import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase-admin';
import { getStripe, applicationFeeAmount } from '@/lib/stripe';
import { rateLimit, clientIp } from '@/lib/rate-limit';
import { ANON_COOKIE, verifyAnonId } from '@/lib/anon-id';
import { estimateFlatShippingCents } from '@/lib/shipping';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  video_id: z.string().uuid(),
  product_id: z.string().uuid(),
  quantity: z.number().int().min(1).max(10).default(1),
  selection: z.record(z.string().max(24), z.string().max(24)).optional(),
  /** Generated client-side when the sheet opens, so a double-submit or a
   *  retried network request cannot create a second charge. */
  idempotency_key: z.string().min(16).max(64),
  email: z.string().email().max(120).optional(),
});

/**
 * Creates (or returns) the PaymentIntent for an in-feed purchase.
 *
 * Unlike the legacy redirect flow, checkout never leaves the feed, so there is
 * no Checkout Session — the PaymentIntent is the order's identity. Everything
 * that decides the price is computed HERE, server-side: a client that can pick
 * its own amount can buy a $400 item for $4.
 */
export async function POST(request: NextRequest) {
  if (!rateLimit(`intent:${clientIp(request)}`, 12, 60_000)) {
    return NextResponse.json({ error: 'Too many attempts. Try again shortly.' }, { status: 429 });
  }

  const cookie = request.cookies.get(ANON_COOKIE)?.value;
  const anonId = cookie ? await verifyAnonId(cookie) : null;
  if (!anonId) {
    return NextResponse.json({ error: 'No viewer identity' }, { status: 400 });
  }

  let input;
  try {
    input = bodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const db = createAdminClient();

  // The product must actually be attached to the video the viewer is watching.
  // Without this a client can pair any product id with any video id.
  const { data: link } = await db
    .from('video_products')
    .select('product_id, seller_id, videos!inner(id, status), products!inner(id, title, price_cents, inventory_count, status, variants, shipping_profile_id)')
    .eq('video_id', input.video_id)
    .eq('product_id', input.product_id)
    .maybeSingle();

  if (!link) {
    return NextResponse.json({ error: 'That item is not available here' }, { status: 404 });
  }

  const product = (link as unknown as {
    products: {
      id: string; title: string; price_cents: number; inventory_count: number;
      status: string; variants: unknown; shipping_profile_id: string | null;
    };
    videos: { status: string };
    seller_id: string;
  });

  if (product.videos.status !== 'live' || product.products.status !== 'active') {
    return NextResponse.json({ error: 'This drop is no longer available' }, { status: 409 });
  }
  if (product.products.inventory_count < input.quantity) {
    return NextResponse.json(
      { error: 'Sold out', code: 'sold_out', available: product.products.inventory_count },
      { status: 409 }
    );
  }

  const { data: seller } = await db
    .from('profiles')
    .select('id, handle, stripe_account_id, charges_enabled, from_address')
    .eq('id', product.seller_id)
    .single();

  if (!seller?.stripe_account_id || !seller.charges_enabled || !seller.from_address) {
    return NextResponse.json({ error: 'This seller cannot take payments right now' }, { status: 409 });
  }

  // Variant deltas are resolved from the stored variants blob, never from the
  // client, for the same reason the base price is.
  let unitCents = product.products.price_cents;
  const variants = Array.isArray(product.products.variants) ? product.products.variants : [];
  for (const group of variants as Array<{ name?: string; options?: Array<Record<string, unknown>> }>) {
    if (!group?.name || !Array.isArray(group.options)) continue;
    const chosen = input.selection?.[group.name];
    if (!chosen) continue;
    const opt = group.options.find(
      (o) => o.value === chosen || o.name === chosen
    );
    if (opt) unitCents += Number(opt.price_delta_cents ?? 0) || 0;
  }

  const subtotal = unitCents * input.quantity;

  let shippingCents = 0;
  try {
    const { data: profile } = await db
      .from('shipping_profiles')
      .select('weight_oz, length_in, width_in, height_in')
      .eq('id', product.products.shipping_profile_id ?? '')
      .maybeSingle();
    shippingCents = await estimateFlatShippingCents(
      seller.from_address,
      Number(profile?.weight_oz ?? 8),
      {
        length_in: Number(profile?.length_in ?? 9),
        width_in: Number(profile?.width_in ?? 6),
        height_in: Number(profile?.height_in ?? 2),
      }
    );
  } catch (err) {
    console.error('shipping estimate failed, using fallback:', err);
    shippingCents = 595;
  }

  const total = subtotal + shippingCents;

  try {
    const stripe = getStripe();
    const intent = await stripe.paymentIntents.create(
      {
        amount: total,
        currency: 'usd',
        automatic_payment_methods: { enabled: true },
        // Destination charge: the seller is paid, Drip's fee is taken off the
        // top. Same fee model as the legacy flow — commission plus the Stripe
        // processing passthrough, so the platform never subsidizes card fees.
        transfer_data: { destination: seller.stripe_account_id },
        application_fee_amount: applicationFeeAmount(subtotal, total),
        shipping: undefined,
        metadata: {
          drip_video_id: input.video_id,
          drip_product_id: input.product_id,
          drip_seller_id: seller.id,
          drip_anon_id: anonId,
          drip_quantity: String(input.quantity),
          drip_subtotal_cents: String(subtotal),
          drip_shipping_cents: String(shippingCents),
          drip_selection: JSON.stringify(input.selection ?? {}),
        },
        ...(input.email ? { receipt_email: input.email } : {}),
      },
      // Stripe-side idempotency: a retried request returns the SAME intent
      // rather than creating a second one.
      { idempotencyKey: `pi_${input.idempotency_key}` }
    );

    return NextResponse.json({
      clientSecret: intent.client_secret,
      paymentIntentId: intent.id,
      subtotalCents: subtotal,
      shippingCents,
      totalCents: total,
      title: product.products.title,
      sellerHandle: seller.handle,
    });
  } catch (err) {
    console.error('payment intent failed:', err);
    return NextResponse.json(
      { error: 'Something went wrong on our side. You have not been charged.' },
      { status: 500 }
    );
  }
}
