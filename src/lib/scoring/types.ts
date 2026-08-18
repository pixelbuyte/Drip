// Step 8 of the build order. NOTHING imports this at runtime yet.
//
// The spec is explicit: "Do not build steps 8-10 before step 6 is live and
// producing real event data. A ranking algorithm trained on nothing is worse
// than reverse-chronological." So these are pure functions with tests, wired
// to nothing, ready for the day there is data to rank.
//
// Every function takes `now` and its context as explicit parameters rather
// than reading a clock or a store, so all of it is deterministic and testable
// without mocks.

export type TrustTier = 'new' | 'building' | 'trusted' | 'elite';
export type CandidateLane = 'affinity' | 'trending' | 'fresh' | 'social' | 'random';

export type Weights = {
  wCommerce: number;
  wEngagement: number;
  wAffinity: number;
  wFreshness: number;
  wTrust: number;
  wDiversity: number;
  pFatigue: number;
  pQuality: number;
  bayesAlpha: number;
  freshnessHalfLifeHours: number;
  /**
   * `norm()` is used eight times in the spec and never defined there. There is
   * no way to map an unbounded rate onto 0-1 without a cap, and the cap
   * silently changes what every weight means — so caps are configuration, not
   * constants, and they are as load-bearing as the weights themselves.
   */
  normCaps: Record<string, number>;
};

export const DEFAULT_WEIGHTS: Weights = {
  wCommerce: 0.35,
  wEngagement: 0.2,
  wAffinity: 0.2,
  wFreshness: 0.1,
  wTrust: 0.1,
  wDiversity: 0.05,
  pFatigue: 0.15,
  pQuality: 0.25,
  bayesAlpha: 50,
  freshnessHalfLifeHours: 72,
  normCaps: {
    purchaseRate: 0.05,
    cartRate: 0.12,
    tapRate: 0.35,
    avgLoopCount: 3,
    shareRate: 0.05,
    saveRate: 0.12,
    ratingAvg: 5,
    skipUnder2sRate: 0.6,
    reportRate: 0.02,
    notInterestedRate: 0.05,
  },
};

export type CandidateStats = {
  impressions24h: number;
  purchases24h: number;
  addToCarts24h: number;
  productTaps24h: number;
  completions24h: number;
  skipsUnder2s24h: number;
  shares24h: number;
  saves24h: number;
  avgLoopCount: number;
  reportsAll: number;
  notInterestedAll: number;
  impressionsAll: number;
  impressions1h: number;
  purchases1h: number;
  addToCarts1h: number;
  productTaps1h: number;
};

export type CandidateTrust = {
  fulfillmentScore: number;
  disputeRate: number;
  ratingAvg: number | null;
  tier: TrustTier;
};

export type Candidate = {
  videoId: string;
  sellerId: string;
  categoryId: string | null;
  lane: CandidateLane;
  publishedAt: Date;
  minPriceCents: number;
  hashtags: string[];
  stats: CandidateStats;
  trust: CandidateTrust;
};

export type PriceBand = { p25: number; p50: number; p75: number };

export type ViewerProfile = {
  categoryAffinity: Record<string, number>;
  sellerAffinity: Record<string, number>;
  hashtagAffinity: Record<string, number>;
  priceBand: PriceBand | null;
  coldStartComplete: boolean;
};

/** The last N already placed, newest first. */
export type RecentContext = {
  sellerIds: string[];
  categoryIds: (string | null)[];
  priceCents: number[];
  seenSellerIds: ReadonlySet<string>;
};

export type CategoryPriors = {
  /** Platform median rate for the category, used as the Bayesian prior. */
  purchaseRate: Record<string, number>;
  cartRate: Record<string, number>;
  tapRate: Record<string, number>;
  fallback: { purchaseRate: number; cartRate: number; tapRate: number };
};

export type ScoreComponents = Record<
  'commerce' | 'engagement' | 'affinity' | 'freshness' | 'trust' | 'diversity' | 'fatigue' | 'quality',
  number
>;

export type ScoredCandidate = Candidate & {
  score: number;
  components: ScoreComponents;
};

/** Trust tier floor: new sellers are penalized, never buried, or cold start is unsolvable. */
export const TIER_BONUS: Record<TrustTier, number> = {
  new: 0.5,
  building: 0.7,
  trusted: 0.9,
  elite: 1.0,
};

export const PRICE_BANDS = { low: 2500, mid: 7500 } as const;

export function priceBandOf(cents: number): 'low' | 'mid' | 'high' {
  if (cents < PRICE_BANDS.low) return 'low';
  if (cents < PRICE_BANDS.mid) return 'mid';
  return 'high';
}
