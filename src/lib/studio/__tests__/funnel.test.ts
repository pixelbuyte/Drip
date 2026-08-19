import { describe, expect, it } from 'vitest';
import type { FunnelStep, FunnelStepKey } from '../types';
import {
  EMPTY_MEDIANS,
  FUNNEL_STEP_LABELS,
  MEANINGFUL_SHORTFALL,
  MIN_FUNNEL_IMPRESSIONS,
  MIN_MEDIAN_SAMPLE,
  MIN_STEP_SAMPLE,
  assessFunnel,
  buildFunnel,
  buildRetentionCurve,
  buildSteps,
  buildTrafficSources,
  categoryMedians,
  clockLabel,
  conversionPct,
  median,
  reachBenchmark,
  stepRatio,
  type CategoryMedians,
  type FunnelCounts,
} from '../funnel';

/* ── helpers ──────────────────────────────────────────────────────────────
   `meds` fabricates a benchmark with a sample size well past the minimum, so
   a test about SELECTION is never accidentally a test about sample size.   */

const meds = (m: Partial<CategoryMedians>): CategoryMedians => ({
  ...EMPTY_MEDIANS,
  sampleSize: 40,
  ...m,
});

const counts = (c: Partial<FunnelCounts>): FunnelCounts => ({
  impressions: 0,
  stayed: 0,
  taps: 0,
  addToCarts: 0,
  purchases: 0,
  ...c,
});

/** A hand-built rung, for testing the comparator independently of the funnel. */
const step = (
  key: FunnelStepKey,
  n: number,
  ratePct: number | null,
  medianRatePct: number | null
): FunnelStep => ({
  key,
  label: FUNNEL_STEP_LABELS[key],
  count: n,
  ratePct,
  medianRatePct,
  ratio: stepRatio(ratePct, medianRatePct),
});

/* ═══════════════════════════════════════════════════════════════════════════
   SMALL MATHS
   ═══════════════════════════════════════════════════════════════════════════ */

describe('median', () => {
  it('is null for an empty sample — not 0, which would read as a real zero', () => {
    expect(median([])).toBeNull();
  });

  it('takes the middle of an odd sample', () => {
    expect(median([5, 1, 3])).toBe(3);
  });

  it('averages the middle pair of an even sample', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('ignores NaN and Infinity rather than propagating them', () => {
    expect(median([1, Number.NaN, 3, Number.POSITIVE_INFINITY])).toBe(2);
  });
});

describe('conversionPct', () => {
  it('is null when the rung above is empty — 0 of 0 is unknown, not 0%', () => {
    expect(conversionPct(0, 0)).toBeNull();
    expect(conversionPct(0, 5)).toBeNull();
  });

  it('is 0 when people arrived and none converted', () => {
    expect(conversionPct(100, 0)).toBe(0);
  });

  it('clamps at 100 — taps are not deduplicated per viewer, impressions are', () => {
    expect(conversionPct(100, 137)).toBe(100);
  });

  it('matches video_stats: 198 of 412 is 48%', () => {
    expect(conversionPct(412, 198)).toBeCloseTo(48.058, 3);
  });
});

describe('stepRatio', () => {
  it('is null when either side is unknown', () => {
    expect(stepRatio(null, 20)).toBeNull();
    expect(stepRatio(20, null)).toBeNull();
  });

  it('is null when the median is 0 — dividing by it would fabricate infinity', () => {
    expect(stepRatio(20, 0)).toBeNull();
  });

  it('is the multiple against the median', () => {
    expect(stepRatio(48, 34)).toBeCloseTo(1.4118, 4);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   MEDIANS
   ═══════════════════════════════════════════════════════════════════════════ */

describe('categoryMedians', () => {
  it('publishes nothing for an empty category', () => {
    expect(categoryMedians([])).toEqual(EMPTY_MEDIANS);
  });

  it('withholds a rung until MIN_MEDIAN_SAMPLE peers can answer it', () => {
    const peers = Array.from({ length: MIN_MEDIAN_SAMPLE - 1 }, () =>
      counts({ impressions: 100, stayed: 50, taps: 10, addToCarts: 5, purchases: 1 })
    );
    const m = categoryMedians(peers);
    expect(m.watchedPct).toBeNull();
    expect(m.tapPct).toBeNull();
    expect(m.sampleSize).toBe(MIN_MEDIAN_SAMPLE - 1);
  });

  it('draws each rung only from the peers that reached it', () => {
    // Five peers. Four of them have a cart; the fifth never got one, so it can
    // contribute no cart→purchase rate and that rung stays null.
    const peers: FunnelCounts[] = [
      counts({ impressions: 100, stayed: 10, taps: 2, addToCarts: 0, purchases: 0 }),
      counts({ impressions: 100, stayed: 20, taps: 4, addToCarts: 2, purchases: 1 }),
      counts({ impressions: 100, stayed: 30, taps: 6, addToCarts: 3, purchases: 1 }),
      counts({ impressions: 100, stayed: 40, taps: 8, addToCarts: 4, purchases: 1 }),
      counts({ impressions: 100, stayed: 50, taps: 10, addToCarts: 5, purchases: 1 }),
    ];
    const m = categoryMedians(peers);

    expect(m.impressions).toBe(100);
    expect(m.watchedPct).toBe(30); // 10,20,30,40,50
    expect(m.tapPct).toBe(20); // every peer taps at 20%
    expect(m.cartPct).toBe(50); // 0,50,50,50,50
    expect(m.purchasePct).toBeNull(); // only four peers had a cart
    expect(m.sampleSize).toBe(5);
  });
});

describe('reachBenchmark', () => {
  it('compares impressions as a count, which is what the spec row shows', () => {
    expect(reachBenchmark(412, meds({ impressions: 180 }))).toEqual({
      medianImpressions: 180,
      ratio: 412 / 180,
    });
  });

  it('has no ratio without a median', () => {
    expect(reachBenchmark(412, EMPTY_MEDIANS)).toEqual({
      medianImpressions: null,
      ratio: null,
    });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   THE STEPS
   ═══════════════════════════════════════════════════════════════════════════ */

describe('buildSteps', () => {
  it('is always five rungs, widest to narrowest', () => {
    const steps = buildSteps(counts({}), EMPTY_MEDIANS);
    expect(steps.map((s) => s.key)).toEqual([
      'impressions',
      'watched',
      'taps',
      'add_to_cart',
      'purchases',
    ]);
  });

  it('leaves the first rung with no rate — it converts from nothing', () => {
    const steps = buildSteps(counts({ impressions: 412 }), meds({ watchedPct: 34 }));
    expect(steps[0].ratePct).toBeNull();
    expect(steps[0].ratio).toBeNull();
  });

  it('rates each rung against the one above it, not against impressions', () => {
    const steps = buildSteps(
      counts({ impressions: 412, stayed: 198, taps: 38, addToCarts: 11, purchases: 3 }),
      EMPTY_MEDIANS
    );
    expect(steps[1].ratePct).toBeCloseTo(48.06, 2); // 198/412
    expect(steps[2].ratePct).toBeCloseTo(19.19, 2); // 38/198, not 38/412
    expect(steps[3].ratePct).toBeCloseTo(28.95, 2); // 11/38
    expect(steps[4].ratePct).toBeCloseTo(27.27, 2); // 3/11
  });

  it('reports raw counts even when a rung over-delivers, and clamps only the rate', () => {
    const steps = buildSteps(counts({ impressions: 100, stayed: 137 }), EMPTY_MEDIANS);
    expect(steps[1].count).toBe(137);
    expect(steps[1].ratePct).toBe(100);
  });

  it('survives negative and non-finite counters from a half-migrated table', () => {
    const steps = buildSteps(
      counts({ impressions: -5, stayed: Number.NaN, taps: 3 }),
      EMPTY_MEDIANS
    );
    expect(steps.map((s) => s.count)).toEqual([0, 0, 3, 0, 0]);
    expect(steps[1].ratePct).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   DROP-OFF SELECTION — the part that does damage if it is wrong
   ═══════════════════════════════════════════════════════════════════════════ */

describe('assessFunnel — which rung gets named', () => {
  it('picks the worst RELATIVE drop, not the largest absolute one', () => {
    // Absolute losses: 600 (impressions→stayed), 300, 60, 36. The biggest is
    // the first rung, as it is on literally every video. Relative to the
    // category, though, the first rung is fine and the last rung is halved.
    const steps = buildSteps(
      counts({ impressions: 1000, stayed: 400, taps: 100, addToCarts: 40, purchases: 4 }),
      meds({ watchedPct: 45, tapPct: 30, cartPct: 40, purchasePct: 25 })
    );

    expect(steps[1].count - steps[0].count).toBe(-600); // biggest absolute drop
    const assessment = assessFunnel(steps);

    expect(assessment.kind).toBe('drop_off');
    if (assessment.kind !== 'drop_off') throw new Error('unreachable');
    expect(assessment.diagnosis.step).toBe('purchases'); // smallest absolute drop
  });

  it('breaks a ratio tie toward the rung that lost more people', () => {
    const steps = [
      step('impressions', 1000, null, null),
      step('watched', 500, 50, 50), // ratio 1.0 — fine
      step('taps', 100, 20, 40), // ratio 0.5, lost 500 * 0.20 = 100
      step('add_to_cart', 40, 40, 80), // ratio 0.5, lost 100 * 0.40 = 40
      step('purchases', 4, 10, 12), // ratio 0.83 — inside the noise band
    ];

    const assessment = assessFunnel(steps);
    expect(assessment.kind).toBe('drop_off');
    if (assessment.kind !== 'drop_off') throw new Error('unreachable');
    expect(assessment.diagnosis.step).toBe('taps');
  });

  it('breaks a total tie toward the earlier rung, so the answer is deterministic', () => {
    // A funnel cannot really put the same number of people on two rungs with
    // the same rate and the same median — this input is synthetic, and exists
    // only to pin the last tie-break so the output can never depend on
    // iteration order.
    const steps = [
      step('impressions', 100, null, null),
      step('watched', 100, 50, 100), // ratio 0.5, prev 100, lost 50
      step('taps', 50, 50, 100), // ratio 0.5, prev 100, lost 50
      step('add_to_cart', 25, 90, 90),
      step('purchases', 20, 90, 90),
    ];

    const assessment = assessFunnel(steps);
    expect(assessment.kind).toBe('drop_off');
    if (assessment.kind !== 'drop_off') throw new Error('unreachable');
    expect(assessment.diagnosis.step).toBe('watched');
  });

  it('skips a rung whose category median is missing and names the next-worst', () => {
    // Taps is by far the worst rate on the page (4%), but the category has no
    // honest median for it. Diagnosing it anyway would be inventing a
    // benchmark; the screen falls to the rung that does have one.
    const steps = buildSteps(
      counts({ impressions: 1000, stayed: 800, taps: 32, addToCarts: 16, purchases: 2 }),
      meds({ watchedPct: 70, tapPct: null, cartPct: 50, purchasePct: 40 })
    );

    expect(steps[2].ratio).toBeNull();
    const assessment = assessFunnel(steps);
    expect(assessment.kind).toBe('drop_off');
    if (assessment.kind !== 'drop_off') throw new Error('unreachable');
    expect(assessment.diagnosis.step).toBe('purchases'); // 12.5% vs 40% = 0.31x
  });

  it('will not diagnose a rung fed by fewer than MIN_STEP_SAMPLE people', () => {
    // 1 of 3 people bought. That is 33% against a 90% median and it means
    // nothing whatsoever.
    const steps = [
      step('impressions', 600, null, null),
      step('watched', 400, 66.7, 60),
      step('taps', 60, 15, 14),
      step('add_to_cart', MIN_STEP_SAMPLE - 7, 5, 5),
      step('purchases', 1, 33, 90), // ratio 0.37, but prev is only 3 people
    ];

    // Without the guard this reads as a 0.37x leak and gets named. With it,
    // the funnel is correctly reported as having nothing worth changing.
    expect(steps[4].ratio).toBeLessThan(1 - MEANINGFUL_SHORTFALL);
    expect(assessFunnel(steps).kind).toBe('healthy');
  });
});

describe('assessFunnel — the states that are not a leak', () => {
  it('says nothing at all about a funnel with zero impressions', () => {
    const funnel = buildFunnel({ videoId: 'v1', counts: counts({}) });
    expect(funnel.assessment.kind).toBe('no_impressions');
    expect(funnel.dropOff).toBeNull();
    expect(funnel.steps.every((s) => s.count === 0)).toBe(true);
  });

  it('still says nothing when the category is busy but this video has no reach', () => {
    const peers = Array.from({ length: 20 }, () =>
      counts({ impressions: 500, stayed: 300, taps: 60, addToCarts: 20, purchases: 5 })
    );
    const funnel = buildFunnel({ videoId: 'v1', counts: counts({}), peers });
    expect(funnel.assessment.kind).toBe('no_impressions');
  });

  it('holds off while the video is still below MIN_FUNNEL_IMPRESSIONS', () => {
    const steps = buildSteps(
      counts({ impressions: MIN_FUNNEL_IMPRESSIONS - 1, stayed: 5, taps: 1 }),
      meds({ watchedPct: 60, tapPct: 20, cartPct: 30, purchasePct: 20 })
    );
    const assessment = assessFunnel(steps);
    expect(assessment.kind).toBe('too_early');
    if (assessment.kind !== 'too_early') throw new Error('unreachable');
    expect(assessment.needed).toBe(MIN_FUNNEL_IMPRESSIONS);
  });

  it('reports no benchmark rather than a benchmark it does not have', () => {
    const steps = buildSteps(
      counts({ impressions: 500, stayed: 100, taps: 5, addToCarts: 1, purchases: 0 }),
      EMPTY_MEDIANS
    );
    const assessment = assessFunnel(steps);
    expect(assessment.kind).toBe('no_benchmark');
    if (assessment.kind !== 'no_benchmark') throw new Error('unreachable');
    expect(assessment.needed).toBe(MIN_MEDIAN_SAMPLE);
  });

  it('manufactures no problem for a funnel that beats the median everywhere', () => {
    const steps = buildSteps(
      counts({ impressions: 1000, stayed: 700, taps: 210, addToCarts: 84, purchases: 42 }),
      meds({ watchedPct: 50, tapPct: 20, cartPct: 30, purchasePct: 40 })
    );

    const assessment = assessFunnel(steps);
    expect(assessment.kind).toBe('healthy');
    if (assessment.kind !== 'healthy') throw new Error('unreachable');

    expect(assessment.aboveMedianEverywhere).toBe(true);
    expect(assessment.headline).toContain('every step');
    // It still has to say what to do next: a number with no implied action is
    // decoration, and "post again" is the only lever left on a healthy video.
    expect(assessment.detail).toMatch(/post|freshness/i);
    expect(buildFunnel({ videoId: 'v1', counts: counts({ impressions: 0 }) }).dropOff).toBeNull();
  });

  it('treats a rung just inside the noise band as healthy, and just outside as a leak', () => {
    const onEdge = 100 * (1 - MEANINGFUL_SHORTFALL); // exactly 0.85x
    const inside = buildSteps(
      counts({ impressions: 1000, stayed: 850, taps: 850, addToCarts: 850, purchases: 850 }),
      meds({ watchedPct: 100, tapPct: 100, cartPct: 100, purchasePct: 100 })
    );
    expect(inside[1].ratePct).toBe(onEdge);
    expect(assessFunnel(inside).kind).toBe('healthy');

    const outside = buildSteps(
      counts({ impressions: 1000, stayed: 840, taps: 840, addToCarts: 840, purchases: 840 }),
      meds({ watchedPct: 100, tapPct: 100, cartPct: 100, purchasePct: 100 })
    );
    expect(assessFunnel(outside).kind).toBe('drop_off');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   THE SENTENCE ITSELF
   ═══════════════════════════════════════════════════════════════════════════ */

/** The spec's worked example, as this schema can actually measure it. */
const SPEC_EXAMPLE = counts({
  impressions: 412,
  stayed: 198,
  taps: 38,
  addToCarts: 11,
  purchases: 3,
});
const SPEC_MEDIANS = meds({
  impressions: 180,
  watchedPct: 34,
  tapPct: 15,
  cartPct: 25,
  purchasePct: 60,
});

describe('the drop-off diagnosis', () => {
  it('names the step, quantifies the gap, gives one cause and one lever', () => {
    const assessment = assessFunnel(buildSteps(SPEC_EXAMPLE, SPEC_MEDIANS), {
      checkoutOpens: 7,
    });
    expect(assessment.kind).toBe('drop_off');
    if (assessment.kind !== 'drop_off') throw new Error('unreachable');

    const { diagnosis } = assessment;
    expect(diagnosis.step).toBe('purchases');
    // The gap, with both numbers — the spec's sentence.
    expect(diagnosis.gapDescription).toContain('7 of the 11');
    expect(diagnosis.gapDescription).toContain('4 did not finish');
    expect(diagnosis.gapDescription).toContain('60%');
    expect(diagnosis.oneCause.length).toBeGreaterThan(0);
    expect(diagnosis.oneLever.length).toBeGreaterThan(0);
  });

  it('gives exactly one lever, whichever rung leaks', () => {
    const inputs: Array<[FunnelCounts, CategoryMedians, Record<string, unknown>]> = [
      [
        counts({ impressions: 1000, stayed: 200, taps: 40, addToCarts: 12, purchases: 5 }),
        meds({ watchedPct: 70, tapPct: 20, cartPct: 30, purchasePct: 40 }),
        {},
      ],
      [
        counts({ impressions: 1000, stayed: 200, taps: 40, addToCarts: 12, purchases: 5 }),
        meds({ watchedPct: 70, tapPct: 20, cartPct: 30, purchasePct: 40 }),
        { pinnedAtSecond: 9 },
      ],
      [
        counts({ impressions: 1000, stayed: 800, taps: 40, addToCarts: 20, purchases: 8 }),
        meds({ watchedPct: 70, tapPct: 20, cartPct: 50, purchasePct: 40 }),
        {},
      ],
      [
        counts({ impressions: 1000, stayed: 800, taps: 200, addToCarts: 20, purchases: 8 }),
        meds({ watchedPct: 70, tapPct: 20, cartPct: 50, purchasePct: 40 }),
        { productSoldOut: true },
      ],
      [SPEC_EXAMPLE, SPEC_MEDIANS, { checkoutOpens: 7 }],
      [
        SPEC_EXAMPLE,
        SPEC_MEDIANS,
        { checkoutOpens: 7, shippingChargedCents: 899, categoryShippingCents: 549 },
      ],
    ];

    for (const [c, m, evidence] of inputs) {
      const assessment = assessFunnel(buildSteps(c, m), evidence);
      expect(assessment.kind).toBe('drop_off');
      if (assessment.kind !== 'drop_off') throw new Error('unreachable');
      // One lever means one sentence. Two would let the seller change two
      // things and learn nothing from the result.
      expect(assessment.diagnosis.oneLever.match(/\./g) ?? []).toHaveLength(1);
    }
  });

  it('blames shipping only when it can show both numbers', () => {
    const withNumbers = assessFunnel(buildSteps(SPEC_EXAMPLE, SPEC_MEDIANS), {
      checkoutOpens: 7,
      shippingChargedCents: 899,
      categoryShippingCents: 549,
    });
    if (withNumbers.kind !== 'drop_off') throw new Error('unreachable');
    expect(withNumbers.diagnosis.oneCause).toContain('$8.99');
    expect(withNumbers.diagnosis.oneCause).toContain('$5.49');

    const withoutNumbers = assessFunnel(buildSteps(SPEC_EXAMPLE, SPEC_MEDIANS), {
      checkoutOpens: 7,
    });
    if (withoutNumbers.kind !== 'drop_off') throw new Error('unreachable');
    expect(withoutNumbers.diagnosis.oneCause).not.toMatch(/\$/);
  });

  it('does not blame shipping when the seller is already at the category median', () => {
    const assessment = assessFunnel(buildSteps(SPEC_EXAMPLE, SPEC_MEDIANS), {
      checkoutOpens: 7,
      shippingChargedCents: 560,
      categoryShippingCents: 549,
    });
    if (assessment.kind !== 'drop_off') throw new Error('unreachable');
    expect(assessment.diagnosis.oneCause).not.toContain('$5.49');
  });

  it('blames the sold-out product over the description when inventory is gone', () => {
    const leakyCart = counts({
      impressions: 1000,
      stayed: 800,
      taps: 200,
      addToCarts: 20,
      purchases: 8,
    });
    const m = meds({ watchedPct: 70, tapPct: 20, cartPct: 50, purchasePct: 40 });

    const stocked = assessFunnel(buildSteps(leakyCart, m), {});
    const soldOut = assessFunnel(buildSteps(leakyCart, m), { productSoldOut: true });
    if (stocked.kind !== 'drop_off' || soldOut.kind !== 'drop_off') {
      throw new Error('unreachable');
    }
    expect(stocked.diagnosis.step).toBe('add_to_cart');
    expect(soldOut.diagnosis.step).toBe('add_to_cart');
    expect(soldOut.diagnosis.oneCause).toMatch(/out of stock/i);
    expect(stocked.diagnosis.oneCause).not.toMatch(/out of stock/i);
  });

  it('uses the pin time only when the seller actually recorded one', () => {
    const weakHook = counts({
      impressions: 1000,
      stayed: 200,
      taps: 40,
      addToCarts: 12,
      purchases: 5,
    });
    const m = meds({ watchedPct: 70, tapPct: 20, cartPct: 30, purchasePct: 40 });

    const pinned = assessFunnel(buildSteps(weakHook, m), { pinnedAtSecond: 9 });
    const unpinned = assessFunnel(buildSteps(weakHook, m), {});
    if (pinned.kind !== 'drop_off' || unpinned.kind !== 'drop_off') {
      throw new Error('unreachable');
    }
    expect(pinned.diagnosis.step).toBe('watched');
    expect(pinned.diagnosis.oneCause).toContain('0:09');
    expect(unpinned.diagnosis.oneCause).not.toContain('0:09');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   END TO END
   ═══════════════════════════════════════════════════════════════════════════ */

describe('buildFunnel', () => {
  it('carries the diagnosis onto VideoFunnel.dropOff and nothing else', () => {
    const peers = Array.from({ length: 9 }, () =>
      counts({ impressions: 400, stayed: 140, taps: 21, addToCarts: 5, purchases: 3 })
    );
    const funnel = buildFunnel({
      videoId: 'abc',
      counts: SPEC_EXAMPLE,
      peers,
      evidence: { checkoutOpens: 7 },
    });

    expect(funnel.videoId).toBe('abc');
    expect(funnel.steps).toHaveLength(5);
    expect(funnel.medians.sampleSize).toBe(9);
    expect(funnel.reach.medianImpressions).toBe(400);
    expect(funnel.reach.ratio).toBeCloseTo(1.03, 2);
    expect(funnel.dropOff?.step).toBe(funnel.steps.find((s) => s.ratio !== null && s.ratio < 0.85)?.key);
  });

  it('leaves dropOff null in every state that is not a leak', () => {
    expect(buildFunnel({ videoId: 'a', counts: counts({}) }).dropOff).toBeNull();
    expect(
      buildFunnel({ videoId: 'b', counts: counts({ impressions: 10, stayed: 1 }) }).dropOff
    ).toBeNull();
    expect(buildFunnel({ videoId: 'c', counts: SPEC_EXAMPLE }).dropOff).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   RETENTION
   ═══════════════════════════════════════════════════════════════════════════ */

describe('buildRetentionCurve', () => {
  it('has nothing to draw with no impressions', () => {
    const curve = buildRetentionCurve(0, { q25: 0, q50: 0, q75: 0, q95: 0 });
    expect(curve.hasData).toBe(false);
    expect(curve.medianDropOffPct).toBeNull();
    expect(curve.points.every((p) => p.sharePct === 0)).toBe(true);
  });

  it('clamps a looping viewer back under the curve instead of drawing people rejoining', () => {
    // The 25/50/75/95 buckets re-arm on every loop, so a replayed video can
    // report more plays at 75% than at 50%. That is an event-contract
    // artefact, not people coming back.
    const curve = buildRetentionCurve(100, { q25: 60, q50: 30, q75: 55, q95: 20 });
    const plays = curve.points.map((p) => p.plays);
    expect(plays).toEqual([100, 60, 30, 30, 20]);
    for (let i = 1; i < plays.length; i += 1) {
      expect(plays[i]).toBeLessThanOrEqual(plays[i - 1]);
    }
  });

  it('finds where half the audience is gone, by interpolation', () => {
    // 100 -> 80 at 25% -> 40 at 50%. Half (50) falls three quarters of the way
    // from 25% to 50%: 25 + 25 * (80-50)/(80-40) = 43.75%.
    const curve = buildRetentionCurve(100, { q25: 80, q50: 40, q75: 30, q95: 20 }, 20);
    expect(curve.medianDropOffPct).toBeCloseTo(43.75, 4);
    expect(curve.medianDropOffSeconds).toBeCloseTo(8.75, 4);
    expect(curve.mostFinish).toBe(false);
  });

  it('has no drop-off point when most people finish', () => {
    const curve = buildRetentionCurve(100, { q25: 95, q50: 90, q75: 85, q95: 80 }, 30);
    expect(curve.medianDropOffPct).toBeNull();
    expect(curve.medianDropOffSeconds).toBeNull();
    expect(curve.mostFinish).toBe(true);
  });

  it('leaves timestamps unknown when the duration is not recorded', () => {
    const curve = buildRetentionCurve(100, { q25: 40, q50: 20, q75: 10, q95: 5 });
    expect(curve.medianDropOffPct).not.toBeNull();
    expect(curve.medianDropOffSeconds).toBeNull();
    expect(curve.points.every((p) => p.atSeconds === null)).toBe(true);
  });
});

describe('clockLabel', () => {
  it('formats seconds the way a video player does', () => {
    expect(clockLabel(0)).toBe('0:00');
    expect(clockLabel(4)).toBe('0:04');
    expect(clockLabel(9.4)).toBe('0:09');
    expect(clockLabel(83)).toBe('1:23');
  });

  it('is an em dash for anything it does not know', () => {
    expect(clockLabel(null)).toBe('—');
    expect(clockLabel(Number.NaN)).toBe('—');
    expect(clockLabel(-1)).toBe('—');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   TRAFFIC SOURCES
   ═══════════════════════════════════════════════════════════════════════════ */

describe('buildTrafficSources', () => {
  it('is empty when the video has not been served anywhere', () => {
    expect(buildTrafficSources({})).toEqual([]);
    expect(buildTrafficSources({ affinity: 0, fresh: 0 })).toEqual([]);
  });

  it('orders by size, drops empties, and shares sum to 100', () => {
    const sources = buildTrafficSources({
      affinity: 120,
      fresh: 500,
      trending: 0,
      social: 30,
      shared: 50,
    });
    expect(sources.map((s) => s.key)).toEqual(['fresh', 'affinity', 'shared', 'social']);
    expect(sources.reduce((sum, s) => sum + s.sharePct, 0)).toBeCloseTo(100, 6);
  });

  it('speaks seller language, never the candidate_lane enum', () => {
    const [source] = buildTrafficSources({ affinity: 1 });
    expect(source.label).toBe('For You (matched to interests)');
    expect(source.explanation.length).toBeGreaterThan(0);
  });
});
