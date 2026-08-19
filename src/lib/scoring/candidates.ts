// Spec 2.1 — CANDIDATE GENERATION, and spec 2.5's impression guarantee.
//
// PURE AND DB-FREE, on purpose and non-negotiably. This module takes an
// in-memory pool plus a viewer context and returns the lane-allocated, deduped
// candidate set. It never opens a connection, never reads a clock, never calls
// Math.random.
//
// The reason is the spec's own: "unit tests pass on logic that is still
// catastrophically wrong at scale — only simulation surfaces it." A module that
// needs Postgres cannot be driven by the offline simulation harness, and a
// module that reads a global clock or a global RNG cannot be replayed
// byte-for-byte. So the SQL-shaped hard filters are expressed here as pure
// predicates over a projected row (`PoolVideo`), each one individually
// testable, and a later step wires the same predicates to real queries. The
// predicate is the specification; the WHERE clause is an optimisation of it.
//
// Determinism (contract 1): `now: Date` and `rng: Rng` are always explicit
// parameters. Every ordering is a total order — score/rate first, videoId
// ascending as the final tie-break — so a result never depends on the order the
// caller happened to hand us the pool in.

import { safeRate } from './normalize';
import type { Rng } from './rng';
import {
  IMPRESSION_BUDGET_TOTAL,
  IMPRESSION_BUDGET_WINDOW_HOURS,
  LANES,
  type Candidate,
  type CandidateLane,
  type ImpressionBudget,
  type LaneShares,
  type PriceBand,
  type ViewerProfile,
} from './types';
import { velocityScore } from './velocity';

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

// ---------------------------------------------------------------------------
// Lane shares
// ---------------------------------------------------------------------------

/**
 * Spec 2.1. Five sources run in parallel, their results are unioned and
 * deduped, and the union is trimmed to ~500 candidates in these proportions.
 *
 * Exported and tunable rather than inlined because the simulation harness
 * sweeps them: the whole point of a reproducible simulation is being able to
 * ask "what happens at 30/30/20/10/10" and get a comparable answer.
 */
export const LANE_SHARES: LaneShares = {
  affinity: 0.35,
  trending: 0.25,
  fresh: 0.2,
  social: 0.1,
  tail: 0.1,
};

/**
 * A viewer with `coldStartComplete === false`. Spec: "You have no signal —
 * don't pretend."
 *
 * Affinity is zero because there is no affinity to read, and social is zero
 * because a viewer with no signal has no follows and no purchase history
 * either — a social lane here would be a lane over an empty set dressed up as
 * personalisation. The remaining 100% goes 40 trending / 30 fresh / 30 tail.
 *
 * A zero share is not merely "fills last". It DISABLES the lane: a disabled
 * lane is skipped by the quota fill AND by backfill, so it cannot receive
 * candidates through the back door when another lane runs dry. That is what
 * makes "don't pretend" structural instead of aspirational, and it is what
 * `byLane.affinity.length === 0` asserts in the tests.
 */
export const COLD_START_LANE_SHARES: LaneShares = {
  affinity: 0,
  trending: 0.4,
  fresh: 0.3,
  social: 0,
  tail: 0.3,
};

/**
 * DEDUPE PRIORITY. A video that qualifies for two lanes keeps the assignment
 * from the lane listed EARLIEST here, and the fill loop below runs in exactly
 * this order so dedupe is not a separate pass that can disagree with it.
 *
 * The ordering rule is: how irreplaceable is this video WITHIN this lane?
 *
 *   fresh     Irreplaceable. The lane carries spec 2.5's 500-impression
 *             guarantee, and the guarantee is attached to a specific video.
 *             The selector reserves its floor slots by `lane === 'fresh'`
 *             (see select.ts), so relabelling a budget-owed video as
 *             'trending' does not move it to a different queue — it silently
 *             deletes its delivery. This is why fresh must outrank tail, and
 *             in fact everything.
 *   social    Narrowest eligible set: sellers this viewer explicitly follows
 *             or has bought from, in 14 days. There is usually no second video
 *             that could stand in for it, and the lane only has a 10% share to
 *             begin with.
 *   affinity  Viewer-specific, but drawn from three whole categories over 30
 *             days — a big set, easy to refill from.
 *   trending  Global. Every viewer sees the same eligible set, so anything
 *             taken from it is replaced by the next item down.
 *   tail      Last by definition: it is the residual lane, sampled uniformly
 *             from 90 days of catalogue. It has the widest eligible set of
 *             all, so promoting a video OUT of tail costs nothing, while
 *             demoting one INTO tail throws away a real reason to show it.
 *
 * Read it as scarcity descending. Nothing here is about lane size: affinity is
 * the largest share and still loses to social, because share size says how many
 * slots to fill, not how hard a particular slot is to fill.
 */
export const LANE_PRIORITY = ['fresh', 'social', 'affinity', 'trending', 'tail'] as const satisfies
  readonly CandidateLane[];

/** Lower rank wins a dedupe contest. */
export function lanePriorityRank(lane: CandidateLane): number {
  const i = LANE_PRIORITY.indexOf(lane as (typeof LANE_PRIORITY)[number]);
  return i === -1 ? LANE_PRIORITY.length : i;
}

/** Which of two lane assignments survives dedupe. */
export function higherPriorityLane(a: CandidateLane, b: CandidateLane): CandidateLane {
  return lanePriorityRank(a) <= lanePriorityRank(b) ? a : b;
}

// ---------------------------------------------------------------------------
// Lane windows and tuning
// ---------------------------------------------------------------------------

/** Affinity lane: top-N affinity categories. */
export const AFFINITY_TOP_CATEGORIES = 3;
/** Affinity lane: price within the viewer's band +/- 40%. */
export const AFFINITY_PRICE_TOLERANCE = 0.4;
/** Affinity lane: published in the last 30 days. */
export const AFFINITY_WINDOW_DAYS = 30;
/** Fresh lane: published in the last 48 hours (same window as the guarantee). */
export const FRESH_WINDOW_HOURS = IMPRESSION_BUDGET_WINDOW_HOURS;
/** Fresh lane: fewer than 500 lifetime impressions (same size as the guarantee). */
export const FRESH_IMPRESSION_LIMIT = IMPRESSION_BUDGET_TOTAL;
/** Social lane: followed / purchased-from sellers, last 14 days. */
export const SOCIAL_WINDOW_DAYS = 14;
/** Tail lane: uniform sample from the last 90 days. */
export const TAIL_WINDOW_DAYS = 90;
/** Hard filter: suppress a video bought from in the last 7 days. */
export const RECENT_PURCHASE_WINDOW_DAYS = 7;
/** Spec 2.5: a category with fewer live videos than this is "thin". */
export const THIN_CATEGORY_THRESHOLD = 50;
/** Spec 2.5: freshness multiplier applied to sellers in a thin category. */
export const THIN_CATEGORY_MULTIPLIER = 1.2;
/** Spec 2.1: "~500 candidates". */
export const DEFAULT_TARGET_SIZE = 500;

// ---------------------------------------------------------------------------
// The projected row
// ---------------------------------------------------------------------------

/** Mirrors public.video_status. */
export type PoolVideoStatus = 'processing' | 'live' | 'paused' | 'removed';

/** Mirrors public.product_status. */
export type PoolProductStatus = 'active' | 'out_of_stock' | 'archived';

/** One attached product, projected down to what the hard filters read. */
export type PoolProduct = {
  productId: string;
  status: PoolProductStatus;
  inventoryCount: number;
};

/** The seller row, projected down to what the hard filters read. */
export type PoolSeller = {
  sellerId: string;
  suspended: boolean;
  chargesEnabled: boolean;
  /**
   * ISO-3166 alpha-2 codes this seller ships to. The single entry
   * `SHIPS_WORLDWIDE` ('*') means no restriction. An EMPTY array means the
   * seller ships nowhere and every video of theirs is filtered out — that is
   * deliberate, not a bug: a missing shipping configuration must fail closed,
   * because the alternative is selling to a buyer you cannot deliver to.
   */
  shipsToCountries: readonly string[];
};

export const SHIPS_WORLDWIDE = '*';

/**
 * A candidate as it comes out of the candidate query, before a lane is
 * assigned. This is the projection the SQL would return; `hardFilters` is the
 * WHERE clause, written as functions.
 *
 * It is `Candidate` minus `lane` plus the filterable columns, so the generated
 * output is structurally a `Candidate` and drops straight into scoring.
 */
export type PoolVideo = Omit<Candidate, 'lane'> & {
  /** Ignored on input — `generateCandidates` assigns the real lane. */
  lane?: CandidateLane;
  status: PoolVideoStatus;
  seller: PoolSeller;
  products: readonly PoolProduct[];
  /**
   * Gross merchandise value in the last 24h, if the caller has it. The
   * affinity lane orders by revenue-per-impression; when this is absent it is
   * estimated as `purchases24h * minPriceCents` — an underestimate for
   * multi-item orders, and documented as such so nobody reads the ordering as
   * exact accounting.
   */
  revenueCents24h?: number;
  /**
   * Live videos in this video's category, for `thinCategoryMultiplier`. Not
   * used for filtering — it is a per-category aggregate the caller loads once.
   */
  categoryLiveCount?: number;
};

/** A pool video with its lane decided. Structurally a `Candidate`. */
export type GeneratedCandidate = PoolVideo & { lane: CandidateLane };

// ---------------------------------------------------------------------------
// The viewer context
// ---------------------------------------------------------------------------

/** What this viewer has already bought from one specific video. */
export type ViewerVideoPurchase = {
  purchasedAt: Date;
  /**
   * True when the video still attaches products this viewer has NOT bought.
   * Spec 2.1's escape hatch: a video is only suppressed for 7 days if there is
   * nothing left on it to buy.
   */
  hasUnpurchasedItems: boolean;
};

/**
 * Everything the hard filters and the lane sources need about the viewer. All
 * of it is data the caller loads; nothing here is fetched.
 */
export type ViewerContext = {
  viewerId: string;
  profile: ViewerProfile;
  /** ISO-3166 alpha-2, e.g. 'US'. Compared case-insensitively. */
  countryCode: string;
  /** Already-served video ids the client is asking us to skip. */
  excludeIds?: ReadonlySet<string>;
  /** `not_interested` on the video itself (permanent). */
  notInterestedVideoIds?: ReadonlySet<string>;
  /** `not_interested` on the seller (30 days — the caller filters by expiry). */
  notInterestedSellerIds?: ReadonlySet<string>;
  /** Social lane source: sellers this viewer follows. */
  followedSellerIds?: ReadonlySet<string>;
  /** Social lane source: sellers this viewer has bought from. */
  purchasedSellerIds?: ReadonlySet<string>;
  /** videoId -> this viewer's purchase from that video, for the 7-day rule. */
  purchasesByVideoId?: ReadonlyMap<string, ViewerVideoPurchase>;
};

const EMPTY_SET: ReadonlySet<string> = new Set<string>();
const EMPTY_MAP: ReadonlyMap<string, ViewerVideoPurchase> = new Map();

// ---------------------------------------------------------------------------
// Hard filters (spec 2.1) — "applied at query time, always"
// ---------------------------------------------------------------------------

export type HardFilterId =
  | 'status_live'
  | 'purchasable_product'
  | 'seller_payable'
  | 'not_excluded'
  | 'not_interested'
  | 'ships_to_viewer'
  | 'not_recently_purchased';

/**
 * Every predicate returns TRUE TO KEEP, matching the sense of a SQL WHERE
 * clause. They take `now` explicitly (contract 1) rather than reading a clock,
 * which is why the exported `hardFilters` has a third parameter the task
 * sketch did not: only `not_recently_purchased` needs it, but a filter list
 * whose members have different arities is a filter list nobody can compose.
 */
export type HardFilterFn = (v: PoolVideo, ctx: ViewerContext, now: Date) => boolean;

/** `status = 'live'`. */
export const isLive: HardFilterFn = (v) => v.status === 'live';

/**
 * `EXISTS (SELECT 1 FROM products p ... WHERE p.status = 'active' AND
 *  p.inventory_count > 0)`. A video with nothing buyable on it is not a
 * commerce candidate, whatever it scores.
 */
export const hasPurchasableProduct: HardFilterFn = (v) =>
  v.products.some((p) => p.status === 'active' && p.inventoryCount > 0);

/** Seller not suspended AND `charges_enabled` — we cannot take the money otherwise. */
export const sellerIsPayable: HardFilterFn = (v) => !v.seller.suspended && v.seller.chargesEnabled;

/** `id <> ALL(exclude_ids)` — what the client has already been served. */
export const notExcluded: HardFilterFn = (v, ctx) => !(ctx.excludeIds ?? EMPTY_SET).has(v.videoId);

/**
 * No `not_interested` from this viewer on the video OR on its seller. Two
 * lookups, one filter: the spec states them as one rule and separating them
 * invites a caller to apply half of it.
 */
export const notMarkedNotInterested: HardFilterFn = (v, ctx) =>
  !(ctx.notInterestedVideoIds ?? EMPTY_SET).has(v.videoId) &&
  !(ctx.notInterestedSellerIds ?? EMPTY_SET).has(v.sellerId);

/** Seller ships to the viewer's country (or ships worldwide). Fails closed. */
export const shipsToViewer: HardFilterFn = (v, ctx) => {
  const to = v.seller.shipsToCountries;
  if (to.length === 0) return false;
  const want = ctx.countryCode.trim().toUpperCase();
  if (want === '') return false;
  for (const c of to) {
    if (c === SHIPS_WORLDWIDE) return true;
    if (c.trim().toUpperCase() === want) return true;
  }
  return false;
};

/**
 * Not purchased from by this viewer in 7 days — UNLESS the video still has
 * items they have not bought, in which case it stays eligible. Showing someone
 * the video they just bought from is the single most obvious way to look
 * broken; showing them the one where they bought one of three products is a
 * cross-sell.
 */
export const notRecentlyPurchased: HardFilterFn = (v, ctx, now) => {
  const p = (ctx.purchasesByVideoId ?? EMPTY_MAP).get(v.videoId);
  if (!p) return true;
  if (p.hasUnpurchasedItems) return true;
  const ageMs = now.getTime() - p.purchasedAt.getTime();
  return ageMs >= RECENT_PURCHASE_WINDOW_DAYS * MS_PER_DAY;
};

export type HardFilter = {
  id: HardFilterId;
  /** The SQL this predicate stands in for, so the two can be diffed by eye. */
  sql: string;
  keep: HardFilterFn;
};

/** Applied in order; the first failure short-circuits. */
export const HARD_FILTERS: readonly HardFilter[] = [
  { id: 'status_live', sql: "v.status = 'live'", keep: isLive },
  {
    id: 'purchasable_product',
    sql: "EXISTS (SELECT 1 FROM video_products vp JOIN products p ON p.id = vp.product_id WHERE vp.video_id = v.id AND p.status = 'active' AND p.inventory_count > 0)",
    keep: hasPurchasableProduct,
  },
  {
    id: 'seller_payable',
    sql: 's.suspended IS NOT TRUE AND s.charges_enabled',
    keep: sellerIsPayable,
  },
  { id: 'not_excluded', sql: 'v.id <> ALL($exclude_ids)', keep: notExcluded },
  {
    id: 'not_interested',
    sql: "NOT EXISTS (SELECT 1 FROM viewer_blocks b WHERE b.anon_id = $viewer AND ((b.subject_type = 'video' AND b.subject_id = v.id) OR (b.subject_type = 'seller' AND b.subject_id = v.seller_id)))",
    keep: notMarkedNotInterested,
  },
  {
    id: 'ships_to_viewer',
    sql: "s.ships_to_countries && ARRAY[$country, '*']",
    keep: shipsToViewer,
  },
  {
    id: 'not_recently_purchased',
    sql: "NOT EXISTS (SELECT 1 FROM orders o WHERE o.buyer = $viewer AND o.video_id = v.id AND o.created_at > now() - interval '7 days' AND NOT o.has_unpurchased_items)",
    keep: notRecentlyPurchased,
  },
];

/**
 * Which filter rejects this video, or null if it survives. Exported for the
 * simulation harness: "the pool was empty" is unactionable, "83% of the pool
 * died on ships_to_viewer" is a bug report.
 */
export function firstFailingFilter(
  v: PoolVideo,
  ctx: ViewerContext,
  now: Date
): HardFilterId | null {
  for (const f of HARD_FILTERS) if (!f.keep(v, ctx, now)) return f.id;
  return null;
}

/** The whole WHERE clause. Preserves input order; dedupes by videoId. */
export function hardFilters(
  pool: readonly PoolVideo[],
  ctx: ViewerContext,
  now: Date
): PoolVideo[] {
  const seen = new Set<string>();
  const out: PoolVideo[] = [];
  for (const v of pool) {
    if (seen.has(v.videoId)) continue;
    if (firstFailingFilter(v, ctx, now) !== null) continue;
    seen.add(v.videoId);
    out.push(v);
  }
  return out;
}

/** Per-filter survivor counts. Diagnostics for the simulation harness. */
export function filterBreakdown(
  pool: readonly PoolVideo[],
  ctx: ViewerContext,
  now: Date
): Record<HardFilterId | 'kept', number> {
  const counts = {
    status_live: 0,
    purchasable_product: 0,
    seller_payable: 0,
    not_excluded: 0,
    not_interested: 0,
    ships_to_viewer: 0,
    not_recently_purchased: 0,
    kept: 0,
  } satisfies Record<HardFilterId | 'kept', number>;
  for (const v of pool) {
    const failed = firstFailingFilter(v, ctx, now);
    if (failed === null) counts.kept += 1;
    else counts[failed] += 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Spec 2.5 — the impression guarantee and thin categories
// ---------------------------------------------------------------------------

/**
 * Is this video still owed guaranteed impressions? Spec 2.5: every new video
 * gets 500 impressions over 48 hours, through the fresh lane, REGARDLESS OF
 * SCORE.
 *
 * The guarantee is the only reason a brand-new video is ever shown at all. The
 * evidence gate correctly refuses to believe a rate measured over three
 * impressions, so without a floor nothing would ever accumulate the evidence
 * needed to earn its way in — the ranker would be a perfect closed loop over
 * whatever was already popular.
 *
 * `now` is required here, unlike select.ts's equivalent `isBudgetOwed` where it
 * is optional: at generation time the window boundary is the whole question, so
 * making the clock skippable would let a caller keep re-admitting a video whose
 * 48 hours ran out weeks ago.
 */
export function budgetOwed(video: { budget?: ImpressionBudget | null }, now: Date): boolean {
  const b = video.budget;
  if (!b) return false;
  if (b.satisfied) return false;
  if (!(b.impressionsDelivered < b.budgetTotal)) return false;
  const endsAt = b.windowStart.getTime() + IMPRESSION_BUDGET_WINDOW_HOURS * MS_PER_HOUR;
  return now.getTime() <= endsAt;
}

/** Impressions still owed under the guarantee; 0 when nothing is owed. */
export function budgetRemaining(video: { budget?: ImpressionBudget | null }, now: Date): number {
  if (!budgetOwed(video, now)) return 0;
  const b = video.budget as ImpressionBudget;
  return Math.max(0, b.budgetTotal - b.impressionsDelivered);
}

/**
 * Spec 2.5: sellers in categories with fewer than 50 live videos get a 1.2x
 * freshness multiplier.
 *
 * The boundary is exclusive: 49 live videos is thin, 50 is not. A category with
 * no data at all (0, or a count the caller could not load) is thin — that is
 * the most under-supplied case there is, and defaulting it to 1.0 would deny
 * the boost exactly where the spec most wants it.
 */
export function thinCategoryMultiplier(categoryLiveCount: number | null | undefined): number {
  if (typeof categoryLiveCount !== 'number' || !Number.isFinite(categoryLiveCount)) {
    return THIN_CATEGORY_MULTIPLIER;
  }
  return categoryLiveCount < THIN_CATEGORY_THRESHOLD ? THIN_CATEGORY_MULTIPLIER : 1;
}

// ---------------------------------------------------------------------------
// Lane sources
// ---------------------------------------------------------------------------

/** Cents of GMV per impression over 24h. The affinity lane's ordering key. */
export function revenuePerImpression(v: PoolVideo): number {
  const revenue =
    typeof v.revenueCents24h === 'number' && Number.isFinite(v.revenueCents24h)
      ? Math.max(0, v.revenueCents24h)
      : Math.max(0, v.stats.purchases24h) * Math.max(0, v.minPriceCents);
  return safeRate(revenue, v.stats.impressions24h);
}

/** Total order: `key` descending, then videoId ascending. Never depends on input order. */
function byKeyDesc(key: (v: PoolVideo) => number) {
  return (a: PoolVideo, b: PoolVideo): number => {
    const ka = key(a);
    const kb = key(b);
    const fa = Number.isFinite(ka) ? ka : -Infinity;
    const fb = Number.isFinite(kb) ? kb : -Infinity;
    if (fa !== fb) return fb - fa;
    return a.videoId < b.videoId ? -1 : a.videoId > b.videoId ? 1 : 0;
  };
}

function publishedWithin(v: PoolVideo, now: Date, ms: number): boolean {
  const age = now.getTime() - v.publishedAt.getTime();
  return age >= 0 ? age <= ms : true; // a future publishedAt is still "recent"
}

/**
 * The viewer's top N affinity categories, strongest first. Ties break on
 * categoryId ascending so two categories at the same weight do not reorder
 * between runs. Non-positive weights are not affinity and are dropped.
 */
export function topAffinityCategories(
  profile: ViewerProfile,
  n: number = AFFINITY_TOP_CATEGORIES
): string[] {
  return Object.entries(profile.categoryAffinity)
    .filter(([, w]) => Number.isFinite(w) && w > 0)
    .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, Math.max(0, n))
    .map(([id]) => id);
}

/**
 * The affinity lane's price window: the viewer's observed band widened by 40%
 * on each side. p25 and p75 are the band's edges, so the window is
 * [p25 * 0.6, p75 * 1.4] — widening the EDGES rather than the median, because
 * a viewer whose purchases span $20-$80 is not well described by "$50 +/- 40%".
 * A viewer with no band yet has no price restriction at all.
 */
export function priceWindow(
  band: PriceBand | null,
  tolerance: number = AFFINITY_PRICE_TOLERANCE
): { minCents: number; maxCents: number } | null {
  if (!band) return null;
  const lo = Math.min(band.p25, band.p75);
  const hi = Math.max(band.p25, band.p75);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  return { minCents: Math.max(0, lo * (1 - tolerance)), maxCents: hi * (1 + tolerance) };
}

/**
 * affinity — top 3 affinity categories, price within band +/-40%, last 30d,
 * ordered by revenue-per-impression.
 */
export function affinityLane(pool: readonly PoolVideo[], ctx: ViewerContext, now: Date): PoolVideo[] {
  const cats = new Set(topAffinityCategories(ctx.profile));
  if (cats.size === 0) return [];
  const window = priceWindow(ctx.profile.priceBand);
  const maxAge = AFFINITY_WINDOW_DAYS * MS_PER_DAY;
  return pool
    .filter(
      (v) =>
        v.categoryId !== null &&
        cats.has(v.categoryId) &&
        publishedWithin(v, now, maxAge) &&
        (window === null ||
          (v.minPriceCents >= window.minCents && v.minPriceCents <= window.maxCents))
    )
    .sort(byKeyDesc(revenuePerImpression));
}

/**
 * trending — global top by velocity score.
 *
 * Naming note, because it will otherwise be read as a bug: the spec calls this
 * "24h velocity" while `velocityScore` reads the 1h counters. velocity.ts is
 * declared correct and is not mine to change, so the lane uses it as-is. The 1h
 * window is arguably the better choice anyway — "trending" that lags by a day
 * is not trending — but the discrepancy is real and belongs on the record.
 */
export function trendingLane(pool: readonly PoolVideo[]): PoolVideo[] {
  return pool.filter((v) => velocityScore(v.stats) > 0).sort(byKeyDesc((v) => velocityScore(v.stats)));
}

/**
 * fresh — published in the last 48h with fewer than 500 lifetime impressions.
 * The cold-start lane, and the channel spec 2.5's guarantee is delivered
 * through.
 *
 * Ordered by fewest impressions first, then newest: this lane's job is
 * delivery, not ranking, so the video furthest from its guarantee goes first.
 * Budget-owed videos are NOT ordered here — they are admitted ahead of this
 * list entirely, by `generateCandidates`, since a video can be owed impressions
 * while failing this lane's own criteria.
 */
export function freshLane(pool: readonly PoolVideo[], now: Date): PoolVideo[] {
  const maxAge = FRESH_WINDOW_HOURS * MS_PER_HOUR;
  return pool
    .filter((v) => publishedWithin(v, now, maxAge) && v.stats.impressionsAll < FRESH_IMPRESSION_LIMIT)
    .sort((a, b) => {
      if (a.stats.impressionsAll !== b.stats.impressionsAll) {
        return a.stats.impressionsAll - b.stats.impressionsAll;
      }
      const pa = a.publishedAt.getTime();
      const pb = b.publishedAt.getTime();
      if (pa !== pb) return pb - pa;
      return a.videoId < b.videoId ? -1 : a.videoId > b.videoId ? 1 : 0;
    });
}

/** social — followed or previously-purchased-from sellers, last 14 days. */
export function socialLane(pool: readonly PoolVideo[], ctx: ViewerContext, now: Date): PoolVideo[] {
  const followed = ctx.followedSellerIds ?? EMPTY_SET;
  const bought = ctx.purchasedSellerIds ?? EMPTY_SET;
  if (followed.size === 0 && bought.size === 0) return [];
  const maxAge = SOCIAL_WINDOW_DAYS * MS_PER_DAY;
  return pool
    .filter(
      (v) => (followed.has(v.sellerId) || bought.has(v.sellerId)) && publishedWithin(v, now, maxAge)
    )
    .sort(byKeyDesc((v) => ctx.profile.sellerAffinity[v.sellerId] ?? 0));
}

/**
 * tail — uniform random from live videos in the last 90 days.
 *
 * Returns the eligible set fully shuffled rather than a k-sized sample, because
 * the fill loop has to skip videos already claimed by a higher-priority lane;
 * sampling k up front would silently under-deliver the lane by however many of
 * those k were already taken.
 *
 * The shuffle runs over a videoId-sorted copy so the permutation is a function
 * of (eligible set, rng seed) alone — not of the order the caller built the
 * pool in. That is what makes a simulation run replayable.
 */
export function tailLane(pool: readonly PoolVideo[], now: Date, rng: Rng): PoolVideo[] {
  const maxAge = TAIL_WINDOW_DAYS * MS_PER_DAY;
  const eligible = pool
    .filter((v) => publishedWithin(v, now, maxAge))
    .sort((a, b) => (a.videoId < b.videoId ? -1 : a.videoId > b.videoId ? 1 : 0));
  // Fisher-Yates, drawing from the explicit Rng. Never Math.random.
  for (let i = eligible.length - 1; i > 0; i--) {
    const r = rng();
    const j = Math.min(i, Math.max(0, Math.floor((Number.isFinite(r) ? r : 0) * (i + 1))));
    const tmp = eligible[i];
    eligible[i] = eligible[j];
    eligible[j] = tmp;
  }
  return eligible;
}

// ---------------------------------------------------------------------------
// Quota allocation
// ---------------------------------------------------------------------------

/**
 * Largest-remainder apportionment of `total` across the lane shares, so the
 * quotas sum to exactly `total` instead of to 499 or 501 after rounding.
 *
 * A lane with a non-positive share gets exactly zero and is never eligible for
 * a remainder unit — see COLD_START_LANE_SHARES: zero means disabled, not
 * "rounds to nothing".
 */
export function allocateQuotas(shares: LaneShares, total: number): Record<CandidateLane, number> {
  const out = { affinity: 0, trending: 0, fresh: 0, social: 0, tail: 0 } as Record<
    CandidateLane,
    number
  >;
  if (!Number.isFinite(total) || total <= 0) return out;
  const active = LANES.filter((l) => Number.isFinite(shares[l]) && shares[l] > 0);
  const sum = active.reduce((acc, l) => acc + shares[l], 0);
  if (active.length === 0 || sum <= 0) return out;

  const frac: { lane: CandidateLane; f: number }[] = [];
  let assigned = 0;
  for (const lane of active) {
    const exact = (shares[lane] / sum) * total;
    const floor = Math.floor(exact);
    out[lane] = floor;
    assigned += floor;
    frac.push({ lane, f: exact - floor });
  }
  frac.sort((a, b) =>
    b.f !== a.f ? b.f - a.f : lanePriorityRank(a.lane) - lanePriorityRank(b.lane)
  );
  let remainder = Math.floor(total) - assigned;
  for (let i = 0; remainder > 0 && i < frac.length; i++, remainder--) out[frac[i].lane] += 1;
  return out;
}

// ---------------------------------------------------------------------------
// generateCandidates
// ---------------------------------------------------------------------------

export type GenerateOptions = {
  /** Required. Determinism is the contract — no Math.random in this module. */
  rng: Rng;
  /** Required. Determinism is the contract — no Date.now() in this module. */
  now: Date;
  /** Default 500. */
  targetSize?: number;
  /** Override the warm-viewer table. Default LANE_SHARES. */
  laneShares?: LaneShares;
  /** Override the cold-start table. Default COLD_START_LANE_SHARES. */
  coldStartLaneShares?: LaneShares;
};

export type GenerateResult = {
  /** The union, deduped, in lane-priority order then lane order. */
  candidates: GeneratedCandidate[];
  byLane: Record<CandidateLane, GeneratedCandidate[]>;
  /** Which share table was used — the cold-start branch is not silent. */
  shares: LaneShares;
  coldStart: boolean;
  /**
   * Quotas actually used: apportioned against min(targetSize, eligibleCount),
   * then reduced by the guarantee. Diagnostics — they will not match
   * `shares * targetSize` on a thin pool, and that is the point.
   */
  quotas: Record<CandidateLane, number>;
  /** Videos admitted by spec 2.5's guarantee rather than by lane eligibility. */
  guaranteedVideoIds: string[];
  /** Pool size after the hard filters, before lane allocation. */
  eligibleCount: number;
};

function emptyByLane(): Record<CandidateLane, GeneratedCandidate[]> {
  return { affinity: [], trending: [], fresh: [], social: [], tail: [] };
}

/**
 * Spec 2.1's five sources, unioned, deduped, trimmed to ~500.
 *
 * The order of operations is load-bearing:
 *
 *   1. hard filters              — nothing downstream can resurrect a filtered video
 *   2. spec 2.5's guarantee      — admitted to `fresh` before any quota is spent
 *   3. quota fill in LANE_PRIORITY order — which IS the dedupe rule, not a
 *                                  separate pass that could disagree with it
 *   4. backfill, round-robin     — only when a lane ran dry
 *
 * Step 3 is the whole dedupe story: lanes claim in priority order and a claimed
 * videoId is invisible to every later lane, so a video that qualifies for both
 * fresh and tail is a fresh candidate and there is no code path that can decide
 * otherwise. Backfill iterates the same order, so priority holds in both
 * phases.
 *
 * Precisely, the dedupe rule is "the highest-priority lane that qualifies AND
 * HAS CAPACITY". The capacity half only bites when a lane is over-subscribed —
 * 100 videos that are both social- and affinity-eligible cannot all be social,
 * because social's share is 10% — and in that case the surplus falls to the
 * next-priority lane that wants it rather than being dropped. Priority decides
 * who wins a contested video; the quota decides how many contests a lane can
 * enter.
 */
export function generateCandidates(
  pool: readonly PoolVideo[],
  viewer: ViewerContext,
  opts: GenerateOptions
): GenerateResult {
  const { rng, now } = opts;
  const targetSize = Math.max(
    0,
    Math.floor(
      typeof opts.targetSize === 'number' && Number.isFinite(opts.targetSize)
        ? opts.targetSize
        : DEFAULT_TARGET_SIZE
    )
  );
  const coldStart = !viewer.profile.coldStartComplete;
  const shares = coldStart
    ? (opts.coldStartLaneShares ?? COLD_START_LANE_SHARES)
    : (opts.laneShares ?? LANE_SHARES);

  const eligible = hardFilters(pool, viewer, now);
  const byLane = emptyByLane();
  const claimed = new Set<string>();

  // Quotas are apportioned against the SUPPLY, not against targetSize.
  //
  // A lane may only claim its share of what actually exists. Apportioning
  // against targetSize looks equivalent and is not: a 60-video pool against a
  // target of 500 gives fresh a quota of 100, fresh runs first in priority
  // order, and it takes all 60 — a candidate set that is 100% fresh, from a
  // pool where the same videos were equally eligible for affinity and tail.
  // Downstream that is fatal rather than merely lopsided: select.ts caps a
  // slice at 6 fresh (FRESH_CEILING), so an all-fresh pool of 60 yields a
  // 6-video slice instead of 20.
  //
  // Basing the apportionment on min(targetSize, eligibleCount) keeps every
  // lane proportional to the supply that exists, and the backfill below picks
  // up whatever the narrower lanes could not use. On a healthy pool
  // eligibleCount >= targetSize and this is a no-op.
  const quotas = allocateQuotas(shares, Math.min(targetSize, eligible.length));

  if (targetSize === 0 || eligible.length === 0) {
    return {
      candidates: [],
      byLane,
      shares,
      coldStart,
      quotas,
      guaranteedVideoIds: [],
      eligibleCount: eligible.length,
    };
  }

  // --- 2. The guarantee (spec 2.5) --------------------------------------
  // Admitted to `fresh` unconditionally, ahead of every quota, and NOT subject
  // to the fresh lane's own eligibility rules: a video can be owed impressions
  // while already past 500 lifetime impressions from a previous burst, and the
  // guarantee is a guarantee. Ordered by window expiry (oldest window first) so
  // the videos about to run out of time are delivered first.
  //
  // Note the fresh lane is NOT disabled at cold start — it has a 30% share
  // there — so the guarantee is honoured for cold and warm viewers alike. Were
  // that ever to change, the guarantee would still be admitted here, because it
  // is the platform's promise to the seller and not a personalisation choice.
  const guaranteed = eligible
    .filter((v) => budgetOwed(v, now))
    .sort((a, b) => {
      const wa = a.budget?.windowStart.getTime() ?? 0;
      const wb = b.budget?.windowStart.getTime() ?? 0;
      if (wa !== wb) return wa - wb;
      const ra = budgetRemaining(a, now);
      const rb = budgetRemaining(b, now);
      if (ra !== rb) return rb - ra;
      return a.videoId < b.videoId ? -1 : a.videoId > b.videoId ? 1 : 0;
    });

  const guaranteedVideoIds: string[] = [];
  for (const v of guaranteed) {
    if (claimed.has(v.videoId)) continue;
    claimed.add(v.videoId);
    byLane.fresh.push({ ...v, lane: 'fresh' });
    guaranteedVideoIds.push(v.videoId);
  }

  // The guarantee is charged against the fresh quota first. If it overflows,
  // the overflow is charged to the LOWEST-priority lanes, which is the same
  // scarcity ordering used for dedupe: tail gives up its slots before trending,
  // trending before affinity, and so on. The guarantee itself is never
  // truncated — if it alone exceeds targetSize the result is larger than
  // targetSize, and that is correct. "~500" is a budget; 2.5 is a promise.
  let overflow = Math.max(0, byLane.fresh.length - quotas.fresh);
  quotas.fresh = Math.max(0, quotas.fresh - byLane.fresh.length);
  for (let i = LANE_PRIORITY.length - 1; i >= 0 && overflow > 0; i--) {
    const lane = LANE_PRIORITY[i];
    if (lane === 'fresh') continue;
    const take = Math.min(overflow, quotas[lane]);
    quotas[lane] -= take;
    overflow -= take;
  }

  // --- 3. Quota fill, in LANE_PRIORITY order ----------------------------
  const sources: Record<CandidateLane, PoolVideo[]> = {
    fresh: freshLane(eligible, now),
    social: socialLane(eligible, viewer, now),
    affinity: affinityLane(eligible, viewer, now),
    trending: trendingLane(eligible),
    tail: tailLane(eligible, now, rng),
  };
  /** A zero share disables a lane outright — no quota, and no backfill either. */
  const enabled = (lane: CandidateLane): boolean =>
    Number.isFinite(shares[lane]) && shares[lane] > 0;
  /** Next unclaimed index per lane, so backfill resumes instead of rescanning. */
  const cursor: Record<CandidateLane, number> = {
    affinity: 0,
    trending: 0,
    fresh: 0,
    social: 0,
    tail: 0,
  };

  const take = (lane: CandidateLane, n: number): number => {
    if (n <= 0 || !enabled(lane)) return 0;
    const src = sources[lane];
    let took = 0;
    while (took < n && cursor[lane] < src.length) {
      const v = src[cursor[lane]++];
      if (claimed.has(v.videoId)) continue;
      claimed.add(v.videoId);
      byLane[lane].push({ ...v, lane });
      took++;
    }
    return took;
  };

  for (const lane of LANE_PRIORITY) take(lane, quotas[lane]);

  // --- 4. Backfill ------------------------------------------------------
  // Only reached when a lane ran dry, which on a healthy pool never happens —
  // so the share test on a large pool sees exact quotas.
  //
  // Round-robin one at a time rather than letting the first lane with supply
  // swallow the whole deficit. That matters most for `fresh`: it is first in
  // priority order, and a greedy backfill on a thin pool would hand it the
  // entire remainder, reproducing the "exploration lane grew to 76% of all
  // impressions and RPM fell 33%" failure that select.ts's fresh CEILING exists
  // to prevent. Better not to manufacture the problem here.
  const totalNow = (): number => LANES.reduce((n, l) => n + byLane[l].length, 0);
  while (totalNow() < targetSize) {
    let progress = false;
    for (const lane of LANE_PRIORITY) {
      if (totalNow() >= targetSize) break;
      if (take(lane, 1) > 0) progress = true;
    }
    if (!progress) break; // every enabled lane is exhausted
  }

  const candidates: GeneratedCandidate[] = [];
  for (const lane of LANE_PRIORITY) candidates.push(...byLane[lane]);

  return {
    candidates,
    byLane,
    shares,
    coldStart,
    quotas,
    guaranteedVideoIds,
    eligibleCount: eligible.length,
  };
}
