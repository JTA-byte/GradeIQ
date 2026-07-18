/**
 * GET/POST /api/portfolio
 *
 * List or create the current user's portfolio items. RLS already scopes
 * every query to auth.uid() = user_id, but each route still checks auth
 * explicitly to return a clean 401 instead of an empty/failed query.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function GET() {
  try {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const { data, error } = await supabase
      .from("portfolio_items")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (error) {
      return NextResponse.json({ error: `Failed to load portfolio: ${error.message}` }, { status: 500 });
    }

    return NextResponse.json({ items: data ?? [] });
  } catch (err) {
    return NextResponse.json({ error: `Unexpected server error: ${errorMessage(err)}` }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    let body: { cardName?: string; rawPurchasePrice?: number; dateBought?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    const { cardName, rawPurchasePrice, dateBought } = body;

    if (!cardName || typeof rawPurchasePrice !== "number" || !dateBought) {
      return NextResponse.json(
        { error: "Missing required fields: cardName, rawPurchasePrice, dateBought" },
        { status: 400 }
      );
    }

    const { data, error } = await supabase
      .from("portfolio_items")
      .insert({
        user_id: user.id,
        card_name: cardName,
        raw_purchase_price: rawPurchasePrice,
        date_bought: dateBought,
        status: "raw",
      })
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: `Failed to add portfolio item: ${error.message}` }, { status: 500 });
    }

    return NextResponse.json({ item: data });
  } catch (err) {
    return NextResponse.json({ error: `Unexpected server error: ${errorMessage(err)}` }, { status: 500 });
  }
}
