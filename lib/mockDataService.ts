/**
 * Market price + gem rate data service.
 *
 * getCardMarketData resolves raw (ungraded) pricing through three tiers,
 * falling through to the next whenever the previous one isn't available:
 *   1. TCGPlayer (lib/tcgplayer.ts) when TCGPLAYER_API_KEY/SECRET are set
 *   2. PriceCharting (lib/priceCharting.ts) -- real sold-listing medians,
 *      scraped live at request time (no API key needed)
 *   3. Mock profiles below (illustrative, not real prices)
 * Each tier's result carries a `priceConfidence` ("high" | "medium" |
 * "low") so callers/UI can show how much to trust the number: TCGPlayer's
 * live market price is "high", PriceCharting's confidence depends on
 * recent sale volume (see lib/priceCharting.ts), and mock data is always
 * "low" since it isn't real. It also carries `rawPriceSource` and a
 * ready-to-display `rawPriceLabel` ("Raw price from PriceCharting",
 * "Estimated — verify on eBay", etc.) so the scan results UI never has
 * to guess which tier actually produced the number.
 *
 * Separately, getGradedSalePrices() supplies real topGradePrice (PSA 10)
 * / midGradePrice (PSA 9) values sourced from the market_sales table --
 * populated by the Python scrapers in python-services/scrapers/
 * (130point, PriceCharting, Alt), not TCGPlayer, which has no graded-card
 * pricing at all. This also falls back to the mock profiles below
 * whenever no recent sales exist for a card.
 *
 * getCardGemRates stands in for the PSA/CGC/BGS/TAG pop-report scraper
 * until that's wired up to write into `gem_rates`.
 *
 * Sample data below is loosely modeled on real cards for realism,
 * but treat all numbers as illustrative, not live prices.
 */
import { CardMarketData, GemRateData } from "./roiEngine";
import { getPriceChartingRawPricing, PriceConfidence } from "./priceCharting";
import { getGradedSalePrices, getTCGPlayerRawPricing } from "./tcgplayer";
import { CardVariant } from "./cardVariant";

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

function findProfile(cardName: string, setName: string): MockCardProfile {
  const normalized = normalizeCardName(`${cardName} ${setName}`);

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

export interface ResolvedCardInput {
  cardId: string;
  cardName: string;
  setName: string;
  cardNumber: string;
  variant?: CardVariant;
  variantDetail?: string;
}

// Where a scan's raw price actually came from, and the exact label the
// scan results UI shows for it -- callers should never construct this
// text themselves, so there's one place that decides what "trustworthy"
// looks like to a user. PriceCharting's own cache tier (in-memory, then
// market_prices -- see lib/priceCharting.ts) is an internal freshness
// detail, not something that changes what's shown here: either way it's
// a real median computed from actual sold listings.
export type RawPriceSource = "tcgplayer" | "pricecharting" | "mock";

const RAW_PRICE_LABELS: Record<RawPriceSource, string> = {
  tcgplayer: "Raw price from TCGPlayer",
  pricecharting: "Raw price from PriceCharting",
  mock: "Estimated — verify on eBay",
};

export async function getCardMarketData(
  card: ResolvedCardInput,
  shippingRoundTrip: number = 20
): Promise<CardMarketData & { priceConfidence: PriceConfidence; rawPriceSource: RawPriceSource; rawPriceLabel: string }> {
  const profile = findProfile(card.cardName, card.setName);
  const [live, gradedSales] = await Promise.all([
    getTCGPlayerRawPricing(card.cardId, card.cardName),
    getGradedSalePrices(card.cardId),
  ]);

  console.log(
    `[mockDataService] TCGPlayer result for "${card.cardName}" (${card.setName} #${card.cardNumber}):`,
    live
  );

  const topGradePrice = gradedSales.topGradePrice ?? profile.topGradePrice;
  const midGradePrice = gradedSales.midGradePrice ?? profile.midGradePrice;

  // TCGPlayer's pricing API reports 0 (not null) for a product it has no
  // recent sales data for -- `!== null` alone let a real product with no
  // real price through as if it were a legitimate $0 market price, which
  // is where an earlier "$0 raw price" report traced back to. Guarding
  // on `> 0` treats that the same as "no data," falling through to
  // PriceCharting instead of returning a price no card actually has.
  if (live && live.marketPrice !== null && live.marketPrice > 0) {
    return {
      rawCost: live.lowPrice ?? live.marketPrice,
      rawMarketPrice: live.marketPrice,
      topGradePrice,
      midGradePrice,
      shippingRoundTrip,
      priceConfidence: "high",
      rawPriceSource: "tcgplayer",
      rawPriceLabel: RAW_PRICE_LABELS.tcgplayer,
    };
  }

  // No TCGPlayer keys configured, the live lookup failed/found nothing,
  // or it returned a $0/no-data price -- try PriceCharting's real
  // sold-listing medians next (its own cache chain -- in-memory, then
  // market_prices -- lives in lib/priceCharting.ts), before falling back
  // to mock data.
  const priceCharting = await getPriceChartingRawPricing(
    card.cardId,
    card.cardName,
    card.setName,
    card.cardNumber,
    card.variant ?? "Normal",
    card.variantDetail
  );

  console.log(
    `[mockDataService] PriceCharting result for "${card.cardName}" (${card.setName} #${card.cardNumber}):`,
    priceCharting
  );

  if (priceCharting && priceCharting.primaryPrice !== null && priceCharting.primaryPrice > 0) {
    return {
      rawCost: priceCharting.primaryPrice,
      rawMarketPrice: priceCharting.primaryPrice,
      topGradePrice,
      midGradePrice,
      shippingRoundTrip,
      priceConfidence: priceCharting.confidence,
      rawPriceSource: "pricecharting",
      rawPriceLabel: RAW_PRICE_LABELS.pricecharting,
    };
  }

  // Neither real source had this card. Simulate network latency like a
  // real API call, then fall back to mock data -- flagged "low" confidence
  // and a plain "price unavailable" label since it isn't real.
  await new Promise((resolve) => setTimeout(resolve, 150));

  return {
    rawCost: profile.rawCost,
    rawMarketPrice: profile.rawMarketPrice,
    topGradePrice,
    midGradePrice,
    shippingRoundTrip,
    priceConfidence: "low",
    rawPriceSource: "mock",
    rawPriceLabel: RAW_PRICE_LABELS.mock,
  };
}

export async function getCardGemRates(cardName: string, setName: string): Promise<GemRateData> {
  await new Promise((resolve) => setTimeout(resolve, 150));
  const profile = findProfile(cardName, setName);
  return profile.gemRates;
}

export function getKnownCardNames(): string[] {
  return Object.keys(MOCK_CARD_DATABASE);
}
