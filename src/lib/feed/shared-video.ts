import type { SupabaseClient } from '@supabase/supabase-js';
import { loadFeedItemDetails, type FeedItemDetails } from './item-details';

/**
 * One video by id, for the shareable per-video link (`/v/[videoId]`) and its
 * native counterpart (`GET /api/videos/[id]`). Same wire shape as a feed item
 * (`loadFeedItemDetails`), with two extra rules a shared link needs because
 * its id comes from outside rather than from a ranked query:
 *
 * - the id must be a uuid, or nothing is queried at all;
 * - the video must be `status = 'live'`. A processing, removed or deleted
 *   video is indistinguishable from one that never existed.
 *
 * Like every feed path, a video with no sellable product (all sold out or
 * archived, or the seller lost payouts) is not returned either.
 */

const VIDEO_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The canonical (lowercase) id, or null when `raw` is not a uuid. */
export function normalizeVideoId(raw: unknown): string | null {
  if (typeof raw !== 'string' || !VIDEO_ID_RE.test(raw)) return null;
  return raw.toLowerCase();
}

/**
 * Throws when the query fails (missing table on the legacy schema, network,
 * RLS) — for callers that must tell "not found" from "could not look".
 */
export async function findLiveVideo(
  db: SupabaseClient,
  rawId: unknown
): Promise<FeedItemDetails | null> {
  const id = normalizeVideoId(rawId);
  if (!id) return null;
  const details = await loadFeedItemDetails(db, [id], { liveOnly: true });
  return details.get(id) ?? null;
}

/**
 * Never throws: any failure reads as "no such video". The public page uses
 * this so a broken or not-yet-migrated database (production still runs the
 * legacy schema until 00006+ is applied) renders a 404, never a 500.
 */
export async function loadSharedVideo(
  db: SupabaseClient,
  rawId: unknown
): Promise<FeedItemDetails | null> {
  try {
    return await findLiveVideo(db, rawId);
  } catch (err) {
    console.error('shared video lookup failed:', err);
    return null;
  }
}

export function sharedVideoPath(videoId: string): string {
  return `/v/${videoId}`;
}

/** The stored poster, else Mux's thumbnail for the playback id. */
export function sharedVideoPoster(item: Pick<FeedItemDetails, 'thumbnailUrl' | 'playbackId'>): string | null {
  if (item.thumbnailUrl) return item.thumbnailUrl;
  if (item.playbackId) {
    return `https://image.mux.com/${encodeURIComponent(item.playbackId)}/thumbnail.jpg?width=720&fit_mode=preserve`;
  }
  return null;
}

export function formatPriceCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Title/description for link unfurls (Open Graph, Twitter, iMessage). */
export function sharedVideoSummary(item: FeedItemDetails): { title: string; description: string } {
  const handle = `@${item.seller.handle}`;
  const product = item.products[0];
  const title = product
    ? `${product.title} — ${formatPriceCents(product.priceCents)} · ${handle} on Drip`
    : `${handle} on Drip`;
  const caption = item.caption?.trim();
  const description = caption
    ? caption.length > 200 ? `${caption.slice(0, 199)}…` : caption
    : product
      ? `${product.title} from ${handle}. Watch it and shop it on Drip.`
      : `Watch ${handle} on Drip.`;
  return { title, description };
}
