import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getStripe, applicationFeeAmount } from '@/lib/stripe';
import { createAdminClient } from '@/lib/supabase-admin';
import { estimateFlatShippingCents } from '@/lib/shipping';

const checkoutSchema = z.object({
  drop_id: z.string().uuid(),
  // e.g. { "Size": "M", "Color": "Black" } — required when the drop has variants.
  selection: z.record(z.string().max(20), z.string().max(20)).optional(),
  code: z.string().trim().max(20).optional(),
});

export async function POST(request: NextRequest) {
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

  const { data: seller } = await supabase
    .from('profiles')
    .select('id, handle, display_name, stripe_account_id, charges_enabled, from_address')
    .eq('id', drop.seller_id)
    .single();

  if (!seller?.stripe_account_id || !seller.charges_enabled || !seller.from_address) {
    return NextResponse.json({ error: 'Seller cannot accept payments right now' }, { status: 409 });
  }

  // Per-seller discount validation. Codes are matched against this seller
  // only — a coupon never leaks across sellers.
  let discountCouponId: string | null = null;
  let discountCodeUsed: string | null = null;
  if (input.code) {
    const { data: discount } = await supabase
      .from('discount_codes')
      .select('stripe_coupon_id, code')
      .eq('seller_id', seller.id)
      .eq('code', input.code.toUpperCase())
      .eq('active', true)
      .single();

    if (!discount?.stripe_coupon_id) {
      return NextResponse.json({ error: 'Invalid discount code' }, { status: 400 });
    }
    discountCouponId = discount.stripe_coupon_id;
    discountCodeUsed = discount.code;
  }

  const shippingCents = await estimateFlatShippingCents(
    seller.from_address,
    Number(drop.weight_oz),
    drop.dimensions
  );

  const appUrl = process.env.NEXT_PUBLIC_APP_URL!;
  const dropUrl = `${appUrl}/@${seller.handle}/${drop.slug}`;
  const variantLabel = variants.map((d) => selection[d.name]).join(' / ');

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
        transfer_data: { destination: seller.stripe_account_id },
        // 0 at launch (founding seller program); plumbed for the 8% flip.
        application_fee_amount: applicationFeeAmount(drop.price_cents),
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
