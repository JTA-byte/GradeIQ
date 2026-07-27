/**
 * GET  /api/admin/gem-rates?cardId=... -- this card's gem_rates history
 * POST /api/admin/gem-rates -- insert a hand-entered gem_rates row
 *
 * Both gated on isAdminEmail() (lib/adminAuth.ts), not just "signed in" --
 * this writes data that feeds directly into every user's IQ Score, so it
 * shouldn't be reachable by an arbitrary logged-in user. Insert-only on
 * POST, same as python-services/db/supabase_client.py's write_pop_record:
 * a fresh row becomes "current" (lib/buySignals.ts already picks the
 * latest scraped_at per card+grader) while preserving history, rather
 * than overwriting a previous entry.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isAdminEmail } from "@/lib/adminAuth";

const VALID_GRADERS = ["PSA", "CGC", "BGS", "TAG"] as const;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function requireAdmin() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !isAdminEmail(user.email)) {
    return { supabase, user: null } as const;
  }
  return { supabase, user } as const;
}

export async function GET(request: NextRequest) {
  const { supabase, user } = await requireAdmin();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cardId = request.nextUrl.searchParams.get("cardId");
  if (!cardId) {
    return NextResponse.json({ error: "cardId is required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("gem_rates")
    .select("id, grader, top_grade_pop, total_pop, gem_rate, manually_entered, scraped_at")
    .eq("card_id", cardId)
    .order("scraped_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: `Failed to load gem rates: ${error.message}` }, { status: 500 });
  }

  return NextResponse.json({ rates: data ?? [] });
}

export async function POST(request: NextRequest) {
  const { supabase, user } = await requireAdmin();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const cardId = typeof body.cardId === "string" ? body.cardId : "";
    const grader = typeof body.grader === "string" ? body.grader.toUpperCase() : "";
    const topGradePop = Number(body.topGradePop);
    const totalPop = Number(body.totalPop);

    if (!cardId) {
      return NextResponse.json({ error: "cardId is required" }, { status: 400 });
    }
    if (!VALID_GRADERS.includes(grader as (typeof VALID_GRADERS)[number])) {
      return NextResponse.json({ error: `grader must be one of ${VALID_GRADERS.join(", ")}` }, { status: 400 });
    }
    if (!Number.isFinite(topGradePop) || topGradePop < 0) {
      return NextResponse.json({ error: "topGradePop must be a non-negative number" }, { status: 400 });
    }
    if (!Number.isFinite(totalPop) || totalPop <= 0) {
      return NextResponse.json({ error: "totalPop must be a positive number" }, { status: 400 });
    }
    if (topGradePop > totalPop) {
      return NextResponse.json({ error: "topGradePop can't exceed totalPop" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("gem_rates")
      .insert({
        card_id: cardId,
        grader,
        top_grade_pop: topGradePop,
        total_pop: totalPop,
        manually_entered: true,
      })
      .select("id, grader, top_grade_pop, total_pop, gem_rate, manually_entered, scraped_at")
      .single();

    if (error) {
      if (error.message.includes("manually_entered")) {
        return NextResponse.json(
          {
            error:
              "gem_rates.manually_entered doesn't exist yet -- run the migration in supabase/schema.sql first.",
          },
          { status: 500 }
        );
      }
      return NextResponse.json({ error: `Failed to save: ${error.message}` }, { status: 500 });
    }

    return NextResponse.json({ rate: data });
  } catch (err) {
    return NextResponse.json({ error: `Unexpected server error: ${errorMessage(err)}` }, { status: 500 });
  }
}
