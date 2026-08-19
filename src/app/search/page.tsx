import { randomUUID } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import Link from 'next/link';
import { createAdminClient } from '@/lib/supabase-admin';
import { ANON_COOKIE, verifyAnonId } from '@/lib/anon-id';
import { getSearchSlice } from '@/lib/search/slice';
import { SearchField } from '@/components/landing/nav';
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

  // Per-render session id, adopted by the shell — same rationale as /feed:
  // the SSR slice is recorded under it and the client's events carry it, so
  // impressions join back to the recorded slice instead of orphaning.
  const sessionId = randomUUID();

  if (anonId && query) {
    try {
      const db = createAdminClient();
      const slice = await getSearchSlice(db, {
        query,
        anonId,
        sessionId,
        excludeIds: [],
      });
      items = slice.items;
      exhausted = slice.exhausted;
    } catch (err) {
      console.error('search page slice failed:', err);
    }
  }

  return (
    <div className="min-h-screen bg-cream">
      <div className="mx-auto max-w-[560px] px-5 pt-6">
        {/* This page must carry its own search box: the landing nav (which
            holds the other one) is only rendered on `/`, so without this a
            viewer here could not start, refine, or change a search without
            navigating home first. */}
        <div className="flex items-center gap-3">
          <Link
            href="/"
            className="shrink-0 font-display text-[22px] font-extrabold tracking-[-0.03em] text-ink"
          >
            Drip<span className="text-coral">.</span>
          </Link>
          <SearchField className="flex-1" initialValue={query} />
        </div>

        <h1 className="mt-6 font-display text-[22px] font-extrabold tracking-[-0.02em] text-ink">
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
            Nothing matched that search. Try a different word, or{' '}
            <Link href="/feed" className="font-semibold text-coral-deep underline">
              browse the feed
            </Link>{' '}
            instead.
          </p>
        )}
        {!query && (
          <p className="mt-3 text-[15px] text-muted">Type something above to get started.</p>
        )}
      </div>

      {query && items.length > 0 && (
        <div className="mt-4 h-[calc(100vh-10rem)]">
          <FeedShell
            initialItems={items}
            surface="search"
            initialExhausted={exhausted}
            query={query}
            sessionId={sessionId}
          />
        </div>
      )}
    </div>
  );
}
