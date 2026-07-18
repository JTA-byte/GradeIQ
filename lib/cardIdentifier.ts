/**
 * Structured card identity: name + set + card number + language.
 *
 * A bare card name ("Charizard") is too ambiguous for accurate eBay
 * searches, market data lookups, or scraper queries -- there are dozens
 * of "Charizard" printings across sets, languages, and reprints. The
 * scan form (app/scan/page.tsx) collects all four fields up front so
 * every downstream lookup (TCGPlayer, PriceCharting, Alt.xyz, eBay
 * search links) can key off the same precise identity instead of a
 * fuzzy name-only guess.
 */
import { createServiceRoleClient } from "@/lib/supabase/server";
import { CardLanguage } from "@/lib/cardLanguage";

export type { CardLanguage } from "@/lib/cardLanguage";
export { CARD_LANGUAGES } from "@/lib/cardLanguage";

export interface CardIdentifier {
  name: string;
  setName: string;
  cardNumber: string;
  language: CardLanguage;
}

export interface ResolvedCard {
  id: string;
  isNew: boolean;
}

async function resolveOrCreateCardImpl(
  card: CardIdentifier,
  includeLanguage: boolean
): Promise<ResolvedCard> {
  const supabase = createServiceRoleClient();

  const name = card.name.trim();
  const setName = card.setName.trim();
  const cardNumber = card.cardNumber.trim();
  const language = card.language;

  let existingQuery = supabase
    .from("cards")
    .select("id")
    .ilike("name", name)
    .ilike("set_name", setName)
    .eq("card_number", cardNumber);
  if (includeLanguage) existingQuery = existingQuery.eq("language", language);

  const { data: existing, error: selectError } = await existingQuery.limit(1).maybeSingle();
  if (selectError) throw new Error(selectError.message);

  if (existing) {
    return { id: existing.id, isNew: false };
  }

  const insertPayload: Record<string, string> = { name, set_name: setName, card_number: cardNumber };
  if (includeLanguage) insertPayload.language = language;

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

  const { data: fallback } = await fallbackQuery.maybeSingle();

  if (fallback) {
    return { id: fallback.id, isNew: false };
  }

  throw new Error(
    `Could not find or create a cards row for "${name}" (${setName} #${cardNumber}, ${language}): ${error?.message}`
  );
}

/**
 * Finds the cards row matching this exact identity (name/set matched
 * case-insensitively, since users and autocomplete alike may differ in
 * casing; card_number and language matched as given), or inserts a new
 * row if none exists. Returns isNew=true when a row was just created --
 * callers use that to decide whether to kick off best-effort enrichment
 * (see lib/dynamicCardLookup.ts's enrichCardFromPokemonTCGApi).
 *
 * Tolerates `cards.language` not existing yet on the live DB (it's
 * added in supabase/schema.sql but applied to the live DB by hand) --
 * this sits in the critical path of every scan, so unlike the Buy
 * Signals page's similar fallbacks, a hard failure here would break
 * card analysis entirely rather than just losing a display field.
 */
export async function resolveOrCreateCard(card: CardIdentifier): Promise<ResolvedCard> {
  try {
    return await resolveOrCreateCardImpl(card, true);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.toLowerCase().includes("language")) throw err;

    console.warn(
      "[cardIdentifier] cards.language doesn't exist yet -- resolving without it. " +
        "Run the migration in supabase/schema.sql to enable per-card language."
    );
    return resolveOrCreateCardImpl(card, false);
  }
}
