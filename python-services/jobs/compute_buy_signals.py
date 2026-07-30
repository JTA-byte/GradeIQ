"""
Buy Signals cache refresh trigger.

Runs nightly at 2am UTC via GitHub Actions (.github/workflows/
compute-buy-signals.yml). This is deliberately a THIN trigger, not a
reimplementation of the ROI/IQ engine in Python -- it just calls
app/api/internal/refresh-buy-signals-cache, which runs the real,
already-tested lib/buySignals.ts getBuySignals() and writes the result
into buy_signals_cache. app/buy-signals/page.tsx reads that table
directly instead of recomputing live on every request, which is what
was timing out the Buy Signals page in production (a full pass over
1.8M+ market_sales rows on every page load).

A second implementation of the ROI engine's math in Python (grader fee
tables, grade-probability distributions, IQ score weighting, trend
detection, implied gem rate, etc.) would just be a second place for all
of that to drift out of sync with the TypeScript original -- the same
reasoning behind check_price_alerts.py and scan_active_listings.py
calling into this app over HTTP instead of duplicating its logic.

The underlying computation can be slow (see the route's own docstring --
it depends on how much of market_sales' known duplicate-row bloat has
been cleaned up, see supabase/deduplicate_market_sales.py), so this uses
a long request timeout rather than httpx's short default. The route
itself is still bounded by whatever maxDuration Vercel enforces for your
plan -- if this times out, that's the ceiling to raise, not something
this script can control.

Run manually:
  python -m jobs.compute_buy_signals
"""
from __future__ import annotations

import logging
import os

import httpx

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("jobs.compute_buy_signals")

GRADEIQ_APP_URL = os.environ.get("GRADEIQ_APP_URL", "https://www.gradeiq.net")

# Generous -- the underlying getBuySignals() computation has taken up to
# ~21 minutes against the live, not-yet-deduplicated market_sales table
# (confirmed live). Lower this once that cleanup is done and the
# computation is reliably fast.
REQUEST_TIMEOUT_SECONDS = 25 * 60


def run_job() -> None:
    api_key = os.environ.get("INTERNAL_API_KEY")
    if not api_key:
        logger.error(
            "INTERNAL_API_KEY is not set -- can't call the refresh endpoint. "
            "Add it as a repo secret (Settings -> Secrets and variables -> Actions)."
        )
        raise SystemExit(1)

    url = f"{GRADEIQ_APP_URL}/api/internal/refresh-buy-signals-cache"
    logger.info(f"Triggering Buy Signals cache refresh at {url} ...")

    try:
        response = httpx.post(
            url,
            headers={"x-internal-api-key": api_key},
            timeout=REQUEST_TIMEOUT_SECONDS,
            # gradeiq.net (no www) 308-redirects to www.gradeiq.net --
            # confirmed live. GRADEIQ_APP_URL now defaults to the www
            # form directly so the normal path never hits that redirect;
            # this is just a safety net in case GRADEIQ_APP_URL gets set
            # back to the bare domain by mistake.
            follow_redirects=True,
        )
    except httpx.TimeoutException:
        logger.error(
            f"Refresh request timed out after {REQUEST_TIMEOUT_SECONDS}s. The cache was NOT "
            "updated this run -- likely the underlying computation is still too slow "
            "(see supabase/deduplicate_market_sales.py) or exceeded Vercel's maxDuration."
        )
        raise SystemExit(1)

    if response.status_code != 200:
        logger.error(f"Refresh failed: HTTP {response.status_code} -- {response.text}")
        raise SystemExit(1)

    body = response.json()
    logger.info(
        f"Buy Signals cache refreshed: {body.get('refreshed')} card(s) written, "
        f"{body.get('removed')} stale row(s) removed, computed_at={body.get('computedAt')}"
    )


if __name__ == "__main__":
    run_job()
