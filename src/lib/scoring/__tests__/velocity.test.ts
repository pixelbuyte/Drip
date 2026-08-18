import { describe, expect, it } from 'vitest';
import { velocityScore } from '../velocity';

const HIGH_VOLUME = { purchases1h: 50, addToCarts1h: 100, productTaps1h: 500, impressions1h: 5000 };
const FLUKE = { purchases1h: 2, addToCarts1h: 0, productTaps1h: 0, impressions1h: 40 };

describe('velocityScore', () => {
  it('is 0 when nothing happened', () => {
    expect(velocityScore({ purchases1h: 0, addToCarts1h: 0, productTaps1h: 0, impressions1h: 0 })).toBe(0);
  });

  it('matches the formula on a high-volume video', () => {
    // 1300/5100 * log10(5010). The spec doc quoted 0.943118; the formula it
    // states gives 0.9430959. Recomputed by hand — the doc rounded wrong.
    expect(velocityScore(HIGH_VOLUME)).toBeCloseTo(0.9430959, 5);
  });

  it('matches the formula on a low-volume fluke', () => {
    expect(velocityScore(FLUKE)).toBeCloseTo(0.24271, 5);
  });

  // This is the assertion that fails if anyone "simplifies" away the log10
  // term — it is the whole reason the term exists.
  it('ranks 5000 impressions at a decent rate above 40 at a fluke rate', () => {
    expect(velocityScore(HIGH_VOLUME)).toBeGreaterThan(velocityScore(FLUKE));
  });

  it('is monotonic in purchases at fixed impressions', () => {
    let prev = -1;
    for (const p of [0, 1, 5, 20, 100]) {
      const v = velocityScore({ purchases1h: p, addToCarts1h: 0, productTaps1h: 0, impressions1h: 1000 });
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });
});
