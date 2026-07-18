/**
 * Market price + gem rate data service.
 *
 * getCardMarketData calls the real TCGPlayer client (lib/tcgplayer.ts)
 * for raw market pricing when TCGPLAYER_API_KEY/SECRET are configured,
 * and separately calls getGradedSalePrices() for real topGradePrice
 * (PSA 10) / midGradePrice (PSA 9) values sourced from the market_sales
 * table -- populated by the Python scrapers in python-services/scrapers/
 * (130point, PriceCharting, Alt), not TCGPlayer, which has no graded-card
 * pricing at all. Either lookup falls back to the mock profiles below
 * independently whenever its real data isn't available (keys unset,
 * card not found, no recent sales, or the lookup fails for any reason).
 *
 * getCardGemRates stands in for the PSA/CGC/BGS/TAG pop-report scraper
 * until that's wired up to write into `gem_rates`.
 *
 * Sample data below is loosely modeled on real cards for realism,
 * but treat all numbers as illustrative, not live prices.
 */
import { CardMarketData, GemRateData } from "./roiEngine";
import { getGradedSalePrices, getTCGPlayerRawPricing } from "./tcgplayer";

interface MockCardProfile {
  rawCost: number;
  rawMarketPrice: number;
  topGradePrice: number;
  midGradePrice: number;
  gemRates: GemRateData;
}

const MOCK_CARD_DATABASE: Record<string, MockCardProfile> = {
  "umbreon vmax alt art": {
    rawCost: 350,
    rawMarketPrice: 400,
    topGradePrice: 1450,
    midGradePrice: 650,
    gemRates: {
      psa: 22,
      cgc: 31,
      bgs: 14,
      tag: 24,
      totalPopByGrader: { psa: 2400, cgc: 600, bgs: 300, tag: 90 },
    },
  },
  "charizard base set shadowless": {
    rawCost: 1200,
    rawMarketPrice: 1400,
    topGradePrice: 22000,
    midGradePrice: 6500,
    gemRates: {
      psa: 3,
      cgc: 7,
      bgs: 2,
      tag: 4,
      totalPopByGrader: { psa: 5200, cgc: 800, bgs: 400, tag: 20 },
    },
  },
  "mega charizard x ex sir": {
    rawCost: 180,
    rawMarketPrice: 210,
    topGradePrice: 650,
    midGradePrice: 320,
    gemRates: {
      psa: 26,
      cgc: 34,
      bgs: 18,
      tag: 29,
      totalPopByGrader: { psa: 1100, cgc: 250, bgs: 150, tag: 35 },
    },
  },
  "pikachu surging sparks sir": {
    rawCost: 90,
    rawMarketPrice: 105,
    topGradePrice: 380,
    midGradePrice: 170,
    gemRates: {
      psa: 19,
      cgc: 9,
      bgs: 10,
      tag: 21,
      totalPopByGrader: { psa: 45, cgc: 12, bgs: 8, tag: 6 }, // newer card, low pop everywhere
    },
  },
};

const DEFAULT_PROFILE: MockCardProfile = {
  rawCost: 50,
  rawMarketPrice: 60,
  topGradePrice: 220,
  midGradePrice: 100,
  gemRates: {
    psa: 15,
    cgc: 18,
    bgs: 12,
    tag: 16,
    totalPopByGrader: { psa: 300, cgc: 100, bgs: 60, tag: 25 },
  },
};

function normalizeCardName(name: string): string {
  return name.trim().toLowerCase();
}

function findProfile(cardName: string): MockCardProfile {
  const normalized = normalizeCardName(cardName);

  if (MOCK_CARD_DATABASE[normalized]) {
    return MOCK_CARD_DATABASE[normalized];
  }

  const partialMatch = Object.keys(MOCK_CARD_DATABASE).find(
    (key) => normalized.includes(key) || key.includes(normalized)
  );
  if (partialMatch) {
    return MOCK_CARD_DATABASE[partialMatch];
  }

  return DEFAULT_PROFILE;
}

/**
 * True when `cardName` doesn't match any named mock profile and would
 * fall through to DEFAULT_PROFILE -- i.e. a genuinely unrecognized card,
 * as opposed to one of the four illustrative sample cards above. Used to
 * decide whether to trigger dynamicCardLookup (lib/dynamicCardLookup.ts).
 */
export function isUnknownCard(cardName: string): boolean {
  const normalized = normalizeCardName(cardName);
  if (MOCK_CARD_DATABASE[normalized]) return false;
  const partialMatch = Object.keys(MOCK_CARD_DATABASE).find(
    (key) => normalized.includes(key) || key.includes(normalized)
  );
  return !partialMatch;
}

export async function getCardMarketData(
  cardName: string,
  shippingRoundTrip: number = 20
): Promise<CardMarketData> {
  const profile = findProfile(cardName);
  const [live, gradedSales] = await Promise.all([
    getTCGPlayerRawPricing(cardName),
    getGradedSalePrices(cardName),
  ]);

  const topGradePrice = gradedSales.topGradePrice ?? profile.topGradePrice;
  const midGradePrice = gradedSales.midGradePrice ?? profile.midGradePrice;

  if (live && live.marketPrice !== null) {
    return {
      rawCost: live.lowPrice ?? live.marketPrice,
      rawMarketPrice: live.marketPrice,
      topGradePrice,
      midGradePrice,
      shippingRoundTrip,
    };
  }

  // No TCGPlayer keys configured, or the live lookup failed/found nothing.
  // Simulate network latency like a real API call.
  await new Promise((resolve) => setTimeout(resolve, 150));

  return {
    rawCost: profile.rawCost,
    rawMarketPrice: profile.rawMarketPrice,
    topGradePrice,
    midGradePrice,
    shippingRoundTrip,
  };
}

export async function getCardGemRates(cardName: string): Promise<GemRateData> {
  await new Promise((resolve) => setTimeout(resolve, 150));
  const profile = findProfile(cardName);
  return profile.gemRates;
}

export function getKnownCardNames(): string[] {
  return Object.keys(MOCK_CARD_DATABASE);
}
