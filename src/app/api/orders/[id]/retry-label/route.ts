import { NextRequest, NextResponse } from 'next/server';
import { createServerClient_ } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';
import { fulfillOrder } from '@/lib/fulfillment';

// Retries label purchase for an order stuck in 'paid' (e.g. EasyPost was
// down during the webhook). Ownership checked via RLS before using the
// service role for fulfillment.
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: orderId } = await params;

  const supabase = await createServerClient_();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  // RLS scopes this to the seller's own orders.
  const { data: order } = await supabase
    .from('orders')
    .select('id, status')
    .eq('id', orderId)
    .eq('seller_id', user.id)
    .single();

  if (!order) {
    return NextResponse.json({ error: 'Order not found' }, { status: 404 });
  }

  if (order.status !== 'paid') {
    return NextResponse.json(
      { error: 'A label already exists for this order' },
      { status: 409 }
    );
  }

  // Buyer already got their confirmation in the webhook; just the label.
  const result = await fulfillOrder(createAdminClient(), orderId, {
    sendBuyerEmail: false,
  });

  if (!result.label_created) {
    return NextResponse.json(
      { error: result.error ?? 'Label purchase failed — try again shortly' },
      { status: 502 }
    );
  }

  return NextResponse.json({ label_created: true });
}
