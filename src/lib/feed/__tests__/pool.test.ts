import { describe, expect, it } from 'vitest';
import { loadPool } from '../pool';
import { SHIPS_WORLDWIDE } from '@/lib/scoring/candidates';
import { IMPRESSION_BUDGET_TOTAL } from '@/lib/scoring/types';

/** A minimal structural double for the supabase-js query builder chain.
 *  `seen` captures the select string, so tests can assert on the join shape
 *  PostgREST will actually receive — the one thing a structural mock would
 *  otherwise be blind to. */
function sourceOf(rows: unknown[], seen?: { select?: string }) {
  const builder = {
    select: (columns: string) => {
      if (seen) seen.select = columns;
      return builder;
    },
    eq: () => builder,
    not: () => builder,
    order: () => builder,
    limit: () => builder,
    then: (resolve: (r: { data: unknown; error: null }) => void) =>
      resolve({ data: rows, error: null }),
  };
  return { from: () => builder } as unknown as Parameters<typeof loadPool>[0];
}

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'v1',
    seller_id: 's1',
    category_id: 'c1',
    published_at: '2026-08-01T00:00:00Z',
    hashtags: ['drip'],
    status: 'live',
    profiles: { seller_payments: { charges_enabled: true } },
    categories: { live_video_count: 12 },
    video_stats: {
      impressions_1h: 5,
      impressions_24h: 100,
      impressions_all: 500,
      purchases_1h: 1,
      purchases_24h: 4,
      add_to_carts_1h: 2,
      add_to_carts_24h: 10,
      product_taps_1h: 3,
      product_taps_24h: 20,
      completions_24h: 40,
      skips_under_2s_24h: 15,
      shares_24h: 2,
      saves_24h: 6,
      avg_loop_count: 1.5,
      reports_all: 0,
      not_interested_all: 1,
      gmv_cents_24h: 12000,
      exploration_impressions: 100,
    },
    seller_trust: {
      fulfillment_score: 0.9,
      dispute_rate: 0.01,
      rating_avg: 4.5,
      trust_tier: 'trusted',
    },
    video_products: [
      {
        position: 0,
        pinned_at_second: null,
        products: {
          id: 'p1',
          title: 'Thing',
          price_cents: 1999,
          compare_at_price_cents: null,
          inventory_count: 5,
          low_stock_threshold: 2,
          images: [],
          variants: null,
          status: 'active',
        },
      },
    ],
    ...overrides,
  };
}

const NOW = new Date('2026-08-02T00:00:00Z');

describe('loadPool row mapping', () => {
  it('maps a full row to PoolVideo with every field populated', async () => {
    const [v] = await loadPool(sourceOf([baseRow()]), { poolSize: 500, now: NOW });
    expect(v.videoId).toBe('v1');
    expect(v.sellerId).toBe('s1');
    expect(v.categoryId).toBe('c1');
    expect(v.minPriceCents).toBe(1999);
    expect(v.hashtags).toEqual(['drip']);
    expect(v.stats.impressions24h).toBe(100);
    expect(v.stats.purchases1h).toBe(1);
    expect(v.trust.fulfillmentScore).toBe(0.9);
    expect(v.trust.tier).toBe('trusted');
    expect(v.categoryLiveCount).toBe(12);
    expect(v.revenueCents24h).toBe(12000);
  });

  it('drops a video with no sellable product', async () => {
    const rows = [
      baseRow({
        video_products: [
          {
            position: 0,
            pinned_at_second: null,
            products: { id: 'p1', title: 'x', price_cents: 100, compare_at_price_cents: null,
              inventory_count: 0, low_stock_threshold: 2, images: [], variants: null, status: 'active' },
          },
        ],
      }),
    ];
    const out = await loadPool(sourceOf(rows), { poolSize: 500, now: NOW });
    expect(out).toHaveLength(0);
  });

  it('defaults stats to all-zero when video_stats is absent (brand-new video)', async () => {
    const [v] = await loadPool(sourceOf([baseRow({ video_stats: null })]), { poolSize: 500, now: NOW });
    expect(v.stats.impressions24h).toBe(0);
    expect(v.stats.purchases24h).toBe(0);
  });

  it('defaults trust to the fulfillment_score default (0.7) / tier "new" when seller_trust is absent', async () => {
    const [v] = await loadPool(sourceOf([baseRow({ seller_trust: null })]), { poolSize: 500, now: NOW });
    expect(v.trust.fulfillmentScore).toBe(0.7);
    expect(v.trust.tier).toBe('new');
    expect(v.trust.ratingAvg).toBeNull();
  });

  it('normalises a to-one embed returned as a single-item array', async () => {
    const [v] = await loadPool(
      sourceOf([baseRow({ seller_trust: [{ fulfillment_score: 0.95, dispute_rate: 0, rating_avg: 5, trust_tier: 'elite' }] })]),
      { poolSize: 500, now: NOW }
    );
    expect(v.trust.fulfillmentScore).toBe(0.95);
    expect(v.trust.tier).toBe('elite');
  });

  it('rejects an unknown trust_tier value rather than passing it through', async () => {
    const [v] = await loadPool(
      sourceOf([baseRow({ seller_trust: { fulfillment_score: 0.9, dispute_rate: 0, rating_avg: 4, trust_tier: 'bogus' } })]),
      { poolSize: 500, now: NOW }
    );
    expect(v.trust.tier).toBe('new');
  });

  it('coerces string-typed numerics from the wire', async () => {
    const [v] = await loadPool(
      sourceOf([
        baseRow({
          video_stats: {
            impressions_1h: '5', impressions_24h: '100', impressions_all: '500',
            purchases_1h: '1', purchases_24h: '4', add_to_carts_1h: '2', add_to_carts_24h: '10',
            product_taps_1h: '3', product_taps_24h: '20', completions_24h: '40',
            skips_under_2s_24h: '15', shares_24h: '2', saves_24h: '6', avg_loop_count: '1.5',
            reports_all: '0', not_interested_all: '1', gmv_cents_24h: '12000',
            exploration_impressions: '100',
          },
        }),
      ]),
      { poolSize: 500, now: NOW }
    );
    expect(v.stats.impressions24h).toBe(100);
    expect(v.revenueCents24h).toBe(12000);
  });

  it('the seller/shipping placeholders are exactly what was confirmed with the user', async () => {
    const [v] = await loadPool(sourceOf([baseRow()]), { poolSize: 500, now: NOW });
    expect(v.seller.suspended).toBe(false);
    expect(v.seller.shipsToCountries).toEqual([SHIPS_WORLDWIDE]);
  });

  it('minPriceCents is the minimum across multiple sellable products', async () => {
    const rows = [
      baseRow({
        video_products: [
          { position: 0, pinned_at_second: null, products: { id: 'p1', title: 'a', price_cents: 5000,
            compare_at_price_cents: null, inventory_count: 3, low_stock_threshold: 1, images: [], variants: null, status: 'active' } },
          { position: 1, pinned_at_second: null, products: { id: 'p2', title: 'b', price_cents: 1500,
            compare_at_price_cents: null, inventory_count: 2, low_stock_threshold: 1, images: [], variants: null, status: 'active' } },
        ],
      }),
    ];
    const [v] = await loadPool(sourceOf(rows), { poolSize: 500, now: NOW });
    expect(v.minPriceCents).toBe(1500);
  });

  // -- budget --------------------------------------------------------------

  it('budget.satisfied is true once exploration_impressions reaches 500', async () => {
    const rows = [
      baseRow({
        published_at: '2026-08-01T23:00:00Z', // 1h before NOW, well inside the 48h window
        video_stats: { ...baseRow().video_stats as object, exploration_impressions: 500 },
      }),
    ];
    const [v] = await loadPool(sourceOf(rows), { poolSize: 500, now: NOW });
    expect(v.budget?.satisfied).toBe(true);
    expect(v.budget?.impressionsDelivered).toBe(500);
  });

  it('budget.satisfied is false mid-window with fewer than 500 impressions', async () => {
    const rows = [
      baseRow({
        published_at: '2026-08-01T23:00:00Z',
        video_stats: { ...baseRow().video_stats as object, exploration_impressions: 100 },
      }),
    ];
    const [v] = await loadPool(sourceOf(rows), { poolSize: 500, now: NOW });
    expect(v.budget?.satisfied).toBe(false);
  });

  it('budget.satisfied is true once the 48h window has closed, regardless of count', async () => {
    const rows = [
      baseRow({
        published_at: '2026-07-01T00:00:00Z', // far more than 48h before NOW
        video_stats: { ...baseRow().video_stats as object, exploration_impressions: 3 },
      }),
    ];
    const [v] = await loadPool(sourceOf(rows), { poolSize: 500, now: NOW });
    expect(v.budget?.satisfied).toBe(true);
    expect(v.budget?.impressionsDelivered).toBe(3);
  });

  it('budget defaults to 0 delivered when video_stats is absent', async () => {
    const [v] = await loadPool(
      sourceOf([baseRow({ published_at: '2026-08-01T23:00:00Z', video_stats: null })]),
      { poolSize: 500, now: NOW }
    );
    expect(v.budget?.impressionsDelivered).toBe(0);
    expect(v.budget?.budgetTotal).toBe(IMPRESSION_BUDGET_TOTAL);
  });

  it('returns [] on an empty result set', async () => {
    const out = await loadPool(sourceOf([]), { poolSize: 500, now: NOW });
    expect(out).toEqual([]);
  });
});

describe('loadPool join shape', () => {
  it('uses a plain categories embed when no category filter is set (uncategorized videos stay in the pool)', async () => {
    const seen: { select?: string } = {};
    await loadPool(sourceOf([baseRow()], seen), { poolSize: 500, now: NOW });
    expect(seen.select).toContain('categories (');
    expect(seen.select).not.toContain('categories!inner');
  });

  it('tightens categories to !inner when filtering by slug — a filter on a non-inner embed does not restrict parent rows in PostgREST', async () => {
    const seen: { select?: string } = {};
    await loadPool(sourceOf([baseRow()], seen), {
      poolSize: 500,
      now: NOW,
      categorySlug: 'apparel',
    });
    expect(seen.select).toContain('categories!inner ( slug, live_video_count )');
  });

  it('profiles stays !inner (its handle filter restricts parents) and selects handle', async () => {
    const seen: { select?: string } = {};
    await loadPool(sourceOf([baseRow()], seen), {
      poolSize: 500,
      now: NOW,
      sellerHandle: 'shophandle',
    });
    expect(seen.select).toContain('profiles!inner ( handle, seller_payments!inner ( charges_enabled ) )');
  });
});
