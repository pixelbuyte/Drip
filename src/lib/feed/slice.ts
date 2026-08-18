import type { SupabaseClient } from '@supabase/supabase-js';
import {
  FEED_SLICE_SIZE,
  type FeedItem,
  type FeedLane,
  type FeedProduct,
  type FeedSurface,
  type VariantGroup,
} from './types';

/**
 * Step 6 of the build order: the NAIVE feed. Reverse-chronological plus the
 * spec's hard filters, nothing else. It exists to prove the whole surface —
 * shell, events, product sheet, checkout — with real data before any ranking
 * exists. The spec is explicit that a ranking model trained on nothing is
 * worse than reverse-chronological.
 *
 * Everything here runs as the service role: the viewer-scoped tables are
 * unreachable from a browser by design (RLS filters rows, not columns, and an
 * anon device has no JWT to write a policy against), so this function IS the
 * enforcement boundary. Every filter below is applied server-side.
 */

export type SliceParams = {
  anonId: string;
  sessionId: string;
  surface: FeedSurface;
  excludeIds: string[];
  categorySlug?: string | null;
  sellerHandle?: string | null;
  limit?: number;
  /**
   * published_at of the oldest item already served. Reverse-chronological
   * paging needs a cursor: without one the query always returns the newest
   * page, and once exclude_ids covers it the caller gets an empty slice and
   * shows "You're all caught up" while buyable inventory sits below the
   * window.
   */
  before?: string | null;
};

type ProductRow = {
  position: number;
  pinned_at_second: number | null;
  products: {
    id: string; title: string; price_cents: number;
    compare_at_price_cents: number | null; inventory_count: number;
    low_stock_threshold: number; images: string[] | null;
    variants: unknown; status: string;
  } | null;
};

type VideoRow = {
  id: string; seller_id: string; mux_playback_id: string | null;
  duration_seconds: number; aspect_ratio: string | null;
  thumbnail_url: string | null; caption: string | null;
  hashtags: string[] | null; published_at: string;
  categories: { slug: string } | null;
  profiles: { id: string; handle: string; display_name: string; avatar_url: string | null } | null;
  video_products: ProductRow[] | null;
};

function toVariantGroups(raw: unknown): VariantGroup[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((g): VariantGroup[] => {
    if (!g || typeof g !== 'object') return [];
    const group = g as Record<string, unknown>;
    if (typeof group.name !== 'string' || !Array.isArray(group.options)) return [];
    return [{
      id: typeof group.id === 'string' ? group.id : group.name,
      name: group.name,
      options: group.options.flatMap((o): VariantGroup['options'] => {
        if (!o || typeof o !== 'object') return [];
        const opt = o as Record<string, unknown>;
        const value = typeof opt.value === 'string' ? opt.value
          : typeof opt.name === 'string' ? opt.name : null;
        if (!value) return [];
        return [{
          id: typeof opt.id === 'string' ? opt.id : `${group.name}:${value}`,
          value,
          priceDeltaCents: Number(opt.price_delta_cents ?? 0) || 0,
          inventoryCount: Number(opt.inventory_count ?? 0) || 0,
          sku: typeof opt.sku === 'string' ? opt.sku : null,
        }];
      }),
    }];
  });
}

export async function getFeedSlice(
  db: SupabaseClient,
  params: SliceParams
): Promise<{ items: FeedItem[]; exhausted: boolean; nextBefore: string | null }> {
  const limit = params.limit ?? FEED_SLICE_SIZE;

  // Blocks are a hard filter (spec 2.2): a viewer who said not_interested on a
  // video or a seller must never see them again. Read first so it can be
  // applied as a negative filter rather than post-filtered after paging.
  const { data: blocks } = await db
    .from('viewer_blocks')
    .select('subject_type, subject_id')
    .eq('anon_id', params.anonId)
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`);

  const blockedVideos = new Set<string>();
  const blockedSellers = new Set<string>();
  for (const b of blocks ?? []) {
    if (b.subject_type === 'video') blockedVideos.add(b.subject_id as string);
    if (b.subject_type === 'seller') blockedSellers.add(b.subject_id as string);
  }

  const excluded = new Set([...params.excludeIds, ...blockedVideos]);

  // Over-fetch: the "has a buyable product" and block predicates are applied
  // in TypeScript below, so the SQL page must be larger than the slice or a
  // page of sold-out videos returns an empty slice and the shell shows
  // "caught up" while inventory exists.
  const overFetch = Math.min(limit * 4, 200);

  // supabase-js cannot infer this nested select without blowing its
  // instantiation depth, so the builder is loosely typed for the length of the
  // chain and the result is cast back to VideoRow[] once, below.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query: any = db
    .from('videos')
    .select(`
      id, seller_id, mux_playback_id, duration_seconds, aspect_ratio,
      thumbnail_url, caption, hashtags, published_at,
      categories!inner ( slug ),
      profiles!inner ( id, handle, display_name, avatar_url, charges_enabled ),
      video_products ( position, pinned_at_second,
        products ( id, title, price_cents, compare_at_price_cents, inventory_count,
                   low_stock_threshold, images, variants, status ) )
    `)
    .eq('status', 'live')
    // Seller must actually be able to take money (spec 2.2).
    .eq('profiles.charges_enabled', true)
    .not('published_at', 'is', null)
    .order('published_at', { ascending: false })
    .limit(overFetch);

  if (params.before) query = query.lt('published_at', params.before);

  if (params.categorySlug) query = query.eq('categories.slug', params.categorySlug);
  if (params.sellerHandle) query = query.eq('profiles.handle', params.sellerHandle);
  if (excluded.size > 0) {
    query = query.not('id', 'in', `(${[...excluded].join(',')})`);
  }

  const { data, error } = (await query) as {
    data: VideoRow[] | null;
    error: { message: string } | null;
  };
  if (error) throw new Error(`feed query failed: ${error.message}`);

  const items: FeedItem[] = [];
  let oldestSeen: string | null = null;
  for (const v of data ?? []) {
    oldestSeen = v.published_at;
    if (items.length >= limit) break;
    if (blockedSellers.has(v.seller_id)) continue;
    if (!v.profiles) continue;

    // "At least one attached product with status active AND inventory > 0."
    const products: FeedProduct[] = (v.video_products ?? [])
      .filter((vp) => vp.products && vp.products.status === 'active' && vp.products.inventory_count > 0)
      .sort((a, b) => a.position - b.position)
      .slice(0, 5) // a video sells 1-5 products
      .map((vp) => {
        const p = vp.products!;
        return {
          id: p.id,
          title: p.title,
          priceCents: p.price_cents,
          compareAtPriceCents: p.compare_at_price_cents,
          inventoryCount: p.inventory_count,
          lowStockThreshold: p.low_stock_threshold,
          images: p.images ?? [],
          variants: toVariantGroups(p.variants),
          position: vp.position,
          pinnedAtSecond: vp.pinned_at_second,
        };
      });

    if (products.length === 0) continue;

    items.push({
      videoId: v.id,
      playbackId: v.mux_playback_id,
      durationSeconds: v.duration_seconds,
      aspectRatio: v.aspect_ratio,
      thumbnailUrl: v.thumbnail_url,
      caption: v.caption,
      hashtags: v.hashtags ?? [],
      categorySlug: v.categories?.slug ?? null,
      seller: {
        id: v.profiles.id,
        handle: v.profiles.handle,
        displayName: v.profiles.display_name,
        avatarUrl: v.profiles.avatar_url,
      },
      products,
      lane: 'chrono' as FeedLane,
      position: items.length,
    });
  }

  // Exhausted only when the underlying page was short. A full page that
  // filtered down to nothing means "ask again from the cursor", not "the end"
  // — the caller re-requests with nextBefore.
  const pageWasShort = (data?.length ?? 0) < overFetch;
  const exhausted = items.length === 0 && pageWasShort;
  return { items, exhausted, nextBefore: pageWasShort ? null : oldestSeen };
}

/**
 * Records what was served so events can be attributed to a lane later. Best
 * effort: a failure here must never cost the viewer their feed.
 */
export async function recordSlice(
  db: SupabaseClient,
  args: { sessionId: string; anonId: string; items: FeedItem[]; offset: number }
): Promise<void> {
  if (args.items.length === 0) return;
  const rows = args.items.map((it, i) => ({
    session_id: args.sessionId,
    anon_id: args.anonId,
    video_id: it.videoId,
    // NOT NULL. This wrote null and every insert failed silently, so no slice
    // was ever attributed. The naive feed's lane is 'chrono'.
    lane: it.lane,
    position: args.offset + i,
    score: null,
  }));
  const { error } = await db.from('feed_slices').upsert(rows, {
    onConflict: 'session_id,video_id',
    ignoreDuplicates: true,
  });
  if (error) console.error('feed_slices write failed:', error.message);
}
