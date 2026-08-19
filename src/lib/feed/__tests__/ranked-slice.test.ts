import { describe, expect, it } from 'vitest';
import { getFeedSliceRankedOrNaive, getRankedFeedSlice, resolveCountryCode } from '../ranked-slice';
import { SSR_PLACEHOLDER_SESSION_ID } from '../types';

describe('resolveCountryCode', () => {
  it('uppercases a well-formed two-letter header value', () => {
    expect(resolveCountryCode('us')).toBe('US');
    expect(resolveCountryCode('GB')).toBe('GB');
  });

  it('falls back to the unknown sentinel for null, empty, or malformed values', () => {
    expect(resolveCountryCode(null)).toBe('XX');
    expect(resolveCountryCode(undefined)).toBe('XX');
    expect(resolveCountryCode('')).toBe('XX');
    expect(resolveCountryCode('USA')).toBe('XX');
    expect(resolveCountryCode('1')).toBe('XX');
  });

  it('never returns an empty string (shipsToViewer fails closed on one)', () => {
    for (const v of [null, undefined, '', 'zz', 'zzz', '  ']) {
      expect(resolveCountryCode(v)).not.toBe('');
    }
  });
});

// ---------------------------------------------------------------------------
// A structural double for the supabase-js query builder, dispatching on
// table name. Every terminal method the code under test actually calls is
// covered: select/eq/not/or/in/order/limit resolve the chain, maybeSingle
// resolves a single row, upsert records what was written (for the
// feed_slices assertions), and `then` makes the builder itself awaitable
// (real supabase-js query builders are thenables).
// ---------------------------------------------------------------------------
function sourceOf(byTable: Record<string, unknown[]>) {
  const upserts: Record<string, Record<string, unknown>[]> = {};
  const db = {
    from(table: string) {
      const rows = byTable[table] ?? [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        not: () => builder,
        or: () => builder,
        in: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
        upsert: (toInsert: Record<string, unknown>[]) => {
          upserts[table] = (upserts[table] ?? []).concat(toInsert);
          return Promise.resolve({ data: null, error: null });
        },
        then: (resolve: (r: { data: unknown; error: null }) => void) => resolve({ data: rows, error: null }),
      };
      return builder;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: db as any, upserts };
}

const ACTIVE_WEIGHTS_ROW = { variant: 'ranked_v2', is_active: true, traffic_share: 1 };

function videoRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'v1',
    seller_id: 's1',
    category_id: 'c1',
    published_at: '2026-08-01T12:00:00Z',
    hashtags: ['drip'],
    status: 'live',
    profiles: {
      id: 's1',
      handle: 'shophandle',
      display_name: 'Shop',
      avatar_url: null,
      seller_payments: { charges_enabled: true },
    },
    categories: { slug: 'apparel', live_video_count: 12 },
    video_stats: {
      impressions_1h: 5, impressions_24h: 100, impressions_all: 500,
      purchases_1h: 1, purchases_24h: 4, add_to_carts_1h: 2, add_to_carts_24h: 10,
      product_taps_1h: 3, product_taps_24h: 20, completions_24h: 40,
      skips_under_2s_24h: 15, shares_24h: 2, saves_24h: 6, avg_loop_count: 1.5,
      reports_all: 0, not_interested_all: 1, gmv_cents_24h: 12000, exploration_impressions: 500,
    },
    seller_trust: { fulfillment_score: 0.9, dispute_rate: 0.01, rating_avg: 4.5, trust_tier: 'trusted' },
    video_products: [
      {
        position: 0,
        pinned_at_second: null,
        products: {
          id: 'p1', title: 'Thing', price_cents: 1999, compare_at_price_cents: null,
          inventory_count: 5, low_stock_threshold: 2, images: [], variants: null, status: 'active',
        },
      },
    ],
    mux_playback_id: 'pb1',
    duration_seconds: 15,
    aspect_ratio: '9:16',
    thumbnail_url: null,
    caption: 'hi',
    ...overrides,
  };
}

const NOW_PARAMS = {
  anonId: 'a1',
  sessionId: 'sess-1',
  surface: 'for_you' as const,
  excludeIds: [] as string[],
};

describe('getRankedFeedSlice', () => {
  it('returns null (the naive-fallback signal) when no feed_weights row is active', async () => {
    const { db } = sourceOf({ feed_weights: [] });
    const result = await getRankedFeedSlice(db, NOW_PARAMS);
    expect(result).toBeNull();
  });

  it('returns exhausted:true with no items when the pool is empty', async () => {
    const { db } = sourceOf({ feed_weights: [ACTIVE_WEIGHTS_ROW], videos: [] });
    const result = await getRankedFeedSlice(db, NOW_PARAMS);
    expect(result).toEqual({ items: [], exhausted: true, nextBefore: null });
  });

  it('produces a ranked slice with a real lane and writes score/lane to feed_slices', async () => {
    const videos = [
      videoRow({ id: 'v1', seller_id: 's1', category_id: 'c1' }),
      videoRow({ id: 'v2', seller_id: 's2', category_id: 'c2' }),
      videoRow({ id: 'v3', seller_id: 's3', category_id: 'c1' }),
    ];
    const { db, upserts } = sourceOf({
      feed_weights: [ACTIVE_WEIGHTS_ROW],
      category_rate_medians: [],
      videos,
      viewer_profiles: [],
      follows: [],
      viewer_blocks: [],
      orders: [],
      feed_slices: [],
    });

    const result = await getRankedFeedSlice(db, NOW_PARAMS);
    expect(result).not.toBeNull();
    expect(result!.exhausted).toBe(false);
    expect(result!.items.length).toBeGreaterThan(0);
    for (const item of result!.items) {
      expect(['affinity', 'trending', 'fresh', 'social', 'random']).toContain(item.lane);
      expect(item.videoId).toMatch(/^v\d$/);
      expect(item.products.length).toBeGreaterThan(0);
      expect(item.seller.handle).toBe('shophandle');
    }

    const written = upserts.feed_slices ?? [];
    expect(written.length).toBe(result!.items.length);
    for (const row of written) {
      expect(row.lane).not.toBe('chrono');
      expect(typeof row.score).toBe('number');
      expect(row.score as number).toBeLessThanOrEqual(9.99999);
      expect(row.score as number).toBeGreaterThanOrEqual(-9.99999);
    }
  });

  it('never writes feed_slices for the SSR placeholder session id', async () => {
    const { db, upserts } = sourceOf({
      feed_weights: [ACTIVE_WEIGHTS_ROW],
      category_rate_medians: [],
      videos: [videoRow()],
      viewer_profiles: [],
      follows: [],
      viewer_blocks: [],
      orders: [],
      feed_slices: [],
    });

    const result = await getRankedFeedSlice(db, { ...NOW_PARAMS, sessionId: SSR_PLACEHOLDER_SESSION_ID });
    expect(result!.items.length).toBeGreaterThan(0);
    expect(upserts.feed_slices ?? []).toEqual([]);
  });
});

describe('getFeedSliceRankedOrNaive', () => {
  it('falls back to the naive chronological feed when feed_weights errors', async () => {
    const throwing = {
      from(table: string) {
        if (table === 'feed_weights') {
          return {
            select: () => Promise.reject(new Error('feed_weights table unreachable')),
          };
        }
        // Naive path (slice.ts's getFeedSlice): empty results everywhere,
        // just needs to resolve without throwing.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const builder: any = {
          select: () => builder,
          eq: () => builder,
          not: () => builder,
          or: () => builder,
          in: () => builder,
          order: () => builder,
          limit: () => builder,
          then: (resolve: (r: { data: unknown; error: null }) => void) => resolve({ data: [], error: null }),
        };
        return builder;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const result = await getFeedSliceRankedOrNaive(throwing, NOW_PARAMS);
    // Falls back cleanly rather than throwing out of the whole function.
    expect(result.items).toEqual([]);
  });

  it('returns the ranked result directly when ranking is active and the pool is non-empty', async () => {
    const { db } = sourceOf({
      feed_weights: [ACTIVE_WEIGHTS_ROW],
      category_rate_medians: [],
      videos: [videoRow()],
      viewer_profiles: [],
      follows: [],
      viewer_blocks: [],
      orders: [],
      feed_slices: [],
    });
    const result = await getFeedSliceRankedOrNaive(db, NOW_PARAMS);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0].lane).not.toBe('chrono');
  });
});
