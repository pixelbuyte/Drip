import { NextResponse } from 'next/server';

// Gone: public.drops was dropped by 00007_feed_content_model.sql. Listings are
// created on the feed content model by POST /api/videos, which accepts the
// same request body and still returns upload_url.
export async function POST() {
  return NextResponse.json({ error: 'gone', replacement: '/api/videos' }, { status: 410 });
}
