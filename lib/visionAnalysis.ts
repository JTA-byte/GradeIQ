/**
 * Card vision analysis using the Claude API. Two separate calls:
 *
 * - identifyCard(): fast, single-image call against just the front photo --
 *   fires immediately on upload (see app/api/identify-card/route.ts) so the
 *   scan form can auto-fill name/set/number/language/variant before the
 *   user has even finished picking photos.
 * - analyzeCardCondition(): the condition assessment, taking up to 10
 *   labeled photos (full front/back plus optional corner close-ups) in a
 *   single call. Front Full is the only strictly required photo now --
 *   everything else (Back Full, the 8 close-ups) improves accuracy but
 *   isn't required to run an analysis.
 *
 * Both can run in parallel once the user clicks "Run analysis": the
 * frontend already has identifyCard()'s result from upload time and sends
 * it straight to /api/analyze, which never re-identifies the card itself.
 */
import sharp from "sharp";
import { CardLanguage, CARD_LANGUAGES } from "./cardLanguage";
import { CardVariant, CARD_VARIANTS } from "./cardVariant";

export interface CardImageInput {
  label: string;
  base64: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp";
}

// Claude's vision API rejects images with a dimension over 8000px. Resizing
// down to 1500px on the longest side keeps ample detail for grading while
// staying well under that limit.
const MAX_DIMENSION = 1500;

async function resizeImage(image: CardImageInput): Promise<CardImageInput> {
  const inputBuffer = Buffer.from(image.base64, "base64");
  const resizedBuffer = await sharp(inputBuffer)
    .resize({
      width: MAX_DIMENSION,
      height: MAX_DIMENSION,
      fit: "inside",
      withoutEnlargement: true,
    })
    .toBuffer();

  return {
    ...image,
    base64: resizedBuffer.toString("base64"),
  };
}

export interface VisionAnalysisResult {
  frontCenteringPct: number;
  backCenteringPct: number;
  surfaceScore: number;
  edgeScore: number;
  cornerScore: number;
  overallScore: number;
  notes: string;
  confidence: "low" | "medium" | "high";
  asymmetricWearFlag: boolean;
  worstZone: string;
}

const SYSTEM_PROMPT = `You are an expert Pokémon TCG card grader with deep knowledge of PSA, CGC, and BGS grading standards. You analyze up to 10 labeled photos of a single card -- a full front shot (always present), an optional full back shot, and up to 8 optional close-ups of each corner/quadrant (e.g. "Front Top-Left", "Back Bottom-Right") -- and provide one objective condition assessment for the card as a whole.

Reason across all supplied photos together rather than scoring each in isolation:
- Use the full front and back photos to judge overall surface condition and to calculate centering.
- Calculate front centering and back centering independently -- they often differ.
- If no "Back Full" photo was supplied, you cannot assess the back directly -- report back_centering_pct equal to your front centering estimate as a neutral placeholder, lower your overall confidence rating, and say explicitly in your notes that the back wasn't assessed.
- Weight the corner close-up photos heavily when scoring corners: a sharp close-up of a corner is much more reliable evidence than what you can see of that same corner in the full-card shot. If a close-up is missing for a corner, rely on the full shots for that corner but note the lower confidence.
- Look across ALL corners (from both close-ups and full shots) for asymmetric wear -- e.g. one corner noticeably softer/more rounded or whitened than the other three. This kind of localized damage is common and should be called out explicitly, since it can sink an otherwise gem-quality card.

Be conservative and realistic in your scoring. Most cards are NOT gem mint. Surface scratches, whitening on edges, and centering issues are common and should be scored accordingly. A score of 9-10 should be reserved for cards that genuinely look pristine across all supplied photos.

You must respond with ONLY valid JSON in this exact format, with no other text:
{
  "front_centering_pct": <number, the worse side's percentage for the FRONT, e.g. 60 means a 60/40 centering>,
  "back_centering_pct": <number, the worse side's percentage for the BACK>,
  "surface_score": <number 1-10>,
  "edge_score": <number 1-10>,
  "corner_score": <number 1-10, weighted heavily toward corner close-up photos when present>,
  "overall_score": <number 1-10, your holistic blended assessment>,
  "notes": "<2-3 sentence explanation of what you observed and why you scored it this way>",
  "confidence": "<low, medium, or high -- how confident you are given image quality/angle/lighting and how many close-ups were supplied>",
  "asymmetric_wear_flag": <boolean, true if one zone (a specific corner, edge, or region) is meaningfully worse than the rest of the card>,
  "worst_zone": "<short label for the single worst zone on the card, e.g. 'Back Bottom-Right corner', or \\"none\\" if condition is even across the card>"
}`;

export async function analyzeCardCondition(
  images: CardImageInput[]
): Promise<VisionAnalysisResult> {
  if (images.length === 0) {
    throw new Error("At least one card photo is required for vision analysis");
  }
  if (images.length > 10) {
    throw new Error("A maximum of 10 card photos is supported per analysis");
  }

  const resizedImages = await Promise.all(images.map(resizeImage));

  const content = resizedImages.flatMap((image) => [
    { type: "text" as const, text: `Photo: ${image.label}` },
    {
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: image.mediaType,
        data: image.base64,
      },
    },
  ]);

  content.push({
    type: "text" as const,
    text: "Analyze this Pokémon card's condition for grading purposes using all the labeled photos above, considered together. Respond with only the JSON object.",
  });

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1200,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const textBlock = data.content?.find((block: { type: string }) => block.type === "text");

  if (!textBlock) {
    throw new Error("No text response from vision model");
  }

  let parsed: {
    front_centering_pct: number;
    back_centering_pct: number;
    surface_score: number;
    edge_score: number;
    corner_score: number;
    overall_score: number;
    notes: string;
    confidence: "low" | "medium" | "high";
    asymmetric_wear_flag: boolean;
    worst_zone: string;
  };

  try {
    const cleaned = textBlock.text.replace(/```json|```/g, "").trim();
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Failed to parse vision model response as JSON: ${textBlock.text}`);
  }

  return {
    frontCenteringPct: parsed.front_centering_pct,
    backCenteringPct: parsed.back_centering_pct,
    surfaceScore: parsed.surface_score,
    edgeScore: parsed.edge_score,
    cornerScore: parsed.corner_score,
    overallScore: parsed.overall_score,
    notes: parsed.notes,
    confidence: parsed.confidence,
    asymmetricWearFlag: parsed.asymmetric_wear_flag,
    worstZone: parsed.worst_zone,
  };
}

export interface CardIdentification {
  name: string;
  setName: string;
  cardNumber: string;
  language: CardLanguage;
  variant: CardVariant;
  variantDetail: string | null;
  confidence: "low" | "medium" | "high";
}

const IDENTIFY_SYSTEM_PROMPT = `You are an expert at identifying Pokémon TCG cards from a single photo.

Identify this Pokémon card. Return JSON with:
- name: the card name as printed (e.g. "Charizard")
- set_name: the set name as printed, or unmistakably identifiable from the card's set symbol/layout (e.g. "Base Set", "Evolving Skies")
- card_number: the number printed in the bottom corner, in its exact printed form (e.g. "53/108", "SWSH001")
- language: one of "English", "Japanese", "Korean", "Chinese"
- variant: one of "Normal", "Holo", "Non-Holo", "Reverse Holo", "First Edition", "Shadowless", "No Symbol", "Stamped", "Promo", "Full Art", "Special Illustration Rare", "Hyper Rare", "Secret Rare"
- variant_detail: the stamp type (e.g. "Prerelease", "Staff", "League") if variant is "Stamped", or the promo number (e.g. "SWSH001") if variant is "Promo" -- null for every other variant
- confidence: "high", "medium", or "low", reflecting how certain you are given this photo's clarity, angle, and how legible the printed text/symbols are

If a field isn't fully legible, make your best-guess reading rather than leaving it blank, and lower the confidence rating accordingly.

Respond with ONLY valid JSON in this exact format, no other text:
{
  "name": "<string>",
  "set_name": "<string>",
  "card_number": "<string>",
  "language": "<English|Japanese|Korean|Chinese>",
  "variant": "<Normal|Holo|Non-Holo|Reverse Holo|First Edition|Shadowless|No Symbol|Stamped|Promo|Full Art|Special Illustration Rare|Hyper Rare|Secret Rare>",
  "variant_detail": "<string or null>",
  "confidence": "<high|medium|low>"
}`;

/**
 * Fast, single-image identification call -- fires as soon as the user
 * uploads the front photo (see app/api/identify-card/route.ts), well
 * before they've necessarily added a back photo or clicked "Run
 * analysis". Deliberately separate from analyzeCardCondition() above:
 * this only needs one photo and a small response, so it returns much
 * faster than waiting on the full condition assessment.
 */
export async function identifyCard(image: CardImageInput): Promise<CardIdentification> {
  const resized = await resizeImage(image);

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 400,
      system: IDENTIFY_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image" as const,
              source: {
                type: "base64" as const,
                media_type: resized.mediaType,
                data: resized.base64,
              },
            },
            { type: "text" as const, text: "Identify this card. Respond with only the JSON object." },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const textBlock = data.content?.find((block: { type: string }) => block.type === "text");

  if (!textBlock) {
    throw new Error("No text response from identification model");
  }

  let parsed: {
    name: string;
    set_name: string;
    card_number: string;
    language: string;
    variant: string;
    variant_detail: string | null;
    confidence: "low" | "medium" | "high";
  };

  try {
    const cleaned = textBlock.text.replace(/```json|```/g, "").trim();
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Failed to parse identification response as JSON: ${textBlock.text}`);
  }

  // Validate the model's language/variant against our own known lists
  // rather than trusting free-form text -- falls back to sensible
  // defaults (and a lowered confidence) instead of propagating a value
  // the rest of the app doesn't recognize.
  const language = CARD_LANGUAGES.includes(parsed.language as CardLanguage)
    ? (parsed.language as CardLanguage)
    : "English";
  const variant = CARD_VARIANTS.includes(parsed.variant as CardVariant)
    ? (parsed.variant as CardVariant)
    : "Normal";
  const confidenceDowngraded = language !== parsed.language || variant !== parsed.variant;

  return {
    name: parsed.name,
    setName: parsed.set_name,
    cardNumber: parsed.card_number,
    language,
    variant,
    variantDetail: parsed.variant_detail || null,
    confidence: confidenceDowngraded ? "low" : parsed.confidence,
  };
}
