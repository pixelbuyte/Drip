import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase-admin';
import { rateLimit, clientIp } from '@/lib/rate-limit';
import { ANON_COOKIE, verifyAnonId } from '@/lib/anon-id';
import { getFeedSlice, recordSlice } from '@/lib/feed/slice';
import { FEED_SLICE_SIZE, type FeedResponse, type FeedSurface } from '@/lib/feed/types';

export const dynamic = 'force-dynamic';

const SURFACES = [
  'for_you', 'following', 'category', 'seller_profile', 'search', 'shared_link',
] as const;

const querySchema = z.object({
  session_id: z.string().uuid(),
  surface: z.enum(SURFACES).default('for_you'),
  // Everything already served this session. Capped: the client trims its own
  // list, and an unbounded IN () would eventually blow the statement.
  exclude_ids: z.string().max(8_000).optional(),
  category: z.string().max(40).optional(),
  seller: z.string().max(40).optional(),
  // Accepted and echoed, not yet honored — step 10 owns it.
  mode: z.enum(['default', 'diversify']).default('default'),
  offset: z.coerce.number().int().min(0).max(5_000).default(0),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function GET(request: NextRequest) {
  if (!rateLimit(`feed:${clientIp(request)}`, 60, 60_000)) {
    return NextResponse.json({ error: 'Slow down a moment.' }, { status: 429 });
  }

  const cookie = request.cookies.get(ANON_COOKIE)?.value;
  const anonId =
    (cookie ? await verifyAnonId(cookie) : null) ??
    request.headers.get('x-drip-anon-id');

  if (!anonId || !UUID_RE.test(anonId)) {
    // The proxy mints this before any route renders; missing means the cookie
    // was stripped (some in-app browsers do) or forged.
    return NextResponse.json({ error: 'No viewer identity' }, { status: 400 });
  }

  let params;
  try {
    params = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const excludeIds = (params.exclude_ids ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => UUID_RE.test(s))
    .slice(0, 300);

  try {
    const db = createAdminClient();
    const { items, exhausted } = await getFeedSlice(db, {
      anonId,
      sessionId: params.session_id,
      surface: params.surface as FeedSurface,
      excludeIds,
      categorySlug: params.category ?? null,
      sellerHandle: params.seller ?? null,
      limit: FEED_SLICE_SIZE,
    });

    // Non-blocking: attribution is useful, but never at the cost of the feed.
    void recordSlice(db, {
      sessionId: params.session_id,
      anonId,
      items,
      offset: params.offset,
    });

    const body: FeedResponse = {
      items,
      sessionId: params.session_id,
      surface: params.surface as FeedSurface,
      exhausted,
      mode: params.mode,
    };

    return NextResponse.json(body, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (err) {
    console.error('feed slice failed:', err);
    return NextResponse.json({ error: 'Could not load the feed' }, { status: 500 });
  }
}
