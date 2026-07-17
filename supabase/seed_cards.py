"""
Seeds the `cards` table from the Pokémon TCG API (api.pokemontcg.io) --
a free, no-signup-required catalog of every Pokémon card ever printed.
Gives the nightly scrapers (python-services/scrapers/) real cards to
search for, instead of just whatever's been manually analyzed so far.

Run once locally to seed:
  cd supabase
  python seed_cards.py

Requires: httpx, supabase, python-dotenv -- the same packages already
pinned in python-services/requirements.txt. If they're not installed:
  pip install -r ../python-services/requirements.txt

Reads NEXT_PUBLIC_SUPABASE_URL (falling back to SUPABASE_URL),
SUPABASE_SERVICE_ROLE_KEY, and POKEMONTCG_API_KEY from ../.env.local (the
Next.js app's env file -- note python-services/ has its own separate
.env with SUPABASE_URL under a different convention; this script targets
the root gradeiq/.env.local specifically, as requested).
POKEMONTCG_API_KEY is optional -- without it the API still works, just
at the lower unauthenticated rate limit (see REQUEST_DELAY_SECONDS
below). If set, it's sent as an X-Api-Key header on every request.

--------------------------------------------------------------------------
Two corrections worth knowing about before you run this:

1. "Secret Rare" isn't a real rarity string in this API -- confirmed via
   GET /v2/rarities. The actual value is "Rare Secret" (words reversed).
   Corrected in RARITY_ALLOWLIST below.

2. The API has no boolean/queryable "is this full art" field at all --
   confirmed by inspecting live card JSON (e.g. Charizard VMAX, Champion's
   Path). Full art is a print *style* that spans several rarity tiers,
   not a rarity itself, so "any full art" can't be queried directly.
   RARITY_ALLOWLIST approximates it by also including a few rarities
   that are full art by definition (Rare Ultra, Rare Rainbow, Trainer
   Gallery Rare Holo). This will miss some full art cards that carry an
   otherwise-ordinary rarity label, and may include a handful you don't
   consider gradeable -- adjust the list to taste.
--------------------------------------------------------------------------
"""
from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Optional

import httpx
from dotenv import load_dotenv
from supabase import Client, create_client

# .env.local lives one directory up from this script (gradeiq/.env.local).
load_dotenv(Path(__file__).resolve().parent.parent / ".env.local")

API_BASE = "https://api.pokemontcg.io/v2/cards"
PAGE_SIZE = 250  # the API's documented max page size

# See the module docstring for the "Secret Rare" -> "Rare Secret" fix and
# the "any full art" approximation.
RARITY_ALLOWLIST = [
    "Rare Holo",
    "Ultra Rare",
    "Rare Secret",
    "Illustration Rare",
    "Special Illustration Rare",
    "Hyper Rare",
    # Additional full-art-by-definition tiers, approximating "any full art":
    "Rare Ultra",
    "Rare Rainbow",
    "Trainer Gallery Rare Holo",
]

# Without an API key, the API allows 30 requests/min and 1000/day.
# 2.5s between page requests keeps this comfortably under that even for
# a multi-thousand-card seed run.
REQUEST_DELAY_SECONDS = 2.5
REQUEST_TIMEOUT_SECONDS = 60.0
RETRY_DELAY_SECONDS = 10.0
MAX_RETRIES = 5


def build_headers() -> dict:
    headers = {"User-Agent": "Mozilla/5.0 (compatible; GradeIQ-Seed/1.0)"}
    api_key = os.environ.get("POKEMONTCG_API_KEY")
    if api_key:
        headers["X-Api-Key"] = api_key
    return headers


def build_query() -> str:
    clauses = [f'rarity:"{r}"' for r in RARITY_ALLOWLIST]
    return " OR ".join(clauses)


def get_supabase_client() -> Client:
    url = os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise RuntimeError(
            "NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY "
            "must be set in gradeiq/.env.local"
        )
    return create_client(url, key)


def fetch_cards_page(client: httpx.Client, page: int) -> dict:
    last_error: Optional[Exception] = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = client.get(
                API_BASE,
                params={"q": build_query(), "page": page, "pageSize": PAGE_SIZE},
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
            return response.json()
        except Exception as e:
            last_error = e
            print(f"  Page {page} attempt {attempt}/{MAX_RETRIES} failed: {e}")
            if attempt < MAX_RETRIES:
                time.sleep(RETRY_DELAY_SECONDS)
    raise RuntimeError(f"Failed to fetch page {page} after {MAX_RETRIES} attempts") from last_error


def to_card_row(card: dict) -> Optional[dict]:
    name = card.get("name")
    set_name = (card.get("set") or {}).get("name")
    number = card.get("number")
    rarity = card.get("rarity")

    if not name or not set_name or not number:
        return None  # skip anything missing a field the cards table requires

    return {
        "name": name,
        "set_name": set_name,
        "card_number": number,
        "rarity": rarity,
    }


def run() -> None:
    supabase = get_supabase_client()

    total_inserted = 0
    total_skipped_incomplete = 0
    total_fetched = 0
    total_count: Optional[int] = None

    with httpx.Client(headers=build_headers()) as http_client:
        page = 1
        while True:
            print(f"Fetching page {page} (pageSize={PAGE_SIZE})...")
            try:
                data = fetch_cards_page(http_client, page)
            except Exception as e:
                print(f"Aborting: {e}")
                break

            if total_count is None:
                total_count = data.get("totalCount", 0)
                print(f"Total matching cards to seed: {total_count}")

            cards = data.get("data", [])
            if not cards:
                break

            total_fetched += len(cards)
            rows = [row for row in (to_card_row(c) for c in cards) if row is not None]
            total_skipped_incomplete += len(cards) - len(rows)

            if rows:
                try:
                    result = (
                        supabase.table("cards")
                        .upsert(rows, on_conflict="name,set_name,card_number", ignore_duplicates=True)
                        .execute()
                    )
                    inserted = len(result.data) if result.data else 0
                    total_inserted += inserted
                    print(
                        f"  Page {page}: {len(rows)} candidates, "
                        f"{inserted} newly inserted (rest were duplicates)"
                    )
                except Exception as e:
                    print(f"  Page {page}: DB write failed: {e}")

            print(f"Progress: {total_fetched}/{total_count} cards fetched")

            if total_count is not None and total_fetched >= total_count:
                break

            page += 1
            time.sleep(REQUEST_DELAY_SECONDS)

    print("=" * 50)
    print(
        f"Done. {total_inserted} new cards inserted, "
        f"{total_skipped_incomplete} skipped (missing name/set/number), "
        f"{total_fetched} total fetched."
    )
    print("=" * 50)


if __name__ == "__main__":
    run()
