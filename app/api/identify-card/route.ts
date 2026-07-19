/**
 * POST /api/identify-card
 *
 * Fast card auto-identification, called immediately when the user
 * uploads the front photo on the scan form -- well before they've
 * necessarily added a back photo or clicked "Run analysis". Returns
 * name/set/card number/language/variant so the form can auto-fill
 * itself, with a confidence rating the UI uses to flag fields that
 * still need the user's eyes on them.
 *
 * Deliberately separate from POST /api/analyze:
 * - Auth-gated (so this can't be hit anonymously to run up Anthropic
 *   API costs), but does NOT consume scan allowance -- identifying a
 *   card is a lightweight preview step, not a full analysis, and
 *   charging a scan for it would be unfair to free-tier users who
 *   upload a photo, see the auto-fill, then decide not to run the
 *   full analysis.
 * - Takes exactly one photo (the front), not the full up-to-10-photo
 *   set analyzeCardCondition() takes.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { identifyCard, CardImageInput } from "@/lib/visionAnalysis";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function POST(request: NextRequest) {
  try {
    const supabase = createClient();

    let user;
    try {
      const {
        data: { user: authedUser },
        error: authError,
      } = await supabase.auth.getUser();

      if (authError || !authedUser) {
        return NextResponse.json(
          { error: "Not authenticated. Please sign in to identify cards." },
          { status: 401 }
        );
      }
      user = authedUser;
    } catch (err) {
      return NextResponse.json(
        { error: `Supabase auth check failed: ${errorMessage(err)}` },
        { status: 502 }
      );
    }
    void user; // only needed for the auth check itself -- not used further

    let body: { image?: CardImageInput };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    if (!body.image?.base64 || !body.image?.mediaType) {
      return NextResponse.json({ error: "Missing required field: image" }, { status: 400 });
    }

    try {
      const identification = await identifyCard(body.image);
      return NextResponse.json({ identification });
    } catch (err) {
      return NextResponse.json(
        { error: `Card identification failed: ${errorMessage(err)}` },
        { status: 502 }
      );
    }
  } catch (err) {
    return NextResponse.json(
      { error: `Unexpected server error: ${errorMessage(err)}` },
      { status: 500 }
    );
  }
}
