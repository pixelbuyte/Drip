import { describe, expect, it } from 'vitest';

import { GUARDRAIL_LIMITS } from '../guardrails';
import {
  DEFAULT_WORLD,
  EXPLORATION_HEAVY_WORLD,
  SIMULATION_STRATEGIES,
  compareStrategies,
  formatFullReport,
  runSimulation,
  strategyConfig,
  type SimulationResult,
  type WorldConfig,
} from '../simulate';
import { LANES, SELECTION } from '../types';

/**
 * THE REGRESSION GATE.
 *
 * The spec: "Before shipping any ranking change, run simulate.ts and check all
 * four guardrails." This file is that instruction turned into CI. Everything
 * here runs a REDUCED simulation — the full 2,000-session comparison lives
 * behind `npm run simulate`, because it takes minutes rather than seconds.
 *
 * WHY THE REDUCED RUN IS 1,500 SESSIONS AND NOT 300.
 *
 * Guardrail 2 (100% of new videos receive their 500-impression budget) has an
 * arithmetic floor that a small run cannot clear, and it is worth writing down
 * because it looks like an arbitrary choice and is not:
 *
 *   - A video is served at most ONCE per session, so 500 guaranteed impressions
 *     need 500 distinct sessions.
 *   - They have to land inside a 48h window, so the run needs >= 500 sessions
 *     per 48h — call it 500 sessions/day with slack for the slices a viewer
 *     abandons before reaching the fresh floor's reserved tail slots.
 *   - The window has to CLOSE for the video to be judged at all: below 48h of
 *     simulated time every video is 'pending', the rate is a vacuous 1.0, and
 *     the guardrail asserts nothing.
 *
 * 500 sessions/day x >48h = >1,000 sessions before the first video is even
 * decided. At 1,500 the run spans 72h and decides 6 of its 12 new videos, which
 * is a real measurement. A 300-session run at this density spans 14 hours and
 * decides none of them; the assertion would pass on an empty set.
 */

const CI_SESSIONS = 1500;
const CI_SEED = 424242;

/**
 * Smaller than the shipped ~500 candidates and 3 slices purely for CI wall
 * clock — scoring cost is linear in both. The full run in `npm run simulate`
 * uses DEFAULT_WORLD unchanged.
 */
const CI_WORLD: Partial<WorldConfig> = { maxSlices: 2, targetCandidates: 150 };

/** Runs are pure, so memoise: several assertions share the same two runs. */
const cache = new Map<string, SimulationResult>();
function run(key: string, make: () => SimulationResult): SimulationResult {
  const hit = cache.get(key);
  if (hit) return hit;
  const value = make();
  cache.set(key, value);
  return value;
}

const softmaxRun = () =>
  run('softmax', () =>
    runSimulation({ sessions: CI_SESSIONS, seed: CI_SEED, strategy: 'softmax', world: CI_WORLD })
  );
const greedyRun = () =>
  run('greedy', () =>
    runSimulation({ sessions: CI_SESSIONS, seed: CI_SEED, strategy: 'greedy', world: CI_WORLD })
  );

const TIMEOUT = 300_000;

// ---------------------------------------------------------------------------
// The four guardrails
// ---------------------------------------------------------------------------

describe('simulation guardrails (reduced run)', () => {
  it(
    'runs a world that is actually worth measuring',
    () => {
      const r = softmaxRun();

      // A guardrail run on a world too small to break anything is theatre.
      // These are the preconditions every assertion below depends on.
      expect(r.totals.sessions).toBe(CI_SESSIONS);
      expect(r.totals.impressions).toBeGreaterThan(20_000);
      expect(r.totals.purchases).toBeGreaterThan(100);
      expect(r.world.sellers).toBe(120);
      expect(r.world.newVideosPublished).toBeGreaterThanOrEqual(8);
      expect(r.world.durationHours).toBeGreaterThan(48);
      // New videos entered during the run and were genuinely competed for,
      // rather than the guarantee being satisfied because nobody asked for it.
      expect(r.budget.demandShare).toBeGreaterThan(0.05);
    },
    TIMEOUT
  );

  it(
    'guardrail 1 — impression Gini across active sellers stays below 0.70',
    () => {
      const r = softmaxRun();
      expect(r.gini).toBeLessThan(GUARDRAIL_LIMITS.GINI_MAX);
      // Zeros are IN the population; see impressionGini's contract. Dropping
      // them is the one thing that makes this metric lie.
      expect(r.sellersReached).toBe(r.sellersTotal);
      expect(r.sellersZero).toBe(0);
    },
    TIMEOUT
  );

  it(
    'guardrail 2 — 100% of decided new videos received their full budget',
    () => {
      const r = softmaxRun();
      // Non-vacuous first: `rate` is 1 when nothing has been decided, so the
      // rate alone cannot tell "everyone delivered" from "nobody judged".
      expect(r.budget.decided).toBeGreaterThanOrEqual(3);
      expect(r.budget.starved).toEqual([]);
      expect(r.budget.rate).toBeGreaterThanOrEqual(GUARDRAIL_LIMITS.BUDGET_DELIVERY_MIN);
    },
    TIMEOUT
  );

  it(
    'guardrail 3 — quality sorting ratio lands inside 1.5x - 10x',
    () => {
      const r = softmaxRun();
      expect(r.quality.ratio).not.toBeNull();
      expect(r.quality.ratio).toBeGreaterThanOrEqual(GUARDRAIL_LIMITS.QUALITY_RATIO_MIN);
      expect(r.quality.ratio).toBeLessThanOrEqual(GUARDRAIL_LIMITS.QUALITY_RATIO_MAX);
      // Sorting, not sameness: the high-quality half must genuinely out-reach
      // the low-quality half, which a ratio near 1.0 would deny.
      expect(r.quality.highMean).toBeGreaterThan(r.quality.lowMean);
    },
    TIMEOUT
  );

  it(
    'guardrail 4 — RPM is positive and reported, never thresholded',
    () => {
      const r = softmaxRun();
      expect(r.rpm).toBeGreaterThan(0);
      const rpmCheck = r.guardrails.checks.find((c) => c.id === 'rpm');
      expect(rpmCheck?.status).toBe('report');
    },
    TIMEOUT
  );

  it(
    'the module-level verdict agrees with the four checks',
    () => {
      const r = softmaxRun();
      expect(r.guardrails.checks.map((c) => c.id)).toEqual([
        'gini',
        'budgetDelivery',
        'qualityRatio',
        'rpm',
      ]);
      expect(r.guardrails.checks.filter((c) => c.status === 'fail')).toEqual([]);
      expect(r.passed).toBe(true);
    },
    TIMEOUT
  );
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('reproducibility', () => {
  it(
    'the same seed produces byte-identical metrics',
    () => {
      const opts = { sessions: 300, seed: 99, world: CI_WORLD } as const;
      const a = runSimulation(opts);
      const b = runSimulation(opts);
      // Deep equality first (better failure output), then the literal
      // byte-for-byte claim the whole harness rests on.
      expect(b).toEqual(a);
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    },
    TIMEOUT
  );

  it(
    'a different seed produces a different world',
    () => {
      const a = runSimulation({ sessions: 300, seed: 99, world: CI_WORLD });
      const b = runSimulation({ sessions: 300, seed: 100, world: CI_WORLD });
      // If this ever fails, the seed is not reaching the generators and every
      // "same seed => same result" assertion above is vacuous.
      expect(b.totals.revenueCents).not.toBe(a.totals.revenueCents);
      expect(b.gini).not.toBe(a.gini);
    },
    TIMEOUT
  );

  it(
    'each strategy is deterministic on its own and reruns identically',
    () => {
      for (const strategy of SIMULATION_STRATEGIES) {
        const opts = { sessions: 120, seed: 5, strategy, world: CI_WORLD } as const;
        expect(JSON.stringify(runSimulation(opts))).toBe(JSON.stringify(runSimulation(opts)));
      }
    },
    TIMEOUT
  );
});

// ---------------------------------------------------------------------------
// The comparative claims
// ---------------------------------------------------------------------------

describe('greedy vs softmax — the equity claim', () => {
  it(
    'greedy produces a materially higher impression Gini than softmax',
    () => {
      const greedy = greedyRun();
      const softmax = softmaxRun();
      // Directional with a margin, not a memorised number: the claim is about
      // the MECHANISM (sampling spreads impressions), and pinning an exact Gini
      // would turn a behavioural test into a snapshot that has to be re-blessed
      // every time a weight moves.
      expect(greedy.gini).toBeGreaterThan(softmax.gini + 0.1);
      // Same world, same seed, same constraints — only the temperature differs.
      expect(greedy.world.freshFloor).toBe(softmax.world.freshFloor);
      expect(greedy.world.freshCeiling).toBe(softmax.world.freshCeiling);
      expect(greedy.world.temperature).toBe(0);
      expect(softmax.world.temperature).toBe(SELECTION.SOFTMAX_TEMPERATURE);
    },
    TIMEOUT
  );

  it(
    'greedy concentrates: it reaches fewer sellers and sorts harder on quality',
    () => {
      const greedy = greedyRun();
      const softmax = softmaxRun();
      // Softmax must reach EVERY seller; greedy is allowed to and usually does
      // not. Asserting a strict inequality on seller counts would hinge on a
      // single seller at the margin, so the load-bearing claim is the ratio:
      // greedy sorts far harder on quality, which is the same concentration
      // seen from the other end.
      expect(softmax.sellersReached).toBe(softmax.sellersTotal);
      expect(greedy.sellersReached).toBeLessThanOrEqual(softmax.sellersReached);
      expect(greedy.quality.ratio ?? 0).toBeGreaterThan((softmax.quality.ratio ?? 0) * 1.3);
    },
    TIMEOUT
  );
});

describe('the fresh ceiling — a floor without a ceiling is a takeover', () => {
  /**
   * WHY THIS TEST USES A DIFFERENT WORLD, which is a finding in its own right.
   *
   * On the default MATURE catalogue the fresh ceiling is unreachable and
   * 'floor-only' is byte-identical to 'softmax'. Two independent reasons:
   *
   *   1. `select`'s ceiling counts LANE LABELS, and a candidate is only
   *      labelled 'fresh' if the fresh lane's 20% quota had room for it. The
   *      exploration lane's impression share is bounded by its CANDIDATE share
   *      long before the ceiling gets a vote.
   *   2. An unproven video sits at the evidence gate's 0.5 neutral on every
   *      rate signal and is charged 0.5 on the quality penalty as well, so it
   *      never outscores a proven video. Measured on the default world, fresh
   *      videos take EXACTLY the floor — 3.00 per fully-watched slice — and not
   *      one slot more.
   *
   * So the spec's failure needs the conditions it actually arose under: a young
   * catalogue where everything qualifies as fresh, and an exploration lane
   * given a large share of the candidate set. Under those conditions the
   * ceiling is measurably load-bearing, which is what this asserts.
   */
  const world = { ...EXPLORATION_HEAVY_WORLD, ...CI_WORLD, newVideosPerDay: 2 };
  const sessions = 300;
  const seed = 8181;

  const capped = () =>
    run('explore-softmax', () => runSimulation({ sessions, seed, strategy: 'softmax', world }));
  const uncapped = () =>
    run('explore-floor-only', () =>
      runSimulation({ sessions, seed, strategy: 'floor-only', world })
    );

  it(
    'disabling the ceiling materially raises the fresh lane share',
    () => {
      const a = capped();
      const b = uncapped();
      expect(b.freshShare).toBeGreaterThan(a.freshShare + 0.04);
      expect(b.diagnostics.avgFreshPerFullSlice).toBeGreaterThan(
        a.diagnostics.avgFreshPerFullSlice + 0.5
      );
    },
    TIMEOUT
  );

  it(
    'with the ceiling on, the fresh lane cannot exceed FRESH_CEILING per slice',
    () => {
      const a = capped();
      const b = uncapped();
      // The ceiling is the binding constraint, not a coincidence of supply:
      // capped stays under 6 per slice while uncapped goes past it.
      expect(a.diagnostics.avgFreshPerFullSlice).toBeLessThanOrEqual(SELECTION.FRESH_CEILING);
      expect(b.diagnostics.avgFreshPerFullSlice).toBeGreaterThan(SELECTION.FRESH_CEILING);
      expect(a.world.freshCeiling).toBe(SELECTION.FRESH_CEILING);
      expect(b.world.freshCeiling).toBe(SELECTION.SLICE_SIZE);
    },
    TIMEOUT
  );

  it(
    'the floor is never relaxed under either strategy',
    () => {
      // FRESH_FLOOR is outside RELAX_ORDER by construction. Both strategies
      // must therefore reserve it, and a fully-watched slice must carry it.
      expect(capped().world.freshFloor).toBe(SELECTION.FRESH_FLOOR);
      expect(uncapped().world.freshFloor).toBe(SELECTION.FRESH_FLOOR);
      expect(capped().diagnostics.avgFreshPerFullSlice).toBeGreaterThanOrEqual(
        SELECTION.FRESH_FLOOR
      );
    },
    TIMEOUT
  );
});

// ---------------------------------------------------------------------------
// Shape and wiring
// ---------------------------------------------------------------------------

describe('harness shape', () => {
  it(
    'compareStrategies returns all three strategies over one world',
    () => {
      const c = compareStrategies({ sessions: 120, seed: 3, world: CI_WORLD });
      expect(Object.keys(c).sort()).toEqual(['floor-only', 'greedy', 'softmax']);
      for (const strategy of SIMULATION_STRATEGIES) {
        expect(c[strategy].strategy).toBe(strategy);
        expect(c[strategy].sessions).toBe(120);
        // Same world, so the catalogue is identical across strategies.
        expect(c[strategy].world.matureVideos).toBe(c.softmax.world.matureVideos);
        expect(c[strategy].world.viewers).toBe(c.softmax.world.viewers);
      }
      expect(formatFullReport(c)).toContain('DRIP RANKING SIMULATION');
    },
    TIMEOUT
  );

  it(
    'strategy configs differ in exactly the two knobs under test',
    () => {
      const greedy = strategyConfig('greedy');
      const softmax = strategyConfig('softmax');
      const floorOnly = strategyConfig('floor-only');
      expect(greedy.temperature).toBe(0);
      expect(softmax.temperature).toBe(SELECTION.SOFTMAX_TEMPERATURE);
      expect(floorOnly.temperature).toBe(SELECTION.SOFTMAX_TEMPERATURE);
      expect(greedy.freshCeiling).toBe(SELECTION.FRESH_CEILING);
      expect(softmax.freshCeiling).toBe(SELECTION.FRESH_CEILING);
      expect(floorOnly.freshCeiling).toBe(SELECTION.SLICE_SIZE);
      for (const s of SIMULATION_STRATEGIES) {
        expect(strategyConfig(s).freshFloor).toBe(SELECTION.FRESH_FLOOR);
      }
    },
    TIMEOUT
  );

  it(
    'lane accounting is complete and internally consistent',
    () => {
      const r = softmaxRun();
      let impressions = 0;
      let revenue = 0;
      let share = 0;
      for (const lane of LANES) {
        impressions += r.lanes[lane].impressions;
        revenue += r.lanes[lane].revenueCents;
        share += r.lanes[lane].share;
      }
      expect(impressions).toBe(r.totals.impressions);
      expect(revenue).toBe(r.totals.revenueCents);
      expect(share).toBeCloseTo(1, 10);
      expect(r.freshShare).toBe(r.lanes.fresh.share);
      // Every lane received something: a silent lane is a wiring bug, and the
      // 'tail' rename in particular would show up here as a dead lane.
      for (const lane of LANES) expect(r.lanes[lane].impressions).toBeGreaterThan(0);
    },
    TIMEOUT
  );

  it(
    'the funnel is consistent with the totals it was built from',
    () => {
      const r = softmaxRun();
      expect(r.funnel.counts.impression).toBe(r.totals.impressions);
      expect(r.funnel.counts.product_tap).toBe(r.totals.productTaps);
      expect(r.funnel.counts.add_to_cart).toBe(r.totals.addToCarts);
      expect(r.funnel.counts.checkout_open).toBe(r.totals.checkoutOpens);
      expect(r.funnel.counts.purchase).toBe(r.totals.purchases);
      // A synthetic viewer cannot buy without tapping, so unlike a real log the
      // funnel here must be monotonically non-increasing.
      const counts = [
        r.funnel.counts.impression,
        r.funnel.counts.product_tap,
        r.funnel.counts.add_to_cart,
        r.funnel.counts.checkout_open,
        r.funnel.counts.purchase,
      ];
      for (let i = 1; i < counts.length; i += 1) {
        expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]);
      }
    },
    TIMEOUT
  );

  it(
    'the default world is the one the spec describes',
    () => {
      expect(DEFAULT_WORLD.sellers).toBe(120);
      expect(DEFAULT_WORLD.sliceSize).toBe(SELECTION.SLICE_SIZE);
      expect(DEFAULT_WORLD.targetCandidates).toBe(500);
      // No clock reading anywhere: the epoch is a constant.
      expect(DEFAULT_WORLD.startedAt.toISOString()).toBe('2026-01-05T00:00:00.000Z');
    },
    TIMEOUT
  );
});

// ---------------------------------------------------------------------------
// The full run — `npm run simulate`
// ---------------------------------------------------------------------------

/**
 * The 2,000-session comparison. Minutes, not seconds, so it is off unless
 * SIMULATE_FULL=1 — which is exactly what the `simulate` npm script sets. It is
 * a test rather than a standalone script because vitest is the only TypeScript
 * runner this repo has, and adding one for a report generator is not worth a
 * dependency.
 */
const FULL = process.env.SIMULATE_FULL === '1';
const fullSessions = Number(process.env.SIMULATE_SESSIONS ?? 2000);
const fullSeed = Number(process.env.SIMULATE_SEED ?? 20260105);

describe.runIf(FULL)('full comparison', () => {
  it(
    'prints the 2,000-session comparison across all three strategies',
    () => {
      const mature = compareStrategies({ sessions: fullSessions, seed: fullSeed });
      console.log(formatFullReport(mature));

      // The ceiling only has anything to do on a young, exploration-heavy
      // catalogue; on the mature world above it never binds. Both are reported,
      // because "the ceiling did nothing here" is a result, not an omission.
      const young = compareStrategies({
        sessions: Math.round(fullSessions / 2),
        seed: fullSeed,
        world: { ...EXPLORATION_HEAVY_WORLD, newVideosPerDay: 2 },
      });
      console.log('');
      console.log('#'.repeat(78));
      console.log('YOUNG, EXPLORATION-HEAVY CATALOGUE — where the fresh ceiling can bind');
      console.log('#'.repeat(78));
      console.log('');
      console.log(formatFullReport(young));

      expect(mature.softmax.totals.impressions).toBeGreaterThan(0);
    },
    3_600_000
  );
});
