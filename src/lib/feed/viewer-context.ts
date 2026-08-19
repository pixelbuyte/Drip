import type { SupabaseClient } from '@supabase/supabase-js';
import type { ViewerContext, ViewerVideoPurchase } from '@/lib/scoring/candidates';
import type { PriceBand, ViewerProfile } from '@/lib/scoring/types';
import { loadViewerBlocks } from './blocks';

/**
 * Assembles everything the pure scoring core needs about one viewer:
 * affinity profile, blocks, follows, and purchase history. Nothing here is
 * fetched by the naive feed today — it is new surface for the ranked path.
 *
 * The commerce-eligible order statuses match the rollup job's own definition
 * (migration 00009) exactly, on purpose: "has this viewer bought from this
 * seller" must agree between what counts toward a seller's stats and what
 * counts toward a viewer's purchase history, or the two halves of the
 * platform would disagree about the same fact.
 */

const COMMERCE_ORDER_STATUSES = ['paid', 'label_created', 'shipped', 'delivered'] as const;

const EMPTY_PROFILE: ViewerProfile = {
  categoryAffinity: {},
  sellerAffinity: {},
  hashtagAffinity: {},
  priceBand: null,
  coldStartComplete: false,
};

export type LoadViewerContextOptions = {
  anonId: string;
  countryCode: string;
  excludeIds: ReadonlySet<string>;
};

type ViewerProfileRow = {
  category_affinity: unknown;
  seller_affinity: unknown;
  hashtag_affinity: unknown;
  price_band: unknown;
  cold_start_complete: boolean;
};

function toAffinityRecord(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n === 'number' && Number.isFinite(n)) out[k] = n;
  }
  return out;
}

function toPriceBand(raw: unknown): PriceBand | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const p25 = Number(r.p25);
  const p50 = Number(r.p50);
  const p75 = Number(r.p75);
  if (![p25, p50, p75].every(Number.isFinite)) return null;
  return { p25, p50, p75 };
}

/**
 * `viewer_profiles` has no auto-create trigger (confirmed against the
 * replica) — a brand-new anon id simply has no row, and that is the common
 * case, not a rare one. Missing row -> the all-empty profile, exactly the
 * "no signal yet" state `COLD_START_LANE_SHARES` exists for.
 */
async function loadViewerProfile(db: SupabaseClient, anonId: string): Promise<ViewerProfile> {
  const { data } = await db
    .from('viewer_profiles')
    .select('category_affinity, seller_affinity, hashtag_affinity, price_band, cold_start_complete')
    .eq('anon_id', anonId)
    .maybeSingle();

  const row = data as ViewerProfileRow | null;
  if (!row) return EMPTY_PROFILE;

  return {
    categoryAffinity: toAffinityRecord(row.category_affinity),
    sellerAffinity: toAffinityRecord(row.seller_affinity),
    hashtagAffinity: toAffinityRecord(row.hashtag_affinity),
    priceBand: toPriceBand(row.price_band),
    coldStartComplete: row.cold_start_complete === true,
  };
}

async function loadFollowedSellerIds(db: SupabaseClient, anonId: string): Promise<Set<string>> {
  const { data } = await db.from('follows').select('seller_id').eq('anon_id', anonId);
  return new Set((data ?? []).map((r) => r.seller_id as string));
}

type OrderItemRow = { video_id: string | null; product_id: string | null };
type OrderRow = {
  seller_id: string;
  video_id: string | null;
  created_at: string;
  order_items: OrderItemRow[] | null;
};

/**
 * Purchase history: which sellers this viewer has bought from, and — for the
 * 7-day re-suppression rule (spec 2.1) — whether each purchased video still
 * has products the viewer has NOT bought. A video is only suppressed while
 * there is genuinely nothing left on it to buy; `hasUnpurchasedItems` is what
 * lets the caller tell "already bought everything here" from "bought one of
 * five things, still worth showing again".
 *
 * The live product set for a video is not looked up here — that would need a
 * second round trip per video. Instead this returns the set of product ids
 * the viewer HAS bought per video; the caller (which already loads the pool's
 * live products) compares against that set at scoring time. Simpler than it
 * sounds: this function only ever needs to answer "did they buy this exact
 * set", and the pool already knows the video's current live products.
 */
async function loadPurchaseHistory(
  db: SupabaseClient,
  anonId: string
): Promise<{
  purchasedSellerIds: Set<string>;
  purchasesByVideoId: Map<string, ViewerVideoPurchase & { purchasedProductIds: Set<string> }>;
}> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = (await (db as any)
    .from('orders')
    .select('seller_id, video_id, created_at, order_items ( video_id, product_id )')
    .eq('buyer_anon_id', anonId)
    .in('status', COMMERCE_ORDER_STATUSES)) as { data: OrderRow[] | null };

  const purchasedSellerIds = new Set<string>();
  const byVideo = new Map<string, { purchasedAt: Date; purchasedProductIds: Set<string> }>();

  for (const order of data ?? []) {
    purchasedSellerIds.add(order.seller_id);
    const purchasedAt = new Date(order.created_at);

    for (const item of order.order_items ?? []) {
      // A video may be attached at the order level (order.video_id, the video
      // that drove the sale) or per-item (order_items.video_id) — an order
      // can bundle products discovered from different videos. Attribute the
      // purchase to whichever video id is actually known for this item.
      const videoId = item.video_id ?? order.video_id;
      if (!videoId || !item.product_id) continue;

      const existing = byVideo.get(videoId);
      if (existing) {
        if (purchasedAt > existing.purchasedAt) existing.purchasedAt = purchasedAt;
        existing.purchasedProductIds.add(item.product_id);
      } else {
        byVideo.set(videoId, { purchasedAt, purchasedProductIds: new Set([item.product_id]) });
      }
    }
  }

  const purchasesByVideoId = new Map<
    string,
    ViewerVideoPurchase & { purchasedProductIds: Set<string> }
  >();
  for (const [videoId, v] of byVideo) {
    purchasesByVideoId.set(videoId, {
      purchasedAt: v.purchasedAt,
      // Resolved properly against the video's live product set by the caller
      // (loadRankedFeedContext, once the pool is loaded); true here is a safe
      // starting default — "assume there might be more to buy" — since the
      // alternative (false) would wrongly suppress a video before anyone has
      // checked whether it still has anything unpurchased.
      hasUnpurchasedItems: true,
      purchasedProductIds: v.purchasedProductIds,
    });
  }

  return { purchasedSellerIds, purchasesByVideoId };
}

export async function loadViewerContext(
  db: SupabaseClient,
  opts: LoadViewerContextOptions
): Promise<ViewerContext> {
  const [profile, blocks, followedSellerIds, purchases] = await Promise.all([
    loadViewerProfile(db, opts.anonId),
    loadViewerBlocks(db, opts.anonId),
    loadFollowedSellerIds(db, opts.anonId),
    loadPurchaseHistory(db, opts.anonId),
  ]);

  return {
    viewerId: opts.anonId,
    profile,
    countryCode: opts.countryCode,
    excludeIds: opts.excludeIds,
    notInterestedVideoIds: blocks.blockedVideos,
    notInterestedSellerIds: blocks.blockedSellers,
    followedSellerIds,
    purchasedSellerIds: purchases.purchasedSellerIds,
    purchasesByVideoId: purchases.purchasesByVideoId,
  };
}

/**
 * Given the pool's live products for a video, resolve whether this viewer's
 * purchase there leaves anything unpurchased. Called after the pool loads
 * (Phase 2), since that is the only place the video's CURRENT live product
 * set is known — `loadPurchaseHistory` only knows what was bought, not what
 * is still for sale today.
 */
export function resolveUnpurchasedItems(
  purchasesByVideoId: ReadonlyMap<string, ViewerVideoPurchase & { purchasedProductIds: Set<string> }>,
  liveProductIdsByVideoId: ReadonlyMap<string, ReadonlySet<string>>
): Map<string, ViewerVideoPurchase> {
  const out = new Map<string, ViewerVideoPurchase>();
  for (const [videoId, purchase] of purchasesByVideoId) {
    const liveIds = liveProductIdsByVideoId.get(videoId);
    const hasUnpurchasedItems = liveIds
      ? [...liveIds].some((id) => !purchase.purchasedProductIds.has(id))
      : true;
    out.set(videoId, { purchasedAt: purchase.purchasedAt, hasUnpurchasedItems });
  }
  return out;
}
