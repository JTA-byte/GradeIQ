/**
 * PATCH/DELETE /api/alerts/[id]
 *
 * Update (e.g. toggle is_active) or remove a single price alert. RLS
 * scopes every query to auth.uid() = user_id, so a request for another
 * user's alert id affects zero rows rather than erroring -- treated as
 * a 404 below rather than a silent no-op. Same pattern as
 * app/api/portfolio/[id]/route.ts.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    let body: { isActive?: boolean; targetPrice?: number };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    const update: Record<string, unknown> = {};
    if (body.isActive !== undefined) update.is_active = body.isActive;
    if (body.targetPrice !== undefined) update.target_price = body.targetPrice;

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: "No fields to update" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("price_alerts")
      .update(update)
      .eq("id", params.id)
      .eq("user_id", user.id)
      .select()
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: `Failed to update alert: ${error.message}` }, { status: 500 });
    }
    if (!data) {
      return NextResponse.json({ error: "Alert not found" }, { status: 404 });
    }

    return NextResponse.json({ alert: data });
  } catch (err) {
    return NextResponse.json({ error: `Unexpected server error: ${errorMessage(err)}` }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
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
      .delete()
      .eq("id", params.id)
      .eq("user_id", user.id)
      .select()
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: `Failed to delete alert: ${error.message}` }, { status: 500 });
    }
    if (!data) {
      return NextResponse.json({ error: "Alert not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: `Unexpected server error: ${errorMessage(err)}` }, { status: 500 });
  }
}
