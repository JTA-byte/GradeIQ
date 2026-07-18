/**
 * Buy Signals data layer: scans every card with real scraped sale data
 * and ranks the best current grading opportunities.
 *
 * Reality check done before writing this (query the live DB, don't
 * assume): `gem_rates` is currently EMPTY -- the PSA/CGC/BGS/TAG pop
 * scrapers (python-services/scrapers/{psa,cgc,bgs,tag}_scraper.py) were
 * never fixed with real selectors the way alt_scraper.py was, so no pop
 * report has ever actually been written. `market_sales` has real graded
 * data from Alt.xyz (source 'alt' or 'ebay_sold' comps it aggregates) --
 * TAG isn't tracked by Alt at all, and SGC sales exist but aren't one of
 * GradeIQ's 4 supported graders, so both are skipped here. As of the
 * PriceCharting scraper rewrite (see python-services/scrapers/
 * pricecharting_scraper.py), `market_sales` also gains real *raw*
 * (grade = 'Raw', grader = null, source = 'pricecharting') sale rows
 * once the nightly job has run against a card -- rawMarketPrice below
 * uses those when present instead of an estimate.
 *
 * Practical effect: gemRatePct is 0 for every card today (there's
 * nothing real to report), and pop growth has no history to compute
 * from either -- both default to iqScore.ts's built-in neutral handling.
 * IQ scores right now are effectively driven by ROI% and price momentum
 * (60% of the weight) until the pop scrapers get fixed. This is honest,
 * not a bug -- scores will improve in signal quality as real pop data
 * starts flowing in, same as the rest of this app's mock-to-real story.
 *
 * Raw/ungraded price falls back to an estimated fraction of top-grade
 * price (clearly flagged via isRawPriceEstimated) only when no real
 * PriceCharting raw sales exist yet for a card -- rather than call the
 * live TCGPlayer/PriceCharting clients once per candidate card (967+
 * external calls per page load isn't practical, unlike the single-card
 * analyze flow in lib/mockDataService.ts, which still does exactly that).
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

// How a raw grade-label maps to a human-readable target grade, e.g.
// "PSA 10", "CGC Pristine", "BGS Black Label".
const GRADE_LABEL_DISPLAY: Record<string, string> = {
  "10": "10",
  PRI: "Pristine",
  BL: "Black Label",
};

const SOURCE_DISPLAY: Record<string, string> = {
  ebay_sold: "eBay",
  alt: "Alt.xyz",
  pricecharting: "PriceCharting",
};

// Used only when no real PriceCharting raw sales exist yet for a card.
const ESTIMATED_RAW_TO_TOP_GRADE_RATIO = 0.15;
const ESTIMATED_MID_TO_TOP_GRADE_RATIO_FALLBACK = 0.4;

const DEFAULT_SHIPPING_ROUND_TRIP = 20;

// Confidence thresholds for how many target-grade sales back a signal's
// numbers, within the last 90 days -- same shape as PriceCharting's own
// raw-price confidence scale (lib/priceCharting.ts), applied here to
// graded sale volume instead.
const LOW_VOLUME_THRESHOLD = 5;
const HIGH_CONFIDENCE_THRESHOLD = 10;
const RECENT_SALE_WINDOW_DAYS = 90;

export type PriceConfidence = "high" | "medium" | "low";

export interface RecentSaleDisplay {
  grader: string | null; // null for a raw (ungraded) sale
  grade: string;
  price: number;
  date: string; // ISO date
  source: string; // 'ebay_sold' | 'pricecharting' | 'alt'
  sourceLabel: string; // human-readable, e.g. "Alt.xyz"
  sourceUrl: string | null; // direct listing link, when the scraper captured one (Alt sales only today)
}

export interface BuySignal {
  cardId: string;
  cardName: string;
  setName: string;
  cardNumber: string | null;
  bestGrader: GraderId;
  bestGraderName: string;
  targetGradeLabel: string; // e.g. "PSA 10"
  iqScore: number;
  iqLabel: IQScoreLabel;
  iqReason: string;
  whyReason: string;
  expectedRoiPct: number;
  maxBuyPrice: number;
  gemRatePct: number; // 0 today -- see file header
  rawMarketPrice: number;
  isRawPriceEstimated: boolean;
  topGradePrice: number;
  gapDollars: number;
  saleCount: number; // how many real top-grade sales this estimate rests on (all-time)
  recentSaleCount90d: number;
  priceConfidence: PriceConfidence;
  lastSaleDate: string | null;
  recentSales: RecentSaleDisplay[];
}

interface MarketSaleRow {
  card_id: string;
  grader: string | null;
  grade: string;
  sale_price: number;
  sale_date: string;
  source: string;
  source_url: string | null;
}

interface CardRow {
  id: string;
  name: string;
  set_name: string;
  card_number: string | null;
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

function mostFrequent(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
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

function buildWhyReason(params: {
  cardName: string;
  setName: string;
  gemRatePct: number;
  targetGradeLabel: string;
  gapDollars: number;
  graderName: string;
  fee: number;
  expectedRoiPct: number;
}): string {
  const { cardName, setName, gemRatePct, targetGradeLabel, gapDollars, graderName, fee, expectedRoiPct } =
    params;

  // Only cite a gem rate when there's a real one to cite -- gem_rates is
  // empty today (see file header), and a fabricated "0% gem rate" clause
  // would read like a real, bad number rather than "we have no data yet".
  const gemClause = gemRatePct > 0 ? ` a ${gemRatePct.toFixed(0)}% ${targetGradeLabel} gem rate and` : "";

  return (
    `${cardName} from ${setName} has${gemClause} a $${Math.round(gapDollars).toLocaleString()} ` +
    `raw-to-${targetGradeLabel} gap. ${graderName} fees of $${fee} and a ` +
    `${expectedRoiPct >= 0 ? "+" : ""}${expectedRoiPct.toFixed(0)}% expected net ROI make this one of the ` +
    `stronger opportunities in today's signals.`
  );
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
  popHistory: PopPoint[],
  realRawMarketPrice: number | null
): {
  grader: GraderId;
  targetGradeLabel: string;
  roiPct: number;
  maxBuyPrice: number;
  iqScore: number;
  iqLabel: IQScoreLabel;
  iqReason: string;
  topGradePrice: number;
  rawMarketPrice: number;
  isRawPriceEstimated: boolean;
  saleCount: number;
  recentSaleCount90d: number;
  lastSaleDate: string | null;
} | null {
  const graderConfig = GRADERS.find((g) => g.id === graderCode.toLowerCase());
  if (!graderConfig) return null; // not one of GradeIQ's 4 supported graders (e.g. SGC)

  const topSales = graderSales.filter((s) => TOP_GRADE_LABELS.has(s.grade));
  if (topSales.length === 0) return null; // nothing to anchor an estimate on

  const midSales = graderSales.filter((s) => MID_GRADE_LABELS.has(s.grade));

  const topGradePrice = average(topSales.map((s) => s.sale_price));
  const midGradePrice =
    midSales.length > 0
      ? average(midSales.map((s) => s.sale_price))
      : topGradePrice * ESTIMATED_MID_TO_TOP_GRADE_RATIO_FALLBACK;

  const isRawPriceEstimated = realRawMarketPrice === null;
  const rawMarketPrice = realRawMarketPrice ?? topGradePrice * ESTIMATED_RAW_TO_TOP_GRADE_RATIO;
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

  const now = Date.now();
  const recentSaleCount90d = topSales.filter(
    (s) => now - new Date(s.sale_date).getTime() <= RECENT_SALE_WINDOW_DAYS * 24 * 60 * 60 * 1000
  ).length;

  const lastSaleDate =
    topSales.length > 0
      ? topSales.reduce((latest, s) => (s.sale_date > latest ? s.sale_date : latest), topSales[0].sale_date)
      : null;

  const targetGradeLabel = `${graderConfig.name} ${
    GRADE_LABEL_DISPLAY[mostFrequent(topSales.map((s) => s.grade))] ?? topSales[0].grade
  }`;

  return {
    grader: graderConfig.id,
    targetGradeLabel,
    roiPct,
    maxBuyPrice,
    iqScore: iq.score,
    iqLabel: iq.label,
    iqReason: iq.reason,
    topGradePrice,
    rawMarketPrice,
    isRawPriceEstimated,
    saleCount: topSales.length,
    recentSaleCount90d,
    lastSaleDate,
  };
}

function confidenceFor(recentSaleCount90d: number): PriceConfidence {
  if (recentSaleCount90d < LOW_VOLUME_THRESHOLD) return "low";
  if (recentSaleCount90d < HIGH_CONFIDENCE_THRESHOLD) return "medium";
  return "high";
}

/**
 * Computes buy signals for every card with real market_sales data.
 * Cached for an hour (see app/buy-signals/page.tsx's revalidate export) --
 * this does real aggregation work across every scraped sale, and the
 * underlying data only actually changes once a night anyway.
 */
/**
 * Fetches every market_sales row, tolerating the source_url column not
 * existing yet -- it's added in supabase/schema.sql but, per this
 * project's convention, applied to the live DB by hand rather than by
 * this code. Without the fallback below, a deploy of this feature would
 * hard-break the entire Buy Signals page (this query runs on every page
 * load) for however long it takes to run that migration; sourceUrl is
 * optional display metadata, not something the ROI/IQ math depends on,
 * so degrading to null for it is the right tradeoff.
 */
async function fetchMarketSales(
  supabase: ReturnType<typeof createServiceRoleClient>
): Promise<MarketSaleRow[]> {
  try {
    return await fetchAllRows<MarketSaleRow>(
      supabase,
      "market_sales",
      "card_id, grader, grade, sale_price, sale_date, source, source_url"
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("source_url")) throw err;

    console.warn(
      "[buySignals] market_sales.source_url doesn't exist yet -- falling back without it. " +
        "Run the migration in supabase/schema.sql to enable direct sale listing links."
    );
    const rows = await fetchAllRows<Omit<MarketSaleRow, "source_url">>(
      supabase,
      "market_sales",
      "card_id, grader, grade, sale_price, sale_date, source"
    );
    return rows.map((r) => ({ ...r, source_url: null }));
  }
}

export async function getBuySignals(): Promise<BuySignal[]> {
  const supabase = createServiceRoleClient();

  const [sales, cards, gemRateRows] = await Promise.all([
    fetchMarketSales(supabase),
    fetchAllRows<CardRow>(supabase, "cards", "id, name, set_name, card_number"),
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

    const rawSales = cardSales.filter((s) => s.grade === "Raw");
    const realRawMarketPrice = rawSales.length > 0 ? average(rawSales.map((s) => s.sale_price)) : null;

    const gradedSales = cardSales.filter((s) => s.grade !== "Raw");
    const salesByGrader = groupBy(gradedSales, (s) => s.grader ?? "UNKNOWN");

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
        popHistory,
        realRawMarketPrice
      );

      if (evaluated && (!best || evaluated.iqScore > best.iqScore)) {
        best = evaluated;
      }
    }

    if (best) {
      const graderConfig = GRADERS.find((g) => g.id === best!.grader)!;
      const gemRatePct = latestGemRateByCardGrader.get(`${cardId}:${best.grader.toUpperCase()}`)?.gem_rate ?? 0;
      const gapDollars = best.topGradePrice - best.rawMarketPrice;

      const recentSales: RecentSaleDisplay[] = [...gradedSales]
        .sort((a, b) => new Date(b.sale_date).getTime() - new Date(a.sale_date).getTime())
        .slice(0, 5)
        .map((s) => ({
          grader: s.grader,
          grade: s.grade,
          price: s.sale_price,
          date: s.sale_date,
          source: s.source,
          sourceLabel: SOURCE_DISPLAY[s.source] ?? s.source,
          sourceUrl: s.source_url,
        }));

      signals.push({
        cardId,
        cardName: card.name,
        setName: card.set_name,
        cardNumber: card.card_number,
        bestGrader: best.grader,
        bestGraderName: `${graderConfig.name} ${graderConfig.tier}`,
        targetGradeLabel: best.targetGradeLabel,
        iqScore: best.iqScore,
        iqLabel: best.iqLabel,
        iqReason: best.iqReason,
        whyReason: buildWhyReason({
          cardName: card.name,
          setName: card.set_name,
          gemRatePct,
          targetGradeLabel: best.targetGradeLabel,
          gapDollars,
          graderName: `${graderConfig.name} ${graderConfig.tier}`,
          fee: graderConfig.fee,
          expectedRoiPct: Math.round(best.roiPct * 10) / 10,
        }),
        expectedRoiPct: Math.round(best.roiPct * 10) / 10,
        maxBuyPrice: best.maxBuyPrice,
        gemRatePct,
        rawMarketPrice: Math.round(best.rawMarketPrice * 100) / 100,
        isRawPriceEstimated: best.isRawPriceEstimated,
        topGradePrice: Math.round(best.topGradePrice * 100) / 100,
        gapDollars: Math.round(gapDollars * 100) / 100,
        saleCount: best.saleCount,
        recentSaleCount90d: best.recentSaleCount90d,
        priceConfidence: confidenceFor(best.recentSaleCount90d),
        lastSaleDate: best.lastSaleDate,
        recentSales,
      });
    }
  }

  signals.sort((a, b) => b.iqScore - a.iqScore);
  return signals;
}
