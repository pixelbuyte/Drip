import { describe, expect, it } from 'vitest';
import { getSearchSlice } from '../slice';
import { SSR_PLACEHOLDER_SESSION_ID } from '@/lib/feed/types';

/** A structural double: dispatches .from(table) like the other feed test
 * doubles, plus .rpc(name, args) for search_feed_videos. */
function sourceOf(opts: {
  rpcResult?: { video_id: string; rank: number }[];
  rpcError?: string;
  videos?: Record<string, unknown>[];
  /** viewer_blocks rows: {subject_type: 'video'|'seller', subject_id}. */
  blocks?: Record<string, unknown>[];
  /** feed_slices rows already served this session: {video_id}. */
  served?: Record<string, unknown>[];
  onUpsert?: (rows: Record<string, unknown>[]) => void;
  onRpcArgs?: (args: Record<string, unknown>) => void;
  onServedRead?: () => void;
}) {
  const videos = opts.videos ?? [];
  const db = {
    rpc(name: string, args: Record<string, unknown>) {
      opts.onRpcArgs?.(args);
      if (name !== 'search_feed_videos') throw new Error(`unexpected rpc: ${name}`);
      if (opts.rpcError) return Promise.resolve({ data: null, error: { message: opts.rpcError } });
      return Promise.resolve({ data: opts.rpcResult ?? [], error: null });
    },
    from(table: string) {
      if (table === 'videos') {
        return {
          select: () => ({ in: () => Promise.resolve({ data: videos, error: null }) }),
        };
      }
      if (table === 'viewer_blocks') {
        return {
          select: () => ({
            eq: () => ({
              or: () => Promise.resolve({ data: opts.blocks ?? [], error: null }),
            }),
          }),
        };
      }
      if (table === 'feed_slices') {
        return {
          select: () => ({
            eq: () => ({
              limit: () => {
                opts.onServedRead?.();
                return Promise.resolve({ data: opts.served ?? [], error: null });
              },
            }),
          }),
          upsert: (rows: Record<string, unknown>[]) => {
            opts.onUpsert?.(rows);
            return Promise.resolve({ data: null, error: null });
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return db as any;
}

function videoRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'v1',
    mux_playback_id: 'pb1',
    duration_seconds: 15,
    aspect_ratio: '9:16',
    thumbnail_url: null,
    caption: 'chunky white sneakers',
    hashtags: ['drip'],
    categories: { slug: 'apparel' },
    profiles: { id: 's1', handle: 'shophandle', display_name: 'Shop', avatar_url: null },
    video_products: [
      {
        position: 0,
        pinned_at_second: null,
        products: {
          id: 'p1', title: 'Chunky White Sneakers', price_cents: 5999, compare_at_price_cents: null,
          inventory_count: 3, low_stock_threshold: 2, images: [], variants: null, status: 'active',
        },
      },
    ],
    ...overrides,
  };
}

const PARAMS = { anonId: 'a1', sessionId: 'sess-1', excludeIds: [] as string[] };

describe('getSearchSlice', () => {
  it('returns no results for an empty (or whitespace-only) query, without calling the database', async () => {
    let called = false;
    const db = sourceOf({ onRpcArgs: () => { called = true; } });
    const result = await getSearchSlice(db, { ...PARAMS, query: '   ' });
    expect(result).toEqual({ items: [], exhausted: true });
    expect(called).toBe(false);
  });

  it('maps ranked rows to FeedItem[] in rank order, with lane "chrono"', async () => {
    const db = sourceOf({
      rpcResult: [{ video_id: 'v1', rank: 0.9 }],
      videos: [videoRow()],
    });
    const result = await getSearchSlice(db, { ...PARAMS, query: 'sneakers' });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].videoId).toBe('v1');
    expect(result.items[0].lane).toBe('chrono');
    expect(result.items[0].position).toBe(0);
  });

  it('a zero-result query returns exhausted:true and an empty item list', async () => {
    const db = sourceOf({ rpcResult: [] });
    const result = await getSearchSlice(db, { ...PARAMS, query: 'nonexistent gibberish' });
    expect(result).toEqual({ items: [], exhausted: true });
  });

  it('exhausted is true when the ranked page is shorter than the requested limit', async () => {
    const db = sourceOf({
      rpcResult: [{ video_id: 'v1', rank: 0.9 }],
      videos: [videoRow()],
    });
    const result = await getSearchSlice(db, { ...PARAMS, query: 'sneakers', limit: 5 });
    expect(result.exhausted).toBe(true);
  });

  it('a video id ranked but missing from the details fetch is skipped, not thrown', async () => {
    const db = sourceOf({
      rpcResult: [{ video_id: 'v1', rank: 0.9 }, { video_id: 'v-gone', rank: 0.5 }],
      videos: [videoRow()], // only v1 resolves
    });
    const result = await getSearchSlice(db, { ...PARAMS, query: 'sneakers' });
    expect(result.items.map((i) => i.videoId)).toEqual(['v1']);
  });

  it('propagates a search_feed_videos rpc error rather than silently returning empty', async () => {
    const db = sourceOf({ rpcError: 'function search_feed_videos does not exist' });
    await expect(getSearchSlice(db, { ...PARAMS, query: 'sneakers' })).rejects.toThrow(/search query failed/);
  });

  it('passes category/seller filters and the exclude set through to the rpc call', async () => {
    let seenArgs: Record<string, unknown> | null = null;
    const db = sourceOf({
      rpcResult: [],
      onRpcArgs: (args) => { seenArgs = args; },
    });
    await getSearchSlice(db, {
      ...PARAMS,
      query: 'sneakers',
      categorySlug: 'apparel',
      sellerHandle: 'shophandle',
      excludeIds: ['v9'],
    });
    expect(seenArgs).toMatchObject({
      p_query: 'sneakers',
      p_category_slug: 'apparel',
      p_seller_handle: 'shophandle',
      p_exclude_ids: ['v9'],
    });
  });

  it('a blocked VIDEO is passed to the ranking function as an exclusion', async () => {
    let seenArgs: Record<string, unknown> | null = null;
    const db = sourceOf({
      rpcResult: [],
      blocks: [{ subject_type: 'video', subject_id: 'v-blocked' }],
      onRpcArgs: (args) => { seenArgs = args; },
    });
    await getSearchSlice(db, { ...PARAMS, query: 'sneakers' });
    expect((seenArgs! as { p_exclude_ids: string[] }).p_exclude_ids).toContain('v-blocked');
  });

  it('a blocked SELLER is filtered from results even when their video ranks', async () => {
    const db = sourceOf({
      rpcResult: [{ video_id: 'v1', rank: 0.9 }],
      videos: [videoRow()], // v1's seller is s1 (see videoRow fixture)
      blocks: [{ subject_type: 'seller', subject_id: 's1' }],
    });
    const result = await getSearchSlice(db, { ...PARAMS, query: 'sneakers' });
    expect(result.items).toEqual([]);
  });

  it("the session's already-served history is merged into the exclusion set server-side", async () => {
    // This is what stops paging from stalling once the client's 200-id
    // exclude window has scrolled past the earliest serves.
    let seenArgs: Record<string, unknown> | null = null;
    const db = sourceOf({
      rpcResult: [],
      served: [{ video_id: 'v-served-1' }, { video_id: 'v-served-2' }],
      onRpcArgs: (args) => { seenArgs = args; },
    });
    await getSearchSlice(db, { ...PARAMS, query: 'sneakers', excludeIds: ['v-client'] });
    const ids = (seenArgs! as { p_exclude_ids: string[] }).p_exclude_ids;
    expect(ids).toEqual(expect.arrayContaining(['v-client', 'v-served-1', 'v-served-2']));
  });

  it('skips the served-history read entirely for the SSR placeholder session id', async () => {
    let readServed = false;
    const db = sourceOf({
      rpcResult: [],
      onServedRead: () => { readServed = true; },
    });
    await getSearchSlice(db, {
      ...PARAMS,
      query: 'sneakers',
      sessionId: SSR_PLACEHOLDER_SESSION_ID,
    });
    expect(readServed).toBe(false);
  });

  it('never writes feed_slices for the SSR placeholder session id', async () => {
    let called = false;
    const db = sourceOf({
      rpcResult: [{ video_id: 'v1', rank: 0.9 }],
      videos: [videoRow()],
      onUpsert: () => { called = true; },
    });
    const result = await getSearchSlice(db, {
      ...PARAMS,
      query: 'sneakers',
      sessionId: SSR_PLACEHOLDER_SESSION_ID,
    });
    expect(result.items.length).toBeGreaterThan(0);
    expect(called).toBe(false);
  });

  it('records the served slice to feed_slices with the search lane', async () => {
    let written: Record<string, unknown>[] = [];
    const db = sourceOf({
      rpcResult: [{ video_id: 'v1', rank: 0.9 }],
      videos: [videoRow()],
      onUpsert: (rows) => { written = rows; },
    });
    await getSearchSlice(db, { ...PARAMS, query: 'sneakers' });
    expect(written).toHaveLength(1);
    expect(written[0].lane).toBe('chrono');
    expect(written[0].video_id).toBe('v1');
  });
});
