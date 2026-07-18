/**
 * PATCH/DELETE /api/portfolio/[id]
 *
 * Update or remove a single portfolio item. PATCH accepts any subset of
 * the mutable fields (status, grader, submissionDate, gradeReceived,
 * salePrice) -- the UI sends only what changed for a given status
 * transition (e.g. raw -> submitted sends grader + submissionDate).
 *
 * RLS scopes every query to auth.uid() = user_id, so a request for
 * another user's item id affects zero rows rather than erroring --
 * that's treated as a 404 below rather than a silent no-op.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface PortfolioItemUpdate {
  status?: "watchlist" | "raw" | "submitted" | "graded" | "sold";
  grader?: "PSA" | "CGC" | "BGS" | "TAG";
  submissionDate?: string;
  gradeReceived?: string;
  salePrice?: number;
  // Only used for the watchlist -> raw transition ("log a purchase" on a
  // previously-watchlisted target card) -- these fill in the fields a
  // watchlist row was created without.
  rawPurchasePrice?: number;
  dateBought?: string;
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

    let body: PortfolioItemUpdate;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    const update: Record<string, unknown> = {};
    if (body.status !== undefined) update.status = body.status;
    if (body.grader !== undefined) update.grader = body.grader;
    if (body.submissionDate !== undefined) update.submission_date = body.submissionDate;
    if (body.gradeReceived !== undefined) update.grade_received = body.gradeReceived;
    if (body.salePrice !== undefined) update.sale_price = body.salePrice;
    if (body.rawPurchasePrice !== undefined) update.raw_purchase_price = body.rawPurchasePrice;
    if (body.dateBought !== undefined) update.date_bought = body.dateBought;
    // Logging a purchase against a watchlist row also clears is_watchlist
    // -- it's a real owned card now, not just a target.
    if (body.status === "raw" && body.rawPurchasePrice !== undefined) update.is_watchlist = false;

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: "No fields to update" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("portfolio_items")
      .update(update)
      .eq("id", params.id)
      .eq("user_id", user.id)
      .select()
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: `Failed to update portfolio item: ${error.message}` }, { status: 500 });
    }

    if (!data) {
      return NextResponse.json({ error: "Portfolio item not found" }, { status: 404 });
    }

    return NextResponse.json({ item: data });
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
      .from("portfolio_items")
      .delete()
      .eq("id", params.id)
      .eq("user_id", user.id)
      .select()
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: `Failed to delete portfolio item: ${error.message}` }, { status: 500 });
    }

    if (!data) {
      return NextResponse.json({ error: "Portfolio item not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: `Unexpected server error: ${errorMessage(err)}` }, { status: 500 });
  }
}
