import type { SupabaseClient } from '@supabase/supabase-js';
import {
  bucketValue,
  fnv1a32,
  loadActiveFeedWeights,
  loadCategoryMedians,
  laneToDbValue,
  generateCandidates,
  scoreCandidate,
  select,
  budgetOwedIds,
  thinCategoryMultiplier,
  mulberry32,
  type CandidateLane,
  type PoolVideo,
  type RecentContext,
  type ScoredCandidate,
} from '@/lib/scoring';
import { loadPool } from './pool';
import { loadViewerContext } from './viewer-context';
import { getFeedSlice, recordSlice, type SliceParams } from './slice';
import { loadFeedItemDetails } from './item-details';
import { FEED_SLICE_SIZE, SSR_PLACEHOLDER_SESSION_ID, type FeedItem, type FeedLane } from './types';

/**
 * The impure orchestrator for the ranked feed — direct counterpart to
 * `getFeedSlice`. Composes, in order: `feed_weights` (the A/B config) ->
 * category medians -> the candidate pool -> the viewer's affinity/blocks/
 * purchase context -> `generateCandidates` -> `scoreCandidate` ->
 * `select` -> back to the wire `FeedItem[]` shape, writing the real lane and
 * score to `feed_slices` along the way.
 *
 * `getFeedSliceRankedOrNaive` is the ONE shared "ranked or naive" decision
 * point both `src/app/api/feed/route.ts` and `src/app/feed/page.tsx` call —
 * neither duplicates this branching, so a viewer's first SSR'd slide and
 * every slide after it agree on which path they are on. `slice.ts` itself is
 * never modified: it stays the permanent, zero-deploy fallback. Any failure
 * here — missing `feed_weights` config, an empty pool, a query error, a bug —
 * degrades to the naive chronological feed rather than a 500. Ranking is a
 * refinement; it is never allowed to cost the viewer their feed.
 */

/** No shipping-country column exists yet (see pool.ts) — every seller placeholder
 * ships everywhere, so any non-empty code satisfies `shipsToViewer`. Used when
 * the hosting platform's geo header is absent (local dev, non-Vercel hosting). */
const UNKNOWN_COUNTRY = 'XX';

const COUNTRY_RE = /^[A-Za-z]{2}$/;

/** `x-vercel-ip-country` (or any similarly-shaped header value) -> a
 * `ViewerContext.countryCode`. Never throws, never returns an empty string —
 * `shipsToViewer` fails closed on an empty country and would exclude every
 * seller in this schema's current all-placeholder state. */
export function resolveCountryCode(headerValue: string | null | undefined): string {
  if (headerValue && COUNTRY_RE.test(headerValue)) return headerValue.toUpperCase();
  return UNKNOWN_COUNTRY;
}

const SCORE_MIN = -9.99999;
const SCORE_MAX = 9.99999;

/** `feed_slices.score` is `numeric(6,5)` — one digit before the decimal.
 * Scores are deliberately unclamped upstream (see score.ts), so the write
 * path is where overflow has to be caught, not the scoring math. */
function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.min(SCORE_MAX, Math.max(SCORE_MIN, score));
}

function one<T>(v: T | T[] | null | undefined): T | null {
  if (!v) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

// ---------------------------------------------------------------------------
// Recent-context read-back
// ---------------------------------------------------------------------------

/** Generous bound on a single session's `feed_slices` history. `signals.ts`
 * only ever looks at the first 5-8 entries for diversity/fatigue, but
 * `seenSellerIds` (constraint 7, select.ts) needs every seller this SESSION
 * has ever shown — capped here rather than left unbounded, since the primary
 * key (session_id, video_id) makes this an efficient prefix scan either way. */
const RECENT_CONTEXT_LIMIT = 300;

type RecentSliceRow = {
  video_id: string;
  videos: { seller_id: string; category_id: string | null } | { seller_id: string; category_id: string | null }[] | null;
};

/**
 * `feed_slices` for this session, most-recent first, joined to `videos` for
 * seller/category — `feed_slices` itself stores neither. Ordered arrays feed
 * `diversityBonus`/`fatiguePenalty` (which only read the first few entries);
 * `seenSellerIds` accumulates every seller across the whole read-back, not
 * just the recent window, since constraint 7 asks "has this viewer seen ANY
 * seller in this slice before", not "recently".
 *
 * A served video's price only counts toward `priceCents` when it is still in
 * the freshly-loaded pool — a video that fell out (sold out, unpublished)
 * has no current price to be diverse against, so it is skipped for that one
 * signal rather than guessed at.
 */
async function loadRecentContext(
  db: SupabaseClient,
  sessionId: string,
  poolByVideoId: ReadonlyMap<string, PoolVideo>
): Promise<RecentContext> {
  const { data } = await db
    .from('feed_slices')
    .select('video_id, videos ( seller_id, category_id )')
    .eq('session_id', sessionId)
    .order('position', { ascending: false })
    .limit(RECENT_CONTEXT_LIMIT);

  const sellerIds: string[] = [];
  const categoryIds: (string | null)[] = [];
  const priceCents: number[] = [];
  const seenSellerIds = new Set<string>();

  for (const row of (data ?? []) as RecentSliceRow[]) {
    const v = one(row.videos);
    if (!v) continue;
    seenSellerIds.add(v.seller_id);

    const pv = poolByVideoId.get(row.video_id);
    if (pv) {
      sellerIds.push(pv.sellerId);
      categoryIds.push(pv.categoryId);
      priceCents.push(pv.minPriceCents);
    } else {
      sellerIds.push(v.seller_id);
      categoryIds.push(v.category_id);
    }
  }

  return { sellerIds, categoryIds, priceCents, seenSellerIds };
}

// ---------------------------------------------------------------------------
// feed_slices write-back — real lane, real (clamped) score
// ---------------------------------------------------------------------------

type RankedSliceWriteRow = { videoId: string; lane: FeedLane; score: number };

/** Best-effort, non-blocking — same posture as `slice.ts`'s `recordSlice`.
 * Unlike the naive path, this carries a real lane and a real score, which is
 * the whole reason `feed_slices.score` exists. */
async function recordRankedSlice(
  db: SupabaseClient,
  args: { sessionId: string; anonId: string; items: readonly RankedSliceWriteRow[]; offset: number }
): Promise<void> {
  if (args.items.length === 0) return;
  // Every anonymous visitor's SSR page render shares this same placeholder
  // session id (see feed/page.tsx) — writing under it would collide every
  // visitor's first slice into one (session_id, video_id) primary key.
  if (args.sessionId === SSR_PLACEHOLDER_SESSION_ID) return;
  const rows = args.items.map((it, i) => ({
    session_id: args.sessionId,
    anon_id: args.anonId,
    video_id: it.videoId,
    lane: it.lane,
    position: args.offset + i,
    score: it.score,
  }));
  const { error } = await db.from('feed_slices').upsert(rows, {
    onConflict: 'session_id,video_id',
    ignoreDuplicates: true,
  });
  if (error) console.error('ranked feed_slices write failed:', error.message);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export type RankedOrNaiveParams = SliceParams & {
  /** ISO-3166 alpha-2, from `resolveCountryCode`. Optional: falls back to
   * `UNKNOWN_COUNTRY` so a caller that has not wired the geo header yet still
   * gets a ranked feed rather than one that fails `shipsToViewer` for
   * everyone. */
  countryCode?: string;
  /** Position offset for this page of the session, for `feed_slices.position`
   * and to vary the selection rng across pages. Default 0. */
  offset?: number;
};

function laneOf(lane: CandidateLane): FeedLane {
  return laneToDbValue(lane) as FeedLane;
}

/**
 * `feed_weights.variant = 'control'` is NOT the same as "ranking is on".
 * Migration 00009 seeds `control` with `is_active=true, traffic_share=1.000`
 * as the spec's baseline weights, already live in production — its own
 * comment says "read by nothing until FEED_SCORING_ENABLED is on", but no
 * such flag was ever wired to code. If `getRankedFeedSlice` treated `control`
 * being active as its go-ahead, merging this file at all would silently
 * switch 100% of production traffic onto the brand-new ranked pipeline the
 * moment it deployed — the opposite of the Phase 6 rollout this codebase
 * documents (ship dark, then raise a non-`control` variant's `traffic_share`
 * from 0 in small steps). `control` bucketing here just falls through to the
 * naive feed, exactly as if no row were active at all.
 */
const CONTROL_VARIANT = 'control';

/**
 * Returns `null` — never throws for a missing-config reason — when there is
 * no active `feed_weights` row for this viewer's bucket (or only `control`
 * is active): that is the Phase 6 rollout's off switch, and it must read as
 * "use the naive feed", not as an error. Genuine failures (a query error, a
 * bug) DO throw, so the caller (`getFeedSliceRankedOrNaive`) can log them
 * distinctly before falling back.
 */
export async function getRankedFeedSlice(
  db: SupabaseClient,
  params: RankedOrNaiveParams
): Promise<{ items: FeedItem[]; exhausted: boolean; nextBefore: null } | null> {
  const now = new Date();
  const limit = params.limit ?? FEED_SLICE_SIZE;
  const offset = params.offset ?? 0;

  const active = await loadActiveFeedWeights(db, bucketValue(params.anonId, 'ranked_v2'));
  if (!active || active.variant === CONTROL_VARIANT) return null;

  const medians = await loadCategoryMedians(db);

  const pool = await loadPool(db, {
    poolSize: active.slice.candidatePoolSize,
    categorySlug: params.categorySlug ?? null,
    sellerHandle: params.sellerHandle ?? null,
    now,
  });
  if (pool.length === 0) return { items: [], exhausted: true, nextBefore: null };

  const poolByVideoId = new Map(pool.map((v) => [v.videoId, v]));
  const liveProductIdsByVideoId = new Map(
    pool.map((v) => [
      v.videoId,
      new Set(v.products.filter((p) => p.status === 'active' && p.inventoryCount > 0).map((p) => p.productId)),
    ])
  );

  const excludeSet = new Set(params.excludeIds);
  const viewerCtx = await loadViewerContext(db, {
    anonId: params.anonId,
    countryCode: params.countryCode ?? UNKNOWN_COUNTRY,
    excludeIds: excludeSet,
    liveProductIdsByVideoId,
  });

  const recentContext = await loadRecentContext(db, params.sessionId, poolByVideoId);

  // Generated once per request, not once per position: identical to the
  // simulation harness's own rationale (candidates.ts's docstring) — the
  // pool is stable for the life of one request, and already-served videos
  // are excluded via `viewerCtx.excludeIds` rather than by regenerating.
  const generated = generateCandidates(pool, viewerCtx, {
    rng: mulberry32(fnv1a32(`gen:${params.sessionId}`)),
    now,
    targetSize: active.slice.candidatePoolSize,
    laneShares: active.laneShares,
    coldStartLaneShares: active.coldStartLaneShares,
  });

  // "Exhausted" for the ranked path is the candidate set being empty, not the
  // naive feed's short-page cursor heuristic — there is no cursor here.
  if (generated.candidates.length === 0) return { items: [], exhausted: true, nextBefore: null };

  const scored: ScoredCandidate[] = generated.candidates.map((c) =>
    scoreCandidate(
      c,
      viewerCtx.profile,
      recentContext,
      active.weights,
      medians,
      now,
      thinCategoryMultiplier(c.categoryLiveCount)
    )
  );

  const result = select(scored, recentContext, {
    rng: mulberry32(fnv1a32(`sel:${params.sessionId}:${offset}`)),
    sliceSize: Math.max(0, Math.min(limit, active.slice.sliceSize)),
    freshFloor: active.slice.minFreshPerSlice,
    budgetOwed: budgetOwedIds(scored, now),
  });

  if (result.slice.length === 0) return { items: [], exhausted: false, nextBefore: null };

  const details = await loadFeedItemDetails(
    db,
    result.slice.map((c) => c.videoId)
  );

  const items: FeedItem[] = [];
  const forWrite: RankedSliceWriteRow[] = [];
  for (const cand of result.slice) {
    const detail = details.get(cand.videoId);
    // Fell out between the pool load and this final fetch (sold out,
    // unpublished mid-request) — skip rather than show a broken item, the
    // same posture `slice.ts` takes on a missing seller join.
    if (!detail) continue;
    const lane = laneOf(cand.lane);
    items.push({ ...detail, lane, position: items.length });
    forWrite.push({ videoId: cand.videoId, lane, score: clampScore(cand.score) });
  }

  void recordRankedSlice(db, { sessionId: params.sessionId, anonId: params.anonId, items: forWrite, offset });

  return { items, exhausted: false, nextBefore: null };
}

/**
 * The one shared "ranked or naive" decision point. Both `api/feed/route.ts`
 * and `feed/page.tsx` call this, never `getRankedFeedSlice`/`getFeedSlice`
 * directly, so a viewer's first SSR'd slide and every slide after it agree
 * on which path they are on.
 *
 * Any failure of the ranked path — missing config (`null`), a thrown query
 * error, a bug in the pipeline — falls back to the naive chronological feed.
 * `slice.ts` is never modified by this file; it is the permanent,
 * zero-deploy safety net.
 *
 * Recording what was served lives entirely in here too — `getRankedFeedSlice`
 * writes real lane/score internally, and the naive fallback below writes via
 * `slice.ts`'s own `recordSlice`. Callers never call either directly: one
 * function in, one function out, so there is exactly one place that can
 * double-write or forget to write a slice.
 */
export async function getFeedSliceRankedOrNaive(
  db: SupabaseClient,
  params: RankedOrNaiveParams
): Promise<{ items: FeedItem[]; exhausted: boolean; nextBefore: string | null }> {
  try {
    const ranked = await getRankedFeedSlice(db, params);
    if (ranked) return ranked;
  } catch (err) {
    console.error('ranked feed slice failed, falling back to naive feed:', err);
  }
  const naive = await getFeedSlice(db, params);
  // See recordRankedSlice's own guard: the SSR page's placeholder session id
  // must never be written, or every visitor's first render collides into one
  // (session_id, video_id) row.
  if (params.sessionId !== SSR_PLACEHOLDER_SESSION_ID) {
    void recordSlice(db, {
      sessionId: params.sessionId,
      anonId: params.anonId,
      items: naive.items,
      offset: params.offset ?? 0,
    });
  }
  return naive;
}
