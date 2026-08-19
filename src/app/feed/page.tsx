import { cookies, headers } from 'next/headers';
import { createAdminClient } from '@/lib/supabase-admin';
import { ANON_COOKIE, verifyAnonId } from '@/lib/anon-id';
import { getFeedSliceRankedOrNaive, resolveCountryCode } from '@/lib/feed/ranked-slice';
import { SSR_PLACEHOLDER_SESSION_ID } from '@/lib/feed/types';
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

  if (anonId) {
    try {
      const db = createAdminClient();
      const slice = await getFeedSliceRankedOrNaive(db, {
        anonId,
        // The client owns session identity; this first render only needs
        // content, and the shell re-requests with its real session id.
        sessionId: SSR_PLACEHOLDER_SESSION_ID,
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

  return <FeedShell initialItems={items} surface="for_you" initialExhausted={exhausted} />;
}
