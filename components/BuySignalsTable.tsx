"use client";

import { useMemo, useState } from "react";
import type { BuySignal } from "@/lib/buySignals";
import { ebaySoldListingsUrl } from "@/lib/ebayLink";

type SortKey = "iqScore" | "expectedRoiPct" | "maxBuyPrice";

const IQ_LABEL_STYLE: Record<BuySignal["iqLabel"], string> = {
  Excellent: "bg-moss text-paper",
  Strong: "bg-moss/20 text-moss border border-moss",
  Moderate: "bg-gold/20 text-ink border border-gold",
  Weak: "bg-rust/10 text-rust border border-rust",
};

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
            <option value="expectedRoiPct">Expected ROI%</option>
            <option value="maxBuyPrice">Max buy price</option>
          </select>
        </div>
        <span className="font-mono text-xs text-slate/60 ml-auto">
          {filtered.length} of {signals.length} cards
        </span>
      </div>

      {/* Table */}
      <div className="overflow-x-auto border border-line">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-white/60 border-b border-line font-mono text-[10px] uppercase tracking-widest text-slate/70">
              <th className="text-left px-4 py-3">IQ score</th>
              <th className="text-left px-4 py-3">Card</th>
              <th className="text-left px-4 py-3">Set</th>
              <th className="text-left px-4 py-3">Best grader</th>
              <th className="text-right px-4 py-3">Expected ROI%</th>
              <th className="text-right px-4 py-3">Max buy price</th>
              <th className="text-right px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((s) => (
              <tr key={`${s.cardId}-${s.bestGrader}`} className="border-b border-line last:border-0">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span className={`font-mono text-xs px-2 py-0.5 ${IQ_LABEL_STYLE[s.iqLabel]}`}>
                      {s.iqScore}
                    </span>
                    <span className="font-mono text-[10px] text-slate/60 hidden sm:inline">
                      {s.iqLabel}
                    </span>
                  </div>
                  <p
                    className="font-mono text-[10px] text-slate/50 mt-1 max-w-[220px] truncate"
                    title={s.iqReason}
                  >
                    {s.iqReason}
                  </p>
                </td>
                <td className="px-4 py-3 font-display text-base">{s.cardName}</td>
                <td className="px-4 py-3 font-mono text-xs text-slate">{s.setName}</td>
                <td className="px-4 py-3 font-mono text-xs">{s.bestGraderName}</td>
                <td
                  className={`px-4 py-3 text-right font-mono text-sm ${
                    s.expectedRoiPct >= 0 ? "text-moss" : "text-rust"
                  }`}
                >
                  {s.expectedRoiPct >= 0 ? "+" : ""}
                  {s.expectedRoiPct}%
                </td>
                <td className="px-4 py-3 text-right font-mono text-sm">
                  ${s.maxBuyPrice.toLocaleString()}
                </td>
                <td className="px-4 py-3 text-right">
                  <a
                    href={ebaySoldListingsUrl(s.cardName)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-[10px] uppercase tracking-widest border border-line px-2 py-1 hover:border-moss hover:text-moss transition-colors whitespace-nowrap"
                  >
                    Find on eBay
                  </a>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center font-mono text-sm text-slate/60">
                  No cards match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
