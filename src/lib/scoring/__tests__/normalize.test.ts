import { describe, expect, it } from 'vitest';
import { bayesianRate, norm, safeRate } from '../normalize';

describe('norm', () => {
  it('maps 0 to 0 and the cap to 1', () => {
    expect(norm(0, 10)).toBe(0);
    expect(norm(10, 10)).toBe(1);
  });
  it('clamps both ends', () => {
    expect(norm(25, 10)).toBe(1);
    expect(norm(-3, 10)).toBe(0);
  });
  it('is 0 for a nonsense cap rather than Infinity', () => {
    expect(norm(5, 0)).toBe(0);
  });
});

describe('bayesianRate', () => {
  it('sits exactly at the prior when nothing has been seen', () => {
    expect(bayesianRate(0, 0, 0.02, 50)).toBeCloseTo(0.02, 5);
  });

  // The spec's own example: 3 impressions and 1 purchase must NOT rocket to
  // the top. Unsmoothed this is 0.333; smoothed it lands near the prior.
  it('keeps a 1-of-3 fluke near the prior', () => {
    expect(bayesianRate(1, 3, 0.02, 50)).toBeCloseTo(0.0377358, 5);
  });

  it('converges on the observed rate once volume arrives', () => {
    // (500 + 50*0.02) / (10000 + 50) = 501/10050. The spec doc quoted
    // 0.049751, which is 500/10050 — it dropped the alpha*prior term from the
    // numerator. Verified by hand against the formula the spec itself states.
    expect(bayesianRate(500, 10_000, 0.02, 50)).toBeCloseTo(0.0498507, 5);
  });

  it('never pulls past the prior', () => {
    for (const [c, i] of [[10, 20], [1, 3], [900, 1000]] as const) {
      const observed = c / i;
      const smoothed = bayesianRate(c, i, 0.02, 50);
      if (observed > 0.02) expect(smoothed).toBeLessThan(observed);
    }
  });
});

describe('safeRate', () => {
  it('is 0 rather than Infinity or NaN when nothing was measured', () => {
    expect(safeRate(5, 0)).toBe(0);
    expect(safeRate(0, 0)).toBe(0);
    expect(safeRate(5, -1)).toBe(0);
  });
  it('divides normally and floors negatives', () => {
    expect(safeRate(25, 100)).toBeCloseTo(0.25, 6);
    expect(safeRate(-5, 100)).toBe(0);
  });
});

describe('bayesianRate edge cases', () => {
  it('returns the prior when alpha is 0 and nothing was seen', () => {
    expect(bayesianRate(0, 0, 0.07, 0)).toBeCloseTo(0.07, 6);
  });
});
