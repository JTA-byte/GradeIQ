"""
CGC population report scraper.

CGC's TCG pop report lives at gocollect.com or cgccards.com depending on
the current site structure (CGC has migrated their TCG pop tool a few
times). This implementation targets cgccards.com/population-report --
verify this is still the correct URL before running, since CGC has
historically moved this more often than PSA.
"""
from __future__ import annotations

import time
from typing import Optional
from urllib.parse import quote

from playwright.async_api import async_playwright

from scrapers.base_scraper import BaseGraderScraper, PopRecord, check_robots_allowed


class CGCScraper(BaseGraderScraper):
    grader_name = "CGC"
    base_url = "https://www.cgccards.com"

    async def fetch_pop_data(self, card_name: str, set_name: str) -> Optional[PopRecord]:
        search_query = f"{set_name} {card_name}"
        search_url = f"{self.base_url}/population-report?search={quote(search_query)}"

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

                await page.wait_for_selector(
                    ".pop-report-row, .search-result-card",
                    timeout=10000,
                )

                first_result = page.locator(".pop-report-row, .search-result-card").first
                await first_result.click()
                await page.wait_for_load_state("networkidle")

                rows = await page.locator(".grade-tier-row").all()

                grade_counts: dict[str, int] = {}
                for row in rows:
                    text = await row.inner_text()
                    parts = text.strip().split()
                    if len(parts) >= 2:
                        grade_label = " ".join(parts[:-1])
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
                # CGC's top tier is "Pristine 10", distinct from a plain "10"
                top_grade_pop = grade_counts.get("Pristine 10", grade_counts.get("10", 0))

                return PopRecord(
                    card_name=card_name,
                    set_name=set_name,
                    grader="CGC",
                    grade_label="Pristine 10",
                    grade_pop=top_grade_pop,
                    total_pop=total_pop,
                    scraped_at=time.time(),
                )

            finally:
                await browser.close()
