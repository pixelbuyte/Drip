import { NextRequest, NextResponse } from 'next/server';
import { createPublicClient } from '@/lib/supabase-public';
import { createAdminClient } from '@/lib/supabase-admin';
import { rateLimit, clientIp } from '@/lib/rate-limit';
import { CREATOR_CACHE_CONTROL, loadPublicCreator, normalizeHandle } from '@/lib/creators';

export const dynamic = 'force-dynamic';

/**
 * GET /api/creators/{handle} → { creator: { id, handle, displayName,
 * avatarUrl, followerCount, liveVideoCount } } or 404 { error }.
 *
 * Public: no viewer identity needed and nothing viewer-specific in the body,
 * so the CDN may cache it briefly. See src/lib/creators.ts for the client
 * split and why liveVideoCount is 0 until the seller can take money.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ handle: string }> }
) {
  if (!rateLimit(`creator:${clientIp(request)}`, 60, 60_000)) {
    return NextResponse.json({ error: 'Slow down a moment.' }, { status: 429 });
  }

  const handle = normalizeHandle((await params).handle);
  if (!handle) {
    // A handle the database could never store: same answer as an unknown one.
    return NextResponse.json({ error: 'Creator not found' }, { status: 404 });
  }

  try {
    const creator = await loadPublicCreator(
      { publicDb: createPublicClient(), adminDb: createAdminClient() },
      handle
    );
    if (!creator) {
      return NextResponse.json({ error: 'Creator not found' }, { status: 404 });
    }
    return NextResponse.json(
      { creator },
      { headers: { 'Cache-Control': CREATOR_CACHE_CONTROL } }
    );
  } catch (err) {
    console.error('creator read failed:', err);
    return NextResponse.json({ error: 'Could not load this creator' }, { status: 500 });
  }
}
