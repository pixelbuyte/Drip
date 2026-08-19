import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { getStripe, applicationFeeAmount } from '@/lib/stripe';
import { createAdminClient } from '@/lib/supabase-admin';
import { fulfillOrder } from '@/lib/fulfillment';

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * ORDER RECORDING MUST WORK AGAINST BOTH SCHEMAS.
 *
 * This code deploys the moment the branch merges; the migration chain
 * (00006_reconcile -> 00016) is applied to production SEPARATELY, later, by
 * hand. So there is a window where the deployed webhook runs against the
 * OLD schema (orders.drop_id, drops table, decrement_inventory returning
 * BOOLEAN) — and after the apply it runs against the NEW one
 * (orders.video_id + subtotal/total/platform_fee columns, products table,
 * decrement_product_inventory returning INTEGER). Neither shape is a
 * superset of the other: drop_id does not exist after, video_id does not
 * exist before. Every write below therefore tries the modern shape first
 * and falls back to the legacy shape ONLY on the undefined-column /
 * undefined-function error codes — never on other failures, which stay
 * loud and retryable.
 *
 * The 00007 backfill reuses each drop's id as both its video id and its
 * product id, which is what makes the legacy metadata (drip_drop_id) usable
 * as a video_id/product_id after the migration for in-flight sessions that
 * complete across the boundary.
 */

// PostgREST surfaces an unknown column in an insert payload as PGRST204 and
// an unknown function as PGRST202; raw Postgres equivalents included for the
// cases where the error passes through unmapped.
const UNDEFINED_COLUMN_CODES = new Set(['PGRST204', '42703']);
const UNDEFINED_FUNCTION_CODES = new Set(['PGRST202', '42883']);
const UNDEFINED_TABLE_CODES = new Set(['PGRST205', '42P01']);

type PgError = { code?: string; message?: string } | null;

function codeOf(err: PgError): string {
  return err?.code ?? '';
}

function toShippingAddress(
  name: string | null | undefined,
  address: Stripe.Address | null | undefined
) {
  if (!address) return null;
  return {
    name: name ?? null,
    street1: address.line1,
    street2: address.line2,
    city: address.city,
    state: address.state,
    zip: address.postal_code,
    country: address.country,
  };
}

/**
 * Spend one unit of stock (or `quantity` on the modern schema), returning
 * whether the purchase oversold.
 *
 * Modern: decrement_product_inventory(product_id, qty) -> new count, NULL if
 * insufficient. Legacy (production today): 00001's decrement_inventory
 * returns BOOLEAN, FALSE when sold out — NOT the fork's INTEGER version this
 * handler was originally written against. The old `=== null` check therefore
 * never detected an oversell on the live schema (FALSE !== null), which
 * meant: no auto-refund, order recorded 'paid', no stock to ship. Both
 * return conventions are treated as sold-out here.
 */
async function decrementInventory(
  supabase: AdminClient,
  id: string,
  quantity: number
): Promise<{ oversold: boolean }> {
  const modern = await supabase.rpc('decrement_product_inventory', {
    p_product_id: id,
    p_quantity: quantity,
  });
  if (!modern.error) {
    return { oversold: modern.data === null };
  }
  if (!UNDEFINED_FUNCTION_CODES.has(codeOf(modern.error))) throw modern.error;

  const legacy = await supabase.rpc('decrement_inventory', { drop_id_param: id });
  if (legacy.error) throw legacy.error;
  return { oversold: legacy.data === null || legacy.data === false };
}

/** Full refund + pull the transfer and the application fee back. Throwing
 *  keeps the event retryable — the buyer must be refunded. */
async function refundOversell(paymentIntentId: string, context: string) {
  try {
    await getStripe().refunds.create({
      payment_intent: paymentIntentId,
      reverse_transfer: true,
      refund_application_fee: true,
    });
  } catch (refundErr) {
    console.error(`Oversell refund failed for ${context}:`, refundErr);
    throw refundErr;
  }
}

/** Insert the order, modern columns first, legacy shape only when the modern
 *  columns do not exist yet. Returns null when a concurrent handler already
 *  recorded it (unique violation). */
async function insertOrder(
  supabase: AdminClient,
  modernRow: Record<string, unknown>,
  legacyRow: Record<string, unknown> | null
): Promise<{ id: string } | null> {
  const modern = await supabase.from('orders').insert(modernRow).select('id').single();
  if (!modern.error) return modern.data;
  if (codeOf(modern.error) === '23505') return null;
  if (!legacyRow || !UNDEFINED_COLUMN_CODES.has(codeOf(modern.error))) throw modern.error;

  const legacy = await supabase.from('orders').insert(legacyRow).select('id').single();
  if (!legacy.error) return legacy.data;
  if (codeOf(legacy.error) === '23505') return null;
  throw legacy.error;
}

/** Best-effort order_items snapshot. Modern schema only; silently absent on
 *  the legacy schema. A failure here never blocks the order itself — the
 *  order row is the money record, the item row is reporting granularity. */
async function insertOrderItem(
  supabase: AdminClient,
  row: {
    order_id: string;
    product_id: string;
    seller_id: string;
    video_id: string;
    variant_snapshot: string | null;
    unit_price_cents: number;
    quantity: number;
  }
) {
  try {
    const { data: product } = await supabase
      .from('products')
      .select('title')
      .eq('id', row.product_id)
      .maybeSingle();

    const { error } = await supabase.from('order_items').insert({
      ...row,
      title_snapshot: product?.title ?? 'Item',
    });
    if (error && !UNDEFINED_TABLE_CODES.has(codeOf(error))) {
      console.error(`order_items insert failed for order ${row.order_id}:`, error.message);
    }
  } catch (err) {
    console.error(`order_items insert failed for order ${row.order_id}:`, err);
  }
}

// ---------------------------------------------------------------------------
// Legacy storefront: checkout.session.completed
// ---------------------------------------------------------------------------

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

  const { oversold } = await decrementInventory(supabase, dropId, 1);

  if (oversold && session.payment_intent) {
    await refundOversell(session.payment_intent as string, `session ${session.id}`);
  }

  const shipping = session.shipping_details;
  const shippingCents = parseInt(session.metadata?.drip_shipping_cents ?? '0', 10) || 0;
  const shippingAddress = toShippingAddress(shipping?.name, shipping?.address);

  // session.amount_total is the FULL charge — the legacy checkout adds
  // shipping as a line item, so the item subtotal is the charge minus
  // shipping. The fee mirrors what checkout/route.ts set at session
  // creation: applicationFeeAmount over the (discount-adjusted) item price
  // and total, both of which amount_total already reflects.
  const amountCents = session.amount_total ?? 0;
  const subtotalCents = Math.max(amountCents - shippingCents, 0);
  const status = oversold ? 'refunded' : 'paid';

  const shared = {
    seller_id: sellerId,
    stripe_session_id: session.id,
    buyer_email: session.customer_details?.email ?? '',
    buyer_name: shipping?.name ?? session.customer_details?.name ?? '',
    shipping_address: shippingAddress,
    amount_cents: amountCents,
    shipping_cents: shippingCents,
    status,
  };

  const order = await insertOrder(
    supabase,
    {
      ...shared,
      // Post-backfill, the drop's id IS its video's id and its product's id.
      video_id: dropId,
      subtotal_cents: subtotalCents,
      total_cents: amountCents,
      platform_fee_cents: applicationFeeAmount(subtotalCents, amountCents),
    },
    { ...shared, drop_id: dropId }
  );

  if (oversold || !order) return;

  void insertOrderItem(supabase, {
    order_id: order.id,
    product_id: dropId,
    seller_id: sellerId,
    video_id: dropId,
    variant_snapshot: null,
    unit_price_cents: subtotalCents,
    quantity: 1,
  });

  // Label purchase + emails are best-effort: the order exists and the event
  // claim stands, so a failure here must not re-trigger inventory work.
  // Orders left in 'paid' get a retry button in the seller dashboard.
  await fulfillOrder(supabase, order.id, { sendBuyerEmail: true });
}

// ---------------------------------------------------------------------------
// Feed checkout: payment_intent.succeeded
// ---------------------------------------------------------------------------

/**
 * The in-feed purchase path (/api/checkout/intent) creates a PaymentIntent
 * with no Checkout Session — this handler is what turns that payment into an
 * order row. Before it existed, feed purchases moved real money and recorded
 * NOTHING: no order, no order_items, no video attribution — which is the
 * root cause behind Studio showing "Sold: 0" and "$0.00 earned" forever.
 *
 * No legacy fallback here on purpose: a feed purchase cannot happen against
 * the pre-migration schema (the intent route reads video_products, which
 * does not exist there), so an undefined-column failure means the migration
 * simply has not been applied yet — throwing keeps the event retryable until
 * it has.
 */
async function handlePaymentIntentSucceeded(
  supabase: AdminClient,
  intent: Stripe.PaymentIntent
) {
  const meta = intent.metadata ?? {};
  const videoId = meta.drip_video_id;
  const productId = meta.drip_product_id;
  const sellerId = meta.drip_seller_id;
  // Not a feed purchase (e.g. the PaymentIntent behind a legacy Checkout
  // Session, which checkout.session.completed owns). Nothing to record.
  if (!videoId || !productId || !sellerId) return;

  const { data: existing } = await supabase
    .from('orders')
    .select('id')
    .eq('stripe_payment_intent_id', intent.id)
    .maybeSingle();
  if (existing) return;

  const quantity = Math.max(parseInt(meta.drip_quantity ?? '1', 10) || 1, 1);
  const subtotalCents = parseInt(meta.drip_subtotal_cents ?? '0', 10) || 0;
  const shippingCents = parseInt(meta.drip_shipping_cents ?? '0', 10) || 0;
  const amountCents = intent.amount;

  const modern = await supabase.rpc('decrement_product_inventory', {
    p_product_id: productId,
    p_quantity: quantity,
  });
  if (modern.error) throw modern.error;
  const oversold = modern.data === null;

  if (oversold) {
    await refundOversell(intent.id, `payment intent ${intent.id}`);
  }

  let variantSnapshot: string | null = null;
  try {
    const selection = JSON.parse(meta.drip_selection ?? '{}');
    if (selection && typeof selection === 'object') {
      variantSnapshot = Object.values(selection).join(' / ') || null;
    }
  } catch {
    /* malformed selection metadata; the order still records */
  }

  const order = await insertOrder(
    supabase,
    {
      seller_id: sellerId,
      stripe_payment_intent_id: intent.id,
      buyer_email: intent.receipt_email ?? '',
      buyer_name: intent.shipping?.name ?? '',
      shipping_address: toShippingAddress(intent.shipping?.name, intent.shipping?.address),
      amount_cents: amountCents,
      shipping_cents: shippingCents,
      status: oversold ? 'refunded' : 'paid',
      video_id: videoId,
      buyer_anon_id: meta.drip_anon_id ?? null,
      subtotal_cents: subtotalCents,
      // The PaymentIntent carries the RECORDED fee — authoritative, not a
      // policy recomputation. Fallback only if Stripe ever omits it.
      total_cents: amountCents,
      platform_fee_cents:
        intent.application_fee_amount ?? applicationFeeAmount(subtotalCents, amountCents),
    },
    null
  );

  if (oversold || !order) return;

  void insertOrderItem(supabase, {
    order_id: order.id,
    product_id: productId,
    seller_id: sellerId,
    video_id: videoId,
    variant_snapshot: variantSnapshot,
    unit_price_cents: quantity > 0 ? Math.round(subtotalCents / quantity) : subtotalCents,
    quantity,
  });

  await fulfillOrder(supabase, order.id, {
    sendBuyerEmail: Boolean(intent.receipt_email),
  });
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

      case 'payment_intent.succeeded': {
        const intent = event.data.object as Stripe.PaymentIntent;
        await handlePaymentIntentSucceeded(supabase, intent);
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
