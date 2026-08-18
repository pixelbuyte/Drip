import { NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { getAssetViewCounts } from '@/lib/mux';
import { createServerClient_ } from '@/lib/supabase-server';

// Revenue + payout + per-drop analytics for the seller dashboard.
export async function GET() {
  const supabase = await createServerClient_();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const [{ data: profile }, { data: orders }, { data: drops }] = await Promise.all([
    supabase.from('profiles').select('stripe_account_id').eq('id', user.id).single(),
    supabase
      .from('orders')
      .select('drop_id, amount_cents, status')
      .eq('seller_id', user.id),
    supabase
      .from('drops')
      .select('id, mux_asset_id')
      .eq('seller_id', user.id),
  ]);

  // Revenue excludes refunded orders.
  const validOrders = (orders ?? []).filter((o) => o.status !== 'refunded');
  const totalRevenueCents = validOrders.reduce((sum, o) => sum + o.amount_cents, 0);

  const perDrop: Record<string, { views: number; sales: number; revenue_cents: number }> = {};
  for (const drop of drops ?? []) {
    perDrop[drop.id] = { views: 0, sales: 0, revenue_cents: 0 };
  }
  for (const order of validOrders) {
    const entry = perDrop[order.drop_id];
    if (entry) {
      entry.sales += 1;
      entry.revenue_cents += order.amount_cents;
    }
  }

  // Mux views (best-effort, zeros on failure).
  const assetIds = (drops ?? [])
    .filter((d) => d.mux_asset_id)
    .map((d) => d.mux_asset_id as string);
  const viewCounts = await getAssetViewCounts(assetIds);
  for (const drop of drops ?? []) {
    if (drop.mux_asset_id && perDrop[drop.id]) {
      perDrop[drop.id].views = viewCounts[drop.mux_asset_id] ?? 0;
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
