import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase-admin';
import { rateLimit, clientIp } from '@/lib/rate-limit';
import { ANON_COOKIE, verifyAnonId } from '@/lib/anon-id';
import { getSearchSlice } from '@/lib/search/slice';
import { FEED_SLICE_SIZE, type FeedResponse } from '@/lib/feed/types';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  session_id: z.string().uuid(),
  // Free-text query. Capped well under products.title/description's own
  // bounds; a search box is not a text field for pasting an essay into.
  q: z.string().min(1).max(200),
  // Everything already served this session, same convention as /api/feed.
  exclude_ids: z.string().max(8_000).optional(),
  category: z.string().max(40).optional(),
  seller: z.string().max(40).optional(),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function GET(request: NextRequest) {
  if (!rateLimit(`search:${clientIp(request)}`, 60, 60_000)) {
    return NextResponse.json({ error: 'Slow down a moment.' }, { status: 429 });
  }

  const cookie = request.cookies.get(ANON_COOKIE)?.value;
  const anonId =
    (cookie ? await verifyAnonId(cookie) : null) ??
    request.headers.get('x-drip-anon-id');

  if (!anonId || !UUID_RE.test(anonId)) {
    return NextResponse.json({ error: 'No viewer identity' }, { status: 400 });
  }

  let params;
  try {
    params = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  if (!rateLimit(`search:anon:${anonId}`, 30, 60_000)) {
    return new NextResponse(null, { status: 429 });
  }

  const excludeIds = (params.exclude_ids ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => UUID_RE.test(s))
    .slice(0, 300);

  try {
    const db = createAdminClient();
    const { items, exhausted } = await getSearchSlice(db, {
      query: params.q,
      anonId,
      sessionId: params.session_id,
      excludeIds,
      categorySlug: params.category ?? null,
      sellerHandle: params.seller ?? null,
      limit: FEED_SLICE_SIZE,
    });

    const body: FeedResponse = {
      items,
      sessionId: params.session_id,
      surface: 'search',
      exhausted,
      mode: 'default',
      // No cursor concept for a ranked search result page — pagination is
      // exclude_ids growing, same as the ranked feed's own nextBefore:null.
      nextBefore: null,
    };

    return NextResponse.json(body, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (err) {
    console.error('search slice failed:', err);
    return NextResponse.json({ error: 'Could not search' }, { status: 500 });
  }
}
