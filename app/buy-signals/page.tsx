import { Suspense } from "react";
import { AppHeader } from "@/components/AppHeader";
import { AppFooter } from "@/components/AppFooter";
import { BuySignalsTable } from "@/components/BuySignalsTable";
import { getCachedBuySignals } from "@/lib/buySignalsCache";

// Render on-demand instead of pre-rendering at build time -- with
// 2,220+ cards, the pre-rendered HTML for this page exceeds Vercel's
// build output size limit (FALLBACK_BODY_TOO_LARGE at 19.71 MB).
export const dynamic = "force-dynamic";

/**
 * Coarse relative-time string ("3 hours ago") for the cache's
 * computed_at. Computed at render time on this force-dynamic page, so
 * it's accurate as of each request -- it just won't tick upward live if
 * someone leaves the tab open, which is fine for a "how stale is this
 * data" indicator.
 */
function formatRelativeTime(iso: string): string {
  const diffMinutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes} minute${diffMinutes === 1 ? "" : "s"} ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
}

export default async function BuySignalsPage() {
  // Reads pre-computed results from buy_signals_cache instead of running
  // getBuySignals() (lib/buySignals.ts) live -- that full recompute over
  // market_sales (1.8M+ rows and growing) is what was timing out this
  // page in production. The cache is refreshed nightly at 2am UTC by
  // python-services/jobs/compute_buy_signals.py; see
  // app/api/internal/refresh-buy-signals-cache for how.
  const { signals, lastUpdated } = await getCachedBuySignals();

  return (
    <main className="min-h-screen bg-paper text-ink font-body">
      <AppHeader />
      <div className="max-w-6xl mx-auto px-6 py-10">
        <div className="mb-8">
          <h1 className="font-display text-3xl mb-2">Buy Signals</h1>
          <p className="font-mono text-sm text-slate max-w-2xl">
            Top grading opportunities across every card with real scraped sale data, ranked by IQ
            Score.
          </p>
          <p className="font-mono text-xs text-slate/60 mt-2">
            {lastUpdated
              ? `Last updated ${formatRelativeTime(lastUpdated)} · refreshes nightly at 2am UTC`
              : "Not yet computed -- refreshes nightly at 2am UTC"}
          </p>
          {signals.length > 0 && (
            <p className="font-mono text-xs text-slate/60 mt-2">
              Gem rate data isn&apos;t live yet (pop-report scrapers are still being wired up), so
              scores today are driven mostly by ROI and price momentum -- expect scores to improve
              in signal quality once real population data starts flowing in.
            </p>
          )}
        </div>

        {signals.length === 0 ? (
          <div className="border border-line bg-white/40 p-10 text-center">
            <p className="font-mono text-sm text-slate">
              No buy signals yet -- the cache hasn&apos;t been computed. It refreshes automatically
              at 2am UTC, or trigger it manually by running
              python-services/jobs/compute_buy_signals.py.
            </p>
          </div>
        ) : (
          <Suspense fallback={<p className="font-mono text-sm text-slate">Loading...</p>}>
            <BuySignalsTable signals={signals} />
          </Suspense>
        )}

        <p className="mt-6 font-mono text-[11px] text-slate/50 leading-relaxed">
          GradeIQ provides data for informational purposes only. Grading outcomes are not
          guaranteed. This is not financial advice.
        </p>
      </div>
      <AppFooter />
    </main>
  );
}
