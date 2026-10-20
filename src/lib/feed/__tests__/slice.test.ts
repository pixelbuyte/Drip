import { describe, expect, it } from 'vitest';
import { getFeedSlice } from '../slice';

function row(id: string, publishedAt: string) {
  return {
    id, seller_id: 's1', mux_playback_id: 'pb', duration_seconds: 10, aspect_ratio: '9:16',
    thumbnail_url: null, caption: null, hashtags: [], published_at: publishedAt,
    categories: { slug: 'bags' },
    profiles: { id: 's1', handle: 'h', display_name: 'H', avatar_url: null,
      seller_payments: { charges_enabled: true } },
    video_products: [{ position: 0, pinned_at_second: null, products: {
      id: `p-${id}`, title: 't', price_cents: 100, compare_at_price_cents: null, inventory_count: 3,
      low_stock_threshold: 1, images: [], variants: null, status: 'active' } }],
  };
}

function dbWith(byTable: Record<string, unknown[]>) {
  const lt: string[] = [];
  const db = {
    from(table: string) {
      const rows = byTable[table] ?? [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {};
      for (const op of ['select', 'eq', 'not', 'or', 'in', 'order', 'limit']) b[op] = () => b;
      b.lt = (_col: string, v: string) => { lt.push(v); return b; };
      b.then = (resolve: (r: { data: unknown; error: null }) => void) => resolve({ data: rows, error: null });
      return b;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: db as any, lt };
}

describe('getFeedSlice cursor', () => {
  // limit 1 → over-fetch 4, so a 4-row page is "full" and yields a cursor.
  const page = [
    row('v1', '2026-08-04T00:00:00Z'),
    row('v2', '2026-08-03T00:00:00Z'),
    row('v3', '2026-08-02T00:00:00Z'),
    row('v4', '2026-08-01T00:00:00Z'),
  ];
  const params = { anonId: 'a', sessionId: 's', surface: 'for_you' as const, excludeIds: [], limit: 1 };

  it('points at the last SERVED row, so the next page starts with the first unserved one', async () => {
    const { db } = dbWith({ viewer_blocks: [], videos: page });
    const result = await getFeedSlice(db, params);
    expect(result.items.map((i) => i.videoId)).toEqual(['v1']);
    // Before the fix this was v2's timestamp, and `published_at < cursor`
    // then skipped v2 forever.
    expect(result.nextBefore).toBe('2026-08-04T00:00:00Z');
  });

  it('advances past rows it examined and filtered, not just served ones', async () => {
    const blockedFirst = [{ ...row('v0', '2026-08-05T00:00:00Z'), video_products: [] }, ...page.slice(0, 3)];
    const { db } = dbWith({ viewer_blocks: [], videos: blockedFirst });
    const result = await getFeedSlice(db, params);
    expect(result.items.map((i) => i.videoId)).toEqual(['v1']);
    expect(result.nextBefore).toBe('2026-08-04T00:00:00Z');
  });
});
