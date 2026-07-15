/**
 * GradeIQ ROI Engine
 *
 * Takes card market data, gem rates, and an AI vision assessment,
 * and outputs ranked grader recommendations with expected net ROI.
 *
 * This is the same logic validated in the interactive calculator,
 * promoted to real, typed, testable code.
 */

export type GraderId = "psa" | "cgc" | "bgs" | "tag";

export interface GraderConfig {
  id: GraderId;
  name: string;
  tier: string;
  fee: number; // USD
  turnaroundDays: number;
  sellPlatformFeePct: number; // e.g. 0.13 for 13%
  saleMultiplier: number; // relative price realization vs PSA baseline
}

export const GRADERS: GraderConfig[] = [
  {
    id: "psa",
    name: "PSA",
    tier: "Express",
    fee: 150,
    turnaroundDays: 10,
    sellPlatformFeePct: 0.13,
    saleMultiplier: 1.0,
  },
  {
    id: "cgc",
    name: "CGC",
    tier: "Economy",
    fee: 22,
    turnaroundDays: 45,
    sellPlatformFeePct: 0.13,
    saleMultiplier: 0.88,
  },
  {
    id: "bgs",
    name: "BGS",
    tier: "Standard",
    fee: 75,
    turnaroundDays: 30,
    sellPlatformFeePct: 0.13,
    saleMultiplier: 0.93,
  },
  {
    id: "tag",
    name: "TAG",
    tier: "Standard",
    fee: 30,
    turnaroundDays: 15,
    sellPlatformFeePct: 0.13,
    // TAG is newer with less market liquidity/recognition than the
    // big three -- realized sale prices currently run lower even at
    // the same nominal grade, though this gap tends to narrow as
    // TAG's market presence grows. Revisit this multiplier periodically.
    saleMultiplier: 0.75,
  },
];

export interface CardMarketData {
  rawCost: number; // what you paid / would pay
  rawMarketPrice: number; // current sell price if left raw
  topGradePrice: number; // e.g. PSA 10 price
  midGradePrice: number; // e.g. PSA 9 price
  shippingRoundTrip: number;
}

export interface GemRateData {
  psa: number; // 0-100, % of pop that comes back top grade
  cgc: number;
  bgs: number;
  tag: number;
  totalPopByGrader?: Partial<Record<GraderId, number>>; // for confidence flagging
}

export interface VisionAssessment {
  centeringPct: number; // e.g. 55 means 55/45
  surfaceScore: number; // 1-10
  edgeScore: number; // 1-10
  cornerScore: number; // 1-10
  overallScore: number; // 1-10 blended
}

export interface GraderRecommendation {
  grader: GraderId;
  graderName: string;
  tier: string;
  passesGateCheck: boolean;
  gemRate: number;
  gemRateConfidence: "low" | "medium" | "high";
  topGradeProbability: number;
  expectedSalePrice: number;
  fee: number;
  shippingCost: number;
  platformFee: number;
  netROI: number;
  turnaroundDays: number;
}

export interface FullRecommendation {
  recommendations: GraderRecommendation[]; // sorted best to worst
  bestOption: GraderRecommendation | null;
  rawSaleProfit: number;
  verdict: "grade" | "conditional" | "sell_raw" | "no_grade";
  verdictReason: string;
  arbitrageFlag: string | null;
}

const MIN_POP_FOR_CONFIDENCE = 50;
const MIN_POP_FOR_MEDIUM_CONFIDENCE = 15;

function gemRateConfidence(totalPop: number | undefined): "low" | "medium" | "high" {
  if (totalPop === undefined) return "low";
  if (totalPop >= MIN_POP_FOR_CONFIDENCE) return "high";
  if (totalPop >= MIN_POP_FOR_MEDIUM_CONFIDENCE) return "medium";
  return "low";
}

/**
 * The vision gate: minimum vision score required to be a credible
 * top-grade candidate, scaled by how hard the card is to gem.
 * Higher gem rate = lower bar (the card type forgives more).
 * Lower gem rate = higher bar (only a near-perfect copy has a shot).
 */
function visionGateThreshold(gemRate: number): number {
  if (gemRate >= 25) return 7.5;
  if (gemRate >= 10) return 8.5;
  return 9.5;
}

/**
 * Blends the population-level gem rate (the "wisdom of the grading crowd")
 * with this specific card's vision score into a single probability
 * of hitting the top grade. Gem rate is weighted more heavily because
 * it reflects thousands of real submissions; vision score is one
 * AI's read of one set of photos.
 */
function blendedTopGradeProbability(gemRate: number, visionScore: number): number {
  const GEM_WEIGHT = 0.6;
  const VISION_WEIGHT = 0.4;
  const visionProbComponent = Math.min(1, Math.max(0, (visionScore - 6) / 4));
  const blended = (gemRate / 100) * GEM_WEIGHT + visionProbComponent * VISION_WEIGHT;
  return Math.min(1, Math.max(0, blended));
}

function calculateGraderRecommendation(
  grader: GraderConfig,
  market: CardMarketData,
  gemRate: number,
  totalPop: number | undefined,
  vision: VisionAssessment
): GraderRecommendation {
  const topProb = blendedTopGradeProbability(gemRate, vision.overallScore);
  const midProb = Math.min(1 - topProb, 0.45);
  const lowProb = Math.max(0, 1 - topProb - midProb);

  const adjustedTopPrice = market.topGradePrice * grader.saleMultiplier;
  const adjustedMidPrice = market.midGradePrice * grader.saleMultiplier;
  const adjustedLowPrice = market.rawMarketPrice * 0.85; // assume a below-grade copy sells near raw, slight discount

  const expectedSalePrice =
    topProb * adjustedTopPrice + midProb * adjustedMidPrice + lowProb * adjustedLowPrice;

  const platformFee = expectedSalePrice * grader.sellPlatformFeePct;
  const netROI =
    expectedSalePrice - market.rawCost - grader.fee - market.shippingRoundTrip - platformFee;

  const gateThreshold = visionGateThreshold(gemRate);
  const passesGateCheck = vision.overallScore >= gateThreshold;

  return {
    grader: grader.id,
    graderName: `${grader.name} ${grader.tier}`,
    tier: grader.tier,
    passesGateCheck,
    gemRate,
    gemRateConfidence: gemRateConfidence(totalPop),
    topGradeProbability: Math.round(topProb * 1000) / 1000,
    expectedSalePrice: Math.round(expectedSalePrice * 100) / 100,
    fee: grader.fee,
    shippingCost: market.shippingRoundTrip,
    platformFee: Math.round(platformFee * 100) / 100,
    netROI: Math.round(netROI * 100) / 100,
    turnaroundDays: grader.turnaroundDays,
  };
}

/**
 * Detects when one grader's gem rate is meaningfully higher than another's
 * on the same card -- a potential arbitrage opportunity worth flagging.
 */
function detectArbitrage(gemRates: GemRateData): string | null {
  const entries: [GraderId, number][] = [
    ["psa", gemRates.psa],
    ["cgc", gemRates.cgc],
    ["bgs", gemRates.bgs],
    ["tag", gemRates.tag],
  ];
  entries.sort((a, b) => b[1] - a[1]);
  const [topGrader, topRate] = entries[0];
  const [, secondRate] = entries[1];

  if (topRate >= secondRate * 1.5 && topRate - secondRate >= 8) {
    const graderName = GRADERS.find((g) => g.id === topGrader)?.name ?? topGrader;
    return `${graderName} gem rate (${topRate.toFixed(
      0
    )}%) is significantly higher than other graders on this card. Worth investigating whether this reflects looser standards, a smaller/newer population, or genuine card-specific fit.`;
  }
  return null;
}

export function getGraderRecommendations(
  market: CardMarketData,
  gemRates: GemRateData,
  vision: VisionAssessment
): FullRecommendation {
  const recommendations = GRADERS.map((grader) => {
    const gemRate = gemRates[grader.id];
    const totalPop = gemRates.totalPopByGrader?.[grader.id];
    return calculateGraderRecommendation(grader, market, gemRate, totalPop, vision);
  });

  recommendations.sort((a, b) => b.netROI - a.netROI);

  const rawSaleProfit = Math.round((market.rawMarketPrice - market.rawCost) * 100) / 100;
  const passingOptions = recommendations.filter((r) => r.passesGateCheck);
  const bestOption = passingOptions.length > 0 ? passingOptions[0] : null;

  const maxGemRate = Math.max(gemRates.psa, gemRates.cgc, gemRates.bgs, gemRates.tag);

  let verdict: FullRecommendation["verdict"];
  let verdictReason: string;

  if (maxGemRate < 10 && !bestOption) {
    verdict = "no_grade";
    verdictReason =
      "Gem rate is below 10% across all graders. This card type historically does not gem well regardless of condition -- likely a factory print consistency issue specific to this card or set.";
  } else if (!bestOption) {
    verdict = "sell_raw";
    verdictReason = `Vision score of ${vision.overallScore} doesn't clear the confidence threshold for any grader at this gem rate level. Expected grading return is likely below raw sale profit of $${rawSaleProfit}.`;
  } else if (maxGemRate >= 25) {
    verdict = "grade";
    verdictReason = `Gem rate above 25% and vision score of ${vision.overallScore} clears the threshold. ${bestOption.graderName} offers the best expected net ROI.`;
  } else {
    verdict = "conditional";
    verdictReason = `Moderate gem rate (${maxGemRate.toFixed(
      0
    )}%) -- this copy clears the vision threshold, but returns carry more variance than a high-gem-rate card. Proceed with awareness of the wider probability spread.`;
  }

  return {
    recommendations,
    bestOption,
    rawSaleProfit,
    verdict,
    verdictReason,
    arbitrageFlag: detectArbitrage(gemRates),
  };
}
