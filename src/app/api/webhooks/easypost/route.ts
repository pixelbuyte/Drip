import { NextRequest, NextResponse } from 'next/server';
import { verifyEasyPostSignature } from '@/lib/easypost';
import { sendBuyerDelivered } from '@/lib/emails';
import { createAdminClient } from '@/lib/supabase-admin';

type EasyPostEvent = {
  id: string;
  description: string; // e.g. "tracker.updated"
  result: {
    id: string;
    tracking_code?: string;
    status?: string; // pre_transit | in_transit | out_for_delivery | delivered | ...
  };
};

// Tracker statuses that mean the package is moving.
const SHIPPED_STATUSES = new Set(['in_transit', 'out_for_delivery']);

export async function POST(request: NextRequest) {
  const secret = process.env.EASYPOST_WEBHOOK_SECRET;
  if (!secret) {
    // Unset secret = unverifiable webhook. Refuse rather than trust it;
    // EasyPost retries, so nothing is lost once the secret is configured.
    console.error('EASYPOST_WEBHOOK_SECRET is not set; rejecting webhook');
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 });
  }

  const rawBody = await request.text();
  const signature = request.headers.get('x-hmac-signature');

  if (!verifyEasyPostSignature(rawBody, signature, secret)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  let event: EasyPostEvent;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }

  const supabase = createAdminClient();

  const { error: claimError } = await supabase.from('processed_events').insert({
    provider: 'easypost',
    event_id: event.id,
    event_type: event.description,
  });

  if (claimError) {
    if (claimError.code === '23505') {
      return NextResponse.json({ received: true, duplicate: true });
    }
    console.error('Failed to claim EasyPost event:', claimError);
    return NextResponse.json({ error: 'Event claim failed' }, { status: 500 });
  }

  try {
    if (event.description === 'tracker.updated' && event.result.tracking_code) {
      const trackerStatus = event.result.status ?? '';

      const { data: order } = await supabase
        .from('orders')
        .select('id, status, buyer_email, seller_id')
        .eq('tracking_code', event.result.tracking_code)
        .single();

      if (order) {
        if (trackerStatus === 'delivered' && order.status !== 'delivered') {
          await supabase.from('orders').update({ status: 'delivered' }).eq('id', order.id);

          // The item title is snapshotted on order_items (00007), which
          // replaced orders.drop_id and the drops table.
          const [{ data: item }, { data: seller }] = await Promise.all([
            supabase
              .from('order_items')
              .select('title_snapshot')
              .eq('order_id', order.id)
              .order('created_at', { ascending: true })
              .limit(1)
              .maybeSingle(),
            supabase.from('profiles').select('handle').eq('id', order.seller_id).single(),
          ]);

          if (order.buyer_email) {
            await sendBuyerDelivered(
              order.buyer_email,
              item?.title_snapshot ?? 'Your order',
              seller?.handle ?? 'seller'
            );
          }
        } else if (
          SHIPPED_STATUSES.has(trackerStatus) &&
          order.status === 'label_created'
        ) {
          await supabase.from('orders').update({ status: 'shipped' }).eq('id', order.id);
        }
      }
    }

    return NextResponse.json({ received: true });
  } catch (err) {
    console.error('EasyPost webhook handler failed:', err);
    await supabase
      .from('processed_events')
      .delete()
      .eq('provider', 'easypost')
      .eq('event_id', event.id);
    return NextResponse.json({ error: 'Handler failed' }, { status: 500 });
  }
}
