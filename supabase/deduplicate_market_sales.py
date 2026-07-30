"""
One-time cleanup: removes duplicate market_sales rows accumulated by the
(now-fixed) nightly scraper writing the same sale every night with no
dedup check -- see python-services/db/supabase_client.py's
write_sale_record() and lib/buySignals.ts's module docstring for the
full story. Confirmed live: one sample card had 464 rows for only 129
distinct sales (a 3.6x duplication ratio) across the whole ~1.8M-row
table -- that inflated market_sales enough to time out the Buy Signals
page in production.

Why this doesn't just run the SQL directly: the natural cleanup query
(ROW_NUMBER() OVER (PARTITION BY ...) across the whole table) is a
single statement scanning all 1.8M rows, and that's exactly what timed
out in the Supabase SQL editor. This script avoids scanning
market_sales as one giant table at all -- it walks the much smaller
`cards` table (~6,400 rows) instead, and fetches each card's own
market_sales rows one card at a time. A single card's sales are always
a small, fast fetch (confirmed live: one card's 464 rows came back
instantly), so the expensive part (finding duplicates) never touches
more than a few hundred rows in any single request, regardless of how
large market_sales grows overall.

Deletes are issued in small network-safe batches (DELETE_CHUNK_SIZE)
-- PostgREST encodes `.in_()` filters as URL query parameters even for
DELETE requests, and 5,000 UUIDs in one query string risks exceeding
practical URL length limits. Progress is still reported in the
5,000-duplicate granularity requested, aggregating several delete calls
per progress line.

Run manually:
  cd supabase
  python deduplicate_market_sales.py

Requires: supabase, python-dotenv -- the same packages already pinned
in python-services/requirements.txt.

Reads NEXT_PUBLIC_SUPABASE_URL (falling back to SUPABASE_URL) and
SUPABASE_SERVICE_ROLE_KEY from ../.env.local, same convention as
supabase/seed_cards.py.
"""
from __future__ import annotations

import os
import time
from pathlib import Path

from dotenv import load_dotenv
from supabase import Client, create_client

load_dotenv(Path(__file__).resolve().parent.parent / ".env.local")

# Logical progress-reporting granularity (matches what was asked for --
# "Deleted 5,000 duplicates, X remaining"), not the size of each actual
# network delete call (see DELETE_CHUNK_SIZE).
PROGRESS_REPORT_EVERY = 5000

# Rows per actual DELETE request. Kept well under 5,000 -- PostgREST
# puts .in_() filter values in the URL query string regardless of HTTP
# method, and 5,000 UUIDs (~37 chars each including the comma) would be
# ~185,000 characters, comfortably past practical URL length limits.
DELETE_CHUNK_SIZE = 500

CARDS_PAGE_SIZE = 1000


def get_client() -> Client:
    url = os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise RuntimeError(
            "NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY "
            "must be set in ../.env.local"
        )
    return create_client(url, key)


def get_all_card_ids(client: Client) -> list[str]:
    """Paginates the small (~6,400-row) cards table -- plain offset
    pagination is fine at this size, unlike market_sales."""
    all_ids: list[str] = []
    offset = 0
    while True:
        response = (
            client.table("cards")
            .select("id")
            .range(offset, offset + CARDS_PAGE_SIZE - 1)
            .execute()
        )
        page = response.data
        all_ids.extend(row["id"] for row in page)
        if len(page) < CARDS_PAGE_SIZE:
            break
        offset += CARDS_PAGE_SIZE
    return all_ids


def find_duplicate_ids_for_card(client: Client, card_id: str) -> list[str]:
    """Fetches every market_sales row for one card and returns the ids of
    every row EXCEPT the earliest-scraped copy of each
    (grader, grade, sale_price, sale_date, source) group -- the same
    dedup key as idx_market_sales_dedup (supabase/schema.sql)."""
    response = (
        client.table("market_sales")
        .select("id, grader, grade, sale_price, sale_date, source, scraped_at")
        .eq("card_id", card_id)
        .order("scraped_at", desc=False)
        .execute()
    )
    rows = response.data
    if len(rows) <= 1:
        return []

    seen_keys: set[tuple] = set()
    duplicate_ids: list[str] = []
    for row in rows:
        key = (row.get("grader"), row["grade"], row["sale_price"], row["sale_date"], row["source"])
        if key in seen_keys:
            duplicate_ids.append(row["id"])
        else:
            seen_keys.add(key)
    return duplicate_ids


def delete_chunk(client: Client, ids: list[str]) -> None:
    client.table("market_sales").delete().in_("id", ids).execute()


def main() -> None:
    client = get_client()

    print("Fetching card list...")
    card_ids = get_all_card_ids(client)
    print(f"Scanning {len(card_ids)} cards for duplicate market_sales rows...\n")

    start_time = time.monotonic()
    pending_deletes: list[str] = []
    total_deleted = 0
    since_last_report = 0
    scanned_cards = 0

    for card_id in card_ids:
        duplicate_ids = find_duplicate_ids_for_card(client, card_id)
        pending_deletes.extend(duplicate_ids)
        scanned_cards += 1

        while len(pending_deletes) >= DELETE_CHUNK_SIZE:
            chunk = pending_deletes[:DELETE_CHUNK_SIZE]
            pending_deletes = pending_deletes[DELETE_CHUNK_SIZE:]
            delete_chunk(client, chunk)
            total_deleted += len(chunk)
            since_last_report += len(chunk)

            if since_last_report >= PROGRESS_REPORT_EVERY:
                # Live-updating estimate of how many duplicates remain,
                # extrapolated from the duplication rate seen in cards
                # scanned so far -- not exact (that would need a full
                # pre-scan pass first), but self-correcting as more of
                # the table gets scanned.
                rate = total_deleted / scanned_cards
                estimated_total = rate * len(card_ids)
                estimated_remaining = max(0, round(estimated_total) - total_deleted)
                elapsed = time.monotonic() - start_time
                print(
                    f"Deleted {total_deleted:,} duplicates, ~{estimated_remaining:,} estimated "
                    f"remaining ({scanned_cards}/{len(card_ids)} cards scanned, {elapsed:.0f}s elapsed)..."
                )
                since_last_report = 0

    if pending_deletes:
        delete_chunk(client, pending_deletes)
        total_deleted += len(pending_deletes)

    elapsed = time.monotonic() - start_time
    print(f"\nDone in {elapsed:.0f}s. Removed {total_deleted:,} duplicate rows across {len(card_ids)} cards.")

    print(
        "\nNOTE: this script can't run CREATE UNIQUE INDEX itself -- Supabase's "
        "REST API (PostgREST) has no raw-SQL execution endpoint, only table "
        "operations. Now that duplicates are gone, run this in the Supabase "
        "SQL editor to prevent them from coming back:\n"
    )
    print(
        "create unique index if not exists idx_market_sales_dedup on market_sales (\n"
        "  card_id, coalesce(grader, ''), grade, sale_price, sale_date, source\n"
        ");"
    )


if __name__ == "__main__":
    main()
