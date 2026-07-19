/**
 * POST /api/analyze
 *
 * Auth-gated card analysis endpoint.
 *
 * Flow:
 * 1. Verify the user is logged in
 * 2. Check scan allowance (free: 3/month, pro: unlimited)
 * 3. Upload up to 10 labeled card images to Supabase Storage
 * 4. Run Claude's condition assessment across all supplied images in one
 *    call (Front Full is the only strictly required photo -- Back Full
 *    and the 8 close-ups improve accuracy but aren't required)
 * 5. Resolve the card's identity (name + set + card number + language +
 *    variant) to a real cards row, then pull market data + gem rates
 *    against it -- using the identity the frontend already auto-filled
 *    via POST /api/identify-card at upload time (or the user's manual
 *    edits to it). This route never re-identifies the card itself.
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
import { analyzeCardCondition, CardImageInput } from "@/lib/visionAnalysis";
import { getCardMarketData, getCardGemRates } from "@/lib/mockDataService";
import { CARD_LANGUAGES, CardLanguage, resolveOrCreateCard } from "@/lib/cardIdentifier";
import { CARD_VARIANTS, CardVariant, variantNeedsDetail } from "@/lib/cardVariant";
import { enrichCardFromPokemonTCGApi } from "@/lib/dynamicCardLookup";
import {
  GRADERS,
  calculateMaxBuyPrice,
  deriveGradeProbabilities,
  getGraderRecommendations,
  VisionAssessment,
} from "@/lib/roiEngine";
import { checkScanAllowance, recordScanUsed } from "@/lib/scanGating";

const REQUIRED_LABELS = ["Front Full"];

interface CardIdentifierInput {
  name?: string;
  setName?: string;
  cardNumber?: string;
  language?: string;
  variant?: string;
  variantDetail?: string;
}

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
    let body: { images?: CardImageInput[]; card?: CardIdentifierInput };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    const { images, card: cardInput } = body;

    const cardName = cardInput?.name?.trim();
    const setName = cardInput?.setName?.trim();
    const cardNumber = cardInput?.cardNumber?.trim();
    const language = (cardInput?.language?.trim() || "English") as CardLanguage;
    const variant = (cardInput?.variant?.trim() || "Normal") as CardVariant;
    const variantDetail = cardInput?.variantDetail?.trim() || undefined;

    if (!images || images.length === 0 || !cardName || !setName || !cardNumber) {
      return NextResponse.json(
        {
          error:
            "Missing required fields: images, card.name, card.setName, and card.cardNumber are all required",
        },
        { status: 400 }
      );
    }

    if (!CARD_LANGUAGES.includes(language)) {
      return NextResponse.json(
        { error: `Invalid card.language "${language}" -- must be one of ${CARD_LANGUAGES.join(", ")}` },
        { status: 400 }
      );
    }

    if (!CARD_VARIANTS.includes(variant)) {
      return NextResponse.json(
        { error: `Invalid card.variant "${variant}" -- must be one of ${CARD_VARIANTS.join(", ")}` },
        { status: 400 }
      );
    }

    if (variantNeedsDetail(variant) && !variantDetail) {
      return NextResponse.json(
        {
          error:
            variant === "Promo"
              ? "card.variantDetail (promo number, e.g. SWSH001) is required when card.variant is \"Promo\""
              : "card.variantDetail (stamp type, e.g. Prerelease) is required when card.variant is \"Stamped\"",
        },
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
      visionResult = await analyzeCardCondition(images);
    } catch (err) {
      return NextResponse.json(
        { error: `Anthropic vision analysis failed: ${errorMessage(err)}` },
        { status: 502 }
      );
    }

    // ── 6. Resolve card identity, then market data + gem rates ───────────────
    // Matched by name + set + card number + language + variant, not just
    // a bare name -- see lib/cardIdentifier.ts for why that matters (a
    // name alone matches too many printings for accurate pricing
    // lookups).
    let resolvedCard;
    try {
      resolvedCard = await resolveOrCreateCard({
        name: cardName,
        setName,
        cardNumber,
        language,
        variant,
        variantDetail,
      });
    } catch (err) {
      return NextResponse.json(
        { error: `Card identity lookup failed: ${errorMessage(err)}` },
        { status: 502 }
      );
    }

    // TEMPORARY DEBUG LOGGING -- tracking down a "$0 raw price" report.
    // Remove once the root cause is confirmed fixed in production.
    console.log(
      `[analyze][debug] resolved card: id=${resolvedCard.id} isNew=${resolvedCard.isNew} ` +
        `identity="${cardName}" / "${setName}" #${cardNumber} (${language}, ${variant}${variantDetail ? " " + variantDetail : ""})`
    );

    let marketData, gemRates;
    try {
      [marketData, gemRates] = await Promise.all([
        getCardMarketData({
          cardId: resolvedCard.id,
          cardName,
          setName,
          cardNumber,
          variant,
          variantDetail,
        }),
        getCardGemRates(cardName, setName),
      ]);
    } catch (err) {
      return NextResponse.json(
        { error: `Market data lookup failed: ${errorMessage(err)}` },
        { status: 502 }
      );
    }

    // TEMPORARY DEBUG LOGGING -- tracking down a "$0 raw price" report.
    // Remove once the root cause is confirmed fixed in production.
    console.log("[analyze][debug] final marketData returned to client:", {
      rawCost: marketData.rawCost,
      rawMarketPrice: marketData.rawMarketPrice,
      priceConfidence: marketData.priceConfidence,
      rawPriceSource: marketData.rawPriceSource,
      rawPriceLabel: marketData.rawPriceLabel,
    });

    // A brand-new cards row has no rarity yet -- best-effort backfill from
    // the Pokemon TCG API. Non-fatal (enrichCardFromPokemonTCGApi swallows
    // its own errors) and doesn't affect this request's own marketData,
    // which was already computed above from the user's own identity
    // fields regardless of whether this succeeds.
    if (resolvedCard.isNew) {
      await enrichCardFromPokemonTCGApi(resolvedCard.id, cardName);
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

    // Max buy price: the most you could pay raw and still hit a 50% net
    // ROI target with the best-passing grader. Null when no grader clears
    // the vision confidence gate -- there's no "right price" for a copy
    // this app doesn't think is worth grading in the first place.
    let maxBuyPrice: number | null = null;
    if (recommendation.bestOption) {
      const bestGraderConfig = GRADERS.find((g) => g.id === recommendation.bestOption!.grader);
      if (bestGraderConfig) {
        const gemRate = gemRates[recommendation.bestOption.grader];
        const probs = deriveGradeProbabilities(gemRate, visionResult.overallScore);
        maxBuyPrice = calculateMaxBuyPrice({
          grader: bestGraderConfig,
          gradeProbabilities: probs,
          topGradePrice: marketData.topGradePrice,
          midGradePrice: marketData.midGradePrice,
          belowGradePrice: marketData.rawMarketPrice * 0.85,
          shippingRoundTrip: marketData.shippingRoundTrip,
        });
      }
    }

    // ── 8. Save scan record ──────────────────────────────────────────────────
    try {
      await supabase.from("scans").insert({
        user_id: user.id,
        card_id: resolvedCard.id,
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
      maxBuyPrice,
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
