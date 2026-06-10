import { NextRequest, NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { createServerClient_ } from '@/lib/supabase-server';
import { createDiscountSchema } from '@/lib/validation';

export async function GET() {
  const supabase = await createServerClient_();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const { data, error } = await supabase
    .from('discount_codes')
    .select('id, code, percent_off, active, created_at')
    .eq('seller_id', user.id)
    .order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: 'Failed to load discount codes' }, { status: 500 });
  }

  return NextResponse.json({ discounts: data });
}

// Creates a seller discount code backed by a Stripe coupon on the platform
// account. Applied per-seller at checkout via session `discounts` — never
// allow_promotion_codes, which would make every code platform-wide.
export async function POST(request: NextRequest) {
  const supabase = await createServerClient_();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  let input;
  try {
    input = createDiscountSchema.parse(await request.json());
  } catch (err) {
    const message =
      err instanceof Error && 'errors' in err
        ? (err as { errors: { message: string }[] }).errors[0]?.message
        : 'Invalid input';
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const code = input.code.toUpperCase();

  try {
    const stripe = getStripe();
    const coupon = await stripe.coupons.create({
      percent_off: input.percent_off,
      duration: 'once',
      name: code,
      metadata: { drip_seller_id: user.id },
    });

    const { data, error } = await supabase
      .from('discount_codes')
      .insert({
        seller_id: user.id,
        code,
        percent_off: input.percent_off,
        stripe_coupon_id: coupon.id,
      })
      .select('id, code, percent_off, active, created_at')
      .single();

    if (error) {
      await stripe.coupons.del(coupon.id);
      if (error.code === '23505') {
        return NextResponse.json({ error: 'You already have a code with that name' }, { status: 409 });
      }
      throw error;
    }

    return NextResponse.json({ discount: data });
  } catch (err) {
    console.error('Discount creation failed:', err);
    return NextResponse.json({ error: 'Failed to create discount code' }, { status: 500 });
  }
}

// Deactivates a code (kept for order history; never hard-deleted).
export async function DELETE(request: NextRequest) {
  const supabase = await createServerClient_();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id) {
    return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  }

  const { error } = await supabase
    .from('discount_codes')
    .update({ active: false })
    .eq('id', id)
    .eq('seller_id', user.id);

  if (error) {
    return NextResponse.json({ error: 'Failed to deactivate code' }, { status: 500 });
  }

  return NextResponse.json({ deactivated: true });
}
