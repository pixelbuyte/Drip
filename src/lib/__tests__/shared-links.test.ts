import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  findLiveVideo,
  loadSharedVideo,
  normalizeVideoId,
  sharedVideoPoster,
  sharedVideoSummary,
} from '@/lib/feed/shared-video';
import { appSiteAssociationFromEnv, buildAppSiteAssociation } from '@/lib/apple-app-site-association';

const VIDEO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: VIDEO,
    mux_playback_id: 'pb1',
    duration_seconds: 20,
    aspect_ratio: '9:16',
    thumbnail_url: 'https://img.test/poster.jpg',
    caption: 'The everyday rotation.',
    hashtags: ['tote'],
    categories: { slug: 'bags' },
    profiles: { id: 'seller-1', handle: 'maya', display_name: 'Maya Chen', avatar_url: null },
    video_products: [
      {
        position: 0,
        pinned_at_second: null,
        products: {
          id: 'prod-1', title: 'The Studio Tote', price_cents: 7800, compare_at_price_cents: 9800,
          inventory_count: 5, low_stock_threshold: 3, images: ['https://img.test/a.jpg'],
          variants: [], status: 'active',
        },
      },
    ],
    ...overrides,
  };
}

/** Records the query chain; resolves to `result` when awaited. */
function fakeDb(result: { data: unknown; error: { message: string } | null }) {
  const calls: { method: string; args: unknown[] }[] = [];
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'in', 'eq']) {
    chain[m] = (...args: unknown[]) => {
      calls.push({ method: m, args });
      return chain;
    };
  }
  chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  const db = {
    from: (table: string) => {
      calls.push({ method: 'from', args: [table] });
      return chain;
    },
  } as unknown as SupabaseClient;
  return { db, calls };
}

describe('normalizeVideoId', () => {
  it('accepts uuids (any case, returned lowercase) and rejects everything else', () => {
    expect(normalizeVideoId(VIDEO)).toBe(VIDEO);
    expect(normalizeVideoId(VIDEO.toUpperCase())).toBe(VIDEO);
    expect(normalizeVideoId('not-a-uuid')).toBeNull();
    expect(normalizeVideoId(`${VIDEO}x`)).toBeNull();
    expect(normalizeVideoId(`'; drop table videos; --`)).toBeNull();
    expect(normalizeVideoId(undefined)).toBeNull();
  });
});

describe('loadSharedVideo', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it('queries live videos only and returns the feed item shape', async () => {
    const { db, calls } = fakeDb({ data: [row()], error: null });
    const item = await loadSharedVideo(db, VIDEO);
    expect(calls).toContainEqual({ method: 'from', args: ['videos'] });
    expect(calls).toContainEqual({ method: 'in', args: ['id', [VIDEO]] });
    expect(calls).toContainEqual({ method: 'eq', args: ['status', 'live'] });
    expect(item).toMatchObject({
      videoId: VIDEO,
      playbackId: 'pb1',
      thumbnailUrl: 'https://img.test/poster.jpg',
      seller: { handle: 'maya' },
      products: [{ id: 'prod-1', title: 'The Studio Tote', priceCents: 7800 }],
    });
  });

  it('never queries for an invalid id', async () => {
    const { db, calls } = fakeDb({ data: [row()], error: null });
    expect(await loadSharedVideo(db, 'nope')).toBeNull();
    expect(await loadSharedVideo(db, '../../etc/passwd')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('is null when no live row matches (processing, removed, unknown)', async () => {
    const { db } = fakeDb({ data: [], error: null });
    expect(await loadSharedVideo(db, VIDEO)).toBeNull();
  });

  it('is null when nothing on the video is sellable, like every feed path', async () => {
    const soldOut = row({
      video_products: [{ ...row().video_products[0], products: { ...row().video_products[0].products, inventory_count: 0 } }],
    });
    const { db } = fakeDb({ data: [soldOut], error: null });
    expect(await loadSharedVideo(db, VIDEO)).toBeNull();
  });

  it('is null — not a throw — when the query errors (legacy schema has no videos table)', async () => {
    const { db } = fakeDb({ data: null, error: { message: 'relation "public.videos" does not exist' } });
    await expect(loadSharedVideo(db, VIDEO)).resolves.toBeNull();
    await expect(findLiveVideo(db, VIDEO)).rejects.toThrow(/does not exist/);
  });

  it('is null when the client itself throws', async () => {
    const db = { from: () => { throw new Error('network down'); } } as unknown as SupabaseClient;
    await expect(loadSharedVideo(db, VIDEO)).resolves.toBeNull();
  });
});

describe('shared video presentation', () => {
  it('summarises the first product, price and creator for unfurls', async () => {
    const { db } = fakeDb({ data: [row()], error: null });
    const item = (await loadSharedVideo(db, VIDEO))!;
    expect(sharedVideoSummary(item)).toEqual({
      title: 'The Studio Tote — $78.00 · @maya on Drip',
      description: 'The everyday rotation.',
    });
    const noCaption = { ...item, caption: null };
    expect(sharedVideoSummary(noCaption).description).toBe(
      'The Studio Tote from @maya. Watch it and shop it on Drip.'
    );
  });

  it('falls back to the Mux thumbnail when no poster is stored', () => {
    expect(sharedVideoPoster({ thumbnailUrl: 'https://img.test/p.jpg', playbackId: 'pb' })).toBe(
      'https://img.test/p.jpg'
    );
    expect(sharedVideoPoster({ thumbnailUrl: null, playbackId: 'pb1' })).toMatch(
      /^https:\/\/image\.mux\.com\/pb1\/thumbnail\.jpg/
    );
    expect(sharedVideoPoster({ thumbnailUrl: null, playbackId: null })).toBeNull();
  });
});

describe('apple-app-site-association', () => {
  const original = process.env.APPLE_TEAM_ID;
  afterEach(() => {
    if (original === undefined) delete process.env.APPLE_TEAM_ID;
    else process.env.APPLE_TEAM_ID = original;
  });

  const get = async () => {
    const { GET } = await import('@/app/.well-known/apple-app-site-association/route');
    return GET();
  };

  it('is 404 while APPLE_TEAM_ID is unset', async () => {
    delete process.env.APPLE_TEAM_ID;
    const res = await get();
    expect(res.status).toBe(404);
  });

  it('is 404 for a value that is not a Team ID', async () => {
    process.env.APPLE_TEAM_ID = 'not a team';
    expect((await get()).status).toBe(404);
    expect(appSiteAssociationFromEnv({ APPLE_TEAM_ID: '' })).toBeNull();
  });

  it('serves the applinks JSON for the bundle id, claiming /v/* only', async () => {
    process.env.APPLE_TEAM_ID = 'ABCDE12345';
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    const body = await res.json();
    expect(body).toEqual({
      applinks: {
        details: [
          {
            appIDs: ['ABCDE12345.com.pixelbuyte.drip'],
            components: [{ '/': '/v/*', comment: 'Shared video' }],
          },
        ],
      },
    });
    expect(buildAppSiteAssociation('ZZZZZ99999').applinks.details[0].appIDs).toEqual([
      'ZZZZZ99999.com.pixelbuyte.drip',
    ]);
  });

  it('normalises a lowercase Team ID', () => {
    expect(appSiteAssociationFromEnv({ APPLE_TEAM_ID: ' abcde12345 ' })?.applinks.details[0].appIDs).toEqual([
      'ABCDE12345.com.pixelbuyte.drip',
    ]);
  });
});

describe('GET /api/videos/[id]', () => {
  const state = { result: { data: [row()], error: null } as { data: unknown; error: { message: string } | null } };

  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    state.result = { data: [row()], error: null };
    vi.doMock('@/lib/supabase-public', () => ({ createPublicClient: () => fakeDb(state.result).db }));
  });
  afterEach(() => {
    vi.doUnmock('@/lib/supabase-public');
    vi.restoreAllMocks();
  });

  const get = async (id: string) => {
    const { GET } = await import('@/app/api/videos/[id]/route');
    return GET(new NextRequest(`https://drip.test/api/videos/${id}`), { params: Promise.resolve({ id }) });
  };

  it('returns one feed item for a live video', async () => {
    const res = await get(VIDEO);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.item).toMatchObject({ videoId: VIDEO, lane: 'chrono', position: 0, seller: { handle: 'maya' } });
  });

  it('404s an invalid id and a video that is not live', async () => {
    expect((await get('nope')).status).toBe(404);
    state.result = { data: [], error: null };
    expect((await get(VIDEO)).status).toBe(404);
  });

  it('503s when the lookup fails, so the client can retry', async () => {
    state.result = { data: null, error: { message: 'relation "public.videos" does not exist' } };
    expect((await get(VIDEO)).status).toBe(503);
  });
});
