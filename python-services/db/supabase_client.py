"""
Supabase client for the Python data jobs. Writes scraped pop records
into the gem_rates table, and reads the cards table to know what to scrape.

Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment
(service role, not anon key, since this writes data and bypasses RLS by
design -- this script is a trusted backend job, not a public client).
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Optional

from dotenv import load_dotenv
from supabase import Client, create_client

from scrapers.base_scraper import PopRecord, SaleRecord

load_dotenv()

logger = logging.getLogger("db.supabase_client")


def get_client() -> Client:
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise RuntimeError(
            "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the "
            "environment (see python-services/.env.example)"
        )
    return create_client(url, key)


def get_cards_to_scrape(
    client: Client, limit: Optional[int] = None, offset: int = 0
) -> list[dict]:
    """
    Returns cards from the `cards` table that need a gem rate scrape.
    For the nightly job, you'd typically scrape every card, or prioritize
    cards that haven't been scraped recently / are flagged high-priority
    by user scan volume. This starts simple: return all cards.

    `offset` lets a caller ask for a specific slice of the table (e.g.
    "cards 1000-1999") -- used by the nightly price-scrape job to split
    ~6,400 cards into parallel GitHub Actions matrix batches instead of
    one job scraping all of them sequentially and hitting the 6-hour
    Actions job time limit.

    Paginates via .range() rather than a single .select().execute() call.
    PostgREST (Supabase's API layer) caps any unpaginated request at 1000
    rows by default (its `db-max-rows` setting) -- that cap is enforced
    server-side regardless of what the client sends, so `limit=None` here
    was silently still capped at the first 1000 rows in the `cards` table
    without this loop.
    """
    page_size = 1000
    all_cards: list[dict] = []
    current_offset = offset

    while True:
        remaining = page_size if limit is None else min(page_size, limit - len(all_cards))
        if remaining <= 0:
            break

        response = (
            client.table("cards")
            .select("id, name, set_name, card_number")
            .range(current_offset, current_offset + remaining - 1)
            .execute()
        )
        page = response.data
        all_cards.extend(page)

        if len(page) < remaining:
            break  # last page -- fewer rows came back than we asked for
        current_offset += remaining

    return all_cards


def write_pop_record(client: Client, card_id: str, record: PopRecord) -> None:
    """
    Inserts a new gem_rates row. Deliberately insert-only (never update)
    so historical trend data is preserved -- the whole point of running
    this nightly is to be able to later compute "is this card's gem rate
    trending up or down over the last 90 days".
    """
    try:
        client.table("gem_rates").insert(
            {
                "card_id": card_id,
                "grader": record.grader,
                "top_grade_pop": record.grade_pop,
                "total_pop": record.total_pop,
            }
        ).execute()
        logger.info(
            f"Wrote {record.grader} pop data for card {card_id}: "
            f"{record.grade_pop}/{record.total_pop}"
        )
    except Exception as e:
        logger.error(f"Failed to write pop record for card {card_id}: {e}")
        raise


def write_sale_record(client: Client, card_id: str, record: SaleRecord) -> None:
    """
    Inserts a new market_sales row. Insert-only (never update), same
    reasoning as write_pop_record -- preserves sale history over time.
    """
    try:
        client.table("market_sales").insert(
            {
                "card_id": card_id,
                "grader": record.grader or None,
                "grade": record.grade,
                "sale_price": record.sale_price,
                "sale_date": datetime.fromtimestamp(record.sale_date, tz=timezone.utc).isoformat(),
                "source": record.source,
                "source_url": record.source_url,
            }
        ).execute()
        logger.info(
            f"Wrote {record.source} sale for card {card_id}: "
            f"{record.grader or 'raw'} {record.grade} @ ${record.sale_price}"
        )
    except Exception as e:
        logger.error(f"Failed to write sale record for card {card_id}: {e}")
        raise
