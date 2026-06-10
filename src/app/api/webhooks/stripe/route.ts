import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { getStripe } from '@/lib/stripe';
import { createAdminClient } from '@/lib/supabase-admin';

export async function POST(request: NextRequest) {
  const stripe = getStripe();
  const signature = request.headers.get('stripe-signature');

  if (!signature) {
    return NextResponse.json({ error: 'Missing signature' }, { status: 400 });
  }

  const rawBody = await request.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err);
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  const supabase = createAdminClient();

  // Idempotency: claim the event ID before processing. A duplicate delivery
  // hits the UNIQUE constraint (23505) and is acknowledged without reprocessing.
  const { error: claimError } = await supabase.from('processed_events').insert({
    provider: 'stripe',
    event_id: event.id,
    event_type: event.type,
  });

  if (claimError) {
    if (claimError.code === '23505') {
      return NextResponse.json({ received: true, duplicate: true });
    }
    console.error('Failed to claim webhook event:', claimError);
    return NextResponse.json({ error: 'Event claim failed' }, { status: 500 });
  }

  try {
    switch (event.type) {
      case 'account.updated': {
        const account = event.data.object as Stripe.Account;
        const { error } = await supabase
          .from('profiles')
          .update({ charges_enabled: account.charges_enabled === true })
          .eq('stripe_account_id', account.id);

        if (error) throw error;
        break;
      }

      // Step 5 wires these up: order creation + atomic inventory decrement.
      case 'checkout.session.completed':
        break;

      default:
        break;
    }

    return NextResponse.json({ received: true });
  } catch (err) {
    console.error(`Stripe webhook handler failed for ${event.type}:`, err);
    // Release the claim so Stripe's retry can reprocess this event.
    await supabase
      .from('processed_events')
      .delete()
      .eq('provider', 'stripe')
      .eq('event_id', event.id);
    return NextResponse.json({ error: 'Handler failed' }, { status: 500 });
  }
}
