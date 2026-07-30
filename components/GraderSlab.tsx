import { GraderRecommendation } from "@/lib/roiEngine";

function formatCurrency(value: number): string {
  const sign = value < 0 ? "-" : "+";
  return `${sign}$${Math.abs(Math.round(value)).toLocaleString()}`;
}

function formatPct(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(0)}%`;
}

// CGC's Tier 2 grade is numbered "10" but is the PSA-9-equivalent grade,
// not the PSA-10-equivalent one -- see lib/roiEngine.ts's GRADE_TIERS.
// Called out here since it's the one grader/tier pairing where the
// number alone would mislead someone comparing across graders.
const TIER2_EQUIVALENCE_NOTE: Partial<Record<GraderRecommendation["grader"], string>> = {
  cgc: "CGC 10 = PSA 9 equivalent",
};

function confidenceLabel(level: "low" | "medium" | "high"): string {
  switch (level) {
    case "high":
      return "High confidence";
    case "medium":
      return "Moderate confidence";
    case "low":
      return "Low sample size";
  }
}

export function GraderSlab({
  rec,
  rank,
}: {
  rec: GraderRecommendation;
  rank: number;
}) {
  const isBest = rank === 0 && rec.passesGateCheck;
  const isPositive = rec.netROI >= 0;

  return (
    <div
      className={`border ${
        isBest ? "border-moss border-2" : "border-line"
      } bg-paper relative p-5 ${!rec.passesGateCheck ? "opacity-60" : ""}`}
    >
      {isBest && (
        <span className="absolute -top-3 left-4 bg-moss text-paper text-xs tracking-widest uppercase px-2 py-1 font-mono">
          Best ROI
        </span>
      )}
      {!rec.passesGateCheck && (
        <span className="absolute -top-3 left-4 bg-rust text-paper text-xs tracking-widest uppercase px-2 py-1 font-mono">
          Below threshold
        </span>
      )}

      <div className="flex items-baseline justify-between mb-1 mt-1">
        <h3 className="font-display text-xl text-ink">{rec.graderName}</h3>
        <span className="font-mono text-xs text-slate">{rec.turnaroundDays}d turn</span>
      </div>

      <div
        className={`font-display text-3xl mb-3 ${
          isPositive ? "text-moss" : "text-rust"
        }`}
      >
        {formatCurrency(rec.netROI)}
      </div>

      <dl className="font-mono text-xs space-y-1 text-slate border-t border-line pt-3">
        <div className="flex justify-between">
          <dt>Gem rate</dt>
          <dd>{rec.gemRate.toFixed(0)}%</dd>
        </div>
        <div className="flex justify-between">
          <dt>Top grade prob.</dt>
          <dd>{Math.round(rec.topGradeProbability * 100)}%</dd>
        </div>
        <div className="flex justify-between">
          <dt>Expected sale</dt>
          <dd>${Math.round(rec.expectedSalePrice).toLocaleString()}</dd>
        </div>
        <div className="flex justify-between">
          <dt>Grading fee</dt>
          <dd>${rec.fee}</dd>
        </div>
        <div className="flex justify-between text-slate/70">
          <dt>{confidenceLabel(rec.gemRateConfidence)}</dt>
          <dd></dd>
        </div>
      </dl>

      {/* Tier 1 / Tier 2 ROI -- "if it grades exactly this tier", distinct
          from the single probability-blended netROI figure above. */}
      <dl className="font-mono text-xs space-y-1 border-t border-line pt-3 mt-1">
        <div className="flex justify-between">
          <dt className="text-slate/70">Tier 1 ROI</dt>
          <dd className={rec.tier1RoiPct >= 0 ? "text-moss" : "text-rust"}>{formatPct(rec.tier1RoiPct)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-slate/70">Tier 2 ROI</dt>
          <dd className={rec.tier2RoiPct >= 0 ? "text-moss" : "text-rust"}>{formatPct(rec.tier2RoiPct)}</dd>
        </div>
        {TIER2_EQUIVALENCE_NOTE[rec.grader] && (
          <div className="text-slate/50 text-[10px]">{TIER2_EQUIVALENCE_NOTE[rec.grader]}</div>
        )}
      </dl>
    </div>
  );
}
