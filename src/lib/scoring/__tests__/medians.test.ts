import { describe, expect, it } from 'vitest';
import {
  CATEGORY_MEDIANS_SELECT,
  CATEGORY_MEDIANS_TABLE,
  MEDIAN_RATE_COLUMNS,
  coerceMedian,
  loadCategoryMedians,
  toCategoryMedians,
  type CategoryMedianRow,
  type CategoryMedianSource,
} from '../medians';
import {
  DEFAULT_CATEGORY_MEDIANS,
  makeMedianResolver,
  medianFor,
  NORM_REFERENCE_MULTIPLIER,
  type NormalisableRate,
} from '../types';
import { normToReference, resolveMedian } from '../normalize';

const CAT_A = '1a5be720-50ea-4f89-b2b4-2dcb41469e61';
const CAT_B = 'a5a3a4cc-045d-4c04-9518-ccfae3538af5';

const RATES = Object.keys(MEDIAN_RATE_COLUMNS) as NormalisableRate[];

/** A complete row, in the wire's snake_case, from a rate -> value map. */
function row(categoryId: string | null, values: Partial<Record<NormalisableRate, unknown>>) {
  const out: CategoryMedianRow = { category_id: categoryId };
  for (const rate of RATES) out[MEDIAN_RATE_COLUMNS[rate]] = values[rate] ?? null;
  return out;
}

/** A source whose select() resolves to whatever is handed in. */
function sourceOf(result: { data: unknown; error: unknown }): CategoryMedianSource {
  return { from: () => ({ select: () => Promise.resolve(result) }) };
}

// ---------------------------------------------------------------------------
// Empty / unreachable
// ---------------------------------------------------------------------------

describe('toCategoryMedians — nothing to load', () => {
  it('returns the shipped defaults for an empty table', () => {
    expect(toCategoryMedians([])).toBe(DEFAULT_CATEGORY_MEDIANS);
  });

  it('returns the shipped defaults for null/undefined', () => {
    expect(toCategoryMedians(null)).toBe(DEFAULT_CATEGORY_MEDIANS);
    expect(toCategoryMedians(undefined)).toBe(DEFAULT_CATEGORY_MEDIANS);
  });

  // The whole point of the fallback: with no medians the feed must degrade to
  // v1's global caps, which is exactly what 2.5x each default reproduces.
  it('degrades to v1 behaviour rather than to a division by zero', () => {
    const m = toCategoryMedians([]);
    for (const rate of RATES) {
      expect(m.fallback[rate]).toBeGreaterThan(0);
      expect(normToReference(m.fallback[rate], 0, m.fallback[rate])).toBeCloseTo(
        1 / NORM_REFERENCE_MULTIPLIER,
        10
      );
    }
  });

  it('treats rows that carry no usable number as no rows at all', () => {
    expect(toCategoryMedians([row(CAT_A, {}), row(null, {})])).toBe(DEFAULT_CATEGORY_MEDIANS);
  });
});

// ---------------------------------------------------------------------------
// The global fallback row
// ---------------------------------------------------------------------------

describe('toCategoryMedians — the global row', () => {
  // These are the numbers migration 00013 actually produced on the local
  // replica for the verification fixture (51 samples, median u = 12).
  const GLOBAL = row(null, {
    purchaseRate: 0.012,
    cartRate: 0.112,
    tapRate: 0.212,
    shareRate: 0.312,
    saveRate: 0.412,
    avgLoopCount: 0.812,
    skipUnder2sRate: 0.512,
    reportRate: 0.612,
    notInterestedRate: 0.712,
  });

  it('becomes `fallback`, replacing every measured default', () => {
    const m = toCategoryMedians([GLOBAL]);
    expect(m.fallback).toEqual({
      purchaseRate: 0.012,
      cartRate: 0.112,
      tapRate: 0.212,
      shareRate: 0.312,
      saveRate: 0.412,
      avgLoopCount: 0.812,
      skipUnder2sRate: 0.512,
      reportRate: 0.612,
      notInterestedRate: 0.712,
    });
    expect(m.byCategory).toEqual({});
  });

  // `fallback` is typed complete and every consumer relies on that, so a rate
  // the job could not measure must keep its shipped default, not vanish.
  it('layers over the defaults per rate rather than replacing wholesale', () => {
    const m = toCategoryMedians([row(null, { tapRate: 0.212 })]);
    expect(m.fallback.tapRate).toBe(0.212);
    expect(m.fallback.purchaseRate).toBe(DEFAULT_CATEGORY_MEDIANS.fallback.purchaseRate);
    expect(Object.keys(m.fallback).sort()).toEqual([...RATES].sort());
  });

  it('does not mutate DEFAULT_CATEGORY_MEDIANS', () => {
    const before = { ...DEFAULT_CATEGORY_MEDIANS.fallback };
    toCategoryMedians([row(null, { tapRate: 0.9 })]);
    expect(DEFAULT_CATEGORY_MEDIANS.fallback).toEqual(before);
    expect(DEFAULT_CATEGORY_MEDIANS.byCategory).toEqual({});
  });

  // 00013 deliberately writes no row for the uncategorised group; those videos
  // are meant to land on the global row via medianFor's '' lookup.
  it('serves uncategorised videos through the same row', () => {
    const m = toCategoryMedians([row(null, { tapRate: 0.212 })]);
    expect(medianFor(m, 'tapRate', null)).toBe(0.212);
    expect(medianFor(m, 'tapRate', '')).toBe(0.212);
  });
});

// ---------------------------------------------------------------------------
// Per-category rows and per-rate fallback
// ---------------------------------------------------------------------------

describe('toCategoryMedians — per-category rows', () => {
  it('keys byCategory by category_id and leaves the fallback alone', () => {
    const m = toCategoryMedians([row(CAT_A, { tapRate: 0.211, purchaseRate: 0.011 })]);
    expect(m.byCategory[CAT_A]).toEqual({ tapRate: 0.211, purchaseRate: 0.011 });
    expect(m.fallback).toEqual(DEFAULT_CATEGORY_MEDIANS.fallback);
  });

  // THE per-rate rule. A category with a trustworthy tap rate and no purchase
  // signal must keep its tap rate; throwing the row away over one null column
  // discards good evidence.
  it('falls back PER RATE, not wholesale, for a partial category', () => {
    const m = toCategoryMedians([
      row(null, { purchaseRate: 0.012, tapRate: 0.212 }),
      row(CAT_A, { tapRate: 0.211, purchaseRate: null }),
    ]);
    expect(medianFor(m, 'tapRate', CAT_A)).toBe(0.211); // the category's own
    expect(medianFor(m, 'purchaseRate', CAT_A)).toBe(0.012); // the global row's
    expect(medianFor(m, 'saveRate', CAT_A)).toBe(DEFAULT_CATEGORY_MEDIANS.fallback.saveRate);
  });

  it('omits a missing rate rather than storing undefined', () => {
    const m = toCategoryMedians([row(CAT_A, { tapRate: 0.211 })]);
    expect('purchaseRate' in m.byCategory[CAT_A]).toBe(false);
  });

  it('keeps categories independent', () => {
    const m = toCategoryMedians([
      row(CAT_A, { tapRate: 0.211 }),
      row(CAT_B, { tapRate: 0.2115 }),
    ]);
    expect(medianFor(m, 'tapRate', CAT_A)).toBe(0.211);
    expect(medianFor(m, 'tapRate', CAT_B)).toBe(0.2115);
  });

  it('drops a category row with nothing usable so it resolves to the fallback', () => {
    const m = toCategoryMedians([row(null, { tapRate: 0.212 }), row(CAT_A, { tapRate: 0 })]);
    expect(m.byCategory[CAT_A]).toBeUndefined();
    expect(medianFor(m, 'tapRate', CAT_A)).toBe(0.212);
  });

  it('ignores a row whose category_id is not a usable string', () => {
    const m = toCategoryMedians([{ category_id: 42, tap_rate: 0.5 }]);
    // 42 is not a string, so it is treated as the global row, not as key '42'.
    expect(m.byCategory).toEqual({});
    expect(m.fallback.tapRate).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// Degenerate medians — normToReference divides by these
// ---------------------------------------------------------------------------

describe('coerceMedian — the trust boundary', () => {
  it('accepts a positive number', () => {
    expect(coerceMedian(0.211)).toBe(0.211);
  });

  // node-postgres hands back `numeric` as a string; PostgREST hands back a
  // number. Both have to work or the medians silently vanish on one driver.
  it('accepts a numeric string, as node-postgres renders numeric', () => {
    expect(coerceMedian('0.0115')).toBe(0.0115);
  });

  it('rejects zero — 2.5 * 0 is a reference of 0, i.e. Infinity or NaN', () => {
    expect(coerceMedian(0)).toBeUndefined();
    expect(coerceMedian('0')).toBeUndefined();
  });

  it('rejects negatives', () => {
    expect(coerceMedian(-0.01)).toBeUndefined();
  });

  it('rejects null, undefined, NaN, Infinity and junk', () => {
    for (const v of [null, undefined, NaN, Infinity, -Infinity, '', 'abc', {}, [], true]) {
      expect(coerceMedian(v)).toBeUndefined();
    }
  });
});

describe('toCategoryMedians — degenerate medians are rejected in favour of the fallback', () => {
  it('a zero category median falls through to the global one', () => {
    const m = toCategoryMedians([
      row(null, { purchaseRate: 0.012 }),
      row(CAT_A, { purchaseRate: 0, tapRate: 0.211 }),
    ]);
    expect(medianFor(m, 'purchaseRate', CAT_A)).toBe(0.012);
    expect(medianFor(m, 'tapRate', CAT_A)).toBe(0.211);
  });

  it('a zero GLOBAL median keeps the shipped default', () => {
    const m = toCategoryMedians([row(null, { purchaseRate: 0, tapRate: 0.212 })]);
    expect(m.fallback.purchaseRate).toBe(DEFAULT_CATEGORY_MEDIANS.fallback.purchaseRate);
    expect(m.fallback.tapRate).toBe(0.212);
  });

  it('a negative or non-finite median never reaches normToReference', () => {
    const m = toCategoryMedians([
      row(null, { purchaseRate: 0.012 }),
      row(CAT_A, { purchaseRate: -1, cartRate: NaN, tapRate: 'Infinity' }),
    ]);
    for (const rate of RATES) {
      const v = medianFor(m, rate, CAT_A);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
  });

  // The failure this whole guard exists to stop: a reference of 0 pins every
  // video in the category to 1.0 and hands it the top of the feed.
  it('never produces a resolved reference that is 0, NaN or Infinity', () => {
    const m = toCategoryMedians([
      row(null, { purchaseRate: 0, cartRate: -3 }),
      row(CAT_A, { purchaseRate: 0, cartRate: 'oops' }),
    ]);
    for (const rate of RATES) {
      const median = medianFor(m, rate, CAT_A);
      const reference = resolveMedian(median, m.fallback[rate]) * NORM_REFERENCE_MULTIPLIER;
      expect(Number.isFinite(reference)).toBe(true);
      expect(reference).toBeGreaterThan(0);
      expect(normToReference(1e9, median, m.fallback[rate])).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// The shape the scoring code already expects
// ---------------------------------------------------------------------------

describe('toCategoryMedians — shape', () => {
  // Verified against migration 00013 on the local replica: apparel is the odd
  // (21-sample) bucket, footwear the even (22-sample) one whose medians
  // percentile_cont interpolates to the half-way value.
  const ROWS = [
    row(null, {
      purchaseRate: 0.012,
      cartRate: 0.112,
      tapRate: 0.212,
      shareRate: 0.312,
      saveRate: 0.412,
      avgLoopCount: 0.812,
      skipUnder2sRate: 0.512,
      reportRate: 0.612,
      notInterestedRate: 0.712,
    }),
    row(CAT_A, {
      purchaseRate: 0.011,
      cartRate: 0.111,
      tapRate: 0.211,
      shareRate: 0.311,
      saveRate: 0.411,
      avgLoopCount: 0.811,
      skipUnder2sRate: 0.511,
      reportRate: 0.611,
      notInterestedRate: 0.711,
    }),
    row(CAT_B, {
      purchaseRate: 0.0115,
      cartRate: 0.1115,
      tapRate: 0.2115,
      shareRate: 0.3115,
      saveRate: 0.4115,
      avgLoopCount: 0.8115,
      skipUnder2sRate: 0.5115,
      reportRate: 0.6115,
      notInterestedRate: 0.7115,
    }),
  ];

  it('is exactly what makeMedianResolver consumes', () => {
    const m = toCategoryMedians(ROWS);
    const resolve = makeMedianResolver(m);
    expect(resolve('purchaseRate', CAT_A)).toBe(0.011);
    expect(resolve('purchaseRate', CAT_B)).toBe(0.0115);
    expect(resolve('purchaseRate', 'a-category-with-no-row')).toBe(0.012);
    expect(resolve('purchaseRate', null)).toBe(0.012);
  });

  it('carries a complete fallback and only Partial category entries', () => {
    const m = toCategoryMedians(ROWS);
    expect(Object.keys(m.fallback).sort()).toEqual([...RATES].sort());
    expect(Object.keys(m.byCategory).sort()).toEqual([CAT_A, CAT_B].sort());
    for (const rate of RATES) expect(typeof m.fallback[rate]).toBe('number');
  });

  // The even-count bucket's medians differ from the odd one's by exactly
  // 0.0005 — the interpolation signature. percentile_disc would have snapped
  // to an observation and this would read 0.011 or 0.012.
  it('preserves the interpolated median of an even sample count', () => {
    const m = toCategoryMedians(ROWS);
    expect(medianFor(m, 'purchaseRate', CAT_B) - medianFor(m, 'purchaseRate', CAT_A)).toBeCloseTo(
      0.0005,
      10
    );
  });

  it('feeds normToReference the 2.5x reference the spec asks for', () => {
    const m = toCategoryMedians(ROWS);
    // A video exactly at its category median normalises to 1/2.5 = 0.4, which
    // is the whole point of the 2.5x: average is average, not perfect.
    expect(normToReference(0.011, medianFor(m, 'purchaseRate', CAT_A), m.fallback.purchaseRate))
      .toBeCloseTo(0.4, 10);
    // And 2.5x the median is exactly the top of the scale.
    expect(
      normToReference(0.011 * 2.5, medianFor(m, 'purchaseRate', CAT_A), m.fallback.purchaseRate)
    ).toBe(1);
  });

  it('is stable under a repeated load', () => {
    expect(toCategoryMedians(ROWS)).toEqual(toCategoryMedians(ROWS));
  });
});

// ---------------------------------------------------------------------------
// The loader
// ---------------------------------------------------------------------------

describe('loadCategoryMedians', () => {
  it('asks for the right table and columns', async () => {
    const seen: { table?: string; columns?: string } = {};
    await loadCategoryMedians({
      from: (table) => {
        seen.table = table;
        return {
          select: (columns) => {
            seen.columns = columns;
            return Promise.resolve({ data: [], error: null });
          },
        };
      },
    });
    expect(seen.table).toBe(CATEGORY_MEDIANS_TABLE);
    expect(seen.columns).toBe(CATEGORY_MEDIANS_SELECT);
    expect(seen.columns).toContain('category_id');
    for (const column of Object.values(MEDIAN_RATE_COLUMNS)) {
      expect(seen.columns).toContain(column);
    }
  });

  it('transforms the rows it gets', async () => {
    const m = await loadCategoryMedians(
      sourceOf({ data: [row(CAT_A, { tapRate: 0.211 })], error: null })
    );
    expect(medianFor(m, 'tapRate', CAT_A)).toBe(0.211);
  });

  it('falls back to the defaults when the table is empty', async () => {
    expect(await loadCategoryMedians(sourceOf({ data: [], error: null }))).toBe(
      DEFAULT_CATEGORY_MEDIANS
    );
  });

  // A missing medians table must cost the feed its refinement, never a 500.
  it('falls back to the defaults on a query error', async () => {
    expect(
      await loadCategoryMedians(sourceOf({ data: null, error: { message: 'no such table' } }))
    ).toBe(DEFAULT_CATEGORY_MEDIANS);
  });

  it('falls back to the defaults when the client throws', async () => {
    const exploding: CategoryMedianSource = {
      from: () => {
        throw new Error('unreachable');
      },
    };
    expect(await loadCategoryMedians(exploding)).toBe(DEFAULT_CATEGORY_MEDIANS);
  });

  it('falls back to the defaults when data is not an array', async () => {
    expect(await loadCategoryMedians(sourceOf({ data: { oops: true }, error: null }))).toBe(
      DEFAULT_CATEGORY_MEDIANS
    );
  });
});
