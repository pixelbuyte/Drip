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
    .select('id')
    .eq('id', user.id)
    .single();

  if (profileError || !profile) {
    return NextResponse.json(
      { error: 'Complete your profile before connecting Stripe' },
      { status: 400 }
    );
  }

  // Stripe Connect state (stripe_account_id, charges_enabled) and the seller's
  // ship-from address live on `seller_payments`, NOT on `profiles`: profiles
  // carries a public read policy (profiles_public_read_handle, USING (true)),
  // and a Stripe account id — like the seller's physical home address — must
  // never sit in a publicly readable table. Do not move these columns back.
  //
  // seller_payments is reached with the service role rather than the caller's
  // client: nothing on this table is seller-writable (stripe_account_id is
  // attested by Stripe, not by the seller). Authorization is unchanged — the
  // caller must still be an authenticated user, and every statement below is
  // pinned to their own id.
  const admin = createAdminClient();

  const { data: payments } = await admin
    .from('seller_payments')
    .select('stripe_account_id')
    .eq('seller_id', user.id)
    .maybeSingle();

  const stripe = getStripe();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL!;

  try {
    // No seller_payments row at all is the ordinary brand-new-seller path
    // (profile created before onboarding ever started): it means "not yet
    // connected", exactly like a row with a null stripe_account_id. The row is
    // created below, together with the Stripe account.
    let accountId: string | null = payments?.stripe_account_id ?? null;

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

      // Upsert, not update: the row may not exist yet (brand-new seller), and
      // it may already exist for a seller who saved a ship-from address before
      // connecting Stripe. seller_id is taken from the verified session, so
      // this can only ever touch the caller's own row.
      const { error: upsertError } = await admin
        .from('seller_payments')
        .upsert({ seller_id: user.id, stripe_account_id: accountId }, { onConflict: 'seller_id' });

      if (upsertError) {
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
