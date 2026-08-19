// Step 10 of the build order, v2 — WITHIN-SESSION ADAPTATION (spec 2.6).
//
// "Don't wait for the next slice." The persisted ViewerProfile moves over days;
// this moves over seconds. A viewer who has flicked past the last three videos
// in under two seconds each has told us something the nightly affinity cron
// will not know until tomorrow, and the feed has to act on it now.
//
// Everything here is a pure reducer. No clock is read (`now: Date` is always a
// parameter), no randomness is drawn, and no input is mutated: every update
// returns a fresh state, so a whole session can be replayed event by event and
// asserted step by step. That is the same determinism contract the rest of
// src/lib/scoring/ is built on, and it is what makes the offline simulation
// reproducible.

import { EVENT_WEIGHTS, type AffinityEventType } from './affinity';
import {
  LANES,
  priceBandOf,
  type CandidateLane,
  type SessionState,
  type Weights,
} from './types';

// ---------------------------------------------------------------------------
// Constants — spec 2.6, one named constant per rule so the rules are greppable
// ---------------------------------------------------------------------------

/** "3 consecutive sub-2s skips -> mode=diversify". Consecutive, not cumulative. */
export const DIVERSIFY_SKIP_THRESHOLD = 3;

/** Diversify mode: "diversity x3". */
export const DIVERSIFY_DIVERSITY_MULTIPLIER = 3;

/** Diversify mode: "freshness x1.5" (before it also absorbs redistributed weight). */
export const DIVERSIFY_FRESHNESS_MULTIPLIER = 1.5;

/** "Product tap -> boost that category and price band x1.5 for the rest of the session." */
export const SESSION_BOOST_MULTIPLIER = 1.5;

/** "Purchase -> suppress that seller for 10 videos. They just bought; don't nag." */
export const SELLER_SUPPRESSION_VIDEOS = 10;

/** "2 minutes with no interaction -> inject a high-velocity trending video." */
export const IDLE_INJECTION_MS = 120_000;

/** Which lane an idle-injection is satisfied by. */
export const INJECTION_LANE: CandidateLane = 'trending';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Matches `FeedResponse.mode` in src/lib/feed/types.ts, so it can be echoed straight out. */
export type SessionMode = 'default' | 'diversify';

/** The three buckets `priceBandOf` sorts a price into. */
export type PriceBandLabel = ReturnType<typeof priceBandOf>;

/**
 * The shared `SessionState` (types.ts) plus everything spec 2.6 needs to
 * adapt mid-session. It is a superset, so anything typed against `SessionState`
 * accepts this unchanged.
 *
 * `mode` is deliberately NOT stored — see `sessionMode`. Storing a value that
 * is fully derivable from `consecutiveFastSkips` only creates a second source
 * of truth that can drift from the first.
 */
export type AdaptiveSessionState = SessionState & {
  /**
   * Sub-2s skips with no interaction in between. Reset by interactions ONLY —
   * an impression is the feed acting, not the viewer, so serving the next video
   * must not wipe the run. If it did, the natural
   * impression -> skip -> impression -> skip cadence would never reach 3 and
   * diversify mode would be dead code.
   */
  consecutiveFastSkips: number;
  /** Last product_tap / purchase / any_interaction. Seeded with `startedAt`. */
  lastInteractionAt: Date;
  /**
   * Last impression served from the `trending` lane, or null. Without this the
   * idle rule would fire on every subsequent video forever: the injected video
   * is an impression, and impressions do not reset the idle clock.
   */
  lastTrendingInjectionAt: Date | null;
  /** categoryId -> multiplier. Set once at SESSION_BOOST_MULTIPLIER; never compounds. */
  boostedCategories: ReadonlyMap<string, number>;
  /** price band -> multiplier, same rule. */
  boostedPriceBands: ReadonlyMap<PriceBandLabel, number>;
  /** sellerId -> videos still owed on the countdown. Absent = not suppressed. */
  suppressedSellers: ReadonlyMap<string, number>;
};

function emptyLaneCounts(): Record<CandidateLane, number> {
  const out = {} as Record<CandidateLane, number>;
  for (const lane of LANES) out[lane] = 0;
  return out;
}

/**
 * A session that has seen nothing yet.
 *
 * `startedAt` is a required parameter rather than a `new Date()` default: this
 * module may not read a clock, and seeding the idle timer from a hidden `now`
 * would make `needsTrendingInjection` untestable.
 */
export function initialSessionState(sessionId: string, startedAt: Date): AdaptiveSessionState {
  return {
    sessionId,
    startedAt,
    impressions: 0,
    skipsUnder2s: 0,
    completions: 0,
    productTaps: 0,
    addToCarts: 0,
    purchases: 0,
    categoryCounts: {},
    sellerCounts: {},
    laneCounts: emptyLaneCounts(),
    categoryAffinityDelta: {},
    sellerAffinityDelta: {},
    servedVideoIds: new Set<string>(),
    consecutiveFastSkips: 0,
    // Idle is measured from session start, so a viewer who opens the app and
    // never touches it still qualifies for an injection after two minutes.
    lastInteractionAt: startedAt,
    lastTrendingInjectionAt: null,
    boostedCategories: new Map(),
    boostedPriceBands: new Map(),
    suppressedSellers: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * What `any_interaction` may carry. `purchase`, `product_tap` and `fast_skip`
 * are excluded because they have dedicated events with their own side effects
 * (suppression, boosts, the skip run) — routing one through `any_interaction`
 * would silently skip those. `not_interested` is excluded because it is a
 * negative signal whose suppression mechanism is affinity.ts's 30-day seller
 * block, and treating it as an interaction here would reset the very skip run
 * that diversify mode exists to catch.
 */
export type PositiveInteractionKind = Exclude<
  AffinityEventType,
  'purchase' | 'product_tap' | 'fast_skip' | 'not_interested'
>;

export type SessionEvent =
  /** A video was served. The only event that advances the suppression countdown. */
  | {
      type: 'impression';
      videoId: string;
      sellerId: string;
      categoryId: string | null;
      lane: CandidateLane;
    }
  /** A skip under 2 seconds. */
  | { type: 'fast_skip'; videoId?: string; sellerId?: string | null; categoryId?: string | null }
  /** A product tap: the boost event. */
  | { type: 'product_tap'; categoryId: string | null; priceCents: number; sellerId?: string | null }
  /** A completed purchase: the suppression event. */
  | { type: 'purchase'; sellerId: string; categoryId?: string | null; priceCents?: number }
  /** Any other positive interaction — watch-through, save, share, like, follow, cart. */
  | {
      type: 'any_interaction';
      kind?: PositiveInteractionKind;
      sellerId?: string | null;
      categoryId?: string | null;
    }
  /** Time passed and nothing happened. */
  | { type: 'tick' };

/**
 * Events that mean "the viewer engaged". These and only these reset the
 * consecutive-fast-skip run and the idle clock.
 *
 * `impression` is excluded (the feed acted, not the viewer) and so is `tick`.
 * `fast_skip` is excluded from BOTH: it is the viewer touching the device, not
 * the viewer engaging with the feed. A viewer flicking past twelve videos in
 * two minutes has had nothing land, which is exactly who the trending
 * injection is for — diversify mode and the injection are complementary
 * responses to the same silence, not alternatives.
 */
export function isInteraction(event: SessionEvent): boolean {
  return (
    event.type === 'product_tap' || event.type === 'purchase' || event.type === 'any_interaction'
  );
}

// ---------------------------------------------------------------------------
// Immutable helpers
// ---------------------------------------------------------------------------

/** null categoryId shares the '' bucket, matching `medianFor` in types.ts. */
function countKey(categoryId: string | null | undefined): string {
  return categoryId ?? '';
}

function bump(rec: Readonly<Record<string, number>>, key: string): Record<string, number> {
  return { ...rec, [key]: (rec[key] ?? 0) + 1 };
}

/**
 * Add event-scale affinity points, floored at 0 — the same units and the same
 * floor as `applyEvents` in affinity.ts, so these deltas can be handed straight
 * to it. They are RAW points (a purchase is +10), not normalised weights; do
 * not add them to a normalised ViewerProfile map without renormalising.
 */
function addPoints(
  rec: Readonly<Record<string, number>>,
  key: string | null | undefined,
  points: number
): Record<string, number> {
  if (!key || !Number.isFinite(points) || points === 0) return rec;
  return { ...rec, [key]: Math.max(0, (rec[key] ?? 0) + points) };
}

/** One video passed: every countdown loses one, and a countdown at 0 is gone. */
function decrementSuppression(m: ReadonlyMap<string, number>): ReadonlyMap<string, number> {
  if (m.size === 0) return m;
  const out = new Map<string, number>();
  for (const [sellerId, remaining] of m) {
    const next = remaining - 1;
    if (next > 0) out.set(sellerId, next);
  }
  return out;
}

/** Set-once, never compounding: two taps on the same category are still x1.5. */
function withBoost<K>(m: ReadonlyMap<K, number>, key: K): ReadonlyMap<K, number> {
  if (m.get(key) === SESSION_BOOST_MULTIPLIER) return m;
  return new Map(m).set(key, SESSION_BOOST_MULTIPLIER);
}

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

/**
 * Fold one event into the session. Pure: `state` is never mutated, and `now` is
 * the only clock.
 */
export function applySessionEvent(
  state: AdaptiveSessionState,
  event: SessionEvent,
  now: Date
): AdaptiveSessionState {
  switch (event.type) {
    case 'impression': {
      const served = new Set(state.servedVideoIds);
      served.add(event.videoId);
      return {
        ...state,
        impressions: state.impressions + 1,
        categoryCounts: bump(state.categoryCounts, countKey(event.categoryId)),
        sellerCounts: bump(state.sellerCounts, event.sellerId),
        laneCounts: { ...state.laneCounts, [event.lane]: (state.laneCounts[event.lane] ?? 0) + 1 },
        servedVideoIds: served,
        // A video went by, so every "suppress for 10 videos" countdown ticks.
        suppressedSellers: decrementSuppression(state.suppressedSellers),
        // Any trending video — injected on purpose or drawn by the lane shares —
        // satisfies the idle rule. There is no point injecting a second one.
        lastTrendingInjectionAt:
          event.lane === INJECTION_LANE ? now : state.lastTrendingInjectionAt,
      };
    }

    case 'fast_skip': {
      return {
        ...state,
        skipsUnder2s: state.skipsUnder2s + 1,
        consecutiveFastSkips: state.consecutiveFastSkips + 1,
        categoryAffinityDelta: addPoints(
          state.categoryAffinityDelta,
          event.categoryId,
          EVENT_WEIGHTS.fast_skip
        ),
        sellerAffinityDelta: addPoints(
          state.sellerAffinityDelta,
          event.sellerId,
          EVENT_WEIGHTS.fast_skip
        ),
      };
    }

    case 'product_tap': {
      // Spec 2.6: boost that category AND that price band, x1.5, for the rest
      // of the session. Not decayed, not expired — "for the rest of the
      // session" is the whole rule.
      const boostedCategories =
        event.categoryId === null
          ? state.boostedCategories
          : // A null category is the uncategorised grab-bag, not a taste. Boosting
            // it would boost every uncategorised video in the catalogue.
            withBoost(state.boostedCategories, event.categoryId);
      return {
        ...state,
        productTaps: state.productTaps + 1,
        consecutiveFastSkips: 0,
        lastInteractionAt: now,
        boostedCategories,
        boostedPriceBands: Number.isFinite(event.priceCents)
          ? withBoost(state.boostedPriceBands, priceBandOf(event.priceCents))
          : state.boostedPriceBands,
        categoryAffinityDelta: addPoints(
          state.categoryAffinityDelta,
          event.categoryId,
          EVENT_WEIGHTS.product_tap
        ),
        sellerAffinityDelta: addPoints(
          state.sellerAffinityDelta,
          event.sellerId,
          EVENT_WEIGHTS.product_tap
        ),
      };
    }

    case 'purchase': {
      // A repeat purchase from the same seller restarts the full 10.
      const suppressed = new Map(state.suppressedSellers);
      suppressed.set(event.sellerId, SELLER_SUPPRESSION_VIDEOS);
      return {
        ...state,
        purchases: state.purchases + 1,
        consecutiveFastSkips: 0,
        lastInteractionAt: now,
        suppressedSellers: suppressed,
        categoryAffinityDelta: addPoints(
          state.categoryAffinityDelta,
          event.categoryId,
          EVENT_WEIGHTS.purchase
        ),
        sellerAffinityDelta: addPoints(
          state.sellerAffinityDelta,
          event.sellerId,
          EVENT_WEIGHTS.purchase
        ),
      };
    }

    case 'any_interaction': {
      const points = event.kind === undefined ? 0 : EVENT_WEIGHTS[event.kind];
      return {
        ...state,
        completions: state.completions + (event.kind === 'watch95' ? 1 : 0),
        addToCarts: state.addToCarts + (event.kind === 'add_to_cart' ? 1 : 0),
        consecutiveFastSkips: 0,
        lastInteractionAt: now,
        categoryAffinityDelta: addPoints(state.categoryAffinityDelta, event.categoryId, points),
        sellerAffinityDelta: addPoints(state.sellerAffinityDelta, event.sellerId, points),
      };
    }

    case 'tick':
      // Intentionally identity. The clock is a parameter everywhere in this
      // module, so "time passed" changes nothing that is stored; `tick` exists
      // so a caller replaying a timeline can advance it without inventing a
      // fake interaction. It must NOT clear the skip run — a viewer who stops
      // skipping because they gave up is still telling us the model is wrong.
      return state;
  }
}

/** Fold a whole timeline. Each event carries its own `now`. */
export function applySessionEvents(
  state: AdaptiveSessionState,
  events: readonly { event: SessionEvent; now: Date }[]
): AdaptiveSessionState {
  return events.reduce((s, e) => applySessionEvent(s, e.event, e.now), state);
}

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

/**
 * Derived, never stored. Diversify is on exactly while the consecutive-skip run
 * stands at 3 or more, which means the same interaction that resets the run
 * also ends the mode — if the viewer engages with the diversified feed, the
 * diversification worked and there is nothing left to correct.
 */
export function sessionMode(state: AdaptiveSessionState): SessionMode {
  return state.consecutiveFastSkips >= DIVERSIFY_SKIP_THRESHOLD ? 'diversify' : 'default';
}

// ---------------------------------------------------------------------------
// Weights
// ---------------------------------------------------------------------------

const POSITIVE_WEIGHT_KEYS = [
  'wCommerce',
  'wEngagement',
  'wAffinity',
  'wFreshness',
  'wTrust',
  'wDiversity',
] as const;

/**
 * Sum of the six positive weights. The two penalties (pFatigue, pQuality) are
 * subtracted from the score, not added to it, so they are not part of the
 * budget being conserved and are never rescaled.
 */
export function positiveWeightTotal(w: Weights): number {
  let total = 0;
  for (const key of POSITIVE_WEIGHT_KEYS) {
    const v = w[key];
    if (Number.isFinite(v)) total += v;
  }
  return total;
}

/**
 * THE REDISTRIBUTION (spec 2.5, applied to spec 2.6's diversify mode too).
 *
 * Zeroing affinity without redistributing it drops every score by the affinity
 * weight at once — 20% on the default weights. Scores are compared against each
 * other, so a uniform 20% haircut is not neutral: it shrinks the gaps that
 * every downstream threshold, softmax temperature and tie-break was tuned
 * against, and reshuffles the slice for no reason the viewer caused.
 *
 * So the positive weights are conserved. Given a base vector and an emphasised
 * one (affinity zeroed, and in diversify mode diversity x3 and freshness x1.5):
 *
 *     target  = sum(positive weights of base)
 *     current = sum(positive weights of emphasised)
 *     deficit = target - current
 *     absorb  = emphasised.wCommerce + emphasised.wFreshness
 *
 *     wCommerce'  = emphasised.wCommerce  + deficit * (emphasised.wCommerce  / absorb)
 *     wFreshness' = emphasised.wFreshness + deficit * (emphasised.wFreshness / absorb)
 *
 * Commerce and freshness absorb it, in proportion to what they already hold,
 * because those are the two signals spec 2.5 names: with no usable model of
 * this viewer, what a video sells and how new it is are the only things left
 * worth believing. Engagement and trust are untouched, affinity stays exactly
 * 0, and diversity keeps exactly its x3.
 *
 * On DEFAULT_WEIGHTS in diversify mode: deficit = 1.0 - (0.35 + 0.2 + 0.15 +
 * 0.1 + 0.15) = 0.05, split 0.35:0.15 between commerce and freshness, giving
 * commerce 0.385 and freshness 0.165 — and 0.385 + 0.2 + 0 + 0.165 + 0.1 +
 * 0.15 = 1.0, the original total.
 *
 * Degenerate cases: if commerce and freshness cannot absorb the deficit without
 * going negative (a base with an enormous diversity weight, say), the whole
 * positive vector is uniformly rescaled to the target instead. That still
 * conserves the total and still leaves affinity at 0, because 0 times anything
 * is 0.
 */
function conservePositiveTotal(base: Weights, emphasised: Weights): Weights {
  const target = positiveWeightTotal(base);
  const current = positiveWeightTotal(emphasised);
  const deficit = target - current;
  if (!Number.isFinite(deficit) || deficit === 0) return emphasised;

  const absorb = emphasised.wCommerce + emphasised.wFreshness;
  if (Number.isFinite(absorb) && absorb > 0) {
    const wCommerce = emphasised.wCommerce + deficit * (emphasised.wCommerce / absorb);
    const wFreshness = emphasised.wFreshness + deficit * (emphasised.wFreshness / absorb);
    if (wCommerce >= 0 && wFreshness >= 0) return { ...emphasised, wCommerce, wFreshness };
  }

  if (current > 0) {
    const factor = target / current;
    const scaled = { ...emphasised };
    for (const key of POSITIVE_WEIGHT_KEYS) scaled[key] = emphasised[key] * factor;
    return scaled;
  }
  return emphasised;
}

/**
 * The weights this slice should actually be scored with.
 *
 * Diversify mode (3 consecutive sub-2s skips): "the viewer is telling you your
 * model of them is wrong", so affinity goes to zero, diversity x3, freshness
 * x1.5 — and the freed affinity weight is redistributed rather than dropped
 * (see `conservePositiveTotal`).
 *
 * Cold start (spec 2.5) applies the identical redistribution with no emphasis
 * multipliers: there is no affinity to use yet, for a different reason and with
 * the same fix. Pass `coldStart` from `!viewer.coldStartComplete`. The two
 * compose: in diversify mode a cold-start viewer gets the diversify treatment,
 * because affinity is already 0 either way.
 *
 * Returns `base` unchanged when neither applies — identity is the common path.
 */
export function sessionWeights(
  baseWeights: Weights,
  state: AdaptiveSessionState,
  coldStart = false
): Weights {
  const diversify = sessionMode(state) === 'diversify';
  if (!diversify && !coldStart) return baseWeights;

  const emphasised: Weights = {
    ...baseWeights,
    wAffinity: 0,
    wDiversity: diversify
      ? baseWeights.wDiversity * DIVERSIFY_DIVERSITY_MULTIPLIER
      : baseWeights.wDiversity,
    wFreshness: diversify
      ? baseWeights.wFreshness * DIVERSIFY_FRESHNESS_MULTIPLIER
      : baseWeights.wFreshness,
  };
  return conservePositiveTotal(baseWeights, emphasised);
}

// ---------------------------------------------------------------------------
// Boosts and suppression
// ---------------------------------------------------------------------------

export type SessionBoosts = {
  /** categoryId -> multiplier (SESSION_BOOST_MULTIPLIER). */
  boostedCategories: ReadonlyMap<string, number>;
  /** price band -> multiplier (SESSION_BOOST_MULTIPLIER). */
  boostedPriceBands: ReadonlyMap<PriceBandLabel, number>;
  /** sellerId -> videos remaining on the countdown; absent means not suppressed. */
  suppressedSellers: ReadonlyMap<string, number>;
};

/** The session's live steering inputs, as one object for the selector. */
export function sessionBoosts(state: AdaptiveSessionState): SessionBoosts {
  return {
    boostedCategories: state.boostedCategories,
    boostedPriceBands: state.boostedPriceBands,
    suppressedSellers: state.suppressedSellers,
  };
}

/** x1.5 if this category was tapped this session, else 1 (a no-op multiplier). */
export function categoryBoost(boosts: SessionBoosts, categoryId: string | null): number {
  if (categoryId === null) return 1;
  return boosts.boostedCategories.get(categoryId) ?? 1;
}

/** x1.5 if this price's band was tapped this session, else 1. */
export function priceBandBoost(boosts: SessionBoosts, priceCents: number): number {
  if (!Number.isFinite(priceCents)) return 1;
  return boosts.boostedPriceBands.get(priceBandOf(priceCents)) ?? 1;
}

/**
 * Both boosts together. Multiplicative, so a video matching the tapped category
 * AND the tapped price band gets 2.25 — the two are independent pieces of
 * evidence and a video satisfying both is a strictly better match than one
 * satisfying either.
 */
export function candidateBoost(
  boosts: SessionBoosts,
  candidate: { categoryId: string | null; minPriceCents: number }
): number {
  return categoryBoost(boosts, candidate.categoryId) * priceBandBoost(boosts, candidate.minPriceCents);
}

/** Videos still owed on this seller's post-purchase countdown; 0 when clear. */
export function sellerSuppressionRemaining(boosts: SessionBoosts, sellerId: string): number {
  return boosts.suppressedSellers.get(sellerId) ?? 0;
}

/**
 * A hard filter, not a multiplier: the viewer just bought from them, so they
 * are out of the slice entirely until the countdown clears.
 */
export function isSellerSuppressed(boosts: SessionBoosts, sellerId: string): boolean {
  return sellerSuppressionRemaining(boosts, sellerId) > 0;
}

// ---------------------------------------------------------------------------
// Idle injection
// ---------------------------------------------------------------------------

/**
 * The instant the idle clock restarts from: the later of the last real
 * interaction and the last trending video served.
 */
function idleSince(state: AdaptiveSessionState): number {
  const interaction = state.lastInteractionAt.getTime();
  const injection = state.lastTrendingInjectionAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  return Math.max(interaction, injection);
}

/**
 * Spec 2.6: "2 minutes with no interaction -> inject a high-velocity trending
 * video regardless of affinity."
 *
 * Inclusive at the boundary: exactly 120000ms of silence qualifies.
 *
 * Serving any trending-lane video restarts the clock, so this returns true once
 * per idle stretch rather than pinning the rest of the session to trending.
 */
export function needsTrendingInjection(
  state: AdaptiveSessionState,
  now: Date,
  idleMs: number = IDLE_INJECTION_MS
): boolean {
  const since = idleSince(state);
  const t = now.getTime();
  if (!Number.isFinite(since) || !Number.isFinite(t)) return false;
  return t - since >= idleMs;
}

/** Milliseconds of silence so far. Useful for logging why an injection fired. */
export function idleMsSince(state: AdaptiveSessionState, now: Date): number {
  const since = idleSince(state);
  const t = now.getTime();
  if (!Number.isFinite(since) || !Number.isFinite(t)) return 0;
  return Math.max(0, t - since);
}
