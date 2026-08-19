// Step 8 of the build order, v2 — THE SIMULATION HARNESS.
//
// This file exists because of one line in the spec:
//
//   "Unit tests pass on logic that is still catastrophically wrong at scale —
//    every bug in 2.3 and 2.7 passed 54 assertions and only surfaced under
//    simulation."
//
// and one instruction:
//
//   "Before shipping any ranking change, run simulate.ts and check all four
//    guardrails."
//
// Everything else in src/lib/scoring/ answers "is this function correct?".
// This one answers "is the SYSTEM correct?", which is a different question with
// a different failure mode: every part can be individually right and the feed
// can still concentrate on twelve sellers, starve every new upload, or trade a
// third of its revenue for exploration nobody asked for.
//
// ---------------------------------------------------------------------------
// DETERMINISM (contract 1) — the whole point
// ---------------------------------------------------------------------------
//
// There is no Date.now() and no Math.random() here, the same as everywhere else
// in this directory. The clock is a parameter (`startedAt`) and every random
// draw comes from `mulberry32`. Same seed => byte-identical metrics, asserted in
// the tests. An unreproducible simulation cannot gate a release: if a number
// moves you must be able to say whether the code changed or the dice did.
//
// Randomness is split into three INDEPENDENT streams, which is what makes the
// comparative run a controlled experiment rather than three unrelated runs:
//
//   world stream      seeded once, builds sellers/videos/viewers. Identical for
//                     every strategy, so all three face the same catalogue.
//   generation stream re-seeded per session from (seed, sessionIndex). Drives
//                     tailLane's shuffle. Identical across strategies.
//   behaviour stream  re-seeded per session, and drawn in a FIXED-SIZE BLOCK of
//                     DRAWS_PER_IMPRESSION per impression whether or not each
//                     draw is used. So the "luck" available at position i of a
//                     session is the same under every strategy — only which
//                     video sits at position i differs. Without the fixed block
//                     an early skip would shift the stream and the strategies
//                     would diverge on noise rather than on selection.
//
// Selection consumes its own per-session stream. Greedy consumes none of it
// (temperature 0 never draws), which is exactly why selection cannot be allowed
// to share a stream with viewer behaviour.
//
// ---------------------------------------------------------------------------
// WHY THE CATALOGUE STARTS WITH HISTORY
// ---------------------------------------------------------------------------
//
// A simulation that starts from an empty stats table measures nothing. 2,000
// sessions produce on the order of 70k impressions spread over ~600 videos —
// roughly 20 impressions per video per 24h — and the evidence gate would
// (correctly) refuse to believe any of it, leaving every candidate pinned at
// the 0.5 neutral and the ranker indistinguishable from a coin flip.
//
// So mature videos are born with a BASELINE 24h/lifetime counter set, sampled
// from their true appeal with binomial-ish noise. That is not a cheat, it is
// the modelling assumption: the 2,000 simulated sessions are a SAMPLE of the
// platform's traffic, not the whole of it. The baseline volume is log-uniform
// across four orders of magnitude on purpose, so the pool contains genuine
// small-sample flukes ("1 purchase in 3 impressions") alongside genuinely
// proven videos — the exact pair the evidence gate exists to separate.
//
// Videos that publish DURING the run get no baseline at all. They are the ones
// the impression guarantee and the fresh lane are actually about.
//
// Every impression, purchase and dollar reported below is a SIMULATED one. The
// baseline is scoring input; it is never counted in Gini, RPM or the funnel.

import {
  generateCandidates,
  thinCategoryMultiplier,
  type PoolVideo,
  type ViewerContext,
} from './candidates';
import {
  budgetDeliveryReport,
  evaluateGuardrails,
  funnel,
  impressionGini,
  laneMetrics,
  qualitySortingReport,
  rpm as rpmOf,
  type BudgetDeliveryReport,
  type BudgetObservation,
  type FunnelEvent,
  type FunnelReport,
  type GuardrailVerdict,
  type LaneMetrics,
  type LaneObservation,
  type QualitySortingReport,
} from './guardrails';
import { clamp01 } from './normalize';
import { mulberry32, type Rng } from './rng';
import { scoreCandidate } from './score';
import { budgetOwedIds, select } from './select';
import {
  applySessionEvent,
  candidateBoost,
  initialSessionState,
  isSellerSuppressed,
  needsTrendingInjection,
  sessionBoosts,
  sessionWeights,
  type AdaptiveSessionState,
} from './session';
import {
  isSellerBlocked,
  updateViewerAffinity,
  watchEventType,
  type AffinityEvent,
  type AffinityMap,
  type SellerBlock,
} from './affinity';
import {
  DEFAULT_CATEGORY_MEDIANS,
  DEFAULT_WEIGHTS,
  IMPRESSION_BUDGET_TOTAL,
  IMPRESSION_BUDGET_WINDOW_HOURS,
  LANES,
  SELECTION,
  type CandidateLane,
  type CandidateTrust,
  type CategoryMedians,
  type ImpressionBudget,
  type LaneShares,
  type NormalisableRate,
  type PriceBand,
  type RateMedians,
  type RecentContext,
  type ScoredCandidate,
  type TrustTier,
  type ViewerProfile,
} from './types';

const MS_HOUR = 3_600_000;
const MS_DAY = 24 * MS_HOUR;

// ---------------------------------------------------------------------------
// The world's vocabulary
// ---------------------------------------------------------------------------

/**
 * The 12 seeded categories, slugs verbatim from migration 00007. Using the real
 * slugs rather than 'cat-0'..'cat-11' costs nothing and means a median table
 * dumped out of a run is readable next to a production one.
 */
export const SIM_CATEGORY_IDS = [
  'apparel',
  'footwear',
  'jewelry-accessories',
  'beauty',
  'home-decor',
  'vintage-thrift',
  'collectibles',
  'handmade-craft',
  'tech-gadgets',
  'pet',
  'fitness',
  'other',
] as const;

export type SimCategoryId = (typeof SIM_CATEGORY_IDS)[number];

/**
 * Relative catalogue weight per category. Deliberately uneven so that some
 * categories land under THIN_CATEGORY_THRESHOLD (50 live videos) and the 1.2x
 * thin-category freshness multiplier is actually exercised, and so that
 * per-category medians differ from each other — a flat world would make
 * contract 3 (2.5x the CATEGORY median) indistinguishable from a global cap.
 */
const CATEGORY_WEIGHTS = [18, 14, 11, 10, 9, 8, 6, 6, 5, 5, 4, 4];

const HASHTAG_POOL_PER_CATEGORY = 6;

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

/**
 * The three selection regimes the comparative run puts side by side. They
 * differ in EXACTLY the two knobs named below and in nothing else — same world,
 * same viewers, same session order, same behaviour draws. Anything else would
 * make the comparison an anecdote.
 */
export type SimulationStrategy = 'greedy' | 'softmax' | 'floor-only';

export const SIMULATION_STRATEGIES = ['greedy', 'softmax', 'floor-only'] as const satisfies
  readonly SimulationStrategy[];

export type StrategyConfig = {
  temperature: number;
  freshFloor: number;
  freshCeiling: number;
  description: string;
};

export function strategyConfig(
  strategy: SimulationStrategy,
  sliceSize: number = SELECTION.SLICE_SIZE
): StrategyConfig {
  switch (strategy) {
    case 'greedy':
      // v1. Temperature 0 makes softmaxPick degenerate to argmax and consume no
      // rng at all, so this is pure deterministic ranking under the same
      // constraint set. The fresh floor and ceiling stay ON: the spec's claim is
      // about SAMPLING, and changing two things at once would prove nothing.
      return {
        temperature: 0,
        freshFloor: SELECTION.FRESH_FLOOR,
        freshCeiling: SELECTION.FRESH_CEILING,
        description: 'v1 greedy argmax, same constraints',
      };
    case 'softmax':
      return {
        temperature: SELECTION.SOFTMAX_TEMPERATURE,
        freshFloor: SELECTION.FRESH_FLOOR,
        freshCeiling: SELECTION.FRESH_CEILING,
        description: 'v2 constrained softmax (T=0.08), floor 3 / ceiling 6',
      };
    case 'floor-only':
      // The spec's documented failure: "a floor without a ceiling is not a
      // guarantee, it's a takeover." A ceiling equal to the slice size is no
      // ceiling — select() clamps it up to the floor, never down.
      return {
        temperature: SELECTION.SOFTMAX_TEMPERATURE,
        freshFloor: SELECTION.FRESH_FLOOR,
        freshCeiling: Math.max(sliceSize, SELECTION.FRESH_FLOOR),
        description: 'softmax with the fresh CEILING disabled',
      };
  }
}

// ---------------------------------------------------------------------------
// World configuration
// ---------------------------------------------------------------------------

export type WorldConfig = {
  /** Sellers, with a spread of latent quality. The Gini population. */
  sellers: number;
  /** Mature videos per seller — published before the run, with baseline stats. */
  videosPerSeller: number;
  /**
   * Distinct viewers cycled round-robin. Scaled from the session count by
   * default so every viewer gets a comparable number of sessions and affinity
   * has time to accumulate; a one-session-per-viewer world would leave every
   * viewer permanently in cold start and never exercise the affinity lane.
   */
  viewers?: number;
  /**
   * Simulated sessions per simulated day. This sets the traffic DENSITY, and
   * density is what decides whether the impression guarantee is affordable:
   * every new video needs 500 impressions inside 48h, and the fresh lane can
   * only carry between 15% (the floor) and 30% (the ceiling) of impressions.
   */
  sessionsPerDay: number;
  /**
   * New videos published per simulated day, during the run. Sized against the
   * line above: at 300 sessions/day and ~40 impressions/session the platform
   * serves ~500 impressions/hour, of which the fresh lane realistically carries
   * ~16%, which funds ~0.16 new videos/hour ~= 4/day. Above that the guarantee
   * is arithmetically undeliverable no matter how good the selector is, and the
   * guardrail would be measuring the world's sizing rather than the code.
   * `budget.demandShare` in the result reports what fraction of all impressions
   * the guarantee actually demanded, so this assumption is auditable.
   */
  newVideosPerDay: number;
  /** Slices a viewer may request in one session. */
  maxSlices: number;
  sliceSize: number;
  /** Candidate pool size handed to the scorer. Spec 2.1 says ~500. */
  targetCandidates: number;
  /** Seconds of simulated dwell per impression. Drives the 2-minute idle rule. */
  dwellSeconds: number;
  /**
   * Age range of the pre-existing catalogue, in days.
   *
   * The default lower bound is 3 days, which is deliberately outside the 48h
   * fresh window: it makes the fresh lane consist EXCLUSIVELY of videos that
   * publish during the run, which is the mature-platform case.
   *
   * Set both bounds inside 2 days (together with a small
   * `baselineImpressions24hMax`) to model a YOUNG platform, where most of the
   * catalogue is itself fresh-lane eligible. That is the only regime in which
   * the fresh CEILING can bind at all — see the ceiling test.
   */
  matureAgeDaysMin: number;
  matureAgeDaysMax: number;
  /**
   * Log-uniform range for a mature video's baseline 24h impressions. The spread
   * is what puts small-sample flukes and proven performers in the same pool.
   * Keep the max under IMPRESSION_BUDGET_TOTAL to model a catalogue that has
   * not yet accumulated evidence.
   */
  baselineImpressions24hMin: number;
  baselineImpressions24hMax: number;
  /**
   * Candidate lane shares (spec 2.1). candidates.ts exports these "tunable
   * rather than inlined because the simulation harness sweeps them", and this
   * is the sweep. They matter for the ceiling: `select`'s fresh CEILING counts
   * LANE LABELS, and a video is only labelled 'fresh' if the fresh lane's quota
   * had room for it — so the exploration lane's impression share is bounded by
   * its candidate share long before the ceiling gets a vote. Undefined keeps
   * candidates.ts's defaults.
   */
  laneShares?: LaneShares;
  coldStartLaneShares?: LaneShares;
  /** The only clock in this file. */
  startedAt: Date;
};

export const DEFAULT_WORLD: WorldConfig = {
  sellers: 120,
  videosPerSeller: 5,
  sessionsPerDay: 500,
  newVideosPerDay: 4,
  maxSlices: 3,
  sliceSize: SELECTION.SLICE_SIZE,
  targetCandidates: 500,
  dwellSeconds: 9,
  matureAgeDaysMin: 3,
  matureAgeDaysMax: 90,
  baselineImpressions24hMin: 3,
  baselineImpressions24hMax: 6000,
  // A fixed epoch, not a clock reading. Nothing about the result may depend on
  // when the run happened.
  startedAt: new Date('2026-01-05T00:00:00.000Z'),
};

/**
 * A platform three days old: almost the whole catalogue is inside the 48h fresh
 * window with under 500 lifetime impressions, so almost every candidate is
 * fresh-lane. This is the ONLY regime in which the fresh CEILING can bind —
 * see the note on `strategyConfig('floor-only')` and the findings in the
 * ceiling test. On a mature catalogue the ceiling is unreachable, because an
 * unproven video sits at the evidence gate's 0.5 neutral on every rate signal
 * and simply never outscores a proven one.
 */
export const YOUNG_PLATFORM_WORLD: Partial<WorldConfig> = {
  matureAgeDaysMin: 0.1,
  matureAgeDaysMax: 1.9,
  baselineImpressions24hMin: 3,
  baselineImpressions24hMax: 400,
};

/**
 * The spec's documented disaster, set up so it can actually happen: the
 * exploration lane is given half of every candidate set on a young catalogue
 * where every video qualifies for it. Run 'floor-only' against this and the
 * fresh lane takes the feed; run 'softmax' and the ceiling holds it at
 * FRESH_CEILING / sliceSize.
 *
 * This preset exists because the failure is NOT reproducible on the default
 * world at the shipped 20% fresh share — see the findings in the ceiling test.
 */
export const EXPLORATION_HEAVY_WORLD: Partial<WorldConfig> = {
  ...YOUNG_PLATFORM_WORLD,
  laneShares: { affinity: 0.2, trending: 0.15, fresh: 0.5, social: 0.05, tail: 0.1 },
  coldStartLaneShares: { affinity: 0, trending: 0.2, fresh: 0.6, social: 0, tail: 0.2 },
};

export type SimulationOptions = {
  /** Default 2000. */
  sessions?: number;
  /** Default 20260105. */
  seed?: number;
  /** Default 'softmax'. */
  strategy?: SimulationStrategy;
  world?: Partial<WorldConfig>;
};

// ---------------------------------------------------------------------------
// Seeded helpers
// ---------------------------------------------------------------------------

/**
 * FNV-1a over the integer parts, so each stream gets a well-separated seed.
 * `mulberry32(seed)` and `mulberry32(seed + 1)` are close in state space and
 * correlate visibly over short runs; hashing avoids having to think about it.
 */
function mixSeed(...parts: number[]): number {
  let h = 0x811c9dc5;
  for (const part of parts) {
    let x = part >>> 0;
    for (let i = 0; i < 4; i += 1) {
      h = Math.imul(h ^ (x & 0xff), 0x01000193) >>> 0;
      x >>>= 8;
    }
  }
  return h >>> 0;
}

function uniform(rng: Rng, lo: number, hi: number): number {
  return lo + (hi - lo) * rng();
}

/** Box-Muller. Two draws, always, so consumption is constant. */
function gaussian(rng: Rng): number {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * A binomial draw, normal-approximated and clamped into [0, n].
 *
 * Exact for what this needs: sampling noise that is LARGE at small n and small
 * at large n, which is precisely the phenomenon the evidence gate is built to
 * survive. At n = 3, p = 0.02 it produces the occasional 1 — the "1 purchase in
 * 3 impressions" fluke the spec names — and at n = 20,000 it produces a rate
 * you can believe.
 */
function binomial(rng: Rng, n: number, p: number): number {
  if (n <= 0) return 0;
  const q = clamp01(p);
  const mean = n * q;
  const sd = Math.sqrt(Math.max(0, n * q * (1 - q)));
  const draw = Math.round(mean + gaussian(rng) * sd);
  return Math.min(n, Math.max(0, draw));
}

function median(sorted: readonly number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = n >> 1;
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function quantile(sorted: readonly number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const pos = clamp01(q) * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

type Counters = {
  imp: number;
  pur: number;
  cart: number;
  tap: number;
  comp: number;
  skip: number;
  share: number;
  save: number;
  loops: number;
  rev: number;
};

function zeroCounters(): Counters {
  return { imp: 0, pur: 0, cart: 0, tap: 0, comp: 0, skip: 0, share: 0, save: 0, loops: 0, rev: 0 };
}

type WindowEvent = Counters & { t: number };

type SimSeller = {
  sellerId: string;
  /** Latent, never visible to the ranker. The thing quality-sorting measures. */
  quality: number;
  trust: CandidateTrust;
  homeCategory: SimCategoryId;
};

type SimVideo = {
  videoId: string;
  seller: SimSeller;
  categoryId: SimCategoryId;
  hashtags: string[];
  priceCents: number;
  /** Latent intrinsic quality. Drives conversion; never visible to the ranker. */
  appeal: number;
  publishedAt: Date;
  publishedAtMs: number;
  /** True for videos that publish DURING the run: no baseline, and a guarantee. */
  isNew: boolean;
  budget: ImpressionBudget | null;
  /**
   * Impressions delivered when the 48h window shut. Frozen on purpose: a video
   * that limps to 500 impressions at hour 60 did NOT receive its guarantee, and
   * reading the live counter at the end of the run would score that as a pass.
   */
  deliveredAtWindowClose: number | null;

  /** Static background traffic. Scoring input only — never a reported metric. */
  base24: Counters;
  baseAllImp: number;
  baseReports: number;
  baseNotInterested: number;

  /** Simulated rolling windows. */
  events: WindowEvent[];
  head24: number;
  head1: number;
  w24: Counters;
  w1: Counters;
  simAllImp: number;
  simReports: number;
  simNotInterested: number;

  /** Reported metrics. */
  simImpressions: number;
  simRevenueCents: number;

  /** Mutated in place each session; see `refreshPool`. */
  pool: PoolVideo;
};

type SimViewer = {
  viewerId: string;
  /** Latent taste per category, peak-normalised to [0,1]. Never visible. */
  fit: number[];
  logPriceCenter: number;
  buyPropensity: number;
  profile: ViewerProfile;
  /** The decayed, un-normalised affinity mass — what the cron persists. */
  raw: { categoryAffinity: AffinityMap; sellerAffinity: AffinityMap; hashtagAffinity: AffinityMap };
  seenSellerIds: Set<string>;
  purchasedSellerIds: Set<string>;
  followedSellerIds: Set<string>;
  notInterestedVideoIds: Set<string>;
  sellerBlocks: SellerBlock[];
  purchasesByVideoId: Map<string, { purchasedAt: Date; hasUnpurchasedItems: boolean }>;
  priceObservations: number[];
  interactions: number;
  lastAffinityAt: Date;
};

function tierFor(score: number): TrustTier {
  if (score >= 0.82) return 'elite';
  if (score >= 0.6) return 'trusted';
  if (score >= 0.33) return 'building';
  return 'new';
}

function categoryForIndex(rng: Rng): SimCategoryId {
  const total = CATEGORY_WEIGHTS.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < CATEGORY_WEIGHTS.length; i += 1) {
    r -= CATEGORY_WEIGHTS[i];
    if (r <= 0) return SIM_CATEGORY_IDS[i];
  }
  return SIM_CATEGORY_IDS[SIM_CATEGORY_IDS.length - 1];
}

function hashtagsFor(category: SimCategoryId, rng: Rng): string[] {
  const a = Math.floor(rng() * HASHTAG_POOL_PER_CATEGORY);
  let b = Math.floor(rng() * HASHTAG_POOL_PER_CATEGORY);
  if (b === a) b = (b + 1) % HASHTAG_POOL_PER_CATEGORY;
  return [`#${category}-${a}`, `#${category}-${b}`];
}

/**
 * True per-impression rates for a video, given its latent appeal and its
 * seller's latent quality. These are the generative truth: the baseline stats
 * are noisy samples FROM these, and the live simulation draws FROM these. The
 * ranker never sees them, and its whole job is to recover their ordering from
 * noisy counters.
 */
function trueRates(appeal: number, sellerQuality: number, buyPropensity: number) {
  const m = clamp01(0.25 + 0.75 * appeal);
  const notSkip = clamp01(0.45 + 0.35 * appeal);
  return {
    skip: clamp01(0.55 - 0.35 * appeal),
    completion: notSkip * clamp01(0.25 + 0.55 * appeal),
    loopBonus: 0.45,
    tap: notSkip * clamp01(0.03 + 0.42 * m),
    cartGivenTap: clamp01(0.2 + 0.35 * appeal),
    checkoutGivenCart: clamp01(0.55 + 0.25 * appeal),
    purchaseGivenCheckout: clamp01((0.3 + 0.45 * sellerQuality) * (0.55 + 0.9 * buyPropensity)),
    share: notSkip * clamp01(0.012 + 0.05 * m),
    save: notSkip * clamp01(0.022 + 0.13 * m),
    notInterested: clamp01(0.004 + 0.02 * (1 - m)),
    report: clamp01(0.0015 + 0.008 * (1 - appeal)),
  };
}

function makeSeller(index: number, rng: Rng): SimSeller {
  // Quality spread across the full range with a mild centre bias, so both tails
  // are populated: the quality-sorting ratio is meaningless without genuinely
  // bad sellers to be sorted below.
  const quality = clamp01(0.5 + 0.55 * (rng() + rng() + rng() - 1.5));
  const tierScore = clamp01(quality + 0.12 * gaussian(rng));
  const ratingRoll = rng();
  return {
    sellerId: `sel-${String(index).padStart(3, '0')}`,
    quality,
    homeCategory: categoryForIndex(rng),
    trust: {
      fulfillmentScore: clamp01(0.55 + 0.45 * quality + 0.06 * gaussian(rng)),
      disputeRate: clamp01(0.11 * (1 - quality) + 0.015 * Math.abs(gaussian(rng))),
      // A tenth of sellers have no ratings at all; trustSignal has an explicit
      // branch for that and it should be walked.
      ratingAvg: ratingRoll < 0.1 ? null : Math.min(5, Math.max(0, 2.9 + 2.1 * quality + 0.25 * gaussian(rng))),
      tier: tierFor(tierScore),
    },
  };
}

function makeVideo(
  videoId: string,
  seller: SimSeller,
  publishedAt: Date,
  isNew: boolean,
  rng: Rng
): SimVideo {
  // 70% of a seller's catalogue sits in their home category; the rest spreads,
  // so category affinity is informative without being deterministic.
  const categoryId = rng() < 0.7 ? seller.homeCategory : categoryForIndex(rng);
  const appeal = clamp01(0.55 * seller.quality + 0.45 * rng());
  const priceCents = Math.round(Math.exp(Math.log(4500) + 0.9 * gaussian(rng)));
  const price = Math.min(60_000, Math.max(600, priceCents));

  const video: SimVideo = {
    videoId,
    seller,
    categoryId,
    hashtags: hashtagsFor(categoryId, rng),
    priceCents: price,
    appeal,
    publishedAt,
    publishedAtMs: publishedAt.getTime(),
    isNew,
    budget: isNew
      ? {
          impressionsDelivered: 0,
          budgetTotal: IMPRESSION_BUDGET_TOTAL,
          windowStart: publishedAt,
          satisfied: false,
        }
      : null,
    deliveredAtWindowClose: null,
    base24: zeroCounters(),
    baseAllImp: 0,
    baseReports: 0,
    baseNotInterested: 0,
    events: [],
    head24: 0,
    head1: 0,
    w24: zeroCounters(),
    w1: zeroCounters(),
    simAllImp: 0,
    simReports: 0,
    simNotInterested: 0,
    simImpressions: 0,
    simRevenueCents: 0,
    // Filled immediately below by the caller via `initPool`.
    pool: null as unknown as PoolVideo,
  };
  return video;
}

/**
 * Give a mature video the history it would really have. Volume is log-uniform
 * over three and a half orders of magnitude, which is what puts genuine
 * small-sample flukes in the same pool as genuinely proven videos.
 */
function seedBaseline(
  v: SimVideo,
  ageDays: number,
  rng: Rng,
  impMin: number,
  impMax: number
): void {
  const rates = trueRates(v.appeal, v.seller.quality, 0.5);
  const lo = Math.max(1, impMin);
  const hi = Math.max(lo, impMax);
  const imp24 = Math.round(Math.exp(uniform(rng, Math.log(lo), Math.log(hi))));
  const skip = binomial(rng, imp24, rates.skip);
  const comp = binomial(rng, imp24, rates.completion);
  const tap = binomial(rng, imp24, rates.tap);
  const cart = binomial(rng, tap, rates.cartGivenTap);
  const checkout = binomial(rng, cart, rates.checkoutGivenCart);
  const pur = binomial(rng, checkout, rates.purchaseGivenCheckout);
  v.base24 = {
    imp: imp24,
    pur,
    cart,
    tap,
    comp,
    skip,
    share: binomial(rng, imp24, rates.share),
    save: binomial(rng, imp24, rates.save),
    loops: imp24 + Math.round(comp * rates.loopBonus),
    rev: pur * v.priceCents,
  };
  // Lifetime volume grows with age but sub-linearly — a 90-day-old video is not
  // 90x its last 24 hours.
  v.baseAllImp = Math.round(imp24 * (1 + 0.6 * ageDays));
  v.baseReports = binomial(rng, v.baseAllImp, rates.report);
  v.baseNotInterested = binomial(rng, v.baseAllImp, rates.notInterested);
}

function initPool(v: SimVideo): void {
  v.pool = {
    videoId: v.videoId,
    sellerId: v.seller.sellerId,
    categoryId: v.categoryId,
    publishedAt: v.publishedAt,
    minPriceCents: v.priceCents,
    hashtags: v.hashtags,
    stats: {
      impressions24h: 0,
      purchases24h: 0,
      addToCarts24h: 0,
      productTaps24h: 0,
      completions24h: 0,
      skipsUnder2s24h: 0,
      shares24h: 0,
      saves24h: 0,
      avgLoopCount: 0,
      reportsAll: 0,
      notInterestedAll: 0,
      impressionsAll: 0,
      impressions1h: 0,
      purchases1h: 0,
      addToCarts1h: 0,
      productTaps1h: 0,
    },
    trust: v.seller.trust,
    budget: v.budget,
    status: 'live',
    seller: {
      sellerId: v.seller.sellerId,
      suspended: false,
      chargesEnabled: true,
      shipsToCountries: ['*'],
    },
    products: [{ productId: `${v.videoId}-p0`, status: 'active', inventoryCount: 50 }],
    revenueCents24h: 0,
    categoryLiveCount: 0,
  };
}

// ---------------------------------------------------------------------------
// Rolling windows
// ---------------------------------------------------------------------------

function addTo(dst: Counters, src: Counters): void {
  dst.imp += src.imp;
  dst.pur += src.pur;
  dst.cart += src.cart;
  dst.tap += src.tap;
  dst.comp += src.comp;
  dst.skip += src.skip;
  dst.share += src.share;
  dst.save += src.save;
  dst.loops += src.loops;
  dst.rev += src.rev;
}

function subFrom(dst: Counters, src: Counters): void {
  dst.imp -= src.imp;
  dst.pur -= src.pur;
  dst.cart -= src.cart;
  dst.tap -= src.tap;
  dst.comp -= src.comp;
  dst.skip -= src.skip;
  dst.share -= src.share;
  dst.save -= src.save;
  dst.loops -= src.loops;
  dst.rev -= src.rev;
}

/**
 * Expire whatever has fallen out of the 24h and 1h windows. Amortised O(1) —
 * each event is subtracted at most once per window. `nowMs` is monotonically
 * non-decreasing across the run by construction (sessions never overlap in
 * simulated time), which is what lets a single forward cursor work.
 */
function expireWindows(v: SimVideo, nowMs: number): void {
  const cut24 = nowMs - MS_DAY;
  while (v.head24 < v.events.length && v.events[v.head24].t <= cut24) {
    subFrom(v.w24, v.events[v.head24]);
    v.head24 += 1;
  }
  const cut1 = nowMs - MS_HOUR;
  while (v.head1 < v.events.length && v.events[v.head1].t <= cut1) {
    subFrom(v.w1, v.events[v.head1]);
    v.head1 += 1;
  }
}

/** Refresh the persistent PoolVideo in place. See the note on `SimVideo.pool`. */
function refreshPool(v: SimVideo, nowMs: number, categoryLiveCount: number): void {
  expireWindows(v, nowMs);
  const s = v.pool.stats;
  const imp = v.base24.imp + v.w24.imp;
  s.impressions24h = imp;
  s.purchases24h = v.base24.pur + v.w24.pur;
  s.addToCarts24h = v.base24.cart + v.w24.cart;
  s.productTaps24h = v.base24.tap + v.w24.tap;
  s.completions24h = v.base24.comp + v.w24.comp;
  s.skipsUnder2s24h = v.base24.skip + v.w24.skip;
  s.shares24h = v.base24.share + v.w24.share;
  s.saves24h = v.base24.save + v.w24.save;
  s.avgLoopCount = imp > 0 ? (v.base24.loops + v.w24.loops) / imp : 0;
  s.impressionsAll = v.baseAllImp + v.simAllImp;
  s.reportsAll = v.baseReports + v.simReports;
  s.notInterestedAll = v.baseNotInterested + v.simNotInterested;
  s.impressions1h = v.w1.imp;
  s.purchases1h = v.w1.pur;
  s.addToCarts1h = v.w1.cart;
  s.productTaps1h = v.w1.tap;
  v.pool.revenueCents24h = v.base24.rev + v.w24.rev;
  v.pool.categoryLiveCount = categoryLiveCount;
  v.pool.budget = v.budget;
}

// ---------------------------------------------------------------------------
// Category medians (contract 3)
// ---------------------------------------------------------------------------

const RATE_KEYS: readonly NormalisableRate[] = [
  'purchaseRate',
  'cartRate',
  'tapRate',
  'shareRate',
  'saveRate',
  'avgLoopCount',
  'skipUnder2sRate',
  'reportRate',
  'notInterestedRate',
];

/** Minimum 24h impressions before a video's rates count toward a median. */
const MEDIAN_MIN_IMPRESSIONS = 30;

function rateVector(v: SimVideo): Record<NormalisableRate, number> {
  const s = v.pool.stats;
  const i = s.impressions24h;
  const a = s.impressionsAll;
  return {
    purchaseRate: i > 0 ? s.purchases24h / i : 0,
    cartRate: i > 0 ? s.addToCarts24h / i : 0,
    tapRate: i > 0 ? s.productTaps24h / i : 0,
    shareRate: i > 0 ? s.shares24h / i : 0,
    saveRate: i > 0 ? s.saves24h / i : 0,
    avgLoopCount: s.avgLoopCount,
    skipUnder2sRate: i > 0 ? s.skipsUnder2s24h / i : 0,
    reportRate: a > 0 ? s.reportsAll / a : 0,
    notInterestedRate: a > 0 ? s.notInterestedAll / a : 0,
  };
}

/**
 * The v2 normalisation reference, derived rather than hardcoded (contract 3).
 * `normToReference` multiplies whatever comes out of here by 2.5; this function
 * only produces the medians.
 *
 * A category median of 0 is left AS 0 rather than papered over — purchases
 * genuinely are rare enough that a category's median video often has none in
 * 24h, and `resolveMedian` already owns the "a zero median is not a reference,
 * fall through to the global one" rule. Inventing a positive number here would
 * take that decision away from the module that documents it.
 */
export function computeCategoryMedians(videos: readonly SimVideo[]): CategoryMedians {
  const perCategory = new Map<string, Record<NormalisableRate, number>[]>();
  const global: Record<NormalisableRate, number>[] = [];

  for (const v of videos) {
    if (v.pool.stats.impressions24h < MEDIAN_MIN_IMPRESSIONS) continue;
    const row = rateVector(v);
    global.push(row);
    const bucket = perCategory.get(v.categoryId);
    if (bucket) bucket.push(row);
    else perCategory.set(v.categoryId, [row]);
  }

  const medianOf = (rows: readonly Record<NormalisableRate, number>[], rate: NormalisableRate) =>
    median(rows.map((r) => r[rate]).sort((a, b) => a - b));

  const fallback = {} as RateMedians;
  for (const rate of RATE_KEYS) {
    const m = global.length > 0 ? medianOf(global, rate) : 0;
    // The global fallback is the last line of defence; if the world itself has
    // no signal for a rate, keep the shipped default rather than a zero that
    // would push every video to the neutral 0.5.
    fallback[rate] = m > 0 ? m : DEFAULT_CATEGORY_MEDIANS.fallback[rate];
  }

  const byCategory: Record<string, Partial<RateMedians>> = {};
  for (const [categoryId, rows] of [...perCategory.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : 1
  )) {
    const entry: Partial<RateMedians> = {};
    for (const rate of RATE_KEYS) entry[rate] = medianOf(rows, rate);
    byCategory[categoryId] = entry;
  }

  return { byCategory, fallback };
}

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export type SimulationTotals = {
  sessions: number;
  slices: number;
  impressions: number;
  fastSkips: number;
  productTaps: number;
  addToCarts: number;
  checkoutOpens: number;
  purchases: number;
  revenueCents: number;
  /** Mean impressions actually served per session. */
  impressionsPerSession: number;
};

export type BudgetSummary = BudgetDeliveryReport & {
  /** New videos published during the run — the whole guarantee population. */
  published: number;
  /** published * 500. What the guarantee asked the feed for. */
  demandImpressions: number;
  /**
   * demandImpressions / total impressions. The honest sanity check on the
   * guardrail: the fresh lane can carry at most FRESH_CEILING/sliceSize (30%)
   * of impressions, so a demand share anywhere near that means the world is
   * over-subscribed and a failure says more about the sizing than the code.
   */
  demandShare: number;
};

export type QualitySplit = QualitySortingReport & { label: string };

/**
 * Why a number came out the way it did. None of these are guardrails; they are
 * the things you have to look at before believing one.
 *
 * `avgFreshPerFullSlice` in particular: the fresh FLOOR reserves its slots in
 * the TAIL of a slice (see select.ts), so a viewer who abandons at position 12
 * never sees them. If this sits below `freshFloor` while
 * `freshCandidatesPerSession` is comfortably above it, the floor is being
 * honoured by the selector and lost to abandonment — a fact about the product,
 * not a bug in select().
 */
export type SimulationDiagnostics = {
  /** Mean impressions actually served per slice returned by select(). */
  avgSliceLength: number;
  /** Slices where every position select() returned was actually served. */
  fullSlices: number;
  /** Mean fresh-lane videos served per fully-watched slice. Compare to freshFloor. */
  avgFreshPerFullSlice: number;
  /** Mean fresh-lane candidates in the generated pool, per session. */
  freshCandidatesPerSession: number;
  /** Slices that came back shorter than the slice size. */
  shortSlices: number;
  /** Slices where select() had to relax at least one constraint. */
  relaxedSlices: number;
  /** Sessions that ended because the viewer left rather than running out. */
  abandonedSessions: number;
};

export type SimulationResult = {
  strategy: SimulationStrategy;
  strategyDescription: string;
  sessions: number;
  seed: number;
  world: {
    sellers: number;
    matureVideos: number;
    newVideosPublished: number;
    viewers: number;
    durationHours: number;
    sessionsPerDay: number;
    sliceSize: number;
    freshFloor: number;
    freshCeiling: number;
    temperature: number;
  };
  totals: SimulationTotals;

  /** GUARDRAIL 0 — the objective. Dollars per 1,000 impressions. */
  rpm: number;
  /** GUARDRAIL 1 — impression Gini across all sellers, zeros included. */
  gini: number;
  /** GUARDRAIL 2 — new-video budget delivery. */
  budget: BudgetSummary;
  /** GUARDRAIL 3 — quality sorting, median split of latent seller quality. */
  quality: QualitySplit;
  /** Secondary view: top third vs bottom third, for shape rather than verdict. */
  qualityTercile: QualitySplit;

  sellersTotal: number;
  sellersReached: number;
  sellersZero: number;

  lanes: LaneMetrics;
  /** lanes.fresh.share, hoisted because it is the ceiling's whole story. */
  freshShare: number;
  funnel: FunnelReport;
  diagnostics: SimulationDiagnostics;

  guardrails: GuardrailVerdict;
  /** True when all three thresholded guardrails passed. */
  passed: boolean;
};

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** Uniforms drawn per impression, used or not. See the determinism note above. */
const DRAWS_PER_IMPRESSION = 12;

/** Interactions before a viewer stops being a cold start. */
const COLD_START_INTERACTIONS = 8;

/** Purchase prices remembered for the price band. */
const PRICE_MEMORY = 40;

const IMPRESSION_EVENT: FunnelEvent = { stage: 'impression' };
const TAP_EVENT: FunnelEvent = { stage: 'product_tap' };
const CART_EVENT: FunnelEvent = { stage: 'add_to_cart' };
const CHECKOUT_EVENT: FunnelEvent = { stage: 'checkout_open' };
const PURCHASE_EVENT: FunnelEvent = { stage: 'purchase' };

function emptyProfile(): ViewerProfile {
  return {
    categoryAffinity: {},
    sellerAffinity: {},
    hashtagAffinity: {},
    priceBand: null,
    coldStartComplete: false,
  };
}

function makeViewer(index: number, rng: Rng): SimViewer {
  // Peak-normalised taste: exactly one category sits at 1.0 and the rest fall
  // away, so "a viewer who likes footwear" is a real statement about them
  // rather than a rounding difference.
  const raw = SIM_CATEGORY_IDS.map(() => Math.pow(rng(), 2.5));
  const peak = Math.max(...raw, 1e-9);
  return {
    viewerId: `viewer-${String(index).padStart(4, '0')}`,
    fit: raw.map((r) => r / peak),
    logPriceCenter: Math.log(4000) + 0.7 * gaussian(rng),
    buyPropensity: rng(),
    profile: emptyProfile(),
    raw: { categoryAffinity: {}, sellerAffinity: {}, hashtagAffinity: {} },
    seenSellerIds: new Set(),
    purchasedSellerIds: new Set(),
    followedSellerIds: new Set(),
    notInterestedVideoIds: new Set(),
    sellerBlocks: [],
    purchasesByVideoId: new Map(),
    priceObservations: [],
    interactions: 0,
    lastAffinityAt: new Date(0),
  };
}

function priceBandOfObservations(obs: readonly number[]): PriceBand | null {
  if (obs.length < 4) return null;
  const sorted = [...obs].sort((a, b) => a - b);
  return {
    p25: quantile(sorted, 0.25),
    p50: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
  };
}

/**
 * Run one simulation.
 *
 * Pure with respect to the process: no clock, no global random source, no I/O.
 * The only inputs are `opts`, and the same `opts` always produce a byte-
 * identical `SimulationResult`.
 */
export function runSimulation(opts: SimulationOptions = {}): SimulationResult {
  const sessions = Math.max(1, Math.floor(opts.sessions ?? 2000));
  const seed = opts.seed ?? 20260105;
  const strategy = opts.strategy ?? 'softmax';
  const cfg: WorldConfig = { ...DEFAULT_WORLD, ...opts.world };
  const sliceSize = Math.max(1, Math.floor(cfg.sliceSize));
  const sc = strategyConfig(strategy, sliceSize);

  const viewerCount = Math.max(8, Math.floor(cfg.viewers ?? Math.max(24, Math.round(sessions / 8))));
  const startMs = cfg.startedAt.getTime();
  const sessionGapMs = Math.max(1, Math.round(MS_DAY / Math.max(1, cfg.sessionsPerDay)));
  const dwellMs = Math.max(1, Math.round(cfg.dwellSeconds * 1000));
  const durationMs = sessionGapMs * sessions;

  // ---- world -------------------------------------------------------------
  // One stream, consumed in a fixed order, so every strategy gets the same
  // catalogue and the same viewers down to the last decimal.
  const worldRng = mulberry32(mixSeed(seed, 0x5eed));

  const sellers: SimSeller[] = [];
  for (let i = 0; i < cfg.sellers; i += 1) sellers.push(makeSeller(i, worldRng));

  const videos: SimVideo[] = [];
  let videoCounter = 0;
  for (const seller of sellers) {
    for (let k = 0; k < cfg.videosPerSeller; k += 1) {
      // 3 to 90 days old: never inside the 48h fresh window, so the fresh lane
      // is made up exclusively of videos that publish during the run.
      const ageDays = uniform(worldRng, cfg.matureAgeDaysMin, cfg.matureAgeDaysMax);
      const publishedAt = new Date(startMs - ageDays * MS_DAY);
      const v = makeVideo(`vid-${String(videoCounter++).padStart(5, '0')}`, seller, publishedAt, false, worldRng);
      initPool(v);
      seedBaseline(v, ageDays, worldRng, cfg.baselineImpressions24hMin, cfg.baselineImpressions24hMax);
      videos.push(v);
    }
  }
  const matureVideos = videos.length;

  // New videos, published uniformly across the run. Those published in the last
  // 48h stay PENDING rather than counting as failures — see budgetDeliveryReport.
  const newVideoCount = Math.max(
    0,
    Math.round((durationMs / MS_DAY) * Math.max(0, cfg.newVideosPerDay))
  );
  const pending: SimVideo[] = [];
  for (let i = 0; i < newVideoCount; i += 1) {
    const seller = sellers[Math.floor(worldRng() * sellers.length) % sellers.length];
    const at = new Date(startMs + Math.round(((i + 0.5) / newVideoCount) * durationMs));
    const v = makeVideo(`new-${String(i).padStart(4, '0')}`, seller, at, true, worldRng);
    initPool(v);
    pending.push(v);
  }

  const viewers: SimViewer[] = [];
  for (let i = 0; i < viewerCount; i += 1) viewers.push(makeViewer(i, worldRng));

  // ---- live catalogue ----------------------------------------------------
  const live: SimVideo[] = [...videos];
  const livePool: PoolVideo[] = live.map((v) => v.pool);
  const categoryLive = new Map<string, number>();
  for (const v of live) categoryLive.set(v.categoryId, (categoryLive.get(v.categoryId) ?? 0) + 1);
  let nextPublish = 0;

  let medians: CategoryMedians = DEFAULT_CATEGORY_MEDIANS;
  let mediansRefreshedAt = -Infinity;

  // ---- accumulators ------------------------------------------------------
  const sellerImpressions = new Map<string, number>();
  for (const s of sellers) sellerImpressions.set(s.sellerId, 0);
  const laneTotals = new Map<CandidateLane, { impressions: number; revenueCents: number }>();
  for (const lane of LANES) laneTotals.set(lane, { impressions: 0, revenueCents: 0 });

  const funnelCounts = {
    impression: 0,
    product_tap: 0,
    add_to_cart: 0,
    checkout_open: 0,
    purchase: 0,
  };

  const diag = {
    fullSlices: 0,
    shortSlices: 0,
    relaxedSlices: 0,
    abandonedSessions: 0,
    freshInFullSlices: 0,
    freshCandidates: 0,
  };

  const totals: SimulationTotals = {
    sessions: 0,
    slices: 0,
    impressions: 0,
    fastSkips: 0,
    productTaps: 0,
    addToCarts: 0,
    checkoutOpens: 0,
    purchases: 0,
    revenueCents: 0,
    impressionsPerSession: 0,
  };

  // ---- session loop ------------------------------------------------------
  for (let s = 0; s < sessions; s += 1) {
    const sessionStartMs = startMs + s * sessionGapMs;
    const sessionStart = new Date(sessionStartMs);

    // Publish anything due. A newly live video changes its category's live count
    // and therefore the thin-category freshness multiplier.
    while (nextPublish < pending.length && pending[nextPublish].publishedAtMs <= sessionStartMs) {
      const v = pending[nextPublish++];
      live.push(v);
      livePool.push(v.pool);
      categoryLive.set(v.categoryId, (categoryLive.get(v.categoryId) ?? 0) + 1);
    }

    // Freeze the guarantee outcome for any window that has just shut.
    for (let i = 0; i < nextPublish; i += 1) {
      const v = pending[i];
      if (v.deliveredAtWindowClose !== null || v.budget === null) continue;
      if (sessionStartMs - v.budget.windowStart.getTime() >= IMPRESSION_BUDGET_WINDOW_HOURS * MS_HOUR) {
        v.deliveredAtWindowClose = v.budget.impressionsDelivered;
      }
    }

    for (const v of live) refreshPool(v, sessionStartMs, categoryLive.get(v.categoryId) ?? 0);

    // The medians are a nightly job, so they are recomputed once per simulated
    // day rather than per request — and the ranker spends the day running
    // against a table that is up to 24h stale, exactly as it would in
    // production.
    if (sessionStartMs - mediansRefreshedAt >= MS_DAY) {
      medians = computeCategoryMedians(live);
      mediansRefreshedAt = sessionStartMs;
    }

    const viewer = viewers[s % viewers.length];
    const genRng = mulberry32(mixSeed(seed, s, 0xa1));
    const selRng = mulberry32(mixSeed(seed, s, 0xb2));
    const behaviourRng = mulberry32(mixSeed(seed, s, 0xc3));

    const blockedSellers = new Set<string>();
    for (const b of viewer.sellerBlocks) if (isSellerBlocked(b, sessionStart)) blockedSellers.add(b.sellerId);

    const viewerCtx: ViewerContext = {
      viewerId: viewer.viewerId,
      profile: viewer.profile,
      countryCode: 'US',
      notInterestedVideoIds: viewer.notInterestedVideoIds,
      notInterestedSellerIds: blockedSellers,
      followedSellerIds: viewer.followedSellerIds,
      purchasedSellerIds: viewer.purchasedSellerIds,
      purchasesByVideoId: viewer.purchasesByVideoId,
    };

    const generated = generateCandidates(livePool, viewerCtx, {
      rng: genRng,
      now: sessionStart,
      targetSize: cfg.targetCandidates,
      laneShares: cfg.laneShares,
      coldStartLaneShares: cfg.coldStartLaneShares,
    });
    diag.freshCandidates += generated.byLane.fresh.length;
    const byId = new Map<string, SimVideo>();
    for (const v of live) byId.set(v.videoId, v);

    let state: AdaptiveSessionState = initialSessionState(`sess-${s}`, sessionStart);
    const recent: RecentContext = {
      sellerIds: [],
      categoryIds: [],
      priceCents: [],
      seenSellerIds: viewer.seenSellerIds,
    };
    const affinityEvents: AffinityEvent[] = [];
    let impressionIndex = 0;
    let abandoned = false;
    totals.sessions += 1;

    for (let sliceNo = 0; sliceNo < cfg.maxSlices && !abandoned; sliceNo += 1) {
      const sliceStartMs = sessionStartMs + impressionIndex * dwellMs;
      const sliceNow = new Date(sliceStartMs);
      const weights = sessionWeights(DEFAULT_WEIGHTS, state, !viewer.profile.coldStartComplete);
      const boosts = sessionBoosts(state);

      const scored: ScoredCandidate[] = [];
      for (const cand of generated.candidates) {
        if (state.servedVideoIds.has(cand.videoId)) continue;
        if (isSellerSuppressed(boosts, cand.sellerId)) continue;
        const row = scoreCandidate(
          cand,
          viewer.profile,
          recent,
          weights,
          medians,
          sliceNow,
          thinCategoryMultiplier(cand.categoryLiveCount)
        );
        // Spec 2.6's within-session boosts are a multiplier on the composite
        // score, not a sixth signal — they steer an existing ranking rather
        // than re-weighting it.
        const boost = candidateBoost(boosts, cand);
        if (boost !== 1) row.score *= boost;
        scored.push(row);
      }
      if (scored.length === 0) break;

      const result = select(scored, recent, {
        rng: selRng,
        sliceSize,
        temperature: sc.temperature,
        freshFloor: sc.freshFloor,
        freshCeiling: sc.freshCeiling,
        budgetOwed: budgetOwedIds(scored, sliceNow),
      });
      if (result.slice.length === 0) break;
      totals.slices += 1;
      if (result.slice.length < sliceSize) diag.shortSlices += 1;
      if (result.relaxed.length > 0) diag.relaxedSlices += 1;

      // Spec 2.6's idle rule. Two minutes of silence buys one high-velocity
      // trending video, swapped over the first non-fresh slot so the fresh floor
      // is never spent paying for it.
      const slice = result.slice.slice();
      if (needsTrendingInjection(state, sliceNow)) {
        const inSlice = new Set(slice.map((c) => c.videoId));
        const injection = scored.find((c) => c.lane === 'trending' && !inSlice.has(c.videoId));
        if (injection) {
          const target = slice.findIndex((c) => c.lane !== 'fresh');
          if (target >= 0) slice[target] = injection;
        }
      }

      let servedInSlice = 0;
      let freshInSlice = 0;
      for (const cand of slice) {
        const v = byId.get(cand.videoId);
        if (!v) continue;
        const tMs = sessionStartMs + impressionIndex * dwellMs;
        const t = new Date(tMs);
        impressionIndex += 1;
        servedInSlice += 1;
        if (cand.lane === 'fresh') freshInSlice += 1;

        // --- impression ---------------------------------------------------
        const ev: WindowEvent = { ...zeroCounters(), t: tMs, imp: 1 };
        v.simAllImp += 1;
        v.simImpressions += 1;
        totals.impressions += 1;
        sellerImpressions.set(cand.sellerId, (sellerImpressions.get(cand.sellerId) ?? 0) + 1);
        const laneRow = laneTotals.get(cand.lane);
        if (laneRow) laneRow.impressions += 1;
        funnelCounts.impression += 1;
        viewer.seenSellerIds.add(cand.sellerId);
        if (v.budget && !v.budget.satisfied) {
          v.budget.impressionsDelivered += 1;
          if (v.budget.impressionsDelivered >= v.budget.budgetTotal) v.budget.satisfied = true;
        }
        state = applySessionEvent(
          state,
          {
            type: 'impression',
            videoId: cand.videoId,
            sellerId: cand.sellerId,
            categoryId: cand.categoryId,
            lane: cand.lane,
          },
          t
        );
        recent.sellerIds.unshift(cand.sellerId);
        recent.categoryIds.unshift(cand.categoryId);
        recent.priceCents.unshift(cand.minPriceCents);
        if (recent.sellerIds.length > 12) {
          recent.sellerIds.pop();
          recent.categoryIds.pop();
          recent.priceCents.pop();
        }

        // --- the viewer's turn ---------------------------------------------
        const u: number[] = [];
        for (let d = 0; d < DRAWS_PER_IMPRESSION; d += 1) u.push(behaviourRng());

        const catIndex = SIM_CATEGORY_IDS.indexOf(v.categoryId);
        const fit = catIndex >= 0 ? viewer.fit[catIndex] : 0.2;
        const priceFit = Math.exp(
          -0.5 * Math.pow((Math.log(v.priceCents) - viewer.logPriceCenter) / 0.75, 2)
        );
        // BOTH latent fit AND intrinsic quality, multiplicatively. A viewer who
        // likes footwear converts more on footwear, and a good video converts
        // more than a bad one — but neither alone is enough, which is what makes
        // a better-ranked feed earn genuinely more revenue.
        const match = clamp01((0.25 + 0.75 * fit) * (0.25 + 0.75 * v.appeal) * (0.4 + 0.6 * priceFit));
        const rates = trueRates(v.appeal, v.seller.quality, viewer.buyPropensity);
        const pSkip = clamp01(0.62 - 0.62 * match);

        if (u[0] < pSkip) {
          ev.skip = 1;
          totals.fastSkips += 1;
          state = applySessionEvent(
            state,
            { type: 'fast_skip', videoId: cand.videoId, sellerId: cand.sellerId, categoryId: cand.categoryId },
            t
          );
          affinityEvents.push({
            type: 'fast_skip',
            categoryId: cand.categoryId,
            sellerId: cand.sellerId,
            hashtags: cand.hashtags,
          });
        } else {
          const completion = clamp01(0.2 + 0.95 * match + 0.2 * (u[1] - 0.5));
          const watch = watchEventType(completion);
          if (watch) {
            affinityEvents.push({
              type: watch,
              categoryId: cand.categoryId,
              sellerId: cand.sellerId,
              hashtags: cand.hashtags,
            });
            if (watch === 'watch95') {
              ev.comp = 1;
              state = applySessionEvent(
                state,
                { type: 'any_interaction', kind: 'watch95', sellerId: cand.sellerId, categoryId: cand.categoryId },
                t
              );
            }
          }
          ev.loops = 1 + (ev.comp === 1 && u[2] < rates.loopBonus ? 1 : 0);

          if (u[3] < clamp01(0.03 + 0.6 * match)) {
            ev.tap = 1;
            totals.productTaps += 1;
            funnelCounts.product_tap += 1;
            viewer.interactions += 1;
            viewer.priceObservations.push(v.priceCents);
            if (viewer.priceObservations.length > PRICE_MEMORY) viewer.priceObservations.shift();
            state = applySessionEvent(
              state,
              { type: 'product_tap', categoryId: cand.categoryId, priceCents: cand.minPriceCents, sellerId: cand.sellerId },
              t
            );
            affinityEvents.push({
              type: 'product_tap',
              categoryId: cand.categoryId,
              sellerId: cand.sellerId,
              hashtags: cand.hashtags,
            });

            if (u[4] < rates.cartGivenTap) {
              ev.cart = 1;
              totals.addToCarts += 1;
              funnelCounts.add_to_cart += 1;
              affinityEvents.push({
                type: 'add_to_cart',
                categoryId: cand.categoryId,
                sellerId: cand.sellerId,
                hashtags: cand.hashtags,
              });
              state = applySessionEvent(
                state,
                { type: 'any_interaction', kind: 'add_to_cart', sellerId: cand.sellerId, categoryId: cand.categoryId },
                t
              );

              if (u[5] < rates.checkoutGivenCart) {
                totals.checkoutOpens += 1;
                funnelCounts.checkout_open += 1;
                affinityEvents.push({
                  type: 'checkout_open',
                  categoryId: cand.categoryId,
                  sellerId: cand.sellerId,
                  hashtags: cand.hashtags,
                });

                if (u[6] < rates.purchaseGivenCheckout) {
                  ev.pur = 1;
                  ev.rev = v.priceCents;
                  totals.purchases += 1;
                  totals.revenueCents += v.priceCents;
                  funnelCounts.purchase += 1;
                  v.simRevenueCents += v.priceCents;
                  if (laneRow) laneRow.revenueCents += v.priceCents;
                  viewer.purchasedSellerIds.add(cand.sellerId);
                  viewer.purchasesByVideoId.set(cand.videoId, {
                    purchasedAt: t,
                    hasUnpurchasedItems: false,
                  });
                  viewer.interactions += 2;
                  state = applySessionEvent(
                    state,
                    { type: 'purchase', sellerId: cand.sellerId, categoryId: cand.categoryId, priceCents: cand.minPriceCents },
                    t
                  );
                  affinityEvents.push({
                    type: 'purchase',
                    categoryId: cand.categoryId,
                    sellerId: cand.sellerId,
                    hashtags: cand.hashtags,
                  });
                  // A good purchase sometimes turns into a follow, which is the
                  // only thing that ever populates the social lane.
                  if (u[7] < 0.25 * v.seller.quality) {
                    viewer.followedSellerIds.add(cand.sellerId);
                    affinityEvents.push({ type: 'follow', sellerId: cand.sellerId });
                  }
                }
              }
            }
          }

          if (u[8] < rates.share) {
            ev.share = 1;
            affinityEvents.push({ type: 'share', categoryId: cand.categoryId, sellerId: cand.sellerId, hashtags: cand.hashtags });
            state = applySessionEvent(state, { type: 'any_interaction', kind: 'share', sellerId: cand.sellerId, categoryId: cand.categoryId }, t);
          }
          if (u[9] < rates.save) {
            ev.save = 1;
            affinityEvents.push({ type: 'save', categoryId: cand.categoryId, sellerId: cand.sellerId, hashtags: cand.hashtags });
            state = applySessionEvent(state, { type: 'any_interaction', kind: 'save', sellerId: cand.sellerId, categoryId: cand.categoryId }, t);
          }
        }

        if (u[10] < rates.notInterested) {
          v.simNotInterested += 1;
          viewer.notInterestedVideoIds.add(cand.videoId);
          affinityEvents.push({ type: 'not_interested', categoryId: cand.categoryId, sellerId: cand.sellerId });
        }
        if (u[10] > 1 - rates.report) v.simReports += 1;

        v.events.push(ev);
        addTo(v.w24, ev);
        addTo(v.w1, ev);

        // Leaving is a real outcome and a skippy feed earns more of it.
        const pLeave = Math.min(0.3, 0.002 + 0.008 * state.consecutiveFastSkips);
        if (u[11] < pLeave) {
          abandoned = true;
          break;
        }
      }

      if (servedInSlice === slice.length) {
        diag.fullSlices += 1;
        diag.freshInFullSlices += freshInSlice;
      }
    }
    if (abandoned) diag.abandonedSessions += 1;

    // --- end of session: one affinity cron pass for this viewer -------------
    const sessionEndMs = sessionStartMs + Math.max(1, impressionIndex) * dwellMs;
    const sessionEnd = new Date(sessionEndMs);
    const daysElapsed =
      viewer.lastAffinityAt.getTime() === 0
        ? 0
        : Math.max(0, (sessionEndMs - viewer.lastAffinityAt.getTime()) / MS_DAY);
    // The cron's running state is the RAW map, not the normalised profile —
    // feeding the profile back in is the scale mismatch affinity.ts warns about.
    const source: ViewerProfile = {
      ...viewer.profile,
      categoryAffinity: viewer.raw.categoryAffinity,
      sellerAffinity: viewer.raw.sellerAffinity,
      hashtagAffinity: viewer.raw.hashtagAffinity,
    };
    const update = updateViewerAffinity(source, affinityEvents, daysElapsed, sessionEnd);
    viewer.raw = update.raw;
    viewer.lastAffinityAt = sessionEnd;
    for (const block of update.sellerBlocks) viewer.sellerBlocks.push(block);
    viewer.profile = {
      ...update.profile,
      priceBand: priceBandOfObservations(viewer.priceObservations),
      coldStartComplete: viewer.interactions >= COLD_START_INTERACTIONS,
    };
  }

  totals.impressionsPerSession = totals.sessions > 0 ? totals.impressions / totals.sessions : 0;

  // ---- metrics -----------------------------------------------------------
  const sellerRows = sellers.map((s) => ({
    sellerId: s.sellerId,
    impressions: sellerImpressions.get(s.sellerId) ?? 0,
    quality: s.quality,
  }));
  const gini = impressionGini(sellerRows);
  const sellersReached = sellerRows.filter((r) => r.impressions > 0).length;

  const budgetObservations: BudgetObservation[] = [];
  for (let i = 0; i < nextPublish; i += 1) {
    const v = pending[i];
    if (!v.budget) continue;
    budgetObservations.push({
      videoId: v.videoId,
      impressionsDelivered: v.deliveredAtWindowClose ?? v.budget.impressionsDelivered,
      budgetTotal: v.budget.budgetTotal,
      windowStart: v.budget.windowStart,
    });
  }
  const runEnd = new Date(startMs + durationMs);
  const delivery = budgetDeliveryReport(budgetObservations, runEnd);
  const demandImpressions = budgetObservations.length * IMPRESSION_BUDGET_TOTAL;
  const budget: BudgetSummary = {
    ...delivery,
    published: budgetObservations.length,
    demandImpressions,
    demandShare: totals.impressions > 0 ? demandImpressions / totals.impressions : 0,
  };

  const qualityMedian = median([...sellers.map((s) => s.quality)].sort((a, b) => a - b));
  const quality: QualitySplit = {
    ...qualitySortingReport(sellerRows, (r) => r.quality >= qualityMedian),
    label: `latent quality >= median (${qualityMedian.toFixed(3)})`,
  };
  const sortedQ = [...sellers.map((s) => s.quality)].sort((a, b) => a - b);
  const lowCut = quantile(sortedQ, 1 / 3);
  const highCut = quantile(sortedQ, 2 / 3);
  const qualityTercile: QualitySplit = {
    ...qualitySortingReport(
      sellerRows.filter((r) => r.quality >= highCut || r.quality <= lowCut),
      (r) => r.quality >= highCut
    ),
    label: 'top tercile vs bottom tercile',
  };

  const laneObservations: LaneObservation[] = LANES.map((lane) => {
    const row = laneTotals.get(lane);
    return { lane, impressions: row?.impressions ?? 0, revenueCents: row?.revenueCents ?? 0 };
  });
  const lanes = laneMetrics(laneObservations);

  const funnelEvents: FunnelEvent[] = [];
  for (let i = 0; i < funnelCounts.impression; i += 1) funnelEvents.push(IMPRESSION_EVENT);
  for (let i = 0; i < funnelCounts.product_tap; i += 1) funnelEvents.push(TAP_EVENT);
  for (let i = 0; i < funnelCounts.add_to_cart; i += 1) funnelEvents.push(CART_EVENT);
  for (let i = 0; i < funnelCounts.checkout_open; i += 1) funnelEvents.push(CHECKOUT_EVENT);
  for (let i = 0; i < funnelCounts.purchase; i += 1) funnelEvents.push(PURCHASE_EVENT);
  const funnelReport = funnel(funnelEvents);

  const rpm = rpmOf(totals.revenueCents, totals.impressions);
  const guardrails = evaluateGuardrails({
    gini,
    budgetDelivery: budget.rate,
    qualityRatio: quality.ratio,
    rpm,
  });

  return {
    strategy,
    strategyDescription: sc.description,
    sessions,
    seed,
    world: {
      sellers: cfg.sellers,
      matureVideos,
      newVideosPublished: nextPublish,
      viewers: viewerCount,
      durationHours: durationMs / MS_HOUR,
      sessionsPerDay: cfg.sessionsPerDay,
      sliceSize,
      freshFloor: sc.freshFloor,
      freshCeiling: sc.freshCeiling,
      temperature: sc.temperature,
    },
    totals,
    rpm,
    gini,
    budget,
    quality,
    qualityTercile,
    sellersTotal: sellers.length,
    sellersReached,
    sellersZero: sellers.length - sellersReached,
    lanes,
    freshShare: lanes.fresh.share,
    funnel: funnelReport,
    diagnostics: {
      avgSliceLength: totals.slices > 0 ? totals.impressions / totals.slices : 0,
      fullSlices: diag.fullSlices,
      avgFreshPerFullSlice: diag.fullSlices > 0 ? diag.freshInFullSlices / diag.fullSlices : 0,
      freshCandidatesPerSession: totals.sessions > 0 ? diag.freshCandidates / totals.sessions : 0,
      shortSlices: diag.shortSlices,
      relaxedSlices: diag.relaxedSlices,
      abandonedSessions: diag.abandonedSessions,
    },
    guardrails,
    passed: guardrails.passed,
  };
}

// ---------------------------------------------------------------------------
// The comparative run
// ---------------------------------------------------------------------------

export type StrategyComparison = Record<SimulationStrategy, SimulationResult>;

/**
 * The same world under all three selection regimes.
 *
 * This is the only way to say anything about the spec's central empirical
 * claim — "the equity was free" — because RPM has no absolute meaning. A run
 * reporting $35 RPM is neither good nor bad; $35 against $35 with the Gini down
 * twenty points is an argument.
 */
export function compareStrategies(
  opts: Omit<SimulationOptions, 'strategy'> = {}
): StrategyComparison {
  return {
    greedy: runSimulation({ ...opts, strategy: 'greedy' }),
    softmax: runSimulation({ ...opts, strategy: 'softmax' }),
    'floor-only': runSimulation({ ...opts, strategy: 'floor-only' }),
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function ratioText(r: number | null): string {
  if (r === null) return 'n/a';
  if (!Number.isFinite(r)) return 'Infinity';
  return `${r.toFixed(2)}x`;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function padLeft(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

/** One run, in full. */
export function formatResult(r: SimulationResult): string {
  const lines: string[] = [];
  lines.push(`--- ${r.strategy} (${r.strategyDescription}) ---`);
  lines.push(
    `world      ${r.world.sellers} sellers, ${r.world.matureVideos} mature videos, ` +
      `${r.world.newVideosPublished} published during the run, ${r.world.viewers} viewers, ` +
      `${r.world.durationHours.toFixed(0)}h of simulated time`
  );
  lines.push(
    `traffic    ${r.totals.sessions} sessions, ${r.totals.slices} slices, ` +
      `${r.totals.impressions} impressions (${r.totals.impressionsPerSession.toFixed(1)}/session)`
  );
  lines.push(
    `revenue    ${money(r.totals.revenueCents)} from ${r.totals.purchases} purchases   RPM $${r.rpm.toFixed(2)}`
  );
  lines.push('');
  for (const check of r.guardrails.checks) {
    const value =
      check.value === null
        ? 'n/a'
        : check.id === 'gini'
          ? check.value.toFixed(4)
          : check.id === 'budgetDelivery'
            ? pct(check.value)
            : check.id === 'qualityRatio'
              ? ratioText(check.value)
              : `$${check.value.toFixed(2)}`;
    lines.push(
      `  [${pad(check.status.toUpperCase(), 6)}] ${pad(check.id, 15)} ${padLeft(value, 10)}  ` +
        `(threshold ${check.threshold})`
    );
  }
  lines.push('');
  lines.push(
    `sellers    ${r.sellersReached}/${r.sellersTotal} reached, ${r.sellersZero} with zero impressions`
  );
  lines.push(
    `quality    ${ratioText(r.quality.ratio)} [${r.quality.label}]  ` +
      `high mean ${r.quality.highMean.toFixed(1)} / low mean ${r.quality.lowMean.toFixed(1)}`
  );
  lines.push(
    `           ${ratioText(r.qualityTercile.ratio)} [${r.qualityTercile.label}]`
  );
  lines.push(
    `budget     ${pct(r.budget.rate)} delivered  (${r.budget.delivered} delivered, ` +
      `${r.budget.starved.length} starved, ${r.budget.pending} pending, ${r.budget.decided} decided)`
  );
  lines.push(
    `           guarantee demanded ${r.budget.demandImpressions} impressions = ` +
      `${pct(r.budget.demandShare)} of all impressions served`
  );
  if (r.budget.starved.length > 0) {
    lines.push(`           starved: ${r.budget.starved.slice(0, 12).join(', ')}`);
  }
  lines.push('');
  lines.push(`lane        impressions     share      revenue        RPM`);
  for (const lane of LANES) {
    const m = r.lanes[lane];
    lines.push(
      `  ${pad(lane, 10)}${padLeft(String(m.impressions), 10)}${padLeft(pct(m.share), 11)}` +
        `${padLeft(money(m.revenueCents), 13)}${padLeft(`$${m.rpm.toFixed(2)}`, 11)}`
    );
  }
  lines.push('');
  lines.push(
    `slices     ${r.diagnostics.avgSliceLength.toFixed(1)} impressions/slice, ` +
      `${r.diagnostics.fullSlices}/${r.totals.slices} fully watched, ${r.diagnostics.shortSlices} returned short, ` +
      `${r.diagnostics.relaxedSlices} needed relaxation`
  );
  lines.push(
    `fresh      ${r.diagnostics.freshCandidatesPerSession.toFixed(1)} fresh candidates/session, ` +
      `${r.diagnostics.avgFreshPerFullSlice.toFixed(2)} fresh per fully-watched slice ` +
      `(floor ${r.world.freshFloor}, ceiling ${r.world.freshCeiling})`
  );
  lines.push(`funnel     ${r.funnel.steps.map((s) => `${s.from}->${s.to} ${pct(s.rate)}`).join('   ')}`);
  lines.push(`           overall impression->purchase ${pct(r.funnel.overall)}`);
  return lines.join('\n');
}

/** All three, side by side. This is the table the spec's claim lives or dies on. */
export function formatComparison(c: StrategyComparison): string {
  const order: SimulationStrategy[] = ['greedy', 'softmax', 'floor-only'];
  const rows: [string, (r: SimulationResult) => string][] = [
    ['RPM (USD)', (r) => `$${r.rpm.toFixed(2)}`],
    ['revenue', (r) => money(r.totals.revenueCents)],
    ['impressions', (r) => String(r.totals.impressions)],
    ['impression Gini', (r) => r.gini.toFixed(4)],
    ['sellers reached', (r) => `${r.sellersReached}/${r.sellersTotal}`],
    ['zero-impression sellers', (r) => String(r.sellersZero)],
    ['budget delivery', (r) => pct(r.budget.rate)],
    ['  decided / starved', (r) => `${r.budget.decided} / ${r.budget.starved.length}`],
    ['quality ratio (median split)', (r) => ratioText(r.quality.ratio)],
    ['quality ratio (terciles)', (r) => ratioText(r.qualityTercile.ratio)],
    ['fresh-lane share', (r) => pct(r.freshShare)],
    ['fresh-lane RPM', (r) => `$${r.lanes.fresh.rpm.toFixed(2)}`],
    ['affinity-lane share', (r) => pct(r.lanes.affinity.share)],
    ['affinity-lane RPM', (r) => `$${r.lanes.affinity.rpm.toFixed(2)}`],
    ['purchase rate', (r) => pct(r.funnel.overall)],
    ['guardrails', (r) => (r.passed ? 'PASS' : 'FAIL')],
  ];

  const width = 30;
  const col = 16;
  const lines: string[] = [];
  lines.push(pad('metric', width) + order.map((s) => padLeft(s, col)).join(''));
  lines.push('-'.repeat(width + col * order.length));
  for (const [label, fn] of rows) {
    lines.push(pad(label, width) + order.map((s) => padLeft(fn(c[s]), col)).join(''));
  }
  return lines.join('\n');
}

/**
 * The whole report: the comparison table plus each run in full. This is what
 * `npm run simulate` prints, and what "run simulate.ts and check all four
 * guardrails" means in practice.
 */
export function formatFullReport(c: StrategyComparison): string {
  const parts: string[] = [];
  const any = c.softmax;
  parts.push('='.repeat(78));
  parts.push(`DRIP RANKING SIMULATION — ${any.sessions} sessions, seed ${any.seed}`);
  parts.push('='.repeat(78));
  parts.push('');
  parts.push(formatComparison(c));
  parts.push('');
  for (const strategy of SIMULATION_STRATEGIES) {
    parts.push(formatResult(c[strategy]));
    parts.push('');
  }
  return parts.join('\n');
}
