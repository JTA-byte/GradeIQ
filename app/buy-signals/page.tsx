import { AppHeader } from "@/components/AppHeader";
import { AppFooter } from "@/components/AppFooter";
import { BuySignalsTable } from "@/components/BuySignalsTable";
import { getBuySignals } from "@/lib/buySignals";

// Render on-demand instead of pre-rendering at build time -- with
// 2,220+ cards, the pre-rendered HTML for this page exceeds Vercel's
// build output size limit (FALLBACK_BODY_TOO_LARGE at 19.71 MB).
export const dynamic = "force-dynamic";

// The underlying data (market_sales, gem_rates) only changes when the
// nightly scrapers run, so there's no need to recompute this on every
// request -- cache for an hour and let ISR revalidate in the background.
export const revalidate = 3600;

export default async function BuySignalsPage() {
  const signals = await getBuySignals();

  return (
    <main className="min-h-screen bg-paper text-ink font-body">
      <AppHeader />
      <div className="max-w-6xl mx-auto px-6 py-10">
        <div className="mb-8">
          <h1 className="font-display text-3xl mb-2">Buy Signals</h1>
          <p className="font-mono text-sm text-slate max-w-2xl">
            Top grading opportunities across every card with real scraped sale data, ranked by IQ
            Score. Updates nightly as the scrapers run.
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
              No buy signals yet -- no cards have scraped sale data. Run the nightly scrapers
              (python-services/jobs/nightly_price_scrape.py) to populate this page.
            </p>
          </div>
        ) : (
          <BuySignalsTable signals={signals} />
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
