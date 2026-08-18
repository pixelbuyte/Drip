import type { CandidateStats } from './types';

/**
 * The trending lane's ordering.
 *
 *   velocity = (purchases*10 + carts*3 + taps*1) / (impressions + 100)
 *              * log10(impressions + 10)
 *
 * The log10 term rewards volume so 5000 impressions at a decent rate outrank
 * 40 impressions at a fluke rate; the +100 is the smoothing floor. Both are
 * load-bearing — the unit tests assert the ordering they exist to produce.
 */
export function velocityScore(
  s: Pick<CandidateStats, 'purchases1h' | 'addToCarts1h' | 'productTaps1h' | 'impressions1h'>
): number {
  const weighted =
    Math.max(0, s.purchases1h) * 10 +
    Math.max(0, s.addToCarts1h) * 3 +
    Math.max(0, s.productTaps1h);
  const impressions = Math.max(0, s.impressions1h);
  if (weighted === 0) return 0;
  return (weighted / (impressions + 100)) * Math.log10(impressions + 10);
}
