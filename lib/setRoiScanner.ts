/**
 * Set ROI Scanner: ranks every Pokémon set by average grading ROI
 * across its gradeable cards.
 *
 * Reuses getBuySignals()'s per-card computation (lib/buySignals.ts)
 * rather than re-deriving IQ score/ROI/gem rate from market_sales
 * directly -- that logic is already real, tested, and non-trivial
 * (grade probability blending, netROI, IQ scoring), and duplicating it
 * here would just be two places that could drift out of sync. This
 * file's only job is grouping those already-computed per-card signals
 * by (set name, language) and averaging.
 *
 * A set name is grouped per-language rather than once overall: the same
 * set name can exist in multiple languages (e.g. a Japanese "Evolving
 * Skies" printing) with a genuinely different card pool and ROI
 * profile, so collapsing them into one row would blend two different
 * markets together.
 */
import { getBuySignals, type BuySignal } from "./buySignals";

export interface SetRoiSummary {
  setName: string;
  language: string;
  cardCount: number;
  averageIqScore: number;
  averageGemRatePct: number;
  averageExpectedRoiPct: number;
  bestCard: {
    cardId: string;
    cardName: string;
    iqScore: number;
  };
}

function average(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function groupBy<T, K>(items: T[], keyFn: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const bucket = map.get(key);
    if (bucket) bucket.push(item);
    else map.set(key, [item]);
  }
  return map;
}

/**
 * Computes per-set ROI summaries from the same buy-signal data the Buy
 * Signals page uses. Cached for an hour by app/sets/page.tsx's
 * `revalidate` export, same as Buy Signals -- this does a full pass
 * over every card's signal, and the underlying data only changes
 * nightly anyway.
 */
export async function getSetRoiSummaries(): Promise<SetRoiSummary[]> {
  const signals = await getBuySignals();
  const bySet = groupBy(signals, (s: BuySignal) => `${s.setName}::${s.language}`);

  const summaries: SetRoiSummary[] = [];
  for (const [key, group] of bySet.entries()) {
    const [setName, language] = key.split("::");
    const best = group.reduce((a, b) => (b.iqScore > a.iqScore ? b : a));

    summaries.push({
      setName,
      language,
      cardCount: group.length,
      averageIqScore: Math.round(average(group.map((s) => s.iqScore))),
      averageGemRatePct: Math.round(average(group.map((s) => s.gemRatePct)) * 10) / 10,
      averageExpectedRoiPct: Math.round(average(group.map((s) => s.expectedRoiPct)) * 10) / 10,
      bestCard: {
        cardId: best.cardId,
        cardName: best.cardName,
        iqScore: best.iqScore,
      },
    });
  }

  summaries.sort((a, b) => b.averageIqScore - a.averageIqScore);
  return summaries;
}
