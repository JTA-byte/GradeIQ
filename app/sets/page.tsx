import { AppHeader } from "@/components/AppHeader";
import { AppFooter } from "@/components/AppFooter";
import { SetsTable } from "@/components/SetsTable";
import { getSetRoiSummaries } from "@/lib/setRoiScanner";

// Same reasoning as app/buy-signals/page.tsx: avoid pre-rendering a page
// whose data set grows with every set/language combination scraped.
export const dynamic = "force-dynamic";

// The underlying data (market_sales) only changes when the nightly
// scrapers run, so there's no need to recompute this on every request.
export const revalidate = 3600;

export default async function SetsPage() {
  const summaries = await getSetRoiSummaries();

  return (
    <main className="min-h-screen bg-paper text-ink font-body">
      <AppHeader />
      <div className="max-w-6xl mx-auto px-6 py-10">
        <div className="mb-8">
          <h1 className="font-display text-3xl mb-2">Set ROI Scanner</h1>
          <p className="font-mono text-sm text-slate max-w-2xl">
            Every set ranked by average grading opportunity across its gradeable cards. Click a set
            to see its individual Buy Signals.
          </p>
        </div>

        {summaries.length === 0 ? (
          <div className="border border-line bg-white/40 p-10 text-center">
            <p className="font-mono text-sm text-slate">
              No set data yet -- no cards have scraped sale data. Run the nightly scrapers
              (python-services/jobs/nightly_price_scrape.py) to populate this page.
            </p>
          </div>
        ) : (
          <SetsTable summaries={summaries} />
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
