"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { BuySignal, PriceConfidence, PriceTrend } from "@/lib/buySignals";
import { ebayGradedSoldListingsUrl, ebayRawSoldListingsUrl } from "@/lib/ebayLink";
import { buildSaleListingUrl } from "@/lib/saleListingLink";

type SortKey = "iqScore" | "expectedRoiPct" | "maxBuyPrice" | "gapDollars";
type TrendFilter = "all" | "trending_up" | "stable" | "cooling";

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

const TREND_BADGE: Record<PriceTrend, { label: string; className: string }> = {
  trending_up: { label: "🔥 Trending Up", className: "bg-gold/20 text-ink border border-gold" },
  cooling: { label: "❄️ Cooling", className: "bg-slate/10 text-slate border border-slate/40" },
  stable: { label: "→ Stable", className: "text-slate/60" },
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatFullDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function BuySignalsTable({ signals }: { signals: BuySignal[] }) {
  const searchParams = useSearchParams();
  const initialSet = searchParams.get("set");

  const [minIq, setMinIq] = useState(0);
  const [maxIq, setMaxIq] = useState(100);
  const [graderFilter, setGraderFilter] = useState<string>("all");
  const [setFilter, setSetFilter] = useState<string>(initialSet ?? "all");
  const [sortKey, setSortKey] = useState<SortKey>("iqScore");
  const [minRawPrice, setMinRawPrice] = useState("");
  const [maxRawPrice, setMaxRawPrice] = useState("");
  const [minVolumeOnly, setMinVolumeOnly] = useState(false);
  const [trendFilter, setTrendFilter] = useState<TrendFilter>("all");

  const graders = useMemo(
    () => Array.from(new Set(signals.map((s) => s.bestGrader))).sort(),
    [signals]
  );
  const sets = useMemo(
    () => Array.from(new Set(signals.map((s) => s.setName))).sort(),
    [signals]
  );

  const filtered = useMemo(() => {
    const minPrice = minRawPrice.trim() ? Number(minRawPrice) : null;
    const maxPrice = maxRawPrice.trim() ? Number(maxRawPrice) : null;

    return signals
      .filter((s) => s.iqScore >= minIq && s.iqScore <= maxIq)
      .filter((s) => graderFilter === "all" || s.bestGrader === graderFilter)
      .filter((s) => setFilter === "all" || s.setName === setFilter)
      .filter((s) => minPrice === null || s.rawMarketPrice >= minPrice)
      .filter((s) => maxPrice === null || s.rawMarketPrice <= maxPrice)
      .filter((s) => !minVolumeOnly || s.recentSaleCount90d >= 5)
      .filter((s) => trendFilter === "all" || s.trend === trendFilter)
      .sort((a, b) => b[sortKey] - a[sortKey]);
  }, [signals, minIq, maxIq, graderFilter, setFilter, sortKey, minRawPrice, maxRawPrice, minVolumeOnly, trendFilter]);

  const summary = useMemo(() => {
    if (signals.length === 0) return null;
    const avgGap = signals.reduce((sum, s) => sum + s.gapDollars, 0) / signals.length;
    const best = signals.reduce((a, b) => (b.iqScore > a.iqScore ? b : a));
    return { count: signals.length, avgGap, bestName: best.cardName };
  }, [signals]);

  const trendingNow = useMemo(() => {
    return signals
      .filter((s) => s.trend === "trending_up")
      .sort((a, b) => (b.gradedPriceChangePct ?? 0) - (a.gradedPriceChangePct ?? 0))
      .slice(0, 5);
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

      {trendingNow.length > 0 && (
        <div className="mb-6 border border-gold bg-gold/10 p-4">
          <h3 className="font-display text-lg mb-3">🔥 Trending Now</h3>
          <div className="grid grid-cols-1 sm:grid-cols-5 gap-3">
            {trendingNow.map((s) => (
              <div key={`trending-${s.cardId}`} className="font-mono text-xs bg-white/60 border border-line p-2">
                <div className="font-display text-sm truncate" title={s.cardName}>
                  {s.cardName}
                </div>
                <div className="text-slate/70 truncate">{s.setName}</div>
                <div className="text-moss font-bold mt-1">
                  {s.gradedPriceChangePct !== null && s.gradedPriceChangePct >= 0 ? "+" : ""}
                  {s.gradedPriceChangePct}%
                </div>
              </div>
            ))}
          </div>
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
        <div>
          <label className="block font-mono text-[10px] uppercase tracking-widest text-slate/70 mb-1">
            Raw price min
          </label>
          <input
            type="number"
            min={0}
            placeholder="$0"
            value={minRawPrice}
            onChange={(e) => setMinRawPrice(e.target.value)}
            className="w-24 border border-line bg-white/60 px-2 py-1.5 font-mono text-sm focus:outline-none focus:border-moss"
          />
        </div>
        <div>
          <label className="block font-mono text-[10px] uppercase tracking-widest text-slate/70 mb-1">
            Raw price max
          </label>
          <input
            type="number"
            min={0}
            placeholder="No limit"
            value={maxRawPrice}
            onChange={(e) => setMaxRawPrice(e.target.value)}
            className="w-24 border border-line bg-white/60 px-2 py-1.5 font-mono text-sm focus:outline-none focus:border-moss"
          />
        </div>
        <div>
          <label className="block font-mono text-[10px] uppercase tracking-widest text-slate/70 mb-1">
            Trend
          </label>
          <select
            value={trendFilter}
            onChange={(e) => setTrendFilter(e.target.value as TrendFilter)}
            className="border border-line bg-white/60 px-2 py-1.5 font-mono text-sm focus:outline-none focus:border-moss"
          >
            <option value="all">All trends</option>
            <option value="trending_up">🔥 Trending up</option>
            <option value="stable">→ Stable</option>
            <option value="cooling">❄️ Cooling</option>
          </select>
        </div>
        <label className="flex items-center gap-2 font-mono text-xs text-slate pb-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={minVolumeOnly}
            onChange={(e) => setMinVolumeOnly(e.target.checked)}
            className="accent-moss"
          />
          5+ sales only
        </label>
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
  const [alertOpen, setAlertOpen] = useState(false);
  const [alertPrice, setAlertPrice] = useState(() => String(Math.round(s.maxBuyPrice)));
  const [alertState, setAlertState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  const cardIdentifier = {
    cardName: s.cardName,
    cardNumber: s.cardNumber,
    setName: s.setName,
    variant: s.variant,
    variantDetail: s.variantDetail,
    language: s.language,
  };

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

  async function createPriceAlert() {
    const price = Number(alertPrice);
    if (!alertPrice || Number.isNaN(price) || price <= 0) {
      setAlertState("error");
      return;
    }
    setAlertState("saving");
    try {
      const res = await fetch("/api/alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cardId: s.cardId,
          cardName: s.cardName,
          setName: s.setName,
          targetPrice: price,
          alertType: "below_price",
        }),
      });
      if (res.status === 401) {
        window.location.href = "/auth/login";
        return;
      }
      if (!res.ok) throw new Error("failed");
      setAlertState("saved");
    } catch {
      setAlertState("error");
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
            {s.variant && s.variant !== "Normal" && ` · ${s.variant}`}
            {s.variantDetail && ` (${s.variantDetail})`}
            {" · "}
            {s.language}
          </p>
          <p className="font-mono text-xs text-slate mt-1">
            Target: <span className="text-ink font-bold">{s.targetGradeLabel}</span>
          </p>
          <span
            className={`inline-block mt-1.5 font-mono text-[10px] uppercase tracking-widest px-2 py-0.5 ${TREND_BADGE[s.trend].className}`}
          >
            {TREND_BADGE[s.trend].label}
            {s.gradedPriceChangePct !== null && ` (${s.gradedPriceChangePct >= 0 ? "+" : ""}${s.gradedPriceChangePct}%)`}
          </span>
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
        <span title="0-100: sale volume, recency, price consistency, and whether the raw price is real vs. estimated">
          Data quality: <span className="text-ink font-bold">{s.dataQualityScore}</span>
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
                  href={buildSaleListingUrl(cardIdentifier, sale)}
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
          href={ebayRawSoldListingsUrl(cardIdentifier)}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-[10px] uppercase tracking-widest border border-line px-3 py-1.5 hover:border-moss hover:text-moss transition-colors"
        >
          Find raw on eBay
        </a>
        <a
          href={ebayGradedSoldListingsUrl(cardIdentifier, s.targetGradeLabel)}
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
        <button
          onClick={() => setAlertOpen((v) => !v)}
          className="font-mono text-[10px] uppercase tracking-widest border border-line px-3 py-1.5 hover:border-moss hover:text-moss transition-colors"
        >
          Set Price Alert
        </button>
      </div>

      {alertOpen && (
        <div className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
          <div>
            <label className="block font-mono text-[10px] uppercase tracking-widest text-slate/70 mb-1">
              Notify when raw price drops below
            </label>
            <input
              type="number"
              step="0.01"
              value={alertPrice}
              onChange={(e) => setAlertPrice(e.target.value)}
              className="w-28 border border-line bg-white/60 px-2 py-1.5 font-mono text-sm focus:outline-none focus:border-moss"
            />
          </div>
          <button
            onClick={createPriceAlert}
            disabled={alertState === "saving" || alertState === "saved"}
            className="font-mono text-[10px] uppercase tracking-widest bg-ink text-paper px-3 py-2 hover:bg-moss transition-colors disabled:opacity-50"
          >
            {alertState === "saved"
              ? "Alert created"
              : alertState === "saving"
                ? "Saving..."
                : alertState === "error"
                  ? "Failed -- retry"
                  : "Create alert"}
          </button>
        </div>
      )}
    </div>
  );
}
