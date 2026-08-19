import { NextRequest, NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { createServerClient_ } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';

// Stripe redirects here (GET) when an Account Link expires mid-onboarding.
// Mint a fresh link and send the seller straight back into the flow.
export async function GET(request: NextRequest) {
  const supabase = await createServerClient_();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.redirect(new URL('/auth/login', request.url));
  }

  // stripe_account_id lives on `seller_payments`, NOT on `profiles`: profiles
  // carries a public read policy (profiles_public_read_handle, USING (true)),
  // and a Stripe account id must never sit in a publicly readable table. Do
  // not move it back. Read with the service role (nothing on seller_payments
  // is seller-writable) and pinned to the authenticated caller's own id.
  const { data: payments } = await createAdminClient()
    .from('seller_payments')
    .select('stripe_account_id')
    .eq('seller_id', user.id)
    .maybeSingle();

  // No seller_payments row at all (never started onboarding) is treated the
  // same as a row without an account id: send them to the top of the flow.
  if (!payments?.stripe_account_id) {
    return NextResponse.redirect(new URL('/onboarding/stripe', request.url));
  }

  try {
    const stripe = getStripe();
    const appUrl = process.env.NEXT_PUBLIC_APP_URL!;
    const accountLink = await stripe.accountLinks.create({
      account: payments.stripe_account_id,
      refresh_url: `${appUrl}/api/stripe/onboarding/refresh`,
      return_url: `${appUrl}/onboarding/stripe/return`,
      type: 'account_onboarding',
    });

    return NextResponse.redirect(accountLink.url);
  } catch (err) {
    console.error('Stripe onboarding refresh failed:', err);
    return NextResponse.redirect(new URL('/onboarding/stripe?error=refresh_failed', request.url));
  }
}
