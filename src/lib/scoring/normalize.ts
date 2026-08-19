import { NORM_REFERENCE_MULTIPLIER, SELECTION } from './types';

/** min(max(x,0)/cap, 1). The cap is what gives an unbounded rate a ceiling. */
export function norm(x: number, cap: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(cap) || cap <= 0) return 0;
  return Math.min(Math.max(x, 0) / cap, 1);
}

/** NaN collapses to 0; +/-Infinity clamp to the ends like any other number. */
export function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

/**
 * Bayesian smoothing, so a video with 3 impressions and 1 purchase does not
 * rocket to the top. Pulls every rate toward the category prior, and never
 * past it.
 *
 *   smoothed = (conversions + alpha * prior) / (impressions + alpha)
 */
export function bayesianRate(
  conversions: number,
  impressions: number,
  priorRate: number,
  alpha = 50
): number {
  const c = Math.max(0, conversions);
  const i = Math.max(0, impressions);
  const a = Math.max(0, alpha);
  const denom = i + a;
  if (denom === 0) return priorRate;
  return (c + a * priorRate) / denom;
}

export function safeRate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.max(0, numerator) / denominator;
}

/**
 * THE v2 CORRECTION (spec 2.2).
 *
 *   e = clamp01(impressions / threshold)
 *   gated = e * observed + (1 - e) * 0.5
 *
 * Blend the observed value toward 0.5 (neutral) in proportion to how little
 * evidence stands behind it, so a rate measured over 3 impressions carries 3%
 * of its own weight and 97% of "we don't know".
 *
 * From the spec, and the reason this function exists at all: "smoothing alone
 * does not fix small samples. A video with 1 purchase in 3 impressions beat one
 * with 90 purchases in 20,000 in testing, because 1-in-3 genuinely IS extreme
 * evidence — it is just extremely noisy evidence. Smoothing shrinks the
 * estimate; it doesn't shrink your confidence in it. The evidence gate does."
 *
 * Applied AFTER Bayesian smoothing, to every rate-based signal. The two are not
 * redundant: smoothing moves the point estimate, the gate discounts how much
 * that estimate is allowed to move the final score.
 *
 * UNITS. `observed` must already be on the normalised 0-1 scale, because 0.5 is
 * hardcoded as "neutral" and that is only true on that scale. Handing this a
 * RAW rate inverts it: purchase rates live near 0.02, so blending one toward
 * 0.5 produces ~25x the normalisation reference and the video pins at 1.0. See
 * `gatedRate` below.
 */
export function evidenceGate(
  observed: number,
  impressions: number,
  threshold: number = SELECTION.EVIDENCE_THRESHOLD
): number {
  if (!Number.isFinite(observed)) return 0.5;
  const i = Math.max(0, impressions);
  // A non-positive threshold means "no gate": trust anything actually measured,
  // and stay neutral when nothing was.
  const e = threshold > 0 ? clamp01(i / threshold) : i > 0 ? 1 : 0;
  return e * observed + (1 - e) * 0.5;
}

/**
 * Smooth toward the category prior, then gate on how much evidence there is.
 *
 * READ THIS BEFORE CALLING. The result is on the RAW RATE scale, and the gate
 * has already blended it toward 0.5 — which is neutral only on the normalised
 * scale, not on a rate whose median is 0.02. So this value must NOT then be fed
 * to `normToReference`. Doing so is worse than no gate at all:
 *
 *   1 purchase / 3 impressions   -> gatedRate 0.4861 -> normToReference 1.0000
 *   0 purchases / 0 impressions  -> gatedRate 0.5000 -> normToReference 1.0000
 *   90 purchases / 2,000         -> gatedRate 0.0444 -> normToReference 0.8878
 *
 * The fluke and the video with no data at all both take a perfect commerce
 * score off the high-volume performer — precisely the failure the gate exists
 * to prevent.
 *
 * Use this only where the rate is consumed on its own rate scale (thresholds,
 * comparisons between two rates of the same kind). Anything that feeds a
 * weighted 0-1 signal wants `gatedNormalisedRate`, which normalises first so
 * the gate's 0.5 means what it says.
 */
export function gatedRate(
  conversions: number,
  impressions: number,
  priorRate: number,
  alpha = 50,
  threshold: number = SELECTION.EVIDENCE_THRESHOLD
): number {
  return evidenceGate(bayesianRate(conversions, impressions, priorRate, alpha), impressions, threshold);
}

/**
 * Which median actually governs a rate: the category's, else the global
 * fallback, else 0 (meaning "no reference exists"). Exported because the same
 * resolved number is both the Bayesian prior and the basis of the
 * normalisation reference, and the two must never disagree.
 */
export function resolveMedian(categoryMedian: number, fallbackMedian: number): number {
  if (Number.isFinite(categoryMedian) && categoryMedian > 0) return categoryMedian;
  if (Number.isFinite(fallbackMedian) && fallbackMedian > 0) return fallbackMedian;
  return 0;
}

/**
 * Map a value onto 0-1 against 2.5x the CATEGORY MEDIAN (spec 2.3).
 *
 * Normalising against the median itself would mean a perfectly average video
 * normalises to 1.0 — the top of the scale taken by mediocrity, with no
 * headroom left for excellence. 2.5x the median puts "average" at 0.4 and
 * leaves the ceiling for genuine outperformance.
 *
 * Degenerate medians are the whole reason this is a function rather than a
 * division. A category with no data yet has a median of 0, and 2.5 * 0 is a
 * reference of 0: dividing by it yields Infinity (or NaN at 0/0), which would
 * silently pin every video in a new category to the top of the feed. So a zero
 * category median falls back to the global median, and if that is zero too the
 * signal contributes 0.5 — neutral, the same answer the evidence gate gives
 * when it has nothing to go on.
 */
export function normToReference(
  value: number,
  categoryMedian: number,
  fallbackMedian: number,
  multiplier: number = NORM_REFERENCE_MULTIPLIER
): number {
  const reference = resolveMedian(categoryMedian, fallbackMedian) * multiplier;
  if (!Number.isFinite(reference) || reference <= 0) return 0.5;
  return norm(value, reference);
}

/**
 * THE composition signals.ts should use for a rate-based signal:
 *
 *   Bayesian-smooth -> normalise to 2.5x the category median -> evidence-gate
 *
 * All three v2 corrections in the order that makes each one mean what it says.
 * Normalising before gating is what keeps the gate's 0.5 a genuine neutral
 * instead of a raw rate 25x above the reference (see `gatedRate`), and it is
 * the ordering that actually produces the spec's intended result:
 *
 *   1 purchase / 3 impressions  -> 0.5076   (neutral: noisy, so barely counted)
 *   90 purchases / 2,000        -> 0.8878   (believed, and it wins)
 *   0 purchases / 0 impressions -> 0.5000   (exactly neutral, no free ride)
 *
 * The Bayesian prior is the resolved median itself, so the prior and the
 * normalisation reference can never drift apart.
 */
export function gatedNormalisedRate(
  conversions: number,
  impressions: number,
  categoryMedian: number,
  fallbackMedian: number,
  alpha = 50,
  threshold: number = SELECTION.EVIDENCE_THRESHOLD,
  multiplier: number = NORM_REFERENCE_MULTIPLIER
): number {
  const prior = resolveMedian(categoryMedian, fallbackMedian);
  const smoothed = bayesianRate(conversions, impressions, prior, alpha);
  return evidenceGate(
    normToReference(smoothed, categoryMedian, fallbackMedian, multiplier),
    impressions,
    threshold
  );
}

/**
 * The same pipeline for a value that is already a measured level rather than a
 * conversion count over impressions — avgLoopCount, and anything else where
 * there is nothing to Bayes-smooth. It still needs the gate: an average loop
 * count over 3 views is as noisy as a purchase rate over 3 views.
 */
export function gatedNormalisedValue(
  value: number,
  impressions: number,
  categoryMedian: number,
  fallbackMedian: number,
  threshold: number = SELECTION.EVIDENCE_THRESHOLD,
  multiplier: number = NORM_REFERENCE_MULTIPLIER
): number {
  return evidenceGate(
    normToReference(value, categoryMedian, fallbackMedian, multiplier),
    impressions,
    threshold
  );
}
