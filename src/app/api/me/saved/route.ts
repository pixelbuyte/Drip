import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-admin';
import { resolveSignedAnonId } from '@/lib/anon-request';
import { rateLimit, clientIp } from '@/lib/rate-limit';
import { loadFeedItemDetails } from '@/lib/feed/item-details';
import type { FeedItem } from '@/lib/feed/types';

export const dynamic = 'force-dynamic';

const LIMIT = 60;

/**
 * The viewer's saved videos, newest save first, in the feed's item shape so
 * clients render them with the same cell. Only videos still live and still
 * sellable are returned: a save never resurrects a removed listing.
 */
export async function GET(request: NextRequest) {
  if (!rateLimit(`saved:${clientIp(request)}`, 60, 60_000)) {
    return NextResponse.json({ error: 'Slow down a moment.' }, { status: 429 });
  }

  const anonId = await resolveSignedAnonId(request);
  if (!anonId) {
    return NextResponse.json({ error: 'No viewer identity' }, { status: 401 });
  }

  const db = createAdminClient();
  try {
    const { data, error } = await db
      .from('viewer_video_reactions')
      .select('video_id, saved_at, videos!inner(status)')
      .eq('anon_id', anonId)
      .not('saved_at', 'is', null)
      .eq('videos.status', 'live')
      .order('saved_at', { ascending: false })
      .limit(LIMIT);
    if (error) throw error;

    const ids = (data ?? []).map((r) => (r as { video_id: string }).video_id);
    const details = await loadFeedItemDetails(db, ids);
    const items: FeedItem[] = ids.flatMap((id, position) => {
      const d = details.get(id);
      return d ? [{ ...d, lane: 'chrono' as const, position }] : [];
    });

    return NextResponse.json({ items }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    console.error('saved read failed:', err);
    return NextResponse.json({ error: 'Could not load saved items' }, { status: 500 });
  }
}
