import { notFound } from "next/navigation";
import { AppHeader } from "@/components/AppHeader";
import { AppFooter } from "@/components/AppFooter";
import { BuySignalCard } from "@/components/BuySignalsTable";
import { getSetDetail } from "@/lib/setDetail";
import { TREND_BADGE } from "@/lib/trendBadge";

// Same reasoning as app/buy-signals/page.tsx and app/sets/page.tsx --
// avoid pre-rendering a page whose params aren't known at build time.
export const dynamic = "force-dynamic";
export const revalidate = 3600;

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-mono text-[10px] uppercase tracking-widest text-slate/60">{label}</div>
      <div className="font-display text-xl">{value}</div>
    </div>
  );
}

export default async function SetDetailPage({ params }: { params: { set: string } }) {
  // Confirmed live: this Next.js version does NOT auto-decode dynamic
  // segments (params.set arrives as the raw "Plasma%20Freeze", not
  // "Plasma Freeze"), unlike what App Router docs imply -- decode
  // explicitly rather than relying on it.
  const setName = decodeURIComponent(params.set);
  const detail = await getSetDetail(setName);
  if (!detail) notFound();

  return (
    <main className="min-h-screen bg-paper text-ink font-body">
      <AppHeader />
      <div className="max-w-6xl mx-auto px-6 py-10">
        <nav className="font-mono text-xs text-slate/70 mb-4">
          <a href="/buy-signals" className="hover:text-moss transition-colors">
            Buy Signals
          </a>
          {" → "}
          <a href="/sets" className="hover:text-moss transition-colors">
            Sets
          </a>
          {" → "}
          <span className="text-ink">{detail.setName}</span>
        </nav>

        <div className="mb-6">
          <h1 className="font-display text-3xl mb-1">{detail.setName}</h1>
          <p className="font-mono text-xs text-slate uppercase tracking-widest">{detail.language}</p>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4 border border-line bg-white/40 p-4">
          <Stat label="Gradeable cards" value={String(detail.cardsWithSalesData)} />
          <Stat label="Avg IQ score" value={String(detail.averageIqScore)} />
          <Stat label="Avg gem rate" value={`${detail.averageGemRatePct}%`} />
          <Stat
            label="Avg expected ROI"
            value={`${detail.averageExpectedRoiPct >= 0 ? "+" : ""}${detail.averageExpectedRoiPct}%`}
          />
        </div>

        <p className="font-mono text-sm text-slate mb-8">
          <span className="text-ink font-bold">{detail.cardsWithSalesData}</span> of{" "}
          <span className="text-ink font-bold">{detail.totalCardsInSet}</span> cards in this set have real
          sale data.
          {detail.bestCard && (
            <>
              {" "}
              Best opportunity: <span className="text-ink font-bold">{detail.bestCard.cardName}</span> at{" "}
              <span className="text-moss font-bold">
                {detail.bestCard.expectedRoiPct >= 0 ? "+" : ""}
                {detail.bestCard.expectedRoiPct}%
              </span>{" "}
              expected ROI.
            </>
          )}
        </p>

        {detail.graderProfiles.length > 0 && (
          <div className="mb-8 border border-line bg-white/40 p-5">
            <h2 className="font-display text-xl mb-1">Set Grading Profile</h2>
            <p className="font-mono text-xs text-slate mb-4">
              <span className="text-ink font-bold">{detail.graderProfiles[0].graderName}</span> performs
              best for this set overall -- avg IQ {detail.graderProfiles[0].averageIqScore} across{" "}
              {detail.graderProfiles[0].cardCount} card
              {detail.graderProfiles[0].cardCount === 1 ? "" : "s"}. Overall price trend:{" "}
              <span
                className={`inline-block font-mono text-[10px] uppercase tracking-widest px-2 py-0.5 ${TREND_BADGE[detail.overallTrend].className}`}
              >
                {TREND_BADGE[detail.overallTrend].label}
                {detail.averageGradedPriceChangePct !== null &&
                  ` (${detail.averageGradedPriceChangePct >= 0 ? "+" : ""}${detail.averageGradedPriceChangePct}%)`}
              </span>
            </p>

            <div className="overflow-x-auto">
              <table className="w-full font-mono text-sm">
                <thead>
                  <tr className="border-b border-line text-left">
                    <th className="py-2 pr-4 font-mono text-[10px] uppercase tracking-widest text-slate/70">
                      Grader
                    </th>
                    <th className="py-2 pr-4 font-mono text-[10px] uppercase tracking-widest text-slate/70 text-right">
                      Cards
                    </th>
                    <th className="py-2 pr-4 font-mono text-[10px] uppercase tracking-widest text-slate/70 text-right">
                      Avg IQ
                    </th>
                    <th className="py-2 pr-4 font-mono text-[10px] uppercase tracking-widest text-slate/70 text-right">
                      Avg gem rate
                    </th>
                    <th className="py-2 font-mono text-[10px] uppercase tracking-widest text-slate/70 text-right">
                      Avg ROI%
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {detail.graderProfiles.map((g) => (
                    <tr key={g.grader} className="border-b border-line last:border-b-0">
                      <td className="py-2 pr-4">{g.graderName}</td>
                      <td className="py-2 pr-4 text-right">{g.cardCount}</td>
                      <td className="py-2 pr-4 text-right">{g.averageIqScore}</td>
                      <td className="py-2 pr-4 text-right">{g.averageGemRatePct}%</td>
                      <td className="py-2 text-right text-moss font-bold">
                        {g.averageExpectedRoiPct >= 0 ? "+" : ""}
                        {g.averageExpectedRoiPct}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <h2 className="font-display text-xl mb-4">Buy Signals in {detail.setName}</h2>
        {detail.signals.length === 0 ? (
          <div className="border border-line p-10 text-center font-mono text-sm text-slate/60">
            No cards in this set have scraped sale data yet -- check back after tonight&apos;s scrape.
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {detail.signals.map((s) => (
              <BuySignalCard key={`${s.cardId}-${s.bestGrader}`} signal={s} />
            ))}
          </div>
        )}

        <p className="mt-6 font-mono text-[11px] text-slate/50 leading-relaxed">
          GradeIQ provides data for informational purposes only. Grading outcomes are not guaranteed. This
          is not financial advice.
        </p>
      </div>
      <AppFooter />
    </main>
  );
}
