/**
 * GET/POST /api/alerts
 *
 * List or create the current user's price alerts. RLS already scopes
 * every query to auth.uid() = user_id, but each route still checks auth
 * explicitly to return a clean 401 instead of an empty/failed query --
 * same pattern as app/api/portfolio/route.ts.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const ALERT_TYPES = ["below_price", "above_price"] as const;

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
      .from("price_alerts")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (error) {
      return NextResponse.json({ error: `Failed to load alerts: ${error.message}` }, { status: 500 });
    }

    return NextResponse.json({ alerts: data ?? [] });
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
      cardId?: string;
      cardName?: string;
      setName?: string;
      targetPrice?: number;
      alertType?: string;
    };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    const { cardId, cardName, setName, targetPrice, alertType } = body;

    if (!cardId || !cardName || !setName || typeof targetPrice !== "number" || targetPrice <= 0) {
      return NextResponse.json(
        { error: "Missing required fields: cardId, cardName, setName, targetPrice (> 0)" },
        { status: 400 }
      );
    }

    const resolvedAlertType = alertType ?? "below_price";
    if (!ALERT_TYPES.includes(resolvedAlertType as (typeof ALERT_TYPES)[number])) {
      return NextResponse.json(
        { error: `Invalid alertType -- must be one of ${ALERT_TYPES.join(", ")}` },
        { status: 400 }
      );
    }

    const { data, error } = await supabase
      .from("price_alerts")
      .insert({
        user_id: user.id,
        card_id: cardId,
        card_name: cardName,
        set_name: setName,
        target_price: targetPrice,
        alert_type: resolvedAlertType,
      })
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: `Failed to create alert: ${error.message}` }, { status: 500 });
    }

    return NextResponse.json({ alert: data });
  } catch (err) {
    return NextResponse.json({ error: `Unexpected server error: ${errorMessage(err)}` }, { status: 500 });
  }
}
