/**
 * Dynamic card lookup: when a user analyzes a card GradeIQ doesn't have
 * in the `cards` table yet, this searches the Pokémon TCG API for it and
 * inserts a real row (name, set_name, card_number, rarity) instead of
 * leaving the card permanently stuck on mock data.
 *
 * Scope note -- what this does NOT do: it does not run the Alt.xyz
 * scraper. That scraper is Python/Playwright (python-services/), and
 * this runs inside a Vercel Next.js serverless function -- there's no
 * shared runtime or deployed Python HTTP service for it to call
 * synchronously, and a headless-browser scrape takes far longer than a
 * request has to spare regardless. Newly-inserted cards get picked up
 * automatically the next time the existing nightly GitHub Actions job
 * (jobs/nightly_price_scrape.py) runs -- get_cards_to_scrape() already
 * returns every row in `cards`, new or old. For a genuinely immediate
 * scrape of one specific card, see python-services/scrapers/
 * on_demand_scrape.py, which is a standalone script for manual or
 * future webhook/queue use -- not something this file can invoke inline.
 */
import { createServiceRoleClient } from "@/lib/supabase/server";

interface PokemonTCGCard {
  name: string;
  setName: string;
  cardNumber: string;
  rarity: string | null;
}

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
 * name). That exact string is one of this app's own suggested example
 * searches (see the placeholder text in app/page.tsx), so a strict exact
 * match would systematically fail on it -- and likely on plenty of other
 * user input following the same "<card name> <descriptor>" pattern
 * (e.g. "SIR", "Alternate Art").
 *
 * To handle that without hardcoding a list of descriptor words, this
 * retries with the last word dropped, repeatedly, until a match is
 * found or there's only one word left. Confirmed empirically: "Umbreon
 * VMAX Alt Art" needs two words trimmed ("Alt Art") before "Umbreon
 * VMAX" matches.
 */
async function searchPokemonTCGApi(cardName: string): Promise<PokemonTCGCard | null> {
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

  const setName = card.set?.name;
  const cardNumber = card.number;
  if (!card.name || !setName || !cardNumber) return null;

  return {
    name: card.name,
    setName,
    cardNumber,
    rarity: card.rarity ?? null,
  };
}

/**
 * Searches the Pokémon TCG API for `cardName` and, if found, inserts it
 * into the `cards` table (or returns the existing row's id if one
 * already matches by name/set/number). Returns null if the card isn't
 * found on the Pokémon TCG API or the insert fails outright.
 */
export async function dynamicCardLookup(cardName: string): Promise<string | null> {
  const supabase = createServiceRoleClient();

  // Already have a row for this name? Don't hit the external API again.
  const { data: existing } = await supabase
    .from("cards")
    .select("id")
    .ilike("name", cardName)
    .limit(1)
    .maybeSingle();

  if (existing) {
    return existing.id;
  }

  let apiCard: PokemonTCGCard | null;
  try {
    apiCard = await searchPokemonTCGApi(cardName);
  } catch (err) {
    console.error("[dynamicCardLookup] Pokemon TCG API search failed:", err);
    return null;
  }

  if (!apiCard) {
    console.log(`[dynamicCardLookup] no Pokemon TCG API match for "${cardName}"`);
    return null;
  }

  const { data: created, error } = await supabase
    .from("cards")
    .insert({
      name: apiCard.name,
      set_name: apiCard.setName,
      card_number: apiCard.cardNumber,
      rarity: apiCard.rarity,
    })
    .select("id")
    .single();

  if (!error && created) {
    console.log(
      `[dynamicCardLookup] inserted "${apiCard.name}" (${apiCard.setName} #${apiCard.cardNumber}) as ${created.id}`
    );
    return created.id;
  }

  // Insert failed -- most likely a unique-constraint race with a
  // concurrent request for the same card. Re-fetch rather than fail.
  const { data: fallback } = await supabase
    .from("cards")
    .select("id")
    .eq("name", apiCard.name)
    .eq("set_name", apiCard.setName)
    .eq("card_number", apiCard.cardNumber)
    .maybeSingle();

  if (fallback) {
    return fallback.id;
  }

  console.error("[dynamicCardLookup] insert failed and no fallback row found:", error?.message);
  return null;
}
