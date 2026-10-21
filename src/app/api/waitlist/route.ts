import { NextResponse } from 'next/server';

// Gone: waitlist signups were keyed by drop, and public.drops was dropped by
// 00007_feed_content_model.sql (waitlist_entries is now keyed by product_id).
// Nothing on the feed content model writes a waitlist yet.
export async function POST() {
  return NextResponse.json({ error: 'gone', replacement: null }, { status: 410 });
}
