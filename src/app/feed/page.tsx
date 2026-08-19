import { randomUUID } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { createAdminClient } from '@/lib/supabase-admin';
import { ANON_COOKIE, verifyAnonId } from '@/lib/anon-id';
import { getFeedSliceRankedOrNaive, resolveCountryCode } from '@/lib/feed/ranked-slice';
import FeedShell from '@/components/feed/feed-shell';

// Server-rendered first slice: the first video's poster is the LCP element,
// so it must be in the initial HTML rather than behind a client fetch.
export const dynamic = 'force-dynamic';

export default async function FeedPage() {
  const cookieStore = await cookies();
  const headerList = await headers();
  const cookie = cookieStore.get(ANON_COOKIE)?.value;
  const anonId =
    (cookie ? await verifyAnonId(cookie) : null) ?? headerList.get('x-drip-anon-id');

  let items: Awaited<ReturnType<typeof getFeedSliceRankedOrNaive>>['items'] = [];
  let exhausted = false;

  // One fresh session id per render, minted HERE and adopted by the shell.
  // This replaced the shared placeholder id (which could never be recorded
  // to feed_slices without colliding every visitor into one primary key):
  // recording the SSR slice under a real sid, and having the client emit
  // its impressions under the SAME sid, is what lets ingest resolve each
  // impression's lane — without it the first slice's impressions carried a
  // NULL lane, never counted toward the exploration guarantee, and burned
  // the viewer's one countable impression per video on the way through. It
  // also seeds the selection rng per-visitor, so cold-start visitors don't
  // all receive one byte-identical slice.
  const sessionId = randomUUID();

  if (anonId) {
    try {
      const db = createAdminClient();
      const slice = await getFeedSliceRankedOrNaive(db, {
        anonId,
        sessionId,
        surface: 'for_you',
        excludeIds: [],
        countryCode: resolveCountryCode(headerList.get('x-vercel-ip-country')),
      });
      items = slice.items;
      exhausted = slice.exhausted;
    } catch (err) {
      console.error('feed page slice failed:', err);
    }
  }

  return (
    <FeedShell
      initialItems={items}
      surface="for_you"
      initialExhausted={exhausted}
      sessionId={sessionId}
    />
  );
}
