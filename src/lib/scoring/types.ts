// Step 8 of the build order, v2. NOTHING imports this at runtime yet.
//
// The spec is explicit: "Do not build steps 8-10 before step 6 is live and
// producing real event data. A ranking algorithm trained on nothing is worse
// than reverse-chronological." So these are pure functions with tests, wired
// to nothing, ready for the day there is data to rank.
//
// Every function takes `now` and its context as explicit parameters rather
// than reading a clock or a store, so all of it is deterministic and testable
// without mocks. v2 extends the same rule to randomness: anything stochastic
// takes an explicit `Rng` (see ./rng), never Math.random. Determinism is what
// makes the offline simulation reproducible.

export type TrustTier = 'new' | 'building' | 'trusted' | 'elite';

/**
 * v2 renames the v1 'random' lane to 'tail'. It was never uniformly random —
 * it is the long tail of the catalogue, reached by sampling, and the old name
 * invited exactly the wrong implementation.
 */
export type CandidateLane = 'affinity' | 'trending' | 'fresh' | 'social' | 'tail';

/** Canonical lane order. Iterate this rather than hand-writing the tuple. */
export const LANES = ['affinity', 'trending', 'fresh', 'social', 'tail'] as const satisfies
  readonly CandidateLane[];

/** Target share of a slice per lane. Shares are expected to sum to 1. */
export type LaneShares = Record<CandidateLane, number>;

/**
 * Selection-stage constants. Separate from `Weights` because these shape *how
 * many* and *which* candidates are considered, not how a single candidate
 * scores.
 */
export const SELECTION = {
  /**
   * Softmax temperature for stochastic selection. Low on purpose: at 0.08 the
   * ordering is still dominated by score, but near-ties genuinely swap, which
   * is what stops the feed from being identical for two viewers with almost
   * identical profiles. Sampling always draws from an explicit `Rng`.
   */
  SOFTMAX_TEMPERATURE: 0.08,
  /** Videos returned per slice. */
  SLICE_SIZE: 20,
  /** Minimum fresh-lane videos per slice. NEVER relaxed — see rerank. */
  FRESH_FLOOR: 3,
  /** Maximum fresh-lane videos per slice, so exploration cannot swamp a slice. */
  FRESH_CEILING: 6,
  /** Impressions at which a rate is fully trusted by the evidence gate. */
  EVIDENCE_THRESHOLD: 100,
  /**
   * Spec 6.6, explore vs exploit. SOFTMAX_TEMPERATURE is the exploration dial,
   * and these two numbers turn it from a constant into a function of how much
   * the platform actually knows about a viewer:
   *
   *   uncertainty = 1 - min(1, engagedEvents / UNCERTAINTY_HORIZON_EVENTS)
   *   T           = SOFTMAX_TEMPERATURE * (1 + MAX_EXPLORATION_WIDENING * uncertainty)
   *
   * A brand-new viewer gets T = 0.12 — a wide, exploratory feed. A viewer with
   * 200+ engaged events gets T = 0.08, tight and confident. That is the whole
   * mechanism behind "the algorithm got good after a week": nothing is trained
   * or fitted, it is arithmetic over a counter the caller already has. See
   * `adaptiveTemperature` in select.ts.
   */
  UNCERTAINTY_HORIZON_EVENTS: 200,
  /** Fractional widening of the temperature at zero evidence: 0.08 -> 0.12. */
  MAX_EXPLORATION_WIDENING: 0.5,
  /**
   * Spec 6.6's second half: one slot in every 20 goes to a uniformly random
   * eligible video, with no scoring at all. It looks like waste. It is how you
   * discover that a viewer who has only ever bought jewelry will also buy
   * ceramics — a preference no amount of exploiting the existing model could
   * ever surface. OFF by default in `select` (see SelectOptions.randomSlots),
   * so existing simulation runs stay reproducible.
   */
  RANDOM_SLOT_INTERVAL: 20,
} as const;

// ---------------------------------------------------------------------------
// Normalisation references
// ---------------------------------------------------------------------------

/**
 * v2 correction. `norm()` is used eight times in the spec and never defined
 * there. There is no way to map an unbounded rate onto 0-1 without a
 * reference, and the reference silently changes what every weight means — so
 * references are configuration, not constants, and they are as load-bearing as
 * the weights themselves.
 *
 * v1 used a single global cap per rate. v2 derives the reference from the
 * CATEGORY MEDIAN instead, because a category's "good" is not another's:
 *
 *   reference = 2.5 * median(rate | category)
 *
 * The 2.5x matters as much as the per-category part. Normalising against the
 * median itself would mean "a perfectly average video normalises to a score of
 * 1.0" — the top of the scale would be occupied by mediocrity and there would
 * be no headroom left to express excellence.
 */
export const NORM_REFERENCE_MULTIPLIER = 2.5;

/** Every rate whose 0-1 mapping is derived from a category median. */
export type NormalisableRate =
  | 'purchaseRate'
  | 'cartRate'
  | 'tapRate'
  | 'shareRate'
  | 'saveRate'
  | 'avgLoopCount'
  | 'skipUnder2sRate'
  | 'reportRate'
  | 'notInterestedRate';

/** A complete median table: one median per normalisable rate. */
export type RateMedians = Record<NormalisableRate, number>;

/**
 * Per-category medians, resolved per rate with a global fallback.
 *
 * The same number does double duty: the category median IS the Bayesian prior
 * for that rate (v1's `CategoryPriors` already said "platform median rate for
 * the category, used as the Bayesian prior"), and 2.5x it is the normalisation
 * reference. Keeping one table means the prior and the reference can never
 * drift apart.
 *
 * `byCategory` is keyed by categoryId; the empty string '' is the
 * uncategorised bucket. Entries are partial: any rate a category has no
 * measured median for falls through to `fallback`.
 */
export type CategoryMedians = {
  byCategory: Record<string, Partial<RateMedians>>;
  fallback: RateMedians;
};

/**
 * v1's name for the same table. Kept so the prior/reference duality is
 * explicit at call sites that only care about the Bayesian side.
 */
export type CategoryPriors = CategoryMedians;

/**
 * Resolves the raw category median for a rate — NOT the reference. Multiplying
 * by NORM_REFERENCE_MULTIPLIER and handling a zero median is `normToReference`'s
 * job (see normalize.ts), because a zero median must degrade to neutral rather
 * than divide by zero.
 */
export type MedianResolver = (rate: NormalisableRate, categoryId: string | null) => number;

/** Category median for a rate, falling through to the global median. */
export function medianFor(
  medians: CategoryMedians,
  rate: NormalisableRate,
  categoryId: string | null
): number {
  const row = medians.byCategory[categoryId ?? ''];
  const v = row?.[rate];
  return v === undefined ? medians.fallback[rate] : v;
}

export function makeMedianResolver(medians: CategoryMedians): MedianResolver {
  return (rate, categoryId) => medianFor(medians, rate, categoryId);
}

/**
 * Global fallback medians. Chosen so that 2.5x each one reproduces the v1
 * global caps exactly — v2 changes where the reference comes from without
 * silently re-scaling every weight on day one.
 */
export const DEFAULT_CATEGORY_MEDIANS: CategoryMedians = {
  byCategory: {},
  fallback: {
    purchaseRate: 0.02,
    cartRate: 0.048,
    tapRate: 0.14,
    shareRate: 0.02,
    saveRate: 0.048,
    avgLoopCount: 1.2,
    skipUnder2sRate: 0.24,
    reportRate: 0.008,
    notInterestedRate: 0.02,
  },
};

/**
 * Ratings are the one bounded scale in the system: 0-5 by construction, not an
 * unbounded rate, so it is normalised against its own ceiling rather than
 * against a median.
 */
export const RATING_SCALE_MAX = 5;

// ---------------------------------------------------------------------------
// Weights
// ---------------------------------------------------------------------------

export type Weights = {
  wCommerce: number;
  wEngagement: number;
  wAffinity: number;
  wFreshness: number;
  wTrust: number;
  wDiversity: number;
  pFatigue: number;
  pQuality: number;
  /** Bayesian smoothing strength: shrink toward the prior over `alpha` impressions. */
  bayesAlpha: number;
  freshnessHalfLifeHours: number;
  /** Impressions at which the evidence gate stops discounting an observed rate. */
  evidenceThreshold: number;
  /** reference = normReferenceMultiplier * category median. */
  normReferenceMultiplier: number;
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
  evidenceThreshold: SELECTION.EVIDENCE_THRESHOLD,
  normReferenceMultiplier: NORM_REFERENCE_MULTIPLIER,
};

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

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

/** Every new video is guaranteed 500 impressions inside 48 hours of publish. */
export const IMPRESSION_BUDGET_TOTAL = 500;
export const IMPRESSION_BUDGET_WINDOW_HOURS = 48;

/**
 * A video's guaranteed-impressions state. The guarantee is the only reason a
 * brand-new video with no evidence at all ever gets shown: the evidence gate
 * (correctly) refuses to believe a rate measured over 3 impressions, so
 * without a budget nothing would ever accumulate the evidence needed to earn
 * its way in. `satisfied` is stored rather than recomputed so the budget can
 * be closed out when the window expires unfilled.
 */
export type ImpressionBudget = {
  impressionsDelivered: number;
  /** Always IMPRESSION_BUDGET_TOTAL (500) unless deliberately overridden. */
  budgetTotal: number;
  /** Start of the 48h window — normally the publish time. */
  windowStart: Date;
  satisfied: boolean;
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
  /** Absent for videos past their 48h window or when the caller did not load it. */
  budget?: ImpressionBudget | null;
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

// ---------------------------------------------------------------------------
// Within-session adaptation
// ---------------------------------------------------------------------------

/**
 * What the viewer has done *this session*, layered on top of the persisted
 * profile. The persisted profile moves over days; this moves over minutes, and
 * a viewer who has skipped the last six videos should not have to wait for a
 * nightly job to notice.
 *
 * Purely data — it is threaded through as a parameter and returned updated,
 * never mutated in place, so a session can be replayed step by step.
 */
export type SessionState = {
  sessionId: string;
  startedAt: Date;
  /** Videos served so far this session. */
  impressions: number;
  skipsUnder2s: number;
  completions: number;
  productTaps: number;
  addToCarts: number;
  purchases: number;
  /** Within-session exposure counters, for session-scoped fatigue. */
  categoryCounts: Record<string, number>;
  sellerCounts: Record<string, number>;
  /** How many of each lane have been served, for steering toward LaneShares. */
  laneCounts: Record<CandidateLane, number>;
  /** Session-scoped affinity deltas added to the persisted ViewerProfile. */
  categoryAffinityDelta: Record<string, number>;
  sellerAffinityDelta: Record<string, number>;
  /** Videos already served this session, so a slice never repeats one. */
  servedVideoIds: ReadonlySet<string>;
};

// ---------------------------------------------------------------------------
// Scoring output
// ---------------------------------------------------------------------------

export type ScoreComponents = Record<
  'commerce' | 'engagement' | 'affinity' | 'freshness' | 'trust' | 'diversity' | 'fatigue' | 'quality',
  number
>;

export type ScoredCandidate = Candidate & {
  score: number;
  components: ScoreComponents;
};

/**
 * The result of selection: the slice, which constraint ids had to be relaxed
 * to fill it (see rerank's RELAX_ORDER), and whether stochastic sampling was
 * used at all — a caller replaying a session needs to know whether the Rng was
 * consumed.
 */
export type SelectionResult = {
  slice: ScoredCandidate[];
  relaxed: number[];
  sampled: boolean;
};

// ---------------------------------------------------------------------------
// Trust and price
// ---------------------------------------------------------------------------

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
