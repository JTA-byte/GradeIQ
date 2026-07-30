/**
 * Tests for the ROI engine. Run with: npx tsx lib/roiEngine.test.ts
 * (No test framework dependency -- simple assertions for fast iteration.)
 */
import {
  getGraderRecommendations,
  calculateTierRoiPct,
  calculateTierMaxBuyPrice,
  GRADE_TIERS,
  GRADERS,
  CardMarketData,
  GemRateData,
  VisionAssessment,
} from "./roiEngine";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.log(`  FAIL: ${message}`);
  }
}

console.log("\nTest 1: High gem rate + strong vision score -> should recommend grading");
{
  const market: CardMarketData = {
    rawCost: 85,
    rawMarketPrice: 100,
    topGradePrice: 450,
    midGradePrice: 200,
    shippingRoundTrip: 20,
  };
  const gemRates: GemRateData = {
    psa: 28,
    cgc: 30,
    bgs: 15,
    tag: 20,
    totalPopByGrader: { psa: 800, cgc: 400, bgs: 100, tag: 30 },
  };
  const vision: VisionAssessment = {
    centeringPct: 55,
    surfaceScore: 9,
    edgeScore: 9,
    cornerScore: 8.5,
    overallScore: 8.8,
  };
  const result = getGraderRecommendations(market, gemRates, vision);
  assert(result.verdict === "grade", `verdict should be 'grade', got '${result.verdict}'`);
  assert(result.bestOption !== null, "should have a best option");
  assert(
    result.bestOption!.netROI > 0,
    `best option ROI should be positive, got ${result.bestOption?.netROI}`
  );
}

console.log("\nTest 2: Low gem rate across all graders -> should recommend not grading");
{
  const market: CardMarketData = {
    rawCost: 60,
    rawMarketPrice: 75,
    topGradePrice: 300,
    midGradePrice: 140,
    shippingRoundTrip: 20,
  };
  const gemRates: GemRateData = {
    psa: 4,
    cgc: 6,
    bgs: 3,
    tag: 5,
    totalPopByGrader: { psa: 1200, cgc: 600, bgs: 200, tag: 40 },
  };
  const vision: VisionAssessment = {
    centeringPct: 60,
    surfaceScore: 7,
    edgeScore: 7,
    cornerScore: 7,
    overallScore: 7,
  };
  const result = getGraderRecommendations(market, gemRates, vision);
  assert(
    result.verdict === "no_grade" || result.verdict === "sell_raw",
    `verdict should be 'no_grade' or 'sell_raw', got '${result.verdict}'`
  );
  assert(result.bestOption === null, "should have no passing grader option");
}

console.log("\nTest 3: CGC arbitrage scenario -- CGC gem rate much higher than PSA");
{
  const market: CardMarketData = {
    rawCost: 70,
    rawMarketPrice: 90,
    topGradePrice: 380,
    midGradePrice: 170,
    shippingRoundTrip: 20,
  };
  const gemRates: GemRateData = {
    psa: 9,
    cgc: 26,
    bgs: 8,
    tag: 10,
    totalPopByGrader: { psa: 900, cgc: 80, bgs: 150, tag: 25 },
  };
  const vision: VisionAssessment = {
    centeringPct: 50,
    surfaceScore: 9.5,
    edgeScore: 9.5,
    cornerScore: 9.5,
    overallScore: 9.5,
  };
  const result = getGraderRecommendations(market, gemRates, vision);
  assert(result.arbitrageFlag !== null, "should detect CGC arbitrage opportunity");
  assert(
    result.bestOption?.grader === "cgc",
    `best option should likely be CGC given the arbitrage, got '${result.bestOption?.grader}'`
  );
}

console.log("\nTest 4: Low sample size should flag low confidence");
{
  const market: CardMarketData = {
    rawCost: 50,
    rawMarketPrice: 65,
    topGradePrice: 250,
    midGradePrice: 110,
    shippingRoundTrip: 20,
  };
  const gemRates: GemRateData = {
    psa: 30,
    cgc: 35,
    bgs: 20,
    tag: 18,
    totalPopByGrader: { psa: 8, cgc: 5, bgs: 3, tag: 2 }, // very low pop -- new/rare card
  };
  const vision: VisionAssessment = {
    centeringPct: 50,
    surfaceScore: 9,
    edgeScore: 9,
    cornerScore: 9,
    overallScore: 9,
  };
  const result = getGraderRecommendations(market, gemRates, vision);
  const psaRec = result.recommendations.find((r) => r.grader === "psa");
  assert(
    psaRec?.gemRateConfidence === "low",
    `PSA gem rate confidence should be 'low' with pop of 8, got '${psaRec?.gemRateConfidence}'`
  );
}

console.log("\nTest 5: Recommendations should always be sorted by net ROI descending");
{
  const market: CardMarketData = {
    rawCost: 90,
    rawMarketPrice: 110,
    topGradePrice: 500,
    midGradePrice: 220,
    shippingRoundTrip: 20,
  };
  const gemRates: GemRateData = { psa: 20, cgc: 18, bgs: 22, tag: 19 };
  const vision: VisionAssessment = {
    centeringPct: 50,
    surfaceScore: 8.5,
    edgeScore: 8.5,
    cornerScore: 8.5,
    overallScore: 8.5,
  };
  const result = getGraderRecommendations(market, gemRates, vision);
  const rois = result.recommendations.map((r) => r.netROI);
  const sorted = [...rois].sort((a, b) => b - a);
  assert(
    JSON.stringify(rois) === JSON.stringify(sorted),
    "recommendations array should be sorted by netROI descending"
  );
}

console.log(
  "\nTest 6: Low raw price + high grading fees -> should recommend sell_raw even with a great gem rate"
);
{
  // A $25 raw card: even a stellar gem rate/vision score doesn't make
  // grading worthwhile when the fee alone (PSA $150) dwarfs what the
  // card is worth raw. rawCost === rawMarketPrice here (both $25) is the
  // real PriceCharting-derived case -- see lib/mockDataService.ts.
  const market: CardMarketData = {
    rawCost: 25,
    rawMarketPrice: 25,
    topGradePrice: 100,
    midGradePrice: 50,
    shippingRoundTrip: 20,
  };
  const gemRates: GemRateData = {
    psa: 30,
    cgc: 30,
    bgs: 30,
    tag: 30,
    totalPopByGrader: { psa: 500, cgc: 500, bgs: 500, tag: 500 },
  };
  const vision: VisionAssessment = {
    centeringPct: 50,
    surfaceScore: 9.5,
    edgeScore: 9.5,
    cornerScore: 9.5,
    overallScore: 9.5,
  };
  const result = getGraderRecommendations(market, gemRates, vision);
  assert(result.verdict === "sell_raw", `verdict should be 'sell_raw', got '${result.verdict}'`);
  assert(result.bestOption !== null, "should still surface a best option (for maxBuyPrice), just not as a 'grade' verdict");
  assert(
    (result.bestOption?.netROI ?? 1) <= 0,
    `best option net ROI should be <= 0, got ${result.bestOption?.netROI}`
  );
}

console.log("\nTest 7: GRADE_TIERS -- CGC 10 is Tier 2 (PSA 9 equivalent), not Tier 1");
{
  assert(GRADE_TIERS.tier1.PSA.includes("10"), "PSA 10 should be Tier 1");
  assert(GRADE_TIERS.tier1.CGC.includes("PRI"), "CGC Pristine (PRI) should be Tier 1");
  assert(!(GRADE_TIERS.tier1.CGC as readonly string[]).includes("10"), "CGC 10 should NOT be Tier 1");
  assert(GRADE_TIERS.tier2.CGC.includes("10"), "CGC 10 should be Tier 2 (PSA 9 equivalent)");
  assert(GRADE_TIERS.tier1.BGS.includes("BL"), "BGS Black Label (BL) should be Tier 1");
  assert(GRADE_TIERS.tier2.BGS.includes("10"), "BGS 10 (Gem Mint) should be Tier 2, not Black Label");
}

console.log("\nTest 8: Grader Tier 1/Tier 2 sale multipliers match the specified hierarchy");
{
  const psa = GRADERS.find((g) => g.id === "psa")!;
  const cgc = GRADERS.find((g) => g.id === "cgc")!;
  const bgs = GRADERS.find((g) => g.id === "bgs")!;
  const tag = GRADERS.find((g) => g.id === "tag")!;
  assert(bgs.tier1SaleMultiplier === 1.15, `BGS Black Label multiplier should be 1.15, got ${bgs.tier1SaleMultiplier}`);
  assert(cgc.tier1SaleMultiplier === 1.05, `CGC Pristine 10 multiplier should be 1.05, got ${cgc.tier1SaleMultiplier}`);
  assert(psa.tier1SaleMultiplier === 1.0, `PSA 10 multiplier should be 1.0 (baseline), got ${psa.tier1SaleMultiplier}`);
  assert(tag.tier1SaleMultiplier === 0.75, `TAG 10 multiplier should be 0.75, got ${tag.tier1SaleMultiplier}`);
  assert(cgc.tier2SaleMultiplier === 0.7, `CGC 10 multiplier should be 0.70, got ${cgc.tier2SaleMultiplier}`);
  assert(bgs.tier2SaleMultiplier === 0.68, `BGS 10 multiplier should be 0.68, got ${bgs.tier2SaleMultiplier}`);
  assert(psa.tier2SaleMultiplier === 0.65, `PSA 9 multiplier should be 0.65, got ${psa.tier2SaleMultiplier}`);
  assert(tag.tier2SaleMultiplier === 0.6, `TAG 9 multiplier should be 0.60, got ${tag.tier2SaleMultiplier}`);
}

console.log("\nTest 9: calculateTierRoiPct/calculateTierMaxBuyPrice are deterministic per-tier (not probability-blended)");
{
  const psa = GRADERS.find((g) => g.id === "psa")!;
  const tier1Roi = calculateTierRoiPct({ grader: psa, salePrice: 450, rawCost: 85, shippingRoundTrip: 20 });
  const tier2Roi = calculateTierRoiPct({ grader: psa, salePrice: 200, rawCost: 85, shippingRoundTrip: 20 });
  assert(tier1Roi > tier2Roi, `Tier 1 ROI (${tier1Roi}) should exceed Tier 2 ROI (${tier2Roi}) for a higher sale price`);

  const tier1MaxBuy = calculateTierMaxBuyPrice({ grader: psa, salePrice: 450 });
  const tier2MaxBuy = calculateTierMaxBuyPrice({ grader: psa, salePrice: 200 });
  assert(
    tier1MaxBuy > tier2MaxBuy,
    `Tier 1 max buy price (${tier1MaxBuy}) should exceed Tier 2 max buy price (${tier2MaxBuy})`
  );
}

console.log("\nTest 10: getGraderRecommendations includes deterministic tier1RoiPct/tier2RoiPct per grader");
{
  const market: CardMarketData = {
    rawCost: 85,
    rawMarketPrice: 100,
    topGradePrice: 450,
    midGradePrice: 200,
    shippingRoundTrip: 20,
  };
  const gemRates: GemRateData = { psa: 20, cgc: 22, bgs: 15, tag: 18 };
  const vision: VisionAssessment = {
    centeringPct: 55,
    surfaceScore: 8.5,
    edgeScore: 8.5,
    cornerScore: 8.5,
    overallScore: 8.5,
  };
  const result = getGraderRecommendations(market, gemRates, vision);
  for (const rec of result.recommendations) {
    assert(
      typeof rec.tier1RoiPct === "number" && typeof rec.tier2RoiPct === "number",
      `${rec.grader} should have numeric tier1RoiPct/tier2RoiPct`
    );
    assert(
      rec.tier1RoiPct >= rec.tier2RoiPct,
      `${rec.grader} tier1RoiPct (${rec.tier1RoiPct}) should be >= tier2RoiPct (${rec.tier2RoiPct}) given topGradePrice > midGradePrice`
    );
  }
}

console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("=".repeat(50));

if (failed > 0) {
  process.exit(1);
}
