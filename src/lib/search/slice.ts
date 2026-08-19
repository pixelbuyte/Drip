import type { SupabaseClient } from '@supabase/supabase-js';
import { loadFeedItemDetails } from '@/lib/feed/item-details';
import { recordSlice } from '@/lib/feed/slice';
import { FEED_SLICE_SIZE, SSR_PLACEHOLDER_SESSION_ID, type FeedItem } from '@/lib/feed/types';

/**
 * The query layer for free-text search (spec Part B). Counterpart to
 * `getFeedSlice`/`getRankedFeedSlice`: ranking here is `search_feed_videos`
 * (migration 00015) rather than reverse-chronological or the scoring
 * pipeline, but the shape is the same two-step fetch `ranked-slice.ts`
 * already established — a cheap query returns which video ids matched and in
 * what order, then `loadFeedItemDetails` fetches the full wire shape for
 * only that small set.
 */

export type SearchSliceParams = {
  query: string;
  anonId: string;
  sessionId: string;
  excludeIds: string[];
  categorySlug?: string | null;
  sellerHandle?: string | null;
  limit?: number;
};

export type SearchSliceResult = {
  items: FeedItem[];
  exhausted: boolean;
};

type SearchRow = { video_id: string; rank: number };

/**
 * No lane in `search_feed_videos`' ranking corresponds to one of the five
 * ranked-feed lanes (affinity/trending/fresh/social/tail) — a search result
 * is chosen by text relevance, not by any of those signals. `'chrono'` is
 * the same neutral sentinel the naive feed already uses for "not part of the
 * v2 lane taxonomy", reused here rather than inventing a second one.
 */
const SEARCH_LANE: FeedItem['lane'] = 'chrono';

export async function getSearchSlice(
  db: SupabaseClient,
  params: SearchSliceParams
): Promise<SearchSliceResult> {
  const limit = params.limit ?? FEED_SLICE_SIZE;
  const query = params.query.trim();

  // An empty query has nothing to rank against — return no results rather
  // than asking Postgres to run websearch_to_tsquery('') and match on
  // nothing but the hashtag/category filters, which would silently become
  // "browse everything" instead of "search for nothing".
  if (query.length === 0) return { items: [], exhausted: true };

  const { data, error } = await db.rpc('search_feed_videos', {
    p_query: query,
    p_category_slug: params.categorySlug ?? null,
    p_seller_handle: params.sellerHandle ?? null,
    p_limit: limit,
    p_exclude_ids: params.excludeIds,
  });
  if (error) throw new Error(`search query failed: ${error.message}`);

  const ranked = (data ?? []) as SearchRow[];
  if (ranked.length === 0) return { items: [], exhausted: true };

  const details = await loadFeedItemDetails(
    db,
    ranked.map((r) => r.video_id)
  );

  const items: FeedItem[] = [];
  for (const row of ranked) {
    const detail = details.get(row.video_id);
    // Fell out between the rank query and the details fetch (sold out,
    // unpublished mid-request) — skip rather than show a broken item, same
    // posture as the ranked feed's own loadFeedItemDetails callers.
    if (!detail) continue;
    items.push({ ...detail, lane: SEARCH_LANE, position: items.length });
  }

  // Exhausted when the ranking query returned fewer than a full page: there
  // is no cursor to page further with, unlike the naive feed's published_at
  // cursor — the caller re-requests with a larger excludeIds set instead.
  const exhausted = ranked.length < limit;

  // Every anonymous visitor's SSR /search render shares this same
  // placeholder session id (see feed/page.tsx's identical rationale) —
  // writing under it would collide every visitor's first slice into one
  // (session_id, video_id) primary key.
  if (params.sessionId !== SSR_PLACEHOLDER_SESSION_ID) {
    void recordSlice(db, {
      sessionId: params.sessionId,
      anonId: params.anonId,
      items,
      offset: params.excludeIds.length,
    });
  }

  return { items, exhausted };
}
