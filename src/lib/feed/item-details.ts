import type { SupabaseClient } from '@supabase/supabase-js';
import { shapeSellableProducts, type ProductRow } from './products';
import type { FeedItem } from './types';

/**
 * Fetches display details (thumbnail, caption, seller handle, full product
 * shaping) for a small, already-chosen set of video ids. Shared between the
 * ranked feed (`ranked-slice.ts`, chosen by `select()`) and search
 * (`src/lib/search/slice.ts`, chosen by `search_feed_videos`'s ranking) —
 * both pick a small set of video ids from a query that only carries what
 * their own ranking needs, then need the full wire shape for exactly those
 * ids. Neither widens its own candidate/pool query with everything a
 * `FeedItem` needs, since that would cost the same join on every candidate
 * instead of on just the handful actually shown.
 */

type FeedItemDetailsRow = {
  id: string;
  mux_playback_id: string | null;
  duration_seconds: number;
  aspect_ratio: string | null;
  thumbnail_url: string | null;
  caption: string | null;
  hashtags: string[] | null;
  categories: { slug: string } | { slug: string }[] | null;
  profiles: {
    id: string; handle: string; display_name: string; avatar_url: string | null;
  } | null;
  video_products: ProductRow[] | null;
};

export type FeedItemDetails = Omit<FeedItem, 'lane' | 'position'>;

function one<T>(v: T | T[] | null | undefined): T | null {
  if (!v) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

/**
 * `charges_enabled` is not re-checked here: the caller's own query already
 * guaranteed it moments earlier in the same request, and re-verifying it
 * here would only catch a seller losing payment eligibility mid-request,
 * which the naive feed does not guard against either.
 */
export async function loadFeedItemDetails(
  db: SupabaseClient,
  videoIds: readonly string[]
): Promise<Map<string, FeedItemDetails>> {
  const out = new Map<string, FeedItemDetails>();
  if (videoIds.length === 0) return out;

  // supabase-js cannot infer this nested select without blowing its
  // instantiation depth (same issue slice.ts and pool.ts hit) — loosely
  // typed for the chain, cast back to FeedItemDetailsRow[] once below.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const query: any = db
    .from('videos')
    .select(`
      id, mux_playback_id, duration_seconds, aspect_ratio, thumbnail_url, caption, hashtags,
      categories ( slug ),
      profiles ( id, handle, display_name, avatar_url ),
      video_products ( position, pinned_at_second,
        products ( id, title, price_cents, compare_at_price_cents, inventory_count,
                   low_stock_threshold, images, variants, status ) )
    `)
    .in('id', videoIds);
  const { data, error } = (await query) as {
    data: FeedItemDetailsRow[] | null;
    error: { message: string } | null;
  };
  if (error) throw new Error(`feed item details query failed: ${error.message}`);

  for (const v of data ?? []) {
    const profile = one(v.profiles);
    if (!profile) continue;
    const products = shapeSellableProducts(v.video_products);
    if (products.length === 0) continue;

    out.set(v.id, {
      videoId: v.id,
      playbackId: v.mux_playback_id,
      durationSeconds: v.duration_seconds,
      aspectRatio: v.aspect_ratio,
      thumbnailUrl: v.thumbnail_url,
      caption: v.caption,
      hashtags: v.hashtags ?? [],
      categorySlug: one(v.categories)?.slug ?? null,
      seller: {
        id: profile.id,
        handle: profile.handle,
        displayName: profile.display_name,
        avatarUrl: profile.avatar_url,
      },
      products,
    });
  }
  return out;
}
