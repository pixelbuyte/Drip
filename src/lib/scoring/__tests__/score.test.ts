import { describe, expect, it } from 'vitest';
import { scoreAll, scoreCandidate } from '../score';
import {
  affinitySignal, diversityBonus, fatiguePenalty, freshnessSignal, trustSignal,
} from '../signals';
import { bayesianRate, normToReference, safeRate } from '../normalize';
import {
  DEFAULT_CATEGORY_MEDIANS, DEFAULT_WEIGHTS, medianFor,
  type Candidate, type CategoryMedians, type CategoryPriors, type NormalisableRate,
  type RecentContext, type ViewerProfile,
} from '../types';

const W = DEFAULT_WEIGHTS;
const NOW = new Date('2026-08-18T00:00:00Z');

/**
 * v2: one table is both the Bayesian prior and, at 2.5x, the normalisation
 * reference. `CategoryPriors` is still the alias for the prior-side reading.
 */
const MEDIANS: CategoryPriors = DEFAULT_CATEGORY_MEDIANS;

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
    expect(scoreCandidate(c, VIEWER, CTX, W, MEDIANS, NOW))
      .toEqual(scoreCandidate(c, VIEWER, CTX, W, MEDIANS, NOW));
  });

  it('recomposes exactly from its components under the weight vector', () => {
    const { score, components } = scoreCandidate(candidate(), VIEWER, CTX, W, MEDIANS, NOW);
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
    expect(scoreCandidate(awful, VIEWER, ctx, W, MEDIANS, NOW).score).toBeLessThan(0);
  });

  it('ranks a high-skip video below an otherwise identical one', () => {
    const good = candidate({ videoId: 'good' });
    const bad = candidate({
      videoId: 'bad',
      stats: { ...candidate().stats, skipsUnder2s24h: 600 },
    });
    const gs = scoreCandidate(good, VIEWER, CTX, W, MEDIANS, NOW).score;
    const bs = scoreCandidate(bad, VIEWER, CTX, W, MEDIANS, NOW).score;
    expect(bs).toBeLessThan(gs);
  });

  it('does not depend on input ordering', () => {
    const a = candidate({ videoId: 'a', sellerId: 'sa' });
    const b = candidate({ videoId: 'b', sellerId: 'sb' });
    const forward = scoreAll([a, b], VIEWER, CTX, W, MEDIANS, NOW);
    const backward = scoreAll([b, a], VIEWER, CTX, W, MEDIANS, NOW);
    expect(forward.find((x) => x.videoId === 'a')!.score)
      .toBe(backward.find((x) => x.videoId === 'a')!.score);
  });

  it('scores a video nobody has ever seen as exactly average, not as bad', () => {
    // Every gated component is 0.5 at zero impressions. That is the correct
    // reading of "no evidence" and the reason ImpressionBudget exists: the gate
    // will not let an unproven video in on a fluke, so the 500-impression
    // guarantee is what buys it the evidence to be judged on.
    const unseen = candidate({ stats: {
      ...candidate().stats, impressions24h: 0, impressionsAll: 0,
    } });
    const { components } = scoreCandidate(unseen, VIEWER, CTX, W, MEDIANS, NOW);
    expect(components.commerce).toBe(0.5);
    expect(components.engagement).toBe(0.5);
    expect(components.quality).toBe(0.5);
    // And the ungated components are untouched by its having no data.
    expect(components.freshness).toBe(1);
    expect(components.diversity).toBeCloseTo(1, 10);
  });
});

// ---------------------------------------------------------------------------
// THE HEADLINE CASE (spec 2.2), end to end
// ---------------------------------------------------------------------------

/**
 * The complete v1 scorer: Bayesian smoothing and 2.5x category-median
 * normalisation, with NO evidence gate anywhere. Only the gated components are
 * reimplemented; affinity, freshness, trust, diversity and fatigue are not
 * gated in v2 either, so the real functions are reused for them and any
 * difference between the two scorers is the gate and nothing else.
 */
function ungatedScore(c: Candidate, medians: CategoryMedians): number {
  const imp = c.stats.impressions24h;
  const impAll = c.stats.impressionsAll;

  const term = (n: number, denom: number, r: NormalisableRate) => {
    const cm = medianFor(medians, r, c.categoryId);
    return normToReference(
      bayesianRate(n, denom, cm, W.bayesAlpha), cm, medians.fallback[r], W.normReferenceMultiplier
    );
  };
  const level = (v: number, r: NormalisableRate) => {
    const cm = medianFor(medians, r, c.categoryId);
    return normToReference(v, cm, medians.fallback[r], W.normReferenceMultiplier);
  };

  const commerce =
    0.45 * term(c.stats.purchases24h, imp, 'purchaseRate') +
    0.3 * term(c.stats.addToCarts24h, imp, 'cartRate') +
    0.25 * term(c.stats.productTaps24h, imp, 'tapRate');

  const engagement =
    0.4 * Math.min(1, safeRate(c.stats.completions24h, imp)) +
    0.25 * level(c.stats.avgLoopCount, 'avgLoopCount') +
    0.2 * term(c.stats.shares24h, imp, 'shareRate') +
    0.15 * term(c.stats.saves24h, imp, 'saveRate');

  const quality =
    0.5 * term(c.stats.skipsUnder2s24h, imp, 'skipUnder2sRate') +
    0.3 * term(c.stats.reportsAll, impAll, 'reportRate') +
    0.2 * term(c.stats.notInterestedAll, impAll, 'notInterestedRate');

  return (
    W.wCommerce * commerce +
    W.wEngagement * engagement +
    W.wAffinity * affinitySignal(c, VIEWER, W) +
    W.wFreshness * freshnessSignal(c.publishedAt, NOW, W) +
    W.wTrust * trustSignal(c.trust, W) +
    W.wDiversity * diversityBonus(c, CTX) -
    W.pFatigue * fatiguePenalty(c, CTX) -
    W.pQuality * quality
  );
}

describe('1 purchase in 3 impressions vs 90 in 20,000', () => {
  /**
   * From the spec, and the whole reason the evidence gate exists: "A video with
   * 1 purchase in 3 impressions beat one with 90 purchases in 20,000 in
   * testing, because 1-in-3 genuinely IS extreme evidence — it is just
   * extremely noisy evidence. Smoothing shrinks the estimate; it doesn't shrink
   * your confidence in it. The evidence gate does."
   *
   * Both videos are in a category whose median purchase rate is 0.2%, so
   * 90/20,000 (0.45%) is a genuinely strong performer rather than merely a
   * high-volume one. Everything else about the two is identical: same seller,
   * same publish time, same price, same trust.
   *
   * The fluke is given the best possible reading of its three impressions —
   * every viewer completed it, looped it, tapped, carted, bought, shared and
   * saved, and none skipped. That is what three impressions can look like, and
   * v1 believed all of it.
   */
  const MEDIANS_PROVEN: CategoryMedians = {
    byCategory: {
      proven: {
        purchaseRate: 0.002, cartRate: 0.006, tapRate: 0.03,
        shareRate: 0.004, saveRate: 0.01, avgLoopCount: 1.2,
        skipUnder2sRate: 0.24, reportRate: 0.008, notInterestedRate: 0.02,
      },
    },
    fallback: DEFAULT_CATEGORY_MEDIANS.fallback,
  };

  const shared = {
    sellerId: 'seller', categoryId: 'proven', publishedAt: NOW, minPriceCents: 4000,
    trust: { fulfillmentScore: 0.9, disputeRate: 0.02, ratingAvg: 4.5, tier: 'building' },
  } as const;

  const fluke = candidate({
    ...shared, videoId: 'fluke',
    stats: {
      ...candidate().stats,
      impressions24h: 3, impressionsAll: 3,
      purchases24h: 1, addToCarts24h: 1, productTaps24h: 1,
      completions24h: 3, avgLoopCount: 3, shares24h: 1, saves24h: 1,
      skipsUnder2s24h: 0, reportsAll: 0, notInterestedAll: 0,
    },
  });

  const proven = candidate({
    ...shared, videoId: 'proven',
    stats: {
      ...candidate().stats,
      impressions24h: 20_000, impressionsAll: 20_000,
      purchases24h: 90, addToCarts24h: 260, productTaps24h: 900,
      completions24h: 9_000, avgLoopCount: 1.4, shares24h: 300, saves24h: 700,
      skipsUnder2s24h: 3_000, reportsAll: 0, notInterestedAll: 0,
    },
  });

  const flukeV2 = scoreCandidate(fluke, VIEWER, CTX, W, MEDIANS_PROVEN, NOW).score;
  const provenV2 = scoreCandidate(proven, VIEWER, CTX, W, MEDIANS_PROVEN, NOW).score;

  it('THE HEADLINE: the fluke does not outrank the proven video', () => {
    expect(flukeV2).toBeCloseTo(0.4221958, 6);
    expect(provenV2).toBeCloseTo(0.6467997, 6);
    expect(provenV2).toBeGreaterThan(flukeV2);
    // Not a hairline win — the proven video is more than half a standard slice
    // clear of the fluke.
    expect(provenV2 - flukeV2).toBeGreaterThan(0.2);
  });

  it('and v1 — smoothing without the gate — got it backwards', () => {
    const flukeV1 = ungatedScore(fluke, MEDIANS_PROVEN);
    const provenV1 = ungatedScore(proven, MEDIANS_PROVEN);

    expect(flukeV1).toBeCloseTo(0.6871918, 6);
    expect(provenV1).toBeCloseTo(0.6467997, 6);

    // The exact failure the spec reports, reproduced: Bayesian smoothing and
    // per-category normalisation are BOTH already in place here, and the fluke
    // still wins. Only the gate fixes it.
    expect(flukeV1).toBeGreaterThan(provenV1);
  });

  it('leaves the proven video untouched and demotes only the fluke', () => {
    // The gate is not a tax on everyone. A video past the evidence threshold
    // scores identically with and without it; all of the movement is on the
    // video that had not earned its estimate.
    expect(provenV2).toBeCloseTo(ungatedScore(proven, MEDIANS_PROVEN), 12);
    expect(flukeV2).toBeLessThan(ungatedScore(fluke, MEDIANS_PROVEN));
    expect(ungatedScore(fluke, MEDIANS_PROVEN) - flukeV2).toBeCloseTo(0.2649961, 6);
  });

  it('component by component: commerce is where the correction lands', () => {
    const f = scoreCandidate(fluke, VIEWER, CTX, W, MEDIANS_PROVEN, NOW).components;
    const p = scoreCandidate(proven, VIEWER, CTX, W, MEDIANS_PROVEN, NOW).components;

    expect(f.commerce).toBeCloseTo(0.5122170, 6);
    expect(p.commerce).toBeCloseTo(0.8139651, 6);
    expect(p.commerce).toBeGreaterThan(f.commerce);

    // The fluke's perfect engagement is discounted to near-neutral...
    expect(f.engagement).toBeCloseTo(0.515, 6);
    expect(p.engagement).toBeCloseTo(0.6466667, 6);

    // ...and its clean quality record is too, which is the symmetric cost of
    // the gate: no evidence of harm is not evidence of no harm.
    expect(f.quality).toBeCloseTo(0.4963208, 6);
    expect(p.quality).toBeCloseTo(0.1256858, 6);

    // Everything ungated is identical between the two by construction.
    expect(f.affinity).toBe(p.affinity);
    expect(f.freshness).toBe(p.freshness);
    expect(f.trust).toBe(p.trust);
    expect(f.diversity).toBe(p.diversity);
    expect(f.fatigue).toBe(p.fatigue);
  });
});
