import { describe, expect, it, vi } from 'vitest';
import { recordFeedEventsForAffinity, type RawFeedEvent } from '../affinity-update';

function sourceOf(opts: {
  videos?: Record<string, unknown>[];
  viewerProfile?: Record<string, unknown> | null;
  onUpsert?: (row: Record<string, unknown>) => void;
}) {
  const videos = opts.videos ?? [];
  const errors: string[] = [];

  const db = {
    from(table: string) {
      if (table === 'videos') {
        return {
          select: () => ({ in: () => Promise.resolve({ data: videos, error: null }) }),
        };
      }
      if (table === 'viewer_profiles') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: opts.viewerProfile ?? null, error: null }),
            }),
          }),
          upsert: (row: Record<string, unknown>) => {
            opts.onUpsert?.(row);
            return Promise.resolve({ error: null });
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };

  void errors;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return db as any;
}

const NOW = new Date('2026-08-10T00:00:00Z');

describe('recordFeedEventsForAffinity', () => {
  it('does nothing (no upsert) when no event maps to an affinity signal', async () => {
    let called = false;
    const db = sourceOf({
      videos: [{ id: 'v1', seller_id: 's1', category_id: 'c1', hashtags: [] }],
      onUpsert: () => { called = true; },
    });
    const events: RawFeedEvent[] = [{ t: 'impression', v: 'v1' }, { t: 'video_error', v: 'v1' }];
    await recordFeedEventsForAffinity(db, { anonId: 'a1', events, now: NOW });
    expect(called).toBe(false);
  });

  it('upserts an updated profile for a purchase event', async () => {
    let upserted: Record<string, unknown> | null = null;
    const db = sourceOf({
      videos: [{ id: 'v1', seller_id: 's1', category_id: 'c1', hashtags: ['drip'] }],
      viewerProfile: {
        category_affinity: {},
        seller_affinity: {},
        hashtag_affinity: {},
        price_band: null,
        scored_impressions: 0,
        updated_at: '2026-08-09T00:00:00Z',
      },
      onUpsert: (row) => { upserted = row; },
    });
    const events: RawFeedEvent[] = [{ t: 'purchase', v: 'v1', p: 'p1' }];
    await recordFeedEventsForAffinity(db, { anonId: 'a1', events, now: NOW });
    expect(upserted).not.toBeNull();
    const row = upserted as unknown as { category_affinity: Record<string, number>; anon_id: string };
    expect(row.anon_id).toBe('a1');
    expect(row.category_affinity.c1).toBeGreaterThan(0);
  });

  it('maps a skip under 2s to fast_skip (negative)', async () => {
    // A two-key map isn't enough here: with n=2 the cap's feasibility floor
    // is 1/n = 0.5, so a large negative delta zeroes the losing key and the
    // cap's redistribution hands ALL the freed mass back to it, landing
    // exactly at 0.5/0.5 again — indistinguishable from "nothing happened".
    // Three keys avoids that collapse and shows real relative movement.
    let upserted: Record<string, unknown> | null = null;
    const db = sourceOf({
      videos: [{ id: 'v1', seller_id: 's1', category_id: 'c1', hashtags: [] }],
      viewerProfile: {
        category_affinity: { c1: 0.4, c2: 0.3, c3: 0.3 },
        seller_affinity: {},
        hashtag_affinity: {},
        price_band: null,
        scored_impressions: 5,
        updated_at: '2026-08-09T00:00:00Z',
      },
      onUpsert: (row) => { upserted = row; },
    });
    const events: RawFeedEvent[] = [{ t: 'skip', v: 'v1', wm: 800 }];
    await recordFeedEventsForAffinity(db, { anonId: 'a1', events, now: NOW });
    const row = upserted as unknown as { category_affinity: Record<string, number> } | null;
    expect(row).not.toBeNull();
    expect(row!.category_affinity.c1).toBeLessThan(row!.category_affinity.c2);
  });

  it('a skip at or over 2s is NOT treated as fast_skip', async () => {
    let called = false;
    const db = sourceOf({
      videos: [{ id: 'v1', seller_id: 's1', category_id: 'c1', hashtags: [] }],
      onUpsert: () => { called = true; },
    });
    const events: RawFeedEvent[] = [{ t: 'skip', v: 'v1', wm: 2000 }];
    await recordFeedEventsForAffinity(db, { anonId: 'a1', events, now: NOW });
    expect(called).toBe(false);
  });

  it('watch_progress at >=95% completion maps to watch95 and increments scored_impressions', async () => {
    let upserted: Record<string, unknown> | null = null;
    const db = sourceOf({
      videos: [{ id: 'v1', seller_id: 's1', category_id: 'c1', hashtags: [] }],
      viewerProfile: {
        category_affinity: {},
        seller_affinity: {},
        hashtag_affinity: {},
        price_band: null,
        scored_impressions: 3,
        updated_at: '2026-08-09T00:00:00Z',
      },
      onUpsert: (row) => { upserted = row; },
    });
    const events: RawFeedEvent[] = [{ t: 'watch_progress', v: 'v1', wm: 9500, dm: 10000 }];
    await recordFeedEventsForAffinity(db, { anonId: 'a1', events, now: NOW });
    const row = upserted as unknown as { scored_impressions: number } | null;
    expect(row?.scored_impressions).toBe(4);
  });

  it('counts one scored impression PER watched video, not per batch', async () => {
    // The 20-impression cold-start gate counts videos watched; a batch can
    // carry several. A flat +1 per batch made binge viewers take many times
    // longer to leave cold start.
    let upserted: Record<string, unknown> | null = null;
    const db = sourceOf({
      videos: [
        { id: 'v1', seller_id: 's1', category_id: 'c1', hashtags: [] },
        { id: 'v2', seller_id: 's1', category_id: 'c1', hashtags: [] },
      ],
      viewerProfile: {
        category_affinity: {},
        seller_affinity: {},
        hashtag_affinity: {},
        price_band: null,
        scored_impressions: 3,
        updated_at: '2026-08-09T00:00:00Z',
      },
      onUpsert: (row) => { upserted = row; },
    });
    const events: RawFeedEvent[] = [
      { t: 'watch_progress', v: 'v1', wm: 9500, dm: 10000 },
      { t: 'watch_progress', v: 'v2', wm: 6000, dm: 10000 },
    ];
    await recordFeedEventsForAffinity(db, { anonId: 'a1', events, now: NOW });
    const row = upserted as unknown as { scored_impressions: number } | null;
    expect(row?.scored_impressions).toBe(5); // 3 + one watch95 + one watch50
  });

  it('watch_progress below 50% completion maps to nothing', async () => {
    let called = false;
    const db = sourceOf({
      videos: [{ id: 'v1', seller_id: 's1', category_id: 'c1', hashtags: [] }],
      onUpsert: () => { called = true; },
    });
    const events: RawFeedEvent[] = [{ t: 'watch_progress', v: 'v1', wm: 1000, dm: 10000 }];
    await recordFeedEventsForAffinity(db, { anonId: 'a1', events, now: NOW });
    expect(called).toBe(false);
  });

  it('an event for an unknown video id is skipped, not thrown', async () => {
    const db = sourceOf({ videos: [] });
    const events: RawFeedEvent[] = [{ t: 'purchase', v: 'unknown-video' }];
    await expect(
      recordFeedEventsForAffinity(db, { anonId: 'a1', events, now: NOW })
    ).resolves.toBeUndefined();
  });

  it('a brand-new viewer (no viewer_profiles row) starts from the empty profile', async () => {
    let upserted: Record<string, unknown> | null = null;
    const db = sourceOf({
      videos: [{ id: 'v1', seller_id: 's1', category_id: 'c1', hashtags: [] }],
      viewerProfile: null,
      onUpsert: (row) => { upserted = row; },
    });
    const events: RawFeedEvent[] = [{ t: 'like', v: 'v1' }];
    await recordFeedEventsForAffinity(db, { anonId: 'a1', events, now: NOW });
    const row = upserted as unknown as { category_affinity: Record<string, number> } | null;
    expect(row).not.toBeNull();
    expect(row!.category_affinity.c1).toBeGreaterThan(0);
  });

  it('never throws: a database error anywhere is swallowed', async () => {
    const throwing = {
      from() {
        throw new Error('db down');
      },
    };
    const events: RawFeedEvent[] = [{ t: 'purchase', v: 'v1' }];
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(
      recordFeedEventsForAffinity(throwing as any, { anonId: 'a1', events, now: NOW })
    ).resolves.toBeUndefined();
    spy.mockRestore();
  });

  it('a client whose .from() throws synchronously leaves no unhandled rejection behind', async () => {
    // Regression test for a real bug this file used to have: the video-meta
    // and viewer-profile fetches were once run as
    // `Promise.all([loadVideoMeta(...), db.from(...).select(...)...])` — a
    // bare query expression as the second array element. If THAT expression
    // throws synchronously (not a rejected promise, an actual throw during
    // array construction), the array literal never finishes, Promise.all is
    // never called, and loadVideoMeta's already-in-flight promise — sitting
    // unattached in the aborted array — becomes an unhandled rejection that
    // this function's own try/catch never sees. process's unhandledRejection
    // listener is the only way to observe that failure mode from outside.
    const throwing = {
      from() {
        throw new Error('db down');
      },
    };
    const events: RawFeedEvent[] = [{ t: 'purchase', v: 'v1' }];
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => seen.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await recordFeedEventsForAffinity(throwing as any, { anonId: 'a1', events, now: NOW });
      // Rejections surface on a later microtask/macrotask than the awaited
      // call above; give the event loop a turn before asserting silence.
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', onUnhandled);
      spy.mockRestore();
    }
    expect(seen).toEqual([]);
  });

  it('decay is measured from affinity_computed_at, not the frozen updated_at', async () => {
    // updated_at is never advanced by the upsert (no update trigger on
    // viewer_profiles), so measuring decay from it applied 0.97^(profile age)
    // on EVERY batch — a 90-day-old viewer's whole history was multiplied by
    // ~0.065 each time, letting any single new event overwhelm it. With the
    // clock on affinity_computed_at (written every pass), one day of decay
    // (0.97) leaves the accumulated c1 mass dominant over one new like on c2.
    let upserted: Record<string, unknown> | null = null;
    const db = sourceOf({
      videos: [{ id: 'v1', seller_id: 's1', category_id: 'c2', hashtags: [] }],
      viewerProfile: {
        // Three keys, not two: normalizeWithCap's n=2 feasibility floor pins
        // any two-key map at exactly 0.5/0.5, masking the comparison below.
        category_affinity: { c1: 0.6, c3: 0.4 },
        seller_affinity: {},
        hashtag_affinity: {},
        price_band: null,
        scored_impressions: 40,
        affinity_computed_at: '2026-08-09T00:00:00Z', // 1 day before NOW
        updated_at: '2026-05-12T00:00:00Z', // 90 days before NOW — must be ignored
      },
      onUpsert: (row) => { upserted = row; },
    });
    const events: RawFeedEvent[] = [{ t: 'like', v: 'v1' }];
    await recordFeedEventsForAffinity(db, { anonId: 'a1', events, now: NOW });
    const row = upserted as unknown as { category_affinity: Record<string, number> } | null;
    expect(row).not.toBeNull();
    // Under the updated_at bug this inverts: 0.97^90 ≈ 0.065 of c1 vs 0.3 of
    // c2 puts c2 on top. With the fix, 0.97 of c1 vs 0.3 of c2 keeps c1 first.
    expect(row!.category_affinity.c1).toBeGreaterThan(row!.category_affinity.c2);
  });

  it('an unfollow event nudges seller affinity down when the video meta resolves the seller', async () => {
    // See the fast_skip test above: a two-key map's cap floor (1/n = 0.5)
    // masks any negative delta by redistributing right back to 0.5/0.5.
    let upserted: Record<string, unknown> | null = null;
    const db = sourceOf({
      videos: [{ id: 'v1', seller_id: 's1', category_id: 'c1', hashtags: [] }],
      viewerProfile: {
        category_affinity: {},
        seller_affinity: { s1: 0.4, s2: 0.3, s3: 0.3 },
        hashtag_affinity: {},
        price_band: null,
        scored_impressions: 2,
        updated_at: '2026-08-09T00:00:00Z',
      },
      onUpsert: (row) => { upserted = row; },
    });
    const events: RawFeedEvent[] = [{ t: 'unfollow', v: 'v1' }];
    await recordFeedEventsForAffinity(db, { anonId: 'a1', events, now: NOW });
    const row = upserted as unknown as { seller_affinity: Record<string, number> } | null;
    expect(row).not.toBeNull();
    expect(row!.seller_affinity.s1).toBeLessThan(row!.seller_affinity.s2);
  });
});
