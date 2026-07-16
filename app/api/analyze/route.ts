/**
 * POST /api/analyze
 *
 * Auth-gated card analysis endpoint.
 *
 * Flow:
 * 1. Verify the user is logged in
 * 2. Check scan allowance (free: 3/month, pro: unlimited)
 * 3. Upload up to 10 labeled card images to Supabase Storage
 * 4. Run Claude vision analysis across all images in one call
 * 5. Pull market data + gem rates
 * 6. Run ROI engine
 * 7. Save scan record to DB
 * 8. Increment scan counter
 * 9. Return full recommendation
 *
 * Every branch below returns NextResponse.json(...) -- including the
 * top-level catch -- so a client-side `await res.json()` never chokes on
 * a non-JSON response (an HTML error page, a platform-level error, etc.)
 * from this route itself. Each stage's error is prefixed so it's obvious
 * whether Anthropic, Supabase, or the ROI engine is what failed.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { analyzeCardImages, CardImageInput } from "@/lib/visionAnalysis";
import { getCardMarketData, getCardGemRates } from "@/lib/mockDataService";
import { getGraderRecommendations, VisionAssessment } from "@/lib/roiEngine";
import { checkScanAllowance, recordScanUsed } from "@/lib/scanGating";

const REQUIRED_LABELS = ["Front Full", "Back Full"];

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function POST(request: NextRequest) {
  try {
    const supabase = createClient();

    // ── 1. Auth check ────────────────────────────────────────────────────────
    let user;
    try {
      const {
        data: { user: authedUser },
        error: authError,
      } = await supabase.auth.getUser();

      if (authError || !authedUser) {
        return NextResponse.json(
          { error: "Not authenticated. Please sign in to analyze cards." },
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

    // ── 2. Scan allowance check ──────────────────────────────────────────────
    let allowance;
    try {
      allowance = await checkScanAllowance(supabase, user.id);
    } catch (err) {
      return NextResponse.json(
        { error: `Supabase scan allowance check failed: ${errorMessage(err)}` },
        { status: 502 }
      );
    }

    if (!allowance.allowed) {
      return NextResponse.json(
        {
          error: allowance.reason,
          scansUsed: allowance.scansUsed,
          scansLimit: allowance.scansLimit,
          upgradeUrl: "/upgrade",
        },
        { status: 402 } // Payment Required -- semantically accurate here
      );
    }

    // ── 3. Parse request body ────────────────────────────────────────────────
    let body: { images?: CardImageInput[]; cardName?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    const { images, cardName } = body;

    if (!images || images.length === 0 || !cardName) {
      return NextResponse.json(
        { error: "Missing required fields: images and cardName" },
        { status: 400 }
      );
    }

    if (images.length > 10) {
      return NextResponse.json(
        { error: "A maximum of 10 card photos is supported per analysis" },
        { status: 400 }
      );
    }

    const missingRequired = REQUIRED_LABELS.filter(
      (label) => !images.some((image) => image.label === label)
    );
    if (missingRequired.length > 0) {
      return NextResponse.json(
        { error: `Missing required photos: ${missingRequired.join(", ")}` },
        { status: 400 }
      );
    }

    // ── 4. Upload images to Supabase Storage ─────────────────────────────────
    const imageUrls: string[] = [];
    for (const image of images) {
      try {
        const imageBuffer = Buffer.from(image.base64, "base64");
        const fileName = `${user.id}/${Date.now()}-${image.label.toLowerCase().replace(/\s+/g, "-")}.jpg`;
        const { data: storageData, error: storageError } = await supabase.storage
          .from("card-images")
          .upload(fileName, imageBuffer, {
            contentType: image.mediaType || "image/jpeg",
            upsert: false,
          });

        if (!storageError && storageData) {
          const { data: urlData } = supabase.storage
            .from("card-images")
            .getPublicUrl(storageData.path);
          imageUrls.push(urlData.publicUrl);
        }
        // Non-fatal: if storage fails for one photo, analysis still proceeds --
        // we just won't have that image saved in the scan record history.
      } catch {
        // Storage failure is non-fatal -- continue with analysis
      }
    }

    // ── 5. Vision analysis ───────────────────────────────────────────────────
    let visionResult;
    try {
      visionResult = await analyzeCardImages(images);
    } catch (err) {
      return NextResponse.json(
        { error: `Anthropic vision analysis failed: ${errorMessage(err)}` },
        { status: 502 }
      );
    }

    // ── 6. Market data + gem rates ───────────────────────────────────────────
    let marketData, gemRates;
    try {
      [marketData, gemRates] = await Promise.all([
        getCardMarketData(cardName),
        getCardGemRates(cardName),
      ]);
    } catch (err) {
      return NextResponse.json(
        { error: `Market data lookup failed: ${errorMessage(err)}` },
        { status: 502 }
      );
    }

    // ── 7. ROI engine ─────────────────────────────────────────────────────────
    // The ROI engine takes a single centering value; use the worse of the
    // independently-scored front/back centering, consistent with its
    // "worse side's percentage" semantics.
    const centeringPct = Math.max(visionResult.frontCenteringPct, visionResult.backCenteringPct);

    const visionAssessment: VisionAssessment = {
      centeringPct,
      surfaceScore: visionResult.surfaceScore,
      edgeScore: visionResult.edgeScore,
      cornerScore: visionResult.cornerScore,
      overallScore: visionResult.overallScore,
    };

    let recommendation;
    try {
      recommendation = getGraderRecommendations(marketData, gemRates, visionAssessment);
    } catch (err) {
      return NextResponse.json(
        { error: `ROI engine calculation failed: ${errorMessage(err)}` },
        { status: 500 }
      );
    }

    // ── 8. Save scan record ──────────────────────────────────────────────────
    try {
      await supabase.from("scans").insert({
        user_id: user.id,
        image_urls: imageUrls,
        vision_centering_pct: centeringPct,
        vision_surface_score: visionResult.surfaceScore,
        vision_edge_score: visionResult.edgeScore,
        vision_corner_score: visionResult.cornerScore,
        vision_overall_score: visionResult.overallScore,
        vision_notes: visionResult.notes,
        vision_grade_probs: {},
        worst_zone: visionResult.worstZone,
        asymmetric_wear_flag: visionResult.asymmetricWearFlag,
        recommendation: recommendation as unknown as Record<string, unknown>,
      });
    } catch {
      // Scan save failure is non-fatal -- return results anyway
    }

    // ── 9. Increment scan counter ────────────────────────────────────────────
    try {
      await recordScanUsed(supabase, user.id);
    } catch {
      // Counter increment failure is non-fatal -- return results anyway
    }

    // ── 10. Return results ────────────────────────────────────────────────────
    return NextResponse.json({
      vision: visionResult,
      market: marketData,
      gemRates,
      recommendation,
      meta: {
        scansUsed: allowance.scansUsed + 1,
        scansLimit: allowance.scansLimit,
        tier: allowance.tier,
      },
    });
  } catch (err) {
    // Last-resort catch-all: guarantees this route always responds with
    // JSON, even for an error type none of the stages above anticipated.
    return NextResponse.json(
      { error: `Unexpected server error: ${errorMessage(err)}` },
      { status: 500 }
    );
  }
}
