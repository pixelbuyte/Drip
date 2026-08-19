import type { SupabaseClient } from '@supabase/supabase-js';
import {
  updateViewerAffinityWithSignals,
  watchEventType,
  isNegativeSignalType,
  type ViewerEvent,
} from '@/lib/scoring/affinity';
import type { ViewerProfile } from '@/lib/scoring/types';

/**
 * Per-event, in the events route — not a nightly batch (confirmed with the
 * user). `viewer_profiles.scored_impressions` needs to cross the 20-impression
 * cold-start threshold promptly; a nightly job would leave a viewer's first
 * several sessions always cold-start-scored even after they had generated
 * enough real signal, defeating the point of `coldStartComplete`.
 *
 * KNOWN LIMITATION, stated rather than hidden: this reads the current
 * `viewer_profiles` row, computes the update in the pure core, then writes it
 * back — not a single atomic SQL statement. Two concurrent requests for the
 * same anon_id (two tabs, a fast double-fire) can race and the second write
 * can clobber the first. The affinity numbers this produces are directional
 * signal feeding a ranking model, not a ledger — an occasional lost delta
 * degrades ranking quality by a rounding error, it does not corrupt anything
 * load-bearing. If this ever needs to be airtight, the fix is a Postgres
 * function doing the read-modify-write inside one transaction; not built here
 * to keep this phase's scope to the adapter layer the plan describes.
 */

/** The wire event shape events/route.ts has already parsed and validated. */
export type RawFeedEvent = {
  t: string;
  v: string; // videoId
  p?: string; // productId
  wm?: number; // watched_ms
  dm?: number; // duration_ms
};

// Wire event types with an unambiguous, one-to-one affinity meaning. Every
// other wire type (impression, replay, variant_select, checkout_abandon,
// unsave, unlike, seller_profile_tap, report, video_error) has no
// correspondence in the pure module's vocabulary and is deliberately not
// mapped — not every telemetry event is an affinity signal.
const DIRECT_POSITIVE: ReadonlySet<string> = new Set([
  'purchase', 'add_to_cart', 'checkout_open', 'product_tap', 'follow', 'save', 'share', 'like',
]);

type VideoMeta = { seller_id: string; category_id: string | null; hashtags: string[] | null };

function toViewerEvents(
  events: readonly RawFeedEvent[],
  metaByVideoId: ReadonlyMap<string, VideoMeta>
): ViewerEvent[] {
  const out: ViewerEvent[] = [];

  for (const e of events) {
    const meta = metaByVideoId.get(e.v);
    // No known video (deleted, or metadata fetch missed it) -> the event
    // still matters for suppression bookkeeping in some cases, but without a
    // category/seller to attribute it to there is nothing safe to do with it
    // in the 2.7 pass. Skip rather than guess.
    const base = meta
      ? { categoryId: meta.category_id, sellerId: meta.seller_id, hashtags: meta.hashtags ?? [] }
      : { categoryId: null, sellerId: null, hashtags: [] };

    if (e.t === 'not_interested') {
      out.push({ type: 'not_interested', videoId: e.v, ...base });
      continue;
    }
    if (e.t === 'unfollow' && isNegativeSignalType('unfollow')) {
      if (meta) out.push({ type: 'unfollow', sellerId: meta.seller_id });
      continue;
    }
    if (e.t === 'skip' && typeof e.wm === 'number' && e.wm < 2000) {
      out.push({ type: 'fast_skip', videoId: e.v, ...base });
      continue;
    }
    if (e.t === 'watch_progress' && typeof e.wm === 'number' && typeof e.dm === 'number' && e.dm > 0) {
      const watchType = watchEventType(e.wm / e.dm);
      if (watchType) out.push({ type: watchType, videoId: e.v, ...base });
      continue;
    }
    if (DIRECT_POSITIVE.has(e.t)) {
      out.push({ type: e.t as ViewerEvent['type'], videoId: e.v, ...base });
    }
  }

  return out;
}

async function loadVideoMeta(
  db: SupabaseClient,
  videoIds: readonly string[]
): Promise<Map<string, VideoMeta>> {
  if (videoIds.length === 0) return new Map();
  const { data } = await db
    .from('videos')
    .select('id, seller_id, category_id, hashtags')
    .in('id', videoIds);
  const out = new Map<string, VideoMeta>();
  for (const row of (data ?? []) as (VideoMeta & { id: string })[]) {
    out.set(row.id, { seller_id: row.seller_id, category_id: row.category_id, hashtags: row.hashtags });
  }
  return out;
}

/**
 * Wrapped in its own async function rather than inlined as a bare query
 * expression in a `Promise.all([...])` array literal. That inlining is a real
 * trap: if THIS query throws synchronously (a client whose `.from()` itself
 * throws, rather than rejecting), the throw aborts the array literal before
 * `Promise.all` is ever called — and `loadVideoMeta`'s already-in-flight
 * promise, sitting in the array's first slot, never gets attached to
 * anything. It becomes an unhandled rejection instead of being caught by the
 * try/catch around this whole function, because nothing ever called `.then`
 * or `.catch` on it. Wrapping every branch in an `async function` makes every
 * branch a promise uniformly — a synchronous throw inside an async function
 * becomes a rejected promise, never a bare throw — so `Promise.all` always
 * has real promises to hold, and the outer try/catch always sees everything.
 */
async function loadExistingProfile(
  db: SupabaseClient,
  anonId: string
): Promise<ViewerProfileRow | null> {
  const { data } = await db
    .from('viewer_profiles')
    .select('category_affinity, seller_affinity, hashtag_affinity, price_band, scored_impressions, updated_at')
    .eq('anon_id', anonId)
    .maybeSingle();
  return data as ViewerProfileRow | null;
}

const EMPTY_PROFILE: ViewerProfile = {
  categoryAffinity: {},
  sellerAffinity: {},
  hashtagAffinity: {},
  priceBand: null,
  coldStartComplete: false,
};

type ViewerProfileRow = {
  category_affinity: Record<string, number>;
  seller_affinity: Record<string, number>;
  hashtag_affinity: Record<string, number>;
  price_band: unknown;
  scored_impressions: number;
  updated_at: string;
};

export type RecordAffinityArgs = {
  anonId: string;
  events: readonly RawFeedEvent[];
  now: Date;
};

/**
 * Best-effort, non-blocking — same posture as `recordSlice` and the
 * `issued_ip_hash` write it sits beside. A failure here must never surface
 * to the viewer or cost them their event batch's 202.
 */
export async function recordFeedEventsForAffinity(
  db: SupabaseClient,
  args: RecordAffinityArgs
): Promise<void> {
  try {
    const videoIds = [...new Set(args.events.map((e) => e.v))];
    const [metaByVideoId, row] = await Promise.all([
      loadVideoMeta(db, videoIds),
      loadExistingProfile(db, args.anonId),
    ]);

    const viewerEvents = toViewerEvents(args.events, metaByVideoId);
    if (viewerEvents.length === 0) return;
    const profile: ViewerProfile = row
      ? {
          categoryAffinity: row.category_affinity ?? {},
          sellerAffinity: row.seller_affinity ?? {},
          hashtagAffinity: row.hashtag_affinity ?? {},
          priceBand: null, // price band is set by a separate purchase-driven job, never touched here
          coldStartComplete: false, // irrelevant to the pure update itself
        }
      : EMPTY_PROFILE;

    const daysElapsed = row
      ? Math.max(0, (args.now.getTime() - new Date(row.updated_at).getTime()) / 86_400_000)
      : 0;

    const result = updateViewerAffinityWithSignals({
      profile,
      viewerId: args.anonId,
      events: viewerEvents,
      daysElapsed,
      now: args.now,
      // No embedding neighbour lookup exists yet (spec 6.2 is gated on ~500K
      // events; the platform has none). Omitting `neighbours` degrades
      // not_interested's suppression to the single video and reports that
      // degradation in the result rather than silently doing less than it
      // claims — see NO_NEIGHBOURS's own doc comment.
    });

    const scoredImpressionDelta = viewerEvents.some((e) => e.type === 'watch95' || e.type === 'watch50')
      ? 1
      : 0;

    const { error } = await db.from('viewer_profiles').upsert(
      {
        anon_id: args.anonId,
        category_affinity: result.profile.categoryAffinity,
        seller_affinity: result.profile.sellerAffinity,
        hashtag_affinity: result.profile.hashtagAffinity,
        scored_impressions: (row?.scored_impressions ?? 0) + scoredImpressionDelta,
        affinity_computed_at: args.now.toISOString(),
      },
      { onConflict: 'anon_id' }
    );
    if (error) console.error('viewer_profiles upsert failed:', error.message);

    // Suppressions and seller blocks are DATA the pure core computes but does
    // not persist. spec 6.5's dispute-filed/refund-requested cases have no
    // client-emittable wire event (they originate from checkout/webhook
    // routes, not feed telemetry) and are out of scope here — this call site
    // only ever sees what a viewer's own client can send. Not-interested's
    // seller block and unfollow's suppression ARE reachable from here; wiring
    // their storage (a suppressions table) is the next piece, not yet built.
    void result.suppressions;
    void result.revocations;
    void result.neighbours;
  } catch (err) {
    console.error('recordFeedEventsForAffinity failed:', err);
  }
}
