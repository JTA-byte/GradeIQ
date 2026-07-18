/**
 * Buy Signals data layer: scans every card with real scraped sale data
 * and ranks the best current grading opportunities.
 *
 * Reality check done before writing this (query the live DB, don't
 * assume): `gem_rates` is currently EMPTY -- the PSA/CGC/BGS/TAG pop
 * scrapers (python-services/scrapers/{psa,cgc,bgs,tag}_scraper.py) were
 * never fixed with real selectors the way alt_scraper.py was, so no pop
 * report has ever actually been written. `market_sales` has real data
 * (12,889 rows across 967 distinct cards at last check), all from
 * Alt.xyz (source 'alt' or 'ebay_sold' comps it aggregates) -- TAG isn't
 * tracked by Alt at all, and SGC sales exist but aren't one of GradeIQ's
 * 4 supported graders, so both are skipped here.
 *
 * Practical effect: gemRatePct is 0 for every card today (there's
 * nothing real to report), and pop growth has no history to compute
 * from either -- both default to iqScore.ts's built-in neutral handling.
 * IQ scores right now are effectively driven by ROI% and price momentum
 * (60% of the weight) until the pop scrapers get fixed. This is honest,
 * not a bug -- scores will improve in signal quality as real pop data
 * starts flowing in, same as the rest of this app's mock-to-real story.
 *
 * Raw/ungraded price is also not scraped anywhere yet (Alt only records
 * graded sales; point130/pricecharting are disabled in the nightly job).
 * Rather than call the real TCGPlayer client once per candidate card
 * (967+ external API calls per page load isn't practical, unlike the
 * single-card analyze flow in lib/mockDataService.ts, which still does
 * exactly that), this estimates raw price as a fraction of top-grade
 * price -- a clearly-labeled placeholder, not scraped data.
 */
import { createServiceRoleClient } from "@/lib/supabase/server";
import {
  CardMarketData,
  GemRateData,
  GraderId,
  GRADERS,
  calculateMaxBuyPrice,
  deriveGradeProbabilities,
  getGraderRecommendations,
} from "./roiEngine";
import { calculateIQScore, IQScoreLabel, PopPoint, SalePoint } from "./iqScore";

const PAGE_SIZE = 1000; // PostgREST's default per-request row cap

// A card without a scan yet has no vision assessment -- this neutral
// midpoint (matches deriveGradeProbabilities' own default) avoids
// pretending we know anything about a specific physical copy's condition.
const UNSCANNED_VISION_SCORE = 7.5;

// Grade labels that count as "top tier" / "mid tier" per grader. PRI
// (CGC Pristine) and BL (BGS Black Label) are each grader's actual top
// tier, not a numeric "10" -- see alt_scraper.py's GRADE_PATTERN.
const TOP_GRADE_LABELS = new Set(["10", "PRI", "BL"]);
const MID_GRADE_LABELS = new Set(["9.5", "9"]);

// No real raw-price source is scraped yet (see file header) -- these
// ratios are a placeholder estimate, not observed data.
const ESTIMATED_RAW_TO_TOP_GRADE_RATIO = 0.15;
const ESTIMATED_MID_TO_TOP_GRADE_RATIO_FALLBACK = 0.4;

const DEFAULT_SHIPPING_ROUND_TRIP = 20;

export interface BuySignal {
  cardId: string;
  cardName: string;
  setName: string;
  bestGrader: GraderId;
  bestGraderName: string;
  iqScore: number;
  iqLabel: IQScoreLabel;
  iqReason: string;
  expectedRoiPct: number;
  maxBuyPrice: number;
  gemRatePct: number; // 0 today -- see file header
  topGradePrice: number;
  saleCount: number; // how many real top-grade sales this estimate rests on
}

interface MarketSaleRow {
  card_id: string;
  grader: string | null;
  grade: string;
  sale_price: number;
  sale_date: string;
}

interface CardRow {
  id: string;
  name: string;
  set_name: string;
}

interface GemRateRow {
  card_id: string;
  grader: string;
  total_pop: number;
  gem_rate: number;
  scraped_at: string;
}

async function fetchAllRows<T>(
  supabase: ReturnType<typeof createServiceRoleClient>,
  table: string,
  columns: string
): Promise<T[]> {
  const all: T[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) throw new Error(`Failed to fetch ${table}: ${error.message}`);
    if (!data || data.length === 0) break;

    all.push(...(data as T[]));
    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return all;
}

function average(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function groupBy<T, K>(items: T[], keyFn: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const bucket = map.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      map.set(key, [item]);
    }
  }
  return map;
}

/**
 * For one card's sales from one grader, estimates market data + gem rate
 * + IQ score for that grader, or returns null if there isn't enough data
 * (needs at least one top-grade sale to anchor an estimate on).
 */
function evaluateCardForGrader(
  graderCode: string,
  graderSales: MarketSaleRow[],
  gemRateRow: GemRateRow | undefined,
  popHistory: PopPoint[]
): {
  grader: GraderId;
  roiPct: number;
  maxBuyPrice: number;
  iqScore: number;
  iqLabel: IQScoreLabel;
  iqReason: string;
  topGradePrice: number;
  saleCount: number;
} | null {
  const graderConfig = GRADERS.find((g) => g.id === graderCode.toLowerCase());
  if (!graderConfig) return null; // not one of GradeIQ's 4 supported graders (e.g. SGC)

  const topSales = graderSales.filter((s) => TOP_GRADE_LABELS.has(s.grade));
  if (topSales.length === 0) return null; // nothing to anchor an estimate on

  const midSales = graderSales.filter((s) => MID_GRADE_LABELS.has(s.grade));

  const topGradePrice = average(topSales.map((s) => s.sale_price));
  const midGradePrice =
    midSales.length > 0 ? average(midSales.map((s) => s.sale_price)) : topGradePrice * ESTIMATED_MID_TO_TOP_GRADE_RATIO_FALLBACK;
  const rawMarketPrice = topGradePrice * ESTIMATED_RAW_TO_TOP_GRADE_RATIO;
  const rawCost = rawMarketPrice * 0.85;

  const gemRatePct = gemRateRow?.gem_rate ?? 0;

  const market: CardMarketData = {
    rawCost,
    rawMarketPrice,
    topGradePrice,
    midGradePrice,
    shippingRoundTrip: DEFAULT_SHIPPING_ROUND_TRIP,
  };

  const gemRates: GemRateData = {
    psa: 0,
    cgc: 0,
    bgs: 0,
    tag: 0,
    [graderConfig.id]: gemRatePct,
  } as GemRateData;

  const recommendation = getGraderRecommendations(market, gemRates, {
    centeringPct: 50,
    surfaceScore: UNSCANNED_VISION_SCORE,
    edgeScore: UNSCANNED_VISION_SCORE,
    cornerScore: UNSCANNED_VISION_SCORE,
    overallScore: UNSCANNED_VISION_SCORE,
  });

  const rec = recommendation.recommendations.find((r) => r.grader === graderConfig.id);
  if (!rec) return null;

  const costBasis = rawCost + rec.fee + market.shippingRoundTrip;
  const roiPct = costBasis > 0 ? (rec.netROI / costBasis) * 100 : 0;

  const probs = deriveGradeProbabilities(gemRatePct, UNSCANNED_VISION_SCORE);
  const maxBuyPrice = calculateMaxBuyPrice({
    grader: graderConfig,
    gradeProbabilities: probs,
    topGradePrice,
    midGradePrice,
    belowGradePrice: rawMarketPrice,
    shippingRoundTrip: DEFAULT_SHIPPING_ROUND_TRIP,
  });

  const recentSales: SalePoint[] = topSales.map((s) => ({ price: s.sale_price, date: s.sale_date }));

  const iq = calculateIQScore({
    gemRatePct,
    expectedNetRoiPct: roiPct,
    recentSales,
    popHistory,
  });

  return {
    grader: graderConfig.id,
    roiPct,
    maxBuyPrice,
    iqScore: iq.score,
    iqLabel: iq.label,
    iqReason: iq.reason,
    topGradePrice,
    saleCount: topSales.length,
  };
}

/**
 * Computes buy signals for every card with real market_sales data.
 * Cached for an hour (see app/buy-signals/page.tsx's revalidate export) --
 * this does real aggregation work across every scraped sale, and the
 * underlying data only actually changes once a night anyway.
 */
export async function getBuySignals(): Promise<BuySignal[]> {
  const supabase = createServiceRoleClient();

  const [sales, cards, gemRateRows] = await Promise.all([
    fetchAllRows<MarketSaleRow>(supabase, "market_sales", "card_id, grader, grade, sale_price, sale_date"),
    fetchAllRows<CardRow>(supabase, "cards", "id, name, set_name"),
    fetchAllRows<GemRateRow>(supabase, "gem_rates", "card_id, grader, total_pop, gem_rate, scraped_at"),
  ]);

  const cardById = new Map(cards.map((c) => [c.id, c]));
  const salesByCard = groupBy(sales, (s) => s.card_id);
  const gemRatesByCardGrader = groupBy(gemRateRows, (r) => `${r.card_id}:${r.grader}`);

  // Latest gem_rates row per (card, grader) -- gives the "current" gem
  // rate; the full grouped history above is what pop growth is computed
  // from in calculateIQScore.
  const latestGemRateByCardGrader = new Map<string, GemRateRow>();
  for (const [key, rows] of gemRatesByCardGrader.entries()) {
    const latest = [...rows].sort(
      (a, b) => new Date(b.scraped_at).getTime() - new Date(a.scraped_at).getTime()
    )[0];
    latestGemRateByCardGrader.set(key, latest);
  }

  const signals: BuySignal[] = [];

  for (const [cardId, cardSales] of salesByCard.entries()) {
    const card = cardById.get(cardId);
    if (!card) continue;

    const salesByGrader = groupBy(cardSales, (s) => s.grader ?? "UNKNOWN");

    let best: ReturnType<typeof evaluateCardForGrader> = null;

    for (const [graderCode, graderSales] of salesByGrader.entries()) {
      const gemRateKey = `${cardId}:${graderCode}`;
      const popHistory: PopPoint[] = (gemRatesByCardGrader.get(gemRateKey) ?? []).map((r) => ({
        totalPop: r.total_pop,
        date: r.scraped_at,
      }));

      const evaluated = evaluateCardForGrader(
        graderCode,
        graderSales,
        latestGemRateByCardGrader.get(gemRateKey),
        popHistory
      );

      if (evaluated && (!best || evaluated.iqScore > best.iqScore)) {
        best = evaluated;
      }
    }

    if (best) {
      const graderConfig = GRADERS.find((g) => g.id === best!.grader)!;
      signals.push({
        cardId,
        cardName: card.name,
        setName: card.set_name,
        bestGrader: best.grader,
        bestGraderName: `${graderConfig.name} ${graderConfig.tier}`,
        iqScore: best.iqScore,
        iqLabel: best.iqLabel,
        iqReason: best.iqReason,
        expectedRoiPct: Math.round(best.roiPct * 10) / 10,
        maxBuyPrice: best.maxBuyPrice,
        gemRatePct: latestGemRateByCardGrader.get(`${cardId}:${best.grader.toUpperCase()}`)?.gem_rate ?? 0,
        topGradePrice: Math.round(best.topGradePrice * 100) / 100,
        saleCount: best.saleCount,
      });
    }
  }

  signals.sort((a, b) => b.iqScore - a.iqScore);
  return signals;
}
