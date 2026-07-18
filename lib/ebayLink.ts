/**
 * Builds a link to eBay's sold/completed raw listings for a card, so
 * users can sanity-check current market pricing against real comps.
 */
export function ebaySoldListingsUrl(cardName: string): string {
  const query = `${cardName} raw`;
  return `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}&LH_Complete=1&LH_Sold=1`;
}
