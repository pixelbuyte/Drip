import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-admin';
import { resolveSignedAnonId } from '@/lib/anon-request';
import { rateLimit, clientIp } from '@/lib/rate-limit';
import { parseUuidList } from '@/lib/validation';

export const dynamic = 'force-dynamic';

const MAX_IDS = 50;

/**
 * The viewer's own like / save / follow state for a set of videos and
 * sellers, so a heart renders filled on a video liked in an earlier session.
 *
 * Writes stay where they are — like/save/follow are feed events, applied by
 * ingest_feed_events — this is only the read side, which nothing exposed.
 * Scoped to the caller's signed identity; the service-role client is needed
 * because these tables have RLS enabled with no anon/authenticated policies.
 *
 *   GET /api/me/reactions?video_ids=<uuid,...>&seller_ids=<uuid,...>
 *   → { liked: uuid[], saved: uuid[], following: uuid[] }
 */
export async function GET(request: NextRequest) {
  if (!rateLimit(`reactions:${clientIp(request)}`, 120, 60_000)) {
    return NextResponse.json({ error: 'Slow down a moment.' }, { status: 429 });
  }

  const anonId = await resolveSignedAnonId(request);
  if (!anonId) {
    return NextResponse.json({ error: 'No viewer identity' }, { status: 401 });
  }

  const videoIds = parseUuidList(request.nextUrl.searchParams.get('video_ids'), MAX_IDS);
  const sellerIds = parseUuidList(request.nextUrl.searchParams.get('seller_ids'), MAX_IDS);
  if (videoIds === null || sellerIds === null) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const db = createAdminClient();
  try {
    const [reactions, follows] = await Promise.all([
      videoIds.length
        ? db
            .from('viewer_video_reactions')
            .select('video_id, liked_at, saved_at')
            .eq('anon_id', anonId)
            .in('video_id', videoIds)
        : Promise.resolve({ data: [], error: null }),
      sellerIds.length
        ? db
            .from('follows')
            .select('seller_id')
            .eq('anon_id', anonId)
            .in('seller_id', sellerIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (reactions.error) throw reactions.error;
    if (follows.error) throw follows.error;

    const rows = (reactions.data ?? []) as Array<{
      video_id: string; liked_at: string | null; saved_at: string | null;
    }>;
    return NextResponse.json(
      {
        liked: rows.filter((r) => r.liked_at).map((r) => r.video_id),
        saved: rows.filter((r) => r.saved_at).map((r) => r.video_id),
        following: ((follows.data ?? []) as Array<{ seller_id: string }>).map((f) => f.seller_id),
      },
      { headers: { 'Cache-Control': 'private, no-store' } }
    );
  } catch (err) {
    console.error('reactions read failed:', err);
    return NextResponse.json({ error: 'Could not load reactions' }, { status: 500 });
  }
}
