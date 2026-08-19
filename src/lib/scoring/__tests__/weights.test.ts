import { describe, expect, it } from 'vitest';
import {
  FEED_WEIGHTS_SELECT,
  FEED_WEIGHTS_TABLE,
  loadActiveFeedWeights,
  pickWeightsRow,
  toColdStartLaneShares,
  toLaneShares,
  toSliceShape,
  toWeights,
  laneToDbValue,
  type FeedWeightsRow,
  type FeedWeightsSource,
} from '../weights';
import { DEFAULT_WEIGHTS, SELECTION } from '../types';
import { LANE_SHARES, COLD_START_LANE_SHARES } from '../candidates';

function controlRow(overrides: Partial<FeedWeightsRow> = {}): FeedWeightsRow {
  return {
    variant: 'control',
    is_active: true,
    traffic_share: '1.000',
    w_commerce: '0.350',
    w_engagement: '0.200',
    w_affinity: '0.200',
    w_freshness: '0.100',
    w_trust: '0.100',
    w_diversity: '0.050',
    p_fatigue: '0.150',
    p_quality: '0.250',
    lane_affinity: '0.350',
    lane_trending: '0.250',
    lane_fresh: '0.200',
    lane_social: '0.100',
    lane_random: '0.100',
    cold_lane_trending: '0.400',
    cold_lane_fresh: '0.300',
    cold_lane_random: '0.300',
    bayes_alpha: 50,
    freshness_half_life_hours: '72.00',
    candidate_pool_size: 500,
    slice_size: 20,
    exploration_budget: 500,
    min_fresh_per_slice: 3,
    max_per_seller_per_slice: 2,
    ...overrides,
  };
}

function sourceOf(result: { data: unknown; error: unknown }): FeedWeightsSource {
  return { from: () => ({ select: () => Promise.resolve(result) }) };
}

// ---------------------------------------------------------------------------
// toWeights
// ---------------------------------------------------------------------------

describe('toWeights', () => {
  it('maps a full row to Weights, string numerics included', () => {
    const w = toWeights(controlRow());
    expect(w.wCommerce).toBe(0.35);
    expect(w.wEngagement).toBe(0.2);
    expect(w.pQuality).toBe(0.25);
    expect(w.bayesAlpha).toBe(50);
    expect(w.freshnessHalfLifeHours).toBe(72);
  });

  it('evidenceThreshold and normReferenceMultiplier are code constants, never row-derived', () => {
    const w = toWeights(controlRow({ w_commerce: '0.99' }));
    expect(w.evidenceThreshold).toBe(SELECTION.EVIDENCE_THRESHOLD);
    expect(w.normReferenceMultiplier).toBe(DEFAULT_WEIGHTS.normReferenceMultiplier);
  });

  it('falls back to DEFAULT_WEIGHTS field-by-field on missing/garbage values', () => {
    const w = toWeights({ w_commerce: 'not-a-number', w_engagement: null });
    expect(w.wCommerce).toBe(DEFAULT_WEIGHTS.wCommerce);
    expect(w.wEngagement).toBe(DEFAULT_WEIGHTS.wEngagement);
  });
});

// ---------------------------------------------------------------------------
// toLaneShares / toColdStartLaneShares
// ---------------------------------------------------------------------------

describe('toLaneShares', () => {
  it('maps lane_random -> tail, the one explicit rename', () => {
    const shares = toLaneShares(controlRow({ lane_random: '0.42' }));
    expect(shares.tail).toBe(0.42);
  });

  it('maps every other lane 1:1 by column suffix', () => {
    const shares = toLaneShares(controlRow());
    expect(shares).toEqual({
      affinity: 0.35,
      trending: 0.25,
      fresh: 0.2,
      social: 0.1,
      tail: 0.1,
    });
  });

  it('falls back per-field to LANE_SHARES on garbage', () => {
    const shares = toLaneShares({ lane_affinity: 'nope' });
    expect(shares.affinity).toBe(LANE_SHARES.affinity);
  });
});

describe('toColdStartLaneShares', () => {
  it('forces affinity and social to 0 regardless of row content', () => {
    // Even if a future migration adds these columns and someone seeds a
    // nonzero value, this loader must not start trusting them silently.
    const shares = toColdStartLaneShares(
      controlRow({ cold_lane_affinity: '0.9', cold_lane_social: '0.9' } as FeedWeightsRow)
    );
    expect(shares.affinity).toBe(0);
    expect(shares.social).toBe(0);
  });

  it('maps trending/fresh/random(->tail) from the row', () => {
    const shares = toColdStartLaneShares(controlRow());
    expect(shares.trending).toBe(0.4);
    expect(shares.fresh).toBe(0.3);
    expect(shares.tail).toBe(0.3);
  });

  it('falls back to COLD_START_LANE_SHARES on garbage', () => {
    const shares = toColdStartLaneShares({});
    expect(shares.trending).toBe(COLD_START_LANE_SHARES.trending);
    expect(shares.fresh).toBe(COLD_START_LANE_SHARES.fresh);
    expect(shares.tail).toBe(COLD_START_LANE_SHARES.tail);
  });
});

// ---------------------------------------------------------------------------
// toSliceShape
// ---------------------------------------------------------------------------

describe('toSliceShape', () => {
  it('maps every slice-shape field', () => {
    expect(toSliceShape(controlRow())).toEqual({
      candidatePoolSize: 500,
      sliceSize: 20,
      explorationBudget: 500,
      minFreshPerSlice: 3,
      maxPerSellerPerSlice: 2,
    });
  });

  it('falls back to SELECTION defaults on missing fields', () => {
    const shape = toSliceShape({});
    expect(shape.sliceSize).toBe(SELECTION.SLICE_SIZE);
    expect(shape.minFreshPerSlice).toBe(SELECTION.FRESH_FLOOR);
  });
});

// ---------------------------------------------------------------------------
// pickWeightsRow — the bucketing logic
// ---------------------------------------------------------------------------

describe('pickWeightsRow', () => {
  it('returns null when no row is active', () => {
    const rows = [controlRow({ is_active: false })];
    expect(pickWeightsRow(rows, 0.5)).toBeNull();
  });

  it('returns null on an empty row set', () => {
    expect(pickWeightsRow([], 0.5)).toBeNull();
  });

  it('single active row always wins, any bucket value', () => {
    const rows = [controlRow()];
    expect(pickWeightsRow(rows, 0)?.variant).toBe('control');
    expect(pickWeightsRow(rows, 0.999)?.variant).toBe('control');
  });

  it('splits deterministically by cumulative traffic_share', () => {
    const rows = [
      controlRow({ variant: 'control', traffic_share: '0.900' }),
      controlRow({ variant: 'ranked_v2', traffic_share: '0.100' }),
    ];
    expect(pickWeightsRow(rows, 0.0)?.variant).toBe('control');
    expect(pickWeightsRow(rows, 0.5)?.variant).toBe('control');
    expect(pickWeightsRow(rows, 0.89)?.variant).toBe('control');
    expect(pickWeightsRow(rows, 0.91)?.variant).toBe('ranked_v2');
    expect(pickWeightsRow(rows, 0.999)?.variant).toBe('ranked_v2');
  });

  it('excludes inactive rows from the split entirely', () => {
    const rows = [
      controlRow({ variant: 'control', traffic_share: '0.500', is_active: false }),
      controlRow({ variant: 'ranked_v2', traffic_share: '0.500' }),
    ];
    // Only one active row remains, so it absorbs the whole bucket space.
    expect(pickWeightsRow(rows, 0.01)?.variant).toBe('ranked_v2');
    expect(pickWeightsRow(rows, 0.99)?.variant).toBe('ranked_v2');
  });

  it('a misconfigured sum (<1) still resolves to the last active row rather than undefined', () => {
    const rows = [
      controlRow({ variant: 'control', traffic_share: '0.100' }),
      controlRow({ variant: 'ranked_v2', traffic_share: '0.100' }),
    ];
    expect(pickWeightsRow(rows, 0.99)?.variant).toBe('ranked_v2');
  });

  it('clamps an out-of-range bucketValue instead of throwing', () => {
    const rows = [controlRow({ variant: 'control', traffic_share: '1.000' })];
    expect(pickWeightsRow(rows, -5)?.variant).toBe('control');
    expect(pickWeightsRow(rows, 5)?.variant).toBe('control');
    expect(pickWeightsRow(rows, Number.NaN)?.variant).toBe('control');
  });

  it('is deterministic: same rows + same bucketValue -> same pick, every time', () => {
    const rows = [
      controlRow({ variant: 'control', traffic_share: '0.700' }),
      controlRow({ variant: 'ranked_v2', traffic_share: '0.300' }),
    ];
    const picks = Array.from({ length: 20 }, () => pickWeightsRow(rows, 0.75)?.variant);
    expect(new Set(picks).size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// loadActiveFeedWeights — never throws
// ---------------------------------------------------------------------------

describe('loadActiveFeedWeights', () => {
  it('returns the full shape for a single active control row', async () => {
    const result = await loadActiveFeedWeights(sourceOf({ data: [controlRow()], error: null }), 0.5);
    expect(result?.variant).toBe('control');
    expect(result?.weights.wCommerce).toBe(0.35);
    expect(result?.laneShares.tail).toBe(0.1);
    expect(result?.slice.sliceSize).toBe(20);
  });

  it('returns null on a query error', async () => {
    const result = await loadActiveFeedWeights(
      sourceOf({ data: null, error: { message: 'boom' } }),
      0.5
    );
    expect(result).toBeNull();
  });

  it('returns null on empty data', async () => {
    const result = await loadActiveFeedWeights(sourceOf({ data: [], error: null }), 0.5);
    expect(result).toBeNull();
  });

  it('returns null on non-array data', async () => {
    const result = await loadActiveFeedWeights(
      sourceOf({ data: { unexpected: true }, error: null }),
      0.5
    );
    expect(result).toBeNull();
  });

  it('returns null, not a throw, when the client itself throws', async () => {
    const throwing: FeedWeightsSource = {
      from: () => ({
        select: () => {
          throw new Error('network down');
        },
      }),
    };
    await expect(loadActiveFeedWeights(throwing, 0.5)).resolves.toBeNull();
  });

  it('returns null when every row is inactive', async () => {
    const result = await loadActiveFeedWeights(
      sourceOf({ data: [controlRow({ is_active: false })], error: null }),
      0.5
    );
    expect(result).toBeNull();
  });

  it('buckets between two active variants using the real select list', async () => {
    const rows = [
      controlRow({ variant: 'control', traffic_share: '0.500' }),
      controlRow({ variant: 'ranked_v2', traffic_share: '0.500', w_commerce: '0.500' }),
    ];
    const low = await loadActiveFeedWeights(sourceOf({ data: rows, error: null }), 0.1);
    const high = await loadActiveFeedWeights(sourceOf({ data: rows, error: null }), 0.9);
    expect(low?.variant).toBe('control');
    expect(high?.variant).toBe('ranked_v2');
    expect(high?.weights.wCommerce).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// laneToDbValue
// ---------------------------------------------------------------------------

describe('laneToDbValue', () => {
  it('translates tail -> random, the DB enum value', () => {
    expect(laneToDbValue('tail')).toBe('random');
  });

  it('passes every other lane through unchanged', () => {
    expect(laneToDbValue('affinity')).toBe('affinity');
    expect(laneToDbValue('trending')).toBe('trending');
    expect(laneToDbValue('fresh')).toBe('fresh');
    expect(laneToDbValue('social')).toBe('social');
  });
});

// ---------------------------------------------------------------------------
// Constants sanity
// ---------------------------------------------------------------------------

describe('constants', () => {
  it('FEED_WEIGHTS_TABLE and FEED_WEIGHTS_SELECT are non-empty', () => {
    expect(FEED_WEIGHTS_TABLE).toBe('feed_weights');
    expect(FEED_WEIGHTS_SELECT.length).toBeGreaterThan(0);
    expect(FEED_WEIGHTS_SELECT).toContain('lane_random');
    expect(FEED_WEIGHTS_SELECT).not.toContain('lane_tail');
  });
});
