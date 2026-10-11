import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Buyer order history. Orders are attributed to the device identity that
 * paid (`orders.buyer_anon_id`, set from the PaymentIntent metadata by the
 * Stripe webhook); `buyer_viewer_id` is never written. So "my orders" is:
 *
 *   - this device's identity, unless another account has claimed it (a
 *     shared device must not show the previous person's orders and
 *     addresses to whoever picks it up next); plus
 *   - when signed in, every identity the account owns
 *     (`viewer_identities.auth_user_id`, set by claim_anon_identity).
 *
 * Orders are deliberately NOT matched by buyer_email: the email is typed at
 * checkout, so matching on it would show a stranger's order (and where it
 * shipped) to whoever owns the address they typed.
 */
export async function buyerAnonIds(
  db: SupabaseClient,
  deviceAnonId: string | null,
  userId: string | null
): Promise<string[]> {
  const ids = new Set<string>();

  if (deviceAnonId) {
    const { data, error } = await db
      .from('viewer_identities')
      .select('auth_user_id')
      .eq('anon_id', deviceAnonId)
      .maybeSingle();
    if (error) throw error;
    const owner = (data as { auth_user_id: string | null } | null)?.auth_user_id ?? null;
    if (owner === null || owner === userId) ids.add(deviceAnonId);
  }

  if (userId) {
    const { data, error } = await db
      .from('viewer_identities')
      .select('anon_id')
      .eq('auth_user_id', userId)
      .limit(50);
    if (error) throw error;
    for (const row of (data ?? []) as { anon_id: string }[]) ids.add(row.anon_id);
  }

  return [...ids];
}

/** Statuses a buyer sees; `pending` never completed payment. */
export const BUYER_VISIBLE_STATUSES = [
  'paid',
  'label_created',
  'shipped',
  'delivered',
  'canceled',
  'refunded',
  'disputed',
] as const;

export type BuyerOrder = {
  id: string;
  createdAt: string;
  status: string;
  totalCents: number;
  shippingCents: number;
  trackingCode: string | null;
  seller: { handle: string | null; displayName: string | null };
  items: {
    title: string;
    variant: string | null;
    quantity: number;
    unitPriceCents: number;
    imageUrl: string | null;
  }[];
};

type Row = {
  id: string;
  created_at: string;
  status: string;
  total_cents: number | null;
  amount_cents: number | null;
  shipping_cents: number | null;
  tracking_code: string | null;
  seller: { handle: string | null; display_name: string | null } | null;
  order_items:
    | {
        title_snapshot: string;
        variant_snapshot: string | null;
        quantity: number;
        unit_price_cents: number;
        product: { images: string[] | null } | null;
      }[]
    | null;
};

export function toBuyerOrder(r: Row): BuyerOrder {
  return {
    id: r.id,
    createdAt: r.created_at,
    status: r.status,
    // total_cents is backfilled from amount_cents (00007); prefer it.
    totalCents: r.total_cents || r.amount_cents || 0,
    shippingCents: r.shipping_cents ?? 0,
    trackingCode: r.tracking_code,
    seller: { handle: r.seller?.handle ?? null, displayName: r.seller?.display_name ?? null },
    items: (r.order_items ?? []).map((i) => ({
      title: i.title_snapshot,
      variant: i.variant_snapshot,
      quantity: i.quantity,
      unitPriceCents: i.unit_price_cents,
      imageUrl: i.product?.images?.[0] ?? null,
    })),
  };
}

export async function loadBuyerOrders(
  db: SupabaseClient,
  anonIds: string[],
  limit = 50
): Promise<BuyerOrder[]> {
  if (anonIds.length === 0) return [];
  const { data, error } = await db
    .from('orders')
    .select(
      'id, created_at, status, total_cents, amount_cents, shipping_cents, tracking_code, ' +
        'seller:profiles ( handle, display_name ), ' +
        'order_items ( title_snapshot, variant_snapshot, quantity, unit_price_cents, product:products ( images ) )'
    )
    .in('buyer_anon_id', anonIds)
    .in('status', [...BUYER_VISIBLE_STATUSES])
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as unknown as Row[]).map(toBuyerOrder);
}
