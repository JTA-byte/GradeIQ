"""
TAG (Trading Card Authentication & Grading) population report scraper.

TAG is newer than PSA/CGC/BGS and has a smaller population overall, but
is gaining traction for its sub-grade transparency and faster turnaround.
Their pop data is at taggrading.com/population. TAG's site has historically
exposed more of this data through a discoverable internal API
(XHR requests visible in browser devtools) rather than requiring full HTML
parsing -- check the Network tab when the page loads before assuming you
need Playwright + selectors. The implementation below uses the same
Playwright pattern as the others for consistency, but flags where an
API endpoint discovered via devtools could likely simplify this significantly.
"""
from __future__ import annotations

import time
from typing import Optional
from urllib.parse import quote

from playwright.async_api import async_playwright

from scrapers.base_scraper import BaseGraderScraper, PopRecord, check_robots_allowed


class TAGScraper(BaseGraderScraper):
    grader_name = "TAG"
    base_url = "https://www.taggrading.com"

    async def fetch_pop_data(self, card_name: str, set_name: str) -> Optional[PopRecord]:
        search_query = f"{set_name} {card_name}"
        search_url = f"{self.base_url}/population?search={quote(search_query)}"

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
                    ".pop-card-result",
                    timeout=10000,
                )

                first_result = page.locator(".pop-card-result").first
                await first_result.click()
                await page.wait_for_load_state("networkidle")

                rows = await page.locator(".tag-grade-row").all()

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
                        "page structure may have changed, or this card has no "
                        "TAG submissions yet (common given TAG's smaller pop overall)"
                    )
                    return None

                total_pop = sum(grade_counts.values())
                top_grade_pop = grade_counts.get("10", 0)

                return PopRecord(
                    card_name=card_name,
                    set_name=set_name,
                    grader="TAG",
                    grade_label="10",
                    grade_pop=top_grade_pop,
                    total_pop=total_pop,
                    scraped_at=time.time(),
                )

            finally:
                await browser.close()
