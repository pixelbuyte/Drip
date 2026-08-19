import { describe, expect, it } from 'vitest';
import {
  GUARDRAIL_LIMITS,
  budgetDeliveryRate,
  budgetDeliveryReport,
  evaluateGuardrails,
  funnel,
  gini,
  impressionGini,
  laneMetrics,
  laneRpmWithin,
  qualitySortingRatio,
  qualitySortingReport,
  rpm,
  type BudgetObservation,
  type FunnelEvent,
  type LaneObservation,
} from '../guardrails';

// ---------------------------------------------------------------------------
// gini
// ---------------------------------------------------------------------------

/**
 * The mean-absolute-difference definition, quadratic and obviously correct:
 *
 *   G = SUM_i SUM_j |x_i - x_j| / (2 * n^2 * mean)
 *
 * The implementation uses the O(n log n) sorted formula instead. Cross-checking
 * one against the other is the point: an independent derivation catches an
 * off-by-one in the 1-indexed weight that no single hand vector would.
 */
function giniByMeanAbsoluteDifference(values: readonly number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  const total = values.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  let sumOfDifferences = 0;
  for (const a of values) for (const b of values) sumOfDifferences += Math.abs(a - b);
  return sumOfDifferences / (2 * n * total);
}

describe('gini — analytic values', () => {
  it('is 0 for perfect equality at any n', () => {
    expect(gini([5, 5, 5, 5])).toBe(0);
    expect(gini([0.7, 0.7])).toBe(0);
    expect(gini([3, 3, 3, 3, 3, 3, 3])).toBe(0);
    // Exactly 0, not -2.2e-16 and not -0: the clamp exists for this.
    expect(Object.is(gini([5, 5, 5]), 0)).toBe(true);
  });

  it('is exactly (n-1)/n when one holder has everything', () => {
    for (let n = 1; n <= 10; n += 1) {
      const values = Array.from({ length: n }, (_, i) => (i === n - 1 ? 10 : 0));
      expect(gini(values)).toBeCloseTo((n - 1) / n, 12);
    }
    // Worked by hand: [0,0,0,10] -> n=4, sum=10, SUM(i*x_i)=40,
    // G = 2*40/(4*10) - 5/4 = 2 - 1.25 = 0.75 = (4-1)/4.
    expect(gini([0, 0, 0, 10])).toBeCloseTo(0.75, 12);
  });

  // Hand-computed vectors. Each is worked in the doc comment on gini() and
  // re-derived here so a reviewer can check the formula without running it.
  it('matches [1,2,3,4] = 0.25', () => {
    // n=4, sum=10, SUM(i*x_i) = 1+4+9+16 = 30.
    // G = 2*30/(4*10) - 5/4 = 1.5 - 1.25 = 0.25
    expect(gini([1, 2, 3, 4])).toBeCloseTo(0.25, 12);
  });

  it('matches [1,1,1,1,6] = 0.4', () => {
    // n=5, sum=10, SUM(i*x_i) = 1+2+3+4+30 = 40.
    // G = 2*40/(5*10) - 6/5 = 1.6 - 1.2 = 0.4
    expect(gini([1, 1, 1, 1, 6])).toBeCloseTo(0.4, 12);
  });

  it('matches [100,200,300,400,500] = 0.2666...', () => {
    // n=5, sum=1500, SUM(i*x_i) = 100+400+900+1600+2500 = 5500.
    // G = 2*5500/(5*1500) - 6/5 = 1.466666... - 1.2 = 0.266666...
    expect(gini([100, 200, 300, 400, 500])).toBeCloseTo(4 / 15, 12);
  });

  it('agrees with the mean-absolute-difference definition on every fixture', () => {
    const fixtures = [
      [1, 2, 3, 4],
      [1, 1, 1, 1, 6],
      [100, 200, 300, 400, 500],
      [0, 0, 0, 10],
      [7],
      [2, 2],
      [0, 1, 1, 2, 3, 5, 8, 13, 21],
      [500, 500, 500, 12, 0, 0, 3, 90],
      [1, 1, 1, 1, 1, 1, 1, 1, 1, 999],
    ];
    for (const fixture of fixtures) {
      expect(gini(fixture)).toBeCloseTo(giniByMeanAbsoluteDifference(fixture), 12);
    }
  });
});

describe('gini — degenerate input', () => {
  it('is 0 for an empty population', () => {
    expect(gini([])).toBe(0);
  });

  it('is 0 for a single holder', () => {
    expect(gini([42])).toBe(0);
    expect(gini([0])).toBe(0);
  });

  it('is 0 when nothing was distributed at all', () => {
    // Not concentration — an outage. The caller must notice that from the
    // impression total, which is why this returns 0 rather than 1.
    expect(gini([0, 0, 0, 0])).toBe(0);
  });

  it('REJECTS negative values rather than clamping them', () => {
    expect(() => gini([1, 2, -3])).toThrow(RangeError);
    expect(() => gini([-1])).toThrow(/non-negative/);
  });

  it('REJECTS non-finite values', () => {
    expect(() => gini([1, Number.NaN])).toThrow(RangeError);
    expect(() => gini([1, Number.POSITIVE_INFINITY])).toThrow(RangeError);
  });
});

describe('gini — properties', () => {
  it('is scale invariant', () => {
    expect(gini([1, 2, 3, 4])).toBeCloseTo(gini([10, 20, 30, 40]), 12);
    expect(gini([1, 2, 3, 4])).toBeCloseTo(gini([0.001, 0.002, 0.003, 0.004]), 12);
  });

  it('is order invariant', () => {
    expect(gini([4, 1, 3, 2])).toBeCloseTo(gini([1, 2, 3, 4]), 12);
    expect(gini([10, 0, 0, 0])).toBeCloseTo(gini([0, 0, 0, 10]), 12);
  });

  it('never exceeds (n-1)/n', () => {
    const fixtures = [
      [1, 2, 3, 4],
      [0, 0, 0, 10],
      [1, 1, 1, 1, 1, 1, 1, 1, 1, 999],
      [5, 5, 5],
    ];
    for (const fixture of fixtures) {
      const n = fixture.length;
      expect(gini(fixture)).toBeLessThanOrEqual((n - 1) / n + 1e-12);
      expect(gini(fixture)).toBeGreaterThanOrEqual(0);
    }
  });

  it('rises when impressions move from a poorer seller to a richer one', () => {
    // Pigou-Dalton. [1,2,3,4] -> 0.25; move 1 from the poorest to the richest
    // giving [0,2,3,5]: n=4, sum=10, SUM(i*x_i) = 0+4+9+20 = 33,
    // G = 66/40 - 1.25 = 0.4.
    expect(gini([0, 2, 3, 5])).toBeCloseTo(0.4, 12);
    expect(gini([0, 2, 3, 5])).toBeGreaterThan(gini([1, 2, 3, 4]));
  });

  it('does not mutate or reorder the caller argument', () => {
    const sellers = [4, 1, 3, 2];
    gini(sellers);
    expect(sellers).toEqual([4, 1, 3, 2]);
  });
});

describe('impressionGini', () => {
  it('reads impressions off seller rows', () => {
    const sellers = [
      { sellerId: 'a', impressions: 1 },
      { sellerId: 'b', impressions: 2 },
      { sellerId: 'c', impressions: 3 },
      { sellerId: 'd', impressions: 4 },
    ];
    expect(impressionGini(sellers)).toBeCloseTo(0.25, 12);
  });

  it('counts zero-impression sellers — dropping them hides the churn', () => {
    const served = [
      { sellerId: 'a', impressions: 100 },
      { sellerId: 'b', impressions: 100 },
    ];
    const withStarved = [...served, { sellerId: 'c', impressions: 0 }, { sellerId: 'd', impressions: 0 }];
    expect(impressionGini(served)).toBe(0);
    expect(impressionGini(withStarved)).toBeCloseTo(0.5, 12);
  });
});

// ---------------------------------------------------------------------------
// rpm
// ---------------------------------------------------------------------------

describe('rpm', () => {
  it('converts cents to dollars per 1,000 impressions', () => {
    // $1,000.00 over 1,000 impressions is $1,000 per 1,000 impressions.
    expect(rpm(100_000, 1_000)).toBe(1000);
    // $3,569.00 over 100,000 impressions -> $35.69, exactly.
    expect(rpm(356_900, 100_000)).toBe(35.69);
    // $50.00 over 2,500 impressions -> $20.00
    expect(rpm(5_000, 2_500)).toBe(20);
  });

  it('is 0 rather than Infinity or NaN when nothing was served', () => {
    expect(rpm(50_000, 0)).toBe(0);
    expect(rpm(0, 0)).toBe(0);
    expect(rpm(50_000, -10)).toBe(0);
  });

  it('is 0 for zero revenue on real impressions', () => {
    expect(rpm(0, 10_000)).toBe(0);
  });

  it('passes negative revenue through — refunds are real', () => {
    expect(rpm(-5_000, 1_000)).toBe(-50);
  });

  it('is 0 for non-finite input', () => {
    expect(rpm(Number.NaN, 1_000)).toBe(0);
    expect(rpm(1_000, Number.NaN)).toBe(0);
    expect(rpm(Number.POSITIVE_INFINITY, 1_000)).toBe(0);
  });

  it('scales linearly with impressions at fixed revenue', () => {
    expect(rpm(10_000, 1_000)).toBe(rpm(20_000, 2_000));
  });
});

// ---------------------------------------------------------------------------
// budget delivery
// ---------------------------------------------------------------------------

const NOW = new Date('2026-08-19T12:00:00.000Z');
const HOUR = 3_600_000;

function video(
  videoId: string,
  impressionsDelivered: number,
  hoursAgo: number,
  budgetTotal = 500
): BudgetObservation {
  return {
    videoId,
    impressionsDelivered,
    budgetTotal,
    windowStart: new Date(NOW.getTime() - hoursAgo * HOUR),
  };
}

describe('budgetDeliveryRate', () => {
  it('is 1 when every closed window was filled', () => {
    const videos = [video('a', 500, 60), video('b', 500, 72), video('c', 640, 50)];
    expect(budgetDeliveryRate(videos, NOW)).toBe(1);
  });

  it('drops for each video whose window closed short', () => {
    const videos = [video('a', 500, 60), video('b', 500, 60), video('c', 500, 60), video('d', 499, 60)];
    expect(budgetDeliveryRate(videos, NOW)).toBe(0.75);
    expect(budgetDeliveryReport(videos, NOW).starved).toEqual(['d']);
  });

  it('does not punish a partially-elapsed window', () => {
    // 40/500 two hours in is on pace, not starved. Counted in neither the
    // numerator nor the denominator — otherwise this guardrail can never read
    // 1.0 on a live feed and stops meaning anything.
    const videos = [video('closed', 500, 60), video('inflight', 40, 2)];
    const report = budgetDeliveryReport(videos, NOW);
    expect(report.rate).toBe(1);
    expect(report.decided).toBe(1);
    expect(report.pending).toBe(1);
    expect(report.starved).toEqual([]);
  });

  it('credits a video that hit its budget early, window still open', () => {
    const report = budgetDeliveryReport([video('fast', 500, 2)], NOW);
    expect(report.rate).toBe(1);
    expect(report.delivered).toBe(1);
    expect(report.pending).toBe(0);
  });

  it('treats the 48h boundary as inclusive', () => {
    // Exactly 48h: window closed, video judged and found short.
    expect(budgetDeliveryReport([video('at48', 499, 48)], NOW).starved).toEqual(['at48']);
    // One minute inside 48h: still pending.
    const justInside: BudgetObservation = {
      videoId: 'at4759',
      impressionsDelivered: 499,
      budgetTotal: 500,
      windowStart: new Date(NOW.getTime() - (48 * HOUR - 60_000)),
    };
    const report = budgetDeliveryReport([justInside], NOW);
    expect(report.starved).toEqual([]);
    expect(report.pending).toBe(1);
  });

  it('is 1 with nothing decided, and says so on the report', () => {
    expect(budgetDeliveryRate([], NOW)).toBe(1);
    expect(budgetDeliveryReport([], NOW).decided).toBe(0);
    // A run with no evidence has starved nobody; failing here would block every
    // first run. `decided` is what separates this from "100% delivered".
    const allPending = budgetDeliveryReport([video('x', 10, 1), video('y', 0, 3)], NOW);
    expect(allPending.rate).toBe(1);
    expect(allPending.decided).toBe(0);
    expect(allPending.pending).toBe(2);
  });

  it('honours a per-video budget override', () => {
    expect(budgetDeliveryReport([video('small', 200, 60, 200)], NOW).delivered).toBe(1);
    expect(budgetDeliveryReport([video('small', 199, 60, 200)], NOW).starved).toEqual(['small']);
  });

  it('falls back to the 500 default for a nonsense budgetTotal', () => {
    expect(budgetDeliveryReport([video('bad', 499, 60, 0)], NOW).starved).toEqual(['bad']);
    expect(budgetDeliveryReport([video('bad', 500, 60, 0)], NOW).delivered).toBe(1);
  });

  it('treats a future window start as pending, never as starved', () => {
    const report = budgetDeliveryReport([video('future', 0, -5)], NOW);
    expect(report.pending).toBe(1);
    expect(report.starved).toEqual([]);
  });

  it('floors a negative delivered count instead of crediting it', () => {
    expect(budgetDeliveryReport([video('neg', -50, 60)], NOW).starved).toEqual(['neg']);
  });

  it('accepts a custom window length', () => {
    // With a 24h window, a video 30h old is decided rather than pending.
    expect(budgetDeliveryReport([video('a', 100, 30)], NOW, 24).starved).toEqual(['a']);
    expect(budgetDeliveryReport([video('a', 100, 30)], NOW, 72).pending).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// quality sorting ratio
// ---------------------------------------------------------------------------

type QualitySeller = { sellerId: string; impressions: number; good: boolean };
const isGood = (s: QualitySeller) => s.good;

describe('qualitySortingRatio', () => {
  it('divides the high-quality mean by the low-quality mean', () => {
    const sellers: QualitySeller[] = [
      { sellerId: 'h1', impressions: 4000, good: true },
      { sellerId: 'h2', impressions: 2000, good: true },
      { sellerId: 'l1', impressions: 1500, good: false },
      { sellerId: 'l2', impressions: 500, good: false },
    ];
    const report = qualitySortingReport(sellers, isGood);
    expect(report.highMean).toBe(3000);
    expect(report.lowMean).toBe(1000);
    expect(report.ratio).toBe(3);
    expect(report.highCount).toBe(2);
    expect(report.lowCount).toBe(2);
  });

  it('is null rather than a division by zero when the low group is empty', () => {
    const sellers: QualitySeller[] = [
      { sellerId: 'h1', impressions: 4000, good: true },
      { sellerId: 'h2', impressions: 2000, good: true },
    ];
    const report = qualitySortingReport(sellers, isGood);
    expect(report.ratio).toBeNull();
    expect(report.lowCount).toBe(0);
    expect(report.lowMean).toBe(0);
    expect(qualitySortingRatio(sellers, isGood)).toBeNull();
  });

  it('is null when the high group is empty, and when there are no sellers at all', () => {
    expect(qualitySortingRatio([{ sellerId: 'l', impressions: 10, good: false }], isGood)).toBeNull();
    expect(qualitySortingRatio([] as QualitySeller[], isGood)).toBeNull();
  });

  it('is null when nobody was served at all', () => {
    const sellers: QualitySeller[] = [
      { sellerId: 'h', impressions: 0, good: true },
      { sellerId: 'l', impressions: 0, good: false },
    ];
    // An outage, not a sorting ratio.
    expect(qualitySortingRatio(sellers, isGood)).toBeNull();
  });

  it('is Infinity — NOT null — when a real low group got literally nothing', () => {
    const sellers: QualitySeller[] = [
      { sellerId: 'h', impressions: 5000, good: true },
      { sellerId: 'l', impressions: 0, good: false },
    ];
    // The most extreme winner-take-all there is. It must FAIL the band rather
    // than register as "not measurable".
    expect(qualitySortingRatio(sellers, isGood)).toBe(Number.POSITIVE_INFINITY);
    expect(evaluateGuardrails({ gini: 0.1, budgetDelivery: 1, qualityRatio: Number.POSITIVE_INFINITY, rpm: 10 })
      .checks.find((c) => c.id === 'qualityRatio')?.status).toBe('fail');
  });

  it('lets the caller own the definition of quality', () => {
    const sellers: QualitySeller[] = [
      { sellerId: 'a', impressions: 3000, good: true },
      { sellerId: 'b', impressions: 1000, good: false },
    ];
    // Same data, inverted predicate, reciprocal answer: the split is entirely
    // the caller's, which is the whole point of the parameter.
    expect(qualitySortingRatio(sellers, isGood)).toBe(3);
    expect(qualitySortingRatio(sellers, (s) => !s.good)).toBeCloseTo(1 / 3, 12);
  });

  it('floors negative and non-finite impressions instead of throwing', () => {
    const sellers: QualitySeller[] = [
      { sellerId: 'h1', impressions: 6000, good: true },
      { sellerId: 'h2', impressions: -100, good: true },
      { sellerId: 'l1', impressions: Number.NaN, good: false },
      { sellerId: 'l2', impressions: 2000, good: false },
    ];
    const report = qualitySortingReport(sellers, isGood);
    expect(report.highMean).toBe(3000);
    expect(report.lowMean).toBe(1000);
    expect(report.ratio).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// lane metrics
// ---------------------------------------------------------------------------

const LANE_OBSERVATIONS: LaneObservation[] = [
  { lane: 'affinity', impressions: 3000, revenueCents: 15_000 },
  { lane: 'affinity', impressions: 2000, revenueCents: 10_000 },
  { lane: 'trending', impressions: 2000, revenueCents: 6_000 },
  { lane: 'fresh', impressions: 1500, revenueCents: 5_250 },
  { lane: 'social', impressions: 1000, revenueCents: 2_000 },
  { lane: 'tail', impressions: 500, revenueCents: 500 },
];

describe('laneMetrics', () => {
  it('aggregates impressions, revenue, share and RPM per lane', () => {
    const lanes = laneMetrics(LANE_OBSERVATIONS);
    expect(lanes.affinity.impressions).toBe(5000);
    expect(lanes.affinity.revenueCents).toBe(25_000);
    expect(lanes.affinity.share).toBe(0.5);
    expect(lanes.affinity.rpm).toBe(50); // 25000c = $250 over 5000 -> $50/1000
    expect(lanes.trending.rpm).toBe(30);
    expect(lanes.fresh.rpm).toBe(35);
    expect(lanes.social.rpm).toBe(20);
    expect(lanes.tail.rpm).toBe(10);
  });

  it('gives shares that sum to 1', () => {
    const lanes = laneMetrics(LANE_OBSERVATIONS);
    const total = Object.values(lanes).reduce((sum, lane) => sum + lane.share, 0);
    expect(total).toBeCloseTo(1, 12);
    expect(lanes.fresh.share).toBeCloseTo(0.15, 12);
    expect(lanes.tail.share).toBeCloseTo(0.05, 12);
  });

  it('reports all five v2 lanes, zero-filled, even with no observations', () => {
    const lanes = laneMetrics([]);
    expect(Object.keys(lanes).sort()).toEqual(['affinity', 'fresh', 'social', 'tail', 'trending']);
    // A lane that received nothing is a finding, not an absent key.
    expect(lanes.fresh).toEqual({ lane: 'fresh', impressions: 0, share: 0, revenueCents: 0, rpm: 0 });
  });

  it('has no share NaN when nothing was served', () => {
    const lanes = laneMetrics([{ lane: 'fresh', impressions: 0, revenueCents: 0 }]);
    for (const lane of Object.values(lanes)) {
      expect(Number.isNaN(lane.share)).toBe(false);
      expect(lane.share).toBe(0);
    }
  });

  it("skips a stale v1 'random' row rather than inventing a sixth lane", () => {
    const stale = { lane: 'random', impressions: 900, revenueCents: 900 } as unknown as LaneObservation;
    const lanes = laneMetrics([...LANE_OBSERVATIONS, stale]);
    expect(Object.keys(lanes)).toHaveLength(5);
    expect(lanes.tail.impressions).toBe(500);
    expect(lanes.affinity.share).toBe(0.5); // total unchanged at 10,000
  });

  it('floors negative impressions and tolerates non-finite revenue', () => {
    const lanes = laneMetrics([
      { lane: 'fresh', impressions: -100, revenueCents: Number.NaN },
      { lane: 'fresh', impressions: 1000, revenueCents: 10_000 },
    ]);
    expect(lanes.fresh.impressions).toBe(1000);
    expect(lanes.fresh.revenueCents).toBe(10_000);
    expect(lanes.fresh.rpm).toBe(100);
  });
});

describe('laneRpmWithin', () => {
  it("fires spec 4's rule: fresh RPM within 30% of affinity means raise the share", () => {
    const lanes = laneMetrics(LANE_OBSERVATIONS);
    // affinity $50, fresh $35. 50 * 0.7 = 35 exactly — the inclusive boundary.
    expect(laneRpmWithin(lanes, 'fresh')).toBe(true);
    // social $20 is 40% of affinity: not close enough.
    expect(laneRpmWithin(lanes, 'social')).toBe(false);
  });

  it('is false when the reference lane has no RPM to compare against', () => {
    const lanes = laneMetrics([{ lane: 'fresh', impressions: 1000, revenueCents: 10_000 }]);
    // A dead-quiet affinity lane must not argue for growing exploration.
    expect(laneRpmWithin(lanes, 'fresh')).toBe(false);
  });

  it('respects a custom tolerance and reference lane', () => {
    const lanes = laneMetrics(LANE_OBSERVATIONS);
    expect(laneRpmWithin(lanes, 'social', 'affinity', 0.6)).toBe(true);
    expect(laneRpmWithin(lanes, 'tail', 'trending', 0.5)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// funnel
// ---------------------------------------------------------------------------

function events(counts: Partial<Record<FunnelEvent['stage'], number>>): FunnelEvent[] {
  const out: FunnelEvent[] = [];
  for (const [stage, n] of Object.entries(counts)) {
    for (let i = 0; i < (n ?? 0); i += 1) out.push({ stage: stage as FunnelEvent['stage'] });
  }
  return out;
}

describe('funnel', () => {
  it('counts the five stages and each stage-to-stage conversion', () => {
    const report = funnel(
      events({ impression: 1000, product_tap: 120, add_to_cart: 30, checkout_open: 18, purchase: 9 })
    );
    expect(report.counts).toEqual({
      impression: 1000,
      product_tap: 120,
      add_to_cart: 30,
      checkout_open: 18,
      purchase: 9,
    });
    expect(report.steps.map((s) => `${s.from}->${s.to}`)).toEqual([
      'impression->product_tap',
      'product_tap->add_to_cart',
      'add_to_cart->checkout_open',
      'checkout_open->purchase',
    ]);
    expect(report.steps.map((s) => s.rate)).toEqual([0.12, 0.25, 0.6, 0.5]);
    expect(report.overall).toBeCloseTo(0.009, 12);
  });

  it('has no NaN anywhere on an empty log', () => {
    const report = funnel([]);
    expect(report.counts.impression).toBe(0);
    expect(report.steps.every((s) => s.rate === 0)).toBe(true);
    expect(report.overall).toBe(0);
  });

  it('reports a rate above 1 rather than clamping a non-monotonic log', () => {
    // A purchase whose product_tap was dropped. Clamping would hide exactly the
    // data-integrity problem worth seeing.
    const report = funnel(events({ impression: 100, product_tap: 2, add_to_cart: 4, purchase: 1 }));
    expect(report.steps[1].rate).toBe(2);
    expect(report.steps[2].rate).toBe(0); // 0 checkout_open of 4 carts
    expect(report.steps[3].rate).toBe(0); // nothing entered checkout_open
  });

  it('ignores an unrecognised stage instead of inventing a sixth', () => {
    const log = [...events({ impression: 10, purchase: 1 }), { stage: 'video_error' } as unknown as FunnelEvent];
    const report = funnel(log);
    expect(Object.keys(report.counts)).toHaveLength(5);
    expect(report.counts.impression).toBe(10);
    expect(report.overall).toBeCloseTo(0.1, 12);
  });
});

// ---------------------------------------------------------------------------
// evaluateGuardrails
// ---------------------------------------------------------------------------

const PASSING = { gini: 0.62, budgetDelivery: 1, qualityRatio: 3.4, rpm: 35.69 } as const;

function statusOf(metrics: Parameters<typeof evaluateGuardrails>[0], id: string) {
  return evaluateGuardrails(metrics).checks.find((check) => check.id === id)?.status;
}

describe('evaluateGuardrails', () => {
  it('passes a healthy run and reports all four metrics', () => {
    const verdict = evaluateGuardrails(PASSING);
    expect(verdict.passed).toBe(true);
    expect(verdict.checks.map((c) => c.id)).toEqual(['gini', 'budgetDelivery', 'qualityRatio', 'rpm']);
    expect(verdict.checks.map((c) => c.value)).toEqual([0.62, 1, 3.4, 35.69]);
  });

  it('encodes the thresholds the whole spec is judged on', () => {
    expect(GUARDRAIL_LIMITS).toEqual({
      GINI_MAX: 0.7,
      BUDGET_DELIVERY_MIN: 1,
      QUALITY_RATIO_MIN: 1.5,
      QUALITY_RATIO_MAX: 10,
    });
  });
});

describe('evaluateGuardrails — gini boundary (strictly below 0.70)', () => {
  it('passes at 0.6999', () => {
    expect(statusOf({ ...PASSING, gini: 0.6999 }, 'gini')).toBe('pass');
    expect(evaluateGuardrails({ ...PASSING, gini: 0.6999 }).passed).toBe(true);
  });

  it('FAILS at exactly 0.70 — the guardrail is "below", not "at most"', () => {
    expect(statusOf({ ...PASSING, gini: 0.7 }, 'gini')).toBe('fail');
    expect(evaluateGuardrails({ ...PASSING, gini: 0.7 }).passed).toBe(false);
  });

  it('fails at 0.7001', () => {
    expect(statusOf({ ...PASSING, gini: 0.7001 }, 'gini')).toBe('fail');
  });

  it('is unknown, not failed, when the gini could not be computed', () => {
    expect(statusOf({ ...PASSING, gini: Number.NaN }, 'gini')).toBe('unknown');
    expect(evaluateGuardrails({ ...PASSING, gini: Number.NaN }).passed).toBe(true);
  });
});

describe('evaluateGuardrails — budget delivery boundary (100%, not 90%)', () => {
  it('passes at exactly 1.0', () => {
    expect(statusOf({ ...PASSING, budgetDelivery: 1 }, 'budgetDelivery')).toBe('pass');
  });

  it('fails at 0.999 and at the tempting 0.9', () => {
    expect(statusOf({ ...PASSING, budgetDelivery: 0.999 }, 'budgetDelivery')).toBe('fail');
    expect(statusOf({ ...PASSING, budgetDelivery: 0.9 }, 'budgetDelivery')).toBe('fail');
    expect(evaluateGuardrails({ ...PASSING, budgetDelivery: 0.999 }).passed).toBe(false);
  });
});

describe('evaluateGuardrails — quality ratio band [1.5, 10]', () => {
  it('fails at 1.49 — below 1.5 the algorithm is not sorting at all', () => {
    expect(statusOf({ ...PASSING, qualityRatio: 1.49 }, 'qualityRatio')).toBe('fail');
  });

  it('passes at exactly 1.5', () => {
    expect(statusOf({ ...PASSING, qualityRatio: 1.5 }, 'qualityRatio')).toBe('pass');
  });

  it('passes at exactly 10.0', () => {
    expect(statusOf({ ...PASSING, qualityRatio: 10 }, 'qualityRatio')).toBe('pass');
  });

  it('fails at 10.01 — winner-take-all, the long tail is churning', () => {
    expect(statusOf({ ...PASSING, qualityRatio: 10.01 }, 'qualityRatio')).toBe('fail');
    expect(evaluateGuardrails({ ...PASSING, qualityRatio: 10.01 }).passed).toBe(false);
  });

  it('is unknown, not failed, when the split is not measurable', () => {
    const verdict = evaluateGuardrails({ ...PASSING, qualityRatio: null });
    expect(verdict.checks.find((c) => c.id === 'qualityRatio')?.status).toBe('unknown');
    expect(verdict.checks.find((c) => c.id === 'qualityRatio')?.value).toBeNull();
    expect(verdict.passed).toBe(true);
  });
});

describe('evaluateGuardrails — RPM is reported, never thresholded', () => {
  it('never fails, whatever the RPM', () => {
    for (const value of [0, -12.5, 35.69, 1_000_000]) {
      const check = evaluateGuardrails({ ...PASSING, rpm: value }).checks.find((c) => c.id === 'rpm');
      expect(check?.status).toBe('report');
      expect(check?.value).toBe(value);
      expect(evaluateGuardrails({ ...PASSING, rpm: value }).passed).toBe(true);
    }
  });

  it('reports a null value rather than NaN when RPM is undefined', () => {
    const check = evaluateGuardrails({ ...PASSING, rpm: Number.NaN }).checks.find((c) => c.id === 'rpm');
    expect(check?.value).toBeNull();
    expect(check?.status).toBe('report');
  });
});

describe('evaluateGuardrails — the verdict', () => {
  it('fails the run if any single guardrail fails', () => {
    expect(evaluateGuardrails({ gini: 0.82, budgetDelivery: 1, qualityRatio: 3, rpm: 40 }).passed).toBe(false);
    expect(evaluateGuardrails({ gini: 0.5, budgetDelivery: 0.97, qualityRatio: 3, rpm: 40 }).passed).toBe(false);
    expect(evaluateGuardrails({ gini: 0.5, budgetDelivery: 1, qualityRatio: 541, rpm: 40 }).passed).toBe(false);
  });

  it('reproduces the greedy-vs-softmax comparison from select.ts', () => {
    // Greedy argmax: Gini 0.82, quality ratio 541x. Both guardrails blown.
    const greedy = evaluateGuardrails({ gini: 0.82, budgetDelivery: 1, qualityRatio: 541, rpm: 35.69 });
    expect(greedy.passed).toBe(false);
    expect(greedy.checks.filter((c) => c.status === 'fail').map((c) => c.id)).toEqual([
      'gini',
      'qualityRatio',
    ]);

    // Softmax sampling: Gini 0.62, ratio 13.8x, RPM unchanged. The ratio is
    // still above the 10x band ceiling, so this is a pass on the two headline
    // guardrails and NOT a clean run — which is the honest reading.
    const softmax = evaluateGuardrails({ gini: 0.62, budgetDelivery: 1, qualityRatio: 13.8, rpm: 35.69 });
    expect(softmax.checks.find((c) => c.id === 'gini')?.status).toBe('pass');
    expect(softmax.checks.find((c) => c.id === 'budgetDelivery')?.status).toBe('pass');
    expect(softmax.checks.find((c) => c.id === 'qualityRatio')?.status).toBe('fail');
  });

  it('composes end to end from raw observations', () => {
    const sellers = [
      { sellerId: 'a', impressions: 4000, good: true },
      { sellerId: 'b', impressions: 2000, good: true },
      { sellerId: 'c', impressions: 1500, good: false },
      { sellerId: 'd', impressions: 500, good: false },
    ];
    const lanes = laneMetrics(LANE_OBSERVATIONS);
    const totalImpressions = Object.values(lanes).reduce((s, l) => s + l.impressions, 0);
    const totalRevenue = Object.values(lanes).reduce((s, l) => s + l.revenueCents, 0);

    const verdict = evaluateGuardrails({
      gini: impressionGini(sellers),
      budgetDelivery: budgetDeliveryRate([video('a', 500, 60), video('b', 500, 3)], NOW),
      qualityRatio: qualitySortingRatio(sellers, isGood),
      rpm: rpm(totalRevenue, totalImpressions),
    });

    expect(verdict.passed).toBe(true);
    expect(verdict.checks.find((c) => c.id === 'rpm')?.value).toBeCloseTo(38.75, 12);
  });
});
