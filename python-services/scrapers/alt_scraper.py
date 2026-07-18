"""
Alt.xyz sale-history scraper.

NOTE: the brief for this scraper referred to "alt.gg" -- that domain
doesn't belong to the trading-card platform "Alt"; the real site is
alt.xyz (formerly onlyalt.com). This targets alt.xyz. Its robots.txt has
no Disallow rules at all (empty Disallow for every user-agent), so
nothing here is blocked.

--------------------------------------------------------------------------
Everything below was verified against the live site with a real headless
browser (not guessed), including actually searching "Umbreon VMAX" and
inspecting the rendered DOM. A few things that verification changed from
an earlier, unverified draft of this file:

1. Search is `/browse?query=<url-encoded query>` -- confirmed by watching
   the site's own search box navigate there. The query value must be
   percent-encoded as %20 for spaces (`urllib.parse.quote`, used below);
   a literal "+" is NOT treated as a space by this app's router and
   silently returns the generic unfiltered browse page instead.

2. `soldListings=true&sortBy=newest_first` is required to see actual
   completed sales. Without it, `/browse` shows *live, unsold* auctions --
   their "price" is a current/starting bid on an active auction, not a
   sale. Recording that as a SaleRecord would misrepresent in-progress
   auctions as completed sales, so this scraper only ever queries the
   sold-listings view.

3. A "Sign up / Log in" modal appears over sold-listings results, but the
   underlying data is still present in the DOM regardless (confirmed by
   inspecting the raw HTML) -- it's a growth-prompt overlay, not an
   actual access gate. This scraper deliberately does NOT try to dismiss
   it: an earlier version clicked a `:near()`-matched close button, which
   reliably wiped the entire results grid (confirmed directly -- the grid
   went from 10 items to 0 the instant that click fired), almost
   certainly because closing the modal triggers a client-side route/state
   reset that drops the search's query params. Since the data extracts
   fine with the modal left open, leaving it alone is the correct fix.

4. Real per-result selectors, via `data-testid` (stable) rather than the
   Material-UI `css-xxxxx` hash classes (regenerate on every deploy):
   - `.virtuoso-grid-item` -- one result card (the grid is a virtualized
     react-virtuoso list, so only ~15 results are ever in the DOM at
     once; scrolling to load more isn't implemented here)
   - `[data-testid^="subject-card-number-"]` -- e.g. "Umbreon Vmax #215"
   - `[data-testid^="grade-"]` -- e.g. "PSA 9" (grader + grade combined)
   - `[data-testid^="sold-price-"]` -- e.g. "$2,658"
   - `img[src*="auction-house-logos"]` -- the marketplace logo; its `alt`
     text (e.g. "eBay", "Fanatics Collect") identifies where the sale
     actually happened. Alt aggregates comps from multiple marketplaces,
     it doesn't only show its own native sales.
   - Sale date has no dedicated testid -- it renders as "Sold • <date>"
     in plain text near the price, so it's pulled via regex over the
     card's full text instead.

5. Population ("POP 4,403") is NOT present on the search grid at all --
   only on individual /itm/{uuid} detail pages (`data-testid="card-pops"`
   or the "Pop" span inside `data-testid="grading-company-grade"`).
   SaleRecord has no field for population (that belongs in `gem_rates`,
   populated by the PSA/CGC/BGS/TAG pop scrapers, not here), and visiting
   every result's detail page would multiply requests per search --
   so this is documented as verified but intentionally not fetched.

6. market_sales.source only allows ('ebay_sold', 'pricecharting', 'alt').
   A sale is recorded as "ebay_sold" when the marketplace logo says
   "eBay", and "alt" for every other marketplace Alt aggregates from
   (Fanatics Collect, Goldin, etc., or a genuine native Alt sale) --
   this keeps every record valid against the existing check constraint
   without needing a schema change.
--------------------------------------------------------------------------
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

GRADE_PATTERN = re.compile(r"\b(PSA|BGS|CGC|SGC)\s*[- ]?(10|9\.5|9|8|PRI|BL)\b", re.IGNORECASE)
DATE_PATTERN = re.compile(r"Sold\D*?([A-Za-z]{3}\s+\d{1,2},\s+\d{4})")
PRICE_PATTERN = re.compile(r"[\d,]+\.?\d*")


def _is_crash_error(err: Exception) -> bool:
    """
    Headless Chromium occasionally crashes mid-page (observed directly
    while testing this scraper). A crashed page makes every subsequent
    locator call on it fail too -- those failures must NOT be swallowed
    as "this row doesn't have this field" (a normal, expected case for
    e.g. a live auction row with no sold-price), or the whole page's
    results silently come back empty instead of triggering a retry with
    a fresh browser via scrape_with_retry.
    """
    text = str(err).lower()
    return "crashed" in text or "target closed" in text or "connection closed" in text


class AltScraper(BaseSaleScraper):
    source_name = "alt"
    base_url = "https://alt.xyz"

    def __init__(self):
        # User-requested minimum: 1 request per 3 seconds.
        super().__init__(rate_limiter=RateLimiter(min_delay_seconds=3.0))

    async def fetch_sales(self, card_name: str, set_name: str, card_number: str = "") -> list[SaleRecord]:
        # {name} {number} {set} -- the card number materially narrows
        # results (a bare name + set can still match multiple printings:
        # reprints, promos, or several cards sharing a name within a
        # set's subsets), so it's included whenever the caller has one.
        search_query = " ".join(part for part in [card_name, card_number, set_name] if part).strip()
        search_url = (
            f"{self.base_url}/browse?query={quote(search_query)}"
            "&soldListings=true&sortBy=newest_first"
        )

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
                # domcontentloaded fires as soon as the HTML/DOM is parsed --
                # much sooner than "load" or "networkidle", which can wait a
                # long time on a JS-heavy SPA like this one that keeps
                # polling/streaming in the background. The explicit wait for
                # .virtuoso-grid-item right after is what actually confirms
                # the app has hydrated and rendered results, rather than
                # relying on a load-event heuristic.
                await page.goto(search_url, wait_until="domcontentloaded", timeout=60000)

                try:
                    await page.wait_for_selector(".virtuoso-grid-item", timeout=60000)
                except Exception:
                    self.logger.info(f"No results rendered for '{search_query}' on Alt")
                    return []

                rows = await page.locator(".virtuoso-grid-item").all()

                records: list[SaleRecord] = []
                for row in rows:
                    try:
                        grade_text = await row.locator('[data-testid^="grade-"]').inner_text()
                    except Exception as e:
                        if _is_crash_error(e):
                            raise
                        continue  # this row just doesn't have a grade element

                    match = GRADE_PATTERN.search(grade_text)
                    if not match:
                        continue
                    grader = match.group(1).upper()
                    grade = match.group(2)

                    try:
                        price_text = await row.locator('[data-testid^="sold-price-"]').inner_text()
                    except Exception as e:
                        if _is_crash_error(e):
                            raise
                        continue  # a live/unsold auction row has no sold-price element -- expected, skip

                    price_match = PRICE_PATTERN.search(price_text.replace(",", ""))
                    if not price_match:
                        continue

                    row_text = await row.inner_text()
                    date_match = DATE_PATTERN.search(row_text)
                    sale_date = parse_date_safe(date_match.group(1) if date_match else "")

                    source = "alt"
                    try:
                        logo_alt = await row.locator('img[src*="auction-house-logos"]').first.get_attribute(
                            "alt"
                        )
                        if logo_alt and logo_alt.strip().lower() == "ebay":
                            source = "ebay_sold"
                    except Exception:
                        pass

                    # Each result card links to its own /itm/{uuid} detail page
                    # (confirmed live: the row's first <a> has
                    # href="/itm/{uuid}/sold") -- this is Alt's own page for
                    # the sale, not the external marketplace listing, but
                    # it's the direct, permanent link this app can offer
                    # users regardless of which marketplace the sale came
                    # from. Stripped of the "/sold" suffix since
                    # /itm/{uuid} (no suffix) resolves identically (both
                    # verified live, 200 OK).
                    source_url = None
                    try:
                        href = await row.locator('a[href^="/itm/"]').first.get_attribute("href")
                        if href:
                            item_path = href.split("?")[0]
                            if item_path.endswith("/sold"):
                                item_path = item_path[: -len("/sold")]
                            source_url = f"{self.base_url}{item_path}"
                    except Exception:
                        pass

                    records.append(
                        SaleRecord(
                            card_name=card_name,
                            set_name=set_name,
                            grader=grader,
                            grade=grade,
                            sale_price=float(price_match.group(0)),
                            sale_date=sale_date,
                            source=source,
                            source_url=source_url,
                        )
                    )

                return records

            finally:
                # If the page already crashed, close() itself can raise --
                # swallow that so it doesn't shadow a real exception being
                # propagated out of the try block above.
                try:
                    await browser.close()
                except Exception:
                    pass
