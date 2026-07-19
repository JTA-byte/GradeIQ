"use client";

import { useMemo, useState } from "react";
import type { SetRoiSummary } from "@/lib/setRoiScanner";

type SortKey = "averageExpectedRoiPct" | "averageIqScore" | "cardCount";

function iqScoreColor(score: number): string {
  if (score >= 70) return "bg-moss text-paper";
  if (score >= 50) return "bg-gold/30 text-ink border border-gold";
  return "bg-rust/10 text-rust border border-rust";
}

export function SetsTable({ summaries }: { summaries: SetRoiSummary[] }) {
  const [languageFilter, setLanguageFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("averageExpectedRoiPct");

  const languages = useMemo(
    () => Array.from(new Set(summaries.map((s) => s.language))).sort(),
    [summaries]
  );

  const filtered = useMemo(() => {
    return summaries
      .filter((s) => languageFilter === "all" || s.language === languageFilter)
      .sort((a, b) => b[sortKey] - a[sortKey]);
  }, [summaries, languageFilter, sortKey]);

  return (
    <div>
      {/* Filters */}
      <div className="flex flex-wrap items-end gap-4 mb-6 border border-line bg-white/40 p-4">
        <div>
          <label className="block font-mono text-[10px] uppercase tracking-widest text-slate/70 mb-1">
            Language
          </label>
          <select
            value={languageFilter}
            onChange={(e) => setLanguageFilter(e.target.value)}
            className="border border-line bg-white/60 px-2 py-1.5 font-mono text-sm focus:outline-none focus:border-moss"
          >
            <option value="all">All languages</option>
            {languages.map((l) => (
              <option key={l} value={l}>
                {l}
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
            <option value="averageExpectedRoiPct">Average expected ROI%</option>
            <option value="averageIqScore">Average IQ score</option>
            <option value="cardCount">Gradeable card count</option>
          </select>
        </div>
        <span className="font-mono text-xs text-slate/60 ml-auto">
          {filtered.length} of {summaries.length} sets
        </span>
      </div>

      {/* Table */}
      <div className="border border-line bg-white/40 overflow-x-auto">
        <table className="w-full font-mono text-sm">
          <thead>
            <tr className="border-b border-line text-left">
              <th className="px-4 py-3 font-mono text-[10px] uppercase tracking-widest text-slate/70">
                Set
              </th>
              <th className="px-4 py-3 font-mono text-[10px] uppercase tracking-widest text-slate/70">
                Language
              </th>
              <th className="px-4 py-3 font-mono text-[10px] uppercase tracking-widest text-slate/70 text-right">
                Gradeable cards
              </th>
              <th className="px-4 py-3 font-mono text-[10px] uppercase tracking-widest text-slate/70 text-right">
                Avg IQ score
              </th>
              <th className="px-4 py-3 font-mono text-[10px] uppercase tracking-widest text-slate/70 text-right">
                Avg gem rate
              </th>
              <th className="px-4 py-3 font-mono text-[10px] uppercase tracking-widest text-slate/70 text-right">
                Avg expected ROI%
              </th>
              <th className="px-4 py-3 font-mono text-[10px] uppercase tracking-widest text-slate/70">
                Best card
              </th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((s) => (
              <tr key={`${s.setName}::${s.language}`} className="border-b border-line last:border-b-0">
                <td className="px-4 py-3 font-display text-base">{s.setName}</td>
                <td className="px-4 py-3 text-slate/70">{s.language}</td>
                <td className="px-4 py-3 text-right">{s.cardCount}</td>
                <td className="px-4 py-3 text-right">
                  <span className={`inline-block font-bold px-2 py-0.5 ${iqScoreColor(s.averageIqScore)}`}>
                    {s.averageIqScore}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">{s.averageGemRatePct}%</td>
                <td className="px-4 py-3 text-right text-moss font-bold">
                  {s.averageExpectedRoiPct >= 0 ? "+" : ""}
                  {s.averageExpectedRoiPct}%
                </td>
                <td className="px-4 py-3 text-slate/80 truncate max-w-[200px]" title={s.bestCard.cardName}>
                  {s.bestCard.cardName}
                </td>
                <td className="px-4 py-3">
                  <a
                    href={`/buy-signals?set=${encodeURIComponent(s.setName)}`}
                    className="font-mono text-[10px] uppercase tracking-widest border border-line px-3 py-1.5 hover:border-moss hover:text-moss transition-colors whitespace-nowrap"
                  >
                    View signals
                  </a>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-slate/60">
                  No sets match this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
