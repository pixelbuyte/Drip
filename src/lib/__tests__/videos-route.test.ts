import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/** Records every write the route makes through the seller's own client. */
const state = {
  user: { id: 'seller-1' } as { id: string } | null,
  payments: { charges_enabled: true, from_address: { zip: '10001' } } as Record<string, unknown> | null,
  failOn: null as string | null,
  inserts: [] as { table: string; row: Record<string, unknown> }[],
  deletes: [] as string[],
  uploadsCreated: [] as Record<string, unknown>[],
  uploadsCancelled: [] as string[],
};

function userClient() {
  return {
    auth: { getUser: async () => ({ data: { user: state.user } }) },
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: table === 'categories' ? { id: 'cat-other' } : null }),
          like: async () => ({ data: [{ slug: 'the-studio-tote' }] }),
        }),
      }),
      insert: (row: Record<string, unknown>) => {
        state.inserts.push({ table, row });
        const error = state.failOn === table ? { message: `${table} failed` } : null;
        const result = { data: error ? null : { id: `${table}-id` }, error };
        return Object.assign(Promise.resolve({ error }), {
          select: () => ({ single: async () => result }),
        });
      },
      delete: () => ({
        eq: async () => {
          state.deletes.push(table);
          return { error: null };
        },
      }),
    }),
  };
}

vi.mock('@/lib/supabase-server', () => ({ createServerClient_: async () => userClient() }));
vi.mock('@/lib/supabase-admin', () => ({
  createAdminClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.payments }) }) }) }),
  }),
}));
vi.mock('@/lib/mux', () => ({
  getMux: () => ({
    video: {
      uploads: {
        create: async (args: Record<string, unknown>) => {
          state.uploadsCreated.push(args);
          return { id: 'upload-1', url: 'https://storage.mux.test/upload-1' };
        },
        cancel: async (id: string) => {
          state.uploadsCancelled.push(id);
        },
      },
    },
  }),
}));

const listing = {
  title: 'The Studio Tote',
  price_cents: 7800,
  inventory: 5,
  weight_oz: 12,
  dimensions: { length_in: 14, width_in: 4, height_in: 12 },
  variants: [{ name: 'Color', options: ['Chocolate', 'Sand'] }],
  caption: 'The everyday rotation.',
  hashtags: ['tote'],
  category_slug: 'apparel',
};

const post = async (body: unknown) => {
  const { POST } = await import('@/app/api/videos/route');
  return POST(new NextRequest('https://drip.test/api/videos', { method: 'POST', body: JSON.stringify(body) }));
};

beforeEach(() => {
  state.user = { id: 'seller-1' };
  state.payments = { charges_enabled: true, from_address: { zip: '10001' } };
  state.failOn = null;
  state.inserts = [];
  state.deletes = [];
  state.uploadsCreated = [];
  state.uploadsCancelled = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('POST /api/videos', () => {
  it('requires sign-in, payouts and a ship-from address before anything is created', async () => {
    state.user = null;
    expect((await post(listing)).status).toBe(401);
    state.user = { id: 'seller-1' };
    state.payments = { charges_enabled: false };
    expect((await post(listing)).status).toBe(403);
    state.payments = { charges_enabled: true, from_address: null };
    expect((await post(listing)).status).toBe(400);
    expect(state.uploadsCreated).toHaveLength(0);
    expect(state.inserts).toHaveLength(0);
  });

  it('rejects invalid input', async () => {
    expect((await post({ ...listing, price_cents: 5 })).status).toBe(400);
    expect(state.uploadsCreated).toHaveLength(0);
  });

  it('creates shipping profile, product, video and link, all owned by the caller', async () => {
    const res = await post(listing);
    expect(res.status).toBe(201);
    const body = await res.json();

    expect(state.inserts.map((i) => i.table)).toEqual([
      'shipping_profiles',
      'products',
      'videos',
      'video_products',
    ]);
    for (const i of state.inserts) expect(i.row.seller_id).toBe('seller-1');

    const product = state.inserts[1].row;
    expect(product).toMatchObject({
      slug: 'the-studio-tote-2', // the base slug is taken
      price_cents: 7800,
      inventory_count: 5,
      category_id: 'cat-other',
      shipping_profile_id: 'shipping_profiles-id',
    });

    const video = state.inserts[2].row;
    expect(video).toMatchObject({ mux_upload_id: 'upload-1', caption: 'The everyday rotation.', hashtags: ['tote'] });
    expect(video.status).toBeUndefined(); // guard_video_status pins 'processing'
    const settings = state.uploadsCreated[0].new_asset_settings as { passthrough: string };
    expect(settings.passthrough).toBe(`video:${video.id}`);

    expect(body).toEqual({
      video: { id: video.id },
      product: { id: 'products-id', slug: 'the-studio-tote-2' },
      upload_url: 'https://storage.mux.test/upload-1',
    });
  });

  it('rolls back everything already created, and cancels the upload, when a step fails', async () => {
    state.failOn = 'video_products';
    const res = await post(listing);
    expect(res.status).toBe(500);
    expect(state.deletes).toEqual(['videos', 'products', 'shipping_profiles']);
    expect(state.uploadsCancelled).toEqual(['upload-1']);
  });
});
