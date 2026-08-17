import { NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { createServerClient_ } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';

export async function POST() {
  const supabase = await createServerClient_();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('id, stripe_account_id, charges_enabled')
    .eq('id', user.id)
    .single();

  if (profileError || !profile) {
    return NextResponse.json(
      { error: 'Complete your profile before connecting Stripe' },
      { status: 400 }
    );
  }

  const stripe = getStripe();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL!;

  try {
    let accountId = profile.stripe_account_id;

    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        country: 'US',
        email: user.email,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        business_type: 'individual',
        settings: {
          payouts: {
            // Platform can recover negative balances (refunds/disputes)
            // from the seller's external account.
            debit_negative_balances: true,
          },
        },
        metadata: { drip_profile_id: profile.id },
      });

      accountId = account.id;

      // stripe_account_id is attested by Stripe, not by the seller: the
      // authenticated role has no UPDATE privilege on it (migration 00006),
      // so this write goes through the service role.
      const { error: updateError } = await createAdminClient()
        .from('profiles')
        .update({ stripe_account_id: accountId })
        .eq('id', user.id);

      if (updateError) {
        return NextResponse.json({ error: 'Failed to save Stripe account' }, { status: 500 });
      }
    }

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${appUrl}/api/stripe/onboarding/refresh`,
      return_url: `${appUrl}/onboarding/stripe/return`,
      type: 'account_onboarding',
    });

    return NextResponse.json({ url: accountLink.url });
  } catch (err) {
    console.error('Stripe onboarding start failed:', err);
    return NextResponse.json({ error: 'Failed to start Stripe onboarding' }, { status: 500 });
  }
}
