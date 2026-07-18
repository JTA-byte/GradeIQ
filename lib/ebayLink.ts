/**
 * Builds a link to eBay's sold/completed raw listings for a card, so
 * users can sanity-check current market pricing against real comps.
 */
export function ebaySoldListingsUrl(cardName: string): string {
  const query = `${cardName} raw`;
  return `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}&LH_Complete=1&LH_Sold=1`;
}

/**
 * Same as ebaySoldListingsUrl, but for a specific graded tier (e.g.
 * "PSA 10") instead of raw copies -- used by Buy Signals' "Find graded on
 * eBay" action so the search reflects the exact target grade being
 * evaluated, not just the card name.
 */
export function ebayGradedSoldListingsUrl(cardName: string, targetGradeLabel: string): string {
  const query = `${cardName} ${targetGradeLabel}`;
  return `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}&LH_Complete=1&LH_Sold=1`;
}
