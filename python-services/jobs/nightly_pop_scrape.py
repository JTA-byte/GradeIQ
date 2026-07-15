"""
Nightly pop report scraping job.

Orchestrates all four grader scrapers (PSA, CGC, BGS, TAG) across every
card in the database and writes results into the gem_rates table.

Run manually:
  python -m jobs.nightly_pop_scrape

Run on a schedule (Render/Railway cron, or a plain crontab entry):
  0 3 * * * cd /path/to/python-services && python -m jobs.nightly_pop_scrape

Designed to run once per night. With the default 2.5s+ rate limit per
grader and four graders running concurrently, scraping ~500 cards takes
roughly 500 * 2.5s / 1 (sequential within each grader) ~= 21 minutes per
grader, so ~21 minutes wall-clock since graders run in parallel. Scale
your card list and timing expectations accordingly -- this is intentionally
not built for speed.
"""
from __future__ import annotations

import asyncio
import logging
import sys

from db.supabase_client import get_cards_to_scrape, get_client, write_pop_record
from scrapers.bgs_scraper import BGSScraper
from scrapers.cgc_scraper import CGCScraper
from scrapers.psa_scraper import PSAScraper
from scrapers.tag_scraper import TAGScraper

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("jobs.nightly_pop_scrape")

SCRAPERS = [PSAScraper(), CGCScraper(), BGSScraper(), TAGScraper()]


async def run_job(limit: int | None = None) -> None:
    client = get_client()
    cards = get_cards_to_scrape(client, limit=limit)

    if not cards:
        logger.warning(
            "No cards found in the `cards` table. Add cards before running "
            "this job -- see supabase/schema.sql for the table structure."
        )
        return

    logger.info(f"Starting nightly scrape for {len(cards)} cards across 4 graders")

    total_written = 0
    total_failed = 0

    for i, card in enumerate(cards, start=1):
        logger.info(f"[{i}/{len(cards)}] Scraping '{card['name']}' ({card['set_name']})")

        results = await asyncio.gather(
            *[scraper.scrape_with_retry(card["name"], card["set_name"]) for scraper in SCRAPERS],
            return_exceptions=True,
        )

        for scraper, result in zip(SCRAPERS, results):
            if isinstance(result, Exception):
                logger.error(f"{scraper.grader_name} raised exception: {result}")
                total_failed += 1
                continue
            if result is None:
                total_failed += 1
                continue
            try:
                write_pop_record(client, card["id"], result)
                total_written += 1
            except Exception as e:
                logger.error(f"DB write failed: {e}")
                total_failed += 1

    logger.info(
        f"Nightly scrape complete. {total_written} records written, "
        f"{total_failed} failures across {len(cards)} cards."
    )


if __name__ == "__main__":
    card_limit = None
    if len(sys.argv) > 1 and sys.argv[1].isdigit():
        card_limit = int(sys.argv[1])
        logger.info(f"Running with card limit: {card_limit}")

    asyncio.run(run_job(limit=card_limit))
