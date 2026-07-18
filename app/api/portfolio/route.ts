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

    let body: {
      cardName?: string;
      rawPurchasePrice?: number;
      dateBought?: string;
      isWatchlist?: boolean;
      targetPrice?: number;
    };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    const { cardName, rawPurchasePrice, dateBought, isWatchlist, targetPrice } = body;

    if (!cardName) {
      return NextResponse.json({ error: "Missing required field: cardName" }, { status: 400 });
    }

    // A watchlist entry (from Buy Signals' "Add to watchlist") is a
    // target card the user hasn't bought yet -- no raw_purchase_price/
    // date_bought to record, since fabricating those would misrepresent
    // a target as an actual purchase. Requires the schema migration in
    // supabase/schema.sql's portfolio_items table (is_watchlist,
    // target_price, nullable raw_purchase_price/date_bought) to be
    // applied to the live DB first.
    let insertPayload: {
      user_id: string;
      card_name: string;
      status: string;
      is_watchlist: boolean;
      target_price: number | null;
      raw_purchase_price: number | null;
      date_bought: string | null;
    } | null = null;

    if (isWatchlist) {
      insertPayload = {
        user_id: user.id,
        card_name: cardName,
        status: "watchlist",
        is_watchlist: true,
        target_price: typeof targetPrice === "number" ? targetPrice : null,
        raw_purchase_price: null,
        date_bought: null,
      };
    } else if (typeof rawPurchasePrice === "number" && dateBought) {
      insertPayload = {
        user_id: user.id,
        card_name: cardName,
        status: "raw",
        is_watchlist: false,
        target_price: null,
        raw_purchase_price: rawPurchasePrice,
        date_bought: dateBought,
      };
    }

    if (!insertPayload) {
      return NextResponse.json(
        { error: "Missing required fields: cardName, rawPurchasePrice, dateBought" },
        { status: 400 }
      );
    }

    const { data, error } = await supabase
      .from("portfolio_items")
      .insert(insertPayload)
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
