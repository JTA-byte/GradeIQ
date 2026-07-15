/**
 * Tests for the ROI engine. Run with: npx tsx lib/roiEngine.test.ts
 * (No test framework dependency -- simple assertions for fast iteration.)
 */
import { getGraderRecommendations, CardMarketData, GemRateData, VisionAssessment } from "./roiEngine";

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

console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("=".repeat(50));

if (failed > 0) {
  process.exit(1);
}
