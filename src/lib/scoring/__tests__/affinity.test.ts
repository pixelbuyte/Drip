import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  AFFINITY_CAP,
  AFFINITY_DAILY_RETENTION,
  EVENT_WEIGHTS,
  SELLER_BLOCK_DAYS,
  applyEvents,
  blockSellerFrom,
  daysElapsedBetween,
  decayAffinity,
  isSellerBlocked,
  normalizeWithCap,
  updateViewerAffinity,
  watchEventType,
  type AffinityEvent,
  type AffinityEventType,
  type AffinityMap,
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
