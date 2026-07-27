"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { ActiveDeal, RecentRawDeal } from "@/lib/deals";

// Active listings move fast (bids, new listings, auctions ending) --
// router.refresh() re-runs the server component's data fetch (both
// getActiveDeals() and getRecentRawDeals()) on an interval without a
// full page reload or losing this component's filter state.
const AUTO_REFRESH_MS = 5 * 60 * 1000;

const GRADER_OPTIONS = ["all", "PSA", "CGC", "BGS", "TAG"] as const;
type GraderFilter = (typeof GRADER_OPTIONS)[number];

function iqScoreColor(score: number): string {
  if (score >= 70) return "bg-moss text-paper";
  if (score >= 50) return "bg-gold/30 text-ink border border-gold";
  return "bg-rust/10 text-rust border border-rust";
}

function graderCodeFromName(graderName: string): string {
  return graderName.split(" ")[0]?.toUpperCase() ?? "";
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

interface DealsViewProps {
  initialActiveDeals: ActiveDeal[];
  initialRecentRawDeals: RecentRawDeal[];
}

export function DealsView({ initialActiveDeals, initialRecentRawDeals }: DealsViewProps) {
  const router = useRouter();

  const [minIqScore, setMinIqScore] = useState(0);
  const [minDiscountPct, setMinDiscountPct] = useState(0);
  const [graderFilter, setGraderFilter] = useState<GraderFilter>("all");
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  useEffect(() => {
    const interval = setInterval(() => {
      router.refresh();
      setLastRefreshed(new Date());
    }, AUTO_REFRESH_MS);
    return () => clearInterval(interval);
  }, [router]);

  const filteredActiveDeals = useMemo(() => {
    return initialActiveDeals
      .filter((d) => d.iqScore >= minIqScore)
      .filter((d) => d.discountPct >= minDiscountPct)
      .filter((d) => graderFilter === "all" || d.grader === graderFilter)
      .sort((a, b) => b.discountAmount - a.discountAmount);
  }, [initialActiveDeals, minIqScore, minDiscountPct, graderFilter]);

  const filteredRecentRawDeals = useMemo(() => {
    return initialRecentRawDeals
      .filter((d) => d.iqScore >= minIqScore)
      .filter((d) => d.savingsPct >= minDiscountPct)
      .filter((d) => graderFilter === "all" || graderCodeFromName(d.bestGraderName) === graderFilter)
      .sort((a, b) => new Date(b.saleDate).getTime() - new Date(a.saleDate).getTime());
  }, [initialRecentRawDeals, minIqScore, minDiscountPct, graderFilter]);

  return (
    <div>
      {/* Filters */}
      <div className="flex flex-wrap items-end gap-4 mb-6 border border-line bg-white/40 p-4">
        <div>
          <label className="block font-mono text-[10px] uppercase tracking-widest text-slate/70 mb-1">
            Min IQ score
          </label>
          <input
            type="number"
            min={0}
            max={100}
            value={minIqScore}
            onChange={(e) => setMinIqScore(Number(e.target.value))}
            className="w-20 border border-line bg-white/60 px-2 py-1.5 font-mono text-sm focus:outline-none focus:border-moss"
          />
        </div>
        <div>
          <label className="block font-mono text-[10px] uppercase tracking-widest text-slate/70 mb-1">
            Min discount %
          </label>
          <input
            type="number"
            min={0}
            value={minDiscountPct}
            onChange={(e) => setMinDiscountPct(Number(e.target.value))}
            className="w-24 border border-line bg-white/60 px-2 py-1.5 font-mono text-sm focus:outline-none focus:border-moss"
          />
        </div>
        <div>
          <label className="block font-mono text-[10px] uppercase tracking-widest text-slate/70 mb-1">
            Grader
          </label>
          <select
            value={graderFilter}
            onChange={(e) => setGraderFilter(e.target.value as GraderFilter)}
            className="border border-line bg-white/60 px-2 py-1.5 font-mono text-sm focus:outline-none focus:border-moss"
          >
            {GRADER_OPTIONS.map((g) => (
              <option key={g} value={g}>
                {g === "all" ? "All graders" : g}
              </option>
            ))}
          </select>
        </div>
        <span className="font-mono text-xs text-slate/60 ml-auto">
          Auto-refreshes every 5 min{lastRefreshed && ` -- last refreshed ${formatDateTime(lastRefreshed.toISOString())}`}
        </span>
      </div>

      {/* Active deals */}
      <h2 className="font-display text-xl mb-4">
        🔥 Active Deals <span className="font-mono text-sm text-slate/60">({filteredActiveDeals.length})</span>
      </h2>
      {filteredActiveDeals.length === 0 ? (
        <div className="border border-line p-8 text-center font-mono text-sm text-slate/60 mb-10">
          No active listings below Max Buy Price match these filters right now -- check back soon, this
          list refreshes every 6 hours.
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-10">
          {filteredActiveDeals.map((d) => (
            <div key={d.listingId} className="border border-line bg-white/40 p-5 flex flex-col gap-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-display text-xl leading-tight">{d.cardName}</h3>
                  <p className="font-mono text-xs text-slate/70 mt-0.5">
                    {d.setName}
                    {d.cardNumber && ` #${d.cardNumber}`} · {d.grader} {d.grade}
                  </p>
                </div>
                <span className={`font-mono text-sm font-bold px-2.5 py-1 whitespace-nowrap ${iqScoreColor(d.iqScore)}`}>
                  {d.iqScore}
                </span>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <div className="font-mono text-[10px] uppercase tracking-widest text-slate/60">
                    Current price
                  </div>
                  <div className="font-display text-lg">${Math.round(d.currentPrice).toLocaleString()}</div>
                </div>
                <div>
                  <div className="font-mono text-[10px] uppercase tracking-widest text-slate/60">Max buy</div>
                  <div className="font-display text-lg">${Math.round(d.maxBuyPrice).toLocaleString()}</div>
                </div>
                <div className="border-2 border-moss px-2 py-1 flex flex-col justify-center">
                  <div className="font-mono text-[9px] uppercase tracking-widest text-slate/60">Save</div>
                  <div className="font-display text-lg text-moss">
                    ${Math.round(d.discountAmount).toLocaleString()} ({d.discountPct}%)
                  </div>
                </div>
              </div>

              <p className="font-mono text-xs text-slate/70 border-t border-line pt-3">
                Recommended: {d.bestGraderName} · Expected ROI:{" "}
                <span className="text-moss font-bold">
                  {d.expectedRoiPct >= 0 ? "+" : ""}
                  {d.expectedRoiPct}%
                </span>
                {d.auctionEndTime && <> · Ends {formatDateTime(d.auctionEndTime)}</>}
              </p>

              <a
                href={d.listingUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-[10px] uppercase tracking-widest bg-ink text-paper px-3 py-1.5 hover:bg-moss transition-colors text-center"
              >
                View listing
              </a>
            </div>
          ))}
        </div>
      )}

      {/* Recent raw deals */}
      <h2 className="font-display text-xl mb-4">
        Recent Raw Deals{" "}
        <span className="font-mono text-sm text-slate/60">({filteredRecentRawDeals.length})</span>
      </h2>
      {filteredRecentRawDeals.length === 0 ? (
        <div className="border border-line p-8 text-center font-mono text-sm text-slate/60">
          No raw sales in the last 30 days undercut their card&apos;s current Max Buy Price under these
          filters.
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {filteredRecentRawDeals.map((d, i) => (
            <div key={`${d.cardId}-${i}`} className="border border-line bg-white/40 p-5 flex flex-col gap-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-display text-xl leading-tight">{d.cardName}</h3>
                  <p className="font-mono text-xs text-slate/70 mt-0.5">
                    {d.setName}
                    {d.cardNumber && ` #${d.cardNumber}`}
                  </p>
                </div>
                <span className={`font-mono text-sm font-bold px-2.5 py-1 whitespace-nowrap ${iqScoreColor(d.iqScore)}`}>
                  {d.iqScore}
                </span>
              </div>

              <p className="font-body text-sm text-slate leading-relaxed">
                This card sold raw for <span className="text-ink font-bold">${d.soldPrice.toLocaleString()}</span>{" "}
                on {formatDate(d.saleDate)} via {d.sourceLabel} -- your Max Buy Price is{" "}
                <span className="text-ink font-bold">${Math.round(d.maxBuyPrice).toLocaleString()}</span>, saving{" "}
                <span className="text-moss font-bold">
                  ${Math.round(d.savingsAmount).toLocaleString()} ({d.savingsPct}%)
                </span>
                .
              </p>

              <p className="font-mono text-xs text-slate/70 border-t border-line pt-3">
                Recommended: {d.bestGraderName} · Expected ROI:{" "}
                <span className="text-moss font-bold">
                  {d.expectedRoiPct >= 0 ? "+" : ""}
                  {d.expectedRoiPct}%
                </span>
              </p>

              {d.sourceUrl && (
                <a
                  href={d.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-[10px] uppercase tracking-widest border border-line px-3 py-1.5 hover:border-moss hover:text-moss transition-colors text-center"
                >
                  View sale listing
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
