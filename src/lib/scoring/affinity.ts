// Spec 2.7 — affinity updates. The second load-bearing v2 correction.
//
// The cron runs every 15 minutes and applies, per affinity map:
//
//   new = old * 0.97^days_elapsed + sum(event_weights)
//   then normalise to sum 1.0
//   then cap any single key at 0.45 BY ITERATIVE WATER-FILLING
//
// Everything here is pure. Elapsed time arrives as `daysElapsed` and wall-clock
// time as an explicit `now: Date`; nothing in this module reads a global clock
// or a global random source, because the offline simulation has to be replayable
// byte-for-byte (see ./rng for the same rule applied to randomness).
//
// Nothing here does I/O. The seller block produced by `not_interested` is
// returned as data for the caller to persist.

import type { ViewerProfile } from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Per-day retention: an untouched affinity keeps 97% of its mass each day. */
export const AFFINITY_DAILY_RETENTION = 0.97;

/** No single key may hold more than 45% of a normalised affinity map. */
export const AFFINITY_CAP = 0.45;

/** `not_interested` blocks the seller for 30 days. */
export const SELLER_BLOCK_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Cap-comparison tolerance. Water-filling lands keys exactly ON the cap, and
 * float arithmetic puts them a few ULPs either side of it; without a tolerance
 * the loop would chase a key that is over by 1e-17 forever.
 */
const EPSILON = 1e-12;

/** An affinity map: key (categoryId / sellerId / hashtag) -> weight. */
export type AffinityMap = Record<string, number>;

// ---------------------------------------------------------------------------
// Event weights
// ---------------------------------------------------------------------------

/**
 * Every event that moves affinity. `watch95` / `watch50` are the spec's
 * "watch>=95%" and "watch>=50%" — see `watchEventType` for the boundary.
 */
export type AffinityEventType =
  | 'purchase'
  | 'add_to_cart'
  | 'checkout_open'
  | 'product_tap'
  | 'follow'
  | 'save'
  | 'share'
  | 'watch95'
  | 'watch50'
  | 'like'
  | 'fast_skip'
  | 'not_interested';

/**
 * Spec 2.7's weight table, exactly. Exported because the admin surface renders
 * it: the numbers are product policy, and a policy nobody can read is a policy
 * nobody can argue with.
 *
 * `not_interested` carries -8 AND blocks the seller for 30 days
 * (see `updateViewerAffinity` / `SELLER_BLOCK_DAYS`). The weight alone is not
 * the suppression mechanism — the block is.
 */
export const EVENT_WEIGHTS = {
  purchase: 10,
  add_to_cart: 4,
  checkout_open: 3,
  product_tap: 2,
  follow: 3,
  save: 1.5,
  share: 1.5,
  watch95: 1,
  watch50: 0.3,
  like: 0.3,
  fast_skip: -1.5,
  not_interested: -8,
} as const satisfies Record<AffinityEventType, number>;

/**
 * Which watch event a completion fraction earns, if any. Encodes the ">=" in
 * one place so no caller has to re-derive the boundary: 0.95 exactly is a
 * watch95, 0.5 exactly is a watch50, and the two never both fire.
 */
export function watchEventType(completionFraction: number): AffinityEventType | null {
  if (!Number.isFinite(completionFraction)) return null;
  if (completionFraction >= 0.95) return 'watch95';
  if (completionFraction >= 0.5) return 'watch50';
  return null;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** An event already resolved to one key of one map. */
export type KeyedAffinityEvent = {
  key: string;
  type: AffinityEventType;
  /** Repetitions, default 1. Non-positive or non-finite counts are ignored. */
  count?: number;
};

/**
 * A viewer action against a video, before it is projected onto the three maps.
 * Facets are optional because not every event has all of them (a `follow` has
 * a seller but may have no category).
 */
export type AffinityEvent = {
  type: AffinityEventType;
  categoryId?: string | null;
  sellerId?: string | null;
  hashtags?: readonly string[];
  count?: number;
};

/** A seller the viewer said `not_interested` to. Data only — the caller persists it. */
export type SellerBlock = {
  sellerId: string;
  blockedUntil: Date;
};

/**
 * The result of one cron pass over one viewer.
 *
 * `profile` carries the normalised, capped maps — what the ranker reads.
 * `raw` carries the decayed-and-accumulated maps BEFORE normalisation, and the
 * cron should persist those as its running state. Feeding `profile` back in
 * next pass is a scale mismatch: normalised weights are <= 0.45 while a single
 * purchase is +10, so one event would erase all history. It also makes decay a
 * no-op — scaling every key by 0.97 and then renormalising to sum 1 returns the
 * identical map. Decay only bites relative to newly added event mass, which is
 * exactly its job, but only if the mass it is decaying is on the event scale.
 */
export type ViewerAffinityUpdate = {
  profile: ViewerProfile;
  raw: {
    categoryAffinity: AffinityMap;
    sellerAffinity: AffinityMap;
    hashtagAffinity: AffinityMap;
  };
  sellerBlocks: SellerBlock[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** NaN, Infinity and negatives all collapse to 0. Affinity mass is non-negative. */
function nonNegative(x: number): number {
  return Number.isFinite(x) && x > 0 ? x : 0;
}

function isKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Whole days between two instants, never negative. */
export function daysElapsedBetween(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return ms / MS_PER_DAY;
}

/** `now` plus `days`, as data. Pure: the clock is the caller's to supply. */
export function blockSellerFrom(
  sellerId: string,
  now: Date,
  days: number = SELLER_BLOCK_DAYS
): SellerBlock {
  return { sellerId, blockedUntil: new Date(now.getTime() + days * MS_PER_DAY) };
}

/** A block is live until its expiry instant, inclusive of neither end past it. */
export function isSellerBlocked(block: SellerBlock, now: Date): boolean {
  return block.blockedUntil.getTime() > now.getTime();
}

// ---------------------------------------------------------------------------
// Decay
// ---------------------------------------------------------------------------

/**
 * The `old * 0.97^days_elapsed` term.
 *
 * A negative or non-finite `daysElapsed` decays by nothing rather than growing
 * the map: a clock that went backwards must not hand the viewer extra affinity.
 * Inputs are clamped non-negative on the way through, so the output never is.
 */
export function decayAffinity(
  current: Readonly<AffinityMap>,
  daysElapsed: number,
  dailyRetention: number = AFFINITY_DAILY_RETENTION
): AffinityMap {
  const days = Number.isFinite(daysElapsed) && daysElapsed > 0 ? daysElapsed : 0;
  const retention = Number.isFinite(dailyRetention)
    ? Math.min(1, Math.max(0, dailyRetention))
    : AFFINITY_DAILY_RETENTION;
  const factor = days === 0 ? 1 : Math.pow(retention, days);
  const safeFactor = Number.isFinite(factor) ? Math.max(0, factor) : 0;

  const out: AffinityMap = {};
  for (const key of Object.keys(current)) {
    const decayed = nonNegative(current[key]) * safeFactor;
    out[key] = Number.isFinite(decayed) ? decayed : 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Event accumulation
// ---------------------------------------------------------------------------

/**
 * The `+ sum(event_weights)` term. Adds each event's weight to its key,
 * creating keys the map has never seen.
 *
 * The result is floored at 0. Normalisation distributes non-negative mass, so a
 * negative weight has no representable meaning downstream — and an unfloored
 * map lets a key accumulate arbitrary debt that only decay can repay, which
 * would quietly outlast the 30-day seller block that is the actual suppression
 * mechanism. A key driven to 0 is "no affinity", which is the strongest
 * statement this map can make.
 */
export function applyEvents(
  current: Readonly<AffinityMap>,
  events: readonly KeyedAffinityEvent[]
): AffinityMap {
  const out: AffinityMap = {};
  for (const key of Object.keys(current)) out[key] = nonNegative(current[key]);

  for (const ev of events) {
    if (!ev || !isKey(ev.key)) continue;
    // Cast, not a bare lookup: events cross a process boundary, and an unknown
    // type must be ignored rather than added as NaN.
    const weight = EVENT_WEIGHTS[ev.type] as number | undefined;
    if (weight === undefined || !Number.isFinite(weight)) continue;
    const count = ev.count === undefined ? 1 : ev.count;
    if (!Number.isFinite(count) || count <= 0) continue;
    out[ev.key] = (out[ev.key] ?? 0) + weight * count;
  }

  for (const key of Object.keys(out)) {
    if (!(out[key] > 0)) out[key] = 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Normalisation with an iterative water-filling cap
// ---------------------------------------------------------------------------

/**
 * Normalise to sum 1.0, then cap any single key — BY ITERATIVE WATER-FILLING,
 * not a single redistribution pass.
 *
 * From the spec, and the whole reason this is a loop:
 *
 *   "redistributing overflow once pushes the receiving keys above the cap. With
 *   two categories the cap is also mathematically infeasible — 2 * 0.45 = 0.9
 *   can never sum to 1 — so the effective cap needs a feasibility floor of 1/n.
 *   The naive version produced {apparel: 0.45, beauty: 0.55}, silently
 *   violating the constraint it existed to enforce."
 *
 * So:
 *   effectiveCap = max(cap, 1/n)                      -- the feasibility floor
 *   repeat: clamp everything above effectiveCap down to it, and hand the freed
 *           mass to the keys still strictly below it, in proportion to what
 *           they already hold; a clamped key never receives again.
 *
 * Termination is structural, not a hope: every iteration that redistributes
 * anything freezes at least one new key at the cap, and a frozen key can never
 * come back over it, so the loop cannot run more than n times. The bound below
 * is a guard, not the mechanism.
 *
 * Degenerate inputs, all of which the cron will eventually see:
 *   - empty map            -> empty map
 *   - n = 1                -> {only: 1} (effectiveCap is 1; nothing to cap)
 *   - all zero / all       -> uniform 1/n; with no signal, uniform is the only
 *     negative                distribution that sums to 1 and respects the cap
 *   - negative values      -> clamped to 0 before anything else
 *   - one dominant key     -> its overflow spreads evenly over the zero-weight
 *                             keys, since proportional-to-zero is undefined
 */
export function normalizeWithCap(
  map: Readonly<AffinityMap>,
  cap: number = AFFINITY_CAP
): AffinityMap {
  const keys = Object.keys(map);
  const n = keys.length;
  const out: AffinityMap = {};
  if (n === 0) return out;

  const uniform = 1 / n;
  const requested = Number.isFinite(cap) ? Math.max(0, cap) : AFFINITY_CAP;
  const effectiveCap = Math.max(requested, uniform);

  const w: number[] = new Array<number>(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const v = nonNegative(map[keys[i]]);
    w[i] = v;
    total += v;
  }

  // No mass anywhere: there is nothing to be proportional to.
  if (!(total > 0)) {
    for (let i = 0; i < n; i++) out[keys[i]] = uniform;
    return out;
  }

  for (let i = 0; i < n; i++) w[i] = w[i] / total;

  const frozen: boolean[] = new Array<boolean>(n).fill(false);
  const maxIterations = n + 2;

  for (let iter = 0; iter < maxIterations; iter++) {
    let freed = 0;
    let frozenThisPass = 0;
    for (let i = 0; i < n; i++) {
      if (frozen[i] || w[i] <= effectiveCap + EPSILON) continue;
      freed += w[i] - effectiveCap;
      w[i] = effectiveCap;
      frozen[i] = true;
      frozenThisPass++;
    }
    if (frozenThisPass === 0 || freed <= 0) break;

    let base = 0;
    let receivers = 0;
    for (let i = 0; i < n; i++) {
      if (frozen[i]) continue;
      base += w[i];
      receivers++;
    }
    // Unreachable while effectiveCap >= 1/n (n keys at the cap already sum to
    // >= 1, so they cannot also have overflow to give away), but a silent
    // no-receiver case would drop mass, so it exits instead of pretending.
    if (receivers === 0) break;

    if (base > 0) {
      for (let i = 0; i < n; i++) {
        if (frozen[i]) continue;
        w[i] = w[i] + freed * (w[i] / base);
      }
    } else {
      const share = freed / receivers;
      for (let i = 0; i < n; i++) {
        if (frozen[i]) continue;
        w[i] = w[i] + share;
      }
    }
  }

  // Redistribution is sum-preserving in exact arithmetic and drifts by a few
  // ULPs in float. Rescale once so the contract "sums to 1" holds literally;
  // the correction is ~1e-16 and cannot lift a key back over the cap.
  let sum = 0;
  for (let i = 0; i < n; i++) sum += w[i];
  for (let i = 0; i < n; i++) {
    const v = sum > 0 ? w[i] / sum : uniform;
    out[keys[i]] = Number.isFinite(v) ? v : uniform;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The whole pass
// ---------------------------------------------------------------------------

function projectToKey(
  events: readonly AffinityEvent[],
  pick: (ev: AffinityEvent) => string | null | undefined
): KeyedAffinityEvent[] {
  const out: KeyedAffinityEvent[] = [];
  for (const ev of events) {
    const key = pick(ev);
    if (isKey(key)) out.push({ key, type: ev.type, count: ev.count });
  }
  return out;
}

function projectToHashtags(events: readonly AffinityEvent[]): KeyedAffinityEvent[] {
  const out: KeyedAffinityEvent[] = [];
  for (const ev of events) {
    if (!ev.hashtags) continue;
    // Deduped within an event: a video that tags #denim twice is not two
    // signals. Across events they accumulate normally.
    const seen = new Set<string>();
    for (const tag of ev.hashtags) {
      if (!isKey(tag) || seen.has(tag)) continue;
      seen.add(tag);
      out.push({ key: tag, type: ev.type, count: ev.count });
    }
  }
  return out;
}

function updateOneMap(
  current: Readonly<AffinityMap>,
  events: readonly KeyedAffinityEvent[],
  daysElapsed: number,
  cap: number
): { raw: AffinityMap; normalised: AffinityMap } {
  const raw = applyEvents(decayAffinity(current, daysElapsed), events);
  return { raw, normalised: normalizeWithCap(raw, cap) };
}

/**
 * One cron pass for one viewer: decay, accumulate, normalise-with-cap, across
 * all three affinity maps, plus the seller blocks `not_interested` owes.
 *
 * An event with no categoryId contributes to the seller and hashtag maps only;
 * it is NOT filed under an empty-string bucket, because "uncategorised" is not
 * a taste. The same cap applies to all three maps — one seller owning 90% of a
 * viewer's profile is the same failure as one category doing it.
 *
 * `now` is a parameter, not a reading: `blockedUntil` must be reproducible when
 * a simulation replays this pass.
 */
export function updateViewerAffinity(
  profile: ViewerProfile,
  events: readonly AffinityEvent[],
  daysElapsed: number,
  now: Date,
  cap: number = AFFINITY_CAP
): ViewerAffinityUpdate {
  const category = updateOneMap(
    profile.categoryAffinity,
    projectToKey(events, (ev) => ev.categoryId),
    daysElapsed,
    cap
  );
  const seller = updateOneMap(
    profile.sellerAffinity,
    projectToKey(events, (ev) => ev.sellerId),
    daysElapsed,
    cap
  );
  const hashtag = updateOneMap(
    profile.hashtagAffinity,
    projectToHashtags(events),
    daysElapsed,
    cap
  );

  const sellerBlocks: SellerBlock[] = [];
  const alreadyBlocked = new Set<string>();
  for (const ev of events) {
    if (ev.type !== 'not_interested' || !isKey(ev.sellerId)) continue;
    if (alreadyBlocked.has(ev.sellerId)) continue;
    alreadyBlocked.add(ev.sellerId);
    sellerBlocks.push(blockSellerFrom(ev.sellerId, now));
  }

  return {
    profile: {
      ...profile,
      categoryAffinity: category.normalised,
      sellerAffinity: seller.normalised,
      hashtagAffinity: hashtag.normalised,
    },
    raw: {
      categoryAffinity: category.raw,
      sellerAffinity: seller.raw,
      hashtagAffinity: hashtag.raw,
    },
    sellerBlocks,
  };
}
