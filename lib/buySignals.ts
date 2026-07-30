/**
 * Buy Signals data layer: scans every card with real scraped sale data
 * and ranks the best current grading opportunities.
 *
 * Reality check done before writing this (query the live DB, don't
 * assume): `gem_rates` is currently EMPTY -- the PSA/CGC/BGS/TAG pop
 * scrapers got bot-detected after ~3 hours of running and are disabled
 * (see python-services/jobs/nightly_pop_scrape.py), and manual entry
 * (app/admin/gem-rates) only covers whatever's been hand-entered so far.
 * `market_sales` has real graded data from Alt.xyz (source 'alt' or
 * 'ebay_sold' comps it aggregates) -- TAG isn't tracked by Alt at all,
 * and SGC sales exist but aren't one of GradeIQ's 4 supported graders,
 * so both are skipped here. As of the PriceCharting scraper rewrite (see
 * python-services/scrapers/pricecharting_scraper.py), `market_sales`
 * also gains real *raw* (grade = 'Raw', grader = null, source =
 * 'pricecharting') sale rows once the nightly job has run against a
 * card -- rawMarketPrice below uses those when present instead of an
 * estimate.
 *
 * Practical effect: gemRatePct uses a real gem_rates row when one
 * exists, falls back to computeImpliedGemRate() (top-grade sold-listing
 * share, see its docstring) when there are 5+ graded market_sales for
 * that card/grader, and is 0 only when neither exists -- flagged via
 * isGemRateImplied so the UI and whyReason text can be honest about
 * which case it's in. Pop growth still has no history to compute from
 * either way (gem_rates has nothing to snapshot over time yet) and
 * defaults to iqScore.ts's built-in neutral handling. This is honest,
 * not a bug -- scores will keep improving in signal quality as real pop
 * data starts flowing in, same as the rest of this app's mock-to-real
 * story.
 *
 * Raw/ungraded price falls back to an estimated fraction of top-grade
 * price (clearly flagged via isRawPriceEstimated) only when no real
 * PriceCharting raw sales exist yet for a card -- rather than call the
 * live TCGPlayer/PriceCharting clients once per candidate card (967+
 * external calls per page load isn't practical, unlike the single-card
 * analyze flow in lib/mockDataService.ts, which still does exactly that).
 */
import { unstable_cache } from "next/cache";
import { createServiceRoleClient } from "@/lib/supabase/server";
import {
  CardMarketData,
  GemRateData,
  GRADE_TIERS,
  GraderId,
  GRADERS,
  calculateMaxBuyPrice,
  calculateTierMaxBuyPrice,
  calculateTierRoiPct,
  deriveGradeProbabilities,
  getGraderRecommendations,
} from "./roiEngine";
import { calculateIQScore, IQScoreLabel, PopPoint, SalePoint } from "./iqScore";

const PAGE_SIZE = 1000; // PostgREST's default per-request row cap

// A card without a scan yet has no vision assessment -- this neutral
// midpoint (matches deriveGradeProbabilities' own default) avoids
// pretending we know anything about a specific physical copy's condition.
const UNSCANNED_VISION_SCORE = 7.5;

// How a raw grade-label maps to a human-readable target grade, e.g.
// "PSA 10", "CGC Pristine", "BGS Black Label".
const GRADE_LABEL_DISPLAY: Record<string, string> = {
  "10": "10",
  "9": "9",
  PRI: "Pristine",
  "Pristine 10": "Pristine",
  BL: "Black Label",
  "Black Label": "Black Label",
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

// A card needs at least this many real top-grade sales anchoring its
// price estimate to appear in Buy Signals at all -- 1-2 sales is too
// thin a sample to trust for a "buy this" recommendation, even before
// considering whether either of those sales is itself bad data.
const MIN_SALES_FOR_SIGNAL = 3;

// A card/grader needs at least this many graded market_sales rows before
// computeImpliedGemRate() below will produce a number at all -- fewer
// than this and one early PSA 10 sale could swing the "rate" from 0% to
// 100%. See computeImpliedGemRate()'s own docstring for what this is a
// proxy for and why it's not the same thing as a real population report.
const MIN_SALES_FOR_IMPLIED_GEM_RATE = 5;

// If the graded (top-grade) average is more than this many multiples of
// the real raw price, something upstream is almost certainly wrong --
// either scraper contamination (a different, more valuable printing) or
// a single mislabeled/outlier listing (confirmed live: a real "Flygon
// #5 Rising Rivals" PSA 10 sale at $3,700 sitting next to PSA 7-9 sales
// at $19-47 -- same card, correctly identified, still an implausible
// price). Rather than guess which it is, exclude the card until someone
// reviews market_sales for it directly -- this same ratio is also the
// basis of the one-off market_sales cleanup query run against the live
// DB to clear out rows written before this check existed.
const MAX_GRADED_TO_RAW_RATIO = 100;

export type PriceConfidence = "high" | "medium" | "low";
export type PriceTrend = "trending_up" | "cooling" | "stable";

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
  language: string;
  variant: string;
  variantDetail: string | null;
  bestGrader: GraderId;
  bestGraderName: string;
  targetGradeLabel: string; // e.g. "PSA 10"
  iqScore: number;
  iqLabel: IQScoreLabel;
  iqReason: string;
  whyReason: string;
  expectedRoiPct: number;
  maxBuyPrice: number;
  gemRatePct: number; // real gem_rates value if one exists, else an implied estimate (see isGemRateImplied), else 0
  isGemRateImplied: boolean; // true when gemRatePct came from computeImpliedGemRate() rather than a verified gem_rates row
  rawMarketPrice: number;
  isRawPriceEstimated: boolean;
  topGradePrice: number;
  gapDollars: number;
  // Tier 1 (BGS Black Label / CGC Pristine 10 / PSA 10 / TAG 10) and
  // Tier 2 (BGS 10 / PSA 9 / CGC 10 / TAG 9) priced and computed
  // independently, per GRADE_TIERS -- null when this card/grader has no
  // real sales in that tier. topGradePrice/expectedRoiPct/maxBuyPrice
  // above already reflect "Tier 1 if it has sales, else Tier 2" as the
  // card's single primary signal; these give the UI both numbers at once.
  tier1Price: number | null;
  tier1RoiPct: number | null;
  tier1MaxBuyPrice: number | null;
  tier2Price: number | null;
  tier2RoiPct: number | null;
  tier2MaxBuyPrice: number | null;
  saleCount: number; // how many real top-grade sales this estimate rests on (all-time)
  recentSaleCount90d: number;
  priceConfidence: PriceConfidence;
  lastSaleDate: string | null;
  recentSales: RecentSaleDisplay[];
  trend: PriceTrend;
  gradedPriceChangePct: number | null; // last 30d vs 31-60d avg graded sale price, null if not enough history either side
  dataQualityScore: number; // 0-100, see computeDataQualityScore() -- higher is more trustworthy
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
  language: string | null;
  variant: string | null;
  variant_detail: string | null;
}

interface GemRateRow {
  card_id: string;
  grader: string;
  total_pop: number;
  gem_rate: number;
  scraped_at: string;
}

/**
 * Fetches every row of `table`, working around PostgREST's 1000-row cap
 * per request via keyset ("seek") pagination on the table's uuid `id`
 * primary key -- `WHERE id > lastSeenId ORDER BY id LIMIT 1000` -- rather
 * than offset pagination (`OFFSET n LIMIT 1000`).
 *
 * This distinction is why market_sales (1.8M+ rows) was timing out the
 * Buy Signals page in production, not computeImpliedGemRate() (which is
 * pure arithmetic on numbers already in memory, no query at all): an
 * earlier version of this function fetched pages concurrently via
 * `.range()`, which translates to SQL OFFSET -- and OFFSET's cost grows
 * with how deep into the table it's skipping, so firing many deep-offset
 * pages at once (some skipping close to a million rows each) is exactly
 * what triggered "canceling statement due to statement timeout" when
 * tested live against the real 1.8M-row table. Keyset pagination has no
 * such penalty: `id > lastSeenId` is a direct index seek, equally fast
 * (down to network latency) regardless of depth, so it can't time out
 * this way no matter how large the table grows. The tradeoff is that it
 * must run sequentially (each page's cursor depends on the previous
 * page's last id) rather than concurrently -- see getBuySignals()'s
 * unstable_cache wrapper for how the resulting cost is kept off the
 * request path for real users regardless.
 *
 * `columns` doesn't need to include "id" -- it's added to the select
 * automatically to drive the cursor, then present as an extra field on
 * the returned rows (harmless: TypeScript's structural typing doesn't
 * mind objects having more properties than their declared type lists).
 */
async function fetchAllRows<T>(
  supabase: ReturnType<typeof createServiceRoleClient>,
  table: string,
  columns: string
): Promise<T[]> {
  // Exact column-name match, not a substring check -- "card_id" contains
  // the substring "id" too, which previously made this skip appending the
  // real `id` column whenever a caller's column list happened to include
  // any column ending in "id" (card_id, grader...). That silently left
  // every row's `id` as undefined, which serialized into the next page's
  // `.gt("id", ...)` call as the literal string "undefined" and broke
  // every table's pagination the moment a table had more than one page.
  const hasIdColumn = columns.split(",").some((c) => c.trim() === "id");
  const all: T[] = [];
  let lastId: string | null = null;

  while (true) {
    let query = supabase
      .from(table)
      .select(hasIdColumn ? columns : `${columns}, id`)
      .order("id", { ascending: true })
      .limit(PAGE_SIZE);

    if (lastId !== null) {
      query = query.gt("id", lastId);
    }

    const { data, error } = await query;
    if (error) throw new Error(`Failed to fetch ${table}: ${error.message}`);
    if (!data || data.length === 0) break;

    all.push(...(data as T[]));
    if (data.length < PAGE_SIZE) break;
    lastId = (data[data.length - 1] as unknown as { id: string }).id;
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
  isGemRateImplied: boolean;
  targetGradeLabel: string;
  gapDollars: number;
  graderName: string;
  fee: number;
  expectedRoiPct: number;
}): string {
  const {
    cardName,
    setName,
    gemRatePct,
    isGemRateImplied,
    targetGradeLabel,
    gapDollars,
    graderName,
    fee,
    expectedRoiPct,
  } = params;

  // Only cite a gem rate when there's a real or implied one to cite --
  // with neither, a fabricated "0% gem rate" clause would read like a
  // real, bad number rather than "we have no data yet". When it's implied
  // (computeImpliedGemRate(), not a verified gem_rates row), say so --
  // it's a real signal but a weaker one, and shouldn't be presented with
  // the same confidence as a true population-report rate.
  const article = isGemRateImplied ? "an implied" : "a";
  const gemClause = gemRatePct > 0 ? ` ${article} ${gemRatePct.toFixed(0)}% ${targetGradeLabel} gem rate and` : "";

  return (
    `${cardName} from ${setName} has${gemClause} a $${Math.round(gapDollars).toLocaleString()} ` +
    `raw-to-${targetGradeLabel} gap. ${graderName} fees of $${fee} and a ` +
    `${expectedRoiPct >= 0 ? "+" : ""}${expectedRoiPct.toFixed(0)}% expected net ROI make this one of the ` +
    `stronger opportunities in today's signals.`
  );
}

/**
 * A real, from-actual-sales gem rate estimate for when gem_rates has
 * nothing for this card/grader -- true for every card today, since the
 * PSA/CGC/BGS/TAG pop scrapers are currently disabled after getting bot-
 * detected (see python-services/jobs/nightly_pop_scrape.py). Rather than
 * default straight to 0% (pretending there's no signal at all) or wait
 * on scraping/manual entry, this counts what's already sitting in
 * market_sales: top-grade sales / all graded sales for this grader.
 *
 * This is NOT the same thing as a true population-report gem rate, and
 * callers must not treat it as equally trustworthy -- it's a rate among
 * SOLD copies, which skews toward whatever grade collectors actually
 * list and buy most often on the secondary market (often the top grade,
 * since that's what's worth grading and reselling), not the true
 * distribution of every submitted copy. It's still real signal from
 * data this app already has, though, so it's used as a labeled "implied"
 * fallback (see isGemRateImplied on BuySignal) rather than a fabricated
 * 0%, until real gem_rates data exists for a card.
 */
function computeImpliedGemRate(topGradeCount: number, totalGradedCount: number): number | null {
  if (totalGradedCount < MIN_SALES_FOR_IMPLIED_GEM_RATE) return null;
  return Math.round((topGradeCount / totalGradedCount) * 1000) / 10;
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
  topSalesRows: MarketSaleRow[];
  gemRatePct: number;
  isGemRateImplied: boolean;
  tier1Price: number | null;
  tier1RoiPct: number | null;
  tier1MaxBuyPrice: number | null;
  tier2Price: number | null;
  tier2RoiPct: number | null;
  tier2MaxBuyPrice: number | null;
} | null {
  const graderConfig = GRADERS.find((g) => g.id === graderCode.toLowerCase());
  if (!graderConfig) return null; // not one of GradeIQ's 4 supported graders (e.g. SGC)

  // GRADE_TIERS is keyed by grader NAME ("PSA"/"CGC"/"BGS"/"TAG"), not id --
  // graderConfig.name is exactly one of those four strings.
  const tier1Labels: readonly string[] =
    GRADE_TIERS.tier1[graderConfig.name as keyof typeof GRADE_TIERS.tier1] ?? [];
  const tier2Labels: readonly string[] =
    GRADE_TIERS.tier2[graderConfig.name as keyof typeof GRADE_TIERS.tier2] ?? [];

  const tier1Sales = graderSales.filter((s) => tier1Labels.includes(s.grade));
  const tier2Sales = graderSales.filter((s) => tier2Labels.includes(s.grade));

  // Nothing in Tier 1 or Tier 2 -- everything below Tier 2 (PSA 8, BGS
  // 9.5, etc.) isn't worth anchoring a buy signal on at all.
  if (tier1Sales.length === 0 && tier2Sales.length === 0) return null;

  const tier1Price = tier1Sales.length > 0 ? average(tier1Sales.map((s) => s.sale_price)) : null;
  const tier2Price = tier2Sales.length > 0 ? average(tier2Sales.map((s) => s.sale_price)) : null;

  // Primary signal is Tier 1 (the rarest, highest-value grade); Tier 2
  // is the fallback anchor only when this card/grader has no real Tier 1
  // sales yet. topSales below drives every existing "top grade" display
  // field (targetGradeLabel, topGradePrice, saleCount, trend, etc.).
  const anchorTier: 1 | 2 = tier1Price !== null ? 1 : 2;
  const topSales = anchorTier === 1 ? tier1Sales : tier2Sales;
  const topGradePrice = anchorTier === 1 ? tier1Price! : tier2Price!;

  // midGradePrice feeds the existing probability-blended ROI/IQ model
  // (deriveGradeProbabilities' top/mid/low split) as "the tier down from
  // the anchor" -- real Tier 2 data when the anchor is Tier 1 and some
  // exists, otherwise an estimate (there's no real tier below Tier 2 to
  // use, and PSA 8/BGS 9.5-class sales are deliberately excluded above).
  const midGradePrice =
    anchorTier === 1 && tier2Price !== null
      ? tier2Price
      : topGradePrice * ESTIMATED_MID_TO_TOP_GRADE_RATIO_FALLBACK;

  const isRawPriceEstimated = realRawMarketPrice === null;
  const rawMarketPrice = realRawMarketPrice ?? topGradePrice * ESTIMATED_RAW_TO_TOP_GRADE_RATIO;
  const rawCost = rawMarketPrice * 0.85;

  // Real gem_rates data wins when it exists; otherwise fall back to the
  // implied rate computed from this grader's own sold listings (see
  // computeImpliedGemRate()'s docstring), and only then to 0 (no signal
  // at all -- fewer than MIN_SALES_FOR_IMPLIED_GEM_RATE graded sales).
  // Always measured against true Tier 1 (the rarest grade), even when
  // Tier 2 is what's anchoring the price above -- "gem rate" means the
  // population share hitting the single best grade, not whichever tier
  // happens to have enough sales to price off of.
  const impliedGemRate = computeImpliedGemRate(tier1Sales.length, graderSales.length);
  const isGemRateImplied = gemRateRow === undefined && impliedGemRate !== null;
  const gemRatePct = gemRateRow?.gem_rate ?? impliedGemRate ?? 0;

  const tier1RoiPct =
    tier1Price !== null
      ? Math.round(
          calculateTierRoiPct({
            grader: graderConfig,
            salePrice: tier1Price,
            rawCost,
            shippingRoundTrip: DEFAULT_SHIPPING_ROUND_TRIP,
          }) * 10
        ) / 10
      : null;
  const tier1MaxBuyPrice =
    tier1Price !== null
      ? calculateTierMaxBuyPrice({
          grader: graderConfig,
          salePrice: tier1Price,
          shippingRoundTrip: DEFAULT_SHIPPING_ROUND_TRIP,
        })
      : null;
  const tier2RoiPct =
    tier2Price !== null
      ? Math.round(
          calculateTierRoiPct({
            grader: graderConfig,
            salePrice: tier2Price,
            rawCost,
            shippingRoundTrip: DEFAULT_SHIPPING_ROUND_TRIP,
          }) * 10
        ) / 10
      : null;
  const tier2MaxBuyPrice =
    tier2Price !== null
      ? calculateTierMaxBuyPrice({
          grader: graderConfig,
          salePrice: tier2Price,
          shippingRoundTrip: DEFAULT_SHIPPING_ROUND_TRIP,
        })
      : null;

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
    topSalesRows: topSales,
    gemRatePct,
    isGemRateImplied,
    tier1Price,
    tier1RoiPct,
    tier1MaxBuyPrice,
    tier2Price,
    tier2RoiPct,
    tier2MaxBuyPrice,
  };
}

function confidenceFor(recentSaleCount90d: number): PriceConfidence {
  if (recentSaleCount90d < LOW_VOLUME_THRESHOLD) return "low";
  if (recentSaleCount90d < HIGH_CONFIDENCE_THRESHOLD) return "medium";
  return "high";
}

const DAY_MS = 24 * 60 * 60 * 1000;
const TREND_WINDOW_DAYS = 30;
const TREND_THRESHOLD_PCT = 20; // graded price must move at least this much to be trending/cooling
const RAW_STABLE_THRESHOLD_PCT = 10; // raw price must stay within this band to count as "hasn't moved"

/**
 * Trend detection: last 30 days of graded sales vs. the 30 days before
 * that. "Trending up" requires the graded price to be up 20%+ while the
 * raw price either hasn't moved (within 10%) or there's no raw data to
 * compare -- the whole point is to surface cards where the market is
 * repricing the GRADED premium specifically, not just a card that's
 * generally getting more expensive (raw and graded both up together
 * isn't the same signal). "Cooling" only looks at the graded side --
 * a 20%+ drop is worth flagging regardless of what raw is doing.
 */
function computeTrend(
  gradedTopSales: { sale_price: number; sale_date: string }[],
  rawSales: { sale_price: number; sale_date: string }[]
): { trend: PriceTrend; gradedPriceChangePct: number | null } {
  const now = Date.now();
  const recentCutoff = now - TREND_WINDOW_DAYS * DAY_MS;
  const priorCutoff = now - 2 * TREND_WINDOW_DAYS * DAY_MS;

  const inRecentWindow = (s: { sale_date: string }) => new Date(s.sale_date).getTime() >= recentCutoff;
  const inPriorWindow = (s: { sale_date: string }) => {
    const t = new Date(s.sale_date).getTime();
    return t >= priorCutoff && t < recentCutoff;
  };

  const gradedRecent = gradedTopSales.filter(inRecentWindow);
  const gradedPrior = gradedTopSales.filter(inPriorWindow);

  if (gradedRecent.length === 0 || gradedPrior.length === 0) {
    return { trend: "stable", gradedPriceChangePct: null };
  }

  const gradedRecentAvg = average(gradedRecent.map((s) => s.sale_price));
  const gradedPriorAvg = average(gradedPrior.map((s) => s.sale_price));
  const gradedPriceChangePct =
    gradedPriorAvg > 0 ? ((gradedRecentAvg - gradedPriorAvg) / gradedPriorAvg) * 100 : 0;

  const rawRecent = rawSales.filter(inRecentWindow);
  const rawPrior = rawSales.filter(inPriorWindow);

  let rawPriceChangePct: number | null = null;
  if (rawRecent.length > 0 && rawPrior.length > 0) {
    const rawRecentAvg = average(rawRecent.map((s) => s.sale_price));
    const rawPriorAvg = average(rawPrior.map((s) => s.sale_price));
    rawPriceChangePct = rawPriorAvg > 0 ? ((rawRecentAvg - rawPriorAvg) / rawPriorAvg) * 100 : null;
  }

  const rounded = Math.round(gradedPriceChangePct * 10) / 10;

  if (
    gradedPriceChangePct >= TREND_THRESHOLD_PCT &&
    (rawPriceChangePct === null || Math.abs(rawPriceChangePct) < RAW_STABLE_THRESHOLD_PCT)
  ) {
    return { trend: "trending_up", gradedPriceChangePct: rounded };
  }
  if (gradedPriceChangePct <= -TREND_THRESHOLD_PCT) {
    return { trend: "cooling", gradedPriceChangePct: rounded };
  }
  return { trend: "stable", gradedPriceChangePct: rounded };
}

/**
 * 0-100 score for how much a signal's numbers should be trusted, built
 * from four independent factors (each capped before summing, so one
 * strong factor can't compensate for a card that's weak everywhere
 * else):
 *  - Volume (0-40): how many top-grade sales anchor topGradePrice.
 *  - Recency (0-20): how many of those are from the last 90 days.
 *  - Consistency (0-20): how tightly the top-grade sale prices cluster
 *    -- via coefficient of variation. This is what catches a single
 *    wild outlier mixed into otherwise-sane sales (a real "Flygon #5
 *    Rising Rivals" PSA 10 sold for $3,700 next to PSA 7-9 sales at
 *    $19-47 during live testing -- every sale passed the alt_scraper.py
 *    identity check individually, but the spread itself is the tell).
 *  - Raw grounding (0-20): whether rawMarketPrice came from a real
 *    scraped raw sale rather than ESTIMATED_RAW_TO_TOP_GRADE_RATIO's guess.
 *
 * This is a trust signal for the UI, separate from the hard
 * MIN_SALES_FOR_SIGNAL / MAX_GRADED_TO_RAW_RATIO cutoffs below that
 * exclude a card from Buy Signals entirely -- a card can clear both
 * cutoffs and still show a middling score here (e.g. exactly 3 sales,
 * all old, no real raw price).
 */
function computeDataQualityScore(params: {
  saleCount: number;
  recentSaleCount90d: number;
  isRawPriceEstimated: boolean;
  topSalePrices: number[];
}): number {
  const { saleCount, recentSaleCount90d, isRawPriceEstimated, topSalePrices } = params;

  const volumeScore = Math.min(saleCount / HIGH_CONFIDENCE_THRESHOLD, 1) * 40;
  const recencyScore = Math.min(recentSaleCount90d / LOW_VOLUME_THRESHOLD, 1) * 20;

  let consistencyScore = 20; // neutral default -- nothing to compare a single sale against
  if (topSalePrices.length > 1) {
    const mean = average(topSalePrices);
    const variance = average(topSalePrices.map((p) => (p - mean) ** 2));
    const coefficientOfVariation = mean > 0 ? Math.sqrt(variance) / mean : 0;
    consistencyScore = Math.max(0, 1 - coefficientOfVariation) * 20;
  }

  const rawGroundingScore = isRawPriceEstimated ? 0 : 20;

  return Math.round(volumeScore + recencyScore + consistencyScore + rawGroundingScore);
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

/**
 * Same tolerate-missing-column reasoning as fetchMarketSales() above --
 * `cards.language` and `cards.variant`/`variant_detail` are added in
 * supabase/schema.sql but applied to the live DB by hand, and this query
 * runs on every Buy Signals page load. Falls back a column group at a
 * time so whichever migrations *have* been applied still take effect.
 */
async function fetchCards(supabase: ReturnType<typeof createServiceRoleClient>): Promise<CardRow[]> {
  try {
    return await fetchAllRows<CardRow>(
      supabase,
      "cards",
      "id, name, set_name, card_number, language, variant, variant_detail"
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (message.includes("variant")) {
      console.warn(
        "[buySignals] cards.variant doesn't exist yet -- falling back without it. " +
          "Run the migration in supabase/schema.sql to enable variant display."
      );
      try {
        const rows = await fetchAllRows<Omit<CardRow, "variant" | "variant_detail">>(
          supabase,
          "cards",
          "id, name, set_name, card_number, language"
        );
        return rows.map((r) => ({ ...r, variant: null, variant_detail: null }));
      } catch (err2) {
        const message2 = err2 instanceof Error ? err2.message : String(err2);
        if (!message2.includes("language")) throw err2;
        console.warn("[buySignals] cards.language doesn't exist yet either -- falling back without it too.");
        const rows = await fetchAllRows<Omit<CardRow, "language" | "variant" | "variant_detail">>(
          supabase,
          "cards",
          "id, name, set_name, card_number"
        );
        return rows.map((r) => ({ ...r, language: null, variant: null, variant_detail: null }));
      }
    }

    if (!message.includes("language")) throw err;

    console.warn(
      "[buySignals] cards.language doesn't exist yet -- falling back without it. " +
        "Run the migration in supabase/schema.sql to enable language display."
    );
    const rows = await fetchAllRows<Omit<CardRow, "language" | "variant" | "variant_detail">>(
      supabase,
      "cards",
      "id, name, set_name, card_number"
    );
    return rows.map((r) => ({ ...r, language: null, variant: null, variant_detail: null }));
  }
}

/**
 * Single-card version of fetchMarketSales() -- scoped with .eq() instead
 * of the full-table paginated fetch, for getBuySignalForCard(). A single
 * card's sale history is always well under PostgREST's 1000-row page
 * cap, so no pagination loop is needed here.
 */
async function fetchSalesForCard(
  supabase: ReturnType<typeof createServiceRoleClient>,
  cardId: string
): Promise<MarketSaleRow[]> {
  try {
    const { data, error } = await supabase
      .from("market_sales")
      .select("card_id, grader, grade, sale_price, sale_date, source, source_url")
      .eq("card_id", cardId);
    if (error) throw new Error(error.message);
    return (data ?? []) as MarketSaleRow[];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("source_url")) throw err;

    const { data, error } = await supabase
      .from("market_sales")
      .select("card_id, grader, grade, sale_price, sale_date, source")
      .eq("card_id", cardId);
    if (error) throw new Error(error.message);
    return ((data ?? []) as Omit<MarketSaleRow, "source_url">[]).map((r) => ({ ...r, source_url: null }));
  }
}

/** Single-card version of fetchCards() -- see fetchSalesForCard() above. */
async function fetchCardById(
  supabase: ReturnType<typeof createServiceRoleClient>,
  cardId: string
): Promise<CardRow | null> {
  try {
    const { data, error } = await supabase
      .from("cards")
      .select("id, name, set_name, card_number, language, variant, variant_detail")
      .eq("id", cardId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data as CardRow | null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("variant") && !message.includes("language")) throw err;

    const { data, error } = await supabase
      .from("cards")
      .select("id, name, set_name, card_number")
      .eq("id", cardId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    return { ...data, language: null, variant: null, variant_detail: null } as CardRow;
  }
}

/**
 * All the per-card work that turns raw market_sales rows into a single
 * BuySignal: picking the best grader, applying the min-sales and
 * graded/raw-ratio data-quality gates, and building the display fields.
 * Extracted so getBuySignalForCard() (used by the price-alert email API,
 * app/api/buy-signals/[cardId]/route.ts) can compute one card's signal
 * without getBuySignals()'s full-table fetch and pass over every card in
 * the DB -- calling the full version per alert would mean fully
 * recomputing ~3,000+ cards' signals just to email one of them.
 */
function buildSignalForCard(
  cardId: string,
  card: CardRow,
  cardSales: MarketSaleRow[],
  gemRatesByCardGrader: Map<string, GemRateRow[]>,
  latestGemRateByCardGrader: Map<string, GemRateRow>
): BuySignal | null {
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

  if (!best) return null;

  if (best.saleCount < MIN_SALES_FOR_SIGNAL) {
    return null; // too few sales to trust this card's price estimate at all
  }

  if (!best.isRawPriceEstimated && best.rawMarketPrice > 0) {
    const gradedToRawRatio = best.topGradePrice / best.rawMarketPrice;
    if (gradedToRawRatio > MAX_GRADED_TO_RAW_RATIO) {
      console.warn(
        `[buySignals] Excluding '${card.name}' (${card.set_name}) as unverified data: ` +
          `${best.targetGradeLabel} avg $${Math.round(best.topGradePrice)} is ` +
          `${gradedToRawRatio.toFixed(0)}x the real raw price $${Math.round(best.rawMarketPrice)}. ` +
          `Review market_sales for card_id=${cardId} before re-including.`
      );
      return null;
    }
  }

  const graderConfig = GRADERS.find((g) => g.id === best!.grader)!;
  const { gemRatePct, isGemRateImplied } = best;
  const gapDollars = best.topGradePrice - best.rawMarketPrice;
  const { trend, gradedPriceChangePct } = computeTrend(best.topSalesRows, rawSales);
  const dataQualityScore = computeDataQualityScore({
    saleCount: best.saleCount,
    recentSaleCount90d: best.recentSaleCount90d,
    isRawPriceEstimated: best.isRawPriceEstimated,
    topSalePrices: best.topSalesRows.map((s) => s.sale_price),
  });

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

  return {
    cardId,
    cardName: card.name,
    setName: card.set_name,
    cardNumber: card.card_number,
    language: card.language ?? "English",
    variant: card.variant ?? "Normal",
    variantDetail: card.variant_detail,
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
      isGemRateImplied,
      targetGradeLabel: best.targetGradeLabel,
      gapDollars,
      graderName: `${graderConfig.name} ${graderConfig.tier}`,
      fee: graderConfig.fee,
      expectedRoiPct: Math.round(best.roiPct * 10) / 10,
    }),
    expectedRoiPct: Math.round(best.roiPct * 10) / 10,
    maxBuyPrice: best.maxBuyPrice,
    gemRatePct,
    isGemRateImplied,
    rawMarketPrice: Math.round(best.rawMarketPrice * 100) / 100,
    isRawPriceEstimated: best.isRawPriceEstimated,
    topGradePrice: Math.round(best.topGradePrice * 100) / 100,
    gapDollars: Math.round(gapDollars * 100) / 100,
    tier1Price: best.tier1Price !== null ? Math.round(best.tier1Price * 100) / 100 : null,
    tier1RoiPct: best.tier1RoiPct,
    tier1MaxBuyPrice: best.tier1MaxBuyPrice,
    tier2Price: best.tier2Price !== null ? Math.round(best.tier2Price * 100) / 100 : null,
    tier2RoiPct: best.tier2RoiPct,
    tier2MaxBuyPrice: best.tier2MaxBuyPrice,
    saleCount: best.saleCount,
    recentSaleCount90d: best.recentSaleCount90d,
    priceConfidence: confidenceFor(best.recentSaleCount90d),
    lastSaleDate: best.lastSaleDate,
    recentSales,
    trend,
    gradedPriceChangePct,
    dataQualityScore,
  };
}

function latestGemRateMap(gemRateRows: GemRateRow[]): {
  gemRatesByCardGrader: Map<string, GemRateRow[]>;
  latestGemRateByCardGrader: Map<string, GemRateRow>;
} {
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

  return { gemRatesByCardGrader, latestGemRateByCardGrader };
}

async function computeBuySignals(): Promise<BuySignal[]> {
  const supabase = createServiceRoleClient();

  const [sales, cards, gemRateRows] = await Promise.all([
    fetchMarketSales(supabase),
    fetchCards(supabase),
    fetchAllRows<GemRateRow>(supabase, "gem_rates", "card_id, grader, total_pop, gem_rate, scraped_at"),
  ]);

  const cardById = new Map(cards.map((c) => [c.id, c]));
  const salesByCard = groupBy(sales, (s) => s.card_id);
  const { gemRatesByCardGrader, latestGemRateByCardGrader } = latestGemRateMap(gemRateRows);

  const signals: BuySignal[] = [];

  for (const [cardId, cardSales] of salesByCard.entries()) {
    const card = cardById.get(cardId);
    if (!card) continue;

    const signal = buildSignalForCard(cardId, card, cardSales, gemRatesByCardGrader, latestGemRateByCardGrader);
    if (signal) signals.push(signal);
  }

  signals.sort((a, b) => b.iqScore - a.iqScore);
  return signals;
}

/**
 * Cached for an hour via Next's Data Cache (unstable_cache) -- computeBuySignals()
 * does a full pass over market_sales (1.8M+ rows and growing ~18k/day),
 * even after parallelizing fetchAllRows()'s pagination, so actually
 * running it on every request is what made the Buy Signals page time
 * out in production. Only the first request after each hour (or after
 * this table's next relevant write, if a tag-based revalidation gets
 * added later) pays that cost; Next serves the prior cached result while
 * refreshing in the background otherwise (stale-while-revalidate), so a
 * real user request essentially never blocks on it once the cache is warm.
 */
export const getBuySignals = unstable_cache(computeBuySignals, ["buy-signals"], {
  revalidate: 3600,
});

/**
 * Same computation as getBuySignals(), scoped to a single card -- used by
 * app/api/buy-signals/[cardId]/route.ts so the price-alert email job can
 * pull one card's IQ score/ROI/max-buy-price without recomputing every
 * card in the DB (see buildSignalForCard()'s docstring).
 */
export async function getBuySignalForCard(cardId: string): Promise<BuySignal | null> {
  const supabase = createServiceRoleClient();

  const card = await fetchCardById(supabase, cardId);
  if (!card) return null;

  const [cardSales, gemRateResult] = await Promise.all([
    fetchSalesForCard(supabase, cardId),
    supabase.from("gem_rates").select("card_id, grader, total_pop, gem_rate, scraped_at").eq("card_id", cardId),
  ]);

  const { gemRatesByCardGrader, latestGemRateByCardGrader } = latestGemRateMap(
    (gemRateResult.data ?? []) as GemRateRow[]
  );

  return buildSignalForCard(cardId, card, cardSales, gemRatesByCardGrader, latestGemRateByCardGrader);
}
