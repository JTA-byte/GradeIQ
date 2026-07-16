"""
PriceCharting.com scraper -- raw + graded market prices.

PriceCharting is a server-rendered price-guide site (not a JS SPA), so
this uses plain HTTP + BeautifulSoup rather than Playwright. It's
particularly good for vintage cards (Base Set, Jungle, Fossil, etc.)
where 130point/Alt sale volume tends to be thin.

Search endpoint confirmed live: /search-products?q={query}&type=prices.
Product pages follow /game/{console-slug}/{product-slug} and show a
pricing table with ungraded + several graded tiers (grade 9, PSA 10,
etc. -- PriceCharting's own tier labels, which don't map 1:1 onto
PSA/CGC grade numbers for every row).

NOTE: like the other scrapers, the table selectors and TIER_TO_GRADE
mapping below are illustrative of the approach -- this environment has
no browser available to inspect a live product page's actual DOM.
Verify against a real page and adjust before relying on this for real
data. robots.txt for pricecharting.com only disallows /stripe-connect,
/publish-offer, and /buy -- none of which this scraper touches.
"""
from __future__ import annotations

import re
import time
from typing import Optional
from urllib.parse import quote

import httpx
from bs4 import BeautifulSoup

from scrapers.base_scraper import (
    BaseSaleScraper,
    RateLimiter,
    SaleRecord,
    check_robots_allowed,
    parse_date_safe,
)

HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; GradeIQ-Bot/1.0; +https://gradeiq.app/bot-info)"
}

# Maps PriceCharting's own condition/tier labels to a (grader, grade)
# pair GradeIQ understands. Illustrative -- verify against a live page;
# PriceCharting doesn't always label tiers identically across products.
TIER_TO_GRADE: dict[str, tuple[Optional[str], str]] = {
    "ungraded": (None, "Raw"),
    "grade 9": ("PSA", "9"),
    "psa 10": ("PSA", "10"),
    "psa 9": ("PSA", "9"),
    "cgc 10": ("CGC", "10"),
    "cgc 9.5": ("CGC", "9.5"),
}


class PriceChartingScraper(BaseSaleScraper):
    source_name = "pricecharting"
    base_url = "https://www.pricecharting.com"

    def __init__(self):
        # User-requested minimum: 1 request per 3 seconds.
        super().__init__(rate_limiter=RateLimiter(min_delay_seconds=3.0))

    async def _find_product_url(self, client: httpx.AsyncClient, query: str) -> Optional[str]:
        search_url = f"{self.base_url}/search-products?q={quote(query)}&type=prices"
        if not check_robots_allowed(search_url):
            self.logger.warning(f"robots.txt disallows {search_url}, skipping")
            return None

        response = await client.get(search_url, headers=HEADERS, timeout=15.0)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, "html.parser")

        # Illustrative selector -- inspect the live search-results DOM and adjust.
        first_link = soup.select_one("#games_table tbody tr td.title a, .product-link")
        if not first_link or not first_link.get("href"):
            return None

        href = first_link["href"]
        return href if href.startswith("http") else f"{self.base_url}{href}"

    async def fetch_sales(self, card_name: str, set_name: str) -> list[SaleRecord]:
        query = f"{set_name} {card_name}"

        async with httpx.AsyncClient(follow_redirects=True) as client:
            product_url = await self._find_product_url(client, query)
            if not product_url:
                return []

            if not check_robots_allowed(product_url):
                self.logger.warning(f"robots.txt disallows {product_url}, skipping")
                return []

            response = await client.get(product_url, headers=HEADERS, timeout=15.0)
            response.raise_for_status()
            soup = BeautifulSoup(response.text, "html.parser")

            # Illustrative selector -- PriceCharting's pricing table id/class
            # has changed before; verify against a live product page.
            price_rows = soup.select("#price_data tr, .price-table tr")

            last_updated_text = ""
            updated_el = soup.select_one(".price-update-date, [data-testid='last-updated']")
            if updated_el:
                last_updated_text = updated_el.get_text(strip=True)
            sale_date = parse_date_safe(last_updated_text, fallback=time.time())

            records: list[SaleRecord] = []
            for row in price_rows:
                label_el = row.select_one("td.title, th")
                price_el = row.select_one("td.price, .js-price")
                if not label_el or not price_el:
                    continue

                label = label_el.get_text(strip=True).lower()
                mapping = TIER_TO_GRADE.get(label)
                if not mapping:
                    continue
                grader, grade = mapping

                price_match = re.search(
                    r"[\d,]+\.?\d*", price_el.get_text(strip=True).replace(",", "")
                )
                if not price_match:
                    continue

                records.append(
                    SaleRecord(
                        card_name=card_name,
                        set_name=set_name,
                        grader=grader or "",
                        grade=grade,
                        sale_price=float(price_match.group(0)),
                        # PriceCharting shows a rolling market price, not individual
                        # sale dates -- this is the page's "last updated" date.
                        sale_date=sale_date,
                        source="pricecharting",
                    )
                )

            return records
