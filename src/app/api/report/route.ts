import { NextResponse } from 'next/server';

// Gone: reports were keyed by drop, and public.drops was dropped by
// 00007_feed_content_model.sql. Clients report a video through the feed event
// stream instead: POST /api/events with event_type 'report'.
export async function POST() {
  return NextResponse.json({ error: 'gone', replacement: '/api/events' }, { status: 410 });
}
