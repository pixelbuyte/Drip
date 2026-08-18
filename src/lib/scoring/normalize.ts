/** min(max(x,0)/cap, 1). The cap is what gives an unbounded rate a ceiling. */
export function norm(x: number, cap: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(cap) || cap <= 0) return 0;
  return Math.min(Math.max(x, 0) / cap, 1);
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
