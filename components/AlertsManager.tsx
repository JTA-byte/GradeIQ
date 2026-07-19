"use client";

import { useEffect, useState } from "react";

export interface PriceAlert {
  id: string;
  card_id: string;
  card_name: string;
  set_name: string;
  target_price: number;
  alert_type: "below_price" | "above_price";
  is_active: boolean;
  triggered_at: string | null;
  triggered_price: number | null;
  created_at: string;
}

interface CardOption {
  id: string;
  name: string;
  set_name: string;
  card_number: string | null;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function AlertsManager({ initialAlerts }: { initialAlerts: PriceAlert[] }) {
  const [alerts, setAlerts] = useState<PriceAlert[]>(initialAlerts);
  const [error, setError] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);

  const [cardQuery, setCardQuery] = useState("");
  const [cardOptions, setCardOptions] = useState<CardOption[]>([]);
  const [selectedCard, setSelectedCard] = useState<CardOption | null>(null);
  const [targetPrice, setTargetPrice] = useState("");
  const [alertType, setAlertType] = useState<"below_price" | "above_price">("below_price");
  const [adding, setAdding] = useState(false);

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

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const price = Number(targetPrice);
    if (!selectedCard) {
      setError("Search for and select a card first.");
      return;
    }
    if (!targetPrice || Number.isNaN(price) || price <= 0) {
      setError("Enter a valid target price.");
      return;
    }

    setAdding(true);
    try {
      const res = await fetch("/api/alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cardId: selectedCard.id,
          cardName: selectedCard.name,
          setName: selectedCard.set_name,
          targetPrice: price,
          alertType,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create alert");

      setAlerts((prev) => [data.alert, ...prev]);
      setSelectedCard(null);
      setCardQuery("");
      setTargetPrice("");
      setShowAddForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setAdding(false);
    }
  }

  async function toggleActive(alert: PriceAlert) {
    setError(null);
    try {
      const res = await fetch(`/api/alerts/${alert.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !alert.is_active }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to update alert");
      setAlerts((prev) => prev.map((a) => (a.id === alert.id ? data.alert : a)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  async function deleteAlert(id: string) {
    setError(null);
    try {
      const res = await fetch(`/api/alerts/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to delete alert");
      }
      setAlerts((prev) => prev.filter((a) => a.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-display text-xl">Your alerts</h2>
        <button
          onClick={() => setShowAddForm((v) => !v)}
          className="font-mono text-xs uppercase tracking-widest bg-ink text-paper px-4 py-2 hover:bg-moss transition-colors"
        >
          {showAddForm ? "Cancel" : "+ New alert"}
        </button>
      </div>

      {showAddForm && (
        <form onSubmit={handleAdd} className="border border-line bg-white/40 p-4 mb-6 space-y-3">
          <div className="relative">
            <input
              type="text"
              placeholder="Card name -- e.g. Umbreon VMAX"
              value={selectedCard ? `${selectedCard.name} — ${selectedCard.set_name}` : cardQuery}
              onChange={(e) => {
                setSelectedCard(null);
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
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <select
              value={alertType}
              onChange={(e) => setAlertType(e.target.value as "below_price" | "above_price")}
              className="border border-line bg-white/60 px-3 py-2 font-mono text-sm focus:outline-none focus:border-moss"
            >
              <option value="below_price">Notify when price drops below</option>
              <option value="above_price">Notify when price rises above</option>
            </select>
            <input
              type="number"
              step="0.01"
              placeholder="Target price ($)"
              value={targetPrice}
              onChange={(e) => setTargetPrice(e.target.value)}
              className="border border-line bg-white/60 px-3 py-2 font-mono text-sm focus:outline-none focus:border-moss"
            />
            <button
              type="submit"
              disabled={adding}
              className="bg-ink text-paper font-mono text-xs uppercase tracking-widest py-2 hover:bg-moss transition-colors disabled:opacity-40"
            >
              {adding ? "Adding..." : "Create alert"}
            </button>
          </div>
        </form>
      )}

      {error && (
        <div className="mb-4 px-4 py-3 font-mono text-sm border border-rust bg-rust/10 text-rust">
          {error}
        </div>
      )}

      <div className="space-y-3">
        {alerts.length === 0 && !showAddForm && (
          <div className="border border-line p-8 text-center">
            <p className="font-mono text-sm text-slate">
              No alerts yet. Create one above, or use "Set Price Alert" on any card in Buy
              Signals.
            </p>
          </div>
        )}

        {alerts.map((alert) => (
          <div key={alert.id} className="border border-line bg-white/40 p-4 flex items-center justify-between gap-3 flex-wrap">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span
                  className={`font-mono text-[10px] uppercase tracking-widest px-2 py-0.5 ${
                    alert.triggered_at
                      ? "bg-moss/10 text-moss border border-moss"
                      : alert.is_active
                        ? "bg-gold/10 text-ink border border-gold/60"
                        : "bg-slate/10 text-slate border border-slate/40"
                  }`}
                >
                  {alert.triggered_at ? "Triggered" : alert.is_active ? "Active" : "Paused"}
                </span>
                <h3 className="font-display text-lg">{alert.card_name}</h3>
              </div>
              <p className="font-mono text-xs text-slate/70">
                {alert.set_name} · Notify when price {alert.alert_type === "below_price" ? "drops below" : "rises above"}{" "}
                <span className="text-ink">${alert.target_price.toLocaleString()}</span>
                {alert.triggered_at && (
                  <>
                    {" "}
                    — triggered {formatDate(alert.triggered_at)}
                    {alert.triggered_price !== null && ` at $${alert.triggered_price.toLocaleString()}`}
                  </>
                )}
              </p>
            </div>
            <div className="flex items-center gap-3">
              {!alert.triggered_at && (
                <button
                  onClick={() => toggleActive(alert)}
                  className="font-mono text-xs uppercase tracking-widest border border-line px-3 py-1.5 hover:border-moss hover:text-moss transition-colors"
                >
                  {alert.is_active ? "Pause" : "Resume"}
                </button>
              )}
              <button
                onClick={() => deleteAlert(alert.id)}
                className="font-mono text-xs text-slate/50 hover:text-rust transition-colors"
              >
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
