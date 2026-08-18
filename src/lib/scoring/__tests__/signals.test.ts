import { describe, expect, it } from 'vitest';
import {
  affinitySignal, commerceSignal, diversityBonus, engagementSignal, freshnessSignal,
  priceBandFit, qualityPenalty, fatiguePenalty, trustSignal,
} from '../signals';
import { DEFAULT_WEIGHTS, type Candidate, type RecentContext } from '../types';

const W = DEFAULT_WEIGHTS;
const NOW = new Date('2026-08-18T00:00:00Z');
const BAND = { p25: 2000, p50: 3500, p75: 6000 };

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    videoId: 'v1', sellerId: 's1', categoryId: 'c1', lane: 'trending',
    publishedAt: NOW, minPriceCents: 4000, hashtags: [],
    stats: {
      impressions24h: 1000, purchases24h: 0, addToCarts24h: 0, productTaps24h: 0,
      completions24h: 0, skipsUnder2s24h: 0, shares24h: 0, saves24h: 0,
      avgLoopCount: 0, reportsAll: 0, notInterestedAll: 0, impressionsAll: 1000,
      impressions1h: 0, purchases1h: 0, addToCarts1h: 0, productTaps1h: 0,
    },
    trust: { fulfillmentScore: 1, disputeRate: 0, ratingAvg: 5, tier: 'elite' },
    ...over,
  };
}

const ctx = (over: Partial<RecentContext> = {}): RecentContext => ({
  sellerIds: [], categoryIds: [], priceCents: [], seenSellerIds: new Set(), ...over,
});

describe('freshnessSignal', () => {
  it('decays on a 72 hour half-life, exactly', () => {
    expect(freshnessSignal(NOW, NOW, W)).toBeCloseTo(1, 6);
    expect(freshnessSignal(new Date(NOW.getTime() - 72 * 3600_000), NOW, W)).toBeCloseTo(0.5, 6);
    expect(freshnessSignal(new Date(NOW.getTime() - 144 * 3600_000), NOW, W)).toBeCloseTo(0.25, 6);
  });
  it('applies the thin-category multiplier but never exceeds 1', () => {
    const at72 = new Date(NOW.getTime() - 72 * 3600_000);
    expect(freshnessSignal(at72, NOW, W, 1.2)).toBeCloseTo(0.6, 6);
    expect(freshnessSignal(NOW, NOW, W, 1.2)).toBe(1);
  });
});

describe('priceBandFit', () => {
  it('is 1 inside the band, inclusive at both ends', () => {
    expect(priceBandFit(4000, BAND)).toBe(1);
    expect(priceBandFit(2000, BAND)).toBe(1);
    expect(priceBandFit(6000, BAND)).toBe(1);
  });
  it('reaches 0 at 3x p75 and at 0.3x p25', () => {
    expect(priceBandFit(18_000, BAND)).toBe(0);
    expect(priceBandFit(600, BAND)).toBe(0);
  });
  it('decays linearly to those zero points', () => {
    expect(priceBandFit(12_000, BAND)).toBeCloseTo(0.5, 6);
    expect(priceBandFit(1300, BAND)).toBeCloseTo(0.5, 6);
  });
  it('is neutral, not zero, for a viewer with no band yet', () => {
    expect(priceBandFit(99_999, null)).toBe(0.5);
  });
});

describe('trustSignal', () => {
  // The tier floor is what makes cold start solvable at all.
  it('never zeroes a brand-new seller', () => {
    const s = trustSignal({ fulfillmentScore: 0, disputeRate: 1, ratingAvg: null, tier: 'new' }, W);
    expect(s).toBeCloseTo(0.075, 6);
    expect(s).toBeGreaterThan(0);
  });
  it('is 1 for a perfect elite seller', () => {
    expect(trustSignal({ fulfillmentScore: 1, disputeRate: 0, ratingAvg: 5, tier: 'elite' }, W)).toBeCloseTo(1, 6);
  });
});

describe('fatiguePenalty', () => {
  it('is maximal for the same seller and category immediately after', () => {
    const c = candidate();
    const penalty = fatiguePenalty(c, ctx({ sellerIds: ['s1'], categoryIds: ['c1'] }));
    expect(penalty).toBeCloseTo(1, 6);
  });
  it('halves in the wider window and vanishes beyond it', () => {
    const c = candidate();
    const mid = fatiguePenalty(c, ctx({ sellerIds: ['x', 'y', 'z', 's1'], categoryIds: ['a', 'b', 'c1'] }));
    expect(mid).toBeCloseTo(0.6 * 0.5 + 0.4 * 0.5, 6);
    const none = fatiguePenalty(c, ctx({ sellerIds: Array(9).fill('x'), categoryIds: Array(9).fill('a') }));
    expect(none).toBe(0);
  });
});

describe('qualityPenalty', () => {
  it('is dominant for a video nobody watches past 2 seconds', () => {
    const bad = candidate({ stats: { ...candidate().stats, skipsUnder2s24h: 600, impressions24h: 1000 } });
    expect(qualityPenalty(bad, W)).toBeGreaterThanOrEqual(0.5);
  });
});

describe('engagementSignal', () => {
  // Likes are absent by construction: the spec says they correlate poorly with
  // purchase, so a like count cannot influence this score at all.
  it('ignores likes entirely', () => {
    const base = candidate({ stats: { ...candidate().stats, completions24h: 500 } });
    const withLikes = { ...base, stats: { ...base.stats } } as Candidate & { stats: { likes24h?: number } };
    (withLikes.stats as Record<string, number>).likes24h = 100_000;
    expect(engagementSignal(withLikes, W)).toBe(engagementSignal(base, W));
  });
  it('weights completion most heavily', () => {
    const complete = candidate({ stats: { ...candidate().stats, completions24h: 1000 } });
    expect(engagementSignal(complete, W)).toBeCloseTo(0.4, 6);
  });
});

describe('affinitySignal', () => {
  it('rewards a category the viewer actually buys in', () => {
    const c = candidate();
    const cold = affinitySignal(c, {
      categoryAffinity: {}, sellerAffinity: {}, hashtagAffinity: {},
      priceBand: BAND, coldStartComplete: false,
    }, W);
    const warm = affinitySignal(c, {
      categoryAffinity: { c1: 1 }, sellerAffinity: {}, hashtagAffinity: {},
      priceBand: BAND, coldStartComplete: true,
    }, W);
    expect(warm).toBeGreaterThan(cold);
    expect(warm - cold).toBeCloseTo(0.4, 6);
  });
});

describe('commerceSignal', () => {
  it('rewards purchases far above taps', () => {
    const base = candidate();
    const buys = candidate({ stats: { ...base.stats, purchases24h: 50 } });
    const taps = candidate({ stats: { ...base.stats, productTaps24h: 50 } });
    const priors = {
      purchaseRate: {}, cartRate: {}, tapRate: {},
      fallback: { purchaseRate: 0.01, cartRate: 0.03, tapRate: 0.08 },
    };
    expect(commerceSignal(buys, W, priors)).toBeGreaterThan(commerceSignal(taps, W, priors));
  });

  it('uses the category prior when one exists', () => {
    const c = candidate({ categoryId: 'hot' });
    const withPrior = commerceSignal(c, W, {
      purchaseRate: { hot: 0.05 }, cartRate: {}, tapRate: {},
      fallback: { purchaseRate: 0.001, cartRate: 0.03, tapRate: 0.08 },
    });
    const withFallback = commerceSignal(c, W, {
      purchaseRate: {}, cartRate: {}, tapRate: {},
      fallback: { purchaseRate: 0.001, cartRate: 0.03, tapRate: 0.08 },
    });
    expect(withPrior).toBeGreaterThan(withFallback);
  });

  it('is 0 for a video with no impressions and zero priors', () => {
    const c = candidate({ stats: { ...candidate().stats, impressions24h: 0, impressionsAll: 0 } });
    const zero = { purchaseRate: {}, cartRate: {}, tapRate: {},
      fallback: { purchaseRate: 0, cartRate: 0, tapRate: 0 } };
    expect(commerceSignal(c, W, zero)).toBe(0);
  });
});

describe('diversityBonus', () => {
  it('is maximal against an empty context', () => {
    expect(diversityBonus(candidate(), ctx())).toBeCloseTo(1, 6);
  });

  it('drops for a seller, category and price band all just served', () => {
    const c = candidate();
    const same = diversityBonus(c, ctx({
      sellerIds: ['s1'], categoryIds: ['c1'], priceCents: [4000],
    }));
    expect(same).toBe(0);
  });

  it('credits a different price band even from the same seller', () => {
    const c = candidate({ minPriceCents: 20_000 });
    const v = diversityBonus(c, ctx({ sellerIds: ['s1'], categoryIds: ['c1'], priceCents: [1500] }));
    expect(v).toBeCloseTo(0.25, 6);
  });

  it('only looks at the last 5', () => {
    const c = candidate();
    const old = diversityBonus(c, ctx({
      sellerIds: ['a', 'b', 'c', 'd', 'e', 's1'],
      categoryIds: ['a', 'b', 'c', 'd', 'e', 'c1'],
      priceCents: [1500, 1500, 1500, 1500, 1500, 4000],
    }));
    expect(old).toBeCloseTo(1, 6);
  });
});

describe('hashtag affinity', () => {
  it('contributes when the viewer has affinity for a tag on the video', () => {
    const c = candidate({ hashtags: ['silk', 'vintage'] });
    const none = affinitySignal(c, {
      categoryAffinity: {}, sellerAffinity: {}, hashtagAffinity: {},
      priceBand: null, coldStartComplete: true,
    }, W);
    const some = affinitySignal(c, {
      categoryAffinity: {}, sellerAffinity: {}, hashtagAffinity: { silk: 0.6, vintage: 0.4 },
      priceBand: null, coldStartComplete: true,
    }, W);
    expect(some - none).toBeCloseTo(0.15, 6);
  });
  it('caps hashtag overlap at 1 so many tags cannot dominate', () => {
    const many = candidate({ hashtags: ['a', 'b', 'c', 'd'] });
    const v = affinitySignal(many, {
      categoryAffinity: {}, sellerAffinity: {}, hashtagAffinity: { a: 5, b: 5, c: 5, d: 5 },
      priceBand: null, coldStartComplete: true,
    }, W);
    // 0.4*0 + 0.25*0.5 (no band) + 0.2*0 + 0.15*1 (capped)
    expect(v).toBeCloseTo(0.25 * 0.5 + 0.15, 6);
  });
});
