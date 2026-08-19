import { NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { createServerClient_ } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';

// Fetches the live account state from Stripe, syncs charges_enabled to the
// seller's payment record, and surfaces outstanding requirements so the UI can
// tell the seller exactly what's blocking them.
export async function GET() {
  const supabase = await createServerClient_();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  // stripe_account_id and charges_enabled live on `seller_payments`, NOT on
  // `profiles`: profiles carries a public read policy
  // (profiles_public_read_handle, USING (true)), and Stripe account state —
  // alongside the seller's physical ship-from address on the same row — must
  // never sit in a publicly readable table. Do not move these columns back.
  //
  // Reached with the service role because nothing on seller_payments is
  // seller-writable: charges_enabled mirrors Stripe's KYC verdict, not seller
  // input. Authorization is unchanged — authenticated caller only, every
  // statement pinned to their own id.
  const admin = createAdminClient();

  const { data: payments } = await admin
    .from('seller_payments')
    .select('stripe_account_id, charges_enabled')
    .eq('seller_id', user.id)
    .maybeSingle();

  // No seller_payments row at all (profile created before onboarding started)
  // reads exactly like a row with no account id: not connected.
  if (!payments?.stripe_account_id) {
    return NextResponse.json({ connected: false, charges_enabled: false, requirements: [] });
  }

  try {
    const stripe = getStripe();
    const account = await stripe.accounts.retrieve(payments.stripe_account_id);
    const chargesEnabled = account.charges_enabled === true;

    if (chargesEnabled !== payments.charges_enabled) {
      // The row is guaranteed to exist here — we only got past the check above
      // because it held a stripe_account_id — so this is a plain update.
      await admin
        .from('seller_payments')
        .update({ charges_enabled: chargesEnabled })
        .eq('seller_id', user.id);
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
