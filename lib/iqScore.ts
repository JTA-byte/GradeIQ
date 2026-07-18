/**
 * GradeIQ IQ Score
 *
 * A single 0-100 signal blending four inputs into "how good an
 * opportunity is this card right now to buy raw and grade":
 *   - Gem rate (30%) -- higher is better
 *   - Expected net ROI% (30%) -- higher is better
 *   - Market momentum from recent graded sales (20%) -- rising price is better
 *   - Pop growth rate (20%) -- SLOWER growth is better (inverted before
 *     weighting, since a population flooding with new copies is getting
 *     less scarce, not more attractive)
 *
 * Pure function, same architectural pattern as roiEngine.ts: it takes
 * already-computed inputs (gem rate, ROI%, sale/pop history) rather than
 * querying Supabase itself, so it stays simple to test and reusable from
 * both the per-scan flow and the bulk buy-signals page.
 */

export interface SalePoint {
  price: number;
  date: Date | string;
}

export interface PopPoint {
  totalPop: number;
  date: Date | string;
}

export interface IQScoreInput {
  gemRatePct: number; // 0-100
  expectedNetRoiPct: number; // e.g. 45 means +45%; can be negative
  recentSales: SalePoint[]; // graded sale price history for this card (one consistent grade/grader)
  popHistory: PopPoint[]; // total_pop snapshots over time for the relevant grader
}

export type IQScoreLabel = "Excellent" | "Strong" | "Moderate" | "Weak";

export interface IQScoreResult {
  score: number; // 0-100
  label: IQScoreLabel;
  reason: string;
  breakdown: {
    gemRateSubScore: number;
    roiSubScore: number;
    momentumSubScore: number;
    popGrowthSubScore: number;
    momentumPct: number | null; // null when there's not enough sale history to compute
    popGrowthPct: number | null; // null when there's not enough pop history to compute
  };
}

const WEIGHTS = {
  gemRate: 0.3,
  roi: 0.3,
  momentum: 0.2,
  popGrowth: 0.2,
};

// Used for momentum/pop growth when there isn't enough history to compute
// a real trend -- neutral so missing data neither helps nor hurts the score.
const NEUTRAL_SUB_SCORE = 50;

const DAY_MS = 24 * 60 * 60 * 1000;
const MOMENTUM_RECENT_WINDOW_DAYS = 45;
const MOMENTUM_COMPARISON_WINDOW_DAYS = 90;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toDate(d: Date | string): Date {
  return d instanceof Date ? d : new Date(d);
}

/**
 * Gem rate is a 0-100 percentage, but realistically almost never gets
 * anywhere near 100 -- even an excellent-gemming modern card tops out
 * around 30-35% in this app's own reference data (see
 * lib/mockDataService.ts), and vintage cards are often single digits.
 * A raw 1:1 mapping would mean this component could never use its full
 * 30% weight in practice, so it's rescaled against a realistic ceiling
 * instead: 40%+ gem rate -> full sub-score.
 */
function gemRateSubScore(gemRatePct: number): number {
  const GEM_RATE_CEILING = 40;
  return clamp((gemRatePct / GEM_RATE_CEILING) * 100, 0, 100);
}

/**
 * Maps expected net ROI% onto a 0-100 sub-score: -20% or worse -> 0,
 * +100% or better -> 100, linear in between. Breakeven (0% ROI) lands
 * around 17 -- merely not losing money isn't a good opportunity either.
 */
function roiSubScore(expectedNetRoiPct: number): number {
  const ROI_FLOOR = -20;
  const ROI_CEILING = 100;
  return clamp(((expectedNetRoiPct - ROI_FLOOR) / (ROI_CEILING - ROI_FLOOR)) * 100, 0, 100);
}

/**
 * Momentum: average sale price in the most recent 45 days vs. the prior
 * 45 days (46-90 days ago). Needs at least one sale in each window to
 * call a trend -- returns null (not zero) otherwise, so a card with thin
 * sale history doesn't get penalized for a trend that can't be measured.
 */
function momentumScore(recentSales: SalePoint[]): { pct: number | null; subScore: number } {
  const now = Date.now();

  const recentWindow = recentSales.filter(
    (s) => now - toDate(s.date).getTime() <= MOMENTUM_RECENT_WINDOW_DAYS * DAY_MS
  );
  const olderWindow = recentSales.filter((s) => {
    const age = now - toDate(s.date).getTime();
    return age > MOMENTUM_RECENT_WINDOW_DAYS * DAY_MS && age <= MOMENTUM_COMPARISON_WINDOW_DAYS * DAY_MS;
  });

  if (recentWindow.length === 0 || olderWindow.length === 0) {
    return { pct: null, subScore: NEUTRAL_SUB_SCORE };
  }

  const avg = (points: SalePoint[]) => points.reduce((sum, p) => sum + p.price, 0) / points.length;
  const recentAvg = avg(recentWindow);
  const olderAvg = avg(olderWindow);

  if (olderAvg <= 0) {
    return { pct: null, subScore: NEUTRAL_SUB_SCORE };
  }

  const pct = ((recentAvg - olderAvg) / olderAvg) * 100;
  const MOMENTUM_FLOOR = -30;
  const MOMENTUM_CEILING = 30;
  const subScore = clamp(((pct - MOMENTUM_FLOOR) / (MOMENTUM_CEILING - MOMENTUM_FLOOR)) * 100, 0, 100);
  return { pct, subScore };
}

/**
 * Pop growth: earliest vs. latest total_pop snapshot in popHistory.
 * Inverted before weighting -- 0% growth or better -> 100, +40% growth
 * or more -> 0 -- since a slowly-growing population stays scarce, while
 * a rapidly-growing one is getting less scarce by the day. Needs at
 * least 2 snapshots; returns null otherwise.
 */
function popGrowthScore(popHistory: PopPoint[]): { pct: number | null; subScore: number } {
  if (popHistory.length < 2) {
    return { pct: null, subScore: NEUTRAL_SUB_SCORE };
  }

  const sorted = [...popHistory].sort((a, b) => toDate(a.date).getTime() - toDate(b.date).getTime());
  const earliest = sorted[0];
  const latest = sorted[sorted.length - 1];

  if (earliest.totalPop <= 0) {
    return { pct: null, subScore: NEUTRAL_SUB_SCORE };
  }

  const pct = ((latest.totalPop - earliest.totalPop) / earliest.totalPop) * 100;
  const GROWTH_FLOOR = 0; // 0% growth -> best score
  const GROWTH_CEILING = 40; // 40%+ growth -> worst score
  const inverted = clamp(((GROWTH_CEILING - pct) / (GROWTH_CEILING - GROWTH_FLOOR)) * 100, 0, 100);
  return { pct, subScore: inverted };
}

function labelFor(score: number): IQScoreLabel {
  if (score >= 80) return "Excellent";
  if (score >= 60) return "Strong";
  if (score >= 40) return "Moderate";
  return "Weak";
}

function buildReason(
  gemRatePct: number,
  expectedNetRoiPct: number,
  momentumPct: number | null,
  popGrowthPct: number | null,
  subScores: { gemRate: number; roi: number; momentum: number; popGrowth: number }
): string {
  // Rank by weighted contribution (sub-score * weight), not raw sub-score,
  // so a component that's merely defaulting to neutral (no data) never
  // gets singled out as "the reason" for a good or bad score.
  const contributions = [
    {
      value: subScores.gemRate * WEIGHTS.gemRate,
      detail: `${gemRatePct.toFixed(0)}% gem rate`,
    },
    {
      value: subScores.roi * WEIGHTS.roi,
      detail: `${expectedNetRoiPct >= 0 ? "+" : ""}${expectedNetRoiPct.toFixed(0)}% expected net ROI`,
    },
    ...(momentumPct !== null
      ? [
          {
            value: subScores.momentum * WEIGHTS.momentum,
            detail: `sale prices ${momentumPct >= 0 ? "up" : "down"} ${Math.abs(momentumPct).toFixed(0)}% recently`,
          },
        ]
      : []),
    ...(popGrowthPct !== null
      ? [
          {
            value: subScores.popGrowth * WEIGHTS.popGrowth,
            detail: `population growing ${popGrowthPct.toFixed(0)}%`,
          },
        ]
      : []),
  ];

  const strongest = contributions.reduce((a, b) => (b.value > a.value ? b : a));
  const weakest = contributions.reduce((a, b) => (b.value < a.value ? b : a));

  if (strongest.detail === weakest.detail) {
    return `Driven by ${strongest.detail}.`;
  }

  return `Driven by ${strongest.detail}, held back by ${weakest.detail}.`;
}

export function calculateIQScore(input: IQScoreInput): IQScoreResult {
  const gemSub = gemRateSubScore(input.gemRatePct);
  const roiSub = roiSubScore(input.expectedNetRoiPct);
  const momentum = momentumScore(input.recentSales);
  const popGrowth = popGrowthScore(input.popHistory);

  const rawScore =
    gemSub * WEIGHTS.gemRate +
    roiSub * WEIGHTS.roi +
    momentum.subScore * WEIGHTS.momentum +
    popGrowth.subScore * WEIGHTS.popGrowth;

  const score = clamp(Math.round(rawScore), 0, 100);

  return {
    score,
    label: labelFor(score),
    reason: buildReason(input.gemRatePct, input.expectedNetRoiPct, momentum.pct, popGrowth.pct, {
      gemRate: gemSub,
      roi: roiSub,
      momentum: momentum.subScore,
      popGrowth: popGrowth.subScore,
    }),
    breakdown: {
      gemRateSubScore: gemSub,
      roiSubScore: roiSub,
      momentumSubScore: momentum.subScore,
      popGrowthSubScore: popGrowth.subScore,
      momentumPct: momentum.pct,
      popGrowthPct: popGrowth.pct,
    },
  };
}
