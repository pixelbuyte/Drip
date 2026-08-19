// The load path for spec 2.3's A/B-tunable weights and lane shares.
//
// Migration 00007 (via feed_weights) is the config table; this is the other
// half — it turns rows into the exact `Weights`/`LaneShares` shapes the pure
// core already consumes, plus the bucketing that picks WHICH row a given
// viewer sees. Same split as ./medians:
//
//   toWeights() / toLaneShares() / toColdStartLaneShares()   pure transforms,
//     rows in -> typed shapes out. Testable with a literal array, no database.
//   loadActiveFeedWeights()   the thinnest possible fetch + bucket-selection
//     around them, taking the client structurally so this module imports
//     nothing beyond ./types and ./candidates.
//
// The determinism contract in ./types applies: no clock, no randomness, no
// Math.random. Bucketing takes an explicit bucketValue in [0,1) — the caller
// derives it from the viewer's anon id via ./bucket, once per request.

import {
  DEFAULT_WEIGHTS,
  SELECTION,
  NORM_REFERENCE_MULTIPLIER,
  type CandidateLane,
  type LaneShares,
  type Weights,
} from './types';
import { LANE_SHARES, COLD_START_LANE_SHARES } from './candidates';

/** The table migration 00007 creates. */
export const FEED_WEIGHTS_TABLE = 'feed_weights';

export const FEED_WEIGHTS_SELECT = [
  'variant',
  'is_active',
  'traffic_share',
  'w_commerce',
  'w_engagement',
  'w_affinity',
  'w_freshness',
  'w_trust',
  'w_diversity',
  'p_fatigue',
  'p_quality',
  'lane_affinity',
  'lane_trending',
  'lane_fresh',
  'lane_social',
  'lane_random',
  'cold_lane_trending',
  'cold_lane_fresh',
  'cold_lane_random',
  'bayes_alpha',
  'freshness_half_life_hours',
  'candidate_pool_size',
  'slice_size',
  'exploration_budget',
  'min_fresh_per_slice',
  'max_per_seller_per_slice',
].join(',');

/**
 * One row of `feed_weights` as it comes off the wire. Deliberately
 * `unknown`-valued for the same reason as `CategoryMedianRow`: PostgREST
 * renders `numeric` as a JSON number, node-postgres as a string. The
 * transform owns coercion so no caller has to.
 */
export type FeedWeightsRow = {
  variant?: unknown;
  is_active?: unknown;
  traffic_share?: unknown;
  [column: string]: unknown;
};

export type SliceShape = {
  candidatePoolSize: number;
  sliceSize: number;
  explorationBudget: number;
  minFreshPerSlice: number;
  maxPerSellerPerSlice: number;
};

export type ActiveFeedWeights = {
  variant: string;
  weights: Weights;
  laneShares: LaneShares;
  coldStartLaneShares: LaneShares;
  slice: SliceShape;
};

function coerceNumber(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

function num(row: FeedWeightsRow, column: string, fallback: number): number {
  return coerceNumber(row[column]) ?? fallback;
}

/**
 * Row -> `Weights`. Pure. `evidenceThreshold`/`normReferenceMultiplier` are
 * not `feed_weights` columns — they stay code constants for v1, since no
 * experiment has yet needed per-variant control over the evidence gate
 * itself rather than the signals it gates.
 */
export function toWeights(row: FeedWeightsRow): Weights {
  return {
    wCommerce: num(row, 'w_commerce', DEFAULT_WEIGHTS.wCommerce),
    wEngagement: num(row, 'w_engagement', DEFAULT_WEIGHTS.wEngagement),
    wAffinity: num(row, 'w_affinity', DEFAULT_WEIGHTS.wAffinity),
    wFreshness: num(row, 'w_freshness', DEFAULT_WEIGHTS.wFreshness),
    wTrust: num(row, 'w_trust', DEFAULT_WEIGHTS.wTrust),
    wDiversity: num(row, 'w_diversity', DEFAULT_WEIGHTS.wDiversity),
    pFatigue: num(row, 'p_fatigue', DEFAULT_WEIGHTS.pFatigue),
    pQuality: num(row, 'p_quality', DEFAULT_WEIGHTS.pQuality),
    bayesAlpha: num(row, 'bayes_alpha', DEFAULT_WEIGHTS.bayesAlpha),
    freshnessHalfLifeHours: num(
      row,
      'freshness_half_life_hours',
      DEFAULT_WEIGHTS.freshnessHalfLifeHours
    ),
    evidenceThreshold: SELECTION.EVIDENCE_THRESHOLD,
    normReferenceMultiplier: NORM_REFERENCE_MULTIPLIER,
  };
}

/**
 * Row -> warm-viewer `LaneShares`. The one explicit rename in this file: DB
 * `lane_random` is code `'tail'` — v2 renamed the lane because it was never
 * uniformly random, it is the sampled long tail (see ./types). Every other
 * lane name matches its column suffix exactly.
 */
export function toLaneShares(row: FeedWeightsRow): LaneShares {
  return {
    affinity: num(row, 'lane_affinity', LANE_SHARES.affinity),
    trending: num(row, 'lane_trending', LANE_SHARES.trending),
    fresh: num(row, 'lane_fresh', LANE_SHARES.fresh),
    social: num(row, 'lane_social', LANE_SHARES.social),
    tail: num(row, 'lane_random', LANE_SHARES.tail),
  };
}

/**
 * Row -> cold-start `LaneShares`. `affinity` and `social` are hardcoded to 0
 * regardless of what the row contains, because `feed_weights` has no
 * `cold_lane_affinity`/`cold_lane_social` columns at all — a brand-new viewer
 * has no affinity signal and no follows yet, so there is nothing honest to
 * put there. This mirrors `COLD_START_LANE_SHARES`'s existing "don't pretend"
 * design; it is not a gap this loader is meant to fill.
 */
export function toColdStartLaneShares(row: FeedWeightsRow): LaneShares {
  return {
    affinity: 0,
    trending: num(row, 'cold_lane_trending', COLD_START_LANE_SHARES.trending),
    fresh: num(row, 'cold_lane_fresh', COLD_START_LANE_SHARES.fresh),
    social: 0,
    tail: num(row, 'cold_lane_random', COLD_START_LANE_SHARES.tail),
  };
}

export function toSliceShape(row: FeedWeightsRow): SliceShape {
  return {
    candidatePoolSize: num(row, 'candidate_pool_size', 500),
    sliceSize: num(row, 'slice_size', SELECTION.SLICE_SIZE),
    explorationBudget: num(row, 'exploration_budget', 500),
    minFreshPerSlice: num(row, 'min_fresh_per_slice', SELECTION.FRESH_FLOOR),
    maxPerSellerPerSlice: num(row, 'max_per_seller_per_slice', 2),
  };
}

function isActive(row: FeedWeightsRow): boolean {
  return row.is_active === true || row.is_active === 'true' || row.is_active === 't';
}

function variantName(row: FeedWeightsRow): string {
  return typeof row.variant === 'string' && row.variant.length > 0 ? row.variant : 'control';
}

/**
 * Pick a row by cumulative `traffic_share`, given a caller-supplied
 * `bucketValue` in [0,1). Deterministic and pure: the same bucket value
 * against the same rows always picks the same variant, which is what makes a
 * viewer's A/B assignment stable across requests (see ./bucket).
 *
 * `is_active=false` rows are excluded first. If the active shares do not sum
 * to 1 (a config error, or a share was just lowered mid-request), the last
 * row absorbs the remainder rather than the bucket falling through to
 * nothing — so a slightly-misconfigured `traffic_share` degrades to "picks
 * the last active variant more often than intended", never to "picks no
 * variant and the caller gets undefined behaviour".
 */
export function pickWeightsRow(
  rows: readonly FeedWeightsRow[],
  bucketValue: number
): FeedWeightsRow | null {
  const active = rows.filter(isActive);
  if (active.length === 0) return null;

  const b = Number.isFinite(bucketValue) ? Math.min(Math.max(bucketValue, 0), 1) : 0;
  let cumulative = 0;
  for (let i = 0; i < active.length; i++) {
    const share = coerceNumber(active[i].traffic_share) ?? 0;
    cumulative += Math.max(0, share);
    if (b < cumulative || i === active.length - 1) return active[i];
  }
  return active[active.length - 1];
}

/**
 * The minimum surface of a Supabase client this loader needs. Structural
 * rather than imported, same rationale as `CategoryMedianSource`.
 */
export type FeedWeightsSource = {
  from(table: string): {
    select(columns: string): PromiseLike<{ data: unknown; error: unknown }>;
  };
};

/**
 * Read `feed_weights`, bucket the viewer into an active variant, and return
 * the fully-typed shapes the ranked-feed orchestrator needs.
 *
 * Returns `null` — never throws — when there is nothing usable: no active
 * row, a fetch error, or an unreachable table. `null` is the caller's signal
 * to fall back to the naive chronological feed; ranking is a refinement, and
 * its own config being unavailable must never turn into a 500 on the feed's
 * only working path. Mirrors `loadCategoryMedians`'s contract exactly.
 */
export async function loadActiveFeedWeights(
  source: FeedWeightsSource,
  bucketValue: number
): Promise<ActiveFeedWeights | null> {
  try {
    const { data, error } = await source.from(FEED_WEIGHTS_TABLE).select(FEED_WEIGHTS_SELECT);
    if (error || !Array.isArray(data) || data.length === 0) return null;

    const row = pickWeightsRow(data as FeedWeightsRow[], bucketValue);
    if (!row) return null;

    return {
      variant: variantName(row),
      weights: toWeights(row),
      laneShares: toLaneShares(row),
      coldStartLaneShares: toColdStartLaneShares(row),
      slice: toSliceShape(row),
    };
  } catch {
    return null;
  }
}

/** Re-exported so callers translating a lane for a DB write have one source. */
export function laneToDbValue(lane: CandidateLane): string {
  return lane === 'tail' ? 'random' : lane;
}
