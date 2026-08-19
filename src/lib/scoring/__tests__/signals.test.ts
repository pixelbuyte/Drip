import { describe, expect, it } from 'vitest';
import {
  DEAD_VIDEO_MIN_IMPRESSIONS, DEAD_VIDEO_SKIP_RATE,
  affinitySignal, commerceSignal, diversityBonus, engagementSignal, freshnessSignal,
  isDeadVideo, priceBandFit, qualityPenalty, fatiguePenalty, trustSignal,
} from '../signals';
import { bayesianRate, normToReference } from '../normalize';
import {
  DEFAULT_CATEGORY_MEDIANS, DEFAULT_WEIGHTS, medianFor,
  type Candidate, type CategoryMedians, type NormalisableRate, type RateMedians,
  type RecentContext,
} from '../types';

const W = DEFAULT_WEIGHTS;
const NOW = new Date('2026-08-18T00:00:00Z');
const BAND = { p25: 2000, p50: 3500, p75: 6000 };

/** The platform defaults: 2.5x each of these reproduces the v1 global caps. */
const M = DEFAULT_CATEGORY_MEDIANS;

const ZERO_MEDIANS: RateMedians = {
  purchaseRate: 0, cartRate: 0, tapRate: 0, shareRate: 0, saveRate: 0,
  avgLoopCount: 0, skipUnder2sRate: 0, reportRate: 0, notInterestedRate: 0,
};

function withCategory(byCategory: Record<string, Partial<RateMedians>>): CategoryMedians {
  return { byCategory, fallback: M.fallback };
}

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

/**
 * The v1 pipeline, kept alive here on purpose: Bayesian smoothing and 2.5x
 * median normalisation, with NO evidence gate. The headline test below scores
 * the same two candidates through both and asserts they disagree — that is the
 * only way to prove the gate is what produces the v2 ordering rather than the
 * smoothing that was already there in v1.
 */
function ungatedCommerce(c: Candidate, medians: CategoryMedians): number {
  const imp = c.stats.impressions24h;
  const term = (n: number, r: NormalisableRate) => {
    const cm = medianFor(medians, r, c.categoryId);
    return normToReference(
      bayesianRate(n, imp, cm, W.bayesAlpha),
      cm,
      medians.fallback[r],
      W.normReferenceMultiplier
    );
  };
  return (
    0.45 * term(c.stats.purchases24h, 'purchaseRate') +
    0.3 * term(c.stats.addToCarts24h, 'cartRate') +
    0.25 * term(c.stats.productTaps24h, 'tapRate')
  );
}

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
  // Freshness is a subtraction of two timestamps, not a sampled rate, so the
  // evidence gate must not touch it: a two-hour-old video with no impressions
  // is still exactly two hours old.
  it('is not evidence-gated — a brand-new video with no data is still fresh', () => {
    const c = candidate({ stats: { ...candidate().stats, impressions24h: 0, impressionsAll: 0 } });
    expect(freshnessSignal(c.publishedAt, NOW, W)).toBe(1);
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
  // v2: the rating ceiling is RATING_SCALE_MAX (5), a bounded scale, not 2.5x a
  // median — a 5-star average is the top of the scale by construction.
  it('normalises the rating against the 0-5 scale, not a category median', () => {
    const half = trustSignal({ fulfillmentScore: 0, disputeRate: 1, ratingAvg: 2.5, tier: 'new' }, W);
    expect(half - 0.075).toBeCloseTo(0.2 * 0.5, 6);
  });
  // Trust is seller-level, measured over the seller's orders, not this video's
  // impressions — so it is not gated and does not move toward 0.5 with no data.
  it('is not evidence-gated by the video that carries it', () => {
    const t = { fulfillmentScore: 1, disputeRate: 0, ratingAvg: 5, tier: 'elite' } as const;
    expect(trustSignal(t, W)).toBeCloseTo(1, 6);
    expect(trustSignal(t, W)).not.toBeCloseTo(0.5, 2);
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
    const bad = candidate({ stats: { ...candidate().stats, skipsUnder2s24h: 900, impressions24h: 1000 } });
    expect(qualityPenalty(bad, W, M)).toBeGreaterThanOrEqual(0.5);
    expect(qualityPenalty(bad, W, M)).toBeCloseTo(0.5095238, 6);
  });
  // A 60% skip rate is 2.5x the 0.24 median, i.e. exactly at the top of the
  // normalised scale, so the skip term alone contributes very nearly its full
  // 0.5 weight.
  it('puts a 2.5x-median skip rate at the top of its own scale', () => {
    const bad = candidate({ stats: { ...candidate().stats, skipsUnder2s24h: 600, impressions24h: 1000 } });
    expect(qualityPenalty(bad, W, M)).toBeCloseTo(0.4952381, 6);
  });
  // Reports and not-interested are lifetime counters and must gate on lifetime
  // impressions, not on the 24h window — otherwise a video having a quiet day
  // would have its whole report history discounted to nothing.
  it('gates the lifetime penalties on lifetime impressions, not the 24h window', () => {
    // Identical 10% report rate; only the lifetime evidence behind it differs.
    // Both have an empty 24h window, so the fast-skip term is 0.5 for both and
    // any difference between them has to come from the lifetime gate.
    const thin = candidate({ stats: {
      ...candidate().stats, impressions24h: 0, impressionsAll: 20, reportsAll: 2,
    } });
    const thick = candidate({ stats: {
      ...candidate().stats, impressions24h: 0, impressionsAll: 50_000, reportsAll: 5_000,
    } });

    // Were reports gated on impressions24h, both would sit at 0.5 and tie.
    expect(qualityPenalty(thick, W, M)).toBeGreaterThan(qualityPenalty(thin, W, M));
    expect(qualityPenalty(thick, W, M)).toBeCloseTo(0.5500799, 6);
    expect(qualityPenalty(thin, W, M)).toBeCloseTo(0.5214286, 6);
  });
});

describe('engagementSignal', () => {
  // Likes are absent by construction: the spec says they correlate poorly with
  // purchase, so a like count cannot influence this score at all.
  it('ignores likes entirely', () => {
    const base = candidate({ stats: { ...candidate().stats, completions24h: 500 } });
    const withLikes = { ...base, stats: { ...base.stats } } as Candidate & { stats: { likes24h?: number } };
    (withLikes.stats as Record<string, number>).likes24h = 100_000;
    expect(engagementSignal(withLikes, W, M)).toBe(engagementSignal(base, W, M));
  });
  it('weights completion most heavily', () => {
    const base = candidate();
    const complete = candidate({ stats: { ...base.stats, completions24h: 1000 } });
    // Isolating completion: going from 0% to 100% moves engagement by exactly
    // its 0.40 weight. (The absolute value carries a small floor from the
    // share/save Bayesian priors, which is why this is a difference.)
    expect(engagementSignal(complete, W, M) - engagementSignal(base, W, M)).toBeCloseTo(0.4, 10);
  });
  // Completion is bounded 0-1 by construction so it is never median-normalised,
  // but it IS gated: 3-for-3 is not a 100% completion rate, it is three views.
  it('gates completion too — 3-for-3 is worth almost nothing', () => {
    const at = (impressions: number, completions: number) =>
      engagementSignal(candidate({ stats: {
        ...candidate().stats,
        impressions24h: impressions, impressionsAll: impressions, completions24h: completions,
      } }), W, M);

    // What going from 0% to 100% completion is worth, measured at one
    // impression count at a time so only the gate on completion can move it.
    const thinGain = at(3, 3) - at(3, 0);
    const thickGain = at(5_000, 5_000) - at(5_000, 0);

    expect(thinGain).toBeCloseTo(0.4 * (3 / 100), 10); // 0.012
    expect(thickGain).toBeCloseTo(0.4, 10); // the full weight, fully believed
    expect(thickGain / thinGain).toBeCloseTo(100 / 3, 6);
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
  // Affinity is measured over the VIEWER's history; the video's impression
  // count is not its sample size, so gating it on that would be a category
  // error. A viewer who loves this category loves it on a video with 0 views.
  it('is not gated by the candidate\'s impression count', () => {
    const viewer = {
      categoryAffinity: { c1: 1 }, sellerAffinity: {}, hashtagAffinity: {},
      priceBand: BAND, coldStartComplete: true,
    };
    const unseen = candidate({ stats: { ...candidate().stats, impressions24h: 0, impressionsAll: 0 } });
    expect(affinitySignal(unseen, viewer, W)).toBe(affinitySignal(candidate(), viewer, W));
  });
});

// ---------------------------------------------------------------------------
// v2: THE EVIDENCE GATE
// ---------------------------------------------------------------------------

describe('the evidence gate, at signal level', () => {
  /**
   * THE HEADLINE CASE (spec 2.2).
   *
   * The spec's own report of the v1 failure: "A video with 1 purchase in 3
   * impressions beat one with 90 purchases in 20,000 in testing, because 1-in-3
   * genuinely IS extreme evidence — it is just extremely noisy evidence."
   *
   * Both videos live in a category whose median purchase rate is 0.2%, so
   * 90/20,000 (0.45%) is a genuinely strong performer and not merely a big one.
   * The fluke's funnel is perfect: every one of its three viewers tapped,
   * carted and bought.
   */
  const PROVEN_CATEGORY = withCategory({
    proven: { purchaseRate: 0.002, cartRate: 0.006, tapRate: 0.03 },
  });

  const fluke = candidate({
    videoId: 'fluke', categoryId: 'proven',
    stats: {
      ...candidate().stats,
      impressions24h: 3, impressionsAll: 3,
      purchases24h: 1, addToCarts24h: 1, productTaps24h: 1,
    },
  });

  const proven = candidate({
    videoId: 'proven', categoryId: 'proven',
    stats: {
      ...candidate().stats,
      impressions24h: 20_000, impressionsAll: 20_000,
      purchases24h: 90, addToCarts24h: 260, productTaps24h: 900,
    },
  });

  it('does not let 1 purchase in 3 impressions outrank 90 in 20,000', () => {
    const flukeScore = commerceSignal(fluke, W, PROVEN_CATEGORY);
    const provenScore = commerceSignal(proven, W, PROVEN_CATEGORY);

    expect(flukeScore).toBeCloseTo(0.5122170, 6);
    expect(provenScore).toBeCloseTo(0.8139651, 6);
    expect(provenScore).toBeGreaterThan(flukeScore);
  });

  // The proof that it is the GATE doing this, and not the Bayesian smoothing
  // that v1 already had. Remove the gate from commerceSignal and the first
  // assertion above flips; this one documents exactly what it flips to.
  it('is the gate, not the smoothing — v1 ranked the fluke FIRST', () => {
    const flukeV1 = ungatedCommerce(fluke, PROVEN_CATEGORY);
    const provenV1 = ungatedCommerce(proven, PROVEN_CATEGORY);

    expect(flukeV1).toBeCloseTo(0.9072327, 6);
    expect(provenV1).toBeCloseTo(0.8139651, 6);
    expect(flukeV1).toBeGreaterThan(provenV1);

    // The high-volume video is untouched by the gate — it already had all the
    // evidence anyone could ask for. Only the fluke moves.
    expect(commerceSignal(proven, W, PROVEN_CATEGORY)).toBeCloseTo(provenV1, 12);
    expect(commerceSignal(fluke, W, PROVEN_CATEGORY)).toBeLessThan(flukeV1);
  });

  it('gates every rate-based signal to exactly 0.5 at zero impressions', () => {
    const unseen = candidate({ stats: {
      ...candidate().stats, impressions24h: 0, impressionsAll: 0,
      purchases24h: 0, addToCarts24h: 0, productTaps24h: 0,
    } });
    // Each signal's internal weights sum to 1, so "every term neutral" is 0.5.
    expect(commerceSignal(unseen, W, M)).toBe(0.5);
    expect(engagementSignal(unseen, W, M)).toBe(0.5);
    expect(qualityPenalty(unseen, W, M)).toBe(0.5);
  });

  it('leaves a signal past the threshold entirely alone', () => {
    // At exactly the category median for all three commerce rates, and far past
    // the 100-impression threshold: the gate is the identity, and what is left
    // is pure 2.5x-median normalisation.
    const atMedian = candidate({ categoryId: null, stats: {
      ...candidate().stats,
      impressions24h: 100_000, impressionsAll: 100_000,
      purchases24h: 0.02 * 100_000, addToCarts24h: 0.048 * 100_000, productTaps24h: 0.14 * 100_000,
    } });
    expect(commerceSignal(atMedian, W, M)).toBeCloseTo(0.4, 10);
  });

  it('relaxes its grip monotonically as impressions accumulate 0 -> 100', () => {
    // One video converting at a steady 2x the category median, observed over
    // ever more impressions. Nothing about the video changes; only the evidence
    // behind it does, and its score must climb the whole way without a cliff.
    //
    // All three commerce medians are 0.02 here, so the three terms are
    // identical and commerceSignal equals a single gated term exactly (its
    // weights sum to 1). 2x the median is 0.8 of the reference — below the clamp.
    const mono: CategoryMedians = {
      byCategory: {},
      fallback: { ...ZERO_MEDIANS, purchaseRate: 0.02, cartRate: 0.02, tapRate: 0.02 },
    };
    const at = (impressions: number) => {
      const n = 0.04 * impressions; // 1, 2, 3, 4 at 25 / 50 / 75 / 100 impressions
      return commerceSignal(candidate({ categoryId: null, stats: {
        ...candidate().stats,
        impressions24h: impressions, impressionsAll: impressions,
        purchases24h: n, addToCarts24h: n, productTaps24h: n,
      } }), W, mono);
    };

    const series = [0, 25, 50, 75, 100].map(at);
    expect(series[0]).toBe(0.5);
    expect(series[1]).toBeCloseTo(0.5083333, 6);
    expect(series[2]).toBeCloseTo(0.55, 10);
    expect(series[3]).toBeCloseTo(0.605, 10);
    expect(series[4]).toBeCloseTo(0.6666667, 6);
    for (let i = 1; i < series.length; i += 1) {
      expect(series[i]!).toBeGreaterThan(series[i - 1]!);
    }

    // Past the threshold the gate is done; further movement is the Bayesian
    // smoothing converging on the observed rate, not the gate letting go.
    expect(at(1_000)).toBeCloseTo(0.7809524, 6);
  });
});

// ---------------------------------------------------------------------------
// v2: 2.5x CATEGORY-MEDIAN NORMALISATION
// ---------------------------------------------------------------------------

describe('category-median normalisation', () => {
  it('scores a video AT the category median at 0.4, not 1.0', () => {
    const atMedian = candidate({ categoryId: null, stats: {
      ...candidate().stats,
      impressions24h: 100_000, impressionsAll: 100_000,
      purchases24h: 0.02 * 100_000, addToCarts24h: 0.048 * 100_000, productTaps24h: 0.14 * 100_000,
    } });
    const s = commerceSignal(atMedian, W, M);
    expect(s).toBeCloseTo(0.4, 10);
    // The whole point of the 2.5x: average is not excellent.
    expect(s).not.toBeCloseTo(1, 2);
  });

  it('reads the same raw rate differently in two categories', () => {
    // 20 purchases in 1,000 impressions — 2% — is double the median in a
    // category that converts at 1% and half the median in one at 4%.
    const medians = withCategory({ niche: { purchaseRate: 0.01 }, hot: { purchaseRate: 0.04 } });
    const stats = { ...candidate().stats, purchases24h: 20 };
    const niche = commerceSignal(candidate({ categoryId: 'niche', stats }), W, medians);
    const hot = commerceSignal(candidate({ categoryId: 'hot', stats }), W, medians);

    expect(niche).toBeCloseTo(0.3619048, 6);
    expect(hot).toBeCloseTo(0.1047619, 6);
    expect(niche).toBeGreaterThan(hot);
  });

  it('falls through to the global median for a rate a category has not measured', () => {
    // Purchases only, so the purchase median is the only thing that can move
    // the answer (see the zero-conversion invariance test below).
    const stats = { ...candidate().stats, purchases24h: 20, addToCarts24h: 0, productTaps24h: 0 };
    const partial = candidate({ categoryId: 'partial', stats });
    const unknown = candidate({ categoryId: 'unknown', stats });

    // 'partial' has measured a cart median but never a purchase median, so its
    // purchases must be scored exactly as an unmeasured category's would be.
    const cartOnly = withCategory({ partial: { cartRate: 0.006 } });
    expect(commerceSignal(partial, W, cartOnly))
      .toBeCloseTo(commerceSignal(unknown, W, cartOnly), 12);

    // And that is not vacuous: overriding the purchase median instead DOES move
    // it, so the equality above is fall-through and not indifference.
    const purchaseOverride = withCategory({ partial: { purchaseRate: 0.001 } });
    expect(commerceSignal(partial, W, purchaseOverride))
      .not.toBeCloseTo(commerceSignal(unknown, W, purchaseOverride), 6);
  });

  // Worth pinning because it is surprising: with zero conversions the median
  // cancels out. smoothed/reference = (alpha*m) / ((imp+alpha) * 2.5*m), and the
  // m divides away, leaving alpha / (2.5 * (imp + alpha)). A video that has
  // converted nobody scores the same everywhere — its evidence is "none", and
  // none is not category-specific.
  it('is median-invariant for a video with zero conversions', () => {
    const none = { ...candidate().stats, purchases24h: 0, addToCarts24h: 0, productTaps24h: 0 };
    const cheap = withCategory({ x: { purchaseRate: 0.0001, cartRate: 0.0001, tapRate: 0.0001 } });
    const rich = withCategory({ x: { purchaseRate: 0.4, cartRate: 0.4, tapRate: 0.4 } });
    const c = candidate({ categoryId: 'x', stats: none });

    const expected = W.bayesAlpha / (W.normReferenceMultiplier * (1000 + W.bayesAlpha));
    expect(commerceSignal(c, W, cheap)).toBeCloseTo(expected, 12);
    expect(commerceSignal(c, W, rich)).toBeCloseTo(expected, 12);
    expect(expected).toBeCloseTo(0.0190476, 6);
  });

  it('puts an uncategorised video in the empty-string bucket', () => {
    const medians = withCategory({ '': { purchaseRate: 0.001 } });
    const stats = { ...candidate().stats, purchases24h: 20 };
    expect(commerceSignal(candidate({ categoryId: null, stats }), W, medians))
      .toBeGreaterThan(commerceSignal(candidate({ categoryId: 'other', stats }), W, medians));
  });

  // 2.5 * 0 is a reference of 0. Dividing by it would be Infinity, or NaN at
  // 0/0, and would silently pin every video in a brand-new category to the top.
  it('never produces NaN or Infinity when no median exists at all', () => {
    const noMedians: CategoryMedians = { byCategory: {}, fallback: ZERO_MEDIANS };
    const cases = [
      candidate(),
      candidate({ categoryId: null, stats: { ...candidate().stats, impressions24h: 0, impressionsAll: 0 } }),
      candidate({ stats: {
        ...candidate().stats, purchases24h: 500, addToCarts24h: 900, productTaps24h: 1000,
        completions24h: 1000, shares24h: 1000, saves24h: 1000, avgLoopCount: 12,
        skipsUnder2s24h: 1000, reportsAll: 1000, notInterestedAll: 1000,
      } }),
    ];
    for (const c of cases) {
      for (const v of [
        commerceSignal(c, W, noMedians),
        engagementSignal(c, W, noMedians),
        qualityPenalty(c, W, noMedians),
      ]) {
        expect(Number.isFinite(v)).toBe(true);
        expect(Number.isNaN(v)).toBe(false);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('survives a category median of exactly zero by using the global one', () => {
    const medians: CategoryMedians = { byCategory: { cold: { purchaseRate: 0 } }, fallback: M.fallback };
    const stats = { ...candidate().stats, purchases24h: 20 };
    expect(commerceSignal(candidate({ categoryId: 'cold', stats }), W, medians))
      .toBeCloseTo(commerceSignal(candidate({ categoryId: 'unknown', stats }), W, medians), 12);
  });
});

// ---------------------------------------------------------------------------
// Commerce, diversity, hashtags
// ---------------------------------------------------------------------------

describe('commerceSignal', () => {
  it('rewards purchases far above taps', () => {
    const base = candidate();
    const buys = candidate({ stats: { ...base.stats, purchases24h: 50 } });
    const taps = candidate({ stats: { ...base.stats, productTaps24h: 50 } });
    expect(commerceSignal(buys, W, M)).toBeGreaterThan(commerceSignal(taps, W, M));
    expect(commerceSignal(buys, W, M)).toBeCloseTo(0.4476190, 6);
    expect(commerceSignal(taps, W, M)).toBeCloseTo(0.0530612, 6);
  });

  it('is exactly neutral, not 0, for a video with no impressions and no medians', () => {
    const c = candidate({ stats: { ...candidate().stats, impressions24h: 0, impressionsAll: 0 } });
    const zero: CategoryMedians = { byCategory: {}, fallback: ZERO_MEDIANS };
    // v1 returned 0 here, which said "this video is terrible" about a video
    // nobody has ever seen. v2 says "we do not know", which is 0.5.
    expect(commerceSignal(c, W, zero)).toBe(0.5);
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

// ---------------------------------------------------------------------------
// Dead video detection
// ---------------------------------------------------------------------------

describe('isDeadVideo', () => {
  const withSkips = (skips: number, impressions: number) =>
    candidate({ stats: {
      ...candidate().stats,
      impressions24h: impressions, impressionsAll: impressions, skipsUnder2s24h: skips,
    } });

  it('exposes the thresholds the spec states', () => {
    expect(DEAD_VIDEO_SKIP_RATE).toBe(0.6);
    expect(DEAD_VIDEO_MIN_IMPRESSIONS).toBe(200);
  });

  it('is dead above 0.6 skips with 200+ impressions', () => {
    const v = isDeadVideo(withSkips(124, 200)); // 0.62
    expect(v.dead).toBe(true);
    expect(v.reason).toBe('fast-skip-death');
    expect(v.skipUnder2sRate).toBeCloseTo(0.62, 10);
    expect(v.impressions).toBe(200);
  });

  // Boundary: exactly 0.6 at exactly 200. The spec says "> 0.6", so a video
  // sitting precisely on the line survives — ties go to the seller.
  it('survives at exactly 0.6 with exactly 200 impressions', () => {
    const v = isDeadVideo(withSkips(120, 200));
    expect(v.skipUnder2sRate).toBe(0.6);
    expect(v.dead).toBe(false);
    expect(v.reason).toBe('skip-rate-acceptable');
  });

  it('is dead one skip above the line at exactly 200 impressions', () => {
    const v = isDeadVideo(withSkips(121, 200));
    expect(v.dead).toBe(true);
    expect(v.reason).toBe('fast-skip-death');
  });

  it('is not dead one impression below the floor, however bad the rate', () => {
    const v = isDeadVideo(withSkips(199, 199)); // 100% skip rate
    expect(v.dead).toBe(false);
    expect(v.reason).toBe('insufficient-impressions');
    expect(v.skipUnder2sRate).toBeCloseTo(1, 10);
    // The 200-impression floor IS this function's evidence gate. Killing a
    // video on 199 impressions is the same mistake the gate exists to prevent.
    expect(v.impressions).toBe(199);
  });

  it('is not dead with no impressions at all', () => {
    const v = isDeadVideo(withSkips(0, 0));
    expect(v.dead).toBe(false);
    expect(v.reason).toBe('insufficient-impressions');
    expect(v.skipUnder2sRate).toBe(0);
  });

  // The spec is explicit that silent burial loses founding sellers, so a bare
  // boolean is not a usable answer: the caller has to write the seller an email.
  it('always returns a WHY, distinct per outcome, quoting the real numbers', () => {
    const dead = isDeadVideo(withSkips(700, 1000));
    const thin = isDeadVideo(withSkips(90, 100));
    const fine = isDeadVideo(withSkips(100, 1000));

    for (const v of [dead, thin, fine]) {
      expect(v.explanation.length).toBeGreaterThan(40);
      expect(v.skipRateThreshold).toBe(DEAD_VIDEO_SKIP_RATE);
      expect(v.impressionsThreshold).toBe(DEAD_VIDEO_MIN_IMPRESSIONS);
    }

    expect(new Set([dead.reason, thin.reason, fine.reason]).size).toBe(3);
    expect(new Set([dead.explanation, thin.explanation, fine.explanation]).size).toBe(3);

    // The numbers the seller needs to act are in the text, not just the fields.
    expect(dead.explanation).toContain('70.0%');
    expect(dead.explanation).toContain('1000 impressions');
    expect(thin.explanation).toContain('100 impressions');
    expect(thin.explanation).toContain('200');
    expect(fine.explanation).toContain('10.0%');
  });

  it('is pure — the same candidate always yields the same verdict', () => {
    const c = withSkips(700, 1000);
    expect(isDeadVideo(c)).toEqual(isDeadVideo(c));
  });
});
