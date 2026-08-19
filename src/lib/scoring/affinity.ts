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

/** A resolved weight change for one key of one map. See `applyAffinityDeltas`. */
export type AffinityDelta = {
  key: string;
  delta: number;
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
  const deltas: AffinityDelta[] = [];
  for (const ev of events) {
    if (!ev || !isKey(ev.key)) continue;
    // Cast, not a bare lookup: events cross a process boundary, and an unknown
    // type must be ignored rather than added as NaN.
    const weight = EVENT_WEIGHTS[ev.type] as number | undefined;
    if (weight === undefined || !Number.isFinite(weight)) continue;
    const count = ev.count === undefined ? 1 : ev.count;
    if (!Number.isFinite(count) || count <= 0) continue;
    deltas.push({ key: ev.key, delta: weight * count });
  }
  return applyAffinityDeltas(current, deltas);
}

/**
 * `applyEvents` with the weight already resolved: the spec 6.5 signals below
 * carry weights that are NOT in `EVENT_WEIGHTS` (see NEGATIVE_SELLER_WEIGHTS),
 * so they cannot be expressed as a `KeyedAffinityEvent`.
 *
 * This is the single implementation of the floor-at-0 rule — `applyEvents`
 * delegates to it — because that floor is what keeps `normalizeWithCap`'s
 * water-filling well defined. A map that can hold negative mass has no
 * normalisation, so stacked negatives bottom out at "no affinity" and the
 * suppression rows, not the arithmetic, carry the punishment from there.
 */
export function applyAffinityDeltas(
  current: Readonly<AffinityMap>,
  deltas: readonly AffinityDelta[]
): AffinityMap {
  const out: AffinityMap = {};
  for (const key of Object.keys(current)) out[key] = nonNegative(current[key]);

  for (const d of deltas) {
    if (!d || !isKey(d.key) || !Number.isFinite(d.delta)) continue;
    out[d.key] = (out[d.key] ?? 0) + d.delta;
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

// ===========================================================================
// SPEC 6.5 — NEGATIVE SIGNALS THAT ACTUALLY BITE
// ===========================================================================
//
// "Most feeds handle negative feedback too gently. Drip should not."
//
//   | signal              | effect                                             |
//   |---------------------|----------------------------------------------------|
//   | not_interested      | -8 category affinity, seller blocked 30 days, AND   |
//   |                     | the 20 nearest neighbours by embedding suppressed   |
//   |                     | for 7 days                                          |
//   | fast skip (<2s)     | -1.5 category affinity                              |
//   | 3 consecutive skips | mode=diversify, affinity weight 0 for the session   |
//   | unfollow            | -5 seller affinity, 30-day For You suppression      |
//   | refund requested    | -4 seller affinity for that viewer, no re-serve 14d |
//   | dispute filed       | seller suppressed PLATFORM-WIDE pending review      |
//
// WHERE EACH NUMBER LIVES. Read this before adding a weight anywhere.
//
//   -8 (not_interested) and -1.5 (fast_skip) are spec 2.7 numbers and already
//   live in `EVENT_WEIGHTS` above, applied exactly once by
//   `updateViewerAffinity`. This section deliberately does NOT re-apply them:
//   two tables holding the same number is how a signal quietly starts biting
//   twice as hard as the spec says. What 6.5 adds for those two types is the
//   SUPPRESSION, which 2.7 never modelled.
//
//   -5 (unfollow) and -4 (refund_requested) are new here, land on the SELLER
//   map only, and live in `NEGATIVE_SELLER_WEIGHTS`. That table is typed
//   `Record<Exclude<NegativeSignalType, AffinityEventType>, number>`, so the
//   day somebody adds `unfollow` to EVENT_WEIGHTS the compiler rejects it
//   instead of letting the viewer take -10.
//
//   "3 consecutive fast skips -> mode=diversify" is NOT here. It is
//   within-session state and already lives in ./session.ts
//   (`DIVERSIFY_SKIP_THRESHOLD`, `sessionMode`, `sessionWeights`), which zeroes
//   wAffinity for the rest of the session. session.ts imports this module;
//   importing it back would be a cycle. The row is in the table above only so
//   the table is the whole of 6.5.
//
// THE NEIGHBOUR SUPPRESSION, AND WHY IT IS AN INJECTED PROVIDER.
//
// "Blocking a single video when someone tells you they dislike a *kind* of
// content is theatre — they'll see three more like it in the next minute and
// conclude the button does nothing."
//
// Correct, and not buildable today: the two-tower embedding model of spec 6.2
// is explicitly gated at ~500K engagement events and the platform has zero. So
// the nearest-neighbour lookup is a PARAMETER rather than a fake:
//
//     type NeighbourProvider = (videoId: string, k: number) => readonly string[]
//
// With no provider the suppression degrades to the one video the viewer
// actually pressed the button on — and SAYS SO. `neighbours.degraded` is true,
// `neighbours.suppressed` is 0, `neighbours.requested` is 20 and
// `neighbours.degradedVideoIds` names the videos that collapsed. A suppression
// covering 1 video instead of 21 is exactly the theatre above, so it is a
// reported degradation, never a silent one: the caller can alert on it.
//
// When 6.2 lands, one injection makes it real —
//
//     updateViewerAffinityWithSignals({ ...input, neighbours: annIndex.nearest })
//
// — and no other line in this module changes.
//
// SUPPRESSIONS ARE DATA, NOT I/O.
//
// Every rule here returns `{ scope, id, viewerId, until, surface, reason }`
// rows for the caller to persist. Nothing does I/O and `now` is always a
// parameter, so a simulation replays a viewer's entire negative-signal history
// byte-for-byte.
//
// THE SCOPES ARE NOT INTERCHANGEABLE:
//
//   viewer_seller    this viewer stops seeing this seller. not_interested
//                    (30d, every surface), unfollow (30d, For You only),
//                    refund_requested (14d, For You only).
//   viewer_video     this viewer stops seeing this video. The not_interested
//                    video itself plus its 20 nearest neighbours, 7d.
//   platform_seller  EVERY viewer stops seeing this seller, indefinitely,
//                    pending human review. Only `dispute_filed` produces one.
//                    `viewerId` is null and `until` is null, and both are load
//                    bearing: a viewer-scoped implementation of a filed dispute
//                    leaves a seller under investigation serving happily to
//                    everyone except the one person who complained.
//
// `surface` separates "blocked" from "suppressed out of For You". A viewer who
// unfollowed a seller can still open that seller's page; a viewer who pressed
// not-interested on them cannot, and nobody can reach a disputed seller at all.

// ---------------------------------------------------------------------------
// Signal vocabulary
// ---------------------------------------------------------------------------

/**
 * The rows of spec 6.5, minus the session-mode row that ./session.ts owns.
 *
 * `not_interested` and `fast_skip` are deliberately ALSO `AffinityEventType`s:
 * the same viewer action feeds both passes, contributing its 2.7 weight
 * through `EVENT_WEIGHTS` and its 6.5 suppressions through here. The two sets
 * of numbers are disjoint, so nothing is counted twice.
 */
export type NegativeSignalType =
  | 'not_interested'
  | 'fast_skip'
  | 'unfollow'
  | 'refund_requested'
  | 'dispute_filed';

/** Iterate this rather than re-listing the union. */
export const NEGATIVE_SIGNAL_TYPES = [
  'not_interested',
  'fast_skip',
  'unfollow',
  'refund_requested',
  'dispute_filed',
] as const satisfies readonly NegativeSignalType[];

const NEGATIVE_SIGNAL_TYPE_SET: ReadonlySet<string> = new Set(NEGATIVE_SIGNAL_TYPES);

export function isNegativeSignalType(value: unknown): value is NegativeSignalType {
  return typeof value === 'string' && NEGATIVE_SIGNAL_TYPE_SET.has(value);
}

/**
 * The 6.5 weights that are NOT already in `EVENT_WEIGHTS`, applied to the
 * SELLER affinity map.
 *
 * `dispute_filed` is 0 on purpose. The spec gives it no affinity weight
 * because the affinity map is the wrong instrument for it: a filed dispute is
 * a platform-wide suspension pending review, and expressing that as "this one
 * viewer likes them 4 less" would be a rounding error dressed up as
 * enforcement. The suppression IS the mechanism. A 0 weight also emits no
 * delta at all, so a dispute never conjures a 0-valued key into a viewer's map.
 */
export const NEGATIVE_SELLER_WEIGHTS = {
  unfollow: -5,
  refund_requested: -4,
  dispute_filed: 0,
} as const satisfies Record<Exclude<NegativeSignalType, AffinityEventType>, number>;

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

/** `not_interested`: "suppress the 20 nearest neighbours by embedding". */
export const NEIGHBOUR_SUPPRESSION_K = 20;

/** ...for 7 days. */
export const NEIGHBOUR_SUPPRESSION_DAYS = 7;

/** Unfollow: 30-day For You suppression. */
export const UNFOLLOW_SUPPRESSION_DAYS = 30;

/** Refund requested: "do not re-serve that seller for 14 days". */
export const REFUND_SUPPRESSION_DAYS = 14;

// ---------------------------------------------------------------------------
// Suppressions
// ---------------------------------------------------------------------------

export type SuppressionScope = 'viewer_seller' | 'viewer_video' | 'platform_seller';

/**
 * Which surfaces a row covers. `all` hides the subject everywhere; `for_you`
 * hides it from the ranked feed only, leaving direct navigation intact.
 */
export type SuppressionSurface = 'all' | 'for_you';

/**
 * One suppression, as the caller will persist it.
 *
 * `viewerId` is null exactly when `scope` is `platform_seller` — that null is
 * what makes the row apply to everybody. `until` is null only for a dispute:
 * "pending review" has no expiry, and inventing one would quietly reinstate a
 * seller nobody ever cleared.
 */
export type Suppression = {
  scope: SuppressionScope;
  /** sellerId for the seller scopes, videoId for `viewer_video`. */
  id: string;
  /** Null means every viewer. */
  viewerId: string | null;
  /** Null means indefinite, pending review. */
  until: Date | null;
  surface: SuppressionSurface;
  /** The 6.5 signal that produced this row. Part of its identity — see `mergeSuppressions`. */
  reason: NegativeSignalType;
};

type SuppressionRule = {
  scope: SuppressionScope;
  /** Null = indefinite. */
  days: number | null;
  surface: SuppressionSurface;
};

/**
 * Every suppression the spec asks for, in one greppable table. The keys name
 * the rule rather than the signal because `not_interested` produces two
 * different rows with two different lifetimes.
 */
export const SUPPRESSION_RULES = {
  /** "seller blocked 30 days" — a block, so every surface. */
  not_interested_seller: { scope: 'viewer_seller', days: SELLER_BLOCK_DAYS, surface: 'all' },
  /** The disliked video and its 20 nearest neighbours, 7 days. */
  not_interested_video: {
    scope: 'viewer_video',
    days: NEIGHBOUR_SUPPRESSION_DAYS,
    surface: 'all',
  },
  /** "30-day For You suppression" — the feed only; the seller's page still works. */
  unfollow: { scope: 'viewer_seller', days: UNFOLLOW_SUPPRESSION_DAYS, surface: 'for_you' },
  /** "do not re-serve that seller for 14 days" — re-serving is what the feed does. */
  refund_requested: { scope: 'viewer_seller', days: REFUND_SUPPRESSION_DAYS, surface: 'for_you' },
  /** Platform-wide, indefinite, pending review. */
  dispute_filed: { scope: 'platform_seller', days: null, surface: 'all' },
} as const satisfies Record<string, SuppressionRule>;

function suppressionUntil(now: Date, days: number | null): Date | null {
  return days === null ? null : new Date(now.getTime() + days * MS_PER_DAY);
}

function suppressionRow(
  rule: SuppressionRule,
  id: string,
  viewerId: string | null,
  now: Date,
  reason: NegativeSignalType
): Suppression {
  return {
    scope: rule.scope,
    id,
    viewerId,
    until: suppressionUntil(now, rule.days),
    surface: rule.surface,
    reason,
  };
}

/** Bridges the 2.7 `SellerBlock` shape onto a 6.5 row. Same fact, one representation. */
export function suppressionFromSellerBlock(block: SellerBlock, viewerId: string): Suppression {
  return {
    scope: 'viewer_seller',
    id: block.sellerId,
    viewerId,
    until: block.blockedUntil,
    surface: SUPPRESSION_RULES.not_interested_seller.surface,
    reason: 'not_interested',
  };
}

/** Live until the expiry instant, exclusive — the same boundary as `isSellerBlocked`. */
export function isSuppressionActive(row: Suppression, now: Date): boolean {
  return row.until === null || row.until.getTime() > now.getTime();
}

export function activeSuppressions(rows: readonly Suppression[], now: Date): Suppression[] {
  return rows.filter((row) => isSuppressionActive(row, now));
}

/**
 * Collapse rows that say the same thing, keeping the longest-lived.
 *
 * Identity includes `reason`, which looks redundant until a refollow: an
 * unfollow (30d, For You) and a refund (14d, For You) against one seller are
 * the same scope, id, viewer and surface, and merging them would leave a
 * single row labelled `unfollow` that the viewer could then delete by pressing
 * follow — silently lifting the refund suppression too. Keeping them apart
 * costs one row and closes that hole.
 */
export function mergeSuppressions(rows: readonly Suppression[]): Suppression[] {
  const byKey = new Map<string, Suppression>();
  for (const row of rows) {
    if (!row || !isKey(row.id)) continue;
    const key = [row.scope, row.id, row.viewerId ?? '', row.surface, row.reason].join(' ');
    const previous = byKey.get(key);
    if (previous === undefined) {
      byKey.set(key, row);
      continue;
    }
    if (previous.until === null) continue;
    if (row.until === null || row.until.getTime() > previous.until.getTime()) {
      byKey.set(key, row);
    }
  }
  return [...byKey.values()];
}

/** What the feed asks before serving a candidate. */
export type SuppressionQuery = {
  viewerId: string;
  sellerId?: string | null;
  videoId?: string | null;
  now: Date;
  /** Defaults to `for_you`, because the feed is the caller that matters. */
  surface?: SuppressionSurface;
};

function matchesQuery(row: Suppression, query: SuppressionQuery): boolean {
  const surface = query.surface ?? 'for_you';
  if (row.surface !== 'all' && row.surface !== surface) return false;
  switch (row.scope) {
    case 'platform_seller':
      // No viewer check: that is the entire point of the scope.
      return isKey(query.sellerId) && row.id === query.sellerId;
    case 'viewer_seller':
      return row.viewerId === query.viewerId && isKey(query.sellerId) && row.id === query.sellerId;
    case 'viewer_video':
      return row.viewerId === query.viewerId && isKey(query.videoId) && row.id === query.videoId;
    default:
      return false;
  }
}

/** The first live row that hides this candidate from this viewer, or null. */
export function findSuppression(
  rows: readonly Suppression[],
  query: SuppressionQuery
): Suppression | null {
  for (const row of rows) {
    if (!row) continue;
    if (!isSuppressionActive(row, query.now)) continue;
    if (matchesQuery(row, query)) return row;
  }
  return null;
}

export function isSuppressed(rows: readonly Suppression[], query: SuppressionQuery): boolean {
  return findSuppression(rows, query) !== null;
}

// ---------------------------------------------------------------------------
// Revocation — unfollow is not a life sentence
// ---------------------------------------------------------------------------

/**
 * "Delete the rows this viewer's action undoes." Data, like everything else.
 *
 * `reason` is required and never widened to "all reasons": a follow undoes an
 * unfollow, nothing more. It cannot lift a not_interested block, a refund
 * suppression, or — see `revokeSuppressions` — anything platform-wide.
 */
export type SuppressionRevocation = {
  scope: SuppressionScope;
  id: string;
  viewerId: string;
  reason: NegativeSignalType;
};

/** The revocation a `follow` earns: it clears that viewer's unfollow suppression only. */
export function revocationForRefollow(sellerId: string, viewerId: string): SuppressionRevocation {
  return { scope: 'viewer_seller', id: sellerId, viewerId, reason: 'unfollow' };
}

/**
 * Apply revocations to a persisted row set.
 *
 * Platform-scoped rows are dropped from consideration before anything else. A
 * viewer pressing follow on a seller who is under dispute review must not be
 * able to reinstate them for the entire platform, and relying on the key
 * comparison to happen to miss is not a safeguard.
 */
export function revokeSuppressions(
  rows: readonly Suppression[],
  revocations: readonly SuppressionRevocation[]
): Suppression[] {
  if (revocations.length === 0) return [...rows];
  const keys = new Set<string>();
  for (const r of revocations) {
    if (!r || !isKey(r.id) || !isKey(r.viewerId)) continue;
    if (r.scope === 'platform_seller') continue;
    keys.add([r.scope, r.id, r.viewerId, r.reason].join(' '));
  }
  return rows.filter((row) => {
    if (!row) return false;
    if (row.scope === 'platform_seller' || row.viewerId === null) return true;
    return !keys.has([row.scope, row.id, row.viewerId, row.reason].join(' '));
  });
}

// ---------------------------------------------------------------------------
// Neighbours (spec 6.2, injected)
// ---------------------------------------------------------------------------

/**
 * The nearest-neighbour lookup spec 6.5 needs and spec 6.2 has not built yet.
 * Returns up to `k` video ids nearest `videoId` in embedding space. Must be
 * pure and deterministic for a given index; the simulation replays it.
 */
export type NeighbourProvider = (videoId: string, k: number) => readonly string[];

/**
 * The honest stand-in until 6.2 exists: no embeddings, therefore no
 * neighbours. Passing it is treated exactly like passing nothing —
 * `providerPresent` is false — so "we have no model" and "we forgot to wire
 * the model" never look the same in a log.
 */
export const NO_NEIGHBOURS: NeighbourProvider = () => [];

/** What actually happened to the neighbour half of `not_interested`. */
export type NeighbourSuppressionReport = {
  /** False when no provider was supplied, or `NO_NEIGHBOURS` was. */
  providerPresent: boolean;
  /** k per `not_interested` carrying a videoId — what the spec asked for. */
  requested: number;
  /** Distinct neighbour videos actually suppressed — what the viewer got. */
  suppressed: number;
  /** True when at least one `not_interested` collapsed to its single video. */
  degraded: boolean;
  /** Which videos those were, so the caller can alert with a subject. */
  degradedVideoIds: string[];
};

function resolveK(k: number | undefined): number {
  if (k === undefined) return NEIGHBOUR_SUPPRESSION_K;
  if (!Number.isFinite(k) || k <= 0) return NEIGHBOUR_SUPPRESSION_K;
  return Math.floor(k);
}

// ---------------------------------------------------------------------------
// The 6.5 pass
// ---------------------------------------------------------------------------

/**
 * One negative signal. Discrete acts, so there is no `count`: a viewer cannot
 * unfollow twice. Two genuinely separate occurrences in one batch (two refunds
 * against one seller) are distinguished by `id`; without one, identical
 * signals collapse to a single application, which is what makes "each weight
 * applied exactly once" true by construction rather than by hope.
 */
export type NegativeSignalEvent = {
  type: NegativeSignalType;
  /** Required for the neighbour suppression — `not_interested` is about a video. */
  videoId?: string | null;
  sellerId?: string | null;
  categoryId?: string | null;
  /** Event / order / dispute id, when two occurrences must both count. */
  id?: string | null;
};

export type NegativeSignalInput = {
  viewerId: string;
  signals: readonly NegativeSignalEvent[];
  now: Date;
  /** Omit (or pass NO_NEIGHBOURS) until spec 6.2 exists. */
  neighbours?: NeighbourProvider;
  /** Defaults to NEIGHBOUR_SUPPRESSION_K. Non-positive or non-finite falls back to it. */
  neighbourK?: number;
};

export type NegativeSignalResult = {
  /** Weight changes for the SELLER map, from NEGATIVE_SELLER_WEIGHTS only. */
  sellerDeltas: AffinityDelta[];
  suppressions: Suppression[];
  neighbours: NeighbourSuppressionReport;
};

/**
 * Signals in, deltas and suppression rows out. Pure; no clock, no I/O, no
 * randomness.
 *
 * Note what is NOT here: the -8 and -1.5 category weights. They belong to
 * `EVENT_WEIGHTS` and are applied by `updateViewerAffinity`. Callers that want
 * both halves of 6.5 in one call should use `updateViewerAffinityWithSignals`,
 * which runs both passes over one event stream and cannot double-count.
 */
export function applyNegativeSignals(input: NegativeSignalInput): NegativeSignalResult {
  const { viewerId, now } = input;
  const signals = input.signals ?? [];
  const k = resolveK(input.neighbourK);
  const provider = input.neighbours;
  const providerPresent = provider !== undefined && provider !== NO_NEIGHBOURS;

  const sellerDeltas: AffinityDelta[] = [];
  const suppressions: Suppression[] = [];
  const degradedVideoIds: string[] = [];
  let requested = 0;
  let suppressed = 0;

  const seen = new Set<string>();

  for (const signal of signals) {
    if (!signal || !isNegativeSignalType(signal.type)) continue;
    const dedupeKey = [
      signal.type,
      signal.id ?? '',
      signal.videoId ?? '',
      signal.sellerId ?? '',
    ].join(' ');
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    switch (signal.type) {
      case 'fast_skip':
        // -1.5 is EVENT_WEIGHTS' and the three-in-a-row rule is session.ts's.
        // A fast skip suppresses nothing on its own: it is the weakest signal
        // in the table and the viewer may simply have been scrolling.
        break;

      case 'not_interested': {
        if (isKey(signal.sellerId)) {
          suppressions.push(
            suppressionRow(
              SUPPRESSION_RULES.not_interested_seller,
              signal.sellerId,
              viewerId,
              now,
              'not_interested'
            )
          );
        }
        if (!isKey(signal.videoId)) break;

        suppressions.push(
          suppressionRow(
            SUPPRESSION_RULES.not_interested_video,
            signal.videoId,
            viewerId,
            now,
            'not_interested'
          )
        );

        requested += k;
        const found = provider ? provider(signal.videoId, k) : [];
        const taken = new Set<string>();
        for (const neighbour of found ?? []) {
          if (taken.size >= k) break;
          // The source video already has its own row, and a provider that
          // returns it must not eat one of the 20 slots.
          if (!isKey(neighbour) || neighbour === signal.videoId || taken.has(neighbour)) continue;
          taken.add(neighbour);
          suppressions.push(
            suppressionRow(
              SUPPRESSION_RULES.not_interested_video,
              neighbour,
              viewerId,
              now,
              'not_interested'
            )
          );
        }
        suppressed += taken.size;
        if (taken.size === 0) degradedVideoIds.push(signal.videoId);
        break;
      }

      case 'unfollow':
      case 'refund_requested':
      case 'dispute_filed': {
        if (!isKey(signal.sellerId)) break;
        const weight = NEGATIVE_SELLER_WEIGHTS[signal.type];
        if (weight !== 0) sellerDeltas.push({ key: signal.sellerId, delta: weight });
        suppressions.push(
          suppressionRow(
            SUPPRESSION_RULES[signal.type],
            signal.sellerId,
            // The null is the platform-wide part. Do not "fix" it to viewerId.
            signal.type === 'dispute_filed' ? null : viewerId,
            now,
            signal.type
          )
        );
        break;
      }
    }
  }

  return {
    sellerDeltas,
    suppressions: mergeSuppressions(suppressions),
    neighbours: {
      providerPresent,
      requested,
      suppressed,
      degraded: degradedVideoIds.length > 0,
      degradedVideoIds,
    },
  };
}

// ---------------------------------------------------------------------------
// One pass over one stream
// ---------------------------------------------------------------------------

/**
 * A 2.7 event or a 6.5 signal. One stream, so a `not_interested` cannot be fed
 * to both passes twice by a caller trying to be helpful.
 */
export type ViewerEvent = Omit<AffinityEvent, 'type'> & {
  type: AffinityEventType | NegativeSignalType;
  /** Needed by the neighbour suppression; ignored by the 2.7 pass. */
  videoId?: string | null;
  /** Distinguishes repeated 6.5 signals; ignored by the 2.7 pass. */
  id?: string | null;
};

export type ViewerSignalUpdate = ViewerAffinityUpdate & {
  /** Persist these. `sellerBlocks` is the same 30-day fact in the older shape. */
  suppressions: Suppression[];
  /** Rows the caller should DELETE from storage — a refollow undoing an unfollow. */
  revocations: SuppressionRevocation[];
  neighbours: NeighbourSuppressionReport;
};

export type ViewerSignalInput = {
  profile: ViewerProfile;
  viewerId: string;
  events: readonly ViewerEvent[];
  daysElapsed: number;
  now: Date;
  cap?: number;
  neighbours?: NeighbourProvider;
  neighbourK?: number;
};

function isAffinityEventType(value: string): value is AffinityEventType {
  return Object.prototype.hasOwnProperty.call(EVENT_WEIGHTS, value);
}

/**
 * The whole thing: spec 2.7's decay/accumulate/normalise pass and spec 6.5's
 * negative signals, over ONE event stream.
 *
 * Each weight is applied exactly once because the two tables are disjoint by
 * construction — `EVENT_WEIGHTS` owns not_interested/fast_skip and
 * `NEGATIVE_SELLER_WEIGHTS` owns unfollow/refund/dispute, with the type system
 * enforcing that no type appears in both. An event whose type only 6.5 knows
 * passes through `updateViewerAffinity` untouched (it ignores unknown types),
 * and its seller weight is applied to the RAW map afterwards, before
 * normalisation — which is the same thing, since `normalizeWithCap` is a pure
 * function of the raw map.
 *
 * REFOLLOW. An unfollow still costs -5 seller affinity even if the viewer
 * follows again a second later: the affinity map records what they did, and it
 * decays on its own. The 30-day suppression does not survive, because a viewer
 * who has just chosen to follow a seller is plainly willing to see them. A
 * follow LATER IN THE STREAM than the unfollow both cancels that batch's
 * suppression and returns a revocation, so a persisted row from an earlier
 * batch goes too. A follow EARLIER in the stream does neither — they followed,
 * then changed their mind, and the suppression stands.
 */
export function updateViewerAffinityWithSignals(input: ViewerSignalInput): ViewerSignalUpdate {
  const { profile, viewerId, daysElapsed, now } = input;
  const events = input.events ?? [];
  const cap = input.cap ?? AFFINITY_CAP;

  const affinityEvents: AffinityEvent[] = [];
  const signals: NegativeSignalEvent[] = [];
  const lastFollow = new Map<string, number>();
  const lastUnfollow = new Map<string, number>();

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev || typeof ev.type !== 'string') continue;

    if (isAffinityEventType(ev.type)) {
      affinityEvents.push({
        type: ev.type,
        categoryId: ev.categoryId,
        sellerId: ev.sellerId,
        hashtags: ev.hashtags,
        count: ev.count,
      });
      if (ev.type === 'follow' && isKey(ev.sellerId)) lastFollow.set(ev.sellerId, i);
    }

    if (isNegativeSignalType(ev.type)) {
      signals.push({
        type: ev.type,
        videoId: ev.videoId,
        sellerId: ev.sellerId,
        categoryId: ev.categoryId,
        id: ev.id,
      });
      if (ev.type === 'unfollow' && isKey(ev.sellerId)) lastUnfollow.set(ev.sellerId, i);
    }
  }

  const base = updateViewerAffinity(profile, affinityEvents, daysElapsed, now, cap);
  const negative = applyNegativeSignals({
    viewerId,
    signals,
    now,
    neighbours: input.neighbours,
    neighbourK: input.neighbourK,
  });

  const revocations: SuppressionRevocation[] = [];
  for (const [sellerId, followIndex] of lastFollow) {
    const unfollowIndex = lastUnfollow.get(sellerId);
    // They unfollowed after following: the suppression is the newer fact.
    if (unfollowIndex !== undefined && unfollowIndex > followIndex) continue;
    revocations.push(revocationForRefollow(sellerId, viewerId));
  }

  const sellerRaw = applyAffinityDeltas(base.raw.sellerAffinity, negative.sellerDeltas);

  return {
    profile: {
      ...base.profile,
      sellerAffinity: normalizeWithCap(sellerRaw, cap),
    },
    raw: {
      ...base.raw,
      sellerAffinity: sellerRaw,
    },
    sellerBlocks: base.sellerBlocks,
    suppressions: revokeSuppressions(negative.suppressions, revocations),
    revocations,
    neighbours: negative.neighbours,
  };
}
