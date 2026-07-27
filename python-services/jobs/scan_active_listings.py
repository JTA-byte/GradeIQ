"""
Active listing deal scanner.

Runs every 6 hours via GitHub Actions (.github/workflows/scan-active-
listings.yml) -- separate from jobs/nightly_price_scrape.py (which only
runs once a night) because active listing prices and auction countdowns
change far more often than sold-comp history does.

For each card, scrapes Alt.xyz's currently-live (not yet sold) listings
via AltScraper.fetch_active_listings(), then compares each listing's
current_price against that card's max_buy_price from Buy Signals --
pulled from app/api/buy-signals/[cardId]/route.ts (an internal, shared-
secret-gated Next.js endpoint) rather than recomputed here in Python, for
the same reason jobs/check_price_alerts.py's email calls it: that
endpoint already reuses lib/buySignals.ts's real ROI engine, and a second
implementation of that math in Python would just be a second place for
it to drift out of sync. A listing priced below max_buy_price -- in ANY
grade, not just the specific tier Buy Signals targets -- is flagged a
deal: a graded copy (even a low grade) selling for less than what you'd
pay for a RAW copy is an unusual, likely-underpriced listing regardless
of which grade it happens to be.

If the buy-signals API call fails for any reason (INTERNAL_API_KEY/
GRADEIQ_APP_URL not configured, network error, or the card doesn't
currently clear lib/buySignals.ts's own data-quality gates), the listing
is still recorded -- just without a deal flag, since there's nothing to
compare its price against.

Scope: unlike the nightly sale scrape (which matrix-batches across all
~6,400 cards), this does NOT attempt full-catalog coverage every 6 hours.
Each fetch_active_listings() call launches its own headless browser and
takes several seconds to tens of seconds; scanning thousands of cards
4x/day would both blow well past a reasonable job timeout and risk the
exact bot-detection problem that already took down the PSA/CGC/BGS/TAG
pop scrapers (see nightly_pop_scrape.py). --limit (default 300) bounds
each run to a slice of the `cards` table, same --offset/--limit pattern
as nightly_price_scrape.py, so this can be scaled up via matrix batching
later if broader coverage is needed.

Run manually:
  python -m jobs.scan_active_listings
  python -m jobs.scan_active_listings --limit 50   # quick manual check
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os

import httpx

from db.supabase_client import get_cards_to_scrape, get_client, write_active_listing
from scrapers.alt_scraper import ActiveListingRecord, AltScraper

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("jobs.scan_active_listings")

GRADEIQ_APP_URL = os.environ.get("GRADEIQ_APP_URL", "https://gradeiq.net")
DEFAULT_LIMIT = 300

# A single card search can return several listings across different
# grades/graders; each fetch_active_listings() call is its own browser
# launch, so this timeout just bounds one card's worth of work, not the
# whole job.
PER_CARD_TIMEOUT_SECONDS = 30.0


def fetch_max_buy_price(card_id: str) -> float | None:
    """Same approach as check_price_alerts.py's fetch_buy_signal() --
    returns None on any failure (unconfigured, network error, 404 because
    the card doesn't clear lib/buySignals.ts's data-quality gates) so the
    caller can still record the listing without a deal flag."""
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
        return response.json()["signal"]["maxBuyPrice"]
    except Exception as e:
        logger.warning(f"Could not fetch max buy price for card {card_id}: {e}")
        return None


async def _fetch_with_timeout(scraper: AltScraper, card: dict) -> list[ActiveListingRecord]:
    try:
        return await asyncio.wait_for(
            scraper.fetch_active_listings(card["name"], card["set_name"], card.get("card_number") or ""),
            timeout=PER_CARD_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        logger.warning(
            f"Active-listing scan timed out after {PER_CARD_TIMEOUT_SECONDS:.0f}s "
            f"for '{card['name']}' ({card['set_name']}) -- skipping"
        )
        return []


async def run_job(limit: int | None = DEFAULT_LIMIT, offset: int = 0) -> None:
    client = get_client()
    cards = get_cards_to_scrape(client, limit=limit, offset=offset)

    if not cards:
        logger.warning(f"No cards found for offset={offset}, limit={limit}.")
        return

    logger.info(f"Scanning active listings for {len(cards)} cards (offset={offset})")

    scraper = AltScraper()
    total_written = 0
    total_deals = 0
    total_failed = 0

    for i, card in enumerate(cards, start=1):
        logger.info(f"[{i}/{len(cards)}] Scanning active listings for '{card['name']}' ({card['set_name']})")

        try:
            listings = await _fetch_with_timeout(scraper, card)
        except Exception as e:
            logger.error(f"Active-listing fetch raised for '{card['name']}': {e}")
            total_failed += 1
            continue

        if not listings:
            continue

        # One buy-signal lookup per card (not per listing) -- every
        # listing for this card compares against the same max_buy_price.
        max_buy_price = fetch_max_buy_price(card["id"])

        for record in listings:
            is_deal = max_buy_price is not None and record.current_price < max_buy_price
            deal_discount_amount = (max_buy_price - record.current_price) if is_deal else None

            try:
                write_active_listing(
                    client,
                    card["id"],
                    record.listing_url,
                    record.current_price,
                    record.auction_end_time,
                    record.grader,
                    record.grade,
                    is_deal,
                    deal_discount_amount,
                )
                total_written += 1
                if is_deal:
                    total_deals += 1
            except Exception as e:
                logger.error(f"DB write failed for '{card['name']}': {e}")
                total_failed += 1

    logger.info(
        f"Active listing scan complete. {total_written} listing(s) written, "
        f"{total_deals} flagged as deals, {total_failed} failure(s) across {len(cards)} cards."
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Active listing deal scanner")
    parser.add_argument("--offset", type=int, default=0, help="Skip this many cards before scanning")
    parser.add_argument(
        "--limit",
        type=int,
        default=DEFAULT_LIMIT,
        help=f"Scan at most this many cards after the offset (default {DEFAULT_LIMIT})",
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    logger.info(f"Running with offset={args.offset}, limit={args.limit}")
    asyncio.run(run_job(limit=args.limit, offset=args.offset))
