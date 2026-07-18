/**
 * Best-effort card enrichment via the Pokémon TCG API.
 *
 * Card identity resolution (name + set + card number + language) is now
 * driven directly by the scan form -- see lib/cardIdentifier.ts's
 * resolveOrCreateCard(), which the analyze route calls to get a real
 * cards row before this ever runs. This file's job shrank to just
 * backfilling supplementary fields the user didn't provide (currently
 * `rarity`) for a newly-created row, since the user's own identity
 * fields are already authoritative and don't need "discovering."
 *
 * Fire-and-forget from the analyze route: failure here is always
 * non-fatal and never affects the scan's own result, which was already
 * computed from the user-supplied identity regardless of whether this
 * succeeds.
 *
 * Scope note -- what this does NOT do: it does not run the Alt.xyz
 * scraper. That scraper is Python/Playwright (python-services/), and
 * this runs inside a Vercel Next.js serverless function -- there's no
 * shared runtime or deployed Python HTTP service for it to call
 * synchronously, and a headless-browser scrape takes far longer than a
 * request has to spare regardless. Newly-inserted cards get picked up
 * automatically the next time the existing nightly GitHub Actions job
 * (jobs/nightly_price_scrape.py) runs -- get_cards_to_scrape() already
 * returns every row in `cards`, new or old.
 */
import { createServiceRoleClient } from "@/lib/supabase/server";

async function queryPokemonTCGApi(nameQuery: string, headers: Record<string, string>) {
  const query = `name:"${nameQuery}"`;
  const url = `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(query)}&pageSize=1`;

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Pokemon TCG API request failed (${response.status})`);
  }
  const data = await response.json();
  return data.data?.[0] ?? null;
}

/**
 * The Pokemon TCG API's `name:"..."` query is an exact-phrase match
 * against the card's real `name` field -- confirmed directly: searching
 * `name:"Umbreon VMAX Alt Art"` returns zero results, because the API's
 * actual name for that card is just "Umbreon VMAX" ("Alt Art" is a
 * GradeIQ-side descriptor for the illustration, not part of the card's
 * name). To handle that without hardcoding a list of descriptor words,
 * this retries with the last word dropped, repeatedly, until a match is
 * found or there's only one word left.
 */
async function searchPokemonTCGApi(cardName: string): Promise<{ rarity: string | null } | null> {
  const headers: Record<string, string> = {};
  const apiKey = process.env.POKEMONTCG_API_KEY;
  if (apiKey) headers["X-Api-Key"] = apiKey;

  const words = cardName.trim().split(/\s+/);
  let card = null;

  for (let wordCount = words.length; wordCount >= 1; wordCount--) {
    const attempt = words.slice(0, wordCount).join(" ");
    card = await queryPokemonTCGApi(attempt, headers);
    if (card) break;
  }

  if (!card) return null;
  return { rarity: card.rarity ?? null };
}

/**
 * Looks up `cardName` on the Pokémon TCG API and, if a rarity is found,
 * backfills `cards.rarity` for `cardId` -- only when it's still null, so
 * this never clobbers a value set some other way. No-op (not an error)
 * when the API has no match or returns no rarity.
 */
export async function enrichCardFromPokemonTCGApi(cardId: string, cardName: string): Promise<void> {
  try {
    const apiCard = await searchPokemonTCGApi(cardName);
    if (!apiCard?.rarity) return;

    const supabase = createServiceRoleClient();
    await supabase.from("cards").update({ rarity: apiCard.rarity }).eq("id", cardId).is("rarity", null);
    console.log(`[enrichCard] backfilled rarity "${apiCard.rarity}" for card ${cardId}`);
  } catch (err) {
    console.error("[enrichCard] Pokemon TCG API enrichment failed:", err);
  }
}
