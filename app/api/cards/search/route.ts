/**
 * GET /api/cards/search?name=...&set=...
 *
 * Card autocomplete for the scan form: as the user types a card name and
 * set, this returns matching rows from `cards` (including card_number
 * and language) so they can pick the exact printing instead of typing
 * the card number by hand. Public reference data, no RLS on `cards`, so
 * this doesn't gate on auth -- same reasoning as lib/buySignals.ts using
 * the service-role client for read-only catalog data.
 */
import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";

const MIN_QUERY_LENGTH = 2;
const RESULT_LIMIT = 8;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function GET(request: NextRequest) {
  try {
    const name = request.nextUrl.searchParams.get("name")?.trim() ?? "";
    const set = request.nextUrl.searchParams.get("set")?.trim() ?? "";

    if (name.length < MIN_QUERY_LENGTH && set.length < MIN_QUERY_LENGTH) {
      return NextResponse.json({ cards: [] });
    }

    const supabase = createServiceRoleClient();

    function buildQuery(columns: string) {
      let query = supabase.from("cards").select(columns).order("name").limit(RESULT_LIMIT);
      if (name.length >= MIN_QUERY_LENGTH) query = query.ilike("name", `%${name}%`);
      if (set.length >= MIN_QUERY_LENGTH) query = query.ilike("set_name", `%${set}%`);
      return query;
    }

    let { data, error } = await buildQuery("id, name, set_name, card_number, language");

    // Tolerate cards.language not existing yet on the live DB (added in
    // supabase/schema.sql, applied by hand) -- fall back rather than
    // breaking autocomplete for however long that takes to run.
    if (error?.message.includes("language")) {
      console.warn("[cards/search] cards.language doesn't exist yet -- falling back without it.");
      const fallback = await buildQuery("id, name, set_name, card_number");
      data = fallback.data?.map((row: Record<string, unknown>) => ({ ...row, language: null })) ?? null;
      error = fallback.error;
    }

    if (error) {
      return NextResponse.json({ error: `Card search failed: ${error.message}` }, { status: 500 });
    }

    return NextResponse.json({ cards: data ?? [] });
  } catch (err) {
    return NextResponse.json(
      { error: `Unexpected server error: ${errorMessage(err)}` },
      { status: 500 }
    );
  }
}
