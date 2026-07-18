/**
 * Builds eBay sold-listings search links from a card's full identity
 * (name, set, card number, language) rather than just its name -- a bare
 * name like "Charizard" matches dozens of printings, so the extra
 * identifiers meaningfully narrow the search to the right card.
 *
 * Query shape: "{name} {card number} {set name} {language} pokemon
 * [ungraded | {grader} {grade}]". Fields that aren't known (older
 * Buy Signals rows scraped before card_number/language existed, a scan
 * where the user left an optional field blank) are simply omitted
 * rather than interpolated as "undefined"/"null".
 */
export interface CardIdentifierLike {
  cardName: string;
  cardNumber?: string | null;
  setName?: string | null;
  language?: string | null;
}

function identifierParts(card: CardIdentifierLike): string[] {
  return [card.cardName, card.cardNumber, card.setName, card.language].filter(
    (part): part is string => !!part && part.trim().length > 0
  );
}

function buildUrl(query: string): string {
  return `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}&LH_Complete=1&LH_Sold=1`;
}

/** Sold/completed **raw** (ungraded) listings for a card. */
export function ebayRawSoldListingsUrl(card: CardIdentifierLike): string {
  return buildUrl([...identifierParts(card), "pokemon", "ungraded"].join(" "));
}

/** Sold/completed listings for a specific graded tier, e.g. "PSA 10". */
export function ebayGradedSoldListingsUrl(card: CardIdentifierLike, gradeLabel: string): string {
  return buildUrl([...identifierParts(card), "pokemon", gradeLabel].join(" "));
}
