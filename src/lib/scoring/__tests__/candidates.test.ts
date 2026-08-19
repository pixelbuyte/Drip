import { describe, expect, it } from 'vitest';

import {
  AFFINITY_PRICE_TOLERANCE,
  COLD_START_LANE_SHARES,
  DEFAULT_TARGET_SIZE,
  HARD_FILTERS,
  LANE_PRIORITY,
  LANE_SHARES,
  SHIPS_WORLDWIDE,
  THIN_CATEGORY_THRESHOLD,
  affinityLane,
  allocateQuotas,
  budgetOwed,
  budgetRemaining,
  filterBreakdown,
  firstFailingFilter,
  freshLane,
  generateCandidates,
  hardFilters,
  hasPurchasableProduct,
  higherPriorityLane,
  isLive,
  lanePriorityRank,
  notExcluded,
  notMarkedNotInterested,
  notRecentlyPurchased,
  priceWindow,
  revenuePerImpression,
  sellerIsPayable,
  shipsToViewer,
  socialLane,
  tailLane,
  thinCategoryMultiplier,
  topAffinityCategories,
  trendingLane,
  type PoolVideo,
  type ViewerContext,
} from '../candidates';
import { mulberry32 } from '../rng';
import {
  IMPRESSION_BUDGET_TOTAL,
  LANES,
  type CandidateLane,
  type CandidateStats,
  type ImpressionBudget,
  type ViewerProfile,
} from '../types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-06-15T12:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const agoHours = (h: number) => new Date(NOW.getTime() - h * HOUR);
const agoDays = (d: number) => new Date(NOW.getTime() - d * DAY);

function stats(over: Partial<CandidateStats> = {}): CandidateStats {
  return {
    impressions24h: 1000,
    purchases24h: 10,
    addToCarts24h: 30,
    productTaps24h: 100,
    completions24h: 400,
    skipsUnder2s24h: 200,
    shares24h: 20,
    saves24h: 40,
    avgLoopCount: 1.2,
    reportsAll: 0,
    notInterestedAll: 0,
    impressionsAll: 5000,
    impressions1h: 50,
    purchases1h: 1,
    addToCarts1h: 2,
    productTaps1h: 5,
    ...over,
  };
}

function video(over: Partial<PoolVideo> & { videoId: string }): PoolVideo {
  return {
    sellerId: `s-${over.videoId}`,
    categoryId: 'cat-a',
    publishedAt: agoDays(5),
    minPriceCents: 5000,
    hashtags: [],
    stats: stats(),
    trust: { fulfillmentScore: 0.9, disputeRate: 0.01, ratingAvg: 4.5, tier: 'trusted' },
    budget: null,
    status: 'live',
    seller: {
      sellerId: over.sellerId ?? `s-${over.videoId}`,
      suspended: false,
      chargesEnabled: true,
      shipsToCountries: [SHIPS_WORLDWIDE],
    },
    products: [{ productId: `p-${over.videoId}`, status: 'active', inventoryCount: 5 }],
    ...over,
  };
}

function profile(over: Partial<ViewerProfile> = {}): ViewerProfile {
  return {
    categoryAffinity: { 'cat-a': 0.5, 'cat-b': 0.3, 'cat-c': 0.15, 'cat-d': 0.05 },
    sellerAffinity: {},
    hashtagAffinity: {},
    priceBand: null,
    coldStartComplete: true,
    ...over,
  };
}

function viewer(over: Partial<ViewerContext> = {}): ViewerContext {
  return {
    viewerId: 'viewer-1',
    profile: profile(),
    countryCode: 'US',
    ...over,
  };
}

function openBudget(over: Partial<ImpressionBudget> = {}): ImpressionBudget {
  return {
    impressionsDelivered: 12,
    budgetTotal: IMPRESSION_BUDGET_TOTAL,
    windowStart: agoHours(6),
    satisfied: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Hard filters, each in isolation
// ---------------------------------------------------------------------------

describe('hard filters (spec 2.1) — each in isolation', () => {
  const ctx = viewer();

  it('status_live keeps only live videos', () => {
    expect(isLive(video({ videoId: 'v1', status: 'live' }), ctx, NOW)).toBe(true);
    for (const s of ['processing', 'paused', 'removed'] as const) {
      expect(isLive(video({ videoId: 'v1', status: s }), ctx, NOW)).toBe(false);
    }
  });

  it('purchasable_product needs an ACTIVE product with inventory > 0', () => {
    const mk = (products: PoolVideo['products']) => video({ videoId: 'v1', products });
    expect(hasPurchasableProduct(mk([{ productId: 'p', status: 'active', inventoryCount: 1 }]), ctx, NOW)).toBe(true);
    expect(hasPurchasableProduct(mk([{ productId: 'p', status: 'active', inventoryCount: 0 }]), ctx, NOW)).toBe(false);
    expect(hasPurchasableProduct(mk([{ productId: 'p', status: 'out_of_stock', inventoryCount: 9 }]), ctx, NOW)).toBe(false);
    expect(hasPurchasableProduct(mk([{ productId: 'p', status: 'archived', inventoryCount: 9 }]), ctx, NOW)).toBe(false);
    expect(hasPurchasableProduct(mk([]), ctx, NOW)).toBe(false);
    // "at least one" — one good product among dead ones is enough.
    expect(
      hasPurchasableProduct(
        mk([
          { productId: 'a', status: 'archived', inventoryCount: 9 },
          { productId: 'b', status: 'active', inventoryCount: 2 },
        ]),
        ctx,
        NOW
      )
    ).toBe(true);
  });

  it('seller_payable needs not-suspended AND charges_enabled', () => {
    const mk = (suspended: boolean, chargesEnabled: boolean) =>
      video({
        videoId: 'v1',
        seller: { sellerId: 's', suspended, chargesEnabled, shipsToCountries: [SHIPS_WORLDWIDE] },
      });
    expect(sellerIsPayable(mk(false, true), ctx, NOW)).toBe(true);
    expect(sellerIsPayable(mk(true, true), ctx, NOW)).toBe(false);
    expect(sellerIsPayable(mk(false, false), ctx, NOW)).toBe(false);
    expect(sellerIsPayable(mk(true, false), ctx, NOW)).toBe(false);
  });

  it('not_excluded drops exclude_ids', () => {
    const v = video({ videoId: 'v1' });
    expect(notExcluded(v, viewer({ excludeIds: new Set(['other']) }), NOW)).toBe(true);
    expect(notExcluded(v, viewer({ excludeIds: new Set(['v1']) }), NOW)).toBe(false);
    expect(notExcluded(v, viewer(), NOW)).toBe(true); // absent set == no exclusions
  });

  it('not_interested drops both video-level and seller-level blocks', () => {
    const v = video({ videoId: 'v1', sellerId: 'seller-x' });
    expect(notMarkedNotInterested(v, viewer(), NOW)).toBe(true);
    expect(notMarkedNotInterested(v, viewer({ notInterestedVideoIds: new Set(['v1']) }), NOW)).toBe(false);
    expect(notMarkedNotInterested(v, viewer({ notInterestedSellerIds: new Set(['seller-x']) }), NOW)).toBe(false);
    // A block on a DIFFERENT seller must not leak across.
    expect(notMarkedNotInterested(v, viewer({ notInterestedSellerIds: new Set(['seller-y']) }), NOW)).toBe(true);
  });

  it('ships_to_viewer honours the country list, the worldwide sentinel, and fails closed', () => {
    const mk = (shipsToCountries: string[]) =>
      video({
        videoId: 'v1',
        seller: { sellerId: 's', suspended: false, chargesEnabled: true, shipsToCountries },
      });
    expect(shipsToViewer(mk(['US', 'CA']), viewer({ countryCode: 'US' }), NOW)).toBe(true);
    expect(shipsToViewer(mk(['CA', 'GB']), viewer({ countryCode: 'US' }), NOW)).toBe(false);
    expect(shipsToViewer(mk([SHIPS_WORLDWIDE]), viewer({ countryCode: 'JP' }), NOW)).toBe(true);
    expect(shipsToViewer(mk(['us']), viewer({ countryCode: 'US' }), NOW)).toBe(true); // case-insensitive
    // Fails closed: no configured countries, or no known viewer country.
    expect(shipsToViewer(mk([]), viewer({ countryCode: 'US' }), NOW)).toBe(false);
    expect(shipsToViewer(mk(['US']), viewer({ countryCode: '' }), NOW)).toBe(false);
  });

  it('not_recently_purchased suppresses for 7d, unless items remain unpurchased', () => {
    const v = video({ videoId: 'v1' });
    const withPurchase = (daysAgo: number, hasUnpurchasedItems: boolean) =>
      viewer({
        purchasesByVideoId: new Map([
          ['v1', { purchasedAt: agoDays(daysAgo), hasUnpurchasedItems }],
        ]),
      });

    expect(notRecentlyPurchased(v, withPurchase(2, false), NOW)).toBe(false);
    expect(notRecentlyPurchased(v, withPurchase(8, false), NOW)).toBe(true);
    // The escape hatch: bought one of three products, the video is a cross-sell.
    expect(notRecentlyPurchased(v, withPurchase(2, true), NOW)).toBe(true);
    // No purchase at all.
    expect(notRecentlyPurchased(v, viewer(), NOW)).toBe(true);
  });

  it('not_recently_purchased boundary is exactly 7 days', () => {
    const v = video({ videoId: 'v1' });
    const at = (ms: number) =>
      viewer({
        purchasesByVideoId: new Map([
          ['v1', { purchasedAt: new Date(NOW.getTime() - ms), hasUnpurchasedItems: false }],
        ]),
      });
    expect(notRecentlyPurchased(v, at(7 * DAY - 1), NOW)).toBe(false);
    expect(notRecentlyPurchased(v, at(7 * DAY), NOW)).toBe(true);
  });

  it('hardFilters composes every predicate and dedupes by videoId', () => {
    const pool = [
      video({ videoId: 'ok' }),
      video({ videoId: 'dead', status: 'removed' }),
      video({ videoId: 'nostock', products: [{ productId: 'p', status: 'active', inventoryCount: 0 }] }),
      video({
        videoId: 'nokyc',
        seller: { sellerId: 's', suspended: false, chargesEnabled: false, shipsToCountries: ['US'] },
      }),
      video({ videoId: 'ok' }), // duplicate row from the union
    ];
    const kept = hardFilters(pool, viewer(), NOW);
    expect(kept.map((v) => v.videoId)).toEqual(['ok']);
  });

  it('firstFailingFilter names the rule that rejected a video', () => {
    expect(firstFailingFilter(video({ videoId: 'v', status: 'paused' }), viewer(), NOW)).toBe('status_live');
    expect(
      firstFailingFilter(
        video({ videoId: 'v', products: [{ productId: 'p', status: 'active', inventoryCount: 0 }] }),
        viewer(),
        NOW
      )
    ).toBe('purchasable_product');
    expect(firstFailingFilter(video({ videoId: 'v' }), viewer(), NOW)).toBeNull();
  });

  it('filterBreakdown attributes every pool row exactly once', () => {
    const pool = [
      video({ videoId: 'a' }),
      video({ videoId: 'b', status: 'processing' }),
      video({ videoId: 'c', status: 'removed' }),
      video({ videoId: 'd', products: [] }),
    ];
    const b = filterBreakdown(pool, viewer(), NOW);
    expect(b.kept).toBe(1);
    expect(b.status_live).toBe(2);
    expect(b.purchasable_product).toBe(1);
    const total = Object.values(b).reduce((a, n) => a + n, 0);
    expect(total).toBe(pool.length);
  });

  it('HARD_FILTERS carries every filter id exactly once', () => {
    const ids = HARD_FILTERS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      'status_live',
      'purchasable_product',
      'seller_payable',
      'not_excluded',
      'not_interested',
      'ships_to_viewer',
      'not_recently_purchased',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Spec 2.5
// ---------------------------------------------------------------------------

describe('thinCategoryMultiplier (spec 2.5)', () => {
  it('boundaries at 49 / 50', () => {
    expect(thinCategoryMultiplier(49)).toBe(1.2);
    expect(thinCategoryMultiplier(50)).toBe(1);
    expect(thinCategoryMultiplier(THIN_CATEGORY_THRESHOLD - 1)).toBe(1.2);
    expect(thinCategoryMultiplier(THIN_CATEGORY_THRESHOLD)).toBe(1);
  });

  it('0 and unknown counts are thin — that is where the boost is most needed', () => {
    expect(thinCategoryMultiplier(0)).toBe(1.2);
    expect(thinCategoryMultiplier(null)).toBe(1.2);
    expect(thinCategoryMultiplier(undefined)).toBe(1.2);
    expect(thinCategoryMultiplier(Number.NaN)).toBe(1.2);
  });

  it('large categories get no boost', () => {
    expect(thinCategoryMultiplier(51)).toBe(1);
    expect(thinCategoryMultiplier(10_000)).toBe(1);
  });
});

describe('budgetOwed (spec 2.5)', () => {
  it('is owed inside the window with impressions remaining', () => {
    expect(budgetOwed({ budget: openBudget() }, NOW)).toBe(true);
    expect(budgetRemaining({ budget: openBudget() }, NOW)).toBe(IMPRESSION_BUDGET_TOTAL - 12);
  });

  it('is not owed with no budget, once satisfied, or once fully delivered', () => {
    expect(budgetOwed({ budget: null }, NOW)).toBe(false);
    expect(budgetOwed({}, NOW)).toBe(false);
    expect(budgetOwed({ budget: openBudget({ satisfied: true }) }, NOW)).toBe(false);
    expect(budgetOwed({ budget: openBudget({ impressionsDelivered: 500 }) }, NOW)).toBe(false);
    expect(budgetOwed({ budget: openBudget({ impressionsDelivered: 501 }) }, NOW)).toBe(false);
  });

  it('closes exactly 48h after the window start', () => {
    const at = (h: number) => ({ budget: openBudget({ windowStart: agoHours(h) }) });
    expect(budgetOwed(at(47.9), NOW)).toBe(true);
    expect(budgetOwed(at(48), NOW)).toBe(true);
    expect(budgetOwed(at(48.1), NOW)).toBe(false);
    expect(budgetRemaining(at(48.1), NOW)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Lane priority
// ---------------------------------------------------------------------------

describe('lane priority', () => {
  it('is a total order over all five lanes', () => {
    expect([...LANE_PRIORITY].sort()).toEqual([...LANES].sort());
  });

  it('fresh outranks tail — budget delivery must not be lost to lane reassignment', () => {
    expect(lanePriorityRank('fresh')).toBeLessThan(lanePriorityRank('tail'));
    expect(higherPriorityLane('tail', 'fresh')).toBe('fresh');
    expect(higherPriorityLane('fresh', 'tail')).toBe('fresh');
  });

  it('fresh outranks every lane, tail loses to every lane', () => {
    for (const lane of LANES) {
      expect(lanePriorityRank('fresh')).toBeLessThanOrEqual(lanePriorityRank(lane));
      expect(lanePriorityRank('tail')).toBeGreaterThanOrEqual(lanePriorityRank(lane));
    }
  });

  it('orders by scarcity: fresh > social > affinity > trending > tail', () => {
    expect([...LANE_PRIORITY]).toEqual(['fresh', 'social', 'affinity', 'trending', 'tail']);
  });
});

// ---------------------------------------------------------------------------
// Lane sources
// ---------------------------------------------------------------------------

describe('affinity lane', () => {
  it('takes the top 3 affinity categories only', () => {
    expect(topAffinityCategories(profile())).toEqual(['cat-a', 'cat-b', 'cat-c']);
  });

  it('breaks affinity ties on categoryId so ordering is deterministic', () => {
    const p = profile({ categoryAffinity: { z: 0.5, a: 0.5, m: 0.5, b: 0.1 } });
    expect(topAffinityCategories(p)).toEqual(['a', 'm', 'z']);
  });

  it('ignores zero and negative affinities', () => {
    const p = profile({ categoryAffinity: { a: 0.5, b: 0, c: -1 } });
    expect(topAffinityCategories(p)).toEqual(['a']);
  });

  it('restricts to the top-3 categories, the 30d window, and the price band', () => {
    const ctx = viewer({ profile: profile({ priceBand: { p25: 2000, p50: 5000, p75: 8000 } }) });
    const pool = [
      video({ videoId: 'in', categoryId: 'cat-a', minPriceCents: 5000, publishedAt: agoDays(3) }),
      video({ videoId: 'wrong-cat', categoryId: 'cat-d', minPriceCents: 5000 }),
      video({ videoId: 'no-cat', categoryId: null, minPriceCents: 5000 }),
      video({ videoId: 'too-old', categoryId: 'cat-a', minPriceCents: 5000, publishedAt: agoDays(31) }),
      video({ videoId: 'too-cheap', categoryId: 'cat-a', minPriceCents: 1000 }),
      video({ videoId: 'too-dear', categoryId: 'cat-a', minPriceCents: 20_000 }),
      // 2000 * 0.6 = 1200 and 8000 * 1.4 = 11200 — both edges are inclusive.
      video({ videoId: 'edge-lo', categoryId: 'cat-b', minPriceCents: 1200 }),
      video({ videoId: 'edge-hi', categoryId: 'cat-b', minPriceCents: 11_200 }),
    ];
    const ids = affinityLane(pool, ctx, NOW).map((v) => v.videoId);
    expect(new Set(ids)).toEqual(new Set(['in', 'edge-lo', 'edge-hi']));
  });

  it('applies no price restriction when the viewer has no band yet', () => {
    expect(priceWindow(null)).toBeNull();
    const pool = [video({ videoId: 'cheap', minPriceCents: 1 }), video({ videoId: 'dear', minPriceCents: 9_999_999 })];
    expect(affinityLane(pool, viewer(), NOW)).toHaveLength(2);
  });

  it('widens the band edges by 40%, not the median', () => {
    expect(priceWindow({ p25: 2000, p50: 5000, p75: 8000 }, AFFINITY_PRICE_TOLERANCE)).toEqual({
      minCents: 1200,
      maxCents: 11_200,
    });
  });

  it('orders by revenue-per-impression, descending', () => {
    const pool = [
      video({ videoId: 'low', stats: stats({ impressions24h: 1000, purchases24h: 1 }), minPriceCents: 1000 }),
      video({ videoId: 'high', stats: stats({ impressions24h: 1000, purchases24h: 1 }), minPriceCents: 90_000 }),
      video({ videoId: 'mid', revenueCents24h: 20_000, stats: stats({ impressions24h: 1000 }) }),
    ];
    expect(affinityLane(pool, viewer(), NOW).map((v) => v.videoId)).toEqual(['high', 'mid', 'low']);
  });

  it('revenuePerImpression prefers real revenue and survives zero impressions', () => {
    expect(revenuePerImpression(video({ videoId: 'a', revenueCents24h: 5000, stats: stats({ impressions24h: 100 }) }))).toBe(50);
    expect(revenuePerImpression(video({ videoId: 'a', stats: stats({ impressions24h: 0, purchases24h: 3 }) }))).toBe(0);
  });

  it('is empty when the viewer has no category affinity at all', () => {
    const ctx = viewer({ profile: profile({ categoryAffinity: {} }) });
    expect(affinityLane([video({ videoId: 'a' })], ctx, NOW)).toEqual([]);
  });
});

describe('trending lane', () => {
  it('orders by velocity score and drops zero-velocity videos', () => {
    const pool = [
      video({ videoId: 'slow', stats: stats({ purchases1h: 0, addToCarts1h: 0, productTaps1h: 1, impressions1h: 900 }) }),
      video({ videoId: 'hot', stats: stats({ purchases1h: 20, addToCarts1h: 40, productTaps1h: 200, impressions1h: 900 }) }),
      video({ videoId: 'dead', stats: stats({ purchases1h: 0, addToCarts1h: 0, productTaps1h: 0, impressions1h: 900 }) }),
    ];
    expect(trendingLane(pool).map((v) => v.videoId)).toEqual(['hot', 'slow']);
  });
});

describe('fresh lane', () => {
  it('takes only the last 48h with fewer than 500 lifetime impressions', () => {
    const pool = [
      video({ videoId: 'new', publishedAt: agoHours(6), stats: stats({ impressionsAll: 30 }) }),
      video({ videoId: 'old', publishedAt: agoHours(60), stats: stats({ impressionsAll: 30 }) }),
      video({ videoId: 'popular', publishedAt: agoHours(6), stats: stats({ impressionsAll: 500 }) }),
      video({ videoId: 'edge', publishedAt: agoHours(6), stats: stats({ impressionsAll: 499 }) }),
    ];
    expect(new Set(freshLane(pool, NOW).map((v) => v.videoId))).toEqual(new Set(['new', 'edge']));
  });

  it('delivers the least-served video first', () => {
    const pool = [
      video({ videoId: 'b', publishedAt: agoHours(2), stats: stats({ impressionsAll: 200 }) }),
      video({ videoId: 'a', publishedAt: agoHours(2), stats: stats({ impressionsAll: 10 }) }),
      video({ videoId: 'c', publishedAt: agoHours(2), stats: stats({ impressionsAll: 400 }) }),
    ];
    expect(freshLane(pool, NOW).map((v) => v.videoId)).toEqual(['a', 'b', 'c']);
  });
});

describe('social lane', () => {
  it('takes followed OR previously-purchased-from sellers, last 14 days', () => {
    const ctx = viewer({
      followedSellerIds: new Set(['s-follow']),
      purchasedSellerIds: new Set(['s-bought']),
    });
    const pool = [
      video({ videoId: 'f', sellerId: 's-follow', publishedAt: agoDays(3) }),
      video({ videoId: 'b', sellerId: 's-bought', publishedAt: agoDays(3) }),
      video({ videoId: 'stranger', sellerId: 's-other', publishedAt: agoDays(3) }),
      video({ videoId: 'stale', sellerId: 's-follow', publishedAt: agoDays(15) }),
    ];
    expect(new Set(socialLane(pool, ctx, NOW).map((v) => v.videoId))).toEqual(new Set(['f', 'b']));
  });

  it('is empty with no follows and no purchase history', () => {
    expect(socialLane([video({ videoId: 'a' })], viewer(), NOW)).toEqual([]);
  });
});

describe('tail lane', () => {
  const pool = Array.from({ length: 40 }, (_, i) =>
    video({ videoId: `t${String(i).padStart(2, '0')}`, publishedAt: agoDays(30) })
  );

  it('windows to the last 90 days', () => {
    const withOld = [...pool, video({ videoId: 'ancient', publishedAt: agoDays(91) })];
    const ids = tailLane(withOld, NOW, mulberry32(1)).map((v) => v.videoId);
    expect(ids).toHaveLength(40);
    expect(ids).not.toContain('ancient');
  });

  it('is a permutation of the eligible set, not a truncation', () => {
    const ids = tailLane(pool, NOW, mulberry32(7)).map((v) => v.videoId);
    expect([...ids].sort()).toEqual(pool.map((v) => v.videoId).sort());
  });

  it('is deterministic per seed and actually shuffles', () => {
    const a = tailLane(pool, NOW, mulberry32(42)).map((v) => v.videoId);
    const b = tailLane(pool, NOW, mulberry32(42)).map((v) => v.videoId);
    const c = tailLane(pool, NOW, mulberry32(43)).map((v) => v.videoId);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a).not.toEqual(pool.map((v) => v.videoId));
  });

  it('does not depend on the order the caller built the pool in', () => {
    const reversed = [...pool].reverse();
    expect(tailLane(pool, NOW, mulberry32(9)).map((v) => v.videoId)).toEqual(
      tailLane(reversed, NOW, mulberry32(9)).map((v) => v.videoId)
    );
  });
});

// ---------------------------------------------------------------------------
// Quota allocation
// ---------------------------------------------------------------------------

describe('allocateQuotas', () => {
  it('sums to exactly the target', () => {
    for (const total of [1, 7, 20, 97, 500, 501]) {
      const q = allocateQuotas(LANE_SHARES, total);
      expect(LANES.reduce((n, l) => n + q[l], 0)).toBe(total);
    }
  });

  it('reproduces the spec shares at 500', () => {
    expect(allocateQuotas(LANE_SHARES, 500)).toEqual({
      affinity: 175,
      trending: 125,
      fresh: 100,
      social: 50,
      tail: 50,
    });
  });

  it('reproduces the cold-start shares at 500, with affinity and social at zero', () => {
    expect(allocateQuotas(COLD_START_LANE_SHARES, 500)).toEqual({
      affinity: 0,
      trending: 200,
      fresh: 150,
      social: 0,
      tail: 150,
    });
  });

  it('never hands a remainder unit to a zero-share lane', () => {
    for (const total of [1, 2, 3, 4, 7, 11, 13, 99]) {
      const q = allocateQuotas(COLD_START_LANE_SHARES, total);
      expect(q.affinity).toBe(0);
      expect(q.social).toBe(0);
      expect(LANES.reduce((n, l) => n + q[l], 0)).toBe(total);
    }
  });

  it('degenerate inputs produce zeroes rather than NaN', () => {
    const zero = { affinity: 0, trending: 0, fresh: 0, social: 0, tail: 0 };
    expect(allocateQuotas(LANE_SHARES, 0)).toEqual(zero);
    expect(allocateQuotas(LANE_SHARES, -5)).toEqual(zero);
    expect(allocateQuotas(zero, 500)).toEqual(zero);
  });
});

// ---------------------------------------------------------------------------
// generateCandidates
// ---------------------------------------------------------------------------

/** A pool broad enough that every lane can fill its quota. */
function largePool(): PoolVideo[] {
  const out: PoolVideo[] = [];
  // Affinity-shaped: top categories, mid price, inside 30d, real revenue.
  for (let i = 0; i < 300; i++) {
    out.push(
      video({
        videoId: `aff-${String(i).padStart(3, '0')}`,
        sellerId: `sa-${i % 40}`,
        categoryId: ['cat-a', 'cat-b', 'cat-c'][i % 3],
        publishedAt: agoDays(3 + (i % 20)),
        minPriceCents: 4000 + i,
        revenueCents24h: 100_000 - i * 100,
        stats: stats({ impressionsAll: 20_000, purchases1h: 0, addToCarts1h: 0, productTaps1h: 0 }),
      })
    );
  }
  // Trending-shaped: no affinity category, real 1h velocity.
  for (let i = 0; i < 300; i++) {
    out.push(
      video({
        videoId: `trd-${String(i).padStart(3, '0')}`,
        sellerId: `st-${i % 40}`,
        categoryId: 'cat-z',
        publishedAt: agoDays(10),
        stats: stats({
          impressionsAll: 50_000,
          impressions1h: 500,
          purchases1h: 40 - (i % 40),
          addToCarts1h: 10,
          productTaps1h: 30,
        }),
      })
    );
  }
  // Fresh-shaped: last 48h, tiny impression counts, no velocity, off-affinity.
  for (let i = 0; i < 300; i++) {
    out.push(
      video({
        videoId: `frs-${String(i).padStart(3, '0')}`,
        sellerId: `sf-${i % 40}`,
        categoryId: 'cat-z',
        publishedAt: agoHours(1 + (i % 40)),
        stats: stats({ impressionsAll: i % 300, purchases1h: 0, addToCarts1h: 0, productTaps1h: 0 }),
      })
    );
  }
  // Social-shaped: followed sellers, inside 14d, off-affinity, no velocity.
  for (let i = 0; i < 300; i++) {
    out.push(
      video({
        videoId: `soc-${String(i).padStart(3, '0')}`,
        sellerId: `sfollow-${i % 10}`,
        categoryId: 'cat-z',
        publishedAt: agoDays(5),
        stats: stats({ impressionsAll: 30_000, purchases1h: 0, addToCarts1h: 0, productTaps1h: 0 }),
      })
    );
  }
  // Tail-only: inside 90d, nothing else going for them.
  for (let i = 0; i < 400; i++) {
    out.push(
      video({
        videoId: `tal-${String(i).padStart(3, '0')}`,
        sellerId: `sl-${i % 60}`,
        categoryId: 'cat-z',
        publishedAt: agoDays(60),
        stats: stats({ impressionsAll: 9_000, purchases1h: 0, addToCarts1h: 0, productTaps1h: 0 }),
      })
    );
  }
  return out;
}

const followedCtx = viewer({
  followedSellerIds: new Set(Array.from({ length: 10 }, (_, i) => `sfollow-${i}`)),
});

describe('generateCandidates — lane shares', () => {
  it('honours the spec shares on a large pool', () => {
    const r = generateCandidates(largePool(), followedCtx, { rng: mulberry32(1), now: NOW });
    expect(r.coldStart).toBe(false);
    expect(r.shares).toEqual(LANE_SHARES);
    expect(r.candidates).toHaveLength(DEFAULT_TARGET_SIZE);
    expect(r.byLane.affinity).toHaveLength(175);
    expect(r.byLane.trending).toHaveLength(125);
    expect(r.byLane.fresh).toHaveLength(100);
    expect(r.byLane.social).toHaveLength(50);
    expect(r.byLane.tail).toHaveLength(50);
    for (const lane of LANES) {
      const share = r.byLane[lane].length / r.candidates.length;
      expect(Math.abs(share - LANE_SHARES[lane])).toBeLessThan(0.02);
    }
  });

  it('stamps every candidate with the lane that produced it', () => {
    const r = generateCandidates(largePool(), followedCtx, { rng: mulberry32(1), now: NOW });
    for (const lane of LANES) {
      for (const c of r.byLane[lane]) expect(c.lane).toBe(lane);
    }
    expect(r.candidates.map((c) => c.lane)).toEqual(
      LANE_PRIORITY.flatMap((l) => r.byLane[l].map(() => l as CandidateLane))
    );
  });

  it('respects a custom target size', () => {
    const r = generateCandidates(largePool(), followedCtx, {
      rng: mulberry32(1),
      now: NOW,
      targetSize: 100,
    });
    expect(r.candidates).toHaveLength(100);
    expect(r.byLane.affinity).toHaveLength(35);
    expect(r.byLane.tail).toHaveLength(10);
  });

  it('is deterministic for a fixed seed and independent of pool order', () => {
    const pool = largePool();
    const a = generateCandidates(pool, followedCtx, { rng: mulberry32(5), now: NOW });
    const b = generateCandidates([...pool].reverse(), followedCtx, { rng: mulberry32(5), now: NOW });
    expect(a.candidates.map((c) => `${c.lane}:${c.videoId}`)).toEqual(
      b.candidates.map((c) => `${c.lane}:${c.videoId}`)
    );
  });
});

describe('generateCandidates — cold start ("don\'t pretend")', () => {
  const coldCtx = viewer({
    profile: profile({ coldStartComplete: false }),
    followedSellerIds: new Set(Array.from({ length: 10 }, (_, i) => `sfollow-${i}`)),
  });

  it('yields EXACTLY ZERO affinity-lane candidates', () => {
    const r = generateCandidates(largePool(), coldCtx, { rng: mulberry32(3), now: NOW });
    expect(r.coldStart).toBe(true);
    expect(r.byLane.affinity).toHaveLength(0);
    expect(r.candidates.filter((c) => c.lane === 'affinity')).toHaveLength(0);
  });

  it('yields zero social-lane candidates even when the viewer has follows in the pool', () => {
    const r = generateCandidates(largePool(), coldCtx, { rng: mulberry32(3), now: NOW });
    expect(r.byLane.social).toHaveLength(0);
  });

  it('splits 40/30/30 across trending, fresh and tail', () => {
    const r = generateCandidates(largePool(), coldCtx, { rng: mulberry32(3), now: NOW });
    expect(r.candidates).toHaveLength(DEFAULT_TARGET_SIZE);
    expect(r.byLane.trending).toHaveLength(200);
    expect(r.byLane.fresh).toHaveLength(150);
    expect(r.byLane.tail).toHaveLength(150);
  });

  it('keeps affinity at zero even when only affinity-shaped videos exist to backfill from', () => {
    // Every video here qualifies for the affinity lane and nothing else, so a
    // backfill that ignored the zero share would fill the whole slice with it.
    const pool = Array.from({ length: 80 }, (_, i) =>
      video({
        videoId: `aff-${i}`,
        categoryId: 'cat-a',
        publishedAt: agoDays(10),
        stats: stats({ impressionsAll: 20_000, purchases1h: 0, addToCarts1h: 0, productTaps1h: 0 }),
      })
    );
    const r = generateCandidates(pool, coldCtx, { rng: mulberry32(3), now: NOW, targetSize: 50 });
    expect(r.byLane.affinity).toHaveLength(0);
    expect(r.byLane.social).toHaveLength(0);
    // They are still reachable through the lanes cold start DOES allow.
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.candidates.every((c) => c.lane === 'trending' || c.lane === 'fresh' || c.lane === 'tail')).toBe(true);
  });
});

describe('generateCandidates — dedupe', () => {
  /**
   * A pool where each block qualifies for exactly one non-tail lane, so a
   * single planted multi-lane video is the only contested one. Every video is
   * inside 90d and therefore also tail-eligible — that is realistic, since the
   * tail lane is "uniform random from live videos, last 90d".
   */
  function isolatedPool(): PoolVideo[] {
    const noVelocity = { purchases1h: 0, addToCarts1h: 0, productTaps1h: 0 };
    const out: PoolVideo[] = [];
    for (let i = 0; i < 20; i++) {
      out.push(
        video({
          videoId: `soc-${String(i).padStart(2, '0')}`,
          sellerId: `sfollow-${i % 10}`,
          categoryId: 'cat-z',
          publishedAt: agoDays(5),
          stats: stats({ impressionsAll: 30_000, ...noVelocity }),
        })
      );
      out.push(
        video({
          videoId: `aff-${String(i).padStart(2, '0')}`,
          sellerId: `sa-${i}`,
          categoryId: 'cat-a',
          publishedAt: agoDays(10),
          stats: stats({ impressionsAll: 20_000, ...noVelocity }),
        })
      );
      out.push(
        video({
          videoId: `trd-${String(i).padStart(2, '0')}`,
          sellerId: `st-${i}`,
          categoryId: 'cat-z',
          publishedAt: agoDays(10),
          stats: stats({ impressionsAll: 50_000, impressions1h: 400, purchases1h: 5 }),
        })
      );
    }
    return out;
  }

  it('emits each videoId exactly once', () => {
    const r = generateCandidates(largePool(), followedCtx, { rng: mulberry32(2), now: NOW });
    const ids = r.candidates.map((c) => c.videoId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('a video qualifying for fresh AND tail is assigned fresh', () => {
    // 'contested' is published 6h ago with 10 impressions: eligible for BOTH.
    const contested = video({
      videoId: 'contested',
      sellerId: 'sc',
      categoryId: 'cat-z',
      publishedAt: agoHours(6),
      stats: stats({ impressionsAll: 10, purchases1h: 0, addToCarts1h: 0, productTaps1h: 0 }),
    });
    expect(freshLane([contested], NOW).map((v) => v.videoId)).toEqual(['contested']);
    expect(tailLane([contested], NOW, mulberry32(1)).map((v) => v.videoId)).toEqual(['contested']);

    const r = generateCandidates([...isolatedPool(), contested], followedCtx, {
      rng: mulberry32(1),
      now: NOW,
    });
    expect(r.byLane.fresh.map((c) => c.videoId)).toContain('contested');
    expect(r.byLane.tail.map((c) => c.videoId)).not.toContain('contested');
  });

  it('a video qualifying for social AND affinity AND trending is assigned social', () => {
    const contested = video({
      videoId: 'contested',
      sellerId: 'sfollow-0',
      categoryId: 'cat-a',
      publishedAt: agoDays(2),
      stats: stats({ impressionsAll: 20_000, impressions1h: 400, purchases1h: 5 }),
    });
    const r = generateCandidates([...isolatedPool(), contested], followedCtx, {
      rng: mulberry32(1),
      now: NOW,
    });
    expect(r.byLane.social.map((c) => c.videoId)).toContain('contested');
    expect(r.byLane.affinity.map((c) => c.videoId)).not.toContain('contested');
    expect(r.byLane.trending.map((c) => c.videoId)).not.toContain('contested');
    expect(r.byLane.tail.map((c) => c.videoId)).not.toContain('contested');
  });

  it('a video qualifying for affinity AND trending is assigned affinity', () => {
    const contested = video({
      videoId: 'contested',
      sellerId: 'sc',
      categoryId: 'cat-a',
      publishedAt: agoDays(2),
      stats: stats({ impressionsAll: 20_000, impressions1h: 400, purchases1h: 5 }),
    });
    const r = generateCandidates([...isolatedPool(), contested], viewer(), {
      rng: mulberry32(1),
      now: NOW,
    });
    expect(r.byLane.affinity.map((c) => c.videoId)).toContain('contested');
    expect(r.byLane.trending.map((c) => c.videoId)).not.toContain('contested');
  });

  it('priority governs the contest, quota governs capacity: an over-subscribed lane spills down', () => {
    // Every video here is social-eligible AND affinity-eligible. Social's
    // quota is 10% so it cannot hold them all; the surplus does not vanish and
    // does not stay unassigned — it falls to the next-priority lane that both
    // wants it and has room. The rule is "highest-priority lane WITH CAPACITY",
    // and this is the only case where the two halves of it come apart.
    const pool = Array.from({ length: 100 }, (_, i) =>
      video({
        videoId: `both-${String(i).padStart(3, '0')}`,
        sellerId: `sfollow-${i % 10}`,
        categoryId: 'cat-a',
        publishedAt: agoDays(3),
        stats: stats({ impressionsAll: 20_000, purchases1h: 0, addToCarts1h: 0, productTaps1h: 0 }),
      })
    );
    const r = generateCandidates(pool, followedCtx, { rng: mulberry32(1), now: NOW });
    expect(r.byLane.social.length).toBeGreaterThan(0);
    expect(r.byLane.affinity.length).toBeGreaterThan(0);
    expect(r.candidates).toHaveLength(100);
    // Whatever the split, no video is emitted twice and none is dropped.
    expect(new Set(r.candidates.map((c) => c.videoId)).size).toBe(100);
  });
});

describe('generateCandidates — spec 2.5 guarantee', () => {
  /** Terrible on every axis: no velocity, no revenue, off-affinity, unloved. */
  const dud = (over: Partial<PoolVideo> = {}): PoolVideo =>
    video({
      videoId: 'dud',
      categoryId: 'cat-z',
      sellerId: 'nobody',
      publishedAt: agoHours(30),
      revenueCents24h: 0,
      stats: stats({
        impressions24h: 0,
        purchases24h: 0,
        impressionsAll: 3,
        impressions1h: 0,
        purchases1h: 0,
        addToCarts1h: 0,
        productTaps1h: 0,
      }),
      trust: { fulfillmentScore: 0.1, disputeRate: 0.5, ratingAvg: 1, tier: 'new' },
      budget: openBudget({ windowStart: agoHours(30), impressionsDelivered: 3 }),
      ...over,
    });

  it('a budget-owed video is in the fresh lane even inside a 900-video pool', () => {
    const pool = [...largePool(), dud()];
    const r = generateCandidates(pool, followedCtx, { rng: mulberry32(1), now: NOW });
    expect(r.guaranteedVideoIds).toContain('dud');
    expect(r.byLane.fresh.map((c) => c.videoId)).toContain('dud');
    expect(r.candidates.find((c) => c.videoId === 'dud')?.lane).toBe('fresh');
  });

  it('is admitted even when the fresh lane would reject it on its own criteria', () => {
    // Past 500 lifetime impressions and past the 48h publish window, so
    // freshLane() excludes it — but the guarantee is still open.
    const stubborn = dud({
      videoId: 'stubborn',
      publishedAt: agoDays(9),
      stats: stats({ impressionsAll: 20_000, impressions1h: 0, purchases1h: 0, addToCarts1h: 0, productTaps1h: 0 }),
      budget: openBudget({ windowStart: agoHours(12), impressionsDelivered: 100 }),
    });
    expect(freshLane([stubborn], NOW)).toEqual([]);
    const r = generateCandidates([...largePool(), stubborn], followedCtx, {
      rng: mulberry32(1),
      now: NOW,
    });
    expect(r.byLane.fresh.map((c) => c.videoId)).toContain('stubborn');
  });

  it('is admitted for a cold-start viewer too', () => {
    const coldCtx = viewer({ profile: profile({ coldStartComplete: false }) });
    const r = generateCandidates([...largePool(), dud()], coldCtx, { rng: mulberry32(1), now: NOW });
    expect(r.byLane.fresh.map((c) => c.videoId)).toContain('dud');
  });

  it('is NOT admitted once the window closes or the budget is filled', () => {
    const expired = dud({ videoId: 'expired', budget: openBudget({ windowStart: agoHours(49) }) });
    const filled = dud({ videoId: 'filled', budget: openBudget({ impressionsDelivered: 500 }) });
    const r = generateCandidates([...largePool(), expired, filled], followedCtx, {
      rng: mulberry32(1),
      now: NOW,
    });
    expect(r.guaranteedVideoIds).not.toContain('expired');
    expect(r.guaranteedVideoIds).not.toContain('filled');
  });

  it('still loses to the hard filters — a guarantee is not a licence to sell nothing', () => {
    const noStock = dud({
      videoId: 'nostock',
      products: [{ productId: 'p', status: 'active', inventoryCount: 0 }],
    });
    const r = generateCandidates([...largePool(), noStock], followedCtx, {
      rng: mulberry32(1),
      now: NOW,
    });
    expect(r.guaranteedVideoIds).not.toContain('nostock');
    expect(r.candidates.some((c) => c.videoId === 'nostock')).toBe(false);
  });

  it('overflowing the fresh quota is charged to the lowest-priority lanes, not to the guarantee', () => {
    // 40 owed videos against a fresh quota of 20% * 100 = 20.
    const owed = Array.from({ length: 40 }, (_, i) =>
      dud({
        videoId: `owed-${String(i).padStart(2, '0')}`,
        sellerId: `so-${i}`,
        budget: openBudget({ windowStart: agoHours(20 + i / 100), impressionsDelivered: 1 }),
      })
    );
    const r = generateCandidates([...largePool(), ...owed], followedCtx, {
      rng: mulberry32(1),
      now: NOW,
      targetSize: 100,
    });
    expect(r.guaranteedVideoIds).toHaveLength(40);
    for (const v of owed) expect(r.byLane.fresh.map((c) => c.videoId)).toContain(v.videoId);
    expect(r.candidates).toHaveLength(100);
    // Tail (lowest priority) gives up its slots before affinity (highest of the
    // three non-fresh remainders that carry a share here).
    expect(r.byLane.tail.length).toBeLessThan(10);
    expect(r.byLane.affinity).toHaveLength(35);
  });

  it('delivers the closest-to-expiry window first', () => {
    const mk = (id: string, windowHoursAgo: number) =>
      dud({ videoId: id, sellerId: id, budget: openBudget({ windowStart: agoHours(windowHoursAgo) }) });
    const r = generateCandidates([mk('young', 2), mk('old', 40), mk('mid', 20)], viewer(), {
      rng: mulberry32(1),
      now: NOW,
      targetSize: 10,
    });
    expect(r.guaranteedVideoIds).toEqual(['old', 'mid', 'young']);
  });
});

describe('generateCandidates — degenerate inputs', () => {
  it('an empty pool returns an empty, fully-shaped result', () => {
    const r = generateCandidates([], viewer(), { rng: mulberry32(1), now: NOW });
    expect(r.candidates).toEqual([]);
    expect(r.eligibleCount).toBe(0);
    for (const lane of LANES) expect(r.byLane[lane]).toEqual([]);
  });

  it('a pool where everything is filtered out returns empty', () => {
    const pool = Array.from({ length: 50 }, (_, i) => video({ videoId: `v${i}`, status: 'removed' }));
    const r = generateCandidates(pool, viewer(), { rng: mulberry32(1), now: NOW });
    expect(r.eligibleCount).toBe(0);
    expect(r.candidates).toEqual([]);
  });

  it('targetSize 0 returns nothing without touching the pool', () => {
    const r = generateCandidates(largePool(), followedCtx, {
      rng: mulberry32(1),
      now: NOW,
      targetSize: 0,
    });
    expect(r.candidates).toEqual([]);
  });

  it('a pool smaller than the target returns every eligible video, exactly once', () => {
    const pool = largePool().slice(0, 37);
    const r = generateCandidates(pool, followedCtx, { rng: mulberry32(1), now: NOW });
    const eligibleIds = hardFilters(pool, followedCtx, NOW).map((v) => v.videoId);
    expect(r.candidates).toHaveLength(eligibleIds.length);
    expect(new Set(r.candidates.map((c) => c.videoId))).toEqual(new Set(eligibleIds));
  });

  it('backfill does not let one lane swallow a thin pool whole', () => {
    // 60 videos that are affinity-eligible, fresh-eligible and tail-eligible at
    // once, against a target of 500. Every lane runs dry; the round-robin must
    // spread them rather than dumping all 60 into fresh.
    const pool = Array.from({ length: 60 }, (_, i) =>
      video({
        videoId: `x${String(i).padStart(2, '0')}`,
        sellerId: `sx-${i}`,
        categoryId: 'cat-a',
        publishedAt: agoHours(4),
        stats: stats({ impressionsAll: i, purchases1h: 0, addToCarts1h: 0, productTaps1h: 0 }),
      })
    );
    const r = generateCandidates(pool, viewer(), { rng: mulberry32(1), now: NOW });
    expect(r.candidates).toHaveLength(60);
    expect(r.byLane.fresh.length).toBeLessThan(60);
    expect(r.byLane.affinity.length).toBeGreaterThan(0);
    expect(r.byLane.tail.length).toBeGreaterThan(0);
  });

  it('a pool with no tail-eligible videos still fills the other lanes', () => {
    const pool = Array.from({ length: 200 }, (_, i) =>
      video({
        videoId: `anc-${i}`,
        sellerId: `sa-${i}`,
        categoryId: 'cat-a',
        publishedAt: agoDays(200), // outside every lane window except affinity's? no — outside all
        stats: stats({ impressionsAll: 10_000 }),
      })
    );
    const r = generateCandidates(pool, viewer(), { rng: mulberry32(1), now: NOW });
    // Nothing is inside any lane window, so nothing is generated — the module
    // does not invent eligibility it was not given.
    expect(r.eligibleCount).toBe(200);
    expect(r.byLane.tail).toHaveLength(0);
    expect(r.byLane.fresh).toHaveLength(0);
  });

  it('never returns a video that failed a hard filter, whatever the lane', () => {
    const pool = largePool().map((v, i) =>
      i % 7 === 0
        ? { ...v, seller: { ...v.seller, chargesEnabled: false } }
        : i % 11 === 0
          ? { ...v, status: 'paused' as const }
          : v
    );
    const r = generateCandidates(pool, followedCtx, { rng: mulberry32(4), now: NOW });
    for (const c of r.candidates) {
      expect(c.seller.chargesEnabled).toBe(true);
      expect(c.status).toBe('live');
    }
  });
});

describe('purity', () => {
  it('does not mutate the pool it was given', () => {
    const pool = largePool();
    const snapshot = pool.map((v) => `${v.videoId}:${v.lane ?? ''}`);
    generateCandidates(pool, followedCtx, { rng: mulberry32(8), now: NOW });
    expect(pool.map((v) => `${v.videoId}:${v.lane ?? ''}`)).toEqual(snapshot);
  });

  it('contains no clock or global-random reads', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../candidates.ts', import.meta.url), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/Date\.now\(/);
    expect(code).not.toMatch(/Math\.random\(/);
    expect(code).not.toMatch(/new Date\(\)/);
  });
});
