"""
Alt.xyz sale-history scraper.

NOTE: the brief for this scraper referred to "alt.gg" -- that domain
doesn't belong to the trading-card platform "Alt"; the real site is
alt.xyz (formerly onlyalt.com). This targets alt.xyz. Its robots.txt has
no Disallow rules at all (empty Disallow for every user-agent), so
nothing here is blocked.

Alt is a modern marketplace/vaulting platform for high-value graded
cards, focused on recent, high-liquidity modern cards and SIRs -- which
lines up well with GradeIQ's core market. It aggregates realized sales
across eBay, MySlabs, and its own Liquid Auctions/Fixed Price listings,
and shows PSA/BGS pop alongside listings.

NOTE: like the other scrapers, the CSS selectors and search URL below
are illustrative of the approach -- Alt's exact search/browse URL
structure wasn't confirmed against a live DOM (no browser available in
this environment). Inspect a live search result on alt.xyz and adjust
before relying on this for real data.
"""
from __future__ import annotations

import re
from urllib.parse import quote

from playwright.async_api import async_playwright

from scrapers.base_scraper import (
    BaseSaleScraper,
    RateLimiter,
    SaleRecord,
    check_robots_allowed,
    parse_date_safe,
)

GRADE_PATTERN = re.compile(r"\b(PSA|BGS|CGC|SGC)\s*[- ]?(10|9\.5|9|8)\b", re.IGNORECASE)


class AltScraper(BaseSaleScraper):
    source_name = "alt"
    base_url = "https://alt.xyz"

    def __init__(self):
        # User-requested minimum: 1 request per 3 seconds.
        super().__init__(rate_limiter=RateLimiter(min_delay_seconds=3.0))

    async def fetch_sales(self, card_name: str, set_name: str) -> list[SaleRecord]:
        search_query = f"{set_name} {card_name}"
        search_url = f"{self.base_url}/browse?query={quote(search_query)}"

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
                    "[data-testid='card-listing'], .listing-card, .sale-history-row",
                    timeout=10000,
                )

                rows = await page.locator(
                    "[data-testid='card-listing'], .listing-card, .sale-history-row"
                ).all()

                records: list[SaleRecord] = []
                for row in rows:
                    try:
                        title = await row.locator(
                            "[data-testid='listing-title'], .listing-title, .card-name"
                        ).inner_text()
                    except Exception:
                        continue

                    match = GRADE_PATTERN.search(title)
                    if not match:
                        continue
                    grader = match.group(1).upper()
                    grade = match.group(2)

                    try:
                        price_text = await row.locator(
                            "[data-testid='sale-price'], .sale-price, .listing-price"
                        ).inner_text()
                    except Exception:
                        continue

                    price_match = re.search(r"[\d,]+\.?\d*", price_text.replace(",", ""))
                    if not price_match:
                        continue

                    date_text = ""
                    try:
                        date_text = await row.locator(
                            "[data-testid='sale-date'], .sale-date"
                        ).inner_text()
                    except Exception:
                        pass

                    records.append(
                        SaleRecord(
                            card_name=card_name,
                            set_name=set_name,
                            grader=grader,
                            grade=grade,
                            sale_price=float(price_match.group(0)),
                            sale_date=parse_date_safe(date_text),
                            source="alt",
                        )
                    )

                return records

            finally:
                await browser.close()
