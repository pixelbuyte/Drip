import { NextRequest, NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { createServerClient_ } from '@/lib/supabase-server';

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

  const { data: profile } = await supabase
    .from('profiles')
    .select('stripe_account_id')
    .eq('id', user.id)
    .single();

  if (!profile?.stripe_account_id) {
    return NextResponse.redirect(new URL('/onboarding/stripe', request.url));
  }

  try {
    const stripe = getStripe();
    const appUrl = process.env.NEXT_PUBLIC_APP_URL!;
    const accountLink = await stripe.accountLinks.create({
      account: profile.stripe_account_id,
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
