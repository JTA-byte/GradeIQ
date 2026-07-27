import { AppHeader } from "@/components/AppHeader";
import { AppFooter } from "@/components/AppFooter";
import { DealsView } from "@/components/DealsView";
import { getActiveDeals, getRecentRawDeals } from "@/lib/deals";

// Same reasoning as app/buy-signals/page.tsx -- active_listings and
// market_sales change often enough that pre-rendering this at build
// time would just serve stale deals.
export const dynamic = "force-dynamic";

export default async function DealsPage() {
  const [activeDeals, recentRawDeals] = await Promise.all([getActiveDeals(), getRecentRawDeals()]);

  return (
    <main className="min-h-screen bg-paper text-ink font-body">
      <AppHeader />
      <div className="max-w-6xl mx-auto px-6 py-10">
        <div className="mb-8">
          <h1 className="font-display text-3xl mb-2">Deals</h1>
          <p className="font-mono text-sm text-slate max-w-2xl">
            Cards currently listed on Alt.xyz below their Max Buy Price, plus recent raw sales that
            would have undercut it. Active listings refresh automatically every 5 minutes.
          </p>
        </div>

        <DealsView initialActiveDeals={activeDeals} initialRecentRawDeals={recentRawDeals} />

        <p className="mt-6 font-mono text-[11px] text-slate/50 leading-relaxed">
          GradeIQ provides data for informational purposes only. Grading outcomes are not
          guaranteed. Listing prices and auction end times change quickly -- always verify current
          details on the listing itself before buying. This is not financial advice.
        </p>
      </div>
      <AppFooter />
    </main>
  );
}
