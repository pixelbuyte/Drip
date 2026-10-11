import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { buyerAnonIds, loadBuyerOrders, toBuyerOrder } from '../buyer-orders';

const DEVICE = '11111111-1111-4111-8111-111111111111';
const OTHER_DEVICE = '22222222-2222-4222-8222-222222222222';

/** viewer_identities double: anon_id → auth_user_id. */
function identities(rows: Record<string, string | null>) {
  return {
    from: () => ({
      select: () => ({
        eq: (col: string, val: string) => {
          if (col === 'anon_id') {
            return {
              maybeSingle: async () => ({
                data: val in rows ? { auth_user_id: rows[val] } : null,
                error: null,
              }),
            };
          }
          return {
            limit: async () => ({
              data: Object.entries(rows)
                .filter(([, owner]) => owner === val)
                .map(([anon_id]) => ({ anon_id })),
              error: null,
            }),
          };
        },
      }),
    }),
  } as unknown as SupabaseClient;
}

describe('buyerAnonIds', () => {
  it('a guest sees this device’s orders', async () => {
    expect(await buyerAnonIds(identities({ [DEVICE]: null }), DEVICE, null)).toEqual([DEVICE]);
  });

  it('a signed-in buyer sees every device linked to the account', async () => {
    const db = identities({ [DEVICE]: 'u1', [OTHER_DEVICE]: 'u1' });
    expect((await buyerAnonIds(db, DEVICE, 'u1')).sort()).toEqual([DEVICE, OTHER_DEVICE].sort());
  });

  it('a shared device claimed by another account shows nothing of theirs', async () => {
    const db = identities({ [DEVICE]: 'someone-else' });
    expect(await buyerAnonIds(db, DEVICE, null)).toEqual([]);
    expect(await buyerAnonIds(db, DEVICE, 'u1')).toEqual([]);
  });
});

describe('loadBuyerOrders', () => {
  it('queries nothing for an empty identity set', async () => {
    const db = { from: () => { throw new Error('should not query'); } } as unknown as SupabaseClient;
    expect(await loadBuyerOrders(db, [])).toEqual([]);
  });

  it('maps rows, preferring total_cents and the first product image', () => {
    const o = toBuyerOrder({
      id: 'o1',
      created_at: '2026-10-01T00:00:00Z',
      status: 'shipped',
      total_cents: 8600,
      amount_cents: 8600,
      shipping_cents: 800,
      tracking_code: '1Z',
      seller: { handle: 'maya', display_name: 'Maya Chen' },
      order_items: [
        {
          title_snapshot: 'The Studio Tote',
          variant_snapshot: 'Chocolate',
          quantity: 1,
          unit_price_cents: 7800,
          product: { images: ['https://img.test/a.jpg', 'https://img.test/b.jpg'] },
        },
      ],
    });
    expect(o).toEqual({
      id: 'o1',
      createdAt: '2026-10-01T00:00:00Z',
      status: 'shipped',
      totalCents: 8600,
      shippingCents: 800,
      trackingCode: '1Z',
      seller: { handle: 'maya', displayName: 'Maya Chen' },
      items: [
        { title: 'The Studio Tote', variant: 'Chocolate', quantity: 1, unitPriceCents: 7800, imageUrl: 'https://img.test/a.jpg' },
      ],
    });
  });

  it('falls back to amount_cents for legacy rows and tolerates a deleted product', () => {
    const o = toBuyerOrder({
      id: 'o2', created_at: 't', status: 'paid', total_cents: 0, amount_cents: 4600, shipping_cents: null,
      tracking_code: null, seller: null,
      order_items: [{ title_snapshot: 'Item', variant_snapshot: null, quantity: 2, unit_price_cents: 2300, product: null }],
    });
    expect(o.totalCents).toBe(4600);
    expect(o.shippingCents).toBe(0);
    expect(o.items[0].imageUrl).toBeNull();
    expect(o.seller).toEqual({ handle: null, displayName: null });
  });
});
