"use client";

import { useEffect, useRef, useState } from "react";
import { AppHeader } from "@/components/AppHeader";
import { AppFooter } from "@/components/AppFooter";
import { GraderSlab } from "@/components/GraderSlab";
import type { FullRecommendation } from "@/lib/roiEngine";
import { ebayRawSoldListingsUrl } from "@/lib/ebayLink";
import { CARD_LANGUAGES, CardLanguage } from "@/lib/cardLanguage";

interface CardSuggestion {
  id: string;
  name: string;
  set_name: string;
  card_number: string | null;
  language: string | null;
}

interface SlotDef {
  key: string;
  label: string;
  required: boolean;
}

const SLOTS: SlotDef[] = [
  { key: "front_full", label: "Front Full", required: true },
  { key: "front_top_left", label: "Front Top-Left", required: false },
  { key: "front_top_right", label: "Front Top-Right", required: false },
  { key: "front_bottom_left", label: "Front Bottom-Left", required: false },
  { key: "front_bottom_right", label: "Front Bottom-Right", required: false },
  { key: "back_full", label: "Back Full", required: true },
  { key: "back_top_left", label: "Back Top-Left", required: false },
  { key: "back_top_right", label: "Back Top-Right", required: false },
  { key: "back_bottom_left", label: "Back Bottom-Left", required: false },
  { key: "back_bottom_right", label: "Back Bottom-Right", required: false },
];

interface SlotImage {
  preview: string;
  base64: string;
  mediaType: string;
}

// Vercel serverless functions cap request bodies at 4.5MB. Base64 inflates
// raw bytes by ~33%, so 10 photos at 1500px (the old ceiling) could total
// ~4MB of raw JPEG -- comfortably over budget once base64-encoded, even
// though the resize itself was "working". 1000px cuts pixel area by ~56%
// vs. 1500px, giving real headroom instead of just barely fitting.
const MAX_DIMENSION = 1000;
const JPEG_QUALITY = 0.9;

function resizeImageFile(file: File): Promise<{ dataUrl: string; mediaType: string }> {
  return new Promise((resolve, reject) => {
    // Object URLs decode more reliably than FileReader data URLs on mobile
    // Safari/Chrome for large camera photos (no intermediate base64 blowup
    // just to hand the bytes to an <img>), and are revoked immediately
    // after the canvas has read them so nothing lingers in memory.
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Failed to load photo -- try a different photo or browser"));
    };

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);

      if (!img.width || !img.height) {
        reject(new Error("Photo loaded with no dimensions -- try a different photo"));
        return;
      }

      const scale = Math.min(1, MAX_DIMENSION / Math.max(img.width, img.height));
      const width = Math.round(img.width * scale);
      const height = Math.round(img.height * scale);

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Canvas not supported in this browser"));
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);

      const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
      if (!dataUrl || dataUrl === "data:,") {
        reject(new Error("Resize produced an empty image -- try a different photo"));
        return;
      }

      resolve({ dataUrl, mediaType: "image/jpeg" });
    };

    img.src = objectUrl;
  });
}

interface AnalysisResponse {
  vision: {
    frontCenteringPct: number;
    backCenteringPct: number;
    surfaceScore: number;
    edgeScore: number;
    cornerScore: number;
    overallScore: number;
    notes: string;
    confidence: string;
    asymmetricWearFlag: boolean;
    worstZone: string;
  };
  market: {
    rawCost: number;
    rawMarketPrice: number;
    topGradePrice: number;
    midGradePrice: number;
    priceConfidence: "high" | "medium" | "low";
    rawPriceSource: "tcgplayer" | "pricecharting" | "mock";
    rawPriceLabel: string;
  };
  recommendation: FullRecommendation;
  maxBuyPrice: number | null;
  meta?: {
    scansUsed: number;
    scansLimit: number;
    tier: string;
  };
}

const PRICE_CONFIDENCE_STYLE: Record<"high" | "medium" | "low", string> = {
  high: "text-moss",
  medium: "text-ink",
  low: "text-rust",
};

function verdictStyle(verdict: string): { label: string; className: string } {
  switch (verdict) {
    case "grade":
      return { label: "Grade it", className: "bg-moss text-paper" };
    case "conditional":
      return { label: "Conditional — proceed with care", className: "bg-gold text-ink" };
    case "sell_raw":
      return { label: "Sell raw", className: "bg-rust text-paper" };
    case "no_grade":
      return { label: "Do not grade", className: "bg-rust text-paper" };
    default:
      return { label: verdict, className: "bg-slate text-paper" };
  }
}

export default function ScanPage() {
  const [cardName, setCardName] = useState("");
  const [setName, setSetName] = useState("");
  const [cardNumber, setCardNumber] = useState("");
  const [language, setLanguage] = useState<CardLanguage>("English");
  const [suggestions, setSuggestions] = useState<CardSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [slotImages, setSlotImages] = useState<Record<string, SlotImage | undefined>>({});
  const [activeSlot, setActiveSlot] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; isLimit?: boolean } | null>(null);
  const [result, setResult] = useState<AnalysisResponse | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const hasRequiredCardFields = Boolean(cardName.trim() && setName.trim() && cardNumber.trim());

  // Debounced autocomplete: look up matching cards as the user types a
  // name/set, so they can pick the exact printing (and auto-fill its
  // card number) instead of hunting for it on the card themselves.
  useEffect(() => {
    if (cardName.trim().length < 2 && setName.trim().length < 2) {
      setSuggestions([]);
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(async () => {
      try {
        const params = new URLSearchParams();
        if (cardName.trim()) params.set("name", cardName.trim());
        if (setName.trim()) params.set("set", setName.trim());
        const res = await fetch(`/api/cards/search?${params}`, { signal: controller.signal });
        if (!res.ok) return;
        const data = await res.json();
        setSuggestions(data.cards ?? []);
      } catch {
        // Autocomplete failing silently is fine -- the user can still
        // type the card number by hand.
      }
    }, 300);

    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, [cardName, setName]);

  function applySuggestion(suggestion: CardSuggestion) {
    setCardName(suggestion.name);
    setSetName(suggestion.set_name);
    setCardNumber(suggestion.card_number ?? "");
    if (suggestion.language && (CARD_LANGUAGES as string[]).includes(suggestion.language)) {
      setLanguage(suggestion.language as CardLanguage);
    }
    setShowSuggestions(false);
  }

  const uploadedCount = SLOTS.filter((slot) => slotImages[slot.key]).length;
  const hasRequiredPhotos = SLOTS.filter((slot) => slot.required).every(
    (slot) => slotImages[slot.key]
  );

  function openSlot(key: string) {
    setActiveSlot(key);
    fileInputRef.current?.click();
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    const slotKey = activeSlot;
    e.target.value = "";
    if (!file || !slotKey) return;

    try {
      const { dataUrl, mediaType } = await resizeImageFile(file);
      setSlotImages((prev) => ({
        ...prev,
        [slotKey]: { preview: dataUrl, base64: dataUrl.split(",")[1], mediaType },
      }));
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : "Could not process that photo" });
    }
  }

  async function handleAnalyze() {
    if (!hasRequiredPhotos || !hasRequiredCardFields) {
      setError({
        message:
          "Please upload at least the Front Full and Back Full photos, and fill in card name, set name, and card number.",
      });
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);

    const images = SLOTS.filter((slot) => slotImages[slot.key]).map((slot) => ({
      label: slot.label,
      base64: slotImages[slot.key]!.base64,
      mediaType: slotImages[slot.key]!.mediaType,
    }));

    const requestBody = JSON.stringify({
      images,
      card: { name: cardName, setName, cardNumber, language },
    });

    // Logs to the browser console so a payload that's still too large shows
    // up immediately, rather than only surfacing as a cryptic 413 from
    // Vercel after the fact. Blob.size gives the actual byte length
    // (requestBody.length undercounts for any multi-byte characters).
    const payloadBytes = new Blob([requestBody]).size;
    const perImageBytes = images.map((img) => ({
      label: img.label,
      kb: Math.round((img.base64.length * 0.75) / 1024),
    }));
    console.log(
      `[analyze] request payload: ${(payloadBytes / 1024 / 1024).toFixed(2)}MB total, ` +
        `${images.length} photos`,
      perImageBytes
    );
    if (payloadBytes > 4.5 * 1024 * 1024) {
      console.warn(
        `[analyze] payload (${(payloadBytes / 1024 / 1024).toFixed(2)}MB) exceeds Vercel's 4.5MB ` +
          "request body limit -- this request will likely fail with 413."
      );
    }

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: requestBody,
      });

      if (res.status === 401) {
        window.location.href = "/auth/login";
        return;
      }

      if (res.status === 402) {
        const data = await res.json();
        setError({ message: data.error, isLimit: true });
        setLoading(false);
        return;
      }

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Analysis failed");
      }

      const data: AnalysisResponse = await res.json();
      setResult(data);
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : "Something went wrong" });
    } finally {
      setLoading(false);
    }
  }

  const verdict = result ? verdictStyle(result.recommendation.verdict) : null;

  return (
    <main className="min-h-screen bg-paper text-ink font-body">
      <AppHeader />

      <div className="max-w-4xl mx-auto px-6 py-10">
        {/* Upload + card name */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
          <section>
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="font-display text-lg">1. Upload your card</h2>
              <span className="font-mono text-xs text-slate/70">
                {uploadedCount}/{SLOTS.length} photos added
              </span>
            </div>
            <div className="grid grid-cols-5 gap-2">
              {SLOTS.map((slot) => {
                const image = slotImages[slot.key];
                return (
                  <div key={slot.key} className="flex flex-col items-center">
                    <button
                      type="button"
                      onClick={() => openSlot(slot.key)}
                      className={`w-full aspect-[3/4] border-2 flex items-center justify-center overflow-hidden bg-white/40 transition-colors ${
                        image
                          ? "border-moss"
                          : slot.required
                          ? "border-dashed border-rust/60 hover:border-rust"
                          : "border-dashed border-line hover:border-moss"
                      }`}
                    >
                      {image ? (
                        <img
                          src={image.preview}
                          alt={slot.label}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <span className="font-mono text-[10px] text-slate/60 px-1 text-center leading-tight">
                          +
                        </span>
                      )}
                    </button>
                    <span className="font-mono text-[10px] text-slate/70 mt-1 text-center leading-tight">
                      {slot.label}
                      {slot.required && <span className="text-rust">*</span>}
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="font-mono text-[11px] text-slate/60 mt-3">
              <span className="text-rust">*</span> Front Full and Back Full are required. The 8
              corner close-ups are optional but recommended — they sharpen corner scoring.
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={handleFileSelect}
            />
          </section>

          <section className="flex flex-col justify-between">
            <div>
              <h2 className="font-display text-lg mb-3">2. Identify your card</h2>

              <div className="relative mb-2">
                <input
                  type="text"
                  value={cardName}
                  onChange={(e) => setCardName(e.target.value)}
                  onFocus={() => setShowSuggestions(true)}
                  onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                  placeholder="Card name -- e.g. Charizard"
                  className="w-full border border-line bg-white/60 px-4 py-3 font-mono text-sm focus:outline-none focus:border-moss"
                />
                {showSuggestions && suggestions.length > 0 && (
                  <ul className="absolute z-10 top-full left-0 right-0 mt-1 border border-line bg-paper shadow-md max-h-56 overflow-y-auto">
                    {suggestions.map((s) => (
                      <li key={s.id}>
                        <button
                          type="button"
                          onMouseDown={() => applySuggestion(s)}
                          className="w-full text-left px-4 py-2 font-mono text-xs hover:bg-moss/10 transition-colors"
                        >
                          {s.name} — {s.set_name}
                          {s.card_number && ` #${s.card_number}`}
                          {s.language && ` (${s.language})`}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <input
                type="text"
                value={setName}
                onChange={(e) => setSetName(e.target.value)}
                onFocus={() => setShowSuggestions(true)}
                onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                placeholder="Set name -- e.g. Base Set"
                className="w-full border border-line bg-white/60 px-4 py-3 font-mono text-sm focus:outline-none focus:border-moss mb-2"
              />

              <input
                type="text"
                value={cardNumber}
                onChange={(e) => setCardNumber(e.target.value)}
                placeholder="Card number -- e.g. 4/102"
                className="w-full border border-line bg-white/60 px-4 py-3 font-mono text-sm focus:outline-none focus:border-moss mb-1"
                onKeyDown={(e) => e.key === "Enter" && handleAnalyze()}
              />
              <p className="font-mono text-[11px] text-slate/60 mb-2">
                Tip: Find the card number in the bottom left or right corner of your card.
              </p>

              <label className="block font-mono text-[10px] uppercase tracking-widest text-slate/70 mb-1">
                Language
              </label>
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value as CardLanguage)}
                className="w-full border border-line bg-white/60 px-4 py-3 font-mono text-sm focus:outline-none focus:border-moss"
              >
                {CARD_LANGUAGES.map((lang) => (
                  <option key={lang} value={lang}>
                    {lang}
                  </option>
                ))}
              </select>
            </div>
            <button
              onClick={handleAnalyze}
              disabled={loading || !hasRequiredPhotos || !hasRequiredCardFields}
              className="mt-6 w-full bg-ink text-paper font-mono text-sm uppercase tracking-widest py-4 hover:bg-moss transition-colors disabled:opacity-40"
            >
              {loading ? "Analyzing..." : "Run analysis"}
            </button>
          </section>
        </div>

        {/* Error states */}
        {error && (
          <div
            className={`mb-6 px-4 py-3 font-mono text-sm border ${
              error.isLimit
                ? "border-gold bg-gold/10 text-ink"
                : "border-rust bg-rust/10 text-rust"
            }`}
          >
            {error.message}
            {error.isLimit && (
              <a
                href="/upgrade"
                className="ml-3 underline underline-offset-2 text-moss font-mono text-sm"
              >
                Upgrade to Pro →
              </a>
            )}
          </div>
        )}

        {/* Results */}
        {result && (
          <div className="space-y-8 border-t border-line pt-10">
            {/* Vision assessment */}
            <section>
              <h2 className="font-display text-lg mb-3">Vision assessment</h2>
              <div className="border border-line bg-white/40 p-5">
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 mb-4 font-mono text-xs">
                  {[
                    {
                      label: "Front centering",
                      value: `${result.vision.frontCenteringPct}/${100 - result.vision.frontCenteringPct}`,
                    },
                    {
                      label: "Back centering",
                      value: `${result.vision.backCenteringPct}/${100 - result.vision.backCenteringPct}`,
                    },
                    { label: "Surface", value: `${result.vision.surfaceScore}/10` },
                    { label: "Edges", value: `${result.vision.edgeScore}/10` },
                    { label: "Corners", value: `${result.vision.cornerScore}/10` },
                  ].map(({ label, value }) => (
                    <div key={label}>
                      <div className="text-slate/70 mb-1">{label}</div>
                      <div className="text-xl text-ink font-display">{value}</div>
                    </div>
                  ))}
                </div>
                {result.vision.asymmetricWearFlag && (
                  <div className="mb-4 border border-gold bg-gold/10 px-4 py-3 font-mono text-xs text-ink">
                    <span className="font-medium">Asymmetric wear flag: </span>
                    Worst zone is {result.vision.worstZone} — condition is uneven across the card.
                  </div>
                )}
                <p className="font-body text-sm text-slate leading-relaxed border-t border-line pt-3">
                  {result.vision.notes}
                </p>
                <p className="font-mono text-xs text-slate/50 mt-2">
                  AI confidence: {result.vision.confidence}
                </p>
              </div>
            </section>

            {/* Raw price */}
            <section>
              <h2 className="font-display text-lg mb-3">Raw price</h2>
              <div className="border border-line bg-white/40 p-5 flex items-center justify-between flex-wrap gap-3">
                <div>
                  <div className="font-display text-3xl text-ink">
                    ${Math.round(result.market.rawMarketPrice).toLocaleString()}
                  </div>
                  <p
                    className={`font-mono text-xs mt-1 ${
                      PRICE_CONFIDENCE_STYLE[result.market.priceConfidence]
                    }`}
                  >
                    {result.market.rawPriceLabel}
                  </p>
                </div>
                <a
                  href={ebayRawSoldListingsUrl({ cardName, cardNumber, setName, language })}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-xs uppercase tracking-widest border border-line px-3 py-2 hover:border-moss hover:text-moss transition-colors whitespace-nowrap"
                >
                  Verify on eBay
                </a>
              </div>
            </section>

            {/* Verdict */}
            <section>
              <h2 className="font-display text-lg mb-3">Verdict</h2>
              <div className={`${verdict?.className} p-5`}>
                <div className="font-display text-2xl mb-2">{verdict?.label}</div>
                <p className="font-body text-sm leading-relaxed opacity-90">
                  {result.recommendation.verdictReason}
                </p>
              </div>
              {result.recommendation.arbitrageFlag && (
                <div className="mt-3 border border-gold bg-gold/10 px-4 py-3 font-mono text-xs text-ink">
                  <span className="font-medium">Arbitrage signal: </span>
                  {result.recommendation.arbitrageFlag}
                </div>
              )}
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border border-line bg-white/40 px-4 py-3">
                <div className="font-mono text-xs text-slate">
                  {result.maxBuyPrice !== null ? (
                    <>
                      Max buy price for 50% ROI:{" "}
                      <span className="font-display text-lg text-ink">
                        ${result.maxBuyPrice.toLocaleString()}
                      </span>
                    </>
                  ) : (
                    "No grader clears the confidence threshold, so there's no target buy price for this copy."
                  )}
                </div>
                <a
                  href={ebayRawSoldListingsUrl({ cardName, cardNumber, setName, language })}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-xs uppercase tracking-widest border border-line px-3 py-2 hover:border-moss hover:text-moss transition-colors whitespace-nowrap"
                >
                  Find on eBay
                </a>
              </div>
            </section>

            {/* Grader comparison — 4 columns for PSA/CGC/BGS/TAG */}
            <section>
              <h2 className="font-display text-lg mb-3">Grader comparison</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {result.recommendation.recommendations.map((rec, i) => (
                  <GraderSlab key={rec.grader} rec={rec} rank={i} />
                ))}
              </div>
              <div className="mt-4 flex items-center justify-between font-mono text-xs text-slate/70">
                <span>
                  Sell raw instead:{" "}
                  <span
                    className={
                      result.recommendation.rawSaleProfit >= 0 ? "text-moss" : "text-rust"
                    }
                  >
                    {result.recommendation.rawSaleProfit >= 0 ? "+" : ""}$
                    {Math.round(result.recommendation.rawSaleProfit).toLocaleString()}
                  </span>
                </span>
                {result.meta && (
                  <span>
                    {result.meta.tier === "free"
                      ? `${result.meta.scansUsed}/${result.meta.scansLimit} scans used this month`
                      : "Pro · unlimited scans"}
                  </span>
                )}
              </div>
              <p className="mt-4 font-mono text-[11px] text-slate/50 leading-relaxed">
                GradeIQ provides data for informational purposes only. Grading outcomes are not
                guaranteed. This is not financial advice.
              </p>
            </section>
          </div>
        )}
      </div>
      <AppFooter />
    </main>
  );
}
