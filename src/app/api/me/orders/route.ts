import { NextRequest, NextResponse } from 'next/server';
import { createServerClient_ } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';
import { resolveSignedAnonId } from '@/lib/anon-request';
import { buyerAnonIds, loadBuyerOrders } from '@/lib/buyer-orders';
import { rateLimit, clientIp } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * GET /api/me/orders → { orders: BuyerOrder[] }, newest first, at most 50.
 *
 * Works for guests (this device's purchases) and signed-in buyers (every
 * device linked to the account). See src/lib/buyer-orders.ts for why the
 * identity set is built the way it is. Service role: orders and
 * viewer_identities grant buyers nothing under RLS.
 */
export async function GET(request: NextRequest) {
  if (!rateLimit(`buyer-orders:${clientIp(request)}`, 60, 60_000)) {
    return NextResponse.json({ error: 'Slow down a moment.' }, { status: 429 });
  }

  const supabase = await createServerClient_();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const deviceAnonId = await resolveSignedAnonId(request);
  if (!user && !deviceAnonId) {
    return NextResponse.json({ error: 'No viewer identity' }, { status: 401 });
  }

  try {
    const db = createAdminClient();
    const ids = await buyerAnonIds(db, deviceAnonId, user?.id ?? null);
    const orders = await loadBuyerOrders(db, ids);
    return NextResponse.json({ orders }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    console.error('buyer orders read failed:', err);
    return NextResponse.json({ error: 'Could not load your orders' }, { status: 500 });
  }
}
