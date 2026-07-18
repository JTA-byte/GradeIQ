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

--------------------------------------------------------------------------
Japanese cards: run_japanese_seed() below, added after checking three
real options rather than guessing:

1. api.pokemontcg.io (the API used above) is English-only -- confirmed
   directly: all 174 sets in GET /v2/sets are standard English series
   (Base, Sword & Shield, Scarlet & Violet, etc.), no card has a
   `language` field, and "VMAX Climax" (a real Japanese-exclusive set
   with no English equivalent) returns zero results. There's no
   Japanese-cards mode to opt into here.

2. ptcgdex.com is a real site, but it's a general SPA-based price/grading
   tracker (like PriceCharting or PokeData), not a specialized Japanese
   card database -- nothing about it suggested better JP coverage than
   scraping yet another JS-heavy site, so it wasn't worth building
   against for this.

3. api.tcgdex.net ("TCGdex", tcgdex.dev) is a real, free, open, no-signup
   multilingual Pokemon TCG API that includes Japanese -- confirmed live:
   GET https://api.tcgdex.net/v2/ja/cards returns real Japanese card data
   (6,246 total Japanese cards), and GET .../ja/rarities returns a real
   rarity enum. This is what run_japanese_seed() uses.

Two real constraints from that API worth knowing:

- The card-list endpoint (even filtered by ?rarity=) only returns brief
  objects (id, localId, name) -- no set name or confirmed rarity. So
  this collects candidate ids per rarity tier first (cheap: one request
  per tier), then fetches each candidate's full detail individually
  (GET .../ja/cards/{id}) to get set name -- there's no bulk "full
  objects" endpoint. That's what makes the Japanese pass much slower
  than the English one card up above.

- Hitting the *same* target of "gradeable, Holo-tier-and-above" that the
  English RARITY_ALLOWLIST uses, translated to TCGdex's real Japanese
  rarity vocabulary (JP_RARITY_ALLOWLIST below), only turns up ~1,150
  candidates -- well under the "~5,000" target. Counted directly per
  tier: Holo Rare 492, Ultra Rare 63, Secret Rare 24, Illustration rare
  228, Special illustration rare 36, Hyper Rare 5, Double rare 272, Mega
  Hyper Rare 4, Black White Rare 2, Shiny rare 20. TCGdex's Japanese
  catalog is simply smaller/more concentrated at the top end than its
  English one (or than the real universe of Japanese cards ever
  printed -- this database may not be exhaustive). Reaching 5,000 would
  require also including "Rare" (+1,684) and/or "Uncommon"/"Common",
  but that breaks equivalence with the English filter -- plain "Rare"
  and bulk commons aren't what "gradeable" means there either. This
  script stays faithful to that principle rather than padding the count;
  adjust JP_RARITY_ALLOWLIST yourself if you'd rather hit the number.
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

JP_API_BASE = "https://api.tcgdex.net/v2/ja/cards"

# TCGdex's real Japanese rarity vocabulary (confirmed via GET
# https://api.tcgdex.net/v2/ja/rarities), mapped to the same "gradeable,
# Holo-tier-and-above" bar as RARITY_ALLOWLIST above. "Holo Rare" /
# "Secret Rare" are the JP word-order equivalents of English "Rare Holo"
# / "Rare Secret"; the rest are literal 1:1 names or JP-specific top
# tiers with no English equivalent. Deliberately excludes plain "Rare",
# "Uncommon", and "Common" to stay equivalent to the English filter --
# see the module docstring for why this caps out well under the
# "~5,000" target despite that.
JP_RARITY_ALLOWLIST = [
    "Holo Rare",
    "Ultra Rare",
    "Secret Rare",
    "Illustration rare",
    "Special illustration rare",
    "Hyper Rare",
    "Double rare",
    "Mega Hyper Rare",
    "Black White Rare",
    "Shiny rare",
]

# TCGdex publishes no documented rate limit -- still throttled to be a
# good citizen, especially since the per-card detail fetch below means
# one request per candidate card rather than one per page.
JP_REQUEST_DELAY_SECONDS = 0.3
JP_DB_BATCH_SIZE = 100


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


def run_english_seed() -> None:
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
        f"English seed done. {total_inserted} new cards inserted, "
        f"{total_skipped_incomplete} skipped (missing name/set/number), "
        f"{total_fetched} total fetched."
    )
    print("=" * 50)


def fetch_jp_candidate_ids(http_client: httpx.Client) -> list[str]:
    """
    TCGdex's card-list endpoint supports server-side ?rarity= filtering,
    but even filtered, list responses are "brief" objects (id, localId,
    name only) -- no set name, so there's nothing worth inserting yet.
    This collects candidate ids per rarity tier (one cheap request per
    tier, see JP_RARITY_ALLOWLIST); fetch_jp_card_detail() below fills in
    the rest per-card.
    """
    seen: dict[str, None] = {}  # dict, not set, to preserve fetch order
    for rarity in JP_RARITY_ALLOWLIST:
        try:
            response = http_client.get(
                JP_API_BASE, params={"rarity": rarity}, timeout=REQUEST_TIMEOUT_SECONDS
            )
            response.raise_for_status()
            brief_cards = response.json()
        except Exception as e:
            print(f"  Failed to list rarity '{rarity}': {e}")
            continue

        for card in brief_cards:
            seen.setdefault(card["id"], None)

        print(f"  '{rarity}': {len(brief_cards)} candidates")
        time.sleep(JP_REQUEST_DELAY_SECONDS)

    return list(seen.keys())


def fetch_jp_card_detail(http_client: httpx.Client, card_id: str) -> Optional[dict]:
    last_error: Optional[Exception] = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = http_client.get(f"{JP_API_BASE}/{card_id}", timeout=REQUEST_TIMEOUT_SECONDS)
            response.raise_for_status()
            return response.json()
        except Exception as e:
            last_error = e
            if attempt < MAX_RETRIES:
                time.sleep(RETRY_DELAY_SECONDS)
    print(f"  Failed to fetch detail for {card_id} after {MAX_RETRIES} attempts: {last_error}")
    return None


def to_jp_card_row(card: dict) -> Optional[dict]:
    name = card.get("name")
    set_name = (card.get("set") or {}).get("name")
    number = card.get("localId")
    rarity = card.get("rarity")

    if not name or not set_name or not number:
        return None  # skip anything missing a field the cards table requires

    return {
        "name": name,
        # Note in set_name that this is a Japanese card, as requested --
        # this also keeps a JP card from silently colliding with an
        # English card of a similar name/number under the table's
        # (name, set_name, card_number) unique constraint.
        "set_name": f"{set_name} (Japanese)",
        "card_number": number,
        "rarity": rarity,
    }


def run_japanese_seed() -> None:
    print()
    print("=" * 50)
    print("Japanese card seed (TCGdex API)")
    print("=" * 50)

    supabase = get_supabase_client()
    total_inserted = 0
    total_skipped_incomplete = 0
    batch: list[dict] = []

    def flush_batch():
        nonlocal total_inserted, batch
        if not batch:
            return
        try:
            result = (
                supabase.table("cards")
                .upsert(batch, on_conflict="name,set_name,card_number", ignore_duplicates=True)
                .execute()
            )
            inserted = len(result.data) if result.data else 0
            total_inserted += inserted
            print(f"  Wrote batch of {len(batch)}, {inserted} newly inserted")
        except Exception as e:
            print(f"  DB write failed for batch: {e}")
        batch = []

    with httpx.Client(headers={"User-Agent": "Mozilla/5.0 (compatible; GradeIQ-Seed/1.0)"}) as http_client:
        print("Collecting candidate card ids per rarity tier...")
        candidate_ids = fetch_jp_candidate_ids(http_client)
        print(f"Total unique candidates: {len(candidate_ids)}")

        for i, card_id in enumerate(candidate_ids, start=1):
            card = fetch_jp_card_detail(http_client, card_id)

            if card:
                row = to_jp_card_row(card)
                if row is None:
                    total_skipped_incomplete += 1
                else:
                    batch.append(row)

            if len(batch) >= JP_DB_BATCH_SIZE:
                flush_batch()

            if i % 100 == 0 or i == len(candidate_ids):
                print(f"Progress: {i}/{len(candidate_ids)} cards fetched")

            time.sleep(JP_REQUEST_DELAY_SECONDS)

        flush_batch()

    print("=" * 50)
    print(
        f"Japanese seed done. {total_inserted} new cards inserted, "
        f"{total_skipped_incomplete} skipped (missing name/set/number), "
        f"{len(candidate_ids)} total candidates processed."
    )
    print("=" * 50)


if __name__ == "__main__":
    run_english_seed()
    run_japanese_seed()
