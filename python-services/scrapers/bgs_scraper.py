"""
BGS (Beckett) population report scraper.

Beckett's pop report lives at beckett.com/grading/population-report and
requires navigating set -> card, similar to PSA. BGS has a unique tier
above 10 -- "Black Label" (a perfect 10 across all four sub-grades) --
which is rarer and worth tracking separately since it commands a steep
price premium over a standard Gem Mint 10.
"""
from __future__ import annotations

import time
from typing import Optional
from urllib.parse import quote

from playwright.async_api import async_playwright

from scrapers.base_scraper import BaseGraderScraper, PopRecord, check_robots_allowed


class BGSScraper(BaseGraderScraper):
    grader_name = "BGS"
    base_url = "https://www.beckett.com"

    async def fetch_pop_data(self, card_name: str, set_name: str) -> Optional[PopRecord]:
        search_query = f"{set_name} {card_name}"
        search_url = f"{self.base_url}/grading/population-report?search={quote(search_query)}"

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
                    ".pop-result-row",
                    timeout=10000,
                )

                first_result = page.locator(".pop-result-row").first
                await first_result.click()
                await page.wait_for_load_state("networkidle")

                rows = await page.locator(".grade-row").all()

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
                # Black Label (perfect 10/10/10/10 subgrades) is the true
                # top tier, distinct from a standard Gem Mint 10
                black_label_pop = grade_counts.get("Black Label", 0)
                standard_10_pop = grade_counts.get("10", 0)
                top_grade_pop = black_label_pop + standard_10_pop

                return PopRecord(
                    card_name=card_name,
                    set_name=set_name,
                    grader="BGS",
                    grade_label="10 (incl. Black Label)",
                    grade_pop=top_grade_pop,
                    total_pop=total_pop,
                    scraped_at=time.time(),
                )

            finally:
                await browser.close()
