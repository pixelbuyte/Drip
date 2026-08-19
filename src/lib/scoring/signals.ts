// The eight per-candidate signals of spec 2.2, v2.
//
//   score = 0.35*commerce + 0.20*engagement + 0.20*affinity
//         + 0.10*freshness + 0.10*trust + 0.05*diversity
//         - 0.15*fatigue - 0.25*quality
//
// Every function here is pure and takes its clock and its reference tables as
// explicit parameters. Nothing reads Date.now() or Math.random().
//
// ---------------------------------------------------------------------------
// v2 CHANGE 1 — WHICH INPUTS ARE EVIDENCE-GATED, AND WHY
// ---------------------------------------------------------------------------
//
// The gate (see normalize.ts) blends a signal toward 0.5 in proportion to how
// little evidence stands behind it:
//
//   e = clamp01(impressions / threshold);  gated = e * observed + (1 - e) * 0.5
//
// It answers a different question from Bayesian smoothing. Smoothing asks
// "given a prior, what is the best estimate of this rate?"; the gate asks "how
// much should an estimate this thin be allowed to move the score at all?" So
// every rate-based input is smoothed AND THEN gated, in that order, and the
// normalisation to 0-1 happens between them because 0.5 is only a neutral value
// on the normalised scale (see `gatedNormalisedRate`'s doc comment for the
// measured proof that gating a raw rate inverts the correction).
//
// GATED — measured over THIS video's impressions, so the impression count is a
// genuine sample size:
//   commerce    purchase rate, cart rate, tap rate       (24h impressions)
//   engagement  completion rate, avg loop count,
//               share rate, save rate                    (24h impressions)
//   quality     fast-skip rate                           (24h impressions)
//               report rate, not-interested rate         (all-time impressions)
//
// Each of those uses the denominator its numerator was actually counted
// against: reports and not-interested are lifetime counters, so they gate on
// lifetime impressions, not on the 24h window.
//
// NOT GATED — nothing here is a rate sampled over this video's impressions, so
// there is no sample size to be uncertain about, and pulling the input toward
// 0.5 would state a doubt that does not exist:
//   freshness         a subtraction of two timestamps. Exact. Gating it would
//                     say "we are not sure this video is two hours old".
//   trust.*           seller-level attributes over the seller's order history,
//                     not over this video's impressions. Their evidence
//                     discount already exists and is explicit: TIER_BONUS.new
//                     is 0.5, which is the trust side's evidence gate, applied
//                     by hand at the only place the sample size is known.
//   ratingAvg         bounded 0-5 by construction, so it normalises against
//                     RATING_SCALE_MAX rather than a median, and it is a
//                     seller attribute besides.
//   priceBandFit      a deterministic function of a price and the viewer's
//                     band. Not a measurement of this video.
//   affinity.*        measured over the VIEWER's history. Its sample size is
//                     the viewer's event count, which has nothing to do with
//                     this video's impressions; gating it on them would be a
//                     category error.
//   diversity, fatigue  positional facts about the last N videos served.
//                     Exact, and known with certainty.
//
// A consequence worth stating out loud, because it looks like a bug: a video
// with zero impressions gates to exactly 0.5 on EVERY gated input, including
// the quality penalty. It is therefore scored as exactly average — not good,
// not bad. That is the correct reading of "no evidence", and it is also why
// ImpressionBudget exists (types.ts): the gate will never let an unproven video
// earn its way in on a fluke, so the 500-impression guarantee is what buys it
// the evidence to be judged on.
//
// ---------------------------------------------------------------------------
// v2 CHANGE 2 — NORMALISATION IS 2.5x THE CATEGORY MEDIAN
// ---------------------------------------------------------------------------
//
// v1 divided every rate by a hardcoded global cap. v2 divides by
// 2.5 * median(rate | category), resolved per candidate. Two corrections in
// one: a category's "good" is not another category's good, and the 2.5x is what
// stops an average video normalising to 1.0 — at the median a signal is 0.4,
// leaving the top of the scale for genuine outperformance.
//
// The same table is the Bayesian prior and the basis of the normalisation
// reference, so the two can never drift apart.

import {
  clamp01,
  gatedNormalisedRate,
  gatedNormalisedValue,
  evidenceGate,
  norm,
  safeRate,
} from './normalize';
import {
  RATING_SCALE_MAX,
  TIER_BONUS,
  medianFor,
  priceBandOf,
  type Candidate,
  type CandidateTrust,
  type CategoryMedians,
  type NormalisableRate,
  type PriceBand,
  type RecentContext,
  type ViewerProfile,
  type Weights,
} from './types';

/**
 * Resolve (category median, global fallback median) for one rate.
 *
 * Both halves are handed to the normalize helpers rather than pre-collapsed,
 * because `resolveMedian` owns the "a zero median is not a reference" rule and
 * must be the only place that decides it.
 */
function medians(
  medianTable: CategoryMedians,
  rate: NormalisableRate,
  categoryId: string | null
): [category: number, fallback: number] {
  return [medianFor(medianTable, rate, categoryId), medianTable.fallback[rate]];
}

// ---------------------------------------------------------------------------
// Commerce
// ---------------------------------------------------------------------------

/**
 * The reason this platform exists: purchase intent, not watch time.
 *
 * All three rates are smoothed toward the category median, normalised against
 * 2.5x it, then gated on the 24h impression count. The weights sum to 1, so a
 * video with no impressions at all scores exactly 0.5 here.
 */
export function commerceSignal(c: Candidate, w: Weights, medianTable: CategoryMedians): number {
  const imp = c.stats.impressions24h;
  const cat = c.categoryId;
  const rate = (n: number, r: NormalisableRate) =>
    gatedNormalisedRate(
      n,
      imp,
      ...medians(medianTable, r, cat),
      w.bayesAlpha,
      w.evidenceThreshold,
      w.normReferenceMultiplier
    );

  return (
    0.45 * rate(c.stats.purchases24h, 'purchaseRate') +
    0.3 * rate(c.stats.addToCarts24h, 'cartRate') +
    0.25 * rate(c.stats.productTaps24h, 'tapRate')
  );
}

// ---------------------------------------------------------------------------
// Engagement
// ---------------------------------------------------------------------------

/**
 * Likes appear nowhere in this function, deliberately. The spec: "Explicitly do
 * not weight likes heavily. Likes are cheap and correlate poorly with purchase."
 *
 * Completion is the one rate here that is NOT median-normalised: it is bounded
 * to 0-1 by construction (completions cannot exceed impressions), so it is
 * already on the scale everything else has to be mapped onto, and a reference
 * would only re-scale a scale. It is still gated — a 100% completion rate over
 * three impressions is exactly as uninformative as a 33% purchase rate over
 * three. It is not additionally Bayes-smoothed, because on a bounded scale the
 * gate's pull toward 0.5 already IS the shrinkage a 0.5-prior smoothing would
 * apply, and doing both would shrink the same estimate twice.
 *
 * avgLoopCount is a measured level rather than conversions over impressions, so
 * there is nothing to smooth; it is normalised against its category median and
 * gated like everything else.
 */
export function engagementSignal(c: Candidate, w: Weights, medianTable: CategoryMedians): number {
  const imp = c.stats.impressions24h;
  const cat = c.categoryId;

  const completion = evidenceGate(
    clamp01(safeRate(c.stats.completions24h, imp)),
    imp,
    w.evidenceThreshold
  );

  const loop = gatedNormalisedValue(
    c.stats.avgLoopCount,
    imp,
    ...medians(medianTable, 'avgLoopCount', cat),
    w.evidenceThreshold,
    w.normReferenceMultiplier
  );

  const rate = (n: number, r: NormalisableRate) =>
    gatedNormalisedRate(
      n,
      imp,
      ...medians(medianTable, r, cat),
      w.bayesAlpha,
      w.evidenceThreshold,
      w.normReferenceMultiplier
    );

  return (
    0.4 * completion +
    0.25 * loop +
    0.2 * rate(c.stats.shares24h, 'shareRate') +
    0.15 * rate(c.stats.saves24h, 'saveRate')
  );
}

// ---------------------------------------------------------------------------
// Affinity
// ---------------------------------------------------------------------------

/**
 * 1.0 inside the viewer's p25-p75 band, decaying linearly to 0 at 3x p75 and
 * 0.3x p25. Someone who buys $18 items should not get a wall of $400 items.
 * A viewer with no band yet gets 0.5 — neutral, not a zero that would bury
 * every candidate before the profile exists.
 *
 * Not gated: this is arithmetic on a price and a band, not a sampled rate.
 */
export function priceBandFit(priceCents: number, band: PriceBand | null): number {
  if (!band) return 0.5;
  const { p25, p75 } = band;
  if (priceCents >= p25 && priceCents <= p75) return 1;

  if (priceCents > p75) {
    const zero = 3 * p75;
    if (priceCents >= zero) return 0;
    return 1 - (priceCents - p75) / (zero - p75);
  }

  const zero = 0.3 * p25;
  if (priceCents <= zero) return 0;
  return (priceCents - zero) / (p25 - zero);
}

/**
 * Viewer-side, so nothing here is gated on the candidate's impressions — the
 * sample size behind a category affinity is the viewer's event history, not
 * this video's reach.
 */
export function affinitySignal(c: Candidate, v: ViewerProfile, w: Weights): number {
  void w;
  const category = c.categoryId ? (v.categoryAffinity[c.categoryId] ?? 0) : 0;
  const seller = v.sellerAffinity[c.sellerId] ?? 0;
  const hashtag =
    c.hashtags.length === 0
      ? 0
      : Math.min(
          1,
          c.hashtags.reduce((sum, h) => sum + (v.hashtagAffinity[h] ?? 0), 0)
        );
  return (
    0.4 * Math.min(1, category) +
    0.25 * priceBandFit(c.minPriceCents, v.priceBand) +
    0.2 * Math.min(1, seller) +
    0.15 * hashtag
  );
}

// ---------------------------------------------------------------------------
// Freshness, trust
// ---------------------------------------------------------------------------

/** Exponential decay, half-life 72 hours. Exact, therefore never gated. */
export function freshnessSignal(
  publishedAt: Date,
  now: Date,
  w: Weights,
  thinCategoryMultiplier = 1
): number {
  const hours = (now.getTime() - publishedAt.getTime()) / 3_600_000;
  if (!Number.isFinite(hours)) return 0;
  const base = Math.exp((-Math.LN2 * Math.max(0, hours)) / w.freshnessHalfLifeHours);
  return Math.min(1, base * thinCategoryMultiplier);
}

/**
 * Seller-level, so no input is gated on the video's impressions.
 *
 * ratingAvg normalises against RATING_SCALE_MAX rather than a category median:
 * it is the one bounded scale in the system, 0-5 by construction, and dividing
 * it by 2.5x a median would invent a ceiling it already has. A seller with no
 * ratings contributes 0 to this term and is held up by the tier floor instead.
 *
 * `w` is unused and kept for call-site stability — the rating ceiling moved
 * from the weight vector to a constant in v2.
 */
export function trustSignal(t: CandidateTrust, w: Weights): number {
  void w;
  return (
    0.4 * clamp01(t.fulfillmentScore) +
    0.25 * (1 - clamp01(t.disputeRate)) +
    0.2 * (t.ratingAvg === null ? 0 : norm(t.ratingAvg, RATING_SCALE_MAX)) +
    0.15 * TIER_BONUS[t.tier]
  );
}

// ---------------------------------------------------------------------------
// Diversity, fatigue
// ---------------------------------------------------------------------------

/** Small positive score for differing from the last 5 served. Positional, exact. */
export function diversityBonus(c: Candidate, ctx: RecentContext): number {
  const recentSellers = ctx.sellerIds.slice(0, 5);
  const recentCategories = ctx.categoryIds.slice(0, 5);
  const recentBands = ctx.priceCents.slice(0, 5).map(priceBandOf);
  let score = 0;
  if (!recentSellers.includes(c.sellerId)) score += 0.4;
  if (!recentCategories.includes(c.categoryId)) score += 0.35;
  if (!recentBands.includes(priceBandOf(c.minPriceCents))) score += 0.25;
  return score;
}

/** Recency positions in the last-served list. Positional, exact, never gated. */
export function fatiguePenalty(c: Candidate, ctx: RecentContext): number {
  const sellerIdx = ctx.sellerIds.indexOf(c.sellerId);
  const seller = sellerIdx === -1 ? 0 : sellerIdx < 3 ? 1 : sellerIdx < 8 ? 0.5 : 0;

  const catIdx = ctx.categoryIds.indexOf(c.categoryId);
  const category = catIdx === -1 ? 0 : catIdx < 2 ? 1 : catIdx < 5 ? 0.5 : 0;

  return 0.6 * seller + 0.4 * category;
}

// ---------------------------------------------------------------------------
// Quality penalty
// ---------------------------------------------------------------------------

/**
 * The strongest negative signal in the system (weighted -0.25).
 *
 * All three inputs are rates measured over impressions, so all three are
 * smoothed, normalised against 2.5x their category median, and gated. Note the
 * denominators differ: fast skips are a 24h counter, reports and
 * not-interested are lifetime, and each gates on the impression count it was
 * actually measured against.
 */
export function qualityPenalty(c: Candidate, w: Weights, medianTable: CategoryMedians): number {
  const cat = c.categoryId;
  const rate = (n: number, imp: number, r: NormalisableRate) =>
    gatedNormalisedRate(
      n,
      imp,
      ...medians(medianTable, r, cat),
      w.bayesAlpha,
      w.evidenceThreshold,
      w.normReferenceMultiplier
    );

  return (
    0.5 * rate(c.stats.skipsUnder2s24h, c.stats.impressions24h, 'skipUnder2sRate') +
    0.3 * rate(c.stats.reportsAll, c.stats.impressionsAll, 'reportRate') +
    0.2 * rate(c.stats.notInterestedAll, c.stats.impressionsAll, 'notInterestedRate')
  );
}

// ---------------------------------------------------------------------------
// Dead video detection
// ---------------------------------------------------------------------------

/** Above this fast-skip rate, with enough impressions to believe it, a video is dead. */
export const DEAD_VIDEO_SKIP_RATE = 0.6;

/**
 * Impressions required before the verdict is allowed at all. This is the
 * dead-video check's own evidence gate, which is why the rate it judges is the
 * RAW observed one and not the gated signal from `qualityPenalty`: gating twice
 * would make the stated 0.6 unreachable and quietly disable the whole rule.
 */
export const DEAD_VIDEO_MIN_IMPRESSIONS = 200;

export type DeadVideoReason =
  /** Over the skip threshold with enough impressions to be sure. */
  | 'fast-skip-death'
  /** Might be over the threshold, but not enough impressions to say so. */
  | 'insufficient-impressions'
  /** Enough impressions, and the skip rate is within tolerance. */
  | 'skip-rate-acceptable';

export type DeadVideoVerdict = {
  dead: boolean;
  reason: DeadVideoReason;
  /** Plain-language WHY, written to be shown to the seller verbatim. */
  explanation: string;
  skipUnder2sRate: number;
  impressions: number;
  skipRateThreshold: number;
  impressionsThreshold: number;
};

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

/**
 * A video with a fast-skip rate over 0.6 across 200+ impressions is dead: it is
 * not being watched, and no amount of further distribution will change that.
 *
 * Returns the reason, not just a boolean, because the spec is explicit that
 * silent burial is how you lose founding sellers. The caller drops the video
 * from circulation AND emails the seller, and it cannot write that email from a
 * bare `true`. The negative reasons are as load-bearing as the positive one: a
 * seller whose video is merely unproven must be told that, not left to infer a
 * punishment that was never applied.
 *
 * The comparison is strict (> 0.6) and the impression floor inclusive (>= 200),
 * so a video sitting exactly on the skip threshold survives. Judgement calls at
 * the boundary go in the seller's favour.
 */
export function isDeadVideo(c: Candidate): DeadVideoVerdict {
  const impressions = Math.max(0, c.stats.impressions24h);
  const skipUnder2sRate = safeRate(c.stats.skipsUnder2s24h, impressions);

  const base = {
    skipUnder2sRate,
    impressions,
    skipRateThreshold: DEAD_VIDEO_SKIP_RATE,
    impressionsThreshold: DEAD_VIDEO_MIN_IMPRESSIONS,
  };

  if (impressions < DEAD_VIDEO_MIN_IMPRESSIONS) {
    return {
      ...base,
      dead: false,
      reason: 'insufficient-impressions',
      explanation:
        `Not enough evidence to judge this video: ${impressions} impressions in the last 24 hours, ` +
        `below the ${DEAD_VIDEO_MIN_IMPRESSIONS} required. Its fast-skip rate is currently ` +
        `${pct(skipUnder2sRate)}, but over this few impressions that number means very little.`,
    };
  }

  if (skipUnder2sRate > DEAD_VIDEO_SKIP_RATE) {
    return {
      ...base,
      dead: true,
      reason: 'fast-skip-death',
      explanation:
        `${pct(skipUnder2sRate)} of viewers skipped this video in under 2 seconds, across ` +
        `${impressions} impressions in the last 24 hours. That is above the ` +
        `${pct(DEAD_VIDEO_SKIP_RATE)} limit, and there are enough impressions behind it to be ` +
        `confident. The opening seconds are not holding attention — a different hook, not more ` +
        `distribution, is what changes this.`,
    };
  }

  return {
    ...base,
    dead: false,
    reason: 'skip-rate-acceptable',
    explanation:
      `Fast-skip rate is ${pct(skipUnder2sRate)} across ${impressions} impressions in the last ` +
      `24 hours, at or below the ${pct(DEAD_VIDEO_SKIP_RATE)} limit. This video stays in circulation.`,
  };
}
