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
Point130Scraper is temporarily disabled -- the nightly GitHub Actions run
reported it as blocked by robots.txt. PriceChartingScraper has been
re-enabled: its selectors were fully rewritten and verified against a
live product page (see scrapers/pricecharting_scraper.py's module
docstring), and its robots.txt (Disallow: /stripe-connect,
/publish-offer, /buy only) doesn't block the search/product URLs it
uses.

Note: an earlier manual check of 130point.com/robots.txt (Allow: /,
Disallow: /api/ only) suggested Point130Scraper's actual search/product
URLs shouldn't be blocked either. If it's still being skipped after
re-enabling, check whether `check_robots_allowed()` in base_scraper.py is
resolving/parsing robots.txt correctly in the Actions runner's
environment specifically, rather than assuming the site itself disallows
it.
--------------------------------------------------------------------------
Batching: a single run scraping all ~6,400 cards sequentially was hitting
GitHub Actions' 6-hour job time limit. nightly-price-scrape.yml now runs
7 jobs in parallel via a matrix strategy, each calling this module with
--offset/--limit to claim its own ~1,000-card slice (0-999, 1000-1999,
etc.) -- see get_cards_to_scrape() in db/supabase_client.py for how the
offset is applied. Each scraper call per card is also capped at
PER_CARD_TIMEOUT_SECONDS: a single unresponsive card (e.g. Alt.xyz's
headless browser hanging) no longer stalls the rest of that batch.
--------------------------------------------------------------------------
"""
from __future__ import annotations

import argparse
import asyncio
import logging

from db.supabase_client import get_cards_to_scrape, get_client, write_sale_record
from scrapers.alt_scraper import AltScraper
from scrapers.base_scraper import BaseSaleScraper, SaleRecord
from scrapers.pricecharting_scraper import PriceChartingScraper

# Temporarily disabled -- see module docstring.
# from scrapers.point130_scraper import Point130Scraper

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("jobs.nightly_price_scrape")

SCRAPERS = [AltScraper(), PriceChartingScraper()]

# If a scraper hasn't returned for a single card within this many seconds,
# skip it and move on rather than letting one slow/hung card (or a stuck
# headless browser) eat into the rest of this batch's time budget.
PER_CARD_TIMEOUT_SECONDS = 30.0


async def _scrape_with_timeout(
    scraper: BaseSaleScraper, card: dict
) -> list[SaleRecord]:
    try:
        return await asyncio.wait_for(
            scraper.scrape_with_retry(card["name"], card["set_name"], card.get("card_number") or ""),
            timeout=PER_CARD_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        logger.warning(
            f"{scraper.source_name} timed out after {PER_CARD_TIMEOUT_SECONDS:.0f}s "
            f"for '{card['name']}' ({card['set_name']}) -- skipping"
        )
        return []


async def run_job(limit: int | None = None, offset: int = 0) -> None:
    client = get_client()
    cards = get_cards_to_scrape(client, limit=limit, offset=offset)

    if not cards:
        logger.warning(
            f"No cards found in the `cards` table for offset={offset}, limit={limit}. "
            "Add cards before running this job -- see supabase/schema.sql for the "
            "table structure."
        )
        return

    logger.info(
        f"Starting nightly sale scrape for {len(cards)} cards "
        f"(offset={offset}) across {len(SCRAPERS)} source(s)"
    )

    total_written = 0
    total_failed = 0

    for i, card in enumerate(cards, start=1):
        logger.info(f"[{i}/{len(cards)}] Scraping sales for '{card['name']}' ({card['set_name']})")

        results = await asyncio.gather(
            *[_scrape_with_timeout(scraper, card) for scraper in SCRAPERS],
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
        f"{total_failed} failures across {len(cards)} cards (offset={offset})."
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Nightly graded-sale price scrape")
    parser.add_argument(
        "--offset",
        type=int,
        default=0,
        help="Skip this many cards before scraping (for parallel batched runs)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Scrape at most this many cards after the offset",
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    if args.offset or args.limit is not None:
        logger.info(f"Running with offset={args.offset}, limit={args.limit}")

    asyncio.run(run_job(limit=args.limit, offset=args.offset))
