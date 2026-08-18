import { NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { createServerClient_ } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';

// Fetches the live account state from Stripe, syncs charges_enabled to the
// profile, and surfaces outstanding requirements so the UI can tell the
// seller exactly what's blocking them.
export async function GET() {
  const supabase = await createServerClient_();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('stripe_account_id, charges_enabled')
    .eq('id', user.id)
    .single();

  if (!profile?.stripe_account_id) {
    return NextResponse.json({ connected: false, charges_enabled: false, requirements: [] });
  }

  try {
    const stripe = getStripe();
    const account = await stripe.accounts.retrieve(profile.stripe_account_id);
    const chargesEnabled = account.charges_enabled === true;

    if (chargesEnabled !== profile.charges_enabled) {
      // charges_enabled mirrors Stripe's KYC verdict; sellers cannot write
      // it themselves (migration 00006), so sync it as the service role.
      await createAdminClient()
        .from('profiles')
        .update({ charges_enabled: chargesEnabled })
        .eq('id', user.id);
    }

    return NextResponse.json({
      connected: true,
      charges_enabled: chargesEnabled,
      payouts_enabled: account.payouts_enabled === true,
      details_submitted: account.details_submitted === true,
      requirements: account.requirements?.currently_due ?? [],
      disabled_reason: account.requirements?.disabled_reason ?? null,
    });
  } catch (err) {
    console.error('Stripe status check failed:', err);
    return NextResponse.json({ error: 'Failed to check Stripe status' }, { status: 500 });
  }
}
