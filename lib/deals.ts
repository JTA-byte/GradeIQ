/**
 * Deals data layer for app/deals/page.tsx.
 *
 * Two independent sources of "underpriced" signals:
 *  - Active deals: rows in `active_listings` already flagged is_deal=true
 *    by python-services/jobs/scan_active_listings.py (and the nightly
 *    price scrape) at scrape time, by comparing current_price against
 *    the card's max_buy_price from the same internal buy-signals API
 *    this app itself exposes. This page re-fetches each flagged
 *    listing's IQ score/ROI% fresh via getBuySignalForCard() rather than
 *    trusting a stale copy, since Buy Signals data changes as more sales
 *    get scraped -- is_deal itself, though, is left as computed at
 *    scrape time rather than re-verified here, since re-deriving it
 *    would just be re-running the same comparison the scraper already did.
 *  - Recent raw deals: real raw (ungraded) sales from market_sales in
 *    the last 30 days that sold below the card's current max_buy_price
 *    -- these are FYI/context ("here's what this opportunity looked like
 *    recently"), not something actionable today since the sale already
 *    happened.
 */
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getBuySignalForCard } from "./buySignals";

// active_listings rows older than this are treated as stale (the
// listing may have sold, ended, or stopped being surfaced by Alt's
// search) and excluded, rather than actively deleted -- see
// supabase/schema.sql's comment on the table. 18 hours gives slack for
// a missed or delayed run of the 6-hourly scan_active_listings.py.
const ACTIVE_LISTING_FRESHNESS_HOURS = 18;

const RECENT_RAW_DEAL_WINDOW_DAYS = 30;

// getRecentRawDeals() does one getBuySignalForCard() call per unique
// card among matching raw sales -- with potentially hundreds of raw
// sales across 30 days, that's hundreds of individual round trips fanned
// out via Promise.all. Capping the query keeps that fan-out (and the
// page's load time) bounded; the most recent sales are what a "recent
// deals" section should show first anyway.
const RECENT_RAW_SALE_SCAN_LIMIT = 300;

export interface ActiveDeal {
  listingId: string;
  cardId: string;
  cardName: string;
  setName: string;
  cardNumber: string | null;
  grader: string;
  grade: string;
  currentPrice: number;
  maxBuyPrice: number;
  discountAmount: number;
  discountPct: number;
  listingUrl: string;
  auctionEndTime: string | null;
  iqScore: number;
  expectedRoiPct: number;
  bestGraderName: string;
}

export interface RecentRawDeal {
  cardId: string;
  cardName: string;
  setName: string;
  cardNumber: string | null;
  soldPrice: number;
  maxBuyPrice: number;
  savingsAmount: number;
  savingsPct: number;
  saleDate: string;
  sourceLabel: string;
  sourceUrl: string | null;
  iqScore: number;
  expectedRoiPct: number;
  bestGraderName: string;
}

interface ActiveListingRow {
  id: string;
  card_id: string;
  listing_url: string;
  current_price: number;
  auction_end_time: string | null;
  grader: string;
  grade: string;
  deal_discount_amount: number | null;
}

interface RawSaleRow {
  card_id: string;
  sale_price: number;
  sale_date: string;
  source: string;
  source_url: string | null;
}

interface CardLookupRow {
  id: string;
  name: string;
  set_name: string;
  card_number: string | null;
}

const SOURCE_DISPLAY: Record<string, string> = {
  ebay_sold: "eBay",
  alt: "Alt.xyz",
  pricecharting: "PriceCharting",
};

/**
 * Fetches active_listings flagged as deals, tolerating the table not
 * existing yet -- it's added in supabase/schema.sql but, per this
 * project's convention, applied to the live DB by hand.
 */
async function fetchDealListings(
  supabase: ReturnType<typeof createServiceRoleClient>
): Promise<ActiveListingRow[]> {
  const freshnessCutoff = new Date(Date.now() - ACTIVE_LISTING_FRESHNESS_HOURS * 60 * 60 * 1000).toISOString();

  try {
    const { data, error } = await supabase
      .from("active_listings")
      .select("id, card_id, listing_url, current_price, auction_end_time, grader, grade, deal_discount_amount")
      .eq("is_deal", true)
      .gte("scraped_at", freshnessCutoff)
      .or(`auction_end_time.is.null,auction_end_time.gt.${new Date().toISOString()}`)
      .order("deal_discount_amount", { ascending: false });

    if (error) throw new Error(error.message);
    return (data ?? []) as ActiveListingRow[];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("active_listings")) throw err;

    console.warn(
      "[deals] active_listings doesn't exist yet -- returning no active deals. " +
        "Run the migration in supabase/schema.sql to enable this."
    );
    return [];
  }
}

async function fetchCardsByIds(
  supabase: ReturnType<typeof createServiceRoleClient>,
  cardIds: string[]
): Promise<Map<string, CardLookupRow>> {
  if (cardIds.length === 0) return new Map();

  const { data, error } = await supabase
    .from("cards")
    .select("id, name, set_name, card_number")
    .in("id", cardIds);

  if (error) throw new Error(`Failed to fetch cards: ${error.message}`);
  return new Map((data as CardLookupRow[] | null ?? []).map((c: CardLookupRow) => [c.id, c]));
}

export async function getActiveDeals(): Promise<ActiveDeal[]> {
  const supabase = createServiceRoleClient();

  const listings = await fetchDealListings(supabase);
  if (listings.length === 0) return [];

  const cardIds = [...new Set(listings.map((l) => l.card_id))];
  const [cardsById, signalsById] = await Promise.all([
    fetchCardsByIds(supabase, cardIds),
    (async () => {
      const signals = await Promise.all(cardIds.map((id) => getBuySignalForCard(id)));
      return new Map(cardIds.map((id, i) => [id, signals[i]]));
    })(),
  ]);

  const deals: ActiveDeal[] = [];
  for (const listing of listings) {
    const card = cardsById.get(listing.card_id);
    const signal = signalsById.get(listing.card_id);
    // A listing can be flagged a deal at scrape time and then lose its
    // Buy Signal by the time this page loads (e.g. the card's data
    // quality gate trips) -- skip rather than show a deal with no
    // current signal to back it up.
    if (!card || !signal) continue;

    const discountAmount = listing.deal_discount_amount ?? signal.maxBuyPrice - listing.current_price;
    if (discountAmount <= 0) continue;

    deals.push({
      listingId: listing.id,
      cardId: listing.card_id,
      cardName: card.name,
      setName: card.set_name,
      cardNumber: card.card_number,
      grader: listing.grader,
      grade: listing.grade,
      currentPrice: listing.current_price,
      maxBuyPrice: signal.maxBuyPrice,
      discountAmount: Math.round(discountAmount * 100) / 100,
      discountPct: Math.round((discountAmount / signal.maxBuyPrice) * 1000) / 10,
      listingUrl: listing.listing_url,
      auctionEndTime: listing.auction_end_time,
      iqScore: signal.iqScore,
      expectedRoiPct: signal.expectedRoiPct,
      bestGraderName: signal.bestGraderName,
    });
  }

  deals.sort((a, b) => b.discountAmount - a.discountAmount);
  return deals;
}

export async function getRecentRawDeals(): Promise<RecentRawDeal[]> {
  const supabase = createServiceRoleClient();

  const windowCutoff = new Date(
    Date.now() - RECENT_RAW_DEAL_WINDOW_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  const { data, error } = await supabase
    .from("market_sales")
    .select("card_id, sale_price, sale_date, source, source_url")
    .eq("grade", "Raw")
    .gte("sale_date", windowCutoff)
    .order("sale_date", { ascending: false })
    .limit(RECENT_RAW_SALE_SCAN_LIMIT);

  if (error) {
    // This query needs idx_market_sales_raw_recent (supabase/schema.sql)
    // to run fast -- without it, filtering by grade+sale_date across
    // every card (no card_id in the WHERE clause) can't use the
    // existing card_id-first index and hits a full table scan.
    // Confirmed live: exactly this timed out before that index existed.
    // Degrade to an empty list rather than take down the whole Deals
    // page over one section's slow query.
    console.warn(`[deals] Recent raw deals query failed, showing none: ${error.message}`);
    return [];
  }

  const rawSales = (data ?? []) as RawSaleRow[];
  if (rawSales.length === 0) return [];

  const cardIds = [...new Set(rawSales.map((s) => s.card_id))];
  const [cardsById, signalsById] = await Promise.all([
    fetchCardsByIds(supabase, cardIds),
    (async () => {
      const signals = await Promise.all(cardIds.map((id) => getBuySignalForCard(id)));
      return new Map(cardIds.map((id, i) => [id, signals[i]]));
    })(),
  ]);

  const deals: RecentRawDeal[] = [];
  for (const sale of rawSales) {
    const card = cardsById.get(sale.card_id);
    const signal = signalsById.get(sale.card_id);
    if (!card || !signal) continue;

    const savingsAmount = signal.maxBuyPrice - sale.sale_price;
    if (savingsAmount <= 0) continue;

    deals.push({
      cardId: sale.card_id,
      cardName: card.name,
      setName: card.set_name,
      cardNumber: card.card_number,
      soldPrice: sale.sale_price,
      maxBuyPrice: signal.maxBuyPrice,
      savingsAmount: Math.round(savingsAmount * 100) / 100,
      savingsPct: Math.round((savingsAmount / signal.maxBuyPrice) * 1000) / 10,
      saleDate: sale.sale_date,
      sourceLabel: SOURCE_DISPLAY[sale.source] ?? sale.source,
      sourceUrl: sale.source_url,
      iqScore: signal.iqScore,
      expectedRoiPct: signal.expectedRoiPct,
      bestGraderName: signal.bestGraderName,
    });
  }

  deals.sort((a, b) => new Date(b.saleDate).getTime() - new Date(a.saleDate).getTime());
  return deals;
}
