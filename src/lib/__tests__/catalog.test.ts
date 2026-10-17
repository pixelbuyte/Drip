import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadPublicCategories } from '../categories';
import { loadPublicCreator, normalizeHandle } from '../creators';

// ---------------------------------------------------------------------------
// Hand-written Supabase doubles. Every builder call is recorded so the tests
// can pin which columns and filters each query uses, which is the part the
// grants in 00006/00007/00008 make load-bearing.
// ---------------------------------------------------------------------------

type Call = { table: string; op: string; args: unknown[] };
type Result = { data?: unknown; error?: { message: string } | null; count?: number | null };

/** A thenable query builder: every chain method records and returns itself. */
function builder(table: string, calls: Call[], result: () => Result) {
  const b: Record<string, unknown> = {};
  for (const op of ['select', 'eq', 'order', 'limit', 'in', 'not']) {
    b[op] = (...args: unknown[]) => {
      calls.push({ table, op, args });
      return b;
    };
  }
  b.maybeSingle = async () => {
    calls.push({ table, op: 'maybeSingle', args: [] });
    return { error: null, ...result() };
  };
  b.then = (resolve: (r: Result) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve({ error: null, ...result() }).then(resolve, reject);
  return b;
}

function client(results: Record<string, Result | (() => Result)>, calls: Call[] = []) {
  return {
    calls,
    db: {
      from: (table: string) => {
        calls.push({ table, op: 'from', args: [] });
        const r = results[table];
        if (r === undefined) throw new Error(`unexpected table ${table}`);
        return builder(table, calls, typeof r === 'function' ? r : () => r);
      },
    } as unknown as SupabaseClient,
  };
}

const ops = (calls: Call[], table: string) =>
  calls.filter((c) => c.table === table && c.op !== 'from');

// ---------------------------------------------------------------------------
// categories
// ---------------------------------------------------------------------------

describe('loadPublicCategories', () => {
  it('returns slug + name in sort_order', async () => {
    const { db, calls } = client({
      categories: {
        data: [
          { slug: 'apparel', name: 'Apparel', sort_order: 1 },
          { slug: 'footwear', name: 'Footwear', sort_order: 2 },
        ],
      },
    });
    expect(await loadPublicCategories(db)).toEqual([
      { slug: 'apparel', name: 'Apparel' },
      { slug: 'footwear', name: 'Footwear' },
    ]);
    expect(ops(calls, 'categories')).toContainEqual({
      table: 'categories', op: 'order', args: ['sort_order', { ascending: true }],
    });
  });

  it('stays inside the anon column grant (no is_active / live_video_count)', async () => {
    const { db, calls } = client({ categories: { data: [] } });
    await loadPublicCategories(db);
    const mentioned = JSON.stringify(ops(calls, 'categories'));
    expect(mentioned).not.toContain('is_active');
    expect(mentioned).not.toContain('live_video_count');
    for (const c of ops(calls, 'categories').filter((c) => c.op === 'select')) {
      const cols = String(c.args[0]).split(',').map((s) => s.trim());
      expect(cols.every((col) => ['id', 'slug', 'name', 'sort_order'].includes(col))).toBe(true);
    }
  });

  it('never leaks extra columns even if the row carries them', async () => {
    const { db } = client({
      categories: { data: [{ slug: 'pet', name: 'Pet', sort_order: 10, live_video_count: 3 }] },
    });
    expect(await loadPublicCategories(db)).toEqual([{ slug: 'pet', name: 'Pet' }]);
  });

  it('throws on a query error', async () => {
    const { db } = client({ categories: { data: null, error: { message: 'boom' } } });
    await expect(loadPublicCategories(db)).rejects.toThrow('boom');
  });
});

// ---------------------------------------------------------------------------
// creators
// ---------------------------------------------------------------------------

describe('normalizeHandle', () => {
  it('lowercases and strips one leading @', () => {
    expect(normalizeHandle('Maya_Chen')).toBe('maya_chen');
    expect(normalizeHandle('@maya')).toBe('maya');
    expect(normalizeHandle('  maya ')).toBe('maya');
  });

  it('rejects anything the profiles_handle_format rule would', () => {
    for (const bad of ['ab', 'a'.repeat(31), 'maya-chen', 'maya.chen', '@@maya', '', 'maya chen', 'mäya']) {
      expect(normalizeHandle(bad)).toBeNull();
    }
    expect(normalizeHandle('abc')).toBe('abc');
    expect(normalizeHandle('a'.repeat(30))).toBe('a'.repeat(30));
  });
});

const PROFILE = {
  id: 'seller-1', handle: 'maya', display_name: 'Maya Chen', avatar_url: 'https://img.test/m.jpg',
};

function creatorClients(opts: {
  profile?: typeof PROFILE | null;
  followers?: number | null;
  live?: number | null;
  charges?: boolean | null;
  failOn?: string;
}) {
  const fail = (t: string) => (opts.failOn === t ? { message: `${t} failed` } : null);
  const pub = client({ profiles: () => ({ data: opts.profile ?? null, error: fail('profiles') }) });
  const admin = client({
    follows: () => ({ data: null, count: opts.followers ?? 0, error: fail('follows') }),
    videos: () => ({ data: null, count: opts.live ?? 0, error: fail('videos') }),
    seller_payments: () => ({
      data: opts.charges == null ? null : { charges_enabled: opts.charges },
      error: fail('seller_payments'),
    }),
  });
  return { pub, admin, clients: { publicDb: pub.db, adminDb: admin.db } };
}

describe('loadPublicCreator', () => {
  it('returns the public profile with follower and live-video counts', async () => {
    const { clients, pub, admin } = creatorClients({
      profile: PROFILE, followers: 1240, live: 7, charges: true,
    });
    expect(await loadPublicCreator(clients, 'maya')).toEqual({
      id: 'seller-1',
      handle: 'maya',
      displayName: 'Maya Chen',
      avatarUrl: 'https://img.test/m.jpg',
      followerCount: 1240,
      liveVideoCount: 7,
    });

    // Profile read through the anon client, the four granted columns only.
    expect(ops(pub.calls, 'profiles')).toEqual([
      { table: 'profiles', op: 'select', args: ['id, handle, display_name, avatar_url'] },
      { table: 'profiles', op: 'eq', args: ['handle', 'maya'] },
      { table: 'profiles', op: 'maybeSingle', args: [] },
    ]);
    // Counts are head-only exact counts scoped by the resolved seller id.
    expect(ops(admin.calls, 'follows')).toEqual([
      { table: 'follows', op: 'select', args: ['seller_id', { count: 'exact', head: true }] },
      { table: 'follows', op: 'eq', args: ['seller_id', 'seller-1'] },
    ]);
    expect(ops(admin.calls, 'videos')).toEqual([
      { table: 'videos', op: 'select', args: ['id', { count: 'exact', head: true }] },
      { table: 'videos', op: 'eq', args: ['seller_id', 'seller-1'] },
      { table: 'videos', op: 'eq', args: ['status', 'live'] },
    ]);
    expect(admin.calls.some((c) => c.table === 'profiles')).toBe(false);
  });

  it('returns null and runs no admin queries for an unknown handle', async () => {
    const { clients, admin } = creatorClients({ profile: null });
    expect(await loadPublicCreator(clients, 'nobody')).toBeNull();
    expect(admin.calls).toEqual([]);
  });

  it('still returns a creator whose payouts are not set up, with 0 live videos', async () => {
    const { clients } = creatorClients({ profile: PROFILE, followers: 3, live: 2, charges: false });
    const c = await loadPublicCreator(clients, 'maya');
    expect(c).toMatchObject({ handle: 'maya', followerCount: 3, liveVideoCount: 0 });
    expect(c).not.toHaveProperty('chargesEnabled');
  });

  it('treats a missing seller_payments row like charges disabled', async () => {
    const { clients } = creatorClients({ profile: PROFILE, live: 4, charges: null });
    expect((await loadPublicCreator(clients, 'maya'))?.liveVideoCount).toBe(0);
  });

  it('treats null counts as zero', async () => {
    const { clients } = creatorClients({ profile: PROFILE, followers: null, live: null, charges: true });
    expect(await loadPublicCreator(clients, 'maya')).toMatchObject({ followerCount: 0, liveVideoCount: 0 });
  });

  it.each(['profiles', 'follows', 'videos', 'seller_payments'])('throws when %s fails', async (t) => {
    const { clients } = creatorClients({ profile: PROFILE, charges: true, failOn: t });
    await expect(loadPublicCreator(clients, 'maya')).rejects.toThrow(`${t} failed`);
  });
});

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

const routeState = {
  categories: [] as unknown[] | null,
  categoriesError: null as { message: string } | null,
  profile: PROFILE as typeof PROFILE | null,
  publicClients: 0,
  adminClients: 0,
};

vi.mock('@/lib/supabase-public', () => ({
  createPublicClient: () => {
    routeState.publicClients++;
    return client({
      categories: () => ({ data: routeState.categories, error: routeState.categoriesError }),
      profiles: () => ({ data: routeState.profile }),
    }).db;
  },
}));
vi.mock('@/lib/supabase-admin', () => ({
  createAdminClient: () => {
    routeState.adminClients++;
    return client({
      follows: { count: 12 },
      videos: { count: 3 },
      seller_payments: { data: { charges_enabled: true } },
    }).db;
  },
}));

let ipCounter = 0;
const req = (path: string) =>
  new NextRequest(`https://drip.test${path}`, {
    // A fresh IP per request keeps the in-memory rate limiter out of the way.
    headers: { 'x-forwarded-for': `10.0.0.${++ipCounter}` },
  });

describe('GET /api/categories', () => {
  beforeEach(() => {
    routeState.categories = [{ slug: 'apparel', name: 'Apparel', sort_order: 1 }];
    routeState.categoriesError = null;
  });

  it('returns the list with a public CDN cache header', async () => {
    const { GET } = await import('@/app/api/categories/route');
    const res = await GET(req('/api/categories'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ categories: [{ slug: 'apparel', name: 'Apparel' }] });
    expect(res.headers.get('cache-control')).toBe('public, s-maxage=300, stale-while-revalidate=3600');
  });

  it('500s without caching when the read fails', async () => {
    routeState.categoriesError = { message: 'down' };
    const { GET } = await import('@/app/api/categories/route');
    const res = await GET(req('/api/categories'));
    expect(res.status).toBe(500);
    expect(res.headers.get('cache-control') ?? '').not.toContain('public');
    expect(await res.json()).toHaveProperty('error');
  });

  it('rate-limits a single IP', async () => {
    const { GET } = await import('@/app/api/categories/route');
    const fixed = () =>
      new NextRequest('https://drip.test/api/categories', { headers: { 'x-forwarded-for': '10.9.9.9' } });
    let last = 200;
    for (let i = 0; i < 121; i++) last = (await GET(fixed())).status;
    expect(last).toBe(429);
  });
});

describe('GET /api/creators/[handle]', () => {
  beforeEach(() => {
    routeState.profile = PROFILE;
    routeState.publicClients = 0;
    routeState.adminClients = 0;
  });

  const get = async (handle: string) => {
    const { GET } = await import('@/app/api/creators/[handle]/route');
    return GET(req(`/api/creators/${handle}`), { params: Promise.resolve({ handle }) });
  };

  it('returns the creator, case-insensitively, with a short public cache', async () => {
    const res = await get('MAYA');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      creator: {
        id: 'seller-1', handle: 'maya', displayName: 'Maya Chen', avatarUrl: 'https://img.test/m.jpg',
        followerCount: 12, liveVideoCount: 3,
      },
    });
    expect(res.headers.get('cache-control')).toBe('public, s-maxage=60, stale-while-revalidate=300');
  });

  it('404s an unknown handle', async () => {
    routeState.profile = null;
    const res = await get('nobody');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Creator not found' });
  });

  it('404s an invalid handle without touching the database', async () => {
    const res = await get('no');
    expect(res.status).toBe(404);
    expect(routeState.publicClients + routeState.adminClients).toBe(0);
  });
});
