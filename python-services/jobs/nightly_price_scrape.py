"""
Nightly graded-card sale price scraping job.

Orchestrates the sale-history scrapers across every card in the database
and writes results into the market_sales table.

Run manually:
  python -m jobs.nightly_price_scrape

Run on a schedule (Render/Railway cron, or a plain crontab entry):
  0 4 * * * cd /path/to/python-services && python -m jobs.nightly_price_scrape

Runs an hour after nightly_pop_scrape (0 3 * * *) by convention -- stagger
these if running both on the same host so they don't compete for
CPU/network.

--------------------------------------------------------------------------
Point130Scraper and PriceChartingScraper are temporarily disabled -- the
nightly GitHub Actions run reported them as blocked by robots.txt. Only
AltScraper runs for now. Re-enable the other two (uncomment the imports
and add them back to SCRAPERS below) once that's sorted out.

Note: an earlier manual check of 130point.com/robots.txt (Allow: /,
Disallow: /api/ only) and pricecharting.com/robots.txt (Disallow:
/stripe-connect, /publish-offer, /buy only) suggested neither scraper's
actual search/product URLs should be blocked. If they're still being
skipped after re-enabling, check whether `check_robots_allowed()` in
base_scraper.py is resolving/parsing robots.txt correctly in the Actions
runner's environment specifically, rather than assuming the sites
themselves disallow it.
--------------------------------------------------------------------------
"""
from __future__ import annotations

import asyncio
import logging
import sys

from db.supabase_client import get_cards_to_scrape, get_client, write_sale_record
from scrapers.alt_scraper import AltScraper

# Temporarily disabled -- see module docstring.
# from scrapers.point130_scraper import Point130Scraper
# from scrapers.pricecharting_scraper import PriceChartingScraper

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("jobs.nightly_price_scrape")

SCRAPERS = [AltScraper()]


async def run_job(limit: int | None = None) -> None:
    client = get_client()
    cards = get_cards_to_scrape(client, limit=limit)

    if not cards:
        logger.warning(
            "No cards found in the `cards` table. Add cards before running "
            "this job -- see supabase/schema.sql for the table structure."
        )
        return

    logger.info(f"Starting nightly sale scrape for {len(cards)} cards across {len(SCRAPERS)} source(s)")

    total_written = 0
    total_failed = 0

    for i, card in enumerate(cards, start=1):
        logger.info(f"[{i}/{len(cards)}] Scraping sales for '{card['name']}' ({card['set_name']})")

        results = await asyncio.gather(
            *[scraper.scrape_with_retry(card["name"], card["set_name"]) for scraper in SCRAPERS],
            return_exceptions=True,
        )

        for scraper, records in zip(SCRAPERS, results):
            if isinstance(records, Exception):
                logger.error(f"{scraper.source_name} raised exception: {records}")
                total_failed += 1
                continue
            for record in records:
                try:
                    write_sale_record(client, card["id"], record)
                    total_written += 1
                except Exception as e:
                    logger.error(f"DB write failed: {e}")
                    total_failed += 1

    logger.info(
        f"Nightly sale scrape complete. {total_written} records written, "
        f"{total_failed} failures across {len(cards)} cards."
    )


if __name__ == "__main__":
    card_limit = None
    if len(sys.argv) > 1 and sys.argv[1].isdigit():
        card_limit = int(sys.argv[1])
        logger.info(f"Running with card limit: {card_limit}")

    asyncio.run(run_job(limit=card_limit))
