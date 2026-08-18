import { cookies, headers } from 'next/headers';
import { createAdminClient } from '@/lib/supabase-admin';
import { ANON_COOKIE, verifyAnonId } from '@/lib/anon-id';
import { getFeedSlice } from '@/lib/feed/slice';
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

  let items: Awaited<ReturnType<typeof getFeedSlice>>['items'] = [];
  let exhausted = false;

  if (anonId) {
    try {
      const db = createAdminClient();
      const slice = await getFeedSlice(db, {
        anonId,
        // The client owns session identity; this first render only needs
        // content, and the shell re-requests with its real session id.
        sessionId: '00000000-0000-0000-0000-000000000000',
        surface: 'for_you',
        excludeIds: [],
      });
      items = slice.items;
      exhausted = slice.exhausted;
    } catch (err) {
      console.error('feed page slice failed:', err);
    }
  }

  return <FeedShell initialItems={items} surface="for_you" initialExhausted={exhausted} />;
}
