/**
 * PriceCharting.com client for on-demand raw (ungraded) market pricing.
 *
 * Unlike Alt.xyz (lib/dynamicCardLookup.ts's blocker), PriceCharting's
 * sold-listing data is plain server-rendered HTML, not a JS-rendered SPA
 * -- confirmed live against a real product page (Umbreon VMAX, Evolving
 * Skies #95). That means, uniquely among this app's scrapers, it can run
 * directly inside a Vercel serverless function via `fetch()` instead of
 * needing a Python/Playwright batch job. python-services/scrapers/
 * pricecharting_scraper.py implements the same logic in Python for the
 * nightly batch job that populates `market_sales`; this file is the
 * live, scan-time equivalent.
 *
 * What NOT to use: the price shown at the top of a card page
 * (`#used_price .js-price`) is PriceCharting's own rolling average of
 * recent sales -- unreliable, per direct feedback from a PriceCharting
 * power user. We never read that element. Instead, this scrapes every
 * individual sold listing from the "Ungraded" condition tab
 * (`div.completed-auctions-used`, already present in the static HTML --
 * no JS execution needed) and computes our own 30-day and 90-day median.
 *
 * Caching: results are persisted to `market_prices` (source =
 * 'pricecharting', condition = 'raw') for DB_CACHE_TTL_HOURS, keyed off
 * the caller's cardId -- same pattern as lib/tcgplayer.ts. This matters
 * more here than it does for TCGPlayer: Vercel serverless functions are
 * frequently cold-started per request, so an in-memory-only cache (kept
 * below as a same-instance fast path) provided close to no real caching
 * benefit in production -- nearly every scan was re-scraping PriceCharting
 * live. `sample_size` stores sales30d (or sales90d if that's all there
 * was) so a cache hit can still recompute a confidence label without
 * needing the full sale list.
 */
import { createServiceRoleClient } from "@/lib/supabase/server";
import { CardVariant } from "@/lib/cardVariant";

const BASE_URL = "https://www.pricecharting.com";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; GradeIQ-Bot/1.0; +https://gradeiq.app/bot-info)",
};

const DAY_MS = 24 * 60 * 60 * 1000;
const LOW_VOLUME_THRESHOLD = 5; // fewer than this many sales in 90 days -> "low" confidence
const HIGH_CONFIDENCE_THRESHOLD = 10; // 10+ sales in 30 days -> "high" confidence
const IN_MEMORY_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour -- same-instance fast path only
const DB_CACHE_TTL_HOURS = 24;
const ROBOTS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type PriceConfidence = "high" | "medium" | "low";

export interface PriceChartingRawPricing {
  median30d: number | null;
  median90d: number | null;
  sales30d: number;
  sales90d: number;
  confidence: PriceConfidence;
  primaryPrice: number | null; // 30-day median, falling back to the 90-day median
}

let robotsCache: { disallowedPaths: string[]; fetchedAt: number } | null = null;

async function isPathAllowed(pathname: string): Promise<boolean> {
  const now = Date.now();
  if (!robotsCache || now - robotsCache.fetchedAt > ROBOTS_CACHE_TTL_MS) {
    try {
      const res = await fetch(`${BASE_URL}/robots.txt`, { headers: HEADERS });
      const text = res.ok ? await res.text() : "";
      const disallowedPaths = text
        .split("\n")
        .filter((line) => line.trim().toLowerCase().startsWith("disallow:"))
        .map((line) => line.slice(line.indexOf(":") + 1).trim())
        .filter(Boolean);
      robotsCache = { disallowedPaths, fetchedAt: now };
    } catch {
      // robots.txt unreachable -- proceed cautiously rather than blocking
      // every lookup, matching check_robots_allowed()'s behavior in
      // python-services/scrapers/base_scraper.py.
      robotsCache = { disallowedPaths: [], fetchedAt: now };
    }
  }
  return !robotsCache.disallowedPaths.some((path) => pathname.startsWith(path));
}

async function findProductUrl(query: string): Promise<string | null> {
  if (!(await isPathAllowed("/search-products"))) return null;

  const searchUrl = `${BASE_URL}/search-products?${new URLSearchParams({ q: query, type: "prices" })}`;
  const res = await fetch(searchUrl, { headers: HEADERS });
  if (!res.ok) return null;

  // For a strong/near-exact match, PriceCharting 302-redirects straight to
  // the product page instead of rendering a search-results list -- `fetch`
  // follows that automatically, so `res.url` is already the product page
  // in that case (confirmed live: searching "Charizard Shadowless" lands
  // on /game/pokemon-base-set/charizard-shadowless-4 directly, with no
  // "<tr id=\"product-...\">" row to parse).
  if (/^https?:\/\/[^/]+\/game\//.test(res.url)) {
    return res.url;
  }

  const html = await res.text();

  // Real search-result row structure (verified live):
  //   <tr id="product-2512907" data-product="2512907">
  //     <td class="title"><a href="https://www.pricecharting.com/game/...">Name</a></td>
  const match = html.match(/<tr id="product-\d+"[\s\S]*?<td class="title">\s*<a href="([^"]+)"/);
  if (!match) return null;

  const href = match[1];
  return href.startsWith("http") ? href : `${BASE_URL}${href}`;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const VARIANT_SLUG_FRAGMENT: Partial<Record<CardVariant, string>> = {
  Holo: "holo",
  "Non-Holo": "non-holo",
  "Reverse Holo": "reverse-holo",
  "First Edition": "1st-edition",
  Shadowless: "shadowless",
};

/**
 * Builds the PriceCharting-style product slug for a card + variant, per
 * the mapping given for this feature (e.g. Shadowless ->
 * "{name}-shadowless-{number}", Stamped -> "{name}-{stamp}-{number}").
 *
 * NOT used to fetch a URL directly -- confirmed live that guessing
 * slugs this way is unreliable: "charizard-holo-4" 404s (redirects to a
 * search page) for Base Set Charizard, which has no separate "holo"
 * slug since the card is already inherently holo with no plain variant.
 * Exported so callers that DO want to try a direct-URL guess as a last
 * resort can build one consistently, but the primary lookup path below
 * instead appends the equivalent human-readable variant term to the
 * *search query* and lets PriceCharting's own search/redirect logic
 * resolve it -- verified live that this correctly disambiguates (e.g.
 * appending "Shadowless" makes the search redirect straight to
 * .../charizard-shadowless-4 instead of landing on the ambiguous
 * unlimited-print listing).
 */
export function buildPriceChartingSlug(
  cardName: string,
  cardNumber: string,
  variant: CardVariant,
  variantDetail?: string
): string {
  const nameSlug = slugify(cardName);
  const numberSlug = slugify(cardNumber);

  if (variant === "Stamped") {
    const stampSlug = variantDetail ? slugify(variantDetail) : "stamped";
    return [nameSlug, stampSlug, numberSlug].filter(Boolean).join("-");
  }
  if (variant === "Promo") {
    return variantDetail ? [nameSlug, slugify(variantDetail)].filter(Boolean).join("-") : `${nameSlug}-promo`;
  }

  const fragment = VARIANT_SLUG_FRAGMENT[variant];
  return [nameSlug, fragment, numberSlug].filter(Boolean).join("-");
}

/**
 * The human-readable word(s) to append to a PriceCharting search query
 * for this variant -- what actually helps their search disambiguate
 * (verified live), as opposed to buildPriceChartingSlug()'s URL-shaped
 * fragment. "Normal"/"No Symbol" have no distinguishing term (the base
 * print with no suffix, or PriceCharting simply doesn't slug it as a
 * separate variant), so those contribute nothing.
 */
function variantSearchTerm(variant: CardVariant, variantDetail?: string): string {
  switch (variant) {
    case "Holo":
      return "Holo";
    case "Non-Holo":
      return "Non-Holo";
    case "Reverse Holo":
      return "Reverse Holo";
    case "First Edition":
      return "1st Edition";
    case "Shadowless":
      return "Shadowless";
    case "Stamped":
      return variantDetail || "Stamped";
    case "Promo":
      return variantDetail || "Promo";
    case "Full Art":
      return "Full Art";
    case "Special Illustration Rare":
      return "Special Illustration Rare";
    case "Hyper Rare":
      return "Hyper Rare";
    case "Secret Rare":
      return "Secret Rare";
    case "Normal":
    case "No Symbol":
    default:
      return "";
  }
}

function extractProductName(html: string): string | null {
  const match = html.match(/id="product_name"[^>]*>\s*([^\n<]+)/);
  return match ? match[1].trim() : null;
}

function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Guards against PriceCharting's own search silently falling back to an
 * unrelated product when it can't find a good match, rather than
 * returning no results -- confirmed live: searching a deliberately fake
 * card name/set/number matched a real but completely unrelated "Scoop
 * Up" trainer card and returned its real (wrong) price with no
 * indication anything was off. Requires at least the card name's first
 * significant word to appear in the matched product's own name -- lax
 * on purpose, since real PriceCharting product names often add
 * parenthetical variant text ("(Alternate Art Secret)") that a stricter
 * check would reject.
 */
function looksLikeMatch(cardName: string, productName: string): boolean {
  const cardWords = normalizeForMatch(cardName)
    .split(" ")
    .filter((w) => w.length > 2);
  if (cardWords.length === 0) return true;
  return normalizeForMatch(productName).includes(cardWords[0]);
}

function extractUngradedTabHtml(html: string): string {
  // Must match the actual `<div class="completed-auctions-used">` that
  // wraps the sold-listing table, not the several other same-page
  // occurrences of this string (a `data-show-tab="completed-auctions-used"`
  // tab-switch control, an `<a name="completed-auctions-used">` anchor,
  // and a `<div class="tab selected completed-auctions-used">` label all
  // appear earlier on a real page and would otherwise be matched first).
  const marker = '<div class="completed-auctions-used"';
  const startIdx = html.indexOf(marker);
  if (startIdx === -1) return "";

  const rest = html.slice(startIdx);
  // The next sibling condition tab's div (e.g. completed-auctions-new)
  // marks the end of this one's sold-listing table.
  const nextTabOffset = rest.slice(marker.length).search(/<div class="completed-auctions-(?!used)/);
  return nextTabOffset === -1 ? rest : rest.slice(0, nextTabOffset + marker.length);
}

function parseRawSales(html: string): { price: number; timestampMs: number }[] {
  const section = extractUngradedTabHtml(html);
  if (!section) return [];

  // The price span's closing `"` isn't always immediately followed by `>`
  // -- eBay-sourced rows render `class="js-price" >` (extra space) or add
  // a `title="..."` attribute, while TCGPlayer-sourced rows render
  // `class="js-price">` with neither. `[^>]*>` covers both. Matching the
  // literal `class="js-price"` (closing quote right after the class name)
  // also deliberately excludes the sibling `listed-price-inline` /
  // `numeric listed-price` price spans PriceCharting shows next to the
  // real sale price on "best offer" rows.
  const rowPattern =
    /<td class="date">(\d{4}-\d{2}-\d{2})<\/td>[\s\S]*?<span class="js-price"[^>]*>\s*\$([\d,]+\.\d{2})/g;
  const sales: { price: number; timestampMs: number }[] = [];

  let match: RegExpExecArray | null;
  while ((match = rowPattern.exec(section)) !== null) {
    const timestampMs = new Date(`${match[1]}T00:00:00Z`).getTime();
    const price = parseFloat(match[2].replace(/,/g, ""));
    if (Number.isNaN(timestampMs) || Number.isNaN(price)) continue;
    sales.push({ price, timestampMs });
  }

  return sales;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function confidenceFor(sales90d: number, sales30d: number): PriceConfidence {
  if (sales90d < LOW_VOLUME_THRESHOLD) return "low";
  if (sales30d < HIGH_CONFIDENCE_THRESHOLD) return "medium";
  return "high";
}

function summarize(sales: { price: number; timestampMs: number }[]): PriceChartingRawPricing {
  const now = Date.now();
  const prices30 = sales.filter((s) => s.timestampMs >= now - 30 * DAY_MS).map((s) => s.price);
  const prices90 = sales.filter((s) => s.timestampMs >= now - 90 * DAY_MS).map((s) => s.price);

  const median30 = median(prices30);
  const median90 = median(prices90);

  return {
    median30d: median30,
    median90d: median90,
    sales30d: prices30.length,
    sales90d: prices90.length,
    confidence: confidenceFor(prices90.length, prices30.length),
    primaryPrice: median30 ?? median90,
  };
}

const resultCache = new Map<string, { result: PriceChartingRawPricing; fetchedAt: number }>();

async function getDbCachedPrice(cardId: string): Promise<PriceChartingRawPricing | null> {
  try {
    const supabase = createServiceRoleClient();
    const cutoff = new Date(Date.now() - DB_CACHE_TTL_HOURS * 60 * 60 * 1000).toISOString();

    const { data } = await supabase
      .from("market_prices")
      .select("price, sample_size, recorded_at")
      .eq("card_id", cardId)
      .eq("source", "pricecharting")
      .eq("condition", "raw")
      .gte("recorded_at", cutoff)
      .order("recorded_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!data) return null;

    // The cached row only stores the primary price + a sample count, not
    // the full 30d/90d sale list -- callers of this module only ever
    // read .primaryPrice and .confidence, so that's all a cache hit needs
    // to reconstruct faithfully.
    const sampleSize = data.sample_size ?? 0;
    return {
      median30d: data.price,
      median90d: data.price,
      sales30d: sampleSize,
      sales90d: sampleSize,
      confidence: confidenceFor(sampleSize, sampleSize),
      primaryPrice: data.price,
    };
  } catch {
    return null;
  }
}

async function cacheDbPrice(cardId: string, result: PriceChartingRawPricing): Promise<void> {
  if (result.primaryPrice === null) return;
  try {
    const supabase = createServiceRoleClient();
    // Supabase's .insert() does NOT throw on a DB-level error (e.g. a
    // check-constraint violation) -- it resolves with { error } instead,
    // so that has to be checked explicitly or a failed write is silently
    // swallowed (confirmed live: an earlier version of this function
    // never checked `error` and logged nothing at all, even though no
    // row was actually written).
    const { error } = await supabase.from("market_prices").insert({
      card_id: cardId,
      source: "pricecharting",
      condition: "raw",
      price: result.primaryPrice,
      sample_size: result.sales30d || result.sales90d || 1,
    });
    if (error) throw new Error(error.message);
  } catch (err) {
    // Non-fatal -- most likely the 'pricecharting' source value hasn't
    // been added to market_prices' check constraint on this DB yet (see
    // supabase/schema.sql). The live result this guards is still
    // returned to the caller either way; only the persistent cache is
    // lost.
    console.warn("[pricecharting] could not write DB cache (migration may be pending):", err);
  }
}

/**
 * Looks up a real raw-price read for a card from PriceCharting's
 * individual sold listings (not its own blended "market price"). Takes
 * the card's full identity (name + set + card number + variant) rather
 * than just a name -- a bare name matches too many printings, and
 * including the card number and a variant term (e.g. "Shadowless",
 * "1st Edition") in the search query helps PriceCharting's own search
 * disambiguate between them (verified live -- see variantSearchTerm()).
 *
 * Fallback chain: in-memory cache (same warm instance only) -> DB cache
 * (market_prices, up to DB_CACHE_TTL_HOURS old) -> live scrape. Returns
 * null if the card can't be found, robots.txt disallows the lookup, or
 * the request fails for any reason -- callers should fall back to mock
 * data in that case.
 */
export async function getPriceChartingRawPricing(
  cardId: string,
  cardName: string,
  setName: string = "",
  cardNumber: string = "",
  variant: CardVariant = "Normal",
  variantDetail?: string
): Promise<PriceChartingRawPricing | null> {
  const memCached = resultCache.get(cardId);
  if (memCached && Date.now() - memCached.fetchedAt < IN_MEMORY_CACHE_TTL_MS) {
    return memCached.result;
  }

  const dbCached = await getDbCachedPrice(cardId);
  if (dbCached) {
    resultCache.set(cardId, { result: dbCached, fetchedAt: Date.now() });
    console.log("[pricecharting] DB cache hit for", cardName, "-> primary:", dbCached.primaryPrice);
    return dbCached;
  }

  try {
    const query = [setName, cardName, cardNumber, variantSearchTerm(variant, variantDetail)]
      .filter(Boolean)
      .join(" ")
      .trim();
    // TEMPORARY DEBUG LOGGING -- tracking down a "$0 raw price" report.
    // Remove once the root cause is confirmed fixed in production.
    console.log(`[pricecharting][debug] search query: "${query}"`);

    const productUrl = await findProductUrl(query);
    console.log(`[pricecharting][debug] search query "${query}" -> product URL:`, productUrl);
    if (!productUrl) {
      console.log("[pricecharting] no product match for", cardName);
      return null;
    }

    const url = new URL(productUrl);
    if (!(await isPathAllowed(url.pathname))) {
      console.warn("[pricecharting] robots.txt disallows", productUrl);
      return null;
    }

    const res = await fetch(productUrl, { headers: HEADERS });
    console.log(`[pricecharting][debug] product page fetch status: ${res.status} for ${productUrl}`);
    if (!res.ok) return null;

    const html = await res.text();

    const productName = extractProductName(html);
    console.log(`[pricecharting][debug] matched product name: "${productName}" for query "${query}"`);
    if (productName && !looksLikeMatch(cardName, productName)) {
      console.warn(
        `[pricecharting] matched product "${productName}" doesn't look like "${cardName}" -- ` +
          `treating as no match rather than returning a wrong price`
      );
      return null;
    }

    const sales = parseRawSales(html);
    console.log(`[pricecharting][debug] parsed ${sales.length} raw sold listing(s) from ${productUrl}`);
    if (sales.length === 0) {
      console.log("[pricecharting] no sold listings found for", cardName);
      return null;
    }

    const result = summarize(sales);
    resultCache.set(cardId, { result, fetchedAt: Date.now() });
    await cacheDbPrice(cardId, result);
    console.log(
      "[pricecharting] live lookup for",
      cardName,
      "-> primary:",
      result.primaryPrice,
      "confidence:",
      result.confidence,
      `(${result.sales30d} sales/30d, ${result.sales90d} sales/90d)`
    );
    return result;
  } catch (err) {
    console.error("[pricecharting] lookup failed for", cardName, ":", err);
    return null;
  }
}
