/**
 * Tests for the IQ score. Run with: npx tsx lib/iqScore.test.ts
 * (No test framework dependency -- simple assertions for fast iteration.)
 */
import { calculateIQScore, IQScoreInput } from "./iqScore";

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

const now = Date.now();
const daysAgo = (n: number) => new Date(now - n * 24 * 60 * 60 * 1000);

console.log("\nTest 1: High gem rate + strong ROI + rising prices + slow pop growth -> Excellent");
{
  const input: IQScoreInput = {
    gemRatePct: 30,
    expectedNetRoiPct: 80,
    recentSales: [
      { price: 500, date: daysAgo(5) },
      { price: 480, date: daysAgo(20) },
      { price: 350, date: daysAgo(60) },
      { price: 340, date: daysAgo(75) },
    ],
    popHistory: [
      { totalPop: 100, date: daysAgo(180) },
      { totalPop: 105, date: daysAgo(1) },
    ],
  };
  const result = calculateIQScore(input);
  assert(result.score >= 80, `score should be >= 80, got ${result.score}`);
  assert(result.label === "Excellent", `label should be 'Excellent', got '${result.label}'`);
  assert(result.breakdown.momentumPct !== null && result.breakdown.momentumPct > 0, "momentum should be positive");
  assert(result.breakdown.popGrowthPct !== null && result.breakdown.popGrowthPct < 10, "pop growth should be low");
}

console.log("\nTest 2: Low gem rate + negative ROI + falling prices + fast pop growth -> Weak");
{
  const input: IQScoreInput = {
    gemRatePct: 5,
    expectedNetRoiPct: -30,
    recentSales: [
      { price: 100, date: daysAgo(5) },
      { price: 105, date: daysAgo(20) },
      { price: 200, date: daysAgo(60) },
      { price: 210, date: daysAgo(75) },
    ],
    popHistory: [
      { totalPop: 100, date: daysAgo(180) },
      { totalPop: 180, date: daysAgo(1) },
    ],
  };
  const result = calculateIQScore(input);
  assert(result.score < 40, `score should be < 40, got ${result.score}`);
  assert(result.label === "Weak", `label should be 'Weak', got '${result.label}'`);
  assert(result.breakdown.momentumPct !== null && result.breakdown.momentumPct < 0, "momentum should be negative");
}

console.log("\nTest 3: No sale/pop history -> neutral sub-scores, no crash");
{
  const input: IQScoreInput = {
    gemRatePct: 20,
    expectedNetRoiPct: 20,
    recentSales: [],
    popHistory: [],
  };
  const result = calculateIQScore(input);
  assert(result.breakdown.momentumPct === null, "momentumPct should be null with no sale history");
  assert(result.breakdown.popGrowthPct === null, "popGrowthPct should be null with no pop history");
  assert(result.breakdown.momentumSubScore === 50, "momentum sub-score should default to neutral (50)");
  assert(result.breakdown.popGrowthSubScore === 50, "pop growth sub-score should default to neutral (50)");
  assert(result.score >= 0 && result.score <= 100, `score should stay in [0,100], got ${result.score}`);
}

console.log("\nTest 4: Score is always clamped to [0, 100] at the extremes");
{
  const worst = calculateIQScore({
    gemRatePct: -50,
    expectedNetRoiPct: -1000,
    recentSales: [],
    popHistory: [],
  });
  const best = calculateIQScore({
    gemRatePct: 500,
    expectedNetRoiPct: 1000,
    recentSales: [],
    popHistory: [],
  });
  assert(worst.score >= 0, `worst-case score should be >= 0, got ${worst.score}`);
  assert(best.score <= 100, `best-case score should be <= 100, got ${best.score}`);
}

console.log("\nTest 5: Reason string names a real driving factor, not a neutral default");
{
  const input: IQScoreInput = {
    gemRatePct: 35,
    expectedNetRoiPct: 5,
    recentSales: [],
    popHistory: [],
  };
  const result = calculateIQScore(input);
  assert(result.reason.includes("gem rate"), `reason should cite gem rate as the driver, got: "${result.reason}"`);
  assert(!result.reason.includes("null"), `reason should never leak a literal "null", got: "${result.reason}"`);
}

console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("=".repeat(50));

if (failed > 0) {
  process.exit(1);
}
