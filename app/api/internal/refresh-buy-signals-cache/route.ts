/**
 * POST /api/internal/refresh-buy-signals-cache
 *
 * Internal, service-to-service endpoint -- triggered nightly (2am UTC)
 * by python-services/jobs/compute_buy_signals.py via GitHub Actions.
 * Runs getBuySignals() (lib/buySignals.ts's real, tested ROI/IQ engine)
 * and writes its output into buy_signals_cache, which
 * app/buy-signals/page.tsx reads directly instead of recomputing on
 * every request -- that full recompute (a pass over 1.8M+ market_sales
 * rows) is what was timing out the Buy Signals page in production.
 *
 * Deliberately calls the EXISTING TypeScript computation rather than
 * reimplementing ROI/IQ math in Python for the nightly job -- a second
 * implementation would be a second place for that logic to drift out of
 * sync, same reasoning as check_price_alerts.py and
 * scan_active_listings.py calling into this app over HTTP instead of
 * duplicating its math.
 *
 * Gated on a shared secret (INTERNAL_API_KEY), same as
 * app/api/buy-signals/[cardId]/route.ts, since the caller is a GitHub
 * Actions cron job with no user session.
 */
import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getBuySignals, type BuySignal } from "@/lib/buySignals";

// getBuySignals() does a full pass over market_sales -- generous, since
// how long that takes depends on how much of the known duplicate-row
// bloat (see supabase/deduplicate_market_sales.py) has been cleaned up
// on the live DB. Requires a Vercel plan that supports a maxDuration
// this long; lower it once the underlying computation is reliably fast.
export const maxDuration = 300;

const UPSERT_CHUNK_SIZE = 500;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function toCacheRow(signal: BuySignal, computedAt: string) {
  return {
    card_id: signal.cardId,
    card_name: signal.cardName,
    set_name: signal.setName,
    card_number: signal.cardNumber,
    language: signal.language,
    variant: signal.variant,
    variant_detail: signal.variantDetail,
    iq_score: signal.iqScore,
    iq_label: signal.iqLabel,
    iq_reason: signal.iqReason,
    why_reason: signal.whyReason,
    roi_percent: signal.expectedRoiPct,
    max_buy_price: signal.maxBuyPrice,
    best_grader: signal.bestGrader,
    best_grader_name: signal.bestGraderName,
    target_grade: signal.targetGradeLabel,
    raw_price: signal.rawMarketPrice,
    is_raw_price_estimated: signal.isRawPriceEstimated,
    top_grade_price: signal.topGradePrice,
    gap_amount: signal.gapDollars,
    implied_gem_rate: signal.gemRatePct,
    is_gem_rate_implied: signal.isGemRateImplied,
    sale_count: signal.saleCount,
    recent_sale_count_90d: signal.recentSaleCount90d,
    last_sale_date: signal.lastSaleDate,
    price_confidence: signal.priceConfidence,
    recent_sales: signal.recentSales,
    trend: signal.trend,
    graded_price_change_pct: signal.gradedPriceChangePct,
    data_quality_score: signal.dataQualityScore,
    computed_at: computedAt,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function POST(request: NextRequest) {
  const expectedKey = process.env.INTERNAL_API_KEY;
  if (!expectedKey) {
    return NextResponse.json({ error: "INTERNAL_API_KEY not configured" }, { status: 503 });
  }
  if (request.headers.get("x-internal-api-key") !== expectedKey) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const supabase = createServiceRoleClient();
    const signals = await getBuySignals();
    const computedAt = new Date().toISOString();
    const currentCardIds = new Set(signals.map((s) => s.cardId));

    // Remove cache rows for cards that no longer qualify for a signal
    // (e.g. tripped MAX_GRADED_TO_RAW_RATIO or dropped below
    // MIN_SALES_FOR_SIGNAL since the last refresh) -- otherwise they'd
    // linger in the cache forever since upsert only touches cards
    // that ARE in the current result.
    const { data: existingRows, error: existingError } = await supabase
      .from("buy_signals_cache")
      .select("card_id");
    if (existingError) throw new Error(`Failed to read existing cache: ${existingError.message}`);

    const staleCardIds = (existingRows ?? [])
      .map((r: { card_id: string }) => r.card_id)
      .filter((id: string) => !currentCardIds.has(id));

    for (const batch of chunk(staleCardIds, UPSERT_CHUNK_SIZE)) {
      const { error } = await supabase.from("buy_signals_cache").delete().in("card_id", batch);
      if (error) throw new Error(`Failed to remove stale cache rows: ${error.message}`);
    }

    const rows = signals.map((s) => toCacheRow(s, computedAt));
    for (const batch of chunk(rows, UPSERT_CHUNK_SIZE)) {
      const { error } = await supabase.from("buy_signals_cache").upsert(batch, { onConflict: "card_id" });
      if (error) throw new Error(`Failed to upsert cache rows: ${error.message}`);
    }

    return NextResponse.json({
      refreshed: signals.length,
      removed: staleCardIds.length,
      computedAt,
    });
  } catch (err) {
    return NextResponse.json({ error: `Unexpected server error: ${errorMessage(err)}` }, { status: 500 });
  }
}
