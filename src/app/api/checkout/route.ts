import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getStripe, applicationFeeAmount } from '@/lib/stripe';
import { createAdminClient } from '@/lib/supabase-admin';
import { estimateFlatShippingCents } from '@/lib/shipping';
import { rateLimit, clientIp } from '@/lib/rate-limit';

const checkoutSchema = z.object({
  drop_id: z.string().uuid(),
  // e.g. { "Size": "M", "Color": "Black" } — required when the drop has variants.
  selection: z.record(z.string().max(20), z.string().max(20)).optional(),
  code: z.string().trim().max(20).optional(),
});

export async function POST(request: NextRequest) {
  if (!rateLimit(`checkout:${clientIp(request)}`, 10, 60_000)) {
    return NextResponse.json(
      { error: 'Too many checkout attempts. Try again in a minute.' },
      { status: 429 }
    );
  }

  let input;
  try {
    input = checkoutSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  // Buyers are unauthenticated; service role reads bypass RLS but every
  // condition is re-checked here server-side.
  const supabase = createAdminClient();

  const { data: drop } = await supabase
    .from('drops')
    .select('id, seller_id, title, slug, description, price_cents, inventory, weight_oz, dimensions, variants, mux_playback_id, status')
    .eq('id', input.drop_id)
    .single();

  if (!drop || drop.status !== 'active') {
    return NextResponse.json({ error: 'This drop is not available' }, { status: 404 });
  }

  if (drop.inventory <= 0) {
    return NextResponse.json({ error: 'Sold out' }, { status: 409 });
  }

  // Validate variant selection against the drop's defined dimensions.
  const variants: { name: string; options: string[] }[] = drop.variants ?? [];
  const selection = input.selection ?? {};
  for (const dim of variants) {
    const chosen = selection[dim.name];
    if (!chosen || !dim.options.includes(chosen)) {
      return NextResponse.json({ error: `Please select a ${dim.name}` }, { status: 400 });
    }
  }

  // The seller's public identity and their payment config live in two
  // different tables: stripe_account_id, charges_enabled and from_address are
  // on `seller_payments`, NOT on `profiles`. profiles carries a public read
  // policy (profiles_public_read_handle, USING (true)), and a Stripe account
  // id — like from_address, the seller's physical home address — must never
  // sit in a publicly readable table. Do not move these columns back.
  //
  // Two queries instead of a PostgREST embed: both are single-row primary-key
  // lookups and run in parallel, the embed's to-one shape depends on PostgREST
  // inferring the seller_payments -> profiles FK, and keeping them separate
  // makes "profile exists but never onboarded" (no seller_payments row at all)
  // a plain null instead of a nested shape to unwrap.
  const [{ data: seller }, { data: payments }] = await Promise.all([
    supabase
      .from('profiles')
      .select('id, handle, display_name')
      .eq('id', drop.seller_id)
      .single(),
    // maybeSingle: a seller with no seller_payments row has simply never
    // started Stripe onboarding — that is a null, not an error.
    supabase
      .from('seller_payments')
      .select('stripe_account_id, charges_enabled, from_address')
      .eq('seller_id', drop.seller_id)
      .maybeSingle(),
  ]);

  // Missing payment row, half-finished onboarding and a seller who never saved
  // a ship-from address all mean the same thing to a buyer: no checkout.
  if (
    !seller ||
    !payments?.stripe_account_id ||
    !payments.charges_enabled ||
    !payments.from_address
  ) {
    return NextResponse.json({ error: 'Seller cannot accept payments right now' }, { status: 409 });
  }

  // Per-seller discount validation. Codes are matched against this seller
  // only — a coupon never leaks across sellers.
  let discountCouponId: string | null = null;
  let discountCodeUsed: string | null = null;
  let discountPercent = 0;
  if (input.code) {
    const { data: discount } = await supabase
      .from('discount_codes')
      .select('stripe_coupon_id, code, percent_off')
      .eq('seller_id', seller.id)
      .eq('code', input.code.toUpperCase())
      .eq('active', true)
      .single();

    if (!discount?.stripe_coupon_id) {
      return NextResponse.json({ error: 'Invalid discount code' }, { status: 400 });
    }
    discountCouponId = discount.stripe_coupon_id;
    discountCodeUsed = discount.code;
    discountPercent = discount.percent_off;
  }

  const shippingCents = await estimateFlatShippingCents(
    // from_address comes off seller_payments, not the publicly readable profiles row.
    payments.from_address,
    Number(drop.weight_oz),
    drop.dimensions
  );

  const appUrl = process.env.NEXT_PUBLIC_APP_URL!;
  const dropUrl = `${appUrl}/@${seller.handle}/${drop.slug}`;
  const variantLabel = variants.map((d) => selection[d.name]).join(' / ');

  // Stripe coupons apply percent-off across ALL line items (shipping
  // included), so the fee is computed on the discounted amounts — what the
  // buyer is actually charged.
  const discountFactor = 1 - discountPercent / 100;
  const discountedItemCents = Math.round(drop.price_cents * discountFactor);
  const discountedTotalCents = Math.round((drop.price_cents + shippingCents) * discountFactor);

  try {
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      // Hard rule: US addresses only.
      shipping_address_collection: { allowed_countries: ['US'] },
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: variantLabel ? `${drop.title} (${variantLabel})` : drop.title,
              ...(drop.description ? { description: drop.description } : {}),
              ...(drop.mux_playback_id
                ? { images: [`https://image.mux.com/${drop.mux_playback_id}/thumbnail.jpg?width=600`] }
                : {}),
            },
            unit_amount: drop.price_cents,
          },
          quantity: 1,
        },
        {
          price_data: {
            currency: 'usd',
            product_data: { name: 'Shipping (USPS)' },
            unit_amount: shippingCents,
          },
          quantity: 1,
        },
      ],
      ...(discountCouponId ? { discounts: [{ coupon: discountCouponId }] } : {}),
      payment_intent_data: {
        // stripe_account_id comes off seller_payments, not the publicly readable profiles row.
        transfer_data: { destination: payments.stripe_account_id },
        // Drip commission (0 during founding program) + Stripe processing
        // passthrough, so the platform never subsidizes card fees.
        application_fee_amount: applicationFeeAmount(discountedItemCents, discountedTotalCents),
        metadata: {
          drip_drop_id: drop.id,
          drip_seller_id: seller.id,
        },
      },
      metadata: {
        drip_drop_id: drop.id,
        drip_seller_id: seller.id,
        drip_variant_selection: JSON.stringify(selection),
        drip_shipping_cents: String(shippingCents),
        ...(discountCodeUsed ? { drip_discount_code: discountCodeUsed } : {}),
      },
      // Limit how long a session can sit open against finite inventory.
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
      success_url: `${dropUrl}/thanks?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: dropUrl,
    });

    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error('Checkout session creation failed:', err);
    return NextResponse.json({ error: 'Could not start checkout' }, { status: 500 });
  }
}
