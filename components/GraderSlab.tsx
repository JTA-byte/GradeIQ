import { GraderRecommendation } from "@/lib/roiEngine";

function formatCurrency(value: number): string {
  const sign = value < 0 ? "-" : "+";
  return `${sign}$${Math.abs(Math.round(value)).toLocaleString()}`;
}

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
    </div>
  );
}
