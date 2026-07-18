"""
PriceCharting.com scraper -- raw (ungraded) sale prices from real sold listings.

Verified live against a real product page (Umbreon VMAX, Evolving Skies
#95, checked 2026-07-17). Key findings that shape this implementation:

- The price shown at the top of a card page (`#used_price .js-price`) is
  PriceCharting's own rolling average of recent sales -- exactly the
  "unreliable blended number" a PriceCharting power user warned us not to
  use as our raw price. We never read that element.
- The "volume" control under that price is NOT a link to a separate page
  -- it's a same-page tab switch (`td.js-show-tab[data-show-tab=...]`).
  All condition tabs' full sold-listing tables (eBay + TCGPlayer sourced)
  are already present in the initial static HTML response, confirmed by
  counting `.js-price` occurrences inside `div.completed-auctions-used`
  against that tab's own "Ungraded (N)" dropdown option count. No
  JavaScript execution or Playwright is needed for this scraper -- plain
  httpx + BeautifulSoup is sufficient.
- Individual sold-listing rows live in
  `div.completed-auctions-used table tbody tr`, each with `td.date`
  (already ISO `YYYY-MM-DD`, no fuzzy date parsing needed) and
  `td.numeric span.js-price` (`$XX.XX`).

Search endpoint confirmed live: GET /search-products?q={query}&type=prices,
first result at `tr[id^="product-"] td.title a` (a full absolute href,
not a relative path).

robots.txt only disallows /stripe-connect, /publish-offer, and /buy --
none of which this scraper touches.
"""
from __future__ import annotations

import statistics
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import urlparse

import httpx
from bs4 import BeautifulSoup

from scrapers.base_scraper import BaseSaleScraper, RateLimiter, SaleRecord, check_robots_allowed

HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; GradeIQ-Bot/1.0; +https://gradeiq.app/bot-info)"
}

DAY_SECONDS = 86400
LOW_VOLUME_THRESHOLD = 5  # fewer than this many sales in 90 days -> "low volume, use with caution"
HIGH_CONFIDENCE_THRESHOLD = 10  # 10+ sales in 30 days -> "high" confidence


@dataclass
class RawPriceSummary:
    """Aggregated raw-price read for a single card, computed from individual
    sold listings rather than PriceCharting's own blended average."""

    median_30d: Optional[float]
    median_90d: Optional[float]
    sales_30d: int
    sales_90d: int
    confidence: str  # "high" | "medium" | "low"
    primary_price: Optional[float]  # 30-day median, falling back to the 90-day median


class PriceChartingScraper(BaseSaleScraper):
    source_name = "pricecharting"
    base_url = "https://www.pricecharting.com"

    def __init__(self):
        # User-requested minimum: 1 request per 3 seconds.
        super().__init__(rate_limiter=RateLimiter(min_delay_seconds=3.0))

    async def _find_product_url(self, client: httpx.AsyncClient, query: str) -> Optional[str]:
        search_url = f"{self.base_url}/search-products"
        if not check_robots_allowed(search_url):
            self.logger.warning(f"robots.txt disallows {search_url}, skipping")
            return None

        response = await client.get(
            search_url, params={"q": query, "type": "prices"}, headers=HEADERS, timeout=15.0
        )
        response.raise_for_status()

        # For a strong/near-exact match, PriceCharting 302-redirects
        # straight to the product page instead of rendering a
        # search-results list -- httpx follows that automatically (this
        # client is constructed with follow_redirects=True), so
        # response.url is already the product page in that case (confirmed
        # live: searching "Charizard Shadowless" lands on
        # /game/pokemon-base-set/charizard-shadowless-4 directly, with no
        # `<tr id="product-...">` row to parse).
        if urlparse(str(response.url)).path.startswith("/game/"):
            return str(response.url)

        soup = BeautifulSoup(response.text, "html.parser")

        first_link = soup.select_one('tr[id^="product-"] td.title a')
        if not first_link or not first_link.get("href"):
            return None

        href = first_link["href"]
        return href if href.startswith("http") else f"{self.base_url}{href}"

    async def _scrape_raw_sales(
        self, client: httpx.AsyncClient, product_url: str
    ) -> list[tuple[float, float]]:
        """Returns (sale_price, sale_date_unix_ts) pairs scraped from the
        ungraded ("Raw") condition tab -- the only tab relevant to raw
        pricing. Graded tiers (grade 9, PSA 10, etc.) live in sibling tabs
        on the same page and aren't touched here."""
        if not check_robots_allowed(product_url):
            self.logger.warning(f"robots.txt disallows {product_url}, skipping")
            return []

        response = await client.get(product_url, headers=HEADERS, timeout=15.0)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, "html.parser")

        # "div.completed-auctions-used" matches two elements on a real page:
        # an empty tab-label div (`<div class="tab selected
        # completed-auctions-used">Ungraded</div>`, appears first in the
        # DOM) and the actual sold-listings div containing the table.
        # select_one() would silently return the empty label div, so this
        # takes the first match that actually contains a dated row instead.
        raw_tab = next(
            (
                candidate
                for candidate in soup.select("div.completed-auctions-used")
                if candidate.select_one("td.date")
            ),
            None,
        )
        if not raw_tab:
            return []

        sales: list[tuple[float, float]] = []
        for row in raw_tab.select("tbody tr"):
            date_el = row.select_one("td.date")
            price_el = row.select_one("td.numeric span.js-price")
            if not date_el or not price_el:
                continue

            date_text = date_el.get_text(strip=True)
            try:
                sale_dt = datetime.strptime(date_text, "%Y-%m-%d").replace(tzinfo=timezone.utc)
            except ValueError:
                continue

            price_text = price_el.get_text(strip=True).replace("$", "").replace(",", "")
            try:
                price = float(price_text)
            except ValueError:
                continue

            sales.append((price, sale_dt.timestamp()))

        return sales

    def _summarize(self, sales: list[tuple[float, float]]) -> RawPriceSummary:
        now = time.time()
        prices_30 = [p for p, ts in sales if ts >= now - 30 * DAY_SECONDS]
        prices_90 = [p for p, ts in sales if ts >= now - 90 * DAY_SECONDS]

        median_30 = statistics.median(prices_30) if prices_30 else None
        median_90 = statistics.median(prices_90) if prices_90 else None

        if len(prices_90) < LOW_VOLUME_THRESHOLD:
            confidence = "low"
        elif len(prices_30) < HIGH_CONFIDENCE_THRESHOLD:
            confidence = "medium"
        else:
            confidence = "high"

        return RawPriceSummary(
            median_30d=median_30,
            median_90d=median_90,
            sales_30d=len(prices_30),
            sales_90d=len(prices_90),
            confidence=confidence,
            primary_price=median_30 if median_30 is not None else median_90,
        )

    async def fetch_raw_price_summary(
        self, card_name: str, set_name: str, card_number: str = ""
    ) -> Optional[RawPriceSummary]:
        """Aggregated median-based raw price read -- the entry point for
        anything that wants a single reliable number plus a confidence
        flag, rather than the raw list of individual sales."""
        query = " ".join(part for part in [card_name, card_number, set_name] if part)

        async with httpx.AsyncClient(follow_redirects=True) as client:
            await self.rate_limiter.wait()
            product_url = await self._find_product_url(client, query)
            if not product_url:
                return None

            await self.rate_limiter.wait()
            sales = await self._scrape_raw_sales(client, product_url)
            if not sales:
                return None

            return self._summarize(sales)

    async def fetch_sales(self, card_name: str, set_name: str, card_number: str = "") -> list[SaleRecord]:
        """BaseSaleScraper interface -- individual raw sale records for the
        nightly market_sales population (feeds Buy Signals and the
        graded-sale averaging in lib/tcgplayer.ts's getGradedSalePrices).
        Only sales from the last 90 days are kept; the median/confidence
        math lives in fetch_raw_price_summary() above, which the nightly
        job has no use for since it writes individual rows, not an
        aggregate."""
        query = " ".join(part for part in [card_name, card_number, set_name] if part)
        cutoff_90 = time.time() - 90 * DAY_SECONDS

        async with httpx.AsyncClient(follow_redirects=True) as client:
            product_url = await self._find_product_url(client, query)
            if not product_url:
                return []

            await self.rate_limiter.wait()
            sales = await self._scrape_raw_sales(client, product_url)

            return [
                SaleRecord(
                    card_name=card_name,
                    set_name=set_name,
                    grader="",
                    grade="Raw",
                    sale_price=price,
                    sale_date=ts,
                    source="pricecharting",
                )
                for price, ts in sales
                if ts >= cutoff_90
            ]
