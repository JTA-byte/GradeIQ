/**
 * Set detail data layer for app/sets/[set]/page.tsx.
 *
 * Reuses getBuySignals() (lib/buySignals.ts) rather than re-deriving
 * ROI/IQ/gem-rate math from market_sales directly -- same reasoning as
 * lib/setRoiScanner.ts: that logic is already real, tested, and
 * non-trivial, so a second implementation here would just be a second
 * place for it to drift out of sync.
 *
 * "Which grader performs best for this set overall" is derived from
 * which grader each card's signal already picked as its bestGrader
 * (getBuySignals() already runs every grader's numbers per card and
 * keeps the highest-IQ one) -- tallying that, rather than re-running
 * every grader's ROI math again here, gives the same answer with no
 * duplicated computation.
 */
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getBuySignals, type BuySignal, type PriceTrend } from "./buySignals";
import { GRADERS, type GraderId } from "./roiEngine";

function average(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function mostFrequent<T>(values: T[]): T {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

export interface SetGraderProfile {
  grader: GraderId;
  graderName: string;
  cardCount: number; // how many of this set's cards use this grader as their best-recommended grader
  averageIqScore: number;
  averageGemRatePct: number;
  averageExpectedRoiPct: number;
}

export interface SetDetail {
  setName: string;
  language: string; // most common language among this set's signals
  totalCardsInSet: number; // from `cards`, regardless of whether they have sale data yet
  cardsWithSalesData: number;
  averageIqScore: number;
  averageGemRatePct: number;
  averageExpectedRoiPct: number;
  bestCard: { cardId: string; cardName: string; iqScore: number; expectedRoiPct: number } | null;
  graderProfiles: SetGraderProfile[]; // sorted best (by avg IQ score) first
  overallTrend: PriceTrend;
  averageGradedPriceChangePct: number | null;
  signals: BuySignal[]; // this set's filtered Buy Signals, for the page's card grid
}

/**
 * Returns null only when the set name doesn't exist in `cards` at all --
 * a set that exists but has no scraped sale data yet still returns a
 * (mostly zeroed) SetDetail so the page can show a "no data yet" state
 * instead of a hard 404.
 */
export async function getSetDetail(setName: string): Promise<SetDetail | null> {
  const supabase = createServiceRoleClient();

  const [allSignals, countResult] = await Promise.all([
    getBuySignals(),
    supabase.from("cards").select("id", { count: "exact", head: true }).eq("set_name", setName),
  ]);

  const totalCardsInSet = countResult.count ?? 0;
  const signals = allSignals.filter((s) => s.setName === setName);

  if (totalCardsInSet === 0 && signals.length === 0) {
    return null; // no such set
  }

  if (signals.length === 0) {
    return {
      setName,
      language: "English",
      totalCardsInSet,
      cardsWithSalesData: 0,
      averageIqScore: 0,
      averageGemRatePct: 0,
      averageExpectedRoiPct: 0,
      bestCard: null,
      graderProfiles: [],
      overallTrend: "stable",
      averageGradedPriceChangePct: null,
      signals: [],
    };
  }

  const language = mostFrequent(signals.map((s) => s.language));

  const byGrader = new Map<GraderId, BuySignal[]>();
  for (const s of signals) {
    const bucket = byGrader.get(s.bestGrader);
    if (bucket) bucket.push(s);
    else byGrader.set(s.bestGrader, [s]);
  }

  const graderProfiles: SetGraderProfile[] = [...byGrader.entries()]
    .map(([grader, graderSignals]) => {
      const graderConfig = GRADERS.find((g) => g.id === grader)!;
      return {
        grader,
        graderName: `${graderConfig.name} ${graderConfig.tier}`,
        cardCount: graderSignals.length,
        averageIqScore: Math.round(average(graderSignals.map((s) => s.iqScore))),
        averageGemRatePct: Math.round(average(graderSignals.map((s) => s.gemRatePct)) * 10) / 10,
        averageExpectedRoiPct: Math.round(average(graderSignals.map((s) => s.expectedRoiPct)) * 10) / 10,
      };
    })
    .sort((a, b) => b.averageIqScore - a.averageIqScore);

  const best = signals.reduce((a, b) => (b.iqScore > a.iqScore ? b : a));

  const trendChanges = signals.map((s) => s.gradedPriceChangePct).filter((v): v is number => v !== null);
  const averageGradedPriceChangePct = trendChanges.length > 0 ? Math.round(average(trendChanges) * 10) / 10 : null;
  const overallTrend: PriceTrend = mostFrequent(signals.map((s) => s.trend));

  return {
    setName,
    language,
    totalCardsInSet: totalCardsInSet || signals.length,
    cardsWithSalesData: signals.length,
    averageIqScore: Math.round(average(signals.map((s) => s.iqScore))),
    averageGemRatePct: Math.round(average(signals.map((s) => s.gemRatePct)) * 10) / 10,
    averageExpectedRoiPct: Math.round(average(signals.map((s) => s.expectedRoiPct)) * 10) / 10,
    bestCard: {
      cardId: best.cardId,
      cardName: best.cardName,
      iqScore: best.iqScore,
      expectedRoiPct: best.expectedRoiPct,
    },
    graderProfiles,
    overallTrend,
    averageGradedPriceChangePct,
    signals,
  };
}
