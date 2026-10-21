import { NextResponse } from 'next/server';

// Gone: public.drops was dropped by 00007_feed_content_model.sql, and
// waitlist_entries is now keyed by product_id. The feed content model has no
// restock route yet (products.inventory_count), so no replacement is named.
export async function POST() {
  return NextResponse.json({ error: 'gone', replacement: null }, { status: 410 });
}
