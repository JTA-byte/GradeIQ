/**
 * Builds eBay sold-listings search links from a card's full identity
 * (name, set, card number, variant, language) rather than just its name
 * -- a bare name like "Charizard" matches dozens of printings, so the
 * extra identifiers meaningfully narrow the search to the right card.
 *
 * Query shape: "{name} {card number} {set name} {variant} {language}
 * [ungraded | {grader} {grade}] pokemon". "Normal" variant is omitted
 * (searching eBay for the literal word "Normal" doesn't help and hides
 * otherwise-relevant unqualified listings); Stamped/Promo's variant
 * detail (stamp type / promo number) is included right after the
 * variant, unless it's identical to the card number already in the
 * query (promo cards often use the same code, e.g. "SWSH001", for both).
 * Fields that aren't known (older Buy Signals rows scraped before
 * card_number/language/variant existed, a scan where the user left an
 * optional field blank) are simply omitted rather than interpolated as
 * "undefined"/"null".
 *
 * Kept "ungraded" (not "raw") for the raw-listing keyword -- an earlier,
 * explicit instruction on this exact search-query design said "add
 * ungraded to the search"; a later message's own illustrative example
 * used "raw" instead, but that looked like shorthand in an example
 * rather than a deliberate redefinition, so this stays consistent with
 * the original explicit rule.
 */
export interface CardIdentifierLike {
  cardName: string;
  cardNumber?: string | null;
  setName?: string | null;
  variant?: string | null;
  variantDetail?: string | null;
  language?: string | null;
}

function identifierParts(card: CardIdentifierLike): string[] {
  const variant = card.variant && card.variant.toLowerCase() !== "normal" ? card.variant : null;
  const variantDetail =
    card.variantDetail && card.variantDetail.trim().toLowerCase() !== (card.cardNumber ?? "").trim().toLowerCase()
      ? card.variantDetail
      : null;

  return [card.cardName, card.cardNumber, card.setName, variant, variantDetail, card.language].filter(
    (part): part is string => !!part && part.trim().length > 0
  );
}

function buildUrl(query: string): string {
  return `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}&LH_Complete=1&LH_Sold=1`;
}

/** Sold/completed **raw** (ungraded) listings for a card. */
export function ebayRawSoldListingsUrl(card: CardIdentifierLike): string {
  return buildUrl([...identifierParts(card), "ungraded", "pokemon"].join(" "));
}

/** Sold/completed listings for a specific graded tier, e.g. "PSA 10". */
export function ebayGradedSoldListingsUrl(card: CardIdentifierLike, gradeLabel: string): string {
  return buildUrl([...identifierParts(card), gradeLabel, "pokemon"].join(" "));
}
