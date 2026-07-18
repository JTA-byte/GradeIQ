"""
On-demand single-card Alt.xyz scrape.

Lets you scrape one card's sale history right now, rather than waiting
for the nightly cron (jobs/nightly_price_scrape.py) to reach it in its
full pass over every row in `cards`.

This exists because lib/dynamicCardLookup.ts (the Next.js side) can
insert a new `cards` row on the fly when a user analyzes an unrecognized
card, but it has no way to invoke this Python/Playwright code inline --
a Vercel serverless function and this repo's Python scrapers don't share
a runtime, and there's no deployed Python HTTP service for it to call.
So today, a newly-inserted card gets scraped on the *next* nightly run,
not instantly. This script is the piece that makes "instantly" possible
later, if you wire it into a queue/webhook -- until then, it's meant to
be run manually.

Run manually:
  python -m scrapers.on_demand_scrape "Umbreon VMAX Alt Art" "Evolving Skies"
  python -m scrapers.on_demand_scrape "Umbreon VMAX Alt Art" "Evolving Skies" <card-id>

If <card-id> is omitted, it's looked up by (name, set_name) -- the row
must already exist (e.g. created by lib/dynamicCardLookup.ts) since this
script only scrapes, it doesn't create cards rows itself.

Or import scrape_card_now() directly from another Python process.
"""
from __future__ import annotations

import asyncio
import logging
import sys
from typing import Optional

from db.supabase_client import get_client, write_sale_record
from scrapers.alt_scraper import AltScraper

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("scrapers.on_demand_scrape")


async def scrape_card_now(card_id: str, card_name: str, set_name: str = "") -> int:
    """
    Scrapes Alt.xyz for a single card right now and writes any sale
    records found into market_sales. Returns the number of records written.
    """
    scraper = AltScraper()
    records = await scraper.scrape_with_retry(card_name, set_name)

    if not records:
        logger.info(f"No Alt sales found for '{card_name}' ({set_name})")
        return 0

    client = get_client()
    written = 0
    for record in records:
        try:
            write_sale_record(client, card_id, record)
            written += 1
        except Exception as e:
            logger.error(f"Failed to write sale record for card {card_id}: {e}")

    logger.info(f"On-demand scrape wrote {written}/{len(records)} sale record(s) for '{card_name}'")
    return written


def _find_card_id(card_name: str, set_name: str) -> Optional[str]:
    client = get_client()
    response = (
        client.table("cards")
        .select("id")
        .eq("name", card_name)
        .eq("set_name", set_name)
        .limit(1)
        .execute()
    )
    if not response.data:
        return None
    return response.data[0]["id"]


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print('Usage: python -m scrapers.on_demand_scrape "<card_name>" "<set_name>" [card_id]')
        sys.exit(1)

    card_name_arg = sys.argv[1]
    set_name_arg = sys.argv[2]
    card_id_arg = sys.argv[3] if len(sys.argv) > 3 else _find_card_id(card_name_arg, set_name_arg)

    if not card_id_arg:
        print(
            f"No cards row found for '{card_name_arg}' ({set_name_arg}) -- "
            "insert it first (e.g. via lib/dynamicCardLookup.ts or supabase/seed_cards.py)."
        )
        sys.exit(1)

    asyncio.run(scrape_card_now(card_id_arg, card_name_arg, set_name_arg))
