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
from typing import Optional

from dotenv import load_dotenv
from supabase import Client, create_client

from scrapers.base_scraper import PopRecord

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


def get_cards_to_scrape(client: Client, limit: Optional[int] = None) -> list[dict]:
    """
    Returns cards from the `cards` table that need a gem rate scrape.
    For the nightly job, you'd typically scrape every card, or prioritize
    cards that haven't been scraped recently / are flagged high-priority
    by user scan volume. This starts simple: return all cards.
    """
    query = client.table("cards").select("id, name, set_name")
    if limit:
        query = query.limit(limit)
    response = query.execute()
    return response.data


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
