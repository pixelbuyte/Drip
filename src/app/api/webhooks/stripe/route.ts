import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { getStripe } from '@/lib/stripe';
import { createAdminClient } from '@/lib/supabase-admin';
import { buyLabel } from '@/lib/easypost';
import { sendSellerLabelEmail, sendBuyerConfirmation } from '@/lib/emails';

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
  await fulfillOrder(supabase, order.id, dropId, sellerId, {
    buyerEmail: session.customer_details?.email ?? '',
    buyerName: shipping?.name ?? session.customer_details?.name ?? '',
    shippingAddress,
    amountCents: session.amount_total ?? 0,
    shippingCents,
    variantSelection: session.metadata?.drip_variant_selection ?? null,
  });
}

type FulfillmentInfo = {
  buyerEmail: string;
  buyerName: string;
  shippingAddress: {
    name: string | null;
    street1: string | null;
    street2: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    country: string | null;
  } | null;
  amountCents: number;
  shippingCents: number;
  variantSelection: string | null;
};

// Buys the shipping label and sends seller + buyer emails. Never throws.
async function fulfillOrder(
  supabase: AdminClient,
  orderId: string,
  dropId: string,
  sellerId: string,
  info: FulfillmentInfo
) {
  try {
    const [{ data: drop }, { data: seller }, { data: sellerUser }] = await Promise.all([
      supabase
        .from('drops')
        .select('title, weight_oz, dimensions, slug')
        .eq('id', dropId)
        .single(),
      supabase
        .from('profiles')
        .select('handle, display_name, from_address')
        .eq('id', sellerId)
        .single(),
      supabase.auth.admin.getUserById(sellerId),
    ]);

    if (!drop || !seller?.from_address) {
      console.error(`Order ${orderId}: missing drop or seller from_address; skipping label`);
      return;
    }

    let variantLabel: string | null = null;
    try {
      const selection = info.variantSelection ? JSON.parse(info.variantSelection) : null;
      if (selection && typeof selection === 'object') {
        variantLabel = Object.values(selection).join(' / ') || null;
      }
    } catch {
      // Malformed metadata; skip the label suffix.
    }

    const emailData = {
      orderId,
      dropTitle: drop.title,
      variantLabel,
      amountCents: info.amountCents,
      shippingCents: info.shippingCents,
      buyerName: info.buyerName,
      buyerEmail: info.buyerEmail,
      shippingAddress: info.shippingAddress,
      sellerDisplayName: seller.display_name,
      sellerHandle: seller.handle,
    };

    let label = null;
    if (info.shippingAddress) {
      try {
        label = await buyLabel(seller.from_address, info.shippingAddress, {
          length_in: drop.dimensions?.length_in ?? 6,
          width_in: drop.dimensions?.width_in ?? 6,
          height_in: drop.dimensions?.height_in ?? 4,
          weight_oz: Number(drop.weight_oz) || 8,
        });

        await supabase
          .from('orders')
          .update({
            easypost_shipment_id: label.shipment_id,
            tracking_code: label.tracking_code,
            label_url: label.label_url,
            status: 'label_created',
          })
          .eq('id', orderId);
      } catch (labelErr) {
        console.error(`Label purchase failed for order ${orderId}:`, labelErr);
      }
    }

    const sellerEmail = sellerUser?.user?.email;
    if (sellerEmail && label) {
      await sendSellerLabelEmail(sellerEmail, emailData, label);
    }

    if (info.buyerEmail) {
      await sendBuyerConfirmation(
        emailData,
        label ? { tracking_code: label.tracking_code, carrier: label.carrier } : null
      );
    }
  } catch (err) {
    console.error(`Fulfillment failed for order ${orderId}:`, err);
  }
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
        const { error } = await supabase
          .from('profiles')
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
