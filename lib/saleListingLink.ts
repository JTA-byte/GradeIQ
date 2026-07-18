/**
 * Builds a link to the actual listing behind one market_sales row, for
 * the "Recent Sales" list on the Buy Signals page.
 *
 * - 'alt': links straight to the sale's own Alt.xyz item page
 *   (https://alt.xyz/itm/{id}) when the scraper captured one -- see
 *   python-services/scrapers/alt_scraper.py's source_url capture. Older
 *   rows scraped before that existed (and any future edge case where
 *   capture fails) have source_url = null, so this falls back to an
 *   Alt.xyz sold-listings search for the card instead of a dead link.
 * - 'ebay_sold': Alt aggregates eBay comps but doesn't expose a stable
 *   per-sale eBay URL, so this always builds an eBay sold-listings
 *   search for the card + grade -- the closest thing to "the actual
 *   listing" without one on file.
 * - 'pricecharting': not currently reachable from this list (Buy
 *   Signals' recent-sales section only shows graded sales, and
 *   PriceCharting only contributes raw/ungraded rows -- see
 *   lib/buySignals.ts), but falls back to the same eBay search rather
 *   than producing a broken link if that ever changes.
 */
import { CardIdentifierLike, ebayGradedSoldListingsUrl } from "./ebayLink";

const GRADE_LABEL_DISPLAY: Record<string, string> = {
  "10": "10",
  PRI: "Pristine",
  BL: "Black Label",
};

export interface SaleListingLinkInput {
  source: string;
  sourceUrl: string | null;
  grader: string | null;
  grade: string;
}

export function buildSaleListingUrl(card: CardIdentifierLike, sale: SaleListingLinkInput): string {
  if (sale.source === "alt") {
    if (sale.sourceUrl) return sale.sourceUrl;
    return `https://alt.xyz/browse?${new URLSearchParams({ query: card.cardName, soldListings: "true" })}`;
  }

  const gradeLabel = [sale.grader, GRADE_LABEL_DISPLAY[sale.grade] ?? sale.grade].filter(Boolean).join(" ");
  return ebayGradedSoldListingsUrl(card, gradeLabel);
}
