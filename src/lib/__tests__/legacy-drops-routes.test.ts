import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * public.drops was dropped by 00007_feed_content_model.sql. These tests pin
 * the legacy routes to the feed content model: the gone ones answer 410, and
 * the ported ones never touch `drops` or the removed orders.drop_id column.
 */

type Result = { data: unknown; error: unknown };

/** One recorded query against the fake client. */
class Query {
  op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  columns = '';
  payload: unknown = undefined;
  filters: { kind: string; column: string; value: unknown }[] = [];
  mode: 'many' | 'single' | 'maybeSingle' = 'many';

  constructor(
    private db: FakeDb,
    readonly table: string
  ) {}

  select(columns = '*') {
    if (this.op === 'select') this.columns = columns;
    return this;
  }
  insert(payload: unknown) {
    this.op = 'insert';
    this.payload = payload;
    return this;
  }
  update(payload: unknown) {
    this.op = 'update';
    this.payload = payload;
    return this;
  }
  delete() {
    this.op = 'delete';
    return this;
  }
  private filter(kind: string, column: string, value?: unknown) {
    this.filters.push({ kind, column, value });
    return this;
  }
  eq(column: string, value: unknown) {
    return this.filter('eq', column, value);
  }
  neq(column: string, value: unknown) {
    return this.filter('neq', column, value);
  }
  in(column: string, value: unknown) {
    return this.filter('in', column, value);
  }
  is(column: string, value: unknown) {
    return this.filter('is', column, value);
  }
  order(column: string, value?: unknown) {
    return this.filter('order', column, value);
  }
  limit(value: number) {
    return this.filter('limit', 'limit', value);
  }
  value(column: string): unknown {
    return this.filters.find((f) => f.kind === 'eq' && f.column === column)?.value;
  }
  single() {
    this.mode = 'single';
    return this.exec();
  }
  maybeSingle() {
    this.mode = 'maybeSingle';
    return this.exec();
  }
  then<T>(resolve: (r: Result) => T, reject?: (e: unknown) => T) {
    return this.exec().then(resolve, reject);
  }
  private exec(): Promise<Result> {
    this.db.log.push(this);
    return Promise.resolve(this.db.handler(this));
  }
}

class FakeDb {
  log: Query[] = [];
  user: { id: string } | null = { id: 'seller-1' };
  constructor(public handler: (q: Query) => Result = () => ({ data: null, error: null })) {}
  auth = { getUser: async () => ({ data: { user: this.user } }) };
  from(table: string) {
    return new Query(this, table);
  }
  tables() {
    return this.log.map((q) => q.table);
  }
}

let db = new FakeDb();
const delivered: unknown[][] = [];
const balanceCalls: unknown[] = [];

vi.mock('@/lib/supabase-server', () => ({ createServerClient_: async () => db }));
vi.mock('@/lib/supabase-admin', () => ({ createAdminClient: () => db }));
vi.mock('@/lib/emails', () => ({
  sendBuyerDelivered: async (...args: unknown[]) => {
    delivered.push(args);
  },
}));
vi.mock('@/lib/mux', () => ({
  getAssetViewCounts: async (ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, id === 'asset-a' ? 40 : 7])),
}));
vi.mock('@/lib/stripe', () => ({
  getStripe: () => ({
    balance: {
      retrieve: async (opts: unknown) => {
        balanceCalls.push(opts);
        return {
          pending: [{ currency: 'usd', amount: 1200 }],
          available: [{ currency: 'usd', amount: 300 }, { currency: 'eur', amount: 999 }],
        };
      },
    },
  }),
}));

beforeEach(() => {
  db = new FakeDb();
  delivered.length = 0;
  balanceCalls.length = 0;
});

describe('gone legacy drop routes answer 410', () => {
  const routes: [string, () => Promise<{ POST: () => Promise<Response> }>, string | null][] = [
    ['POST /api/drops', () => import('@/app/api/drops/route'), '/api/videos'],
    ['POST /api/drops/[id]/restock', () => import('@/app/api/drops/[id]/restock/route'), null],
    ['POST /api/checkout', () => import('@/app/api/checkout/route'), '/api/checkout/intent'],
    ['POST /api/waitlist', () => import('@/app/api/waitlist/route'), null],
    ['POST /api/report', () => import('@/app/api/report/route'), '/api/events'],
  ];

  it.each(routes)('%s', async (_name, load, replacement) => {
    const res = await (await load()).POST();
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: 'gone', replacement });
    expect(db.log).toHaveLength(0);
  });
});

describe('GET /api/dashboard/stats on the feed content model', () => {
  const get = async () => {
    const { GET } = await import('@/app/api/dashboard/stats/route');
    return GET();
  };

  it('401s without a session', async () => {
    db.user = null;
    expect((await get()).status).toBe(401);
  });

  it('sums counted orders by total_cents and keys per_drop by video id', async () => {
    db.handler = (q) => {
      if (q.table === 'seller_payments') return { data: { stripe_account_id: 'acct_1' }, error: null };
      if (q.table === 'orders') {
        return {
          data: [
            { video_id: 'video-a', total_cents: 5000, amount_cents: 5000, status: 'paid' },
            { video_id: 'video-a', total_cents: 0, amount_cents: 2500, status: 'delivered' },
            { video_id: 'video-b', total_cents: 1000, amount_cents: 1000, status: 'shipped' },
            { video_id: null, total_cents: 700, amount_cents: 700, status: 'paid' },
          ],
          error: null,
        };
      }
      if (q.table === 'videos') {
        return {
          data: [
            { id: 'video-a', mux_asset_id: 'asset-a' },
            { id: 'video-b', mux_asset_id: null },
          ],
          error: null,
        };
      }
      return { data: null, error: { message: `unexpected table ${q.table}` } };
    };

    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      total_revenue_cents: 9200,
      total_sales: 4,
      pending_payout_cents: 1200,
      available_payout_cents: 300,
      per_drop: {
        'video-a': { views: 40, sales: 2, revenue_cents: 7500 },
        'video-b': { views: 0, sales: 1, revenue_cents: 1000 },
      },
    });
    expect(balanceCalls).toEqual([{ stripeAccount: 'acct_1' }]);

    expect(db.tables()).not.toContain('drops');
    const orders = db.log.find((q) => q.table === 'orders')!;
    expect(orders.columns).not.toMatch(/drop_id/);
    expect(orders.value('seller_id')).toBe('seller-1');
    // Only completed sales: refunded, canceled, disputed and pending stay out.
    const statuses = orders.filters.find((f) => f.kind === 'in' && f.column === 'status')?.value;
    expect(statuses).toEqual(['paid', 'label_created', 'shipped', 'delivered']);
    expect(db.log.find((q) => q.table === 'videos')!.value('seller_id')).toBe('seller-1');
  });

  it('returns zeros, not a 500, when there are no orders or payouts', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      total_revenue_cents: 0,
      total_sales: 0,
      pending_payout_cents: 0,
      available_payout_cents: 0,
      per_drop: {},
    });
    expect(balanceCalls).toHaveLength(0);
  });
});

describe('GET /api/orders/export on the feed content model', () => {
  const get = async () => {
    const { GET } = await import('@/app/api/orders/export/route');
    return GET();
  };

  it('401s without a session', async () => {
    db.user = null;
    expect((await get()).status).toBe(401);
  });

  it('500s when the orders query fails', async () => {
    db.handler = () => ({ data: null, error: { message: 'boom' } });
    expect((await get()).status).toBe(500);
  });

  it('writes item titles from order_items and totals from total_cents', async () => {
    db.handler = () => ({
      data: [
        {
          id: 'order-1',
          created_at: '2026-10-01T12:00:00.000Z',
          buyer_name: 'Ada, L.',
          buyer_email: 'ada@example.com',
          shipping_address: { street1: '1 Main St', street2: 'Apt 2', city: 'NYC', state: 'NY', zip: '10001' },
          amount_cents: 5250,
          total_cents: 5250,
          shipping_cents: 650,
          status: 'shipped',
          tracking_code: '9400',
          order_items: [
            { title_snapshot: 'Studio Tote', variant_snapshot: 'Sand', quantity: 1 },
            { title_snapshot: 'Key Fob', variant_snapshot: null, quantity: 2 },
          ],
        },
        {
          id: 'order-2',
          created_at: '2026-09-01T12:00:00.000Z',
          buyer_name: null,
          buyer_email: 'b@example.com',
          shipping_address: null,
          amount_cents: 1800,
          total_cents: 0,
          shipping_cents: 0,
          status: 'paid',
          tracking_code: null,
          order_items: [],
        },
      ],
      error: null,
    });

    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    const lines = (await res.text()).split('\n');
    expect(lines[0]).toBe(
      'order_id,date,item,buyer_name,buyer_email,ship_to_street,ship_to_city,ship_to_state,ship_to_zip,total_usd,shipping_usd,status,tracking_code'
    );
    expect(lines[1]).toBe(
      'order-1,2026-10-01T12:00:00.000Z,Studio Tote (Sand); Key Fob x2,"Ada, L.",ada@example.com,1 Main St Apt 2,NYC,NY,10001,52.50,6.50,shipped,9400'
    );
    expect(lines[2]).toBe('order-2,2026-09-01T12:00:00.000Z,,,b@example.com,,,,,18.00,0.00,paid,');

    const q = db.log.find((x) => x.table === 'orders')!;
    expect(q.columns).toMatch(/order_items\(title_snapshot, variant_snapshot, quantity\)/);
    expect(q.columns).not.toMatch(/drops/);
    expect(q.value('seller_id')).toBe('seller-1');
  });
});

describe('POST /api/webhooks/easypost on the feed content model', () => {
  const SECRET = 'whsec_test';
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.EASYPOST_WEBHOOK_SECRET;
    process.env.EASYPOST_WEBHOOK_SECRET = SECRET;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.EASYPOST_WEBHOOK_SECRET;
    else process.env.EASYPOST_WEBHOOK_SECRET = original;
  });

  const post = async (status: string) => {
    const body = JSON.stringify({
      id: `evt_${status}`,
      description: 'tracker.updated',
      result: { id: 'trk_1', tracking_code: '9400TRACK', status },
    });
    const sig = crypto.createHmac('sha256', SECRET).update(body, 'utf8').digest('hex');
    const { POST } = await import('@/app/api/webhooks/easypost/route');
    return POST(
      new NextRequest('https://drip.test/api/webhooks/easypost', {
        method: 'POST',
        body,
        headers: { 'x-hmac-signature': `hmac-sha256-hex=${sig}` },
      })
    );
  };

  const orderHandler = (orderStatus: string) => (q: Query): Result => {
    if (q.table === 'processed_events') return { data: null, error: null };
    if (q.table === 'orders' && q.op === 'select') {
      // The real column list must resolve: orders.drop_id no longer exists.
      if (/drop_id/.test(q.columns)) {
        return { data: null, error: { code: '42703', message: 'column orders.drop_id does not exist' } };
      }
      return {
        data: { id: 'order-1', status: orderStatus, buyer_email: 'buyer@example.com', seller_id: 'seller-1' },
        error: null,
      };
    }
    if (q.table === 'orders' && q.op === 'update') return { data: null, error: null };
    if (q.table === 'order_items') return { data: { title_snapshot: 'Studio Tote' }, error: null };
    if (q.table === 'profiles') return { data: { handle: 'maker' }, error: null };
    return { data: null, error: { message: `relation "${q.table}" does not exist` } };
  };

  it('marks the order delivered and emails the buyer the order_items title', async () => {
    db.handler = orderHandler('shipped');
    const res = await post('delivered');
    expect(res.status).toBe(200);

    const update = db.log.find((q) => q.table === 'orders' && q.op === 'update')!;
    expect(update.payload).toEqual({ status: 'delivered' });
    expect(update.value('id')).toBe('order-1');

    const item = db.log.find((q) => q.table === 'order_items')!;
    expect(item.columns).toBe('title_snapshot');
    expect(item.value('order_id')).toBe('order-1');

    expect(delivered).toEqual([['buyer@example.com', 'Studio Tote', 'maker']]);
    expect(db.tables()).not.toContain('drops');
  });

  it('moves a labelled order to shipped while in transit', async () => {
    db.handler = orderHandler('label_created');
    const res = await post('in_transit');
    expect(res.status).toBe(200);
    const update = db.log.find((q) => q.table === 'orders' && q.op === 'update')!;
    expect(update.payload).toEqual({ status: 'shipped' });
    expect(delivered).toHaveLength(0);
  });

  it('falls back to a generic title when the order has no items', async () => {
    db.handler = (q) =>
      q.table === 'order_items' ? { data: null, error: null } : orderHandler('label_created')(q);
    const res = await post('delivered');
    expect(res.status).toBe(200);
    expect(delivered).toEqual([['buyer@example.com', 'Your order', 'maker']]);
  });
});

describe('resolveLegacyDropVideoId (/@handle/slug -> /v/[videoId])', () => {
  const resolve = async (params: { handle: string; slug: string }) => {
    const { resolveLegacyDropVideoId } = await import('../legacy-drop-link');
    return resolveLegacyDropVideoId(db as unknown as SupabaseClient, params);
  };

  const happy = (q: Query): Result => {
    if (q.table === 'profiles') {
      return q.value('handle') === 'maker' ? { data: { id: 'seller-1' }, error: null } : { data: null, error: null };
    }
    if (q.table === 'products') {
      return q.value('seller_id') === 'seller-1' && q.value('slug') === 'studio-tote'
        ? { data: { id: 'product-1' }, error: null }
        : { data: null, error: null };
    }
    if (q.table === 'video_products') {
      return { data: [{ video_id: 'video-old' }, { video_id: 'video-new' }], error: null };
    }
    if (q.table === 'videos') return { data: { id: 'video-new' }, error: null };
    return { data: null, error: { message: `relation "${q.table}" does not exist` } };
  };

  it('resolves handle + slug through products and video_products to a live video', async () => {
    db.handler = happy;
    expect(await resolve({ handle: '%40maker', slug: 'studio-tote' })).toBe('video-new');

    expect(db.tables()).toEqual(['profiles', 'products', 'video_products', 'videos']);
    const videos = db.log.find((q) => q.table === 'videos')!;
    expect(videos.value('status')).toBe('live');
    expect(videos.filters).toContainEqual({ kind: 'in', column: 'id', value: ['video-old', 'video-new'] });
    expect(videos.filters).toContainEqual({ kind: 'order', column: 'published_at', value: { ascending: false } });
  });

  it('accepts an already-decoded @handle', async () => {
    db.handler = happy;
    expect(await resolve({ handle: '@maker', slug: 'studio-tote' })).toBe('video-new');
  });

  it.each([
    [{ handle: 'maker', slug: 'studio-tote' }, 'no @ prefix'],
    [{ handle: '%40', slug: 'studio-tote' }, 'empty handle'],
    [{ handle: '%E0%A4%A', slug: 'studio-tote' }, 'malformed escape'],
    [{ handle: '%40nobody', slug: 'studio-tote' }, 'unknown handle'],
    [{ handle: '%40maker', slug: 'not-a-product' }, 'unknown slug'],
  ])('returns null for %j (%s)', async (params) => {
    db.handler = happy;
    expect(await resolve(params)).toBeNull();
  });

  it('returns null when the product has no live video', async () => {
    db.handler = (q) => (q.table === 'video_products' ? { data: [], error: null } : happy(q));
    expect(await resolve({ handle: '%40maker', slug: 'studio-tote' })).toBeNull();
    expect(db.tables()).not.toContain('videos');
  });

  it('returns null instead of throwing when a lookup fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    db.handler = (q) => (q.table === 'products' ? { data: null, error: { message: 'boom' } } : happy(q));
    expect(await resolve({ handle: '%40maker', slug: 'studio-tote' })).toBeNull();
    db.handler = () => {
      throw new Error('network');
    };
    expect(await resolve({ handle: '%40maker', slug: 'studio-tote' })).toBeNull();
    vi.restoreAllMocks();
  });
});
