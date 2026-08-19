import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  AFFINITY_CAP,
  AFFINITY_DAILY_RETENTION,
  EVENT_WEIGHTS,
  NEGATIVE_SELLER_WEIGHTS,
  NEGATIVE_SIGNAL_TYPES,
  NEIGHBOUR_SUPPRESSION_DAYS,
  NEIGHBOUR_SUPPRESSION_K,
  NO_NEIGHBOURS,
  REFUND_SUPPRESSION_DAYS,
  SELLER_BLOCK_DAYS,
  SUPPRESSION_RULES,
  UNFOLLOW_SUPPRESSION_DAYS,
  activeSuppressions,
  applyAffinityDeltas,
  applyEvents,
  applyNegativeSignals,
  blockSellerFrom,
  daysElapsedBetween,
  decayAffinity,
  findSuppression,
  isNegativeSignalType,
  isSellerBlocked,
  isSuppressed,
  isSuppressionActive,
  mergeSuppressions,
  normalizeWithCap,
  revocationForRefollow,
  revokeSuppressions,
  suppressionFromSellerBlock,
  updateViewerAffinity,
  updateViewerAffinityWithSignals,
  watchEventType,
  type AffinityEvent,
  type AffinityEventType,
  type AffinityMap,
  type NeighbourProvider,
  type Suppression,
  type ViewerEvent,
} from '../affinity';
import { mulberry32 } from '../rng';
import type { ViewerProfile } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sum = (m: AffinityMap): number => Object.values(m).reduce((a, b) => a + b, 0);
const maxOf = (m: AffinityMap): number => Math.max(...Object.values(m));
const effectiveCap = (n: number, cap = AFFINITY_CAP): number => Math.max(cap, 1 / n);

/**
 * The bug this module exists to prevent, implemented on purpose: normalise,
 * clamp everything over the cap, redistribute the freed mass ONCE. Tests below
 * assert that `normalizeWithCap` does NOT agree with it.
 */
function naiveNormalizeWithCap(map: AffinityMap, cap = AFFINITY_CAP): AffinityMap {
  const keys = Object.keys(map);
  let total = 0;
  for (const k of keys) total += Math.max(0, map[k]);
  const w: AffinityMap = {};
  for (const k of keys) w[k] = total > 0 ? Math.max(0, map[k]) / total : 0;

  let freed = 0;
  const under: string[] = [];
  for (const k of keys) {
    if (w[k] > cap) {
      freed += w[k] - cap;
      w[k] = cap;
    } else {
      under.push(k);
    }
  }
  let base = 0;
  for (const k of under) base += w[k];
  if (base > 0) for (const k of under) w[k] += freed * (w[k] / base);
  return w;
}

function expectValidDistribution(m: AffinityMap, cap = AFFINITY_CAP): void {
  const n = Object.keys(m).length;
  expect(n).toBeGreaterThan(0);
  for (const [key, value] of Object.entries(m)) {
    expect(Number.isFinite(value), `${key} is finite`).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(effectiveCap(n, cap) + 1e-9);
  }
  expect(sum(m)).toBeCloseTo(1, 12);
}

const PROFILE: ViewerProfile = {
  categoryAffinity: {},
  sellerAffinity: {},
  hashtagAffinity: {},
  priceBand: { p25: 1500, p50: 4000, p75: 9000 },
  coldStartComplete: true,
};

const NOW = new Date('2026-01-01T00:00:00.000Z');

// ---------------------------------------------------------------------------
// Determinism contract
// ---------------------------------------------------------------------------

describe('determinism contract', () => {
  it('reads no global clock and no global random source', () => {
    const src = readFileSync(new URL('../affinity.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/Math\s*\.\s*random/);
    expect(src).not.toMatch(/Date\s*\.\s*now/);
    expect(src).not.toMatch(/performance\s*\.\s*now/);
    // `new Date(...)` is only ever derived from the caller's `now`.
    expect(src).not.toMatch(/new Date\(\s*\)/);
  });

  it('does not mutate its inputs', () => {
    const map = Object.freeze({ a: 3, b: 1 });
    const events = Object.freeze([Object.freeze({ key: 'a', type: 'purchase' as const })]);
    expect(() => decayAffinity(map, 2)).not.toThrow();
    expect(() => applyEvents(map, events)).not.toThrow();
    expect(() => normalizeWithCap(map)).not.toThrow();
    expect(map).toEqual({ a: 3, b: 1 });
  });
});

// ---------------------------------------------------------------------------
// Event weights
// ---------------------------------------------------------------------------

describe('EVENT_WEIGHTS', () => {
  it('matches spec 2.7 exactly', () => {
    expect(EVENT_WEIGHTS).toEqual({
      purchase: 10,
      add_to_cart: 4,
      checkout_open: 3,
      product_tap: 2,
      follow: 3,
      save: 1.5,
      share: 1.5,
      watch95: 1,
      watch50: 0.3,
      like: 0.3,
      fast_skip: -1.5,
      not_interested: -8,
    });
  });

  it('maps completion fractions onto the watch events at the >= boundary', () => {
    expect(watchEventType(1)).toBe('watch95');
    expect(watchEventType(0.95)).toBe('watch95');
    expect(watchEventType(0.9499)).toBe('watch50');
    expect(watchEventType(0.5)).toBe('watch50');
    expect(watchEventType(0.4999)).toBeNull();
    expect(watchEventType(Number.NaN)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Decay
// ---------------------------------------------------------------------------

describe('decayAffinity', () => {
  it('0 days elapsed is no change', () => {
    const map = { apparel: 12.5, beauty: 3, home: 0 };
    expect(decayAffinity(map, 0)).toEqual(map);
  });

  it('30 days materially decays (0.97^30 ~= 0.401)', () => {
    const out = decayAffinity({ apparel: 100 }, 30);
    expect(out.apparel).toBeCloseTo(100 * Math.pow(AFFINITY_DAILY_RETENTION, 30), 10);
    expect(out.apparel).toBeCloseTo(40.1007, 3);
    expect(out.apparel).toBeLessThan(50);
    expect(out.apparel).toBeGreaterThan(0);
  });

  it('decays monotonically and never goes negative', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (const days of [0, 1, 7, 30, 90, 365, 10_000]) {
      const value = decayAffinity({ a: 100 }, days).a;
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(previous);
      expect(Number.isFinite(value)).toBe(true);
      previous = value;
    }
  });

  it('clamps negative and non-finite inputs to 0', () => {
    expect(decayAffinity({ a: -50, b: Number.NaN, c: Number.POSITIVE_INFINITY, d: 4 }, 1)).toEqual({
      a: 0,
      b: 0,
      c: 0,
      d: 4 * AFFINITY_DAILY_RETENTION,
    });
  });

  it('never grows the map when the clock goes backwards or is unusable', () => {
    expect(decayAffinity({ a: 10 }, -5)).toEqual({ a: 10 });
    expect(decayAffinity({ a: 10 }, Number.NaN)).toEqual({ a: 10 });
    expect(decayAffinity({ a: 10 }, Number.POSITIVE_INFINITY)).toEqual({ a: 10 });
  });

  it('handles the empty map', () => {
    expect(decayAffinity({}, 12)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Event accumulation
// ---------------------------------------------------------------------------

describe('applyEvents', () => {
  it('accumulates weights onto existing and brand-new keys', () => {
    const out = applyEvents(
      { apparel: 1 },
      [
        { key: 'apparel', type: 'purchase' },
        { key: 'apparel', type: 'add_to_cart' },
        { key: 'beauty', type: 'follow' },
      ]
    );
    expect(out).toEqual({ apparel: 15, beauty: 3 });
  });

  it('applies count as repetitions', () => {
    expect(applyEvents({}, [{ key: 'a', type: 'watch50', count: 3 }]).a).toBeCloseTo(0.9, 12);
  });

  it('ignores non-positive counts, empty keys and unknown event types', () => {
    const out = applyEvents({ a: 2 }, [
      { key: 'a', type: 'purchase', count: 0 },
      { key: 'a', type: 'purchase', count: -1 },
      { key: 'a', type: 'purchase', count: Number.NaN },
      { key: '', type: 'purchase' },
      { key: 'a', type: 'teleported' as AffinityEventType },
    ]);
    expect(out).toEqual({ a: 2 });
  });

  it('floors at 0 rather than accumulating debt', () => {
    expect(applyEvents({ a: 2 }, [{ key: 'a', type: 'not_interested' }])).toEqual({ a: 0 });
    expect(
      applyEvents({ a: 2 }, [
        { key: 'a', type: 'not_interested' },
        { key: 'a', type: 'not_interested' },
      ])
    ).toEqual({ a: 0 });
  });

  it('is a no-op with no events', () => {
    expect(applyEvents({ a: 1, b: 2 }, [])).toEqual({ a: 1, b: 2 });
  });
});

// ---------------------------------------------------------------------------
// normalizeWithCap — the documented bug
// ---------------------------------------------------------------------------

describe('normalizeWithCap — n=2 feasibility floor', () => {
  const input = { apparel: 0.9, beauty: 0.1 };

  it('the naive single-pass version produces the documented wrong output', () => {
    const naive = naiveNormalizeWithCap(input, 0.45);
    expect(naive.apparel).toBeCloseTo(0.45, 12);
    expect(naive.beauty).toBeCloseTo(0.55, 12);
    // Sums to 1, and still violates the very cap it was enforcing.
    expect(sum(naive)).toBeCloseTo(1, 12);
    expect(naive.beauty).toBeGreaterThan(0.45);
    expect(naive.beauty).toBeGreaterThan(effectiveCap(2));
  });

  it('water-filling sums to 1 and respects max(0.45, 1/2) = 0.5', () => {
    const out = normalizeWithCap(input, 0.45);
    expect(sum(out)).toBeCloseTo(1, 12);
    expect(maxOf(out)).toBeLessThanOrEqual(effectiveCap(2) + 1e-12);
    expect(out.apparel).toBeCloseTo(0.5, 12);
    expect(out.beauty).toBeCloseTo(0.5, 12);
  });

  it('does NOT produce {apparel: 0.45, beauty: 0.55}', () => {
    const out = normalizeWithCap(input, 0.45);
    expect(out.apparel).not.toBeCloseTo(0.45, 6);
    expect(out.beauty).not.toBeCloseTo(0.55, 6);
    expect(out.beauty).toBeLessThanOrEqual(0.5 + 1e-12);
  });

  it('holds for any n=2 split', () => {
    for (const [a, b] of [
      [1, 0],
      [0.99, 0.01],
      [0.5, 0.5],
      [0.46, 0.54],
      [7, 3],
    ]) {
      const out = normalizeWithCap({ a, b }, 0.45);
      expectValidDistribution(out, 0.45);
      expect(out.a).toBeCloseTo(0.5, 12);
      expect(out.b).toBeCloseTo(0.5, 12);
    }
  });
});

describe('normalizeWithCap — n=3 with two keys over cap', () => {
  it('converges to sum 1 with no key over 0.45', () => {
    const out = normalizeWithCap({ a: 0.48, b: 0.47, c: 0.05 }, 0.45);
    expectValidDistribution(out, 0.45);
    expect(out.a).toBeCloseTo(0.45, 12);
    expect(out.b).toBeCloseTo(0.45, 12);
    expect(out.c).toBeCloseTo(0.1, 12);
  });

  it('leaves an already-legal distribution alone', () => {
    const out = normalizeWithCap({ a: 0.4, b: 0.35, c: 0.25 }, 0.45);
    expect(out.a).toBeCloseTo(0.4, 12);
    expect(out.b).toBeCloseTo(0.35, 12);
    expect(out.c).toBeCloseTo(0.25, 12);
  });
});

describe('normalizeWithCap — redistribution must not overflow the receivers', () => {
  // Engineered so that ONE pass of proportional redistribution pushes b from
  // 0.28 to 0.5133, well over the cap it was supposed to be under.
  const input = { a: 0.7, b: 0.28, c: 0.01, d: 0.01 };

  it('the single-pass version overflows a receiving key', () => {
    const naive = naiveNormalizeWithCap(input, 0.45);
    expect(naive.b).toBeCloseTo(0.5133333, 6);
    expect(naive.b).toBeGreaterThan(0.45);
  });

  it('water-filling freezes the overflowed receiver on the next iteration', () => {
    const out = normalizeWithCap(input, 0.45);
    expectValidDistribution(out, 0.45);
    expect(out.a).toBeCloseTo(0.45, 12);
    expect(out.b).toBeCloseTo(0.45, 12);
    expect(out.c).toBeCloseTo(0.05, 12);
    expect(out.d).toBeCloseTo(0.05, 12);
    expect(out.b).not.toBeCloseTo(0.5133333, 6);
  });

  it('converges with many keys over a tighter cap', () => {
    const input10: AffinityMap = { a: 100, b: 100, c: 100 };
    for (const k of ['d', 'e', 'f', 'g', 'h', 'i', 'j']) input10[k] = 1;
    const out = normalizeWithCap(input10, 0.2);
    expectValidDistribution(out, 0.2);
    expect(out.a).toBeCloseTo(0.2, 12);
    expect(out.b).toBeCloseTo(0.2, 12);
    expect(out.c).toBeCloseTo(0.2, 12);
    expect(out.d).toBeCloseTo(0.4 / 7, 12);
  });
});

describe('normalizeWithCap — idempotence', () => {
  const cases: AffinityMap[] = [
    { apparel: 0.9, beauty: 0.1 },
    { a: 0.7, b: 0.28, c: 0.01, d: 0.01 },
    { a: 0.48, b: 0.47, c: 0.05 },
    { a: 100, b: 0, c: 0 },
    { a: 1, b: 1, c: 1, d: 1, e: 1 },
    { solo: 42 },
  ];

  it('normalizeWithCap(normalizeWithCap(x)) === normalizeWithCap(x)', () => {
    for (const input of cases) {
      const once = normalizeWithCap(input);
      const twice = normalizeWithCap(once);
      for (const key of Object.keys(once)) {
        expect(Math.abs(twice[key] - once[key])).toBeLessThan(1e-12);
      }
      expect(Object.keys(twice)).toEqual(Object.keys(once));
    }
  });
});

describe('normalizeWithCap — degenerate inputs', () => {
  it('empty map stays empty', () => {
    expect(normalizeWithCap({})).toEqual({});
  });

  it('n=1 gets the whole mass, because max(0.45, 1/1) = 1', () => {
    expect(normalizeWithCap({ solo: 7 })).toEqual({ solo: 1 });
    expect(normalizeWithCap({ solo: 0 })).toEqual({ solo: 1 });
  });

  it('all-equal input is unchanged', () => {
    const out = normalizeWithCap({ a: 5, b: 5, c: 5, d: 5 });
    expectValidDistribution(out);
    for (const v of Object.values(out)) expect(v).toBeCloseTo(0.25, 12);
  });

  it('all-zero input becomes uniform rather than NaN', () => {
    const out = normalizeWithCap({ a: 0, b: 0, c: 0 });
    expectValidDistribution(out);
    for (const v of Object.values(out)) expect(v).toBeCloseTo(1 / 3, 12);
  });

  it('negative inputs are clamped to 0 first', () => {
    const out = normalizeWithCap({ a: -5, b: -1, c: 10 }, 0.45);
    expectValidDistribution(out, 0.45);
    expect(out.c).toBeCloseTo(0.45, 12);
    expect(out.a).toBeCloseTo(0.275, 12);
    expect(out.b).toBeCloseTo(0.275, 12);
  });

  it('non-finite inputs are clamped to 0 rather than poisoning the map', () => {
    const out = normalizeWithCap({ a: Number.NaN, b: Number.POSITIVE_INFINITY, c: 3 });
    expectValidDistribution(out);
    expect(out.c).toBeCloseTo(0.45, 12);
  });

  it('a single dominant key spreads its overflow over zero-weight keys', () => {
    const out = normalizeWithCap({ a: 100, b: 0, c: 0 }, 0.45);
    expectValidDistribution(out, 0.45);
    expect(out.a).toBeCloseTo(0.45, 12);
    expect(out.b).toBeCloseTo(0.275, 12);
    expect(out.c).toBeCloseTo(0.275, 12);
  });

  it('a nonsense cap degrades to the feasibility floor instead of exploding', () => {
    expect(normalizeWithCap({ a: 9, b: 1 }, Number.NaN).a).toBeCloseTo(0.5, 12);
    expect(normalizeWithCap({ a: 9, b: 1 }, -3).a).toBeCloseTo(0.5, 12);
    expect(normalizeWithCap({ a: 9, b: 1, c: 0 }, 0).a).toBeCloseTo(1 / 3, 12);
    expect(normalizeWithCap({ a: 9, b: 1 }, 1).a).toBeCloseTo(0.9, 12);
  });
});

describe('normalizeWithCap — seeded property sweep', () => {
  it('always terminates, sums to 1, never exceeds the effective cap, never NaN', () => {
    const rng = mulberry32(20260819);
    for (let trial = 0; trial < 400; trial++) {
      const n = 1 + Math.floor(rng() * 8);
      const cap = [0.2, 0.3, 0.45, 0.6][Math.floor(rng() * 4)];
      const input: AffinityMap = {};
      for (let i = 0; i < n; i++) {
        const roll = rng();
        input[`k${i}`] = roll < 0.25 ? 0 : roll < 0.35 ? -rng() * 10 : rng() * rng() * 1000;
      }
      const out = normalizeWithCap(input, cap);
      expect(Object.keys(out)).toEqual(Object.keys(input));
      expectValidDistribution(out, cap);
    }
  });
});

// ---------------------------------------------------------------------------
// Seller blocks
// ---------------------------------------------------------------------------

describe('seller blocks', () => {
  it('blocks for 30 days from the supplied clock', () => {
    const block = blockSellerFrom('s1', NOW);
    expect(block.sellerId).toBe('s1');
    expect(block.blockedUntil.toISOString()).toBe('2026-01-31T00:00:00.000Z');
    expect(SELLER_BLOCK_DAYS).toBe(30);
  });

  it('expires exactly at the boundary', () => {
    const block = blockSellerFrom('s1', NOW);
    expect(isSellerBlocked(block, new Date('2026-01-30T23:59:59.999Z'))).toBe(true);
    expect(isSellerBlocked(block, block.blockedUntil)).toBe(false);
    expect(isSellerBlocked(block, new Date('2026-02-01T00:00:00.000Z'))).toBe(false);
  });

  it('daysElapsedBetween is a non-negative day count', () => {
    expect(daysElapsedBetween(NOW, new Date('2026-01-31T00:00:00.000Z'))).toBe(30);
    expect(daysElapsedBetween(NOW, NOW)).toBe(0);
    expect(daysElapsedBetween(new Date('2026-01-31T00:00:00.000Z'), NOW)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The whole pass
// ---------------------------------------------------------------------------

describe('updateViewerAffinity', () => {
  const events: AffinityEvent[] = [
    { type: 'purchase', categoryId: 'apparel', sellerId: 's1', hashtags: ['denim', 'ootd', 'denim'] },
    { type: 'fast_skip', categoryId: 'beauty', sellerId: 's2', hashtags: ['glow'] },
    { type: 'product_tap', categoryId: 'apparel', sellerId: 's3' },
  ];

  it('updates all three maps to a legal distribution', () => {
    const { profile } = updateViewerAffinity(PROFILE, events, 0, NOW);
    expectValidDistribution(profile.categoryAffinity);
    expectValidDistribution(profile.sellerAffinity);
    expectValidDistribution(profile.hashtagAffinity);
  });

  it('returns the raw pre-normalisation mass as the cron running state', () => {
    const { raw } = updateViewerAffinity(PROFILE, events, 0, NOW);
    expect(raw.categoryAffinity).toEqual({ apparel: 12, beauty: 0 });
    expect(raw.sellerAffinity).toEqual({ s1: 10, s2: 0, s3: 2 });
    // Deduped within an event: 'denim' twice in one event counts once.
    expect(raw.hashtagAffinity).toEqual({ denim: 10, ootd: 10, glow: 0 });
  });

  it('carries non-affinity profile fields through untouched', () => {
    const { profile } = updateViewerAffinity(PROFILE, events, 3, NOW);
    expect(profile.priceBand).toEqual(PROFILE.priceBand);
    expect(profile.coldStartComplete).toBe(true);
  });

  it('skips events with no key for a given map', () => {
    const { raw } = updateViewerAffinity(
      PROFILE,
      [{ type: 'follow', sellerId: 's1', categoryId: null }],
      0,
      NOW
    );
    expect(raw.categoryAffinity).toEqual({});
    expect(raw.sellerAffinity).toEqual({ s1: 3 });
  });

  it('emits one 30-day seller block per not_interested seller', () => {
    const { sellerBlocks } = updateViewerAffinity(
      PROFILE,
      [
        { type: 'not_interested', categoryId: 'beauty', sellerId: 's9' },
        { type: 'not_interested', categoryId: 'beauty', sellerId: 's9' },
        { type: 'not_interested', categoryId: 'home', sellerId: 's8' },
        { type: 'fast_skip', sellerId: 's7' },
      ],
      0,
      NOW
    );
    expect(sellerBlocks).toEqual([
      { sellerId: 's9', blockedUntil: new Date('2026-01-31T00:00:00.000Z') },
      { sellerId: 's8', blockedUntil: new Date('2026-01-31T00:00:00.000Z') },
    ]);
  });

  it('emits no blocks when nothing was marked not interested', () => {
    expect(updateViewerAffinity(PROFILE, events, 0, NOW).sellerBlocks).toEqual([]);
  });

  it('decay alone is a no-op once the map is renormalised', () => {
    const seeded: ViewerProfile = {
      ...PROFILE,
      categoryAffinity: { a: 0.4, b: 0.35, c: 0.25 },
    };
    const { profile } = updateViewerAffinity(seeded, [], 30, NOW);
    expect(profile.categoryAffinity.a).toBeCloseTo(0.4, 12);
    expect(profile.categoryAffinity.b).toBeCloseTo(0.35, 12);
    expect(profile.categoryAffinity.c).toBeCloseTo(0.25, 12);
  });

  it('decay changes the balance between history and fresh events', () => {
    const seeded: ViewerProfile = { ...PROFILE, categoryAffinity: { a: 100, b: 100 } };
    const fresh = updateViewerAffinity(
      seeded,
      [{ type: 'purchase', categoryId: 'c' }],
      0,
      NOW
    ).raw.categoryAffinity;
    const stale = updateViewerAffinity(
      seeded,
      [{ type: 'purchase', categoryId: 'c' }],
      365,
      NOW
    ).raw.categoryAffinity;
    // Same event, older history: the event owns proportionally more of the map.
    expect(fresh.c / (fresh.a + fresh.b + fresh.c)).toBeLessThan(
      stale.c / (stale.a + stale.b + stale.c)
    );
  });

  it('caps a dominant category at 0.45 across a realistic map', () => {
    const seeded: ViewerProfile = {
      ...PROFILE,
      categoryAffinity: { apparel: 900, beauty: 40, home: 30, tech: 20, food: 10 },
    };
    const { profile } = updateViewerAffinity(seeded, [], 0, NOW);
    expectValidDistribution(profile.categoryAffinity);
    expect(profile.categoryAffinity.apparel).toBeCloseTo(0.45, 12);
    expect(sum(profile.categoryAffinity)).toBeCloseTo(1, 12);
  });

  it('is deterministic: same inputs, same output', () => {
    const a = updateViewerAffinity(PROFILE, events, 7, NOW);
    const b = updateViewerAffinity(PROFILE, events, 7, NOW);
    expect(a).toEqual(b);
  });
});

// ===========================================================================
// SPEC 6.5 — NEGATIVE SIGNALS THAT ACTUALLY BITE
// ===========================================================================

const VIEWER = 'viewer-a';
const OTHER_VIEWER = 'viewer-b';

const PLUS_7D = new Date('2026-01-08T00:00:00.000Z');
const PLUS_14D = new Date('2026-01-15T00:00:00.000Z');
const PLUS_30D = new Date('2026-01-31T00:00:00.000Z');

const at = (iso: string): Date => new Date(iso);
const msBefore = (d: Date): Date => new Date(d.getTime() - 1);
const msAfter = (d: Date): Date => new Date(d.getTime() + 1);

/** n synthetic neighbour ids. */
const neighbourIds = (n: number, prefix = 'nb'): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`);

/** A well-behaved provider: honours k itself, as a real ANN index would. */
const indexOf =
  (ids: readonly string[]): NeighbourProvider =>
  (_videoId, k) =>
    ids.slice(0, k);

/** A badly-behaved provider: ignores k and returns whatever it likes. */
const rawProvider =
  (ids: readonly string[]): NeighbourProvider =>
  () =>
    ids;

const scoped = (rows: readonly Suppression[], scope: Suppression['scope']): Suppression[] =>
  rows.filter((r) => r.scope === scope);

const profileWith = (sellerAffinity: AffinityMap): ViewerProfile => ({
  ...PROFILE,
  sellerAffinity,
});

// ---------------------------------------------------------------------------
// The tables
// ---------------------------------------------------------------------------

describe('6.5 — the weight tables are disjoint', () => {
  it('NEGATIVE_SELLER_WEIGHTS is only the numbers 2.7 does not already own', () => {
    expect(NEGATIVE_SELLER_WEIGHTS).toEqual({
      unfollow: -5,
      refund_requested: -4,
      dispute_filed: 0,
    });
  });

  it('no signal type carries a weight in both tables', () => {
    for (const key of Object.keys(NEGATIVE_SELLER_WEIGHTS)) {
      expect(Object.prototype.hasOwnProperty.call(EVENT_WEIGHTS, key)).toBe(false);
    }
  });

  it('the two overlapping types keep their 2.7 weights and only their 2.7 weights', () => {
    expect(EVENT_WEIGHTS.not_interested).toBe(-8);
    expect(EVENT_WEIGHTS.fast_skip).toBe(-1.5);
    expect(Object.prototype.hasOwnProperty.call(NEGATIVE_SELLER_WEIGHTS, 'not_interested')).toBe(
      false
    );
    expect(Object.prototype.hasOwnProperty.call(NEGATIVE_SELLER_WEIGHTS, 'fast_skip')).toBe(false);
  });

  it('NEGATIVE_SIGNAL_TYPES is the whole 6.5 table minus the session-mode row', () => {
    expect([...NEGATIVE_SIGNAL_TYPES]).toEqual([
      'not_interested',
      'fast_skip',
      'unfollow',
      'refund_requested',
      'dispute_filed',
    ]);
    for (const t of NEGATIVE_SIGNAL_TYPES) expect(isNegativeSignalType(t)).toBe(true);
    expect(isNegativeSignalType('purchase')).toBe(false);
    expect(isNegativeSignalType(undefined)).toBe(false);
  });

  it('the suppression durations are the spec durations', () => {
    expect(SUPPRESSION_RULES.not_interested_seller.days).toBe(30);
    expect(SUPPRESSION_RULES.not_interested_video.days).toBe(7);
    expect(SUPPRESSION_RULES.unfollow.days).toBe(30);
    expect(SUPPRESSION_RULES.refund_requested.days).toBe(14);
    expect(SUPPRESSION_RULES.dispute_filed.days).toBeNull();
    expect(SELLER_BLOCK_DAYS).toBe(30);
    expect(NEIGHBOUR_SUPPRESSION_DAYS).toBe(7);
    expect(NEIGHBOUR_SUPPRESSION_K).toBe(20);
    expect(UNFOLLOW_SUPPRESSION_DAYS).toBe(30);
    expect(REFUND_SUPPRESSION_DAYS).toBe(14);
  });
});

// ---------------------------------------------------------------------------
// Each weight applied exactly once
// ---------------------------------------------------------------------------

describe('6.5 — each weight is applied exactly once', () => {
  it('unfollow costs -5 seller affinity, once', () => {
    const { sellerDeltas } = applyNegativeSignals({
      viewerId: VIEWER,
      signals: [{ type: 'unfollow', sellerId: 's1' }],
      now: NOW,
    });
    expect(sellerDeltas).toEqual([{ key: 's1', delta: -5 }]);
  });

  it('refund_requested costs -4 seller affinity, once', () => {
    const { sellerDeltas } = applyNegativeSignals({
      viewerId: VIEWER,
      signals: [{ type: 'refund_requested', sellerId: 's1' }],
      now: NOW,
    });
    expect(sellerDeltas).toEqual([{ key: 's1', delta: -4 }]);
  });

  it('dispute_filed moves no affinity at all — the suppression is the mechanism', () => {
    const result = applyNegativeSignals({
      viewerId: VIEWER,
      signals: [{ type: 'dispute_filed', sellerId: 's1' }],
      now: NOW,
    });
    expect(result.sellerDeltas).toEqual([]);
    expect(result.suppressions).toHaveLength(1);
  });

  it('the identical signal repeated in one batch counts once', () => {
    const { sellerDeltas, suppressions } = applyNegativeSignals({
      viewerId: VIEWER,
      signals: [
        { type: 'unfollow', sellerId: 's1' },
        { type: 'unfollow', sellerId: 's1' },
        { type: 'unfollow', sellerId: 's1' },
      ],
      now: NOW,
    });
    expect(sellerDeltas).toEqual([{ key: 's1', delta: -5 }]);
    expect(suppressions).toHaveLength(1);
  });

  it('two genuinely separate occurrences, distinguished by id, both count', () => {
    const { sellerDeltas, suppressions } = applyNegativeSignals({
      viewerId: VIEWER,
      signals: [
        { type: 'refund_requested', sellerId: 's1', id: 'order-1' },
        { type: 'refund_requested', sellerId: 's1', id: 'order-2' },
      ],
      now: NOW,
    });
    expect(sellerDeltas).toEqual([
      { key: 's1', delta: -4 },
      { key: 's1', delta: -4 },
    ]);
    // Two refunds, one suppression window: the rows merge, the weights do not.
    expect(suppressions).toHaveLength(1);
  });

  it('not_interested takes -8 exactly once, from EVENT_WEIGHTS and nowhere else', () => {
    const { raw } = updateViewerAffinityWithSignals({
      profile: { ...PROFILE, categoryAffinity: { beauty: 20 }, sellerAffinity: { s9: 20 } },
      viewerId: VIEWER,
      events: [{ type: 'not_interested', categoryId: 'beauty', sellerId: 's9', videoId: 'v1' }],
      daysElapsed: 0,
      now: NOW,
    });
    // 20 - 8, not 20 - 16.
    expect(raw.categoryAffinity.beauty).toBeCloseTo(12, 12);
    expect(raw.sellerAffinity.s9).toBeCloseTo(12, 12);
  });

  it('fast_skip takes -1.5 exactly once and suppresses nothing', () => {
    const out = updateViewerAffinityWithSignals({
      profile: { ...PROFILE, categoryAffinity: { beauty: 10 } },
      viewerId: VIEWER,
      events: [{ type: 'fast_skip', categoryId: 'beauty', sellerId: 's1', videoId: 'v1' }],
      daysElapsed: 0,
      now: NOW,
    });
    expect(out.raw.categoryAffinity.beauty).toBeCloseTo(8.5, 12);
    expect(out.suppressions).toEqual([]);
    expect(out.neighbours.requested).toBe(0);
    expect(out.neighbours.degraded).toBe(false);
  });

  it('unfollow lands on the seller map only, before normalisation', () => {
    const out = updateViewerAffinityWithSignals({
      profile: profileWith({ s1: 10, s2: 10, s3: 10 }),
      viewerId: VIEWER,
      events: [{ type: 'unfollow', sellerId: 's1', categoryId: 'apparel' }],
      daysElapsed: 0,
      now: NOW,
    });
    expect(out.raw.sellerAffinity).toEqual({ s1: 5, s2: 10, s3: 10 });
    expect(out.raw.categoryAffinity).toEqual({});
    expect(out.raw.hashtagAffinity).toEqual({});
    // The returned profile is exactly the normaliser applied to that raw map.
    expect(out.profile.sellerAffinity).toEqual(normalizeWithCap({ s1: 5, s2: 10, s3: 10 }));
  });

  it('refund lands on the seller map only', () => {
    const out = updateViewerAffinityWithSignals({
      profile: profileWith({ s1: 10, s2: 10 }),
      viewerId: VIEWER,
      events: [{ type: 'refund_requested', sellerId: 's1' }],
      daysElapsed: 0,
      now: NOW,
    });
    expect(out.raw.sellerAffinity).toEqual({ s1: 6, s2: 10 });
  });
});

// ---------------------------------------------------------------------------
// Expiry boundaries
// ---------------------------------------------------------------------------

describe('6.5 — expiry boundaries are exact', () => {
  const rows = applyNegativeSignals({
    viewerId: VIEWER,
    signals: [
      { type: 'not_interested', sellerId: 's1', videoId: 'v1' },
      { type: 'unfollow', sellerId: 's2' },
      { type: 'refund_requested', sellerId: 's3' },
      { type: 'dispute_filed', sellerId: 's4' },
    ],
    now: NOW,
  }).suppressions;

  const rowFor = (scope: Suppression['scope'], id: string): Suppression => {
    const found = rows.find((r) => r.scope === scope && r.id === id);
    expect(found, `${scope}:${id}`).toBeDefined();
    return found as Suppression;
  };

  it('not_interested blocks the seller for exactly 30 days', () => {
    const row = rowFor('viewer_seller', 's1');
    expect(row.until?.toISOString()).toBe('2026-01-31T00:00:00.000Z');
    expect(isSuppressionActive(row, msBefore(PLUS_30D))).toBe(true);
    expect(isSuppressionActive(row, PLUS_30D)).toBe(false);
    expect(isSuppressionActive(row, msAfter(PLUS_30D))).toBe(false);
  });

  it('the disliked video and its neighbours are suppressed for exactly 7 days', () => {
    const row = rowFor('viewer_video', 'v1');
    expect(row.until?.toISOString()).toBe('2026-01-08T00:00:00.000Z');
    expect(isSuppressionActive(row, msBefore(PLUS_7D))).toBe(true);
    expect(isSuppressionActive(row, PLUS_7D)).toBe(false);
    // Not 6.99 days: a day short of the window is still suppressed.
    expect(isSuppressionActive(row, at('2026-01-07T00:00:00.000Z'))).toBe(true);
    expect(isSuppressionActive(row, at('2026-01-09T00:00:00.000Z'))).toBe(false);
  });

  it('unfollow suppresses For You for exactly 30 days', () => {
    const row = rowFor('viewer_seller', 's2');
    expect(row.until?.toISOString()).toBe('2026-01-31T00:00:00.000Z');
    expect(isSuppressionActive(row, msBefore(PLUS_30D))).toBe(true);
    expect(isSuppressionActive(row, PLUS_30D)).toBe(false);
  });

  it('refund suppresses for exactly 14 days — not 13, not 15', () => {
    const row = rowFor('viewer_seller', 's3');
    expect(row.until?.toISOString()).toBe('2026-01-15T00:00:00.000Z');
    expect(isSuppressionActive(row, at('2026-01-14T00:00:00.000Z'))).toBe(true);
    expect(isSuppressionActive(row, msBefore(PLUS_14D))).toBe(true);
    expect(isSuppressionActive(row, PLUS_14D)).toBe(false);
    expect(isSuppressionActive(row, msAfter(PLUS_14D))).toBe(false);
  });

  it('a filed dispute never expires on its own', () => {
    const row = rowFor('platform_seller', 's4');
    expect(row.until).toBeNull();
    expect(isSuppressionActive(row, PLUS_30D)).toBe(true);
    expect(isSuppressionActive(row, at('3000-01-01T00:00:00.000Z'))).toBe(true);
  });

  it('activeSuppressions drops exactly the lapsed rows', () => {
    expect(activeSuppressions(rows, NOW)).toHaveLength(rows.length);
    // Day 14: the 7-day video row and the 14-day refund row have both lapsed.
    const live = activeSuppressions(rows, PLUS_14D);
    expect(live.map((r) => r.id).sort()).toEqual(['s1', 's2', 's4']);
    // Day 30: only the platform-wide dispute survives.
    expect(activeSuppressions(rows, PLUS_30D).map((r) => r.id)).toEqual(['s4']);
    expect(activeSuppressions(rows, at('3000-01-01T00:00:00.000Z'))).toHaveLength(1);
  });

  it('matches the 2.7 seller-block boundary exactly', () => {
    const block = blockSellerFrom('s1', NOW);
    const row = suppressionFromSellerBlock(block, VIEWER);
    for (const when of [msBefore(PLUS_30D), PLUS_30D, msAfter(PLUS_30D)]) {
      expect(isSuppressionActive(row, when)).toBe(isSellerBlocked(block, when));
    }
  });
});

// ---------------------------------------------------------------------------
// Scope: platform-wide is not viewer-scoped
// ---------------------------------------------------------------------------

describe('6.5 — platform-wide and viewer-scoped genuinely differ', () => {
  const rows = applyNegativeSignals({
    viewerId: VIEWER,
    signals: [
      { type: 'unfollow', sellerId: 'unfollowed' },
      { type: 'not_interested', sellerId: 'disliked', videoId: 'v1' },
      { type: 'refund_requested', sellerId: 'refunded' },
      { type: 'dispute_filed', sellerId: 'disputed' },
    ],
    now: NOW,
  }).suppressions;

  it('a filed dispute has no viewer and no expiry', () => {
    const row = scoped(rows, 'platform_seller')[0];
    expect(row).toMatchObject({ id: 'disputed', viewerId: null, until: null, surface: 'all' });
    expect(scoped(rows, 'platform_seller')).toHaveLength(1);
  });

  it('the disputed seller is suppressed for a viewer who has never touched them', () => {
    expect(isSuppressed(rows, { viewerId: OTHER_VIEWER, sellerId: 'disputed', now: NOW })).toBe(
      true
    );
    expect(isSuppressed(rows, { viewerId: 'anyone-at-all', sellerId: 'disputed', now: NOW })).toBe(
      true
    );
  });

  it('every viewer-scoped row is invisible to a different viewer', () => {
    for (const sellerId of ['unfollowed', 'disliked', 'refunded']) {
      expect(isSuppressed(rows, { viewerId: VIEWER, sellerId, now: NOW }), sellerId).toBe(true);
      expect(isSuppressed(rows, { viewerId: OTHER_VIEWER, sellerId, now: NOW }), sellerId).toBe(
        false
      );
    }
  });

  it('a video suppression follows the viewer, not the platform', () => {
    expect(isSuppressed(rows, { viewerId: VIEWER, videoId: 'v1', now: NOW })).toBe(true);
    expect(isSuppressed(rows, { viewerId: OTHER_VIEWER, videoId: 'v1', now: NOW })).toBe(false);
  });

  it('a seller query never matches a video row, and vice versa', () => {
    expect(isSuppressed(rows, { viewerId: VIEWER, sellerId: 'v1', now: NOW })).toBe(false);
    expect(isSuppressed(rows, { viewerId: VIEWER, videoId: 'disliked', now: NOW })).toBe(false);
    expect(isSuppressed(rows, { viewerId: VIEWER, now: NOW })).toBe(false);
  });

  it('surface separates a block from a For You suppression', () => {
    // not_interested is a block: the seller is gone everywhere.
    expect(
      isSuppressed(rows, { viewerId: VIEWER, sellerId: 'disliked', now: NOW, surface: 'all' })
    ).toBe(true);
    // Unfollow and refund only hide the seller from the ranked feed.
    expect(
      isSuppressed(rows, { viewerId: VIEWER, sellerId: 'unfollowed', now: NOW, surface: 'all' })
    ).toBe(false);
    expect(
      isSuppressed(rows, { viewerId: VIEWER, sellerId: 'refunded', now: NOW, surface: 'all' })
    ).toBe(false);
    // A filed dispute reaches every surface.
    expect(
      isSuppressed(rows, { viewerId: OTHER_VIEWER, sellerId: 'disputed', now: NOW, surface: 'all' })
    ).toBe(true);
  });

  it('findSuppression names the signal that hid the candidate', () => {
    expect(findSuppression(rows, { viewerId: VIEWER, sellerId: 'refunded', now: NOW })?.reason).toBe(
      'refund_requested'
    );
    expect(
      findSuppression(rows, { viewerId: OTHER_VIEWER, sellerId: 'disputed', now: NOW })?.reason
    ).toBe('dispute_filed');
    expect(findSuppression(rows, { viewerId: VIEWER, sellerId: 'nobody', now: NOW })).toBeNull();
  });

  it('a lapsed row stops hiding anything', () => {
    expect(isSuppressed(rows, { viewerId: VIEWER, sellerId: 'refunded', now: PLUS_14D })).toBe(
      false
    );
    expect(isSuppressed(rows, { viewerId: VIEWER, videoId: 'v1', now: PLUS_7D })).toBe(false);
    expect(isSuppressed(rows, { viewerId: VIEWER, sellerId: 'disliked', now: PLUS_30D })).toBe(
      false
    );
    // Except the dispute, which nobody has reviewed.
    expect(
      isSuppressed(rows, { viewerId: OTHER_VIEWER, sellerId: 'disputed', now: PLUS_30D })
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Neighbour suppression — the important one
// ---------------------------------------------------------------------------

describe('6.5 — neighbour suppression with an embedding provider', () => {
  const signals = [{ type: 'not_interested' as const, sellerId: 's1', videoId: 'v1' }];

  it('suppresses the 20 nearest neighbours for 7 days', () => {
    const result = applyNegativeSignals({
      viewerId: VIEWER,
      signals,
      now: NOW,
      neighbours: indexOf(neighbourIds(50)),
    });

    expect(result.neighbours).toEqual({
      providerPresent: true,
      requested: 20,
      suppressed: 20,
      degraded: false,
      degradedVideoIds: [],
    });

    const videoRows = scoped(result.suppressions, 'viewer_video');
    // 20 neighbours plus the video the viewer actually pressed the button on.
    expect(videoRows).toHaveLength(21);
    expect(videoRows.map((r) => r.id)).toContain('v1');
    for (const row of videoRows) {
      expect(row.until?.toISOString()).toBe('2026-01-08T00:00:00.000Z');
      expect(row.viewerId).toBe(VIEWER);
      expect(row.reason).toBe('not_interested');
    }
  });

  it('caps at k even when the provider ignores k', () => {
    const result = applyNegativeSignals({
      viewerId: VIEWER,
      signals,
      now: NOW,
      neighbours: rawProvider(neighbourIds(500)),
    });
    expect(result.neighbours.suppressed).toBe(20);
    expect(scoped(result.suppressions, 'viewer_video')).toHaveLength(21);
  });

  it('a neighbour list containing the source video does not spend a slot on it', () => {
    const result = applyNegativeSignals({
      viewerId: VIEWER,
      signals,
      now: NOW,
      neighbours: rawProvider(['v1', ...neighbourIds(20)]),
    });
    expect(result.neighbours.suppressed).toBe(20);
    expect(scoped(result.suppressions, 'viewer_video')).toHaveLength(21);
  });

  it('deduplicates a provider that repeats itself, and ignores junk ids', () => {
    const result = applyNegativeSignals({
      viewerId: VIEWER,
      signals,
      now: NOW,
      neighbours: rawProvider(['nb0', 'nb0', 'nb1', '', 'nb1']),
    });
    expect(result.neighbours.suppressed).toBe(2);
    expect(scoped(result.suppressions, 'viewer_video').map((r) => r.id)).toEqual([
      'v1',
      'nb0',
      'nb1',
    ]);
  });

  it('honours an explicit k', () => {
    const result = applyNegativeSignals({
      viewerId: VIEWER,
      signals,
      now: NOW,
      neighbours: rawProvider(neighbourIds(50)),
      neighbourK: 5,
    });
    expect(result.neighbours.requested).toBe(5);
    expect(result.neighbours.suppressed).toBe(5);
  });

  it('falls back to 20 for a nonsense k', () => {
    for (const k of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = applyNegativeSignals({
        viewerId: VIEWER,
        signals,
        now: NOW,
        neighbours: rawProvider(neighbourIds(50)),
        neighbourK: k,
      });
      expect(result.neighbours.requested).toBe(NEIGHBOUR_SUPPRESSION_K);
      expect(result.neighbours.suppressed).toBe(NEIGHBOUR_SUPPRESSION_K);
    }
  });

  it('suppresses neighbours per disliked video, not per batch', () => {
    const result = applyNegativeSignals({
      viewerId: VIEWER,
      signals: [
        { type: 'not_interested', sellerId: 's1', videoId: 'v1' },
        { type: 'not_interested', sellerId: 's1', videoId: 'v2' },
      ],
      now: NOW,
      neighbours: (videoId, k) => neighbourIds(k, `${videoId}-nb`),
    });
    expect(result.neighbours.requested).toBe(40);
    expect(result.neighbours.suppressed).toBe(40);
    expect(scoped(result.suppressions, 'viewer_video')).toHaveLength(42);
    // One seller, one seller block, however many videos.
    expect(scoped(result.suppressions, 'viewer_seller')).toHaveLength(1);
  });
});

describe('6.5 — neighbour suppression degrades loudly without 6.2', () => {
  const signals = [{ type: 'not_interested' as const, sellerId: 's1', videoId: 'v1' }];

  it('with no provider it reports the degradation instead of pretending', () => {
    const result = applyNegativeSignals({ viewerId: VIEWER, signals, now: NOW });
    expect(result.neighbours).toEqual({
      providerPresent: false,
      requested: 20,
      suppressed: 0,
      degraded: true,
      degradedVideoIds: ['v1'],
    });
    // It still does the one thing it can: the video itself, and the seller.
    expect(scoped(result.suppressions, 'viewer_video').map((r) => r.id)).toEqual(['v1']);
    expect(scoped(result.suppressions, 'viewer_seller')).toHaveLength(1);
  });

  it('NO_NEIGHBOURS is indistinguishable from supplying nothing', () => {
    const withNone = applyNegativeSignals({
      viewerId: VIEWER,
      signals,
      now: NOW,
      neighbours: NO_NEIGHBOURS,
    });
    const withNothing = applyNegativeSignals({ viewerId: VIEWER, signals, now: NOW });
    expect(withNone).toEqual(withNothing);
    expect(withNone.neighbours.providerPresent).toBe(false);
    expect(NO_NEIGHBOURS('v1', 20)).toEqual([]);
  });

  it('a wired provider that knows nothing about this video is degraded but present', () => {
    const result = applyNegativeSignals({
      viewerId: VIEWER,
      signals,
      now: NOW,
      neighbours: (videoId) => (videoId === 'v-other' ? ['nb0'] : []),
    });
    expect(result.neighbours.providerPresent).toBe(true);
    expect(result.neighbours.degraded).toBe(true);
    expect(result.neighbours.degradedVideoIds).toEqual(['v1']);
  });

  it('partial coverage is visible without being called total degradation', () => {
    const result = applyNegativeSignals({
      viewerId: VIEWER,
      signals: [
        { type: 'not_interested', videoId: 'v1' },
        { type: 'not_interested', videoId: 'v2' },
      ],
      now: NOW,
      neighbours: (videoId, k) => (videoId === 'v1' ? neighbourIds(k) : []),
    });
    expect(result.neighbours.requested).toBe(40);
    expect(result.neighbours.suppressed).toBe(20);
    expect(result.neighbours.degraded).toBe(true);
    expect(result.neighbours.degradedVideoIds).toEqual(['v2']);
  });

  it('nothing to suppress is not a degradation', () => {
    const result = applyNegativeSignals({
      viewerId: VIEWER,
      signals: [{ type: 'unfollow', sellerId: 's1' }],
      now: NOW,
    });
    expect(result.neighbours.requested).toBe(0);
    expect(result.neighbours.degraded).toBe(false);
    expect(result.neighbours.degradedVideoIds).toEqual([]);
  });

  it('a not_interested with no videoId cannot ask for neighbours at all', () => {
    const result = applyNegativeSignals({
      viewerId: VIEWER,
      signals: [{ type: 'not_interested', sellerId: 's1' }],
      now: NOW,
      neighbours: indexOf(neighbourIds(50)),
    });
    expect(result.neighbours.requested).toBe(0);
    expect(result.neighbours.degraded).toBe(false);
    expect(scoped(result.suppressions, 'viewer_video')).toHaveLength(0);
    expect(scoped(result.suppressions, 'viewer_seller')).toHaveLength(1);
  });

  it('one injection makes it real — the same call, wired', () => {
    const degraded = updateViewerAffinityWithSignals({
      profile: PROFILE,
      viewerId: VIEWER,
      events: [{ type: 'not_interested', sellerId: 's1', videoId: 'v1', categoryId: 'beauty' }],
      daysElapsed: 0,
      now: NOW,
    });
    const wired = updateViewerAffinityWithSignals({
      profile: PROFILE,
      viewerId: VIEWER,
      events: [{ type: 'not_interested', sellerId: 's1', videoId: 'v1', categoryId: 'beauty' }],
      daysElapsed: 0,
      now: NOW,
      neighbours: indexOf(neighbourIds(50)),
    });
    expect(degraded.neighbours.degraded).toBe(true);
    expect(wired.neighbours.degraded).toBe(false);
    expect(wired.neighbours.suppressed).toBe(20);
    // The affinity half is identical either way: only the reach changed.
    expect(wired.raw).toEqual(degraded.raw);
    expect(wired.profile).toEqual(degraded.profile);
  });
});

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

describe('6.5 — mergeSuppressions', () => {
  it('keeps the longest-lived of two rows that say the same thing', () => {
    const short: Suppression = {
      scope: 'viewer_seller',
      id: 's1',
      viewerId: VIEWER,
      until: PLUS_7D,
      surface: 'for_you',
      reason: 'unfollow',
    };
    const long: Suppression = { ...short, until: PLUS_30D };
    expect(mergeSuppressions([short, long])).toEqual([long]);
    expect(mergeSuppressions([long, short])).toEqual([long]);
  });

  it('an indefinite row beats any dated one', () => {
    const dated: Suppression = {
      scope: 'platform_seller',
      id: 's1',
      viewerId: null,
      until: PLUS_30D,
      surface: 'all',
      reason: 'dispute_filed',
    };
    const forever: Suppression = { ...dated, until: null };
    expect(mergeSuppressions([dated, forever])).toEqual([forever]);
    expect(mergeSuppressions([forever, dated])).toEqual([forever]);
  });

  it('does not merge across reasons, so a refollow cannot lift a refund', () => {
    const rows = applyNegativeSignals({
      viewerId: VIEWER,
      signals: [
        { type: 'unfollow', sellerId: 's1' },
        { type: 'refund_requested', sellerId: 's1' },
      ],
      now: NOW,
    }).suppressions;
    // Same scope, id, viewer and surface — kept apart by reason alone.
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.reason).sort()).toEqual(['refund_requested', 'unfollow']);

    const survivors = revokeSuppressions(rows, [revocationForRefollow('s1', VIEWER)]);
    expect(survivors.map((r) => r.reason)).toEqual(['refund_requested']);
    expect(isSuppressed(survivors, { viewerId: VIEWER, sellerId: 's1', now: NOW })).toBe(true);
  });

  it('does not merge across viewers or scopes', () => {
    const rows = mergeSuppressions([
      ...applyNegativeSignals({
        viewerId: VIEWER,
        signals: [{ type: 'unfollow', sellerId: 's1' }],
        now: NOW,
      }).suppressions,
      ...applyNegativeSignals({
        viewerId: OTHER_VIEWER,
        signals: [{ type: 'unfollow', sellerId: 's1' }],
        now: NOW,
      }).suppressions,
      ...applyNegativeSignals({
        viewerId: VIEWER,
        signals: [{ type: 'dispute_filed', sellerId: 's1' }],
        now: NOW,
      }).suppressions,
    ]);
    expect(rows).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Unfollow -> refollow
// ---------------------------------------------------------------------------

describe('6.5 — unfollow then refollow is not a life sentence', () => {
  const unfollowThenFollow: ViewerEvent[] = [
    { type: 'unfollow', sellerId: 's1' },
    { type: 'follow', sellerId: 's1' },
  ];

  it('an unfollow on its own suppresses for 30 days', () => {
    const out = updateViewerAffinityWithSignals({
      profile: profileWith({ s1: 10, s2: 10 }),
      viewerId: VIEWER,
      events: [{ type: 'unfollow', sellerId: 's1' }],
      daysElapsed: 0,
      now: NOW,
    });
    expect(out.revocations).toEqual([]);
    expect(isSuppressed(out.suppressions, { viewerId: VIEWER, sellerId: 's1', now: NOW })).toBe(
      true
    );
  });

  it('a refollow in the same batch leaves no suppression standing', () => {
    const out = updateViewerAffinityWithSignals({
      profile: profileWith({ s1: 10, s2: 10 }),
      viewerId: VIEWER,
      events: unfollowThenFollow,
      daysElapsed: 0,
      now: NOW,
    });
    expect(out.suppressions).toEqual([]);
    expect(isSuppressed(out.suppressions, { viewerId: VIEWER, sellerId: 's1', now: NOW })).toBe(
      false
    );
    expect(out.revocations).toEqual([
      { scope: 'viewer_seller', id: 's1', viewerId: VIEWER, reason: 'unfollow' },
    ]);
  });

  it('the -5 still happened — affinity records behaviour, suppression records intent', () => {
    const out = updateViewerAffinityWithSignals({
      profile: profileWith({ s1: 10, s2: 10 }),
      viewerId: VIEWER,
      events: unfollowThenFollow,
      daysElapsed: 0,
      now: NOW,
    });
    // 10 - 5 (unfollow) + 3 (follow).
    expect(out.raw.sellerAffinity.s1).toBeCloseTo(8, 12);
  });

  it('the revocation clears a row persisted by an earlier batch', () => {
    const persisted = updateViewerAffinityWithSignals({
      profile: profileWith({ s1: 10 }),
      viewerId: VIEWER,
      events: [{ type: 'unfollow', sellerId: 's1' }],
      daysElapsed: 0,
      now: NOW,
    }).suppressions;
    expect(persisted).toHaveLength(1);

    const later = updateViewerAffinityWithSignals({
      profile: profileWith({ s1: 5 }),
      viewerId: VIEWER,
      events: [{ type: 'follow', sellerId: 's1' }],
      daysElapsed: 1,
      now: NOW,
    });
    expect(later.revocations).toHaveLength(1);
    expect(revokeSuppressions(persisted, later.revocations)).toEqual([]);
  });

  it('following and THEN unfollowing keeps the suppression — the unfollow is the newer fact', () => {
    const out = updateViewerAffinityWithSignals({
      profile: profileWith({ s1: 10 }),
      viewerId: VIEWER,
      events: [
        { type: 'follow', sellerId: 's1' },
        { type: 'unfollow', sellerId: 's1' },
      ],
      daysElapsed: 0,
      now: NOW,
    });
    expect(out.revocations).toEqual([]);
    expect(isSuppressed(out.suppressions, { viewerId: VIEWER, sellerId: 's1', now: NOW })).toBe(
      true
    );
  });

  it('a refollow of one seller does not free another', () => {
    const out = updateViewerAffinityWithSignals({
      profile: profileWith({ s1: 10, s2: 10 }),
      viewerId: VIEWER,
      events: [
        { type: 'unfollow', sellerId: 's1' },
        { type: 'unfollow', sellerId: 's2' },
        { type: 'follow', sellerId: 's1' },
      ],
      daysElapsed: 0,
      now: NOW,
    });
    expect(out.suppressions.map((r) => r.id)).toEqual(['s2']);
  });

  it('a follow cannot lift a not_interested block or a refund suppression', () => {
    const rows = applyNegativeSignals({
      viewerId: VIEWER,
      signals: [
        { type: 'not_interested', sellerId: 's1', videoId: 'v1' },
        { type: 'refund_requested', sellerId: 's1' },
      ],
      now: NOW,
    }).suppressions;
    const survivors = revokeSuppressions(rows, [revocationForRefollow('s1', VIEWER)]);
    expect(survivors).toEqual(rows);
    expect(isSuppressed(survivors, { viewerId: VIEWER, sellerId: 's1', now: NOW })).toBe(true);
  });

  it('a follow can NEVER lift a platform-wide dispute', () => {
    const disputed = applyNegativeSignals({
      viewerId: VIEWER,
      signals: [{ type: 'dispute_filed', sellerId: 's1' }],
      now: NOW,
    }).suppressions;

    // Every shape of revocation anyone could construct, including a malformed
    // one aimed straight at the platform scope.
    const survivors = revokeSuppressions(disputed, [
      revocationForRefollow('s1', VIEWER),
      { scope: 'viewer_seller', id: 's1', viewerId: VIEWER, reason: 'dispute_filed' },
      { scope: 'platform_seller', id: 's1', viewerId: VIEWER, reason: 'dispute_filed' },
    ]);
    expect(survivors).toEqual(disputed);
    expect(isSuppressed(survivors, { viewerId: OTHER_VIEWER, sellerId: 's1', now: NOW })).toBe(true);
  });

  it('a follow by one viewer does not free the seller for another viewer', () => {
    const mine = applyNegativeSignals({
      viewerId: VIEWER,
      signals: [{ type: 'unfollow', sellerId: 's1' }],
      now: NOW,
    }).suppressions;
    const theirs = applyNegativeSignals({
      viewerId: OTHER_VIEWER,
      signals: [{ type: 'unfollow', sellerId: 's1' }],
      now: NOW,
    }).suppressions;
    const survivors = revokeSuppressions([...mine, ...theirs], [
      revocationForRefollow('s1', VIEWER),
    ]);
    expect(survivors).toEqual(theirs);
  });

  it('revoking nothing changes nothing', () => {
    const rows = applyNegativeSignals({
      viewerId: VIEWER,
      signals: [{ type: 'unfollow', sellerId: 's1' }],
      now: NOW,
    }).suppressions;
    expect(revokeSuppressions(rows, [])).toEqual(rows);
  });
});

// ---------------------------------------------------------------------------
// Stacked negatives vs the water-filling normaliser
// ---------------------------------------------------------------------------

describe('6.5 — stacked negatives never break the normaliser', () => {
  it('applyAffinityDeltas floors at 0 rather than accumulating debt', () => {
    expect(applyAffinityDeltas({ s1: 3 }, [{ key: 's1', delta: -5 }])).toEqual({ s1: 0 });
    expect(
      applyAffinityDeltas({ s1: 3 }, [
        { key: 's1', delta: -5 },
        { key: 's1', delta: -4 },
      ])
    ).toEqual({ s1: 0 });
    // A delta for an unseen seller creates the key at 0, exactly as applyEvents does.
    expect(applyAffinityDeltas({ s1: 3 }, [{ key: 's2', delta: -4 }])).toEqual({ s1: 3, s2: 0 });
    expect(applyAffinityDeltas({ s1: 3 }, [{ key: '', delta: -4 }])).toEqual({ s1: 3 });
    expect(applyAffinityDeltas({ s1: 3 }, [{ key: 's1', delta: Number.NaN }])).toEqual({ s1: 3 });
  });

  it('every stacked negative lands on a seller already at 0 and the map still normalises', () => {
    const out = updateViewerAffinityWithSignals({
      profile: profileWith({ s1: 2, s2: 8, s3: 6 }),
      viewerId: VIEWER,
      events: [
        { type: 'not_interested', sellerId: 's1', videoId: 'v1', categoryId: 'beauty' },
        { type: 'unfollow', sellerId: 's1' },
        { type: 'refund_requested', sellerId: 's1', id: 'o1' },
        { type: 'refund_requested', sellerId: 's1', id: 'o2' },
        { type: 'dispute_filed', sellerId: 's1' },
        { type: 'fast_skip', sellerId: 's1', categoryId: 'beauty' },
      ],
      daysElapsed: 0,
      now: NOW,
    });
    expect(out.raw.sellerAffinity.s1).toBe(0);
    // Feed the raw map straight into the normaliser, as the cron does.
    expectValidDistribution(normalizeWithCap(out.raw.sellerAffinity));
    expect(sum(normalizeWithCap(out.raw.sellerAffinity))).toBeCloseTo(1, 12);
    // And the profile the ranker reads is already that distribution.
    expectValidDistribution(out.profile.sellerAffinity);
    expect(out.profile.sellerAffinity).toEqual(normalizeWithCap(out.raw.sellerAffinity));
  });

  it('driving EVERY seller to zero degrades to uniform, not to NaN', () => {
    const out = updateViewerAffinityWithSignals({
      profile: profileWith({ s1: 4, s2: 3, s3: 2 }),
      viewerId: VIEWER,
      events: [
        { type: 'unfollow', sellerId: 's1' },
        { type: 'unfollow', sellerId: 's2' },
        { type: 'unfollow', sellerId: 's3' },
      ],
      daysElapsed: 0,
      now: NOW,
    });
    expect(out.raw.sellerAffinity).toEqual({ s1: 0, s2: 0, s3: 0 });
    expectValidDistribution(out.profile.sellerAffinity);
    for (const v of Object.values(out.profile.sellerAffinity)) expect(v).toBeCloseTo(1 / 3, 12);
  });

  it('holds across a seeded sweep of stacked negatives', () => {
    const rng = mulberry32(20260819);
    const types = ['unfollow', 'refund_requested', 'dispute_filed', 'not_interested'] as const;
    for (let trial = 0; trial < 200; trial++) {
      const n = 1 + Math.floor(rng() * 6);
      const seller: AffinityMap = {};
      for (let i = 0; i < n; i++) seller[`s${i}`] = rng() < 0.3 ? 0 : rng() * 20;

      const events: ViewerEvent[] = [];
      const eventCount = Math.floor(rng() * 12);
      for (let i = 0; i < eventCount; i++) {
        events.push({
          type: types[Math.floor(rng() * types.length)],
          sellerId: `s${Math.floor(rng() * n)}`,
          videoId: `v${i}`,
          categoryId: 'beauty',
          id: `e${i}`,
        });
      }

      const out = updateViewerAffinityWithSignals({
        profile: profileWith(seller),
        viewerId: VIEWER,
        events,
        daysElapsed: rng() * 60,
        now: NOW,
      });

      for (const v of Object.values(out.raw.sellerAffinity)) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }
      expectValidDistribution(normalizeWithCap(out.raw.sellerAffinity));
      expectValidDistribution(out.profile.sellerAffinity);
      // A trial with no events touches no category, and an empty map stays
      // empty — that is normalizeWithCap's documented degenerate case, not a
      // distribution to check.
      if (Object.keys(out.profile.categoryAffinity).length > 0) {
        expectValidDistribution(out.profile.categoryAffinity);
      }
    }
  });

  it('the cap still binds after a negative pass', () => {
    const out = updateViewerAffinityWithSignals({
      profile: profileWith({ s1: 900, s2: 40, s3: 30, s4: 20, s5: 10 }),
      viewerId: VIEWER,
      events: [{ type: 'unfollow', sellerId: 's2' }],
      daysElapsed: 0,
      now: NOW,
    });
    expectValidDistribution(out.profile.sellerAffinity);
    expect(out.profile.sellerAffinity.s1).toBeCloseTo(AFFINITY_CAP, 12);
  });
});

// ---------------------------------------------------------------------------
// The composed pass
// ---------------------------------------------------------------------------

describe('updateViewerAffinityWithSignals', () => {
  const mixed: ViewerEvent[] = [
    { type: 'purchase', categoryId: 'apparel', sellerId: 's1', hashtags: ['denim'] },
    { type: 'not_interested', categoryId: 'beauty', sellerId: 's2', videoId: 'v9' },
    { type: 'unfollow', sellerId: 's3' },
    { type: 'refund_requested', sellerId: 's4' },
    { type: 'dispute_filed', sellerId: 's5' },
  ];

  it('runs both passes over one stream and leaves all three maps legal', () => {
    const out = updateViewerAffinityWithSignals({
      profile: profileWith({ s3: 10, s4: 10 }),
      viewerId: VIEWER,
      events: mixed,
      daysElapsed: 0,
      now: NOW,
    });
    expectValidDistribution(out.profile.categoryAffinity);
    expectValidDistribution(out.profile.sellerAffinity);
    expectValidDistribution(out.profile.hashtagAffinity);
  });

  it('6.5-only types are invisible to the 2.7 pass', () => {
    const out = updateViewerAffinityWithSignals({
      profile: PROFILE,
      viewerId: VIEWER,
      events: [
        { type: 'unfollow', sellerId: 's1', categoryId: 'apparel', hashtags: ['denim'] },
        { type: 'dispute_filed', sellerId: 's2', categoryId: 'apparel' },
      ],
      daysElapsed: 0,
      now: NOW,
    });
    // No category or hashtag mass moved: 6.5 seller weights are seller-only.
    expect(out.raw.categoryAffinity).toEqual({});
    expect(out.raw.hashtagAffinity).toEqual({});
    expect(out.raw.sellerAffinity).toEqual({ s1: 0 });
  });

  it('agrees with running the two passes separately', () => {
    const profile = profileWith({ s3: 10, s4: 10 });
    const composed = updateViewerAffinityWithSignals({
      profile,
      viewerId: VIEWER,
      events: mixed,
      daysElapsed: 3,
      now: NOW,
      neighbours: indexOf(neighbourIds(50)),
    });

    const twoSeven = updateViewerAffinity(
      profile,
      mixed.filter((e) => e.type === 'purchase' || e.type === 'not_interested') as AffinityEvent[],
      3,
      NOW
    );
    const sixFive = applyNegativeSignals({
      viewerId: VIEWER,
      signals: [
        { type: 'not_interested', categoryId: 'beauty', sellerId: 's2', videoId: 'v9' },
        { type: 'unfollow', sellerId: 's3' },
        { type: 'refund_requested', sellerId: 's4' },
        { type: 'dispute_filed', sellerId: 's5' },
      ],
      now: NOW,
      neighbours: indexOf(neighbourIds(50)),
    });

    expect(composed.raw.categoryAffinity).toEqual(twoSeven.raw.categoryAffinity);
    expect(composed.raw.hashtagAffinity).toEqual(twoSeven.raw.hashtagAffinity);
    expect(composed.raw.sellerAffinity).toEqual(
      applyAffinityDeltas(twoSeven.raw.sellerAffinity, sixFive.sellerDeltas)
    );
    expect(composed.suppressions).toEqual(sixFive.suppressions);
    expect(composed.neighbours).toEqual(sixFive.neighbours);
  });

  it('carries the 2.7 seller blocks through, as a subset of the suppressions', () => {
    const out = updateViewerAffinityWithSignals({
      profile: PROFILE,
      viewerId: VIEWER,
      events: mixed,
      daysElapsed: 0,
      now: NOW,
    });
    expect(out.sellerBlocks).toEqual([
      { sellerId: 's2', blockedUntil: new Date('2026-01-31T00:00:00.000Z') },
    ]);
    for (const block of out.sellerBlocks) {
      expect(out.suppressions).toContainEqual(suppressionFromSellerBlock(block, VIEWER));
    }
  });

  it('carries non-affinity profile fields through untouched', () => {
    const out = updateViewerAffinityWithSignals({
      profile: PROFILE,
      viewerId: VIEWER,
      events: mixed,
      daysElapsed: 5,
      now: NOW,
    });
    expect(out.profile.priceBand).toEqual(PROFILE.priceBand);
    expect(out.profile.coldStartComplete).toBe(true);
  });

  it('an empty stream is a clean no-op', () => {
    const out = updateViewerAffinityWithSignals({
      profile: profileWith({ s1: 4, s2: 6 }),
      viewerId: VIEWER,
      events: [],
      daysElapsed: 0,
      now: NOW,
    });
    expect(out.raw.sellerAffinity).toEqual({ s1: 4, s2: 6 });
    expect(out.suppressions).toEqual([]);
    expect(out.revocations).toEqual([]);
    expect(out.neighbours.degraded).toBe(false);
  });

  it('ignores malformed events instead of poisoning the maps', () => {
    const out = updateViewerAffinityWithSignals({
      profile: profileWith({ s1: 4 }),
      viewerId: VIEWER,
      events: [
        { type: 'teleported' as AffinityEventType },
        { type: 'unfollow', sellerId: '' },
        { type: 'unfollow', sellerId: null },
        { type: 'dispute_filed' },
      ],
      daysElapsed: 0,
      now: NOW,
    });
    expect(out.raw.sellerAffinity).toEqual({ s1: 4 });
    expect(out.suppressions).toEqual([]);
  });

  it('is deterministic: same inputs, same output', () => {
    const input = {
      profile: profileWith({ s3: 10, s4: 10 }),
      viewerId: VIEWER,
      events: mixed,
      daysElapsed: 7,
      now: NOW,
      neighbours: indexOf(neighbourIds(50)),
    };
    expect(updateViewerAffinityWithSignals(input)).toEqual(
      updateViewerAffinityWithSignals(input)
    );
  });

  it('does not mutate the profile it was given', () => {
    const seller = { s1: 10 };
    const profile = profileWith(seller);
    updateViewerAffinityWithSignals({
      profile,
      viewerId: VIEWER,
      events: [{ type: 'unfollow', sellerId: 's1' }],
      daysElapsed: 0,
      now: NOW,
    });
    expect(seller).toEqual({ s1: 10 });
    expect(profile.sellerAffinity).toEqual({ s1: 10 });
  });
});
