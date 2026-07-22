"""
Price alert checker.

Runs every 6 hours via GitHub Actions (.github/workflows/check-price-
alerts.yml). For every active row in `price_alerts`, compares the
alert's target_price against the most recently cached raw price for
that card in `market_prices` (source 'tcgplayer' or 'pricecharting',
condition 'raw') -- the same cache lib/priceCharting.ts and
lib/tcgplayer.ts write to on every live scan, and what the nightly
scrape jobs also populate over time. This job does NOT scrape live
itself: re-scraping PriceCharting/TCGPlayer for every active alert on
a fixed schedule would be redundant with the scraping this app already
does elsewhere, and blocked on IP/rate-limit risk for no real benefit --
the cached price is at most a few hours stale, which is more than
precise enough for a "notify me when it crosses $X" alert.

A triggered alert is a one-time notification, not a repeating one: once
it fires, is_active flips to false and triggered_at/triggered_price are
stamped, so the next run of this job won't re-notify for the same
alert every 6 hours forever.

Email delivery is plain SMTP (SMTP_HOST/PORT/USERNAME/PASSWORD +
ALERT_FROM_EMAIL env vars) rather than a specific provider's API, since
none was already wired up anywhere else in this codebase to reuse. If
SMTP isn't configured, this logs what *would* have been sent and still
marks the alert triggered -- better to have a checkable log and a
correctly-updated alert than to silently fail or fabricate a "sent"
status.

The email itself (HTML + plain-text fallback) pulls a card's live IQ
score, expected ROI%, and max buy price from
app/api/buy-signals/[cardId]/route.ts -- an internal, shared-secret-gated
Next.js endpoint -- rather than recomputing that math here in Python.
That endpoint already reuses lib/buySignals.ts's real ROI engine; a
second implementation of that math in Python would just be a second
place for it to drift out of sync. If that call fails for any reason
(INTERNAL_API_KEY/GRADEIQ_APP_URL not configured, network error, or the
card doesn't currently clear lib/buySignals.ts's own data-quality gates),
the email still sends with just the price comparison -- a richer email
is a nice-to-have, not something worth failing the alert over.

Run manually:
  python -m jobs.check_price_alerts
"""
from __future__ import annotations

import logging
import os
import smtplib
from datetime import datetime, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

import httpx

from db.supabase_client import get_client

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("jobs.check_price_alerts")

RAW_PRICE_SOURCES = ("tcgplayer", "pricecharting")
GRADEIQ_APP_URL = os.environ.get("GRADEIQ_APP_URL", "https://gradeiq.net")

# GradeIQ's Tailwind design tokens (tailwind.config.js), inlined here since
# email HTML can't reference a stylesheet.
COLOR_INK = "#1A1815"
COLOR_PAPER = "#F6F3EC"
COLOR_SLATE = "#3D4A4A"
COLOR_MOSS = "#4A6B5C"
COLOR_LINE = "#D8D2C2"


def get_active_alerts(client) -> list[dict]:
    """Paginates via .range() for the same reason every other job in
    this codebase does -- PostgREST caps an unpaginated request at 1000
    rows regardless of what the client asks for."""
    page_size = 1000
    all_rows: list[dict] = []
    offset = 0

    while True:
        response = (
            client.table("price_alerts")
            .select("id, user_id, card_id, card_name, set_name, target_price, alert_type")
            .eq("is_active", True)
            .range(offset, offset + page_size - 1)
            .execute()
        )
        page = response.data
        all_rows.extend(page)
        if len(page) < page_size:
            break
        offset += page_size

    return all_rows


def get_latest_raw_price(client, card_id: str) -> float | None:
    response = (
        client.table("market_prices")
        .select("price, recorded_at")
        .eq("card_id", card_id)
        .eq("condition", "raw")
        .in_("source", list(RAW_PRICE_SOURCES))
        .order("recorded_at", desc=True)
        .limit(1)
        .execute()
    )
    if not response.data:
        return None
    return float(response.data[0]["price"])


def alert_condition_met(alert_type: str, current_price: float, target_price: float) -> bool:
    if alert_type == "below_price":
        return current_price <= target_price
    if alert_type == "above_price":
        return current_price >= target_price
    return False


def get_user_email(client, user_id: str) -> str | None:
    try:
        result = client.auth.admin.get_user_by_id(user_id)
        return result.user.email if result and result.user else None
    except Exception as e:
        logger.error(f"Could not look up email for user {user_id}: {e}")
        return None


def fetch_buy_signal(card_id: str) -> dict | None:
    """Pulls IQ score/expected ROI%/max buy price/eBay+GradeIQ links for
    one card from the internal buy-signals API. Returns None on any
    failure -- unconfigured INTERNAL_API_KEY, network error, non-200, or
    the card not currently clearing lib/buySignals.ts's own min-sales /
    graded-vs-raw-ratio data-quality gates (a 404 from that endpoint) --
    so the caller can fall back to the plainer price-only email instead
    of failing the alert entirely."""
    api_key = os.environ.get("INTERNAL_API_KEY")
    if not api_key:
        return None

    try:
        response = httpx.get(
            f"{GRADEIQ_APP_URL}/api/buy-signals/{card_id}",
            headers={"x-internal-api-key": api_key},
            timeout=15,
        )
        if response.status_code != 200:
            return None
        return response.json()
    except Exception as e:
        logger.warning(f"Could not fetch buy signal for card {card_id}: {e}")
        return None


def build_email_subject(card_name: str, alert_type: str) -> str:
    direction_phrase = "is below your target price" if alert_type == "below_price" else "is above your target price"
    return f"\U0001f525 GradeIQ Alert: {card_name} {direction_phrase}"


def build_text_email(
    card_name: str,
    set_name: str,
    current_price: float,
    target_price: float,
    alert_type: str,
    buy_signal: dict | None,
) -> str:
    direction = "dropped below" if alert_type == "below_price" else "risen above"

    lines = [
        f"{card_name} ({set_name})",
        "",
        f"Current raw price: ${current_price:,.2f}",
        f"Your target: ${target_price:,.2f} ({direction})",
    ]

    if buy_signal:
        signal = buy_signal["signal"]
        lines += [
            "",
            f"IQ Score: {signal['iqScore']}",
            f"Expected ROI: {signal['expectedRoiPct']:+.1f}%",
            f"Max buy price: ${signal['maxBuyPrice']:,.2f}",
            "",
            f"Find it on eBay: {buy_signal['ebayActiveListingsUrl']}",
            f"View on GradeIQ: {buy_signal['buySignalsUrl']}",
        ]

    lines += [
        "",
        "This alert has been marked as triggered and won't notify again -- set a new one at "
        f"{GRADEIQ_APP_URL}/alerts if you want to keep watching this card.",
        "",
        "GradeIQ provides data for informational purposes only. This is not financial advice.",
        f"Manage or unsubscribe from alerts: {GRADEIQ_APP_URL}/alerts",
    ]
    return "\n".join(lines)


def build_html_email(
    card_name: str,
    set_name: str,
    current_price: float,
    target_price: float,
    alert_type: str,
    buy_signal: dict | None,
) -> str:
    direction = "dropped below" if alert_type == "below_price" else "risen above"

    signal_rows = ""
    cta_buttons = ""
    if buy_signal:
        signal = buy_signal["signal"]
        signal_rows = f"""
                  <tr>
                    <td style="padding:8px 0;font-family:monospace;font-size:11px;color:{COLOR_SLATE};text-transform:uppercase;letter-spacing:0.05em;">IQ Score</td>
                    <td style="padding:8px 0;text-align:right;font-size:16px;font-weight:bold;color:{COLOR_INK};">{signal['iqScore']}</td>
                  </tr>
                  <tr>
                    <td style="padding:8px 0;font-family:monospace;font-size:11px;color:{COLOR_SLATE};text-transform:uppercase;letter-spacing:0.05em;">Expected ROI</td>
                    <td style="padding:8px 0;text-align:right;font-size:16px;font-weight:bold;color:{COLOR_MOSS};">{signal['expectedRoiPct']:+.1f}%</td>
                  </tr>
                  <tr>
                    <td style="padding:8px 0;font-family:monospace;font-size:11px;color:{COLOR_SLATE};text-transform:uppercase;letter-spacing:0.05em;">Max Buy Price</td>
                    <td style="padding:8px 0;text-align:right;font-size:16px;font-weight:bold;color:{COLOR_INK};">${signal['maxBuyPrice']:,.2f}</td>
                  </tr>"""
        cta_buttons = f"""
              <tr>
                <td style="padding-top:24px;">
                  <a href="{buy_signal['ebayActiveListingsUrl']}" style="display:inline-block;background-color:{COLOR_MOSS};color:{COLOR_PAPER};text-decoration:none;padding:12px 20px;font-family:monospace;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;margin-right:10px;">Find on eBay</a>
                  <a href="{buy_signal['buySignalsUrl']}" style="display:inline-block;border:1px solid {COLOR_INK};color:{COLOR_INK};text-decoration:none;padding:12px 20px;font-family:monospace;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;">View on GradeIQ</a>
                </td>
              </tr>"""

    return f"""\
<!DOCTYPE html>
<html>
  <body style="margin:0;padding:0;background-color:{COLOR_PAPER};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:{COLOR_PAPER};padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border:1px solid {COLOR_LINE};">
            <tr>
              <td style="background-color:{COLOR_INK};padding:24px 32px;">
                <span style="font-family:Georgia,serif;font-size:22px;color:{COLOR_PAPER};">GradeIQ</span>
                <div style="font-family:monospace;font-size:11px;color:{COLOR_MOSS};text-transform:uppercase;letter-spacing:0.1em;margin-top:4px;">Price Alert Triggered</div>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;font-family:Georgia,serif;">
                <h1 style="font-size:24px;color:{COLOR_INK};margin:0 0 4px 0;">{card_name}</h1>
                <p style="font-family:monospace;font-size:12px;color:{COLOR_SLATE};margin:0 0 20px 0;">{set_name}</p>

                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid {COLOR_LINE};border-bottom:1px solid {COLOR_LINE};padding:4px 0;">
                  <tr>
                    <td style="padding:8px 0;font-family:monospace;font-size:11px;color:{COLOR_SLATE};text-transform:uppercase;letter-spacing:0.05em;">Current Price</td>
                    <td style="padding:8px 0;text-align:right;font-size:18px;font-weight:bold;color:{COLOR_INK};">${current_price:,.2f}</td>
                  </tr>
                  <tr>
                    <td style="padding:8px 0;font-family:monospace;font-size:11px;color:{COLOR_SLATE};text-transform:uppercase;letter-spacing:0.05em;">Your Target</td>
                    <td style="padding:8px 0;text-align:right;font-size:14px;color:{COLOR_SLATE};">${target_price:,.2f}</td>
                  </tr>{signal_rows}
                </table>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">{cta_buttons}
                </table>

                <p style="font-size:14px;color:{COLOR_SLATE};line-height:1.5;margin-top:24px;">
                  {card_name}'s raw price has {direction} your alert target. This alert has been marked as
                  triggered and won't notify again -- set a new one if you want to keep watching this card.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px;background-color:{COLOR_PAPER};border-top:1px solid {COLOR_LINE};">
                <p style="font-family:monospace;font-size:10px;color:{COLOR_SLATE};line-height:1.6;margin:0;">
                  GradeIQ provides data for informational purposes only. This is not financial advice.<br/>
                  <a href="{GRADEIQ_APP_URL}/alerts" style="color:{COLOR_MOSS};">Manage or unsubscribe from alerts</a>
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
"""


def send_alert_email(
    to_email: str, card_name: str, set_name: str, current_price: float, alert: dict, card_id: str
) -> bool:
    """Sends the alert email over plain SMTP as a multipart/alternative
    message (plain-text fallback + branded HTML). Returns True if
    actually sent, False if SMTP isn't configured or sending failed --
    either way, non-fatal to the caller, which still marks the alert
    triggered (the price condition is real regardless of whether the
    email made it out)."""
    host = os.environ.get("SMTP_HOST")
    port = int(os.environ.get("SMTP_PORT", "587"))
    username = os.environ.get("SMTP_USERNAME")
    password = os.environ.get("SMTP_PASSWORD")
    from_email = os.environ.get("ALERT_FROM_EMAIL", username or "alerts@gradeiq.net")

    target_price = float(alert["target_price"])
    subject = build_email_subject(card_name, alert["alert_type"])

    if not host or not username or not password:
        logger.warning(
            f"[check_price_alerts] SMTP not configured (SMTP_HOST/USERNAME/PASSWORD) -- "
            f"would have emailed {to_email}: \"{subject}\""
        )
        return False

    # Only fetched once SMTP is confirmed configured -- no point making
    # the internal API call if there's nowhere to send the result.
    buy_signal = fetch_buy_signal(card_id)
    text_body = build_text_email(card_name, set_name, current_price, target_price, alert["alert_type"], buy_signal)
    html_body = build_html_email(card_name, set_name, current_price, target_price, alert["alert_type"], buy_signal)

    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = from_email
        msg["To"] = to_email
        # Plain text attached first, HTML second -- mail clients render
        # the last part they support, so this order lets HTML-capable
        # clients show the branded version while others fall back to text.
        msg.attach(MIMEText(text_body, "plain"))
        msg.attach(MIMEText(html_body, "html"))

        with smtplib.SMTP(host, port, timeout=15) as server:
            server.starttls()
            server.login(username, password)
            server.sendmail(from_email, [to_email], msg.as_string())
        return True
    except Exception as e:
        logger.error(f"Failed to send alert email to {to_email}: {e}")
        return False


def run_job() -> None:
    client = get_client()

    try:
        alerts = get_active_alerts(client)
    except Exception as e:
        # Tolerate `price_alerts` not existing yet on the live DB -- it's
        # added in supabase/schema.sql but applied by hand. Without this,
        # the GitHub Actions cron would fail loudly every 6 hours until
        # the migration is run; there's nothing to check yet regardless.
        if "price_alerts" in str(e) and ("not find the table" in str(e) or "does not exist" in str(e)):
            logger.warning(
                "price_alerts table doesn't exist yet -- nothing to check. "
                "Run the migration in supabase/schema.sql to enable price alerts."
            )
            return
        raise

    if not alerts:
        logger.info("No active price alerts to check.")
        return

    logger.info(f"Checking {len(alerts)} active price alert(s)...")

    # Avoid looking up the same card's price once per alert when several
    # alerts target it.
    price_cache: dict[str, float | None] = {}
    triggered_count = 0
    emailed_count = 0

    for alert in alerts:
        card_id = alert["card_id"]
        if card_id not in price_cache:
            price_cache[card_id] = get_latest_raw_price(client, card_id)
        current_price = price_cache[card_id]

        if current_price is None:
            logger.info(
                f"No cached raw price yet for '{alert['card_name']}' ({alert['set_name']}) -- skipping alert {alert['id']}"
            )
            continue

        if not alert_condition_met(alert["alert_type"], current_price, float(alert["target_price"])):
            continue

        triggered_count += 1
        logger.info(
            f"Alert {alert['id']} triggered: '{alert['card_name']}' at ${current_price:.2f} "
            f"({alert['alert_type']} ${alert['target_price']})"
        )

        email = get_user_email(client, alert["user_id"])
        if email:
            sent = send_alert_email(email, alert["card_name"], alert["set_name"], current_price, alert, card_id)
            if sent:
                emailed_count += 1
        else:
            logger.warning(f"Could not resolve an email for user {alert['user_id']} -- alert still marked triggered")

        try:
            client.table("price_alerts").update(
                {
                    "is_active": False,
                    "triggered_at": datetime.now(timezone.utc).isoformat(),
                    "triggered_price": current_price,
                }
            ).eq("id", alert["id"]).execute()
        except Exception as e:
            logger.error(f"Failed to mark alert {alert['id']} as triggered: {e}")

    logger.info(
        f"Done. {triggered_count} alert(s) triggered, {emailed_count} email(s) sent, "
        f"out of {len(alerts)} active alert(s) checked."
    )


if __name__ == "__main__":
    run_job()
