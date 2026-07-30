/**
 * Reads pre-computed Buy Signals from buy_signals_cache instead of
 * recomputing them live from market_sales (lib/buySignals.ts's
 * getBuySignals()) on every page load -- that full recompute was what
 * timed out the Buy Signals page in production. The cache is refreshed
 * nightly by app/api/internal/refresh-buy-signals-cache (see its
 * docstring and supabase/schema.sql's buy_signals_cache comment for the
 * full story); this module just reads it back out.
 */
import { createServiceRoleClient } from "@/lib/supabase/server";
import type { BuySignal, PriceConfidence, PriceTrend, RecentSaleDisplay } from "./buySignals";
import type { GraderId } from "./roiEngine";
import type { IQScoreLabel } from "./iqScore";

const PAGE_SIZE = 1000;

interface BuySignalCacheRow {
  card_id: string;
  card_name: string;
  set_name: string;
  card_number: string | null;
  language: string;
  variant: string;
  variant_detail: string | null;
  iq_score: number;
  iq_label: string;
  iq_reason: string;
  why_reason: string;
  roi_percent: number;
  max_buy_price: number;
  best_grader: string;
  best_grader_name: string;
  target_grade: string;
  raw_price: number;
  is_raw_price_estimated: boolean;
  top_grade_price: number;
  gap_amount: number;
  implied_gem_rate: number;
  is_gem_rate_implied: boolean;
  sale_count: number;
  recent_sale_count_90d: number;
  last_sale_date: string | null;
  price_confidence: string;
  recent_sales: RecentSaleDisplay[];
  trend: string;
  graded_price_change_pct: number | null;
  data_quality_score: number;
  computed_at: string;
}

export interface CachedBuySignalsResult {
  signals: BuySignal[];
  lastUpdated: string | null; // most recent computed_at across the cache; null if empty/missing
}

function fromCacheRow(row: BuySignalCacheRow): BuySignal {
  return {
    cardId: row.card_id,
    cardName: row.card_name,
    setName: row.set_name,
    cardNumber: row.card_number,
    language: row.language,
    variant: row.variant,
    variantDetail: row.variant_detail,
    bestGrader: row.best_grader as GraderId,
    bestGraderName: row.best_grader_name,
    targetGradeLabel: row.target_grade,
    iqScore: row.iq_score,
    iqLabel: row.iq_label as IQScoreLabel,
    iqReason: row.iq_reason,
    whyReason: row.why_reason,
    expectedRoiPct: row.roi_percent,
    maxBuyPrice: row.max_buy_price,
    gemRatePct: row.implied_gem_rate,
    isGemRateImplied: row.is_gem_rate_implied,
    rawMarketPrice: row.raw_price,
    isRawPriceEstimated: row.is_raw_price_estimated,
    topGradePrice: row.top_grade_price,
    gapDollars: row.gap_amount,
    saleCount: row.sale_count,
    recentSaleCount90d: row.recent_sale_count_90d,
    priceConfidence: row.price_confidence as PriceConfidence,
    lastSaleDate: row.last_sale_date,
    recentSales: row.recent_sales ?? [],
    trend: row.trend as PriceTrend,
    gradedPriceChangePct: row.graded_price_change_pct,
    dataQualityScore: row.data_quality_score,
  };
}

async function fetchAllCacheRows(
  supabase: ReturnType<typeof createServiceRoleClient>
): Promise<BuySignalCacheRow[]> {
  // Plain offset pagination is fine here -- buy_signals_cache has one
  // row per card (a few thousand at most), nowhere near the scale where
  // OFFSET's depth penalty becomes a problem (see lib/buySignals.ts's
  // fetchAllRows() for where that actually mattered, on market_sales'
  // 1.8M+ rows).
  const all: BuySignalCacheRow[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from("buy_signals_cache")
      .select("*")
      .order("iq_score", { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) throw new Error(`Failed to fetch buy_signals_cache: ${error.message}`);
    if (!data || data.length === 0) break;

    all.push(...(data as BuySignalCacheRow[]));
    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return all;
}

/**
 * Tolerates buy_signals_cache not existing yet -- it's added in
 * supabase/schema.sql but, per this project's convention, applied to
 * the live DB by hand, and this query runs on every Buy Signals page
 * load. Falls back to an empty result rather than crashing the page.
 */
export async function getCachedBuySignals(): Promise<CachedBuySignalsResult> {
  const supabase = createServiceRoleClient();

  try {
    const rows = await fetchAllCacheRows(supabase);
    const signals = rows.map(fromCacheRow);
    const lastUpdated = rows.reduce<string | null>(
      (latest, r) => (!latest || r.computed_at > latest ? r.computed_at : latest),
      null
    );
    return { signals, lastUpdated };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("buy_signals_cache")) throw err;

    console.warn(
      "[buySignalsCache] buy_signals_cache doesn't exist yet -- returning no signals. " +
        "Run the migration in supabase/schema.sql, then trigger " +
        "python-services/jobs/compute_buy_signals.py (or POST " +
        "/api/internal/refresh-buy-signals-cache directly) to populate it."
    );
    return { signals: [], lastUpdated: null };
  }
}
