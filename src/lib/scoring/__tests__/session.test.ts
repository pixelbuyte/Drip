import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  DIVERSIFY_DIVERSITY_MULTIPLIER,
  DIVERSIFY_FRESHNESS_MULTIPLIER,
  DIVERSIFY_SKIP_THRESHOLD,
  IDLE_INJECTION_MS,
  SELLER_SUPPRESSION_VIDEOS,
  SESSION_BOOST_MULTIPLIER,
  applySessionEvent,
  applySessionEvents,
  candidateBoost,
  categoryBoost,
  idleMsSince,
  initialSessionState,
  isSellerSuppressed,
  needsTrendingInjection,
  positiveWeightTotal,
  priceBandBoost,
  sellerSuppressionRemaining,
  sessionBoosts,
  sessionMode,
  sessionWeights,
  type AdaptiveSessionState,
  type SessionEvent,
} from '../session';
import { DEFAULT_WEIGHTS, LANES, type Weights } from '../types';

const T0 = new Date('2026-01-01T00:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

function fresh(): AdaptiveSessionState {
  return initialSessionState('sess-1', T0);
}

const SKIP: SessionEvent = { type: 'fast_skip', sellerId: 's1', categoryId: 'apparel' };
const TICK: SessionEvent = { type: 'tick' };

function impression(n: number, over: Partial<Extract<SessionEvent, { type: 'impression' }>> = {}) {
  return {
    type: 'impression' as const,
    videoId: `v${n}`,
    sellerId: 's1',
    categoryId: 'apparel',
    lane: 'affinity' as const,
    ...over,
  };
}

/** Fold a list of events at a fixed instant. */
function fold(state: AdaptiveSessionState, events: SessionEvent[], now: Date = T0) {
  return events.reduce((s, e) => applySessionEvent(s, e, now), state);
}

// ---------------------------------------------------------------------------

describe('initialSessionState', () => {
  it('starts empty, with the idle clock seeded from startedAt', () => {
    const s = fresh();
    expect(s.sessionId).toBe('sess-1');
    expect(s.startedAt).toBe(T0);
    expect(s.impressions).toBe(0);
    expect(s.skipsUnder2s).toBe(0);
    expect(s.consecutiveFastSkips).toBe(0);
    expect(s.lastInteractionAt).toBe(T0);
    expect(s.lastTrendingInjectionAt).toBeNull();
    expect(s.servedVideoIds.size).toBe(0);
    expect(s.boostedCategories.size).toBe(0);
    expect(s.suppressedSellers.size).toBe(0);
    expect(sessionMode(s)).toBe('default');
  });

  it('seeds a counter for every lane, including the renamed tail lane', () => {
    const s = fresh();
    expect(Object.keys(s.laneCounts).sort()).toEqual([...LANES].sort());
    expect(s.laneCounts.tail).toBe(0);
  });
});

describe('purity', () => {
  it('never mutates the state it is handed', () => {
    const s = fresh();
    const before = JSON.stringify({
      ...s,
      servedVideoIds: [...s.servedVideoIds],
      boostedCategories: [...s.boostedCategories],
      suppressedSellers: [...s.suppressedSellers],
    });
    applySessionEvent(s, impression(1), T0);
    applySessionEvent(s, SKIP, T0);
    applySessionEvent(s, { type: 'purchase', sellerId: 's1' }, T0);
    const after = JSON.stringify({
      ...s,
      servedVideoIds: [...s.servedVideoIds],
      boostedCategories: [...s.boostedCategories],
      suppressedSellers: [...s.suppressedSellers],
    });
    expect(after).toBe(before);
  });

  it('reads no clock and draws no randomness (determinism contract)', () => {
    // Comments are stripped first: the prose below explains why the clock is a
    // parameter, and naming the forbidden call is not making it.
    const code = readFileSync(new URL('../session.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/Date\.now\s*\(/);
    expect(code).not.toMatch(/Math\.random\s*\(/);
    expect(code).not.toMatch(/new Date\s*\(/);
  });
});

// ---------------------------------------------------------------------------
// Diversify mode: the consecutive-skip run
// ---------------------------------------------------------------------------

describe('diversify mode', () => {
  it('does NOT trigger on two consecutive fast skips', () => {
    const s = fold(fresh(), [SKIP, SKIP]);
    expect(s.consecutiveFastSkips).toBe(2);
    expect(sessionMode(s)).toBe('default');
  });

  it('triggers on exactly three', () => {
    const s = fold(fresh(), [SKIP, SKIP, SKIP]);
    expect(s.consecutiveFastSkips).toBe(DIVERSIFY_SKIP_THRESHOLD);
    expect(sessionMode(s)).toBe('diversify');
  });

  it('stays on past three', () => {
    expect(sessionMode(fold(fresh(), [SKIP, SKIP, SKIP, SKIP, SKIP]))).toBe('diversify');
  });

  // The off-by-one that is invisible in production: if serving the next video
  // cleared the run, the real impression/skip cadence would never reach three.
  it('is not reset by the impressions in between the skips', () => {
    const s = fold(fresh(), [
      impression(1), SKIP,
      impression(2), SKIP,
      impression(3), SKIP,
    ]);
    expect(s.consecutiveFastSkips).toBe(3);
    expect(sessionMode(s)).toBe('diversify');
  });

  it('is not reset by a tick', () => {
    const s = fold(fresh(), [SKIP, TICK, SKIP, TICK, SKIP]);
    expect(sessionMode(s)).toBe('diversify');
  });

  it.each([
    ['any_interaction', { type: 'any_interaction', kind: 'save' } as SessionEvent],
    ['product_tap', { type: 'product_tap', categoryId: 'apparel', priceCents: 1000 } as SessionEvent],
    ['purchase', { type: 'purchase', sellerId: 's1' } as SessionEvent],
  ])('a %s RESETS the consecutive counter', (_label, interaction) => {
    const s = fold(fresh(), [SKIP, SKIP, interaction]);
    expect(s.consecutiveFastSkips).toBe(0);
    expect(sessionMode(s)).toBe('default');
  });

  // Six fast skips in a session, never three in a row: still not diversify.
  it('counts consecutive skips, not cumulative ones', () => {
    const tap: SessionEvent = { type: 'product_tap', categoryId: 'beauty', priceCents: 1000 };
    const s = fold(fresh(), [SKIP, SKIP, tap, SKIP, SKIP, tap, SKIP, SKIP]);
    expect(s.skipsUnder2s).toBe(6);
    expect(s.consecutiveFastSkips).toBe(2);
    expect(sessionMode(s)).toBe('default');
  });

  it('re-arms: reset, then three more skips triggers again', () => {
    let s = fold(fresh(), [SKIP, SKIP, { type: 'any_interaction' }]);
    expect(sessionMode(s)).toBe('default');
    s = fold(s, [SKIP, SKIP]);
    expect(sessionMode(s)).toBe('default');
    s = fold(s, [SKIP]);
    expect(sessionMode(s)).toBe('diversify');
  });
});

// ---------------------------------------------------------------------------
// Weights and the redistribution
// ---------------------------------------------------------------------------

const BASE_TOTAL = positiveWeightTotal(DEFAULT_WEIGHTS);

function diversifying(): AdaptiveSessionState {
  return fold(fresh(), [SKIP, SKIP, SKIP]);
}

describe('sessionWeights', () => {
  it('is the identity in default mode for a warm viewer', () => {
    const s = fresh();
    expect(sessionWeights(DEFAULT_WEIGHTS, s)).toBe(DEFAULT_WEIGHTS);
  });

  it('zeroes affinity EXACTLY in diversify mode', () => {
    const w = sessionWeights(DEFAULT_WEIGHTS, diversifying());
    expect(w.wAffinity).toBe(0);
  });

  // The invariant the whole redistribution exists for: without it every score
  // drops by the affinity weight at once and the slice reshuffles for no reason.
  it('preserves the positive-weight total after redistribution', () => {
    const w = sessionWeights(DEFAULT_WEIGHTS, diversifying());
    expect(positiveWeightTotal(w)).toBeCloseTo(BASE_TOTAL, 12);
  });

  it('multiplies diversity by exactly 3 and freshness by at least 1.5', () => {
    const w = sessionWeights(DEFAULT_WEIGHTS, diversifying());
    expect(w.wDiversity).toBeCloseTo(DEFAULT_WEIGHTS.wDiversity * DIVERSIFY_DIVERSITY_MULTIPLIER, 12);
    // Freshness is one of the two absorbers, so it lands above its 1.5x.
    expect(w.wFreshness).toBeGreaterThanOrEqual(
      DEFAULT_WEIGHTS.wFreshness * DIVERSIFY_FRESHNESS_MULTIPLIER
    );
  });

  it('routes the freed weight into commerce and freshness only', () => {
    const w = sessionWeights(DEFAULT_WEIGHTS, diversifying());
    expect(w.wEngagement).toBe(DEFAULT_WEIGHTS.wEngagement);
    expect(w.wTrust).toBe(DEFAULT_WEIGHTS.wTrust);
    expect(w.wCommerce).toBeGreaterThan(DEFAULT_WEIGHTS.wCommerce);
    expect(w.wFreshness).toBeGreaterThan(DEFAULT_WEIGHTS.wFreshness);
  });

  it('matches the documented arithmetic on DEFAULT_WEIGHTS', () => {
    // deficit = 1.0 - (0.35 + 0.2 + 0 + 0.15 + 0.1 + 0.15) = 0.05,
    // split 0.35 : 0.15 between commerce and freshness.
    const w = sessionWeights(DEFAULT_WEIGHTS, diversifying());
    expect(w.wCommerce).toBeCloseTo(0.385, 12);
    expect(w.wFreshness).toBeCloseTo(0.165, 12);
    expect(w.wDiversity).toBeCloseTo(0.15, 12);
  });

  it('leaves the penalties and the tuning constants alone', () => {
    const w = sessionWeights(DEFAULT_WEIGHTS, diversifying());
    expect(w.pFatigue).toBe(DEFAULT_WEIGHTS.pFatigue);
    expect(w.pQuality).toBe(DEFAULT_WEIGHTS.pQuality);
    expect(w.bayesAlpha).toBe(DEFAULT_WEIGHTS.bayesAlpha);
    expect(w.evidenceThreshold).toBe(DEFAULT_WEIGHTS.evidenceThreshold);
    expect(w.normReferenceMultiplier).toBe(DEFAULT_WEIGHTS.normReferenceMultiplier);
    expect(w.freshnessHalfLifeHours).toBe(DEFAULT_WEIGHTS.freshnessHalfLifeHours);
  });

  it('does not mutate the base weights', () => {
    const copy = { ...DEFAULT_WEIGHTS };
    sessionWeights(DEFAULT_WEIGHTS, diversifying());
    expect(DEFAULT_WEIGHTS).toEqual(copy);
  });

  describe('cold start (spec 2.5)', () => {
    it('zeroes affinity and redistributes, with no diversify multipliers', () => {
      const w = sessionWeights(DEFAULT_WEIGHTS, fresh(), true);
      expect(w.wAffinity).toBe(0);
      expect(w.wDiversity).toBe(DEFAULT_WEIGHTS.wDiversity);
      expect(positiveWeightTotal(w)).toBeCloseTo(BASE_TOTAL, 12);
      // 0.2 split 0.35 : 0.10 between commerce and freshness.
      expect(w.wCommerce).toBeCloseTo(0.35 + 0.2 * (0.35 / 0.45), 12);
      expect(w.wFreshness).toBeCloseTo(0.1 + 0.2 * (0.1 / 0.45), 12);
    });

    it('composes with diversify: diversify wins, total still preserved', () => {
      const cold = sessionWeights(DEFAULT_WEIGHTS, diversifying(), true);
      expect(cold).toEqual(sessionWeights(DEFAULT_WEIGHTS, diversifying(), false));
      expect(positiveWeightTotal(cold)).toBeCloseTo(BASE_TOTAL, 12);
    });
  });

  describe('degenerate bases', () => {
    // Diversity so large that x3 overshoots the budget by more than commerce
    // and freshness hold: the proportional step would drive them negative, so
    // the whole positive vector is rescaled instead.
    const LOPSIDED: Weights = {
      ...DEFAULT_WEIGHTS,
      wCommerce: 0.01,
      wEngagement: 0.1,
      wAffinity: 0.01,
      wFreshness: 0.01,
      wTrust: 0.1,
      wDiversity: 0.5,
    };

    it('falls back to a uniform rescale rather than emitting a negative weight', () => {
      const w = sessionWeights(LOPSIDED, diversifying());
      expect(w.wAffinity).toBe(0);
      expect(w.wCommerce).toBeGreaterThan(0);
      expect(w.wFreshness).toBeGreaterThan(0);
      expect(positiveWeightTotal(w)).toBeCloseTo(positiveWeightTotal(LOPSIDED), 12);
    });

    it('survives an all-zero positive vector', () => {
      const zeroed: Weights = {
        ...DEFAULT_WEIGHTS,
        wCommerce: 0, wEngagement: 0, wAffinity: 0, wFreshness: 0, wTrust: 0, wDiversity: 0,
      };
      const w = sessionWeights(zeroed, diversifying());
      expect(positiveWeightTotal(w)).toBe(0);
      expect(Number.isFinite(w.wCommerce)).toBe(true);
      expect(Number.isFinite(w.wFreshness)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Boosts
// ---------------------------------------------------------------------------

describe('sessionBoosts', () => {
  const TAP: SessionEvent = { type: 'product_tap', categoryId: 'beauty', priceCents: 5000 };

  it('boosts the tapped category and price band by x1.5', () => {
    const b = sessionBoosts(fold(fresh(), [TAP]));
    expect(categoryBoost(b, 'beauty')).toBe(SESSION_BOOST_MULTIPLIER);
    expect(priceBandBoost(b, 5000)).toBe(SESSION_BOOST_MULTIPLIER); // mid
  });

  it('leaves untapped categories and bands at a no-op multiplier of 1', () => {
    const b = sessionBoosts(fold(fresh(), [TAP]));
    expect(categoryBoost(b, 'apparel')).toBe(1);
    expect(categoryBoost(b, null)).toBe(1);
    expect(priceBandBoost(b, 1000)).toBe(1); // low
    expect(priceBandBoost(b, 20000)).toBe(1); // high
  });

  it('persists for the rest of the session, through impressions, skips and ticks', () => {
    let s = fold(fresh(), [TAP]);
    for (let i = 0; i < 50; i++) s = fold(s, [impression(i), SKIP, TICK]);
    const b = sessionBoosts(s);
    expect(categoryBoost(b, 'beauty')).toBe(SESSION_BOOST_MULTIPLIER);
    expect(priceBandBoost(b, 5000)).toBe(SESSION_BOOST_MULTIPLIER);
  });

  it('does not compound on a repeat tap', () => {
    const b = sessionBoosts(fold(fresh(), [TAP, TAP, TAP]));
    expect(categoryBoost(b, 'beauty')).toBe(SESSION_BOOST_MULTIPLIER);
    expect(priceBandBoost(b, 5000)).toBe(SESSION_BOOST_MULTIPLIER);
  });

  it('does not boost the uncategorised bucket', () => {
    const b = sessionBoosts(
      fold(fresh(), [{ type: 'product_tap', categoryId: null, priceCents: 5000 }])
    );
    expect(b.boostedCategories.size).toBe(0);
    expect(priceBandBoost(b, 5000)).toBe(SESSION_BOOST_MULTIPLIER);
  });

  it('compounds category x band for a candidate matching both', () => {
    const b = sessionBoosts(fold(fresh(), [TAP]));
    expect(candidateBoost(b, { categoryId: 'beauty', minPriceCents: 5000 })).toBeCloseTo(2.25, 12);
    expect(candidateBoost(b, { categoryId: 'beauty', minPriceCents: 100 })).toBe(1.5);
    expect(candidateBoost(b, { categoryId: 'apparel', minPriceCents: 100 })).toBe(1);
  });

  it('counts the tap and records event-scale affinity points', () => {
    const s = fold(fresh(), [{ type: 'product_tap', categoryId: 'beauty', priceCents: 5000, sellerId: 's9' }]);
    expect(s.productTaps).toBe(1);
    expect(s.categoryAffinityDelta.beauty).toBe(2);
    expect(s.sellerAffinityDelta.s9).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Seller suppression
// ---------------------------------------------------------------------------

describe('seller suppression after a purchase', () => {
  const BUY: SessionEvent = { type: 'purchase', sellerId: 'seller-a', categoryId: 'beauty' };

  it('suppresses the seller immediately, for 10 videos', () => {
    const b = sessionBoosts(fold(fresh(), [BUY]));
    expect(isSellerSuppressed(b, 'seller-a')).toBe(true);
    expect(sellerSuppressionRemaining(b, 'seller-a')).toBe(SELLER_SUPPRESSION_VIDEOS);
    expect(isSellerSuppressed(b, 'seller-b')).toBe(false);
  });

  // Exactly 10, not 9 and not 11.
  it('is still suppressed after 9 videos', () => {
    let s = fold(fresh(), [BUY]);
    for (let i = 0; i < 9; i++) s = fold(s, [impression(i)]);
    expect(isSellerSuppressed(sessionBoosts(s), 'seller-a')).toBe(true);
    expect(sellerSuppressionRemaining(sessionBoosts(s), 'seller-a')).toBe(1);
  });

  it('expires on the 10th video exactly', () => {
    let s = fold(fresh(), [BUY]);
    for (let i = 0; i < 10; i++) s = fold(s, [impression(i)]);
    expect(isSellerSuppressed(sessionBoosts(s), 'seller-a')).toBe(false);
    expect(sellerSuppressionRemaining(sessionBoosts(s), 'seller-a')).toBe(0);
    expect(s.suppressedSellers.size).toBe(0);
  });

  it('stays expired past 10', () => {
    let s = fold(fresh(), [BUY]);
    for (let i = 0; i < 25; i++) s = fold(s, [impression(i)]);
    expect(isSellerSuppressed(sessionBoosts(s), 'seller-a')).toBe(false);
  });

  it('counts videos, not skips or ticks', () => {
    let s = fold(fresh(), [BUY]);
    for (let i = 0; i < 30; i++) s = fold(s, [SKIP, TICK]);
    expect(sellerSuppressionRemaining(sessionBoosts(s), 'seller-a')).toBe(SELLER_SUPPRESSION_VIDEOS);
  });

  it('restarts the full countdown on a repeat purchase', () => {
    let s = fold(fresh(), [BUY]);
    for (let i = 0; i < 7; i++) s = fold(s, [impression(i)]);
    expect(sellerSuppressionRemaining(sessionBoosts(s), 'seller-a')).toBe(3);
    s = fold(s, [BUY]);
    expect(sellerSuppressionRemaining(sessionBoosts(s), 'seller-a')).toBe(SELLER_SUPPRESSION_VIDEOS);
  });

  it('tracks two sellers on independent countdowns', () => {
    let s = fold(fresh(), [BUY]);
    s = fold(s, [impression(1), impression(2), impression(3)]);
    s = fold(s, [{ type: 'purchase', sellerId: 'seller-b' }]);
    s = fold(s, [impression(4)]);
    const b = sessionBoosts(s);
    expect(sellerSuppressionRemaining(b, 'seller-a')).toBe(6);
    expect(sellerSuppressionRemaining(b, 'seller-b')).toBe(9);
  });

  it('counts the purchase and its affinity points', () => {
    const s = fold(fresh(), [BUY]);
    expect(s.purchases).toBe(1);
    expect(s.sellerAffinityDelta['seller-a']).toBe(10);
    expect(s.categoryAffinityDelta.beauty).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Idle trending injection
// ---------------------------------------------------------------------------

describe('needsTrendingInjection', () => {
  it('is false one millisecond before the boundary', () => {
    expect(needsTrendingInjection(fresh(), at(IDLE_INJECTION_MS - 1))).toBe(false);
  });

  it('is true at exactly 120s', () => {
    expect(IDLE_INJECTION_MS).toBe(120_000);
    expect(needsTrendingInjection(fresh(), at(IDLE_INJECTION_MS))).toBe(true);
  });

  it('is true past the boundary', () => {
    expect(needsTrendingInjection(fresh(), at(IDLE_INJECTION_MS + 1))).toBe(true);
  });

  it('measures from session start when nothing has happened at all', () => {
    const s = fold(fresh(), [TICK, TICK], at(60_000));
    expect(needsTrendingInjection(s, at(119_999))).toBe(false);
    expect(needsTrendingInjection(s, at(120_000))).toBe(true);
  });

  it('restarts the clock on an interaction', () => {
    const s = applySessionEvent(fresh(), { type: 'any_interaction', kind: 'save' }, at(90_000));
    expect(needsTrendingInjection(s, at(200_000))).toBe(false);
    expect(needsTrendingInjection(s, at(210_000))).toBe(true);
  });

  it.each([
    ['product_tap', { type: 'product_tap', categoryId: 'a', priceCents: 1 } as SessionEvent],
    ['purchase', { type: 'purchase', sellerId: 's1' } as SessionEvent],
  ])('%s restarts the clock too', (_label, ev) => {
    const s = applySessionEvent(fresh(), ev, at(100_000));
    expect(needsTrendingInjection(s, at(219_999))).toBe(false);
    expect(needsTrendingInjection(s, at(220_000))).toBe(true);
  });

  // A viewer flicking past videos has touched the device but nothing has
  // landed, which is exactly who the injection is for.
  it('is NOT restarted by fast skips or by a non-trending impression', () => {
    let s = applySessionEvent(fresh(), SKIP, at(60_000));
    s = applySessionEvent(s, impression(1, { lane: 'affinity' }), at(90_000));
    s = applySessionEvent(s, TICK, at(110_000));
    expect(needsTrendingInjection(s, at(120_000))).toBe(true);
  });

  // ...but serving a trending video does satisfy it, or the rule would pin the
  // rest of the session to trending.
  it('is satisfied by a trending-lane impression', () => {
    let s = fresh();
    expect(needsTrendingInjection(s, at(120_000))).toBe(true);
    s = applySessionEvent(s, impression(1, { lane: 'trending' }), at(120_000));
    expect(s.lastTrendingInjectionAt?.getTime()).toBe(at(120_000).getTime());
    expect(needsTrendingInjection(s, at(120_001))).toBe(false);
    expect(needsTrendingInjection(s, at(240_000))).toBe(true);
  });

  it('reports the idle duration', () => {
    expect(idleMsSince(fresh(), at(45_000))).toBe(45_000);
    expect(idleMsSince(fresh(), at(-1_000))).toBe(0);
  });

  it('respects an overridden threshold', () => {
    expect(needsTrendingInjection(fresh(), at(5_000), 5_000)).toBe(true);
    expect(needsTrendingInjection(fresh(), at(4_999), 5_000)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bookkeeping
// ---------------------------------------------------------------------------

describe('impression bookkeeping', () => {
  it('counts impressions, categories, sellers, lanes and served ids', () => {
    const s = fold(fresh(), [
      impression(1, { lane: 'tail', categoryId: 'apparel', sellerId: 's1' }),
      impression(2, { lane: 'tail', categoryId: 'apparel', sellerId: 's2' }),
      impression(3, { lane: 'fresh', categoryId: null, sellerId: 's1' }),
    ]);
    expect(s.impressions).toBe(3);
    expect(s.laneCounts.tail).toBe(2);
    expect(s.laneCounts.fresh).toBe(1);
    expect(s.laneCounts.affinity).toBe(0);
    expect(s.categoryCounts.apparel).toBe(2);
    expect(s.categoryCounts['']).toBe(1); // uncategorised bucket, as in medianFor
    expect(s.sellerCounts.s1).toBe(2);
    expect([...s.servedVideoIds].sort()).toEqual(['v1', 'v2', 'v3']);
  });
});

describe('any_interaction', () => {
  it('routes watch95 to completions and add_to_cart to addToCarts', () => {
    const s = fold(fresh(), [
      { type: 'any_interaction', kind: 'watch95', categoryId: 'apparel' },
      { type: 'any_interaction', kind: 'add_to_cart', categoryId: 'apparel' },
      { type: 'any_interaction', kind: 'like', categoryId: 'apparel' },
    ]);
    expect(s.completions).toBe(1);
    expect(s.addToCarts).toBe(1);
    // watch95 1 + add_to_cart 4 + like 0.3, on affinity.ts's event scale.
    expect(s.categoryAffinityDelta.apparel).toBeCloseTo(5.3, 12);
  });

  it('floors negative affinity mass at zero, like applyEvents does', () => {
    const s = fold(fresh(), [SKIP, SKIP, SKIP]); // 3 x -1.5
    expect(s.categoryAffinityDelta.apparel).toBe(0);
    expect(s.sellerAffinityDelta.s1).toBe(0);
  });
});

describe('tick', () => {
  it('changes nothing at all', () => {
    const s = fold(fresh(), [SKIP, SKIP]);
    expect(applySessionEvent(s, TICK, at(999_999))).toBe(s);
  });
});

describe('applySessionEvents', () => {
  it('replays a timeline deterministically, each event with its own instant', () => {
    const timeline = [
      { event: impression(1), now: at(0) },
      { event: SKIP, now: at(1_000) },
      { event: impression(2), now: at(2_000) },
      { event: SKIP, now: at(3_000) },
      { event: impression(3), now: at(4_000) },
      { event: SKIP, now: at(5_000) },
    ];
    const a = applySessionEvents(fresh(), timeline);
    const b = applySessionEvents(fresh(), timeline);
    expect(sessionMode(a)).toBe('diversify');
    expect(sessionWeights(DEFAULT_WEIGHTS, a)).toEqual(sessionWeights(DEFAULT_WEIGHTS, b));
    expect(a.impressions).toBe(b.impressions);
    expect(a.consecutiveFastSkips).toBe(b.consecutiveFastSkips);
  });
});
