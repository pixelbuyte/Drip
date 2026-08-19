import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { getStripe } from '@/lib/stripe';
import { createAdminClient } from '@/lib/supabase-admin';
import { fulfillOrder } from '@/lib/fulfillment';

type AdminClient = ReturnType<typeof createAdminClient>;

// Order creation on payment. Layered idempotency: the event-ID claim plus
// the UNIQUE constraint on orders.stripe_session_id.
async function handleCheckoutCompleted(
  supabase: AdminClient,
  session: Stripe.Checkout.Session
) {
  const dropId = session.metadata?.drip_drop_id;
  const sellerId = session.metadata?.drip_seller_id;
  if (!dropId || !sellerId) {
    console.error(`Session ${session.id} missing drip metadata; skipping`);
    return;
  }

  if (session.payment_status !== 'paid') return;

  // Already recorded (e.g. retried event with a fresh event ID)? Done.
  const { data: existing } = await supabase
    .from('orders')
    .select('id')
    .eq('stripe_session_id', session.id)
    .maybeSingle();
  if (existing) return;

  // Atomic conditional decrement: NULL result means another checkout took
  // the last unit between session creation and payment.
  const { data: newInventory, error: decrementError } = await supabase.rpc(
    'decrement_inventory',
    { drop_id_param: dropId }
  );
  if (decrementError) throw decrementError;

  const oversold = newInventory === null;

  if (oversold && session.payment_intent) {
    // Refund the buyer in full and pull the funds back from the seller's
    // connected account (destination charge -> reverse_transfer).
    try {
      await getStripe().refunds.create({
        payment_intent: session.payment_intent as string,
        reverse_transfer: true,
        refund_application_fee: true,
      });
    } catch (refundErr) {
      console.error(`Oversell refund failed for session ${session.id}:`, refundErr);
      throw refundErr; // keep the event retryable — buyer must be refunded
    }
  }

  const shipping = session.shipping_details;
  const shippingCents = parseInt(session.metadata?.drip_shipping_cents ?? '0', 10) || 0;
  const shippingAddress = shipping?.address
    ? {
        name: shipping.name ?? null,
        street1: shipping.address.line1,
        street2: shipping.address.line2,
        city: shipping.address.city,
        state: shipping.address.state,
        zip: shipping.address.postal_code,
        country: shipping.address.country,
      }
    : null;

  const { data: order, error: orderError } = await supabase
    .from('orders')
    .insert({
      drop_id: dropId,
      seller_id: sellerId,
      stripe_session_id: session.id,
      buyer_email: session.customer_details?.email ?? '',
      buyer_name: shipping?.name ?? session.customer_details?.name ?? '',
      shipping_address: shippingAddress,
      amount_cents: session.amount_total ?? 0,
      shipping_cents: shippingCents,
      status: oversold ? 'refunded' : 'paid',
    })
    .select('id')
    .single();

  if (orderError) {
    // Duplicate session ID means a concurrent handler already recorded it.
    if (orderError.code === '23505') return;
    throw orderError;
  }

  if (oversold || !order) return;

  // Label purchase + emails are best-effort: the order exists and the event
  // claim stands, so a failure here must not re-trigger inventory work.
  // Orders left in 'paid' get a retry button in the seller dashboard.
  await fulfillOrder(supabase, order.id, { sendBuyerEmail: true });
}

export async function POST(request: NextRequest) {
  const stripe = getStripe();
  const signature = request.headers.get('stripe-signature');

  if (!signature) {
    return NextResponse.json({ error: 'Missing signature' }, { status: 400 });
  }

  const rawBody = await request.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err);
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  const supabase = createAdminClient();

  // Idempotency: claim the event ID before processing. A duplicate delivery
  // hits the UNIQUE constraint (23505) and is acknowledged without reprocessing.
  const { error: claimError } = await supabase.from('processed_events').insert({
    provider: 'stripe',
    event_id: event.id,
    event_type: event.type,
  });

  if (claimError) {
    if (claimError.code === '23505') {
      return NextResponse.json({ received: true, duplicate: true });
    }
    console.error('Failed to claim webhook event:', claimError);
    return NextResponse.json({ error: 'Event claim failed' }, { status: 500 });
  }

  try {
    switch (event.type) {
      case 'account.updated': {
        const account = event.data.object as Stripe.Account;
        // charges_enabled lives on `seller_payments`, not `profiles` — profiles
        // is publicly readable and Stripe account state must not be. This
        // handler is the ONLY thing that keeps KYC status in sync, so pointing
        // it at the wrong table meant charges_enabled never updated at all: a
        // seller who completed onboarding stayed permanently unable to sell.
        const { error } = await supabase
          .from('seller_payments')
          .update({ charges_enabled: account.charges_enabled === true })
          .eq('stripe_account_id', account.id);

        if (error) throw error;
        break;
      }

      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        await handleCheckoutCompleted(supabase, session);
        break;
      }

      default:
        break;
    }

    return NextResponse.json({ received: true });
  } catch (err) {
    console.error(`Stripe webhook handler failed for ${event.type}:`, err);
    // Release the claim so Stripe's retry can reprocess this event.
    await supabase
      .from('processed_events')
      .delete()
      .eq('provider', 'stripe')
      .eq('event_id', event.id);
    return NextResponse.json({ error: 'Handler failed' }, { status: 500 });
  }
}
