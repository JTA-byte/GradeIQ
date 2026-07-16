"""
Nightly graded-card sale price scraping job.

Orchestrates all three sale-history scrapers (130point, PriceCharting,
Alt) across every card in the database and writes results into the
market_sales table.

Run manually:
  python -m jobs.nightly_price_scrape

Run on a schedule (Render/Railway cron, or a plain crontab entry):
  0 4 * * * cd /path/to/python-services && python -m jobs.nightly_price_scrape

Runs an hour after nightly_pop_scrape (0 3 * * *) by convention -- stagger
these if running both on the same host so they don't compete for
CPU/network. With the 3s+ rate limit per source and three sources
running concurrently per card, scraping ~500 cards takes roughly
500 * 3s ~= 25 minutes wall-clock, since sources run in parallel per card.
"""
from __future__ import annotations

import asyncio
import logging
import sys

from db.supabase_client import get_cards_to_scrape, get_client, write_sale_record
from scrapers.alt_scraper import AltScraper
from scrapers.point130_scraper import Point130Scraper
from scrapers.pricecharting_scraper import PriceChartingScraper

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("jobs.nightly_price_scrape")

SCRAPERS = [Point130Scraper(), PriceChartingScraper(), AltScraper()]


async def run_job(limit: int | None = None) -> None:
    client = get_client()
    cards = get_cards_to_scrape(client, limit=limit)

    if not cards:
        logger.warning(
            "No cards found in the `cards` table. Add cards before running "
            "this job -- see supabase/schema.sql for the table structure."
        )
        return

    logger.info(f"Starting nightly sale scrape for {len(cards)} cards across 3 sources")

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
