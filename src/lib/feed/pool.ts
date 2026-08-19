import type { SupabaseClient } from '@supabase/supabase-js';
import type { PoolProduct, PoolSeller, PoolVideo, PoolVideoStatus } from '@/lib/scoring/candidates';
import { SHIPS_WORLDWIDE } from '@/lib/scoring/candidates';
import { IMPRESSION_BUDGET_TOTAL, IMPRESSION_BUDGET_WINDOW_HOURS } from '@/lib/scoring/types';
import { minSellablePriceCents, type ProductRow } from './products';

/**
 * The ranked feed's candidate pool. Extends `slice.ts`'s query — same base
 * filters (`status='live'`, seller `charges_enabled`), widened to also pull
 * `video_stats`, `seller_trust` and `categories.live_video_count`, which the
 * naive feed never needed. `slice.ts` itself is untouched: it stays the
 * permanent fallback path, so a bug here can never take down the only
 * feed that currently works.
 *
 * Two placeholders, confirmed with the user rather than guessed:
 *   - `seller.suspended` is always `false` — no such column exists anywhere
 *     in the schema yet.
 *   - `seller.shipsToCountries` is always `[SHIPS_WORLDWIDE]` — same reason.
 * Both are documented here as temporary; replace the moment real columns
 * exist. Filtering pretends nothing about either signal in the meantime,
 * which is why they default to "no restriction" rather than the fail-closed
 * empty array `PoolSeller.shipsToCountries` otherwise supports — a placeholder
 * that silently excluded every seller would be a worse bug than the one it
 * stands in for.
 */

export type LoadPoolOptions = {
  /** Caps the query at feed_weights.candidate_pool_size (default 500). */
  poolSize: number;
  categorySlug?: string | null;
  sellerHandle?: string | null;
  /** The single clock read for this request, threaded through for budget math. */
  now: Date;
};

type VideoStatsRow = {
  impressions_1h: number | string;
  impressions_24h: number | string;
  impressions_all: number | string;
  purchases_1h: number | string;
  purchases_24h: number | string;
  add_to_carts_1h: number | string;
  add_to_carts_24h: number | string;
  product_taps_1h: number | string;
  product_taps_24h: number | string;
  completions_24h: number | string;
  skips_under_2s_24h: number | string;
  shares_24h: number | string;
  saves_24h: number | string;
  avg_loop_count: number | string;
  reports_all: number | string;
  not_interested_all: number | string;
  gmv_cents_24h: number | string;
  exploration_impressions: number | string;
};

type SellerTrustRow = {
  fulfillment_score: number | string;
  dispute_rate: number | string;
  rating_avg: number | string | null;
  trust_tier: string;
};

type PoolVideoRow = {
  id: string;
  seller_id: string;
  category_id: string | null;
  published_at: string;
  hashtags: string[] | null;
  status: string;
  profiles: {
    seller_payments: { charges_enabled: boolean } | { charges_enabled: boolean }[] | null;
  } | null;
  categories: { live_video_count: number } | null;
  video_stats: VideoStatsRow | VideoStatsRow[];
  seller_trust: SellerTrustRow | SellerTrustRow[];
  video_products: ProductRow[] | null;
};

function n(v: number | string | null | undefined, fallback = 0): number {
  const parsed = typeof v === 'string' ? Number(v) : v;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : fallback;
}

/** to-one embeds come back as an object or a single-item array depending on
 *  how PostgREST negotiated the relationship; normalise both to one shape. */
function one<T>(v: T | T[] | null | undefined): T | null {
  if (!v) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

const TRUST_TIERS = new Set(['new', 'building', 'trusted', 'elite']);

function toCandidateTrust(row: SellerTrustRow | SellerTrustRow[] | null): PoolVideo['trust'] {
  const t = one(row);
  const tier = t && TRUST_TIERS.has(t.trust_tier) ? (t.trust_tier as PoolVideo['trust']['tier']) : 'new';
  return {
    fulfillmentScore: t ? n(t.fulfillment_score, 0.7) : 0.7,
    disputeRate: t ? n(t.dispute_rate, 0) : 0,
    ratingAvg: t && t.rating_avg !== null ? n(t.rating_avg) : null,
    tier,
  };
}

function toCandidateStats(row: VideoStatsRow | VideoStatsRow[] | null): PoolVideo['stats'] {
  const s = one(row);
  // No video_stats row yet (brand-new video, rollup hasn't run) -> all-zero.
  // The impression-budget guarantee, not the stats, is what carries a
  // stat-less video into the feed.
  if (!s) {
    return {
      impressions24h: 0, purchases24h: 0, addToCarts24h: 0, productTaps24h: 0,
      completions24h: 0, skipsUnder2s24h: 0, shares24h: 0, saves24h: 0,
      avgLoopCount: 0, reportsAll: 0, notInterestedAll: 0, impressionsAll: 0,
      impressions1h: 0, purchases1h: 0, addToCarts1h: 0, productTaps1h: 0,
    };
  }
  return {
    impressions24h: n(s.impressions_24h),
    purchases24h: n(s.purchases_24h),
    addToCarts24h: n(s.add_to_carts_24h),
    productTaps24h: n(s.product_taps_24h),
    completions24h: n(s.completions_24h),
    skipsUnder2s24h: n(s.skips_under_2s_24h),
    shares24h: n(s.shares_24h),
    saves24h: n(s.saves_24h),
    avgLoopCount: n(s.avg_loop_count),
    reportsAll: n(s.reports_all),
    notInterestedAll: n(s.not_interested_all),
    impressionsAll: n(s.impressions_all),
    impressions1h: n(s.impressions_1h),
    purchases1h: n(s.purchases_1h),
    addToCarts1h: n(s.add_to_carts_1h),
    productTaps1h: n(s.product_taps_1h),
  };
}

/**
 * A video's guaranteed-impressions state, derived at read time. No column
 * stores "satisfied" — it is `exploration_impressions >= 500` OR the 48h
 * window has closed, matching the pure `budgetOwed` helper's own contract of
 * taking `now` explicitly rather than reading a clock.
 */
function toImpressionBudget(
  statsRow: VideoStatsRow | VideoStatsRow[] | null,
  publishedAt: Date,
  now: Date
): PoolVideo['budget'] {
  const s = one(statsRow);
  const delivered = s ? n(s.exploration_impressions) : 0;
  const windowClosed =
    now.getTime() - publishedAt.getTime() > IMPRESSION_BUDGET_WINDOW_HOURS * 3_600_000;
  return {
    impressionsDelivered: delivered,
    budgetTotal: IMPRESSION_BUDGET_TOTAL,
    windowStart: publishedAt,
    satisfied: delivered >= IMPRESSION_BUDGET_TOTAL || windowClosed,
  };
}

function toPoolSeller(sellerId: string): PoolSeller {
  return {
    sellerId,
    // Placeholders — see the file header. Neither column exists yet.
    suspended: false,
    chargesEnabled: true, // the query's !inner join already guarantees this
    shipsToCountries: [SHIPS_WORLDWIDE],
  };
}

function toPoolProducts(rows: readonly ProductRow[] | null): PoolProduct[] {
  return (rows ?? [])
    .filter((r) => r.products !== null)
    .map((r) => ({
      productId: r.products!.id,
      status: (r.products!.status as PoolProduct['status']) ?? 'archived',
      inventoryCount: r.products!.inventory_count,
    }));
}

export async function loadPool(db: SupabaseClient, opts: LoadPoolOptions): Promise<PoolVideo[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query: any = db
    .from('videos')
    .select(`
      id, seller_id, category_id, published_at, hashtags, status,
      profiles!inner ( seller_payments!inner ( charges_enabled ) ),
      categories ( live_video_count ),
      video_stats ( impressions_1h, impressions_24h, impressions_all,
        purchases_1h, purchases_24h, add_to_carts_1h, add_to_carts_24h,
        product_taps_1h, product_taps_24h, completions_24h,
        skips_under_2s_24h, shares_24h, saves_24h, avg_loop_count,
        reports_all, not_interested_all, gmv_cents_24h, exploration_impressions ),
      seller_trust ( fulfillment_score, dispute_rate, rating_avg, trust_tier ),
      video_products ( position, pinned_at_second,
        products ( id, title, price_cents, compare_at_price_cents, inventory_count,
                   low_stock_threshold, images, variants, status ) )
    `)
    .eq('status', 'live')
    .eq('profiles.seller_payments.charges_enabled', true)
    .not('published_at', 'is', null)
    .order('published_at', { ascending: false })
    .limit(Math.max(1, opts.poolSize));

  if (opts.categorySlug) query = query.eq('categories.slug', opts.categorySlug);
  if (opts.sellerHandle) query = query.eq('profiles.handle', opts.sellerHandle);

  const { data, error } = (await query) as { data: PoolVideoRow[] | null; error: { message: string } | null };
  if (error) throw new Error(`pool query failed: ${error.message}`);

  const out: PoolVideo[] = [];
  for (const v of data ?? []) {
    const minPriceCents = minSellablePriceCents(v.video_products);
    // No sellable product -> not a candidate at all, same rule slice.ts uses.
    if (minPriceCents === null) continue;

    const publishedAt = new Date(v.published_at);
    out.push({
      videoId: v.id,
      sellerId: v.seller_id,
      categoryId: v.category_id,
      publishedAt,
      minPriceCents,
      hashtags: v.hashtags ?? [],
      stats: toCandidateStats(v.video_stats),
      trust: toCandidateTrust(v.seller_trust),
      budget: toImpressionBudget(v.video_stats, publishedAt, opts.now),
      status: v.status as PoolVideoStatus,
      seller: toPoolSeller(v.seller_id),
      products: toPoolProducts(v.video_products),
      revenueCents24h: n(one(v.video_stats)?.gmv_cents_24h, 0),
      categoryLiveCount: v.categories?.live_video_count,
    });
  }
  return out;
}
