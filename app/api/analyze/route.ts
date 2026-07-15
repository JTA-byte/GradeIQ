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
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { analyzeCardImages, CardImageInput } from "@/lib/visionAnalysis";
import { getCardMarketData, getCardGemRates } from "@/lib/mockDataService";
import { getGraderRecommendations, VisionAssessment } from "@/lib/roiEngine";
import { checkScanAllowance, recordScanUsed } from "@/lib/scanGating";

const REQUIRED_LABELS = ["Front Full", "Back Full"];

export async function POST(request: NextRequest) {
  const supabase = createClient();

  // ── 1. Auth check ──────────────────────────────────────────────────────────
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json(
      { error: "Not authenticated. Please sign in to analyze cards." },
      { status: 401 }
    );
  }

  // ── 2. Scan allowance check ────────────────────────────────────────────────
  const allowance = await checkScanAllowance(supabase, user.id);

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

  // ── 3. Parse request body ──────────────────────────────────────────────────
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

  // ── 4. Upload images to Supabase Storage ───────────────────────────────────
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

  // ── 5. Vision analysis ─────────────────────────────────────────────────────
  let visionResult;
  try {
    visionResult = await analyzeCardImages(images);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Vision analysis failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  // ── 6. Market data + gem rates ─────────────────────────────────────────────
  const [marketData, gemRates] = await Promise.all([
    getCardMarketData(cardName),
    getCardGemRates(cardName),
  ]);

  // ── 7. ROI engine ──────────────────────────────────────────────────────────
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

  const recommendation = getGraderRecommendations(marketData, gemRates, visionAssessment);

  // ── 8. Save scan record ────────────────────────────────────────────────────
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

  // ── 9. Increment scan counter ──────────────────────────────────────────────
  await recordScanUsed(supabase, user.id);

  // ── 10. Return results ─────────────────────────────────────────────────────
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
}
