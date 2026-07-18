/**
 * Structured card identity: name + set + card number + language + variant.
 *
 * A bare card name ("Charizard") is too ambiguous for accurate eBay
 * searches, market data lookups, or scraper queries -- there are dozens
 * of "Charizard" printings across sets, languages, variants, and
 * reprints. The scan form (app/scan/page.tsx) collects all of this up
 * front so every downstream lookup (TCGPlayer, PriceCharting, Alt.xyz,
 * eBay search links) can key off the same precise identity instead of a
 * fuzzy name-only guess.
 */
import { createServiceRoleClient } from "@/lib/supabase/server";
import { CardLanguage } from "@/lib/cardLanguage";
import { CardVariant } from "@/lib/cardVariant";

export type { CardLanguage } from "@/lib/cardLanguage";
export { CARD_LANGUAGES } from "@/lib/cardLanguage";
export type { CardVariant } from "@/lib/cardVariant";
export { CARD_VARIANTS } from "@/lib/cardVariant";

export interface CardIdentifier {
  name: string;
  setName: string;
  cardNumber: string;
  language: CardLanguage;
  variant: CardVariant;
  variantDetail?: string; // stamp type or promo number, only meaningful for Stamped/Promo
}

export interface ResolvedCard {
  id: string;
  isNew: boolean;
}

async function resolveOrCreateCardImpl(
  card: CardIdentifier,
  includeLanguage: boolean,
  includeVariant: boolean
): Promise<ResolvedCard> {
  const supabase = createServiceRoleClient();

  const name = card.name.trim();
  const setName = card.setName.trim();
  const cardNumber = card.cardNumber.trim();
  const language = card.language;
  const variant = card.variant;
  const variantDetail = card.variantDetail?.trim() || null;

  let existingQuery = supabase
    .from("cards")
    .select("id")
    .ilike("name", name)
    .ilike("set_name", setName)
    .eq("card_number", cardNumber);
  if (includeLanguage) existingQuery = existingQuery.eq("language", language);
  if (includeVariant) {
    existingQuery = existingQuery.eq("variant", variant);
    existingQuery = variantDetail
      ? existingQuery.eq("variant_detail", variantDetail)
      : existingQuery.is("variant_detail", null);
  }

  const { data: existing, error: selectError } = await existingQuery.limit(1).maybeSingle();
  if (selectError) throw new Error(selectError.message);

  if (existing) {
    return { id: existing.id, isNew: false };
  }

  const insertPayload: Record<string, string | null> = {
    name,
    set_name: setName,
    card_number: cardNumber,
  };
  if (includeLanguage) insertPayload.language = language;
  if (includeVariant) {
    insertPayload.variant = variant;
    insertPayload.variant_detail = variantDetail;
  }

  const { data: created, error } = await supabase
    .from("cards")
    .insert(insertPayload)
    .select("id")
    .single();

  if (!error && created) {
    return { id: created.id, isNew: true };
  }

  // Insert failed -- most likely a unique-constraint race with a
  // concurrent request for the same card. Re-fetch rather than fail.
  let fallbackQuery = supabase
    .from("cards")
    .select("id")
    .eq("name", name)
    .eq("set_name", setName)
    .eq("card_number", cardNumber);
  if (includeLanguage) fallbackQuery = fallbackQuery.eq("language", language);
  if (includeVariant) {
    fallbackQuery = variant
      ? fallbackQuery.eq("variant", variant)
      : fallbackQuery;
    fallbackQuery = variantDetail
      ? fallbackQuery.eq("variant_detail", variantDetail)
      : fallbackQuery.is("variant_detail", null);
  }

  const { data: fallback } = await fallbackQuery.maybeSingle();

  if (fallback) {
    return { id: fallback.id, isNew: false };
  }

  throw new Error(
    `Could not find or create a cards row for "${name}" (${setName} #${cardNumber}, ${language}, ${variant}): ${error?.message}`
  );
}

/**
 * Finds the cards row matching this exact identity (name/set matched
 * case-insensitively, since users and autocomplete alike may differ in
 * casing; card_number, language, variant, and variant_detail matched as
 * given), or inserts a new row if none exists. Returns isNew=true when a
 * row was just created -- callers use that to decide whether to kick off
 * best-effort enrichment (see lib/dynamicCardLookup.ts's
 * enrichCardFromPokemonTCGApi).
 *
 * Tolerates `cards.language` and/or `cards.variant`/`variant_detail` not
 * existing yet on the live DB (added in supabase/schema.sql but applied
 * to the live DB by hand) -- this sits in the critical path of every
 * scan, so unlike the Buy Signals page's similar fallbacks, a hard
 * failure here would break card analysis entirely rather than just
 * losing a display field. Falls back one column group at a time so
 * whichever migrations *have* been applied still take effect.
 */
export async function resolveOrCreateCard(card: CardIdentifier): Promise<ResolvedCard> {
  try {
    return await resolveOrCreateCardImpl(card, true, true);
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).toLowerCase();

    if (message.includes("variant")) {
      console.warn(
        "[cardIdentifier] cards.variant doesn't exist yet -- resolving without it. " +
          "Run the migration in supabase/schema.sql to enable per-card variant."
      );
      try {
        return await resolveOrCreateCardImpl(card, true, false);
      } catch (err2) {
        const message2 = (err2 instanceof Error ? err2.message : String(err2)).toLowerCase();
        if (!message2.includes("language")) throw err2;
        console.warn(
          "[cardIdentifier] cards.language doesn't exist yet either -- resolving without it too."
        );
        return resolveOrCreateCardImpl(card, false, false);
      }
    }

    if (message.includes("language")) {
      console.warn(
        "[cardIdentifier] cards.language doesn't exist yet -- resolving without it. " +
          "Run the migration in supabase/schema.sql to enable per-card language."
      );
      return resolveOrCreateCardImpl(card, false, false);
    }

    throw err;
  }
}
