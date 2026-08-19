import { describe, expect, it } from 'vitest';
import {
  bayesianRate,
  clamp01,
  evidenceGate,
  gatedNormalisedRate,
  gatedNormalisedValue,
  gatedRate,
  norm,
  normToReference,
  resolveMedian,
  safeRate,
} from '../normalize';

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

describe('clamp01', () => {
  it('collapses NaN to 0 and clamps the infinities like any other number', () => {
    expect(clamp01(Number.NaN)).toBe(0);
    expect(clamp01(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clamp01(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(clamp01(0.3)).toBe(0.3);
  });
});

// ---------------------------------------------------------------------------
// THE EVIDENCE GATE (spec 2.2)
// ---------------------------------------------------------------------------

describe('evidenceGate', () => {
  // The contract, restated as an executable assertion. If the formula ever
  // drifts from `e * observed + (1 - e) * 0.5`, this fails before anything else.
  it('is exactly e*observed + (1-e)*0.5 for e = impressions/threshold', () => {
    for (const [observed, impressions, threshold] of [
      [0.9, 25, 100],
      [0.1, 60, 100],
      [0.75, 7, 40],
      [0.0, 33, 100],
    ] as const) {
      const e = Math.min(1, impressions / threshold);
      expect(evidenceGate(observed, impressions, threshold)).toBeCloseTo(
        e * observed + (1 - e) * 0.5,
        12
      );
    }
  });

  // No evidence means no opinion. Not a low score, not a high one — 0.5.
  it('returns exactly 0.5 at zero impressions, whatever was observed', () => {
    for (const observed of [0, 0.02, 0.5, 0.99, 1]) {
      expect(evidenceGate(observed, 0, 100)).toBe(0.5);
    }
  });

  // At or past the threshold the gate must be the identity function, or it
  // would be permanently taxing videos that have already proved themselves.
  it('passes an observation through untouched once the threshold is met', () => {
    for (const impressions of [100, 101, 5_000, 20_000]) {
      expect(evidenceGate(0.87, impressions, 100)).toBeCloseTo(0.87, 12);
      expect(evidenceGate(0.03, impressions, 100)).toBeCloseTo(0.03, 12);
    }
  });

  it('is exactly halfway to neutral at half the threshold', () => {
    expect(evidenceGate(0.9, 50, 100)).toBeCloseTo(0.7, 12);
    expect(evidenceGate(0.1, 50, 100)).toBeCloseTo(0.3, 12);
  });

  // "Smoothly" is the load-bearing word: the discount has to be continuous in
  // impressions, or a video crossing an impression count would jump in rank.
  it('weakens monotonically and linearly as impressions rise 0 -> 100', () => {
    const observed = 0.9;
    const values = Array.from({ length: 101 }, (_, i) => evidenceGate(observed, i, 100));

    expect(values[0]).toBe(0.5);
    expect(values[100]).toBeCloseTo(observed, 12);

    for (let i = 1; i <= 100; i += 1) {
      const pull = Math.abs(observed - values[i]!);
      const priorPull = Math.abs(observed - values[i - 1]!);
      // Strictly less discounted at every extra impression.
      expect(pull).toBeLessThan(priorPull);
      // And by the same amount each time — linear in e, therefore no cliffs.
      expect(values[i]! - values[i - 1]!).toBeCloseTo((observed - 0.5) / 100, 12);
    }
  });

  it('discounts a value below neutral upward, symmetrically', () => {
    expect(evidenceGate(0.1, 10, 100)).toBeCloseTo(0.46, 12);
    expect(evidenceGate(0.9, 10, 100)).toBeCloseTo(0.54, 12);
  });

  it('treats a non-positive threshold as "no gate", staying neutral with no data', () => {
    expect(evidenceGate(0.8, 5, 0)).toBe(0.8);
    expect(evidenceGate(0.8, 0, 0)).toBe(0.5);
  });

  it('is neutral rather than NaN for a non-finite observation', () => {
    expect(evidenceGate(Number.NaN, 500, 100)).toBe(0.5);
  });
});

describe('resolveMedian', () => {
  it('prefers the category median, falls through, then gives up at 0', () => {
    expect(resolveMedian(0.03, 0.02)).toBe(0.03);
    expect(resolveMedian(0, 0.02)).toBe(0.02);
    expect(resolveMedian(0, 0)).toBe(0);
    expect(resolveMedian(Number.NaN, 0.02)).toBe(0.02);
  });
});

// ---------------------------------------------------------------------------
// 2.5x-MEDIAN NORMALISATION (spec 2.3)
// ---------------------------------------------------------------------------

describe('normToReference', () => {
  // The entire reason for the 2.5x. Normalising against the median itself would
  // put "perfectly average" at the top of the scale with no headroom above it.
  it('puts a video AT the category median at 0.4, not 1.0', () => {
    expect(normToReference(0.02, 0.02, 0.02)).toBeCloseTo(0.4, 12);
    expect(normToReference(0.02, 0.02, 0.02)).not.toBeCloseTo(1, 2);
    // Same shape at a completely different median: the answer is scale-free.
    expect(normToReference(0.35, 0.35, 0.01)).toBeCloseTo(0.4, 12);
  });

  it('reaches exactly 1.0 at 2.5x the median and clamps above it', () => {
    expect(normToReference(0.05, 0.02, 0.02)).toBeCloseTo(1, 12);
    expect(normToReference(0.5, 0.02, 0.02)).toBe(1);
  });

  it('uses the category median over the fallback, so "good" is per-category', () => {
    // The same 2% rate: excellent in a category whose median is 0.5%, mediocre
    // in one whose median is 4%.
    expect(normToReference(0.02, 0.005, 0.02)).toBeCloseTo(1, 12);
    expect(normToReference(0.02, 0.04, 0.02)).toBeCloseTo(0.2, 12);
  });

  it('falls back to the global median when a category has none yet', () => {
    expect(normToReference(0.02, 0, 0.02)).toBeCloseTo(0.4, 12);
  });

  // A brand-new category has a median of 0, and 2.5 * 0 is a reference of 0.
  // Dividing by it would pin every video in that category to the top of the
  // feed forever, which is the worst possible failure mode for a cold category.
  it('degrades to neutral rather than NaN or Infinity with no median at all', () => {
    for (const value of [0, 0.02, 5, 1e9]) {
      const r = normToReference(value, 0, 0);
      expect(r).toBe(0.5);
      expect(Number.isFinite(r)).toBe(true);
    }
    expect(normToReference(0.02, Number.NaN, Number.NaN)).toBe(0.5);
    expect(normToReference(0.02, -1, -1)).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// THE COMPOSITION — smooth, normalise, THEN gate
// ---------------------------------------------------------------------------

describe('gatedNormalisedRate', () => {
  // THE HEADLINE CASE, at the level of a single rate. Full-signal and
  // full-score versions live in signals.test.ts and score.test.ts.
  it('refuses to let 1-in-3 outscore a high-volume performer', () => {
    const fluke = gatedNormalisedRate(1, 3, 0.02, 0.02);
    const proven = gatedNormalisedRate(90, 2_000, 0.02, 0.02);
    expect(fluke).toBeCloseTo(0.5076415, 6);
    expect(proven).toBeCloseTo(0.8878049, 6);
    expect(proven).toBeGreaterThan(fluke);
  });

  it('is exactly 0.5 for a video with no impressions at all — no free ride', () => {
    expect(gatedNormalisedRate(0, 0, 0.02, 0.02)).toBe(0.5);
    // Even a nonsense conversion count with no impressions behind it.
    expect(gatedNormalisedRate(99, 0, 0.02, 0.02)).toBe(0.5);
  });

  it('is pure normalisation once the evidence threshold is met', () => {
    // 2% observed against a 2% median: exactly at the median, so smoothing is a
    // no-op and the gate is the identity. 0.4, straight through.
    expect(gatedNormalisedRate(0.02 * 100_000, 100_000, 0.02, 0.02)).toBeCloseTo(0.4, 12);
  });

  it('never produces NaN or Infinity for a category with no median', () => {
    for (const [conv, imp] of [[0, 0], [1, 3], [500, 10_000]] as const) {
      const v = gatedNormalisedRate(conv, imp, 0, 0);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBe(0.5);
    }
  });
});

describe('gatedNormalisedValue', () => {
  it('gates a measured level the same way, with nothing to smooth', () => {
    // avgLoopCount 1.2 against a 1.2 median -> 0.4, gated through at volume.
    expect(gatedNormalisedValue(1.2, 5_000, 1.2, 1.2)).toBeCloseTo(0.4, 12);
    // The same loop count seen 3 times means almost nothing.
    expect(gatedNormalisedValue(1.2, 3, 1.2, 1.2)).toBeCloseTo(0.497, 3);
    expect(gatedNormalisedValue(9_999, 0, 1.2, 1.2)).toBe(0.5);
  });
});

// This is a regression guard, not an endorsement. `gatedRate` implements the
// contract's formula verbatim and is correct on its own rate scale, but feeding
// its output to `normToReference` inverts the whole correction: 0.5 is neutral
// only AFTER normalisation, and a raw purchase rate blended toward 0.5 lands
// ~25x above the reference. The numbers below are the pathology, pinned so that
// nobody "simplifies" signals.ts back into this order without a failing test.
describe('gatedRate -> normToReference (the inverted order, pinned)', () => {
  it('hands the fluke and the zero-data video a perfect score', () => {
    const flukeInverted = normToReference(gatedRate(1, 3, 0.02), 0.02, 0.02);
    const noDataInverted = normToReference(gatedRate(0, 0, 0.02), 0.02, 0.02);
    const provenInverted = normToReference(gatedRate(90, 2_000, 0.02), 0.02, 0.02);

    expect(flukeInverted).toBe(1);
    expect(noDataInverted).toBe(1);
    expect(provenInverted).toBeCloseTo(0.8878049, 6);

    // Strictly worse than v1: the noise beats the evidence.
    expect(flukeInverted).toBeGreaterThan(provenInverted);

    // The correct order reverses it.
    expect(gatedNormalisedRate(90, 2_000, 0.02, 0.02)).toBeGreaterThan(
      gatedNormalisedRate(1, 3, 0.02, 0.02)
    );
  });
});
