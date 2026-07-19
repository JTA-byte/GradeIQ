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

Run manually:
  python -m jobs.check_price_alerts
"""
from __future__ import annotations

import logging
import os
import smtplib
from datetime import datetime, timezone
from email.mime.text import MIMEText

from db.supabase_client import get_client

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("jobs.check_price_alerts")

RAW_PRICE_SOURCES = ("tcgplayer", "pricecharting")


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


def send_alert_email(to_email: str, card_name: str, set_name: str, current_price: float, alert: dict) -> bool:
    """Sends the alert email over plain SMTP. Returns True if actually
    sent, False if SMTP isn't configured or sending failed -- either
    way, non-fatal to the caller, which still marks the alert triggered
    (the price condition is real regardless of whether the email made
    it out)."""
    host = os.environ.get("SMTP_HOST")
    port = int(os.environ.get("SMTP_PORT", "587"))
    username = os.environ.get("SMTP_USERNAME")
    password = os.environ.get("SMTP_PASSWORD")
    from_email = os.environ.get("ALERT_FROM_EMAIL", username or "alerts@gradeiq.net")

    direction = "dropped below" if alert["alert_type"] == "below_price" else "risen above"
    subject = f"GradeIQ alert: {card_name} {direction} ${alert['target_price']:.2f}"
    body = (
        f"{card_name} ({set_name}) raw price is now ${current_price:.2f}, "
        f"which has {direction} your alert target of ${alert['target_price']:.2f}.\n\n"
        f"This alert has been marked as triggered and won't notify again -- "
        f"set a new one at https://gradeiq.net/alerts if you want to keep watching this card.\n\n"
        f"GradeIQ provides data for informational purposes only. This is not financial advice."
    )

    if not host or not username or not password:
        logger.warning(
            f"[check_price_alerts] SMTP not configured (SMTP_HOST/USERNAME/PASSWORD) -- "
            f"would have emailed {to_email}: \"{subject}\""
        )
        return False

    try:
        msg = MIMEText(body)
        msg["Subject"] = subject
        msg["From"] = from_email
        msg["To"] = to_email

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
            sent = send_alert_email(email, alert["card_name"], alert["set_name"], current_price, alert)
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
