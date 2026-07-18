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
 * Caching: `market_prices.source` doesn't currently allow 'pricecharting'
 * as a value (its check constraint only lists 'tcgplayer', 'ebay_sold',
 * 'alt' -- see supabase/schema.sql), so this doesn't persist results
 * there the way lib/tcgplayer.ts does. Instead it uses a short in-memory
 * cache (module scope) to avoid re-scraping the same card on back-to-back
 * requests within one server instance's lifetime -- good enough given
 * PriceCharting has no documented rate limit policy but this app scrapes
 * conservatively everywhere else too.
 */
const BASE_URL = "https://www.pricecharting.com";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; GradeIQ-Bot/1.0; +https://gradeiq.app/bot-info)",
};

const DAY_MS = 24 * 60 * 60 * 1000;
const LOW_VOLUME_THRESHOLD = 5; // fewer than this many sales in 90 days -> "low" confidence
const HIGH_CONFIDENCE_THRESHOLD = 10; // 10+ sales in 30 days -> "high" confidence
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
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

function summarize(sales: { price: number; timestampMs: number }[]): PriceChartingRawPricing {
  const now = Date.now();
  const prices30 = sales.filter((s) => s.timestampMs >= now - 30 * DAY_MS).map((s) => s.price);
  const prices90 = sales.filter((s) => s.timestampMs >= now - 90 * DAY_MS).map((s) => s.price);

  const median30 = median(prices30);
  const median90 = median(prices90);

  let confidence: PriceConfidence;
  if (prices90.length < LOW_VOLUME_THRESHOLD) {
    confidence = "low";
  } else if (prices30.length < HIGH_CONFIDENCE_THRESHOLD) {
    confidence = "medium";
  } else {
    confidence = "high";
  }

  return {
    median30d: median30,
    median90d: median90,
    sales30d: prices30.length,
    sales90d: prices90.length,
    confidence,
    primaryPrice: median30 ?? median90,
  };
}

const resultCache = new Map<string, { result: PriceChartingRawPricing; fetchedAt: number }>();

/**
 * Looks up a real raw-price read for a card from PriceCharting's
 * individual sold listings (not its own blended "market price"). Takes
 * the card's full identity (name + set + card number) rather than just
 * a name -- a bare name matches too many printings, and including the
 * card number in the search query helps PriceCharting's own search
 * disambiguate between them. Returns null if the card can't be found,
 * robots.txt disallows the lookup, or the request fails for any reason
 * -- callers should fall back to mock data or another source in that
 * case.
 */
export async function getPriceChartingRawPricing(
  cardName: string,
  setName: string = "",
  cardNumber: string = ""
): Promise<PriceChartingRawPricing | null> {
  const cacheKey = `${setName}::${cardName}::${cardNumber}`.toLowerCase().trim();
  const cached = resultCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.result;
  }

  try {
    const query = `${setName} ${cardName} ${cardNumber}`.trim();
    const productUrl = await findProductUrl(query);
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
    if (!res.ok) return null;

    const html = await res.text();
    const sales = parseRawSales(html);
    if (sales.length === 0) {
      console.log("[pricecharting] no sold listings found for", cardName);
      return null;
    }

    const result = summarize(sales);
    resultCache.set(cacheKey, { result, fetchedAt: Date.now() });
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
