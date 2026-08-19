import { cookies, headers } from 'next/headers';
import { createAdminClient } from '@/lib/supabase-admin';
import { ANON_COOKIE, verifyAnonId } from '@/lib/anon-id';
import { getSearchSlice } from '@/lib/search/slice';
import { SSR_PLACEHOLDER_SESSION_ID } from '@/lib/feed/types';
import FeedShell from '@/components/feed/feed-shell';

// Server-rendered first slice, same rationale as /feed: the first result's
// poster is the LCP element for whatever a viewer just searched.
export const dynamic = 'force-dynamic';

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const query = (q ?? '').trim();

  const cookieStore = await cookies();
  const headerList = await headers();
  const cookie = cookieStore.get(ANON_COOKIE)?.value;
  const anonId =
    (cookie ? await verifyAnonId(cookie) : null) ?? headerList.get('x-drip-anon-id');

  let items: Awaited<ReturnType<typeof getSearchSlice>>['items'] = [];
  let exhausted = true;

  if (anonId && query) {
    try {
      const db = createAdminClient();
      const slice = await getSearchSlice(db, {
        query,
        anonId,
        // Same throwaway-session rationale as /feed's SSR render: the client
        // owns real session identity and re-requests with it. Never written
        // to feed_slices — see SSR_PLACEHOLDER_SESSION_ID.
        sessionId: SSR_PLACEHOLDER_SESSION_ID,
        excludeIds: [],
      });
      items = slice.items;
      exhausted = slice.exhausted;
    } catch (err) {
      console.error('search page slice failed:', err);
    }
  }

  return (
    <div className="min-h-screen bg-cream pt-16">
      <div className="mx-auto max-w-[560px] px-5 pt-6">
        <h1 className="font-display text-[22px] font-extrabold tracking-[-0.02em] text-ink">
          {query ? (
            <>
              Results for <span className="text-coral">&ldquo;{query}&rdquo;</span>
            </>
          ) : (
            'Search'
          )}
        </h1>
        {query && items.length === 0 && (
          <p className="mt-3 text-[15px] text-muted">
            Nothing matched that search. Try a different word, or browse the feed instead.
          </p>
        )}
        {!query && (
          <p className="mt-3 text-[15px] text-muted">Type something in the search bar above to get started.</p>
        )}
      </div>

      {query && items.length > 0 && (
        <div className="mt-4 h-[calc(100vh-9rem)]">
          <FeedShell initialItems={items} surface="search" initialExhausted={exhausted} query={query} />
        </div>
      )}
    </div>
  );
}
