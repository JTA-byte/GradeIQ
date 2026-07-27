"use client";

import { useEffect, useState } from "react";

interface CardOption {
  id: string;
  name: string;
  set_name: string;
  card_number: string | null;
}

interface GemRateRow {
  id: string;
  grader: "PSA" | "CGC" | "BGS" | "TAG";
  top_grade_pop: number;
  total_pop: number;
  gem_rate: number;
  manually_entered: boolean;
  scraped_at: string;
}

const GRADERS = ["PSA", "CGC", "BGS", "TAG"] as const;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function AdminGemRatesManager() {
  const [cardQuery, setCardQuery] = useState("");
  const [cardOptions, setCardOptions] = useState<CardOption[]>([]);
  const [selectedCard, setSelectedCard] = useState<CardOption | null>(null);

  const [rates, setRates] = useState<GemRateRow[]>([]);
  const [loadingRates, setLoadingRates] = useState(false);

  const [grader, setGrader] = useState<(typeof GRADERS)[number]>("PSA");
  const [topGradePop, setTopGradePop] = useState("");
  const [totalPop, setTotalPop] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Card autocomplete, same debounce pattern as components/AlertsManager.tsx
  useEffect(() => {
    if (cardQuery.trim().length < 2 || selectedCard) {
      setCardOptions([]);
      return;
    }
    const controller = new AbortController();
    const timeout = setTimeout(async () => {
      try {
        const res = await fetch(`/api/cards/search?${new URLSearchParams({ name: cardQuery.trim() })}`, {
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data = await res.json();
        setCardOptions(data.cards ?? []);
      } catch {
        // Autocomplete failing silently is fine.
      }
    }, 300);
    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, [cardQuery, selectedCard]);

  useEffect(() => {
    if (!selectedCard) {
      setRates([]);
      return;
    }
    setLoadingRates(true);
    setError(null);
    fetch(`/api/admin/gem-rates?${new URLSearchParams({ cardId: selectedCard.id })}`)
      .then((res) => res.json())
      .then((data) => setRates(data.rates ?? []))
      .catch(() => setError("Could not load this card's existing gem rates."))
      .finally(() => setLoadingRates(false));
  }, [selectedCard]);

  const previewGemRate =
    topGradePop && totalPop && Number(totalPop) > 0
      ? ((Number(topGradePop) / Number(totalPop)) * 100).toFixed(2)
      : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!selectedCard) {
      setError("Search for and select a card first.");
      return;
    }
    const top = Number(topGradePop);
    const total = Number(totalPop);
    if (!topGradePop || !Number.isFinite(top) || top < 0) {
      setError("Enter a valid top-grade population.");
      return;
    }
    if (!totalPop || !Number.isFinite(total) || total <= 0) {
      setError("Enter a valid total population.");
      return;
    }
    if (top > total) {
      setError("Top-grade population can't exceed total population.");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/admin/gem-rates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardId: selectedCard.id, grader, topGradePop: top, totalPop: total }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save");

      setRates((prev) => [data.rate, ...prev]);
      setSuccess(`Saved ${grader} gem rate for ${selectedCard.name}.`);
      setTopGradePop("");
      setTotalPop("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="relative mb-6">
        <label className="block font-mono text-[10px] uppercase tracking-widest text-slate/70 mb-1">
          Find a card
        </label>
        <input
          type="text"
          placeholder="Card name -- e.g. Umbreon VMAX"
          value={selectedCard ? `${selectedCard.name} — ${selectedCard.set_name}` : cardQuery}
          onChange={(e) => {
            setSelectedCard(null);
            setSuccess(null);
            setCardQuery(e.target.value);
          }}
          className="w-full border border-line bg-white/60 px-3 py-2 font-mono text-sm focus:outline-none focus:border-moss"
        />
        {!selectedCard && cardOptions.length > 0 && (
          <ul className="absolute z-10 top-full left-0 right-0 mt-1 border border-line bg-paper shadow-md max-h-56 overflow-y-auto">
            {cardOptions.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedCard(c);
                    setCardOptions([]);
                  }}
                  className="w-full text-left px-3 py-2 font-mono text-xs hover:bg-moss/10 transition-colors"
                >
                  {c.name} — {c.set_name}
                  {c.card_number && ` #${c.card_number}`}
                </button>
              </li>
            ))}
          </ul>
        )}
        {selectedCard && (
          <button
            type="button"
            onClick={() => {
              setSelectedCard(null);
              setCardQuery("");
              setRates([]);
              setSuccess(null);
            }}
            className="mt-1 font-mono text-[10px] uppercase tracking-widest text-slate/60 hover:text-rust transition-colors"
          >
            Clear -- search a different card
          </button>
        )}
      </div>

      {selectedCard && (
        <>
          <form onSubmit={handleSubmit} className="border border-line bg-white/40 p-4 mb-6 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              <select
                value={grader}
                onChange={(e) => setGrader(e.target.value as (typeof GRADERS)[number])}
                className="border border-line bg-white/60 px-3 py-2 font-mono text-sm focus:outline-none focus:border-moss"
              >
                {GRADERS.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min={0}
                placeholder="Top-grade pop (e.g. PSA 10 count)"
                value={topGradePop}
                onChange={(e) => setTopGradePop(e.target.value)}
                className="border border-line bg-white/60 px-3 py-2 font-mono text-sm focus:outline-none focus:border-moss"
              />
              <input
                type="number"
                min={0}
                placeholder="Total population"
                value={totalPop}
                onChange={(e) => setTotalPop(e.target.value)}
                className="border border-line bg-white/60 px-3 py-2 font-mono text-sm focus:outline-none focus:border-moss"
              />
              <button
                type="submit"
                disabled={saving}
                className="bg-ink text-paper font-mono text-xs uppercase tracking-widest py-2 hover:bg-moss transition-colors disabled:opacity-40"
              >
                {saving ? "Saving..." : "Save gem rate"}
              </button>
            </div>
            {previewGemRate && (
              <p className="font-mono text-xs text-slate/70">
                Gem rate preview: <span className="text-ink font-bold">{previewGemRate}%</span>
              </p>
            )}
          </form>

          {error && (
            <div className="mb-4 px-4 py-3 font-mono text-sm border border-rust bg-rust/10 text-rust">{error}</div>
          )}
          {success && (
            <div className="mb-4 px-4 py-3 font-mono text-sm border border-moss bg-moss/10 text-moss">{success}</div>
          )}

          <h2 className="font-display text-lg mb-3">
            Existing gem rates for {selectedCard.name} ({selectedCard.set_name})
          </h2>
          {loadingRates ? (
            <p className="font-mono text-sm text-slate/60">Loading...</p>
          ) : rates.length === 0 ? (
            <p className="font-mono text-sm text-slate/60">No gem rate history for this card yet.</p>
          ) : (
            <div className="border border-line bg-white/40 overflow-x-auto">
              <table className="w-full font-mono text-sm">
                <thead>
                  <tr className="border-b border-line text-left">
                    <th className="px-4 py-2 font-mono text-[10px] uppercase tracking-widest text-slate/70">
                      Grader
                    </th>
                    <th className="px-4 py-2 font-mono text-[10px] uppercase tracking-widest text-slate/70 text-right">
                      Top grade
                    </th>
                    <th className="px-4 py-2 font-mono text-[10px] uppercase tracking-widest text-slate/70 text-right">
                      Total
                    </th>
                    <th className="px-4 py-2 font-mono text-[10px] uppercase tracking-widest text-slate/70 text-right">
                      Gem rate
                    </th>
                    <th className="px-4 py-2 font-mono text-[10px] uppercase tracking-widest text-slate/70">
                      Source
                    </th>
                    <th className="px-4 py-2 font-mono text-[10px] uppercase tracking-widest text-slate/70">
                      Date
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rates.map((r) => (
                    <tr key={r.id} className="border-b border-line last:border-b-0">
                      <td className="px-4 py-2">{r.grader}</td>
                      <td className="px-4 py-2 text-right">{r.top_grade_pop.toLocaleString()}</td>
                      <td className="px-4 py-2 text-right">{r.total_pop.toLocaleString()}</td>
                      <td className="px-4 py-2 text-right font-bold">{r.gem_rate}%</td>
                      <td className="px-4 py-2">
                        <span
                          className={`font-mono text-[10px] uppercase tracking-widest px-2 py-0.5 ${
                            r.manually_entered
                              ? "bg-gold/20 text-ink border border-gold"
                              : "bg-slate/10 text-slate border border-slate/40"
                          }`}
                        >
                          {r.manually_entered ? "Manual" : "Scraped"}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-slate/70">{formatDate(r.scraped_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
