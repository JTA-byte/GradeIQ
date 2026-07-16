"""
130point.com sale-history scraper.

130point aggregates completed/sold listings across eBay and several
auction houses (Goldin, Heritage, MySlabs, etc.) into one search tool.
This scrapes the public search page at 130point.com/search -- robots.txt
for 130point.com allows "/" and only disallows "/api/", so the search
page itself is fair game; this deliberately does NOT call any /api/
endpoint directly even if one is discoverable via the browser network
tab, out of respect for that disallow rule.

NOTE: like the existing PSA/CGC pop scrapers, the CSS selectors below
are illustrative of the approach, not verified against the live DOM --
this environment has no browser available to inspect it. Before running
this for real, open 130point.com/search in a browser, search for a
card, and update the selectors in fetch_sales() to match what's
actually rendered.

Only surfaces sales for the grades GradeIQ's ROI engine cares about
(PSA 10/9/8, CGC 10/9.5) -- 130point's results are a mixed bag of every
grade and raw listings, so we filter to those via a regex over each
listing's title text. Sales are recorded with source="ebay_sold" since
that's the marketplace 130point is aggregating for the vast majority of
listings (matches the source value already anticipated in the original
market_prices table).
"""
from __future__ import annotations

import re
import time
from urllib.parse import quote

from playwright.async_api import async_playwright

from scrapers.base_scraper import (
    BaseSaleScraper,
    RateLimiter,
    SaleRecord,
    check_robots_allowed,
    parse_date_safe,
)

RELEVANT_GRADES = {
    ("PSA", "10"),
    ("PSA", "9"),
    ("PSA", "8"),
    ("CGC", "10"),
    ("CGC", "9.5"),
}

GRADE_PATTERN = re.compile(r"\b(PSA|CGC)\s*[- ]?(10|9\.5|9|8)\b", re.IGNORECASE)


class Point130Scraper(BaseSaleScraper):
    source_name = "130point"
    base_url = "https://130point.com"

    def __init__(self):
        # User-requested minimum: 1 request per 3 seconds.
        super().__init__(rate_limiter=RateLimiter(min_delay_seconds=3.0))

    async def fetch_sales(self, card_name: str, set_name: str) -> list[SaleRecord]:
        search_query = f"{set_name} {card_name}"
        search_url = f"{self.base_url}/search?q={quote(search_query)}"

        if not check_robots_allowed(search_url):
            self.logger.warning(f"robots.txt disallows {search_url}, skipping")
            return []

        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            context = await browser.new_context(
                user_agent=(
                    "Mozilla/5.0 (compatible; GradeIQ-Bot/1.0; "
                    "+https://gradeiq.app/bot-info)"
                )
            )
            page = await context.new_page()

            try:
                await page.goto(search_url, wait_until="networkidle", timeout=15000)

                # Illustrative selector -- inspect the live DOM and adjust.
                await page.wait_for_selector(
                    "[data-testid='sale-row'], .sale-result-row, .search-result-item",
                    timeout=10000,
                )

                rows = await page.locator(
                    "[data-testid='sale-row'], .sale-result-row, .search-result-item"
                ).all()

                records: list[SaleRecord] = []
                for row in rows:
                    try:
                        title = await row.locator(
                            "[data-testid='listing-title'], .listing-title, .item-title"
                        ).inner_text()
                    except Exception:
                        continue

                    match = GRADE_PATTERN.search(title)
                    if not match:
                        continue

                    grader = match.group(1).upper()
                    grade = match.group(2)
                    if (grader, grade) not in RELEVANT_GRADES:
                        continue

                    try:
                        price_text = await row.locator(
                            "[data-testid='sale-price'], .sale-price, .item-price"
                        ).inner_text()
                    except Exception:
                        continue

                    price_match = re.search(r"[\d,]+\.?\d*", price_text.replace(",", ""))
                    if not price_match:
                        continue
                    sale_price = float(price_match.group(0))

                    date_text = ""
                    try:
                        date_text = await row.locator(
                            "[data-testid='sale-date'], .sale-date, .item-date"
                        ).inner_text()
                    except Exception:
                        pass

                    records.append(
                        SaleRecord(
                            card_name=card_name,
                            set_name=set_name,
                            grader=grader,
                            grade=grade,
                            sale_price=sale_price,
                            sale_date=parse_date_safe(date_text),
                            source="ebay_sold",
                        )
                    )

                return records

            finally:
                await browser.close()
