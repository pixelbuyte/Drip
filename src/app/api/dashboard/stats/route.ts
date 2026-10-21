import { NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { getAssetViewCounts } from '@/lib/mux';
import { createServerClient_ } from '@/lib/supabase-server';
import { COUNTED_ORDER_STATUSES } from '@/lib/studio/types';

type OrderRow = {
  video_id: string | null;
  total_cents: number | null;
  amount_cents: number | null;
  status: string;
};

/** total_cents is backfilled from amount_cents (00007); prefer it. */
function orderCents(o: OrderRow): number {
  return Number(o.total_cents || o.amount_cents || 0);
}

// Revenue + payout + per-video analytics for the seller dashboard.
//
// Reads the feed content model (00007): orders carry video_id (orders.drop_id
// and public.drops are gone), and per-video views come from videos.mux_asset_id.
// `per_drop` keeps its name for the existing caller and is keyed by video id;
// the 00007 backfill reused each drop's id as its video's id.
export async function GET() {
  const supabase = await createServerClient_();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const [{ data: profile }, { data: orders, error: ordersError }, { data: videos }] =
    await Promise.all([
      // stripe_account_id is on `seller_payments`, not `profiles` (profiles is
      // publicly readable). maybeSingle: no row means onboarding never started.
      supabase
        .from('seller_payments')
        .select('stripe_account_id')
        .eq('seller_id', user.id)
        .maybeSingle(),
      // Only completed sales count: pending, refunded, canceled and disputed
      // orders are excluded, the same rule Studio and the feed rollup use.
      supabase
        .from('orders')
        .select('video_id, total_cents, amount_cents, status')
        .eq('seller_id', user.id)
        .in('status', [...COUNTED_ORDER_STATUSES]),
      supabase
        .from('videos')
        .select('id, mux_asset_id')
        .eq('seller_id', user.id),
    ]);

  if (ordersError) {
    console.error('Dashboard stats: orders query failed:', ordersError);
  }

  const validOrders = (orders ?? []) as OrderRow[];
  const totalRevenueCents = validOrders.reduce((sum, o) => sum + orderCents(o), 0);

  const perDrop: Record<string, { views: number; sales: number; revenue_cents: number }> = {};
  for (const video of videos ?? []) {
    perDrop[video.id] = { views: 0, sales: 0, revenue_cents: 0 };
  }
  for (const order of validOrders) {
    const entry = order.video_id ? perDrop[order.video_id] : undefined;
    if (entry) {
      entry.sales += 1;
      entry.revenue_cents += orderCents(order);
    }
  }

  // Mux views (best-effort, zeros on failure).
  const assetIds = (videos ?? [])
    .filter((v) => v.mux_asset_id)
    .map((v) => v.mux_asset_id as string);
  const viewCounts = await getAssetViewCounts(assetIds);
  for (const video of videos ?? []) {
    if (video.mux_asset_id && perDrop[video.id]) {
      perDrop[video.id].views = viewCounts[video.mux_asset_id] ?? 0;
    }
  }

  // Payout balance from the seller's connected account (best-effort).
  let pendingPayoutCents = 0;
  let availablePayoutCents = 0;
  if (profile?.stripe_account_id) {
    try {
      const balance = await getStripe().balance.retrieve({
        stripeAccount: profile.stripe_account_id,
      });
      pendingPayoutCents = balance.pending
        .filter((b) => b.currency === 'usd')
        .reduce((sum, b) => sum + b.amount, 0);
      availablePayoutCents = balance.available
        .filter((b) => b.currency === 'usd')
        .reduce((sum, b) => sum + b.amount, 0);
    } catch (err) {
      console.error('Failed to fetch Stripe balance:', err);
    }
  }

  return NextResponse.json({
    total_revenue_cents: totalRevenueCents,
    total_sales: validOrders.length,
    pending_payout_cents: pendingPayoutCents,
    available_payout_cents: availablePayoutCents,
    per_drop: perDrop,
  });
}
