import { NextRequest, NextResponse } from 'next/server';
import { createPublicClient } from '@/lib/supabase-public';
import { rateLimit, clientIp } from '@/lib/rate-limit';
import { findLiveVideo, normalizeVideoId } from '@/lib/feed/shared-video';
import type { FeedItem } from '@/lib/feed/types';

export const dynamic = 'force-dynamic';

/**
 * GET /api/videos/[id] — one live video in the feed's item shape, for the
 * native app opening a shared link (`drip://v/<id>`, `https://<site>/v/<id>`).
 * Public: read with the anon client, so RLS (live videos only; products only
 * of sellers who can take payment) binds on top of the explicit live filter.
 *
 * 404 for a malformed id, a video that is not live, or one with nothing left
 * to sell. 503 when the lookup itself fails (including the legacy schema,
 * which has no `videos` table) so the client offers a retry instead of
 * claiming the video is gone.
 */
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!rateLimit(`video:${clientIp(request)}`, 120, 60_000)) {
    return NextResponse.json({ error: 'Slow down a moment.' }, { status: 429 });
  }

  const { id } = await ctx.params;
  if (!normalizeVideoId(id)) {
    return NextResponse.json({ error: 'This video is not available.' }, { status: 404 });
  }

  try {
    const details = await findLiveVideo(createPublicClient(), id);
    if (!details) {
      return NextResponse.json({ error: 'This video is not available.' }, { status: 404 });
    }
    const item: FeedItem = { ...details, lane: 'chrono', position: 0 };
    return NextResponse.json({ item }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    console.error('video read failed:', err);
    return NextResponse.json({ error: 'Could not load this video.' }, { status: 503 });
  }
}
