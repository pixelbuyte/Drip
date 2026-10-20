import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  createListingSchema,
  muxAspectRatio,
  parsePassthrough,
  toStoredVariants,
} from '../listings';
import { toVariantGroups } from '../feed/products';

const VID = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';

describe('createListingSchema', () => {
  const base = {
    title: 'The Studio Tote',
    price_cents: 7800,
    inventory: 5,
    weight_oz: 12,
    dimensions: { length_in: 14, width_in: 4, height_in: 12 },
  };

  it('defaults the category so the naive feed (categories!inner) keeps the video', () => {
    expect(createListingSchema.parse(base).category_slug).toBe('other');
  });

  it('rejects an unknown category and a "was" price that is not higher', () => {
    expect(createListingSchema.safeParse({ ...base, category_slug: 'weapons' }).success).toBe(false);
    expect(createListingSchema.safeParse({ ...base, compare_at_price_cents: 7800 }).success).toBe(false);
    expect(createListingSchema.safeParse({ ...base, compare_at_price_cents: 9800 }).success).toBe(true);
  });
});

describe('toStoredVariants', () => {
  it('round-trips through the feed reader with every option in stock', () => {
    const stored = toStoredVariants([{ name: 'Color', options: ['Chocolate', 'Sand', 'Sand'] }], 5);
    const groups = toVariantGroups(stored);
    expect(groups).toEqual([
      {
        id: 'Color',
        name: 'Color',
        options: [
          { id: 'Color:Chocolate', value: 'Chocolate', priceDeltaCents: 0, inventoryCount: 5, sku: null },
          { id: 'Color:Sand', value: 'Sand', priceDeltaCents: 0, inventoryCount: 5, sku: null },
        ],
      },
    ]);
  });

  it('stores no variants as NULL', () => {
    expect(toStoredVariants(undefined, 5)).toBeNull();
    expect(toStoredVariants([], 5)).toBeNull();
  });
});

describe('parsePassthrough / muxAspectRatio', () => {
  it('tells listings from legacy drops and rejects junk', () => {
    expect(parsePassthrough(`video:${VID}`)).toEqual({ kind: 'video', id: VID });
    expect(parsePassthrough(VID)).toEqual({ kind: 'drop', id: VID });
    expect(parsePassthrough('video:not-a-uuid')).toBeNull();
    expect(parsePassthrough("x'; drop table")).toBeNull();
    expect(parsePassthrough(undefined)).toBeNull();
  });

  it('keeps only ratios the CHECK accepts', () => {
    expect(muxAspectRatio('9:16')).toBe('9:16');
    expect(muxAspectRatio('9.0:16')).toBeNull();
    expect(muxAspectRatio(undefined)).toBeNull();
  });
});

// --- Mux webhook -----------------------------------------------------------

type Update = { table: string; values: Record<string, unknown>; filters: [string, unknown][] };
const updates: Update[] = [];

vi.mock('@/lib/supabase-admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      insert: async () => ({ error: null }),
      delete: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
      update: (values: Record<string, unknown>) => {
        const u: Update = { table, values, filters: [] };
        updates.push(u);
        const chain = {
          eq: (col: string, val: unknown) => {
            u.filters.push([col, val]);
            return chain;
          },
          then: (resolve: (v: { error: null }) => void) => resolve({ error: null }),
        };
        return chain;
      },
    }),
  }),
}));

const SECRET = 'mux-test-secret';
function signed(body: object) {
  const raw = JSON.stringify(body);
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex');
  return new NextRequest('https://drip.test/api/webhooks/mux', {
    method: 'POST',
    body: raw,
    headers: { 'mux-signature': `t=${t},v1=${v1}` },
  });
}

describe('Mux webhook → videos', () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.MUX_WEBHOOK_SECRET;
    process.env.MUX_WEBHOOK_SECRET = SECRET;
    updates.length = 0;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.MUX_WEBHOOK_SECRET;
    else process.env.MUX_WEBHOOK_SECRET = original;
  });

  it('publishes a ready listing video, only from processing', async () => {
    const { POST } = await import('@/app/api/webhooks/mux/route');
    const res = await POST(
      signed({
        id: 'evt1',
        type: 'video.asset.ready',
        data: {
          id: 'asset1',
          passthrough: `video:${VID}`,
          duration: 21.5,
          aspect_ratio: '9:16',
          playback_ids: [{ id: 'pb1', policy: 'public' }],
        },
      })
    );
    expect(res.status).toBe(200);
    expect(updates).toHaveLength(1);
    const u = updates[0];
    expect(u.table).toBe('videos');
    expect(u.values).toMatchObject({
      status: 'live',
      mux_asset_id: 'asset1',
      mux_playback_id: 'pb1',
      duration_seconds: 21.5,
      aspect_ratio: '9:16',
      thumbnail_url: 'https://image.mux.com/pb1/thumbnail.jpg?time=1',
    });
    expect(typeof u.values.published_at).toBe('string');
    expect(u.filters).toEqual([
      ['id', VID],
      ['status', 'processing'],
    ]);
  });

  it('removes an over-length video instead of publishing it', async () => {
    const { POST } = await import('@/app/api/webhooks/mux/route');
    await POST(
      signed({
        id: 'evt2',
        type: 'video.asset.ready',
        data: { id: 'asset2', passthrough: `video:${VID}`, duration: 75, playback_ids: [{ id: 'pb2', policy: 'public' }] },
      })
    );
    expect(updates[0].values).toMatchObject({ status: 'removed', mux_asset_id: 'asset2' });
    expect(updates[0].values.mux_playback_id).toBeUndefined();
  });

  it('reads an upload error’s passthrough from new_asset_settings and never stores the upload id as an asset', async () => {
    const { POST } = await import('@/app/api/webhooks/mux/route');
    await POST(
      signed({
        id: 'evt3',
        type: 'video.upload.errored',
        data: { id: 'upload3', new_asset_settings: { passthrough: `video:${VID}` } },
      })
    );
    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe('videos');
    expect(updates[0].values).toEqual({ status: 'removed', removed_reason: 'Video processing failed' });
  });

  it('still routes legacy drop passthroughs to drops', async () => {
    const { POST } = await import('@/app/api/webhooks/mux/route');
    await POST(
      signed({
        id: 'evt4',
        type: 'video.asset.ready',
        data: { id: 'asset4', passthrough: VID, duration: 10, playback_ids: [{ id: 'pb4', policy: 'public' }] },
      })
    );
    expect(updates[0].table).toBe('drops');
    expect(updates[0].values).toMatchObject({ status: 'active', mux_playback_id: 'pb4' });
  });
});
