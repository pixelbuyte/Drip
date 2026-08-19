import {
  IMPRESSION_BUDGET_TOTAL,
  IMPRESSION_BUDGET_WINDOW_HOURS,
  LANES,
  type CandidateLane,
} from './types';

/**
 * SPEC 0 and SPEC 4 — THE GUARDRAILS.
 *
 * THE ONE RULE: optimise revenue per 1,000 impressions. "Watch time is the
 * metric that turns a commerce product into a video product." Nothing in this
 * file measures watch time, and that is deliberate.
 *
 * RPM is the objective; these are the two things that must not degrade while
 * chasing it:
 *
 *   1. Impression Gini across active sellers stays BELOW 0.70. "Above that, the
 *      feed is concentrating on a handful of sellers and everyone else churns."
 *   2. 100% of new videos receive their guaranteed impression budget. Not 90%.
 *      "A seller who uploads and gets zero views is gone in a week."
 *
 * Everything here is a pure function over arrays of observations. No clock (a
 * `now: Date` is always passed in), no randomness, no I/O — a guardrail run is
 * a pure function of its inputs, so a simulation result can be replayed and
 * argued with rather than merely quoted.
 *
 * UNITS. Money is always integer CENTS on the way in and DOLLARS on the way out
 * of `rpm`, because RPM is quoted in dollars everywhere in the spec ("$3,569")
 * and a unit mix-up in the objective function is a 100x error nobody notices.
 *
 * BAD INPUT. `gini` REJECTS negative and non-finite values by throwing; every
 * other function FLOORS a negative count at 0 and treats a non-finite one as 0.
 * The split is not arbitrary: the Gini coefficient is defined only over a
 * non-negative distribution — it is a share-of-total measure, and a negative
 * share is not a wrong number but an undefined one, which also voids the
 * [0, (n-1)/n] range everything downstream relies on. The rest of this module
 * sums and averages row by row, where flooring one corrupt row is a defined
 * repair that does not take an admin dashboard down with it.
 */

// ---------------------------------------------------------------------------
// Gini
// ---------------------------------------------------------------------------

/**
 * The Gini coefficient of a distribution — 0 is perfect equality, and the
 * maximum for n holders is (n-1)/n, reached when one holder has everything.
 *
 * Standard sorted formula, with values sorted ASCENDING and i 1-indexed:
 *
 *   G = (2 * SUM(i * x_i)) / (n * SUM(x_i)) - (n + 1) / n
 *
 * It is algebraically identical to the mean-absolute-difference definition
 * G = SUM_i SUM_j |x_i - x_j| / (2 * n^2 * mean), and both are checked against
 * the same hand-computed vectors in the tests. This form is O(n log n) rather
 * than O(n^2), which matters at 120 sellers per simulated run and much more at
 * real seller counts.
 *
 * Worked by hand, and asserted in the tests:
 *
 *   [1, 2, 3, 4]              n=4  sum=10   SUM(i*x_i)=30
 *                             G = 60/40 - 5/4 = 1.5 - 1.25 = 0.25
 *   [1, 1, 1, 1, 6]           n=5  sum=10   SUM(i*x_i)=40
 *                             G = 80/50 - 6/5 = 1.6 - 1.2 = 0.4
 *   [100, 200, 300, 400, 500] n=5  sum=1500 SUM(i*x_i)=5500
 *                             G = 11000/7500 - 6/5 = 0.26666...
 *   [0, 0, 0, 10]             n=4  sum=10   SUM(i*x_i)=40
 *                             G = 80/40 - 5/4 = 0.75 = (n-1)/n
 *
 * DEGENERATE CASES, all documented because a guardrail that quietly returns
 * NaN is worse than no guardrail:
 *   n = 0        -> 0. There is no population, so there is no inequality.
 *   n = 1        -> 0. One holder holds all of it, and (n-1)/n = 0 agrees.
 *   all zeros    -> 0. Nothing was distributed; that is not concentration.
 *                  It IS an outage, and the caller must notice it from the
 *                  impression total, not from this number.
 *   negative     -> throws RangeError (see the module note above).
 *   non-finite   -> throws RangeError.
 *
 * The input array is NEVER mutated: this sorts a copy. Sorting the caller's
 * array in place would silently reorder a seller table used elsewhere in the
 * same report.
 */
export function gini(values: readonly number[]): number {
  const n = values.length;
  if (n === 0) return 0;

  for (const v of values) {
    if (!Number.isFinite(v) || v < 0) {
      throw new RangeError(
        `gini: values must be finite and non-negative; received ${String(v)}. ` +
          'A negative share makes the coefficient undefined rather than merely wrong.'
      );
    }
  }

  const sorted = [...values].sort((a, b) => a - b);

  let total = 0;
  let weighted = 0;
  for (let i = 0; i < n; i += 1) {
    total += sorted[i];
    weighted += (i + 1) * sorted[i];
  }

  if (total === 0) return 0;

  const g = (2 * weighted) / (n * total) - (n + 1) / n;
  // The analytic range is [0, (n-1)/n], so this clamp can only ever absorb
  // floating-point dust (perfect equality lands on -2.2e-16 for some n) — it
  // cannot mask a real value, because no real value lies outside the range.
  return Math.min(1, Math.max(0, g));
}

/** A seller's impression count over the reporting period. */
export type SellerImpressions = {
  sellerId: string;
  impressions: number;
};

/**
 * Impression Gini across sellers — guardrail 1.
 *
 * WHO COUNTS AS "ACTIVE" IS THE CALLER'S CALL, and it decides the answer.
 * Pass every seller who had a video eligible in the period, INCLUDING those
 * that received zero impressions. Filtering the zeros out is the one mistake
 * that makes this metric lie: a seller who got nothing is precisely the churn
 * the guardrail exists to catch, and dropping them can only move the number
 * down. The simulation quoted in select.ts ("impression Gini 0.82, 27 of 120
 * sellers received zero impressions") counts them.
 */
export function impressionGini(sellers: readonly SellerImpressions[]): number {
  return gini(sellers.map((s) => s.impressions));
}

// ---------------------------------------------------------------------------
// RPM — the objective
// ---------------------------------------------------------------------------

/**
 * Revenue per 1,000 impressions, in DOLLARS, from revenue in CENTS.
 *
 *   dollars = revenueCents / 100;  rpm = dollars * 1000 / impressions
 *
 * which reduces to revenueCents * 10 / impressions. Written that way on
 * purpose: it is one division instead of three operations, so $3,569.00 over
 * 100,000 impressions returns exactly 35.69 rather than 35.690000000000005.
 *
 * ZERO IMPRESSIONS -> 0, not Infinity and not NaN. This does conflate "no data"
 * with "no revenue", so nothing here reports an RPM on its own: `laneMetrics`
 * always carries the impression count beside it, and an RPM of 0 on 0
 * impressions is a different statement from an RPM of 0 on 50,000.
 *
 * NEGATIVE REVENUE IS ALLOWED and passes straight through. Refunds and disputes
 * are real, and a lane that loses money must be able to say so.
 */
export function rpm(revenueCents: number, impressions: number): number {
  if (!Number.isFinite(revenueCents) || !Number.isFinite(impressions)) return 0;
  if (impressions <= 0) return 0;
  return (revenueCents * 10) / impressions;
}

// ---------------------------------------------------------------------------
// New-video budget delivery — guardrail 2
// ---------------------------------------------------------------------------

/**
 * One video's guaranteed-impressions state, as this module needs it. Structural
 * so that `{ videoId, ...candidate.budget }` satisfies it directly (see
 * `ImpressionBudget` in types.ts) without this file depending on the shape of a
 * Candidate.
 */
export type BudgetObservation = {
  /** Reported back for the starved set; never used in the arithmetic. */
  videoId: string;
  impressionsDelivered: number;
  /** Normally IMPRESSION_BUDGET_TOTAL (500); read per video so overrides hold. */
  budgetTotal: number;
  /** Start of the guarantee window — normally the publish time. */
  windowStart: Date;
};

export type BudgetDeliveryReport = {
  /** delivered / decided. 1 when nothing has been decided yet — see below. */
  rate: number;
  /** Videos whose outcome is settled: delivered in full, or window expired. */
  decided: number;
  /** Videos that received their full budget. */
  delivered: number;
  /** Videos whose window closed short of the budget. This list is the alarm. */
  starved: string[];
  /** Still inside the window and not yet full: not a pass, not a failure. */
  pending: number;
};

/**
 * Budget delivery, computed against an explicit `now`.
 *
 * THE DEFINITION MATTERS MORE THAN THE ARITHMETIC. The spec's admin line reads
 * "% of last-48h videos that received all 500 impressions", but taken literally
 * that can never reach 100%: a video published two hours ago with 40/500 is on
 * pace, not starved, and counting it as a failure means the guardrail reads
 * below 1.0 forever and stops meaning anything. So each video is classified:
 *
 *   DELIVERED — impressionsDelivered >= budgetTotal. Counted whether or not the
 *               window is still open; hitting the guarantee early is a pass.
 *   STARVED   — short of the budget AND the window has closed
 *               (now - windowStart >= 48h). This is the failure the guarantee
 *               is about, and the only thing that can drag the rate below 1.
 *   PENDING   — short of the budget with the window still open. Excluded from
 *               BOTH numerator and denominator. Not yet judged.
 *
 *   rate = delivered / (delivered + starved)
 *
 * NO DECIDED VIDEOS -> rate 1. A fresh environment has starved nobody, and
 * failing a guardrail on zero evidence would block every first run. `decided`
 * is on the report so a caller can tell "100% delivered" from "nothing to
 * report"; they are not the same claim and this rate alone cannot distinguish
 * them.
 *
 * The 48h boundary is inclusive: at exactly 48h the window is closed and the
 * video is judged.
 */
export function budgetDeliveryReport(
  videos: readonly BudgetObservation[],
  now: Date,
  windowHours: number = IMPRESSION_BUDGET_WINDOW_HOURS
): BudgetDeliveryReport {
  const windowMs = (Number.isFinite(windowHours) ? Math.max(0, windowHours) : IMPRESSION_BUDGET_WINDOW_HOURS) * 3_600_000;
  const nowMs = now.getTime();

  let delivered = 0;
  let pending = 0;
  const starved: string[] = [];

  for (const video of videos) {
    const target =
      Number.isFinite(video.budgetTotal) && video.budgetTotal > 0
        ? video.budgetTotal
        : IMPRESSION_BUDGET_TOTAL;
    const got = Number.isFinite(video.impressionsDelivered)
      ? Math.max(0, video.impressionsDelivered)
      : 0;

    if (got >= target) {
      delivered += 1;
      continue;
    }

    // An unparseable windowStart yields NaN here; the comparison is false and
    // the video counts as pending rather than being condemned on bad data.
    const closed = nowMs - video.windowStart.getTime() >= windowMs;
    if (closed) starved.push(video.videoId);
    else pending += 1;
  }

  const decided = delivered + starved.length;
  return {
    rate: decided === 0 ? 1 : delivered / decided,
    decided,
    delivered,
    starved,
    pending,
  };
}

/** Fraction of decided videos that received their full budget. See the report. */
export function budgetDeliveryRate(
  videos: readonly BudgetObservation[],
  now: Date,
  windowHours: number = IMPRESSION_BUDGET_WINDOW_HOURS
): number {
  return budgetDeliveryReport(videos, now, windowHours).rate;
}

// ---------------------------------------------------------------------------
// Quality sorting
// ---------------------------------------------------------------------------

export type QualitySortingReport = {
  /**
   * highMean / lowMean, or null when the comparison does not exist. NEVER NaN
   * and never a silent 0.
   */
  ratio: number | null;
  highMean: number;
  lowMean: number;
  highCount: number;
  lowCount: number;
};

/**
 * Mean impressions of high-quality sellers over mean impressions of low-quality
 * sellers. Target band 1.5x-10x: "Below 1.5x the algorithm isn't working; above
 * ~15x it's winner-take-all and the long tail is churning."
 *
 * THE SPLIT IS A PREDICATE, not a definition baked in here. "Quality" is a
 * product judgement that will be relitigated — fulfillment score, dispute rate,
 * trust tier, a blend — and a metric that hardcodes one of them quietly becomes
 * an argument for that one. The caller supplies the predicate and owns the
 * definition; this function only does the arithmetic.
 *
 * DIVISION BY ZERO, all three ways:
 *   no sellers on either side  -> ratio null. There is no comparison to make.
 *   both means 0               -> ratio null. Nobody got anything; that is an
 *                                 outage, not a sorting ratio.
 *   low group exists, mean 0   -> ratio Infinity, deliberately NOT null. The
 *                                 low-quality group being served literally
 *                                 nothing is the most extreme winner-take-all
 *                                 there is, and it must FAIL the band rather
 *                                 than register as "not measurable".
 */
export function qualitySortingReport<T extends SellerImpressions>(
  sellers: readonly T[],
  isHighQuality: (seller: T) => boolean
): QualitySortingReport {
  let highCount = 0;
  let lowCount = 0;
  let highTotal = 0;
  let lowTotal = 0;

  for (const seller of sellers) {
    const impressions = Number.isFinite(seller.impressions) ? Math.max(0, seller.impressions) : 0;
    if (isHighQuality(seller)) {
      highCount += 1;
      highTotal += impressions;
    } else {
      lowCount += 1;
      lowTotal += impressions;
    }
  }

  const highMean = highCount === 0 ? 0 : highTotal / highCount;
  const lowMean = lowCount === 0 ? 0 : lowTotal / lowCount;

  let ratio: number | null;
  if (highCount === 0 || lowCount === 0) ratio = null;
  else if (highMean === 0 && lowMean === 0) ratio = null;
  else if (lowMean === 0) ratio = Number.POSITIVE_INFINITY;
  else ratio = highMean / lowMean;

  return { ratio, highMean, lowMean, highCount, lowCount };
}

/** The ratio alone; null when it does not exist. See `qualitySortingReport`. */
export function qualitySortingRatio<T extends SellerImpressions>(
  sellers: readonly T[],
  isHighQuality: (seller: T) => boolean
): number | null {
  return qualitySortingReport(sellers, isHighQuality).ratio;
}

// ---------------------------------------------------------------------------
// Per-lane metrics
// ---------------------------------------------------------------------------

export type LaneObservation = {
  lane: CandidateLane;
  impressions: number;
  revenueCents: number;
};

export type LaneMetric = {
  lane: CandidateLane;
  impressions: number;
  /** Fraction of all impressions in the period. 0 when nothing was served. */
  share: number;
  revenueCents: number;
  /** Dollars per 1,000 impressions. Read it next to `impressions`, never alone. */
  rpm: number;
};

export type LaneMetrics = Record<CandidateLane, LaneMetric>;

/**
 * Per-lane impressions, share and RPM (spec 4). Every lane in LANES is always
 * present, zero-filled — a lane that received nothing is a finding, and a
 * missing key would let a dashboard render it as absent instead of starved.
 *
 * The rule these feed: "If the fresh lane's RPM is within 30% of affinity's,
 * raise its share." See `laneRpmWithin`.
 *
 * Lanes are 'affinity' | 'trending' | 'fresh' | 'social' | 'tail' — v1's
 * 'random' was renamed in v2. A stale row still carrying 'random' is skipped
 * rather than counted into a sixth phantom lane; it will show up as a shortfall
 * in the tail lane's share, which is the honest place for it to surface.
 */
export function laneMetrics(observations: readonly LaneObservation[]): LaneMetrics {
  const out = {} as LaneMetrics;
  for (const lane of LANES) {
    out[lane] = { lane, impressions: 0, share: 0, revenueCents: 0, rpm: 0 };
  }

  let totalImpressions = 0;
  for (const obs of observations) {
    const row = out[obs.lane];
    if (row === undefined) continue;
    const impressions = Number.isFinite(obs.impressions) ? Math.max(0, obs.impressions) : 0;
    row.impressions += impressions;
    row.revenueCents += Number.isFinite(obs.revenueCents) ? obs.revenueCents : 0;
    totalImpressions += impressions;
  }

  for (const lane of LANES) {
    const row = out[lane];
    row.share = totalImpressions > 0 ? row.impressions / totalImpressions : 0;
    row.rpm = rpm(row.revenueCents, row.impressions);
  }

  return out;
}

/**
 * Spec 4's lane-share rule, as a predicate: is `lane`'s RPM within `tolerance`
 * of `reference`'s? True means the cheaper lane is earning its keep and its
 * share can be raised.
 *
 * False when the reference lane has no RPM to compare against — with no
 * baseline there is no "within 30%", and defaulting to true would let a
 * dead-quiet feed argue for growing the exploration lane.
 */
export function laneRpmWithin(
  lanes: LaneMetrics,
  lane: CandidateLane,
  reference: CandidateLane = 'affinity',
  tolerance = 0.3
): boolean {
  const referenceRpm = lanes[reference].rpm;
  if (!(referenceRpm > 0)) return false;
  return lanes[lane].rpm >= referenceRpm * (1 - tolerance);
}

// ---------------------------------------------------------------------------
// Session funnel
// ---------------------------------------------------------------------------

/**
 * The five stages, in order. These are the wire event names from
 * src/lib/events/client.ts verbatim, so nothing has to translate between the
 * event log and this report.
 */
export const FUNNEL_STAGES = [
  'impression',
  'product_tap',
  'add_to_cart',
  'checkout_open',
  'purchase',
] as const;

export type FunnelStage = (typeof FUNNEL_STAGES)[number];

/** Structural, so a full event row with a `stage` field is accepted as-is. */
export type FunnelEvent = { stage: FunnelStage };

export type FunnelStep = {
  from: FunnelStage;
  to: FunnelStage;
  /** counts[to] / counts[from]; 0 when nothing entered the stage. */
  rate: number;
};

export type FunnelReport = {
  counts: Record<FunnelStage, number>;
  /** The four stage-to-stage conversions, in funnel order. */
  steps: FunnelStep[];
  /** purchase / impression — the end-to-end rate. */
  overall: number;
};

/**
 * Session funnel: impression -> tap -> cart -> checkout_open -> purchase.
 *
 * RATES ARE NOT CLAMPED TO 1. Real logs are not monotonic — a purchase can
 * arrive with its product_tap dropped, and a checkout can resume in a later
 * session than the cart. A rate above 1 is a data-integrity finding, and
 * clamping it would hide exactly the thing worth seeing.
 *
 * An unrecognised stage is ignored rather than counted, so a new event type
 * shipped by the client cannot invent a sixth stage in this report.
 */
export function funnel(events: readonly FunnelEvent[]): FunnelReport {
  const counts = {} as Record<FunnelStage, number>;
  for (const stage of FUNNEL_STAGES) counts[stage] = 0;

  for (const event of events) {
    if (counts[event.stage] === undefined) continue;
    counts[event.stage] += 1;
  }

  const steps: FunnelStep[] = [];
  for (let i = 0; i < FUNNEL_STAGES.length - 1; i += 1) {
    const from = FUNNEL_STAGES[i];
    const to = FUNNEL_STAGES[i + 1];
    steps.push({ from, to, rate: counts[from] > 0 ? counts[to] / counts[from] : 0 });
  }

  return {
    counts,
    steps,
    overall: counts.impression > 0 ? counts.purchase / counts.impression : 0,
  };
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

/**
 * The thresholds, in one place, because they are the numbers the whole v2 spec
 * is judged on.
 *
 * GINI_MAX is STRICT: the guardrail is "below 0.70", so exactly 0.70 fails.
 * The other three bounds are INCLUSIVE.
 *
 * QUALITY_RATIO_MAX is 10, not the "~15x" the spec names as the point where the
 * long tail is definitively churning. 10 is the top of the stated target band
 * (1.5x-10x); leaving the alarm at 15 would mean the band's own ceiling never
 * fires anything.
 */
export const GUARDRAIL_LIMITS = {
  /** Impression Gini must be strictly below this. */
  GINI_MAX: 0.7,
  /** Budget delivery must be at least this. Not 0.9. */
  BUDGET_DELIVERY_MIN: 1,
  QUALITY_RATIO_MIN: 1.5,
  QUALITY_RATIO_MAX: 10,
} as const;

export type GuardrailCheckId = 'gini' | 'budgetDelivery' | 'qualityRatio' | 'rpm';

/**
 * 'pass' / 'fail' are the guardrail verdicts. 'unknown' means the metric could
 * not be computed from the data given (no decided videos, no low-quality
 * sellers) — surfaced, and deliberately NOT a failure, because a run with no
 * evidence has not degraded anything. 'report' is for RPM, which has no fixed
 * threshold and is compared against a baseline run instead.
 */
export type GuardrailStatus = 'pass' | 'fail' | 'unknown' | 'report';

export type GuardrailCheck = {
  id: GuardrailCheckId;
  label: string;
  value: number | null;
  /** Human-readable bound, e.g. '< 0.70'. Rendered by the admin surface. */
  threshold: string;
  status: GuardrailStatus;
  detail: string;
};

export type GuardrailMetrics = {
  /** Impression Gini across active sellers — see `impressionGini`. */
  gini: number;
  /** Fraction of decided new videos that got their full budget. */
  budgetDelivery: number;
  /** High/low mean impression ratio, or null when not measurable. */
  qualityRatio: number | null;
  /** Dollars per 1,000 impressions. Reported, never thresholded. */
  rpm: number;
};

export type GuardrailVerdict = {
  /** False if ANY check failed. 'unknown' and 'report' never fail a run. */
  passed: boolean;
  checks: GuardrailCheck[];
};

/**
 * Turn the four numbers into a structured verdict.
 *
 * RPM IS REPORTED, NEVER THRESHOLDED. It is the objective, not a guardrail:
 * there is no absolute RPM that is "passing", only better or worse than the
 * baseline run, and inventing a fixed threshold here would let a change that
 * halved revenue pass while a change that raised it failed.
 *
 * The asymmetry is the point. RPM is what you optimise; these three are what
 * you are not allowed to break while doing it.
 */
export function evaluateGuardrails(metrics: GuardrailMetrics): GuardrailVerdict {
  const checks: GuardrailCheck[] = [];

  // 1. Impression Gini — strictly below 0.70.
  const giniValue = metrics.gini;
  checks.push({
    id: 'gini',
    label: 'Impression Gini across active sellers',
    value: Number.isFinite(giniValue) ? giniValue : null,
    threshold: `< ${GUARDRAIL_LIMITS.GINI_MAX.toFixed(2)}`,
    status: !Number.isFinite(giniValue)
      ? 'unknown'
      : giniValue < GUARDRAIL_LIMITS.GINI_MAX
        ? 'pass'
        : 'fail',
    detail:
      'Above 0.70 the feed is concentrating on a handful of sellers and everyone else churns.',
  });

  // 2. New-video budget delivery — 100%, not 90%.
  const budget = metrics.budgetDelivery;
  checks.push({
    id: 'budgetDelivery',
    label: 'New videos receiving their full impression budget',
    value: Number.isFinite(budget) ? budget : null,
    threshold: `>= ${GUARDRAIL_LIMITS.BUDGET_DELIVERY_MIN.toFixed(2)}`,
    status: !Number.isFinite(budget)
      ? 'unknown'
      : budget >= GUARDRAIL_LIMITS.BUDGET_DELIVERY_MIN
        ? 'pass'
        : 'fail',
    detail: 'A seller who uploads and gets zero views is gone in a week. 100%, not 90%.',
  });

  // 3. Quality sorting ratio — inside [1.5, 10].
  const quality = metrics.qualityRatio;
  const qualityMeasurable = quality !== null && !Number.isNaN(quality);
  checks.push({
    id: 'qualityRatio',
    label: 'Quality sorting ratio (high-quality / low-quality mean impressions)',
    value: qualityMeasurable ? quality : null,
    threshold: `${GUARDRAIL_LIMITS.QUALITY_RATIO_MIN} - ${GUARDRAIL_LIMITS.QUALITY_RATIO_MAX}`,
    status: !qualityMeasurable
      ? 'unknown'
      : quality >= GUARDRAIL_LIMITS.QUALITY_RATIO_MIN && quality <= GUARDRAIL_LIMITS.QUALITY_RATIO_MAX
        ? 'pass'
        : 'fail',
    detail:
      "Below 1.5x the algorithm isn't working; above the band it is winner-take-all and the long tail is churning.",
  });

  // 4. RPM — the objective. Reported against a baseline, never thresholded.
  checks.push({
    id: 'rpm',
    label: 'Revenue per 1,000 impressions (USD)',
    value: Number.isFinite(metrics.rpm) ? metrics.rpm : null,
    threshold: 'vs baseline',
    status: 'report',
    detail: 'The one rule. No fixed threshold: compare against the baseline run.',
  });

  return { passed: checks.every((check) => check.status !== 'fail'), checks };
}
