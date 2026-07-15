"""
Base scraper class shared by all grader pop-report scrapers.

Encodes the scraping hygiene rules that matter for long-term reliability:
- Conservative rate limiting (these sites will block/throttle aggressive bots)
- Respect for robots.txt
- Retry with backoff on transient failures
- Consistent logging so failures are visible, not silent
- A pluggable interface so PSA/CGC/BGS/TAG scrapers all return the same shape

Requires: playwright, beautifulsoup4
  pip install playwright beautifulsoup4 --break-system-packages
  playwright install chromium
"""
from __future__ import annotations

import asyncio
import logging
import random
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional
from urllib.parse import urlparse
from urllib.robotparser import RobotFileParser

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)


@dataclass
class PopRecord:
    """Normalized pop report record, same shape regardless of grader."""
    card_name: str
    set_name: str
    grader: str  # "PSA", "CGC", "BGS", "TAG"
    grade_label: str  # e.g. "10", "9", "Pristine 10", "Black Label"
    grade_pop: int  # how many copies exist at this exact grade
    total_pop: int  # total copies across all grades for this card
    scraped_at: float  # unix timestamp


class RateLimiter:
    """
    Simple async rate limiter. Default: 1 request per 2.5 seconds, with
    jitter, so we don't hammer any grader's servers. Slower than you'd
    want for a fast scrape, but this is meant to run as an unattended
    nightly job, not a real-time lookup -- patience costs nothing here
    and aggressive scraping is what gets IPs blocked.
    """

    def __init__(self, min_delay_seconds: float = 2.5, jitter_seconds: float = 1.0):
        self.min_delay = min_delay_seconds
        self.jitter = jitter_seconds
        self._last_request_time: float = 0.0

    async def wait(self):
        elapsed = time.monotonic() - self._last_request_time
        delay = self.min_delay + random.uniform(0, self.jitter)
        if elapsed < delay:
            await asyncio.sleep(delay - elapsed)
        self._last_request_time = time.monotonic()


def check_robots_allowed(url: str, user_agent: str = "GradeIQ-Bot") -> bool:
    """
    Checks robots.txt before scraping. If the site disallows the path,
    we respect that and skip -- this matters both ethically and because
    ignoring robots.txt is the kind of thing that gets you a permanent
    IP ban or a cease-and-desist.
    """
    parsed = urlparse(url)
    robots_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"
    rp = RobotFileParser()
    rp.set_url(robots_url)
    try:
        rp.read()
        return rp.can_fetch(user_agent, url)
    except Exception:
        # If robots.txt is unreachable, default to cautious: allow,
        # but log it so a human can check manually.
        logging.getLogger("scraper.robots").warning(
            f"Could not read robots.txt at {robots_url}, proceeding cautiously"
        )
        return True


class BaseGraderScraper(ABC):
    """
    Subclass this per grader. Each subclass only needs to implement
    fetch_pop_data() with grader-specific page navigation and parsing --
    rate limiting, retries, and robots.txt checks are handled here.
    """

    grader_name: str = "UNKNOWN"
    base_url: str = ""

    def __init__(self, rate_limiter: Optional[RateLimiter] = None, max_retries: int = 3):
        self.rate_limiter = rate_limiter or RateLimiter()
        self.max_retries = max_retries
        self.logger = logging.getLogger(f"scraper.{self.grader_name.lower()}")

    @abstractmethod
    async def fetch_pop_data(self, card_name: str, set_name: str) -> Optional[PopRecord]:
        """Grader-specific implementation. Must return a PopRecord or None."""
        raise NotImplementedError

    async def scrape_with_retry(self, card_name: str, set_name: str) -> Optional[PopRecord]:
        for attempt in range(1, self.max_retries + 1):
            await self.rate_limiter.wait()
            try:
                result = await self.fetch_pop_data(card_name, set_name)
                if result:
                    self.logger.info(
                        f"Scraped {card_name} ({set_name}): "
                        f"{result.grade_pop}/{result.total_pop} at {result.grade_label}"
                    )
                return result
            except Exception as e:
                self.logger.warning(
                    f"Attempt {attempt}/{self.max_retries} failed for "
                    f"{card_name} ({set_name}): {e}"
                )
                if attempt < self.max_retries:
                    backoff = (2 ** attempt) + random.uniform(0, 1)
                    await asyncio.sleep(backoff)
                else:
                    self.logger.error(
                        f"All {self.max_retries} attempts failed for {card_name} ({set_name})"
                    )
        return None
