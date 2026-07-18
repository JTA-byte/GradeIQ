"use client";

import { useMemo, useState } from "react";
import type { BuySignal, PriceConfidence } from "@/lib/buySignals";
import { ebayGradedSoldListingsUrl, ebaySoldListingsUrl } from "@/lib/ebayLink";
import { buildSaleListingUrl } from "@/lib/saleListingLink";

type SortKey = "iqScore" | "expectedRoiPct" | "maxBuyPrice" | "gapDollars";

function iqScoreColor(score: number): string {
  if (score >= 70) return "bg-moss text-paper";
  if (score >= 50) return "bg-gold/30 text-ink border border-gold";
  return "bg-rust/10 text-rust border border-rust";
}

const CONFIDENCE_STYLE: Record<PriceConfidence, string> = {
  high: "bg-moss/20 text-moss border border-moss",
  medium: "bg-gold/20 text-ink border border-gold",
  low: "bg-rust/10 text-rust border border-rust",
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatFullDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function BuySignalsTable({ signals }: { signals: BuySignal[] }) {
  const [minIq, setMinIq] = useState(0);
  const [maxIq, setMaxIq] = useState(100);
  const [graderFilter, setGraderFilter] = useState<string>("all");
  const [setFilter, setSetFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("iqScore");

  const graders = useMemo(
    () => Array.from(new Set(signals.map((s) => s.bestGrader))).sort(),
    [signals]
  );
  const sets = useMemo(
    () => Array.from(new Set(signals.map((s) => s.setName))).sort(),
    [signals]
  );

  const filtered = useMemo(() => {
    return signals
      .filter((s) => s.iqScore >= minIq && s.iqScore <= maxIq)
      .filter((s) => graderFilter === "all" || s.bestGrader === graderFilter)
      .filter((s) => setFilter === "all" || s.setName === setFilter)
      .sort((a, b) => b[sortKey] - a[sortKey]);
  }, [signals, minIq, maxIq, graderFilter, setFilter, sortKey]);

  const summary = useMemo(() => {
    if (signals.length === 0) return null;
    const avgGap = signals.reduce((sum, s) => sum + s.gapDollars, 0) / signals.length;
    const best = signals.reduce((a, b) => (b.iqScore > a.iqScore ? b : a));
    return { count: signals.length, avgGap, bestName: best.cardName };
  }, [signals]);

  return (
    <div>
      <HowToUseSection />

      {summary && (
        <div className="mb-6 border border-line bg-white/40 p-4 font-mono text-xs text-slate flex flex-wrap gap-x-6 gap-y-2">
          <span>
            <span className="text-ink font-bold">{summary.count}</span> cards analyzed
          </span>
          <span>
            Average gap: <span className="text-ink font-bold">${Math.round(summary.avgGap).toLocaleString()}</span>
          </span>
          <span>
            Best opportunity: <span className="text-ink font-bold">{summary.bestName}</span>
          </span>
        </div>
      )}

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
            value={minIq}
            onChange={(e) => setMinIq(Number(e.target.value))}
            className="w-20 border border-line bg-white/60 px-2 py-1.5 font-mono text-sm focus:outline-none focus:border-moss"
          />
        </div>
        <div>
          <label className="block font-mono text-[10px] uppercase tracking-widest text-slate/70 mb-1">
            Max IQ score
          </label>
          <input
            type="number"
            min={0}
            max={100}
            value={maxIq}
            onChange={(e) => setMaxIq(Number(e.target.value))}
            className="w-20 border border-line bg-white/60 px-2 py-1.5 font-mono text-sm focus:outline-none focus:border-moss"
          />
        </div>
        <div>
          <label className="block font-mono text-[10px] uppercase tracking-widest text-slate/70 mb-1">
            Grader
          </label>
          <select
            value={graderFilter}
            onChange={(e) => setGraderFilter(e.target.value)}
            className="border border-line bg-white/60 px-2 py-1.5 font-mono text-sm focus:outline-none focus:border-moss"
          >
            <option value="all">All graders</option>
            {graders.map((g) => (
              <option key={g} value={g}>
                {g.toUpperCase()}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block font-mono text-[10px] uppercase tracking-widest text-slate/70 mb-1">
            Set
          </label>
          <select
            value={setFilter}
            onChange={(e) => setSetFilter(e.target.value)}
            className="border border-line bg-white/60 px-2 py-1.5 font-mono text-sm focus:outline-none focus:border-moss max-w-[220px]"
          >
            <option value="all">All sets</option>
            {sets.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block font-mono text-[10px] uppercase tracking-widest text-slate/70 mb-1">
            Sort by
          </label>
          <select
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
            className="border border-line bg-white/60 px-2 py-1.5 font-mono text-sm focus:outline-none focus:border-moss"
          >
            <option value="iqScore">IQ score</option>
            <option value="gapDollars">Price gap</option>
            <option value="expectedRoiPct">Expected ROI%</option>
            <option value="maxBuyPrice">Max buy price</option>
          </select>
        </div>
        <span className="font-mono text-xs text-slate/60 ml-auto">
          {filtered.length} of {signals.length} cards
        </span>
      </div>

      {/* Card grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {filtered.map((s) => (
          <BuySignalCard key={`${s.cardId}-${s.bestGrader}`} signal={s} />
        ))}
        {filtered.length === 0 && (
          <div className="lg:col-span-2 border border-line p-10 text-center font-mono text-sm text-slate/60">
            No cards match these filters.
          </div>
        )}
      </div>
    </div>
  );
}

function HowToUseSection() {
  const [open, setOpen] = useState(false);

  return (
    <div className="mb-6 border border-line bg-white/40">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 font-mono text-xs uppercase tracking-widest text-slate hover:text-moss transition-colors"
      >
        How to use Buy Signals
        <span className="font-mono text-sm">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-3 font-body text-sm text-slate leading-relaxed border-t border-line pt-3">
          <p>
            <span className="font-display text-ink">IQ Score</span> is a single 0-100 signal blending gem
            rate, expected net ROI, recent sale-price momentum, and pop growth. Higher is a stronger
            opportunity right now:{" "}
            <span className="text-moss font-mono">70+ green</span>,{" "}
            <span className="text-ink font-mono">50-69 yellow</span>,{" "}
            <span className="text-rust font-mono">below 50 orange</span>.
          </p>
          <p>
            <span className="font-display text-ink">Max Buy Price</span> is the most you could pay for a
            raw copy and still hit a solid net ROI target with the recommended grader, after subtracting
            grading fees, shipping, and platform fees from the expected graded sale price. Paying more than
            this erodes the opportunity.
          </p>
          <p>
            <span className="font-display text-ink">Price confidence</span> reflects how many real sales
            back a card&apos;s numbers in the last 90 days: <span className="text-moss">High</span> (10+
            sales), <span className="text-ink">Medium</span> (5-9 sales), or{" "}
            <span className="text-rust">Low</span> (under 5 sales -- treat the price as a rough estimate,
            not a firm number).
          </p>
          <p>
            <span className="font-display text-ink">Acting on a signal:</span> find a raw copy at or below
            the Max Buy Price, confirm its condition matches what the target grade needs, then send it to
            the recommended grader. The gap and confidence badge tell you how much conviction to have
            before you commit money.
          </p>
        </div>
      )}
    </div>
  );
}

function BuySignalCard({ signal: s }: { signal: BuySignal }) {
  const [salesOpen, setSalesOpen] = useState(false);
  const [watchlistState, setWatchlistState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  async function addToWatchlist() {
    setWatchlistState("saving");
    try {
      const res = await fetch("/api/portfolio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cardName: s.cardName,
          isWatchlist: true,
          targetPrice: s.maxBuyPrice,
        }),
      });
      if (res.status === 401) {
        window.location.href = "/auth/login";
        return;
      }
      if (!res.ok) throw new Error("failed");
      setWatchlistState("saved");
    } catch {
      setWatchlistState("error");
    }
  }

  return (
    <div className="border border-line bg-white/40 p-5 flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-display text-2xl leading-tight">{s.cardName}</h3>
          <p className="font-mono text-xs text-slate/70 mt-0.5">
            {s.setName}
            {s.cardNumber && ` #${s.cardNumber}`}
          </p>
          <p className="font-mono text-xs text-slate mt-1">
            Target: <span className="text-ink font-bold">{s.targetGradeLabel}</span>
          </p>
        </div>
        <span className={`font-mono text-sm font-bold px-2.5 py-1 whitespace-nowrap ${iqScoreColor(s.iqScore)}`}>
          {s.iqScore}
        </span>
      </div>

      {/* Price context row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-slate/60">Raw</div>
          <div className="font-display text-lg">
            ~${Math.round(s.rawMarketPrice).toLocaleString()}
            {s.isRawPriceEstimated && <span className="font-mono text-[9px] text-slate/50 ml-1">est.</span>}
          </div>
        </div>
        <div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-slate/60">
            {s.targetGradeLabel} avg
          </div>
          <div className="font-display text-lg">${Math.round(s.topGradePrice).toLocaleString()}</div>
        </div>
        <div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-slate/60">Gap</div>
          <div className="font-display text-lg text-moss">+${Math.round(s.gapDollars).toLocaleString()}</div>
        </div>
        <div className="border-2 border-ink px-2 py-1 flex flex-col justify-center">
          <div className="font-mono text-[9px] uppercase tracking-widest text-slate/60">Buy ≤</div>
          <div className="font-display text-xl">${Math.round(s.maxBuyPrice).toLocaleString()}</div>
        </div>
      </div>

      {/* Signal quality row */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs text-slate/70 border-t border-line pt-3">
        <span>
          Based on {s.recentSaleCount90d} sale{s.recentSaleCount90d === 1 ? "" : "s"}, last 90 days
        </span>
        <span className={`px-2 py-0.5 uppercase tracking-widest text-[10px] ${CONFIDENCE_STYLE[s.priceConfidence]}`}>
          {s.priceConfidence}
        </span>
        {s.lastSaleDate && <span>Last sold {formatDate(s.lastSaleDate)}</span>}
      </div>

      {/* Why this card */}
      <p className="font-body text-sm text-slate leading-relaxed border-t border-line pt-3">{s.whyReason}</p>

      {/* Recent graded sales */}
      <div className="border-t border-line pt-3">
        <button
          onClick={() => setSalesOpen((v) => !v)}
          className="w-full flex items-center justify-between font-mono text-[10px] uppercase tracking-widest text-slate hover:text-moss transition-colors"
        >
          Recent Sales ({s.recentSales.length})
          <span className="font-mono text-sm">{salesOpen ? "−" : "+"}</span>
        </button>
        {salesOpen && (
          <div className="mt-2 space-y-1.5">
            {s.recentSales.length === 0 ? (
              <p className="font-mono text-xs text-slate/60">
                No recent sales data -- check back after tonight&apos;s scrape.
              </p>
            ) : (
              s.recentSales.map((sale, i) => (
                <a
                  key={i}
                  href={buildSaleListingUrl(s.cardName, sale)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block font-mono text-xs text-slate hover:text-moss transition-colors underline decoration-dotted underline-offset-2"
                >
                  {sale.grader ? `${sale.grader} ${sale.grade}` : "Raw"} — $
                  {sale.price.toLocaleString()} — {formatFullDate(sale.date)} — {sale.sourceLabel}
                </a>
              ))
            )}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-2 border-t border-line pt-3">
        <a
          href={ebaySoldListingsUrl(s.cardName)}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-[10px] uppercase tracking-widest border border-line px-3 py-1.5 hover:border-moss hover:text-moss transition-colors"
        >
          Find raw on eBay
        </a>
        <a
          href={ebayGradedSoldListingsUrl(s.cardName, s.targetGradeLabel)}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-[10px] uppercase tracking-widest border border-line px-3 py-1.5 hover:border-moss hover:text-moss transition-colors"
        >
          Find graded on eBay
        </a>
        <button
          onClick={addToWatchlist}
          disabled={watchlistState === "saving" || watchlistState === "saved"}
          className="font-mono text-[10px] uppercase tracking-widest bg-ink text-paper px-3 py-1.5 hover:bg-moss transition-colors disabled:opacity-50"
        >
          {watchlistState === "saved"
            ? "Added to watchlist"
            : watchlistState === "saving"
              ? "Adding..."
              : watchlistState === "error"
                ? "Failed -- retry"
                : "Add to watchlist"}
        </button>
      </div>
    </div>
  );
}
