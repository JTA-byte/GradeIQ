/**
 * Card variant type/list, split out from lib/cardIdentifier.ts so client
 * components (app/scan/page.tsx's variant dropdown) can import it
 * without pulling in that file's createServiceRoleClient import -- same
 * reasoning as lib/cardLanguage.ts.
 */
export type CardVariant =
  | "Normal"
  | "Holo"
  | "Non-Holo"
  | "Reverse Holo"
  | "First Edition"
  | "Shadowless"
  | "No Symbol"
  | "Stamped"
  | "Promo"
  | "Full Art"
  | "Special Illustration Rare"
  | "Hyper Rare"
  | "Secret Rare";

export const CARD_VARIANTS: CardVariant[] = [
  "Normal",
  "Holo",
  "Non-Holo",
  "Reverse Holo",
  "First Edition",
  "Shadowless",
  "No Symbol",
  "Stamped",
  "Promo",
  "Full Art",
  "Special Illustration Rare",
  "Hyper Rare",
  "Secret Rare",
];

// These two variants need a free-text sub-field to be meaningful --
// "Stamped" alone doesn't say which stamp, "Promo" alone doesn't say
// which promo card.
export const VARIANTS_WITH_DETAIL: CardVariant[] = ["Stamped", "Promo"];

export function variantNeedsDetail(variant: CardVariant): boolean {
  return VARIANTS_WITH_DETAIL.includes(variant);
}

export function variantDetailLabel(variant: CardVariant): string {
  return variant === "Promo" ? "Promo number (e.g. SWSH001, XY01, BW01)" : "Stamp type (e.g. Prerelease, Staff, League)";
}
