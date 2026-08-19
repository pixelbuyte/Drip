import { describe, expect, it } from 'vitest';
import { loadViewerContext, resolveUnpurchasedItems } from '../viewer-context';

/** A structural double that answers a fixed response per table name. */
function sourceOf(byTable: Record<string, unknown[]>) {
  const db = {
    from(table: string) {
      const rows = byTable[table] ?? [];
      const builder = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        or: () => builder,
        maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
        then: (resolve: (r: { data: unknown; error: null }) => void) =>
          resolve({ data: rows, error: null }),
      };
      return builder;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return db as any;
}

describe('loadViewerContext', () => {
  it('returns an all-empty profile when viewer_profiles has no row (the common, not rare, case)', async () => {
    const ctx = await loadViewerContext(sourceOf({}), {
      anonId: 'a1',
      countryCode: 'US',
      excludeIds: new Set(),
    });
    expect(ctx.profile.coldStartComplete).toBe(false);
    expect(ctx.profile.categoryAffinity).toEqual({});
    expect(ctx.profile.priceBand).toBeNull();
  });

  it('maps a populated viewer_profiles row', async () => {
    const ctx = await loadViewerContext(
      sourceOf({
        viewer_profiles: [
          {
            category_affinity: { footwear: 0.6, beauty: 0.2 },
            seller_affinity: { s1: 0.4 },
            hashtag_affinity: {},
            price_band: { p25: 1000, p50: 2000, p75: 4000 },
            cold_start_complete: true,
          },
        ],
      }),
      { anonId: 'a1', countryCode: 'US', excludeIds: new Set() }
    );
    expect(ctx.profile.categoryAffinity).toEqual({ footwear: 0.6, beauty: 0.2 });
    expect(ctx.profile.priceBand).toEqual({ p25: 1000, p50: 2000, p75: 4000 });
    expect(ctx.profile.coldStartComplete).toBe(true);
  });

  it('treats a malformed price_band as null rather than throwing', async () => {
    const ctx = await loadViewerContext(
      sourceOf({
        viewer_profiles: [
          {
            category_affinity: {},
            seller_affinity: {},
            hashtag_affinity: {},
            price_band: { p25: 'not-a-number' },
            cold_start_complete: false,
          },
        ],
      }),
      { anonId: 'a1', countryCode: 'US', excludeIds: new Set() }
    );
    expect(ctx.profile.priceBand).toBeNull();
  });

  it('follows -> followedSellerIds', async () => {
    const ctx = await loadViewerContext(
      sourceOf({ follows: [{ seller_id: 's1' }, { seller_id: 's2' }] }),
      { anonId: 'a1', countryCode: 'US', excludeIds: new Set() }
    );
    expect(ctx.followedSellerIds).toEqual(new Set(['s1', 's2']));
  });

  it('blocks -> notInterestedVideoIds/SellerIds via the shared loader', async () => {
    const ctx = await loadViewerContext(
      sourceOf({
        viewer_blocks: [
          { subject_type: 'video', subject_id: 'v1' },
          { subject_type: 'seller', subject_id: 's9' },
        ],
      }),
      { anonId: 'a1', countryCode: 'US', excludeIds: new Set() }
    );
    expect(ctx.notInterestedVideoIds).toEqual(new Set(['v1']));
    expect(ctx.notInterestedSellerIds).toEqual(new Set(['s9']));
  });

  it('orders -> purchasedSellerIds and purchasesByVideoId, order-level video_id fallback', async () => {
    const ctx = await loadViewerContext(
      sourceOf({
        orders: [
          {
            seller_id: 's1',
            video_id: 'v1',
            created_at: '2026-08-01T00:00:00Z',
            order_items: [{ video_id: null, product_id: 'p1' }],
          },
        ],
      }),
      { anonId: 'a1', countryCode: 'US', excludeIds: new Set() }
    );
    expect(ctx.purchasedSellerIds).toEqual(new Set(['s1']));
    expect(ctx.purchasesByVideoId?.has('v1')).toBe(true);
    expect(ctx.purchasesByVideoId?.get('v1')?.hasUnpurchasedItems).toBe(true); // safe default pre-resolution
  });

  it('item-level video_id takes precedence over the order-level one', async () => {
    const ctx = await loadViewerContext(
      sourceOf({
        orders: [
          {
            seller_id: 's1',
            video_id: 'v-order-level',
            created_at: '2026-08-01T00:00:00Z',
            order_items: [{ video_id: 'v-item-level', product_id: 'p1' }],
          },
        ],
      }),
      { anonId: 'a1', countryCode: 'US', excludeIds: new Set() }
    );
    expect(ctx.purchasesByVideoId?.has('v-item-level')).toBe(true);
    expect(ctx.purchasesByVideoId?.has('v-order-level')).toBe(false);
  });

  it('an order_item with no video id anywhere and no product id is skipped', async () => {
    const ctx = await loadViewerContext(
      sourceOf({
        orders: [
          {
            seller_id: 's1',
            video_id: null,
            created_at: '2026-08-01T00:00:00Z',
            order_items: [{ video_id: null, product_id: null }],
          },
        ],
      }),
      { anonId: 'a1', countryCode: 'US', excludeIds: new Set() }
    );
    expect(ctx.purchasesByVideoId?.size).toBe(0);
    // The seller is still credited even though no per-video purchase resolved.
    expect(ctx.purchasedSellerIds).toEqual(new Set(['s1']));
  });

  it('excludeIds is passed through unchanged', async () => {
    const excludeIds = new Set(['x1', 'x2']);
    const ctx = await loadViewerContext(sourceOf({}), { anonId: 'a1', countryCode: 'US', excludeIds });
    expect(ctx.excludeIds).toBe(excludeIds);
  });

  it('viewerId is the anonId', async () => {
    const ctx = await loadViewerContext(sourceOf({}), { anonId: 'anon-42', countryCode: 'US', excludeIds: new Set() });
    expect(ctx.viewerId).toBe('anon-42');
  });
});

describe('resolveUnpurchasedItems', () => {
  it('true when the video still has a live product the viewer has not bought', () => {
    const purchases = new Map([
      ['v1', { purchasedAt: new Date(), hasUnpurchasedItems: true, purchasedProductIds: new Set(['p1']) }],
    ]);
    const liveIds = new Map([['v1', new Set(['p1', 'p2'])]]);
    const out = resolveUnpurchasedItems(purchases, liveIds);
    expect(out.get('v1')?.hasUnpurchasedItems).toBe(true);
  });

  it('false when the viewer has bought every currently-live product', () => {
    const purchases = new Map([
      ['v1', { purchasedAt: new Date(), hasUnpurchasedItems: true, purchasedProductIds: new Set(['p1', 'p2']) }],
    ]);
    const liveIds = new Map([['v1', new Set(['p1', 'p2'])]]);
    const out = resolveUnpurchasedItems(purchases, liveIds);
    expect(out.get('v1')?.hasUnpurchasedItems).toBe(false);
  });

  it('defaults to true (safe: do not suppress) when the video is not in the live-products map', () => {
    const purchases = new Map([
      ['v1', { purchasedAt: new Date(), hasUnpurchasedItems: true, purchasedProductIds: new Set(['p1']) }],
    ]);
    const out = resolveUnpurchasedItems(purchases, new Map());
    expect(out.get('v1')?.hasUnpurchasedItems).toBe(true);
  });

  it('an empty live-products set (nothing left to sell) resolves to false', () => {
    const purchases = new Map([
      ['v1', { purchasedAt: new Date(), hasUnpurchasedItems: true, purchasedProductIds: new Set(['p1']) }],
    ]);
    const liveIds = new Map([['v1', new Set<string>()]]);
    const out = resolveUnpurchasedItems(purchases, liveIds);
    expect(out.get('v1')?.hasUnpurchasedItems).toBe(false);
  });
});
