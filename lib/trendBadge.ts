/**
 * Shared trend badge styling, used by both components/BuySignalsTable.tsx
 * (a "use client" module) and app/sets/[set]/page.tsx (a Server
 * Component). Deliberately NOT defined inside BuySignalsTable.tsx --
 * confirmed live that a Server Component can't index into a plain object
 * exported from a "use client" file ("Cannot access X on the server. You
 * cannot dot into a client module from a server component."), so this
 * lookup table needs to live in a plain module both sides can import.
 */
import type { PriceTrend } from "./buySignals";

export const TREND_BADGE: Record<PriceTrend, { label: string; className: string }> = {
  trending_up: { label: "🔥 Trending Up", className: "bg-gold/20 text-ink border border-gold" },
  cooling: { label: "❄️ Cooling", className: "bg-slate/10 text-slate border border-slate/40" },
  stable: { label: "→ Stable", className: "text-slate/60" },
};
