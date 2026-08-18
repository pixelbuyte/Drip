import { describe, expect, it } from 'vitest';
import { scoreAll, scoreCandidate } from '../score';
import {
  DEFAULT_WEIGHTS, type Candidate, type CategoryPriors, type RecentContext, type ViewerProfile,
} from '../types';

const W = DEFAULT_WEIGHTS;
const NOW = new Date('2026-08-18T00:00:00Z');

const PRIORS: CategoryPriors = {
  purchaseRate: {}, cartRate: {}, tapRate: {},
  fallback: { purchaseRate: 0.01, cartRate: 0.03, tapRate: 0.08 },
};

const VIEWER: ViewerProfile = {
  categoryAffinity: {}, sellerAffinity: {}, hashtagAffinity: {},
  priceBand: null, coldStartComplete: false,
};

const CTX: RecentContext = {
  sellerIds: [], categoryIds: [], priceCents: [], seenSellerIds: new Set(),
};

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
    trust: { fulfillmentScore: 0, disputeRate: 1, ratingAvg: null, tier: 'new' },
    ...over,
  };
}

describe('scoreCandidate', () => {
  it('is pure — identical inputs give deep-equal outputs', () => {
    const c = candidate();
    expect(scoreCandidate(c, VIEWER, CTX, W, PRIORS, NOW))
      .toEqual(scoreCandidate(c, VIEWER, CTX, W, PRIORS, NOW));
  });

  it('recomposes exactly from its components under the weight vector', () => {
    const { score, components } = scoreCandidate(candidate(), VIEWER, CTX, W, PRIORS, NOW);
    const recomposed =
      W.wCommerce * components.commerce +
      W.wEngagement * components.engagement +
      W.wAffinity * components.affinity +
      W.wFreshness * components.freshness +
      W.wTrust * components.trust +
      W.wDiversity * components.diversity -
      W.pFatigue * components.fatigue -
      W.pQuality * components.quality;
    expect(score).toBeCloseTo(recomposed, 10);
  });

  it('is not clamped — a heavily penalized video stays orderable below zero', () => {
    const awful = candidate({
      stats: {
        ...candidate().stats,
        skipsUnder2s24h: 1000, reportsAll: 1000, notInterestedAll: 1000,
      },
      trust: { fulfillmentScore: 0, disputeRate: 1, ratingAvg: null, tier: 'new' },
      publishedAt: new Date(NOW.getTime() - 1000 * 3600_000),
    });
    const ctx: RecentContext = {
      sellerIds: ['s1'], categoryIds: ['c1'], priceCents: [4000], seenSellerIds: new Set(['s1']),
    };
    expect(scoreCandidate(awful, VIEWER, ctx, W, PRIORS, NOW).score).toBeLessThan(0);
  });

  it('ranks a high-skip video below an otherwise identical one', () => {
    const good = candidate({ videoId: 'good' });
    const bad = candidate({
      videoId: 'bad',
      stats: { ...candidate().stats, skipsUnder2s24h: 600 },
    });
    const gs = scoreCandidate(good, VIEWER, CTX, W, PRIORS, NOW).score;
    const bs = scoreCandidate(bad, VIEWER, CTX, W, PRIORS, NOW).score;
    expect(bs).toBeLessThan(gs);
  });

  it('does not depend on input ordering', () => {
    const a = candidate({ videoId: 'a', sellerId: 'sa' });
    const b = candidate({ videoId: 'b', sellerId: 'sb' });
    const forward = scoreAll([a, b], VIEWER, CTX, W, PRIORS, NOW);
    const backward = scoreAll([b, a], VIEWER, CTX, W, PRIORS, NOW);
    expect(forward.find((x) => x.videoId === 'a')!.score)
      .toBe(backward.find((x) => x.videoId === 'a')!.score);
  });
});
