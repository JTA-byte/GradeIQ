"use client";

import { useState } from "react";
import { GRADERS, GraderId } from "@/lib/roiEngine";

export interface PortfolioItem {
  id: string;
  card_name: string;
  raw_purchase_price: number;
  date_bought: string;
  status: "raw" | "submitted" | "graded" | "sold";
  grader: string | null;
  submission_date: string | null;
  grade_received: string | null;
  sale_price: number | null;
  created_at: string;
}

const STATUS_STYLE: Record<PortfolioItem["status"], string> = {
  raw: "bg-slate/10 text-slate border border-slate/40",
  submitted: "bg-gold/10 text-ink border border-gold",
  graded: "bg-moss/10 text-moss border border-moss",
  sold: "bg-ink text-paper",
};

function graderConfig(grader: string | null) {
  if (!grader) return null;
  return GRADERS.find((g) => g.id === (grader.toLowerCase() as GraderId)) ?? null;
}

function calculatePnL(item: PortfolioItem): number | null {
  if (item.status !== "sold" || item.sale_price === null) return null;
  const config = graderConfig(item.grader);
  const gradingFee = config?.fee ?? 0;
  const platformFee = item.sale_price * (config?.sellPlatformFeePct ?? 0.13);
  return item.sale_price - item.raw_purchase_price - gradingFee - platformFee;
}

function estimatedReturnDate(item: PortfolioItem): Date | null {
  if (item.status !== "submitted" || !item.submission_date) return null;
  const config = graderConfig(item.grader);
  if (!config) return null;
  const date = new Date(item.submission_date);
  date.setDate(date.getDate() + config.turnaroundDays);
  return date;
}

function formatDate(d: string | Date): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function PortfolioManager({ initialItems }: { initialItems: PortfolioItem[] }) {
  const [items, setItems] = useState<PortfolioItem[]>(initialItems);
  const [showAddForm, setShowAddForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Add-item form state
  const [newCardName, setNewCardName] = useState("");
  const [newPrice, setNewPrice] = useState("");
  const [newDate, setNewDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [adding, setAdding] = useState(false);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const price = Number(newPrice);
    if (!newCardName.trim() || !newPrice || Number.isNaN(price) || price <= 0) {
      setError("Enter a card name and a valid purchase price.");
      return;
    }

    setAdding(true);
    try {
      const res = await fetch("/api/portfolio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardName: newCardName, rawPurchasePrice: price, dateBought: newDate }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to add card");

      setItems((prev) => [data.item, ...prev]);
      setNewCardName("");
      setNewPrice("");
      setShowAddForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setAdding(false);
    }
  }

  async function updateItem(id: string, update: Record<string, unknown>) {
    setError(null);
    try {
      const res = await fetch(`/api/portfolio/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to update card");
      setItems((prev) => prev.map((item) => (item.id === id ? data.item : item)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  async function deleteItem(id: string) {
    setError(null);
    try {
      const res = await fetch(`/api/portfolio/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to remove card");
      }
      setItems((prev) => prev.filter((item) => item.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  const realizedPnL = items.reduce((sum, item) => sum + (calculatePnL(item) ?? 0), 0);
  const soldCount = items.filter((i) => i.status === "sold").length;

  return (
    <div>
      {/* Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
        <div className="border border-line bg-white/40 p-4">
          <div className="font-mono text-[10px] uppercase tracking-widest text-slate/70 mb-1">
            Total P&amp;L (realized)
          </div>
          <div className={`font-display text-2xl ${realizedPnL >= 0 ? "text-moss" : "text-rust"}`}>
            {realizedPnL >= 0 ? "+" : ""}${Math.round(realizedPnL).toLocaleString()}
          </div>
        </div>
        <div className="border border-line bg-white/40 p-4">
          <div className="font-mono text-[10px] uppercase tracking-widest text-slate/70 mb-1">
            Cards tracked
          </div>
          <div className="font-display text-2xl">{items.length}</div>
        </div>
        <div className="border border-line bg-white/40 p-4">
          <div className="font-mono text-[10px] uppercase tracking-widest text-slate/70 mb-1">
            At grader
          </div>
          <div className="font-display text-2xl">
            {items.filter((i) => i.status === "submitted").length}
          </div>
        </div>
        <div className="border border-line bg-white/40 p-4">
          <div className="font-mono text-[10px] uppercase tracking-widest text-slate/70 mb-1">Sold</div>
          <div className="font-display text-2xl">{soldCount}</div>
        </div>
      </div>

      <div className="flex items-center justify-between mb-4">
        <h2 className="font-display text-xl">Your cards</h2>
        <button
          onClick={() => setShowAddForm((v) => !v)}
          className="font-mono text-xs uppercase tracking-widest bg-ink text-paper px-4 py-2 hover:bg-moss transition-colors"
        >
          {showAddForm ? "Cancel" : "+ Add card"}
        </button>
      </div>

      {showAddForm && (
        <form onSubmit={handleAdd} className="border border-line bg-white/40 p-4 mb-6 grid grid-cols-1 sm:grid-cols-4 gap-3">
          <input
            type="text"
            placeholder="Card name"
            value={newCardName}
            onChange={(e) => setNewCardName(e.target.value)}
            className="border border-line bg-white/60 px-3 py-2 font-mono text-sm focus:outline-none focus:border-moss sm:col-span-2"
          />
          <input
            type="number"
            step="0.01"
            placeholder="Raw purchase price"
            value={newPrice}
            onChange={(e) => setNewPrice(e.target.value)}
            className="border border-line bg-white/60 px-3 py-2 font-mono text-sm focus:outline-none focus:border-moss"
          />
          <input
            type="date"
            value={newDate}
            onChange={(e) => setNewDate(e.target.value)}
            className="border border-line bg-white/60 px-3 py-2 font-mono text-sm focus:outline-none focus:border-moss"
          />
          <button
            type="submit"
            disabled={adding}
            className="sm:col-span-4 bg-ink text-paper font-mono text-sm uppercase tracking-widest py-2.5 hover:bg-moss transition-colors disabled:opacity-40"
          >
            {adding ? "Adding..." : "Add to portfolio"}
          </button>
        </form>
      )}

      {error && (
        <div className="mb-4 px-4 py-3 font-mono text-sm border border-rust bg-rust/10 text-rust">
          {error}
        </div>
      )}

      <div className="space-y-3">
        {items.length === 0 && !showAddForm && (
          <div className="border border-line p-8 text-center">
            <p className="font-mono text-sm text-slate">
              No cards yet. Add your first card to start tracking P&amp;L.
            </p>
          </div>
        )}

        {items.map((item) => (
          <PortfolioItemRow
            key={item.id}
            item={item}
            onUpdate={(update) => updateItem(item.id, update)}
            onDelete={() => deleteItem(item.id)}
          />
        ))}
      </div>
    </div>
  );
}

function PortfolioItemRow({
  item,
  onUpdate,
  onDelete,
}: {
  item: PortfolioItem;
  onUpdate: (update: Record<string, unknown>) => void;
  onDelete: () => void;
}) {
  const [showTransitionForm, setShowTransitionForm] = useState(false);
  const [grader, setGrader] = useState<string>("PSA");
  const [submissionDate, setSubmissionDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [gradeReceived, setGradeReceived] = useState("");
  const [salePrice, setSalePrice] = useState("");

  const pnl = calculatePnL(item);
  const returnDate = estimatedReturnDate(item);
  const isOverdue = returnDate !== null && returnDate.getTime() < Date.now();

  function submitTransition() {
    if (item.status === "raw") {
      onUpdate({ status: "submitted", grader, submissionDate });
    } else if (item.status === "submitted") {
      if (!gradeReceived.trim()) return;
      onUpdate({ status: "graded", gradeReceived });
    } else if (item.status === "graded") {
      const price = Number(salePrice);
      if (!salePrice || Number.isNaN(price) || price <= 0) return;
      onUpdate({ status: "sold", salePrice: price });
    }
    setShowTransitionForm(false);
  }

  return (
    <div className="border border-line bg-white/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className={`font-mono text-[10px] uppercase tracking-widest px-2 py-0.5 ${STATUS_STYLE[item.status]}`}>
              {item.status}
            </span>
            <h3 className="font-display text-lg">{item.card_name}</h3>
          </div>
          <p className="font-mono text-xs text-slate/70">
            Bought ${item.raw_purchase_price.toLocaleString()} on {formatDate(item.date_bought)}
            {item.grader && ` -- ${item.grader}`}
            {item.submission_date && `, submitted ${formatDate(item.submission_date)}`}
            {item.grade_received && `, graded ${item.grade_received}`}
          </p>
          {returnDate && (
            <p className={`font-mono text-xs mt-1 ${isOverdue ? "text-rust" : "text-slate/60"}`}>
              Estimated return: {formatDate(returnDate)}
              {isOverdue && " (overdue)"}
            </p>
          )}
        </div>

        <div className="flex items-center gap-3">
          {pnl !== null && (
            <span className={`font-display text-xl ${pnl >= 0 ? "text-moss" : "text-rust"}`}>
              {pnl >= 0 ? "+" : ""}${Math.round(pnl).toLocaleString()}
            </span>
          )}
          {item.status !== "sold" && (
            <button
              onClick={() => setShowTransitionForm((v) => !v)}
              className="font-mono text-xs uppercase tracking-widest border border-line px-3 py-1.5 hover:border-moss hover:text-moss transition-colors"
            >
              {item.status === "raw" && "Mark submitted"}
              {item.status === "submitted" && "Mark graded"}
              {item.status === "graded" && "Mark sold"}
            </button>
          )}
          <button
            onClick={onDelete}
            className="font-mono text-xs text-slate/50 hover:text-rust transition-colors"
          >
            Remove
          </button>
        </div>
      </div>

      {showTransitionForm && (
        <div className="mt-4 pt-4 border-t border-line flex flex-wrap items-end gap-3">
          {item.status === "raw" && (
            <>
              <div>
                <label className="block font-mono text-[10px] uppercase tracking-widest text-slate/70 mb-1">
                  Grader
                </label>
                <select
                  value={grader}
                  onChange={(e) => setGrader(e.target.value)}
                  className="border border-line bg-white/60 px-2 py-1.5 font-mono text-sm focus:outline-none focus:border-moss"
                >
                  {GRADERS.map((g) => (
                    <option key={g.id} value={g.id.toUpperCase()}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block font-mono text-[10px] uppercase tracking-widest text-slate/70 mb-1">
                  Submission date
                </label>
                <input
                  type="date"
                  value={submissionDate}
                  onChange={(e) => setSubmissionDate(e.target.value)}
                  className="border border-line bg-white/60 px-2 py-1.5 font-mono text-sm focus:outline-none focus:border-moss"
                />
              </div>
            </>
          )}
          {item.status === "submitted" && (
            <div>
              <label className="block font-mono text-[10px] uppercase tracking-widest text-slate/70 mb-1">
                Grade received
              </label>
              <input
                type="text"
                placeholder="e.g. PSA 10"
                value={gradeReceived}
                onChange={(e) => setGradeReceived(e.target.value)}
                className="border border-line bg-white/60 px-2 py-1.5 font-mono text-sm focus:outline-none focus:border-moss"
              />
            </div>
          )}
          {item.status === "graded" && (
            <div>
              <label className="block font-mono text-[10px] uppercase tracking-widest text-slate/70 mb-1">
                Sale price
              </label>
              <input
                type="number"
                step="0.01"
                value={salePrice}
                onChange={(e) => setSalePrice(e.target.value)}
                className="border border-line bg-white/60 px-2 py-1.5 font-mono text-sm focus:outline-none focus:border-moss"
              />
            </div>
          )}
          <button
            onClick={submitTransition}
            className="bg-ink text-paper font-mono text-xs uppercase tracking-widest px-4 py-2 hover:bg-moss transition-colors"
          >
            Save
          </button>
        </div>
      )}
    </div>
  );
}
