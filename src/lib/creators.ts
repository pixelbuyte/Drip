import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Public creator profile for GET /api/creators/[handle].
 *
 * Two clients, each doing only what its grants allow:
 *
 *   - The profile row is read with the ANON client. 00006 grants anon SELECT
 *     on exactly (id, handle, display_name, avatar_url) and scopes the public
 *     read policy TO anon, so the database itself guarantees nothing beyond
 *     those columns can come back: a careless `select('*')` here fails rather
 *     than leaks. (A signed-in caller's own bearer client would NOT work:
 *     authenticated only matches profiles_self_read, i.e. their own row.)
 *   - Counts and the charges flag are read with the SERVICE ROLE, scoped by
 *     the seller id resolved above. follows grants anon/authenticated nothing
 *     (00008) and seller_payments is platform-attested state no browser role
 *     can read; only aggregate numbers leave this module.
 *
 * profiles has no bio column (00001/00006), so the response has no bio
 * rather than an invented one. Add it here only once a migration adds it AND
 * puts it on the anon column grant.
 *
 * CHARGES_ENABLED DECISION: the feed (slice.ts) only serves videos whose
 * seller has `seller_payments.charges_enabled`. A creator page, however, is
 * an identity, not a shelf: it can exist before the seller finishes payouts
 * (shared links, follows made from a profile, a seller previewing their own
 * page). So an existing profile is always returned, but `liveVideoCount` is
 * reported as 0 while charges are not enabled, because that is exactly what
 * the seller-profile feed will show. The header count therefore never
 * promises videos the grid cannot render. The flag itself is not exposed.
 */

/** Mirrors the DB rule profiles_handle_format (00006). */
export const HANDLE_RE = /^[a-z0-9_]{3,30}$/;

export const CREATOR_CACHE_CONTROL = 'public, s-maxage=60, stale-while-revalidate=300';

export type PublicCreator = {
  id: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  followerCount: number;
  liveVideoCount: number;
};

/**
 * The URL segment as a stored handle, or null if no profile could have it.
 * Tolerates a leading "@" (links copied from the UI) and any casing.
 */
export function normalizeHandle(raw: string): string | null {
  let handle = raw.trim();
  if (handle.startsWith('@')) handle = handle.slice(1);
  handle = handle.toLowerCase();
  return HANDLE_RE.test(handle) ? handle : null;
}

type ProfileRow = {
  id: string;
  handle: string;
  display_name: string;
  avatar_url: string | null;
};

type Clients = {
  /** Anon-key client; RLS + column grants apply. */
  publicDb: SupabaseClient;
  /** Service-role client; used only for seller-id-scoped aggregates. */
  adminDb: SupabaseClient;
};

/** null when no profile has this (already normalized) handle. */
export async function loadPublicCreator(
  { publicDb, adminDb }: Clients,
  handle: string
): Promise<PublicCreator | null> {
  const { data: profile, error } = (await publicDb
    .from('profiles')
    .select('id, handle, display_name, avatar_url')
    .eq('handle', handle)
    .maybeSingle()) as { data: ProfileRow | null; error: { message: string } | null };
  if (error) throw new Error(`creator profile query failed: ${error.message}`);
  if (!profile) return null;

  const [followers, liveVideos, payments] = await Promise.all([
    adminDb
      .from('follows')
      .select('seller_id', { count: 'exact', head: true })
      .eq('seller_id', profile.id),
    adminDb
      .from('videos')
      .select('id', { count: 'exact', head: true })
      .eq('seller_id', profile.id)
      .eq('status', 'live'),
    adminDb
      .from('seller_payments')
      .select('charges_enabled')
      .eq('seller_id', profile.id)
      .maybeSingle(),
  ]);

  for (const [what, res] of [
    ['follower count', followers],
    ['live video count', liveVideos],
    ['seller payments', payments],
  ] as const) {
    if (res.error) throw new Error(`creator ${what} query failed: ${res.error.message}`);
  }

  const chargesEnabled =
    (payments.data as { charges_enabled: boolean } | null)?.charges_enabled === true;

  return {
    id: profile.id,
    handle: profile.handle,
    displayName: profile.display_name,
    avatarUrl: profile.avatar_url,
    followerCount: followers.count ?? 0,
    liveVideoCount: chargesEnabled ? (liveVideos.count ?? 0) : 0,
  };
}
