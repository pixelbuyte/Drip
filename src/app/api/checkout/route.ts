import { NextResponse } from 'next/server';

// Gone: the legacy Stripe Checkout Session flow read public.drops, which
// 00007_feed_content_model.sql dropped. Checkout is now the in-feed
// PaymentIntent flow at POST /api/checkout/intent.
export async function POST() {
  return NextResponse.json(
    { error: 'gone', replacement: '/api/checkout/intent' },
    { status: 410 }
  );
}
