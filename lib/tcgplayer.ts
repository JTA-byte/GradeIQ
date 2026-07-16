/**
 * TCGPlayer API client for raw (ungraded) market pricing.
 *
 * Auth: OAuth2 client_credentials against POST https://api.tcgplayer.com/token
 * using TCGPLAYER_API_KEY (public key / client_id) and TCGPLAYER_API_SECRET
 * (private key / client_secret). The returned bearer token is valid for
 * ~14 days (`expires_in` seconds), so it's cached in module scope rather
 * than re-fetched on every call.
 *
 * Scope limitation: TCGPlayer's catalog only lists raw/ungraded product
 * listings -- it has no concept of "PSA 10 price" or "CGC 9.5 price".
 * Graded-card pricing (topGradePrice/midGradePrice in CardMarketData) has
 * no TCGPlayer source and stays mock/placeholder data regardless of
 * whether these keys are configured -- see lib/mockDataService.ts.
 *
 * "Recent sold" data was part of the original ask, but TCGPlayer's
 * documented partner API has no sales-history/recently-sold endpoint.
 * The feed shown on tcgplayer.com's own site is served by an internal,
 * undocumented endpoint that isn't part of the public partner API and
 * isn't reliable or sanctioned for third-party use, so this client does
 * not attempt it -- `recentSales` is always null until TCGPlayer offers
 * this officially.
 *
 * Caching: results are cached in the `market_prices` table (source =
 * 'tcgplayer', condition = 'raw') for CACHE_TTL_HOURS, keyed off a
 * `cards` row resolved/created by name. The resolved TCGPlayer product ID
 * is persisted onto `cards.tcgplayer_product_id` so repeat lookups skip
 * the product-search call and go straight to a pricing call.
 *
 * getGradedSalePrices() closes the graded-pricing gap described above --
 * not from TCGPlayer, but from the `market_sales` table populated by the
 * Python scrapers in python-services/scrapers/ (130point, PriceCharting,
 * Alt). This is the real source of topGradePrice/midGradePrice now;
 * mock data is only used when no recent sales exist for a card.
 */
import { createServiceRoleClient } from "@/lib/supabase/server";

const TOKEN_URL = "https://api.tcgplayer.com/token";
const API_BASE = "https://api.tcgplayer.com";
const POKEMON_CATEGORY_ID = 3;
const CACHE_TTL_HOURS = 24;

export interface TCGPlayerRawPricing {
  marketPrice: number | null;
  lowPrice: number | null;
  midPrice: number | null;
  highPrice: number | null;
  recentSales: null; // not available via TCGPlayer's documented partner API -- see file header
}

let cachedToken: { accessToken: string; expiresAt: number } | null = null;

function isConfigured(): boolean {
  return !!(process.env.TCGPLAYER_API_KEY && process.env.TCGPLAYER_API_SECRET);
}

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.accessToken;
  }

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.TCGPLAYER_API_KEY ?? "",
      client_secret: process.env.TCGPLAYER_API_SECRET ?? "",
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`TCGPlayer token request failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  cachedToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return cachedToken.accessToken;
}

async function searchProductIdByName(cardName: string, token: string): Promise<number | null> {
  const response = await fetch(`${API_BASE}/catalog/categories/${POKEMON_CATEGORY_ID}/search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      sort: "Relevance",
      limit: 1,
      offset: 0,
      filters: [{ name: "ProductName", values: [cardName] }],
    }),
  });

  if (!response.ok) {
    throw new Error(`TCGPlayer product search failed (${response.status})`);
  }

  const data = await response.json();
  const productId = data.results?.[0];
  return typeof productId === "number" ? productId : null;
}

async function fetchProductPricing(
  productId: number,
  token: string
): Promise<TCGPlayerRawPricing | null> {
  const response = await fetch(`${API_BASE}/pricing/product/${productId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`TCGPlayer pricing request failed (${response.status})`);
  }

  const data = await response.json();
  const result = data.results?.[0];
  if (!result) return null;

  return {
    marketPrice: result.marketPrice ?? null,
    lowPrice: result.lowPrice ?? null,
    midPrice: result.midPrice ?? null,
    highPrice: result.highPrice ?? null,
    recentSales: null,
  };
}

interface CardRow {
  id: string;
  tcgplayerProductId: number | null;
}

async function getOrCreateCard(cardName: string): Promise<CardRow> {
  const supabase = createServiceRoleClient();

  const { data: existing } = await supabase
    .from("cards")
    .select("id, tcgplayer_product_id")
    .ilike("name", cardName)
    .limit(1)
    .maybeSingle();

  if (existing) {
    return {
      id: existing.id,
      tcgplayerProductId: existing.tcgplayer_product_id ? Number(existing.tcgplayer_product_id) : null,
    };
  }

  // set_name is required by the schema but we only have a free-text card
  // name from the analyze form -- "Unknown" is a placeholder until the
  // app collects set/number too.
  const { data: created, error } = await supabase
    .from("cards")
    .insert({ name: cardName, set_name: "Unknown" })
    .select("id, tcgplayer_product_id")
    .single();

  if (error || !created) {
    throw new Error(`Could not find or create a cards row for "${cardName}": ${error?.message}`);
  }

  return { id: created.id, tcgplayerProductId: null };
}

async function saveResolvedProductId(cardId: string, productId: number): Promise<void> {
  const supabase = createServiceRoleClient();
  await supabase.from("cards").update({ tcgplayer_product_id: String(productId) }).eq("id", cardId);
}

async function getCachedPrice(cardId: string): Promise<TCGPlayerRawPricing | null> {
  const supabase = createServiceRoleClient();
  const cutoff = new Date(Date.now() - CACHE_TTL_HOURS * 60 * 60 * 1000).toISOString();

  const { data } = await supabase
    .from("market_prices")
    .select("price, recorded_at")
    .eq("card_id", cardId)
    .eq("source", "tcgplayer")
    .eq("condition", "raw")
    .gte("recorded_at", cutoff)
    .order("recorded_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) return null;

  return {
    marketPrice: data.price,
    lowPrice: null,
    midPrice: null,
    highPrice: null,
    recentSales: null,
  };
}

async function cachePrice(cardId: string, pricing: TCGPlayerRawPricing): Promise<void> {
  if (pricing.marketPrice === null) return;
  const supabase = createServiceRoleClient();
  await supabase.from("market_prices").insert({
    card_id: cardId,
    source: "tcgplayer",
    condition: "raw",
    price: pricing.marketPrice,
  });
}

/**
 * Looks up raw (ungraded) market pricing for a card by name, using the
 * Supabase cache first. Returns null if TCGPLAYER_API_KEY/SECRET aren't
 * set, or if the lookup fails/finds nothing -- callers should fall back
 * to mock data in either case.
 */
export async function getTCGPlayerRawPricing(cardName: string): Promise<TCGPlayerRawPricing | null> {
  if (!isConfigured()) return null;

  let card: CardRow;
  try {
    card = await getOrCreateCard(cardName);
  } catch (err) {
    console.error("[tcgplayer] could not resolve cards row:", err);
    return null;
  }

  const cached = await getCachedPrice(card.id);
  if (cached) {
    console.log("[tcgplayer] cache hit for", cardName);
    return cached;
  }

  try {
    const token = await getAccessToken();

    let productId = card.tcgplayerProductId;
    if (!productId) {
      productId = await searchProductIdByName(cardName, token);
      if (productId) {
        await saveResolvedProductId(card.id, productId);
      }
    }

    if (!productId) {
      console.log("[tcgplayer] no product match for", cardName);
      return null;
    }

    const pricing = await fetchProductPricing(productId, token);
    if (!pricing) return null;

    await cachePrice(card.id, pricing);
    console.log("[tcgplayer] live lookup succeeded for", cardName, "-> marketPrice", pricing.marketPrice);
    return pricing;
  } catch (err) {
    console.error("[tcgplayer] live pricing lookup failed for", cardName, ":", err);
    return null;
  }
}

export interface GradedSalePrices {
  topGradePrice: number | null; // recent PSA 10 sale average, if any
  midGradePrice: number | null; // recent PSA 9 sale average, if any
}

const SALE_LOOKBACK_DAYS = 90;
const SALE_SAMPLE_SIZE = 5;

async function averageRecentSalePrice(
  cardId: string,
  grader: string,
  grade: string
): Promise<number | null> {
  const supabase = createServiceRoleClient();
  const cutoff = new Date(Date.now() - SALE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data } = await supabase
    .from("market_sales")
    .select("sale_price")
    .eq("card_id", cardId)
    .eq("grader", grader)
    .eq("grade", grade)
    .gte("sale_date", cutoff)
    .order("sale_date", { ascending: false })
    .limit(SALE_SAMPLE_SIZE);

  if (!data || data.length === 0) return null;

  const prices: number[] = data.map((row: { sale_price: number }) => row.sale_price);
  return prices.reduce((sum, price) => sum + price, 0) / prices.length;
}

/**
 * Looks up real graded-card sale prices from `market_sales` (populated by
 * the Python scrapers, not TCGPlayer). Averages up to the 5 most recent
 * PSA 10 / PSA 9 sales within the last 90 days to smooth out single-sale
 * outliers. Returns null for whichever grade has no recent sales --
 * callers should fall back to mock data for those.
 */
export async function getGradedSalePrices(cardName: string): Promise<GradedSalePrices> {
  let card: CardRow;
  try {
    card = await getOrCreateCard(cardName);
  } catch (err) {
    console.error("[tcgplayer] could not resolve cards row for graded sales:", err);
    return { topGradePrice: null, midGradePrice: null };
  }

  const [topGradePrice, midGradePrice] = await Promise.all([
    averageRecentSalePrice(card.id, "PSA", "10"),
    averageRecentSalePrice(card.id, "PSA", "9"),
  ]);

  console.log(
    "[tcgplayer] graded sale lookup for",
    cardName,
    "-> PSA10:",
    topGradePrice,
    "| PSA9:",
    midGradePrice
  );

  return { topGradePrice, midGradePrice };
}
