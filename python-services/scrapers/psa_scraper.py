"""
PSA population report scraper.

PSA's pop report (psacard.com/pop) is JS-rendered and requires searching
by set, then card. There is no official API, so this uses Playwright to
render the page and BeautifulSoup to parse the resulting HTML.

NOTE: PSA's page structure changes periodically. The CSS selectors below
are illustrative of the approach -- when PSA updates their site, you'll
need to inspect the live DOM (right-click -> Inspect on psacard.com/pop)
and update the selectors. This is the most maintenance-heavy part of the
whole data pipeline; budget for occasional fixes.
"""
from __future__ import annotations

import time
from typing import Optional
from urllib.parse import quote

from playwright.async_api import async_playwright

from scrapers.base_scraper import BaseGraderScraper, PopRecord, check_robots_allowed


class PSAScraper(BaseGraderScraper):
    grader_name = "PSA"
    base_url = "https://www.psacard.com"

    async def fetch_pop_data(self, card_name: str, set_name: str) -> Optional[PopRecord]:
        search_query = f"{set_name} {card_name}"
        search_url = f"{self.base_url}/pop/search?q={quote(search_query)}"

        if not check_robots_allowed(search_url):
            self.logger.warning(f"robots.txt disallows {search_url}, skipping")
            return None

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

                # Wait for the results table to render -- adjust selector
                # to match PSA's current DOM structure.
                await page.wait_for_selector(
                    "[data-testid='pop-report-row'], .pop-report-table",
                    timeout=10000,
                )

                # Click into the first matching result
                first_result = page.locator(
                    "[data-testid='pop-report-row'], .pop-report-table tr"
                ).first
                await first_result.click()
                await page.wait_for_load_state("networkidle")

                # Parse the grade breakdown table
                rows = await page.locator(
                    "[data-testid='grade-row'], .grade-breakdown-row"
                ).all()

                grade_counts: dict[str, int] = {}
                for row in rows:
                    text = await row.inner_text()
                    parts = text.strip().split()
                    if len(parts) >= 2:
                        grade_label = parts[0]
                        try:
                            count = int(parts[-1].replace(",", ""))
                            grade_counts[grade_label] = count
                        except ValueError:
                            continue

                if not grade_counts:
                    self.logger.warning(
                        f"No grade data parsed for {card_name} ({set_name}) -- "
                        "page structure may have changed"
                    )
                    return None

                total_pop = sum(grade_counts.values())
                top_grade_pop = grade_counts.get("10", 0)

                return PopRecord(
                    card_name=card_name,
                    set_name=set_name,
                    grader="PSA",
                    grade_label="10",
                    grade_pop=top_grade_pop,
                    total_pop=total_pop,
                    scraped_at=time.time(),
                )

            finally:
                await browser.close()
