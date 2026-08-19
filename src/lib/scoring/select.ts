import type { Rng } from './rng';
import {
  IMPRESSION_BUDGET_WINDOW_HOURS,
  SELECTION,
  priceBandOf,
  type Candidate,
  type RecentContext,
  type ScoredCandidate,
  type SelectionResult,
} from './types';

/**
 * v2 SELECTION — CONSTRAINED SOFTMAX (spec 2.3). Replaces v1's greedy `rerank`.
 *
 * Position 1 is deterministic: the single highest-scoring candidate. The first
 * video decides whether the session continues, so it doesn't get gambled.
 *
 * Positions 2-20 are SAMPLED, with probability proportional to exp(score / T),
 * T = 0.08.
 *
 * Why sampling rather than greedy argmax: greedy means the same handful of
 * top-scoring videos win every slice for every viewer. Simulated over 2,000
 * sessions: impression Gini 0.82, 27 of 120 sellers received zero impressions,
 * high-quality sellers got 541x the reach of low-quality ones. Switching to
 * softmax sampling: Gini 0.62, all 120 sellers reached, ratio 13.8x — and RPM
 * was unchanged at $3,569. The equity was free.
 *
 * Every stochastic step draws from an explicit `Rng` (see ./rng). Nothing here
 * reads a clock or Math.random, so a slice is a pure function of
 * (pool, context, options) and a session replays byte-for-byte.
 *
 * SPEC 6.6 adds two OPT-IN dials on top of that, neither of which changes a
 * default:
 *
 *   - `engagedEvents` derives T from how much is known about the viewer
 *     (`adaptiveTemperature`): 0.12 for a stranger, 0.08 once 200 engaged
 *     events have accumulated. An explicit `temperature` always overrides it.
 *   - `randomSlots` reserves N slots for a uniformly random eligible video
 *     with no scoring at all — the only way a jewelry-only buyer is ever shown
 *     ceramics.
 *
 * Both default to off, so a `select` call written before 6.6 returns exactly
 * the slice it always did.
 */

// ---------------------------------------------------------------------------
// Constraints
// ---------------------------------------------------------------------------

/**
 * Constraint ids are the spec's own numbering (2.3). v1 numbered them
 * differently — check an id against this table, not against memory of
 * rerank.ts:
 *
 *   1  never two videos from the same seller back-to-back
 *   2  at most 2 videos per seller per 20-slice
 *   3  at most 4 consecutive videos from one category
 *   4  MINIMUM 3 fresh-lane videos per slice  <- reserved in the tail, NEVER relaxed
 *   5  MAXIMUM 6 fresh-lane videos per slice  <- structural, also never relaxed
 *   6  at least 2 distinct price bands (<$25 / $25-75 / >$75) in any 6-video window
 *   7  at least 1 seller the viewer has never seen
 *
 * Relaxation order when the pool is too thin: 6 -> 7 -> 2 -> 3 -> 1.
 *
 * Constraint 4 is what keeps new sellers alive, so its absence here is
 * structural rather than a comment someone can ignore: it is not representable
 * in this list, and if the pool cannot satisfy it `select` returns a SHORT
 * slice instead of dropping the floor. Constraint 5 is likewise absent — see
 * the ceiling note below.
 */
export const RELAX_ORDER = [6, 7, 2, 3, 1] as const;

export type RelaxableConstraint = (typeof RELAX_ORDER)[number];

/**
 * Why constraint 5 exists at all — the fresh lane needs a ceiling as well as a
 * floor: "a floor without a ceiling is not a guarantee, it's a takeover. With
 * only a floor, the exploration lane grew to 76% of all impressions and RPM
 * fell 33%. Capping it at 6 restored RPM to baseline while keeping 100% budget
 * delivery."
 *
 * So both fresh bounds sit outside RELAX_ORDER, for opposite reasons: the floor
 * because dropping it starves new sellers, the ceiling because dropping it
 * starves everyone else.
 */

type Active = {
  c1: boolean;
  c2: boolean;
  c3: boolean;
  c6: boolean;
  c7: boolean;
  /** Constraint 2's cap. The spec's default is 2; feed_weights carries a
   *  max_per_seller_per_slice column so a variant can tune it — a knob that
   *  was silently dead until this field existed. */
  maxPerSeller: number;
};

function violates(
  cand: ScoredCandidate,
  placed: readonly ScoredCandidate[],
  active: Active
): boolean {
  // 1: never two from the same seller back-to-back.
  if (active.c1 && placed.length > 0 && placed[placed.length - 1].sellerId === cand.sellerId) {
    return true;
  }

  // 2: at most maxPerSeller (spec default 2) from one seller per slice.
  if (active.c2) {
    let n = 0;
    for (const p of placed) if (p.sellerId === cand.sellerId) n += 1;
    if (n >= active.maxPerSeller) return true;
  }

  // 3: at most 4 consecutive from one category. An uncategorised video (null)
  //    does not extend a run — null means "unknown", not "a category of its
  //    own", and treating it as one would let two unrelated videos block each
  //    other. Carried forward from v1.
  if (active.c3 && cand.categoryId !== null) {
    const tail = placed.slice(-4);
    if (tail.length === 4 && tail.every((p) => p.categoryId === cand.categoryId)) return true;
  }

  // 6: >= 2 distinct price bands in any 6-video window. Only the 5 already
  //    placed can share a window with the candidate.
  if (active.c6) {
    const window = placed.slice(-5);
    if (window.length === 5) {
      const bands = new Set(window.map((p) => priceBandOf(p.minPriceCents)));
      bands.add(priceBandOf(cand.minPriceCents));
      if (bands.size < 2) return true;
    }
  }

  return false;
}

/** Whole-slice check, used when repairing constraint 7 by substitution. */
function validateSlice(slice: readonly ScoredCandidate[], active: Active): boolean {
  const seen = new Set<string>();
  for (let i = 0; i < slice.length; i += 1) {
    const c = slice[i];
    if (seen.has(c.videoId)) return false;
    seen.add(c.videoId);
    // Position 1 is exempt by construction; violates() against an empty prefix
    // is vacuously false, so the same call is correct for i === 0.
    if (violates(c, slice.slice(0, i), active)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Softmax sampling
// ---------------------------------------------------------------------------

/**
 * Softmax weights with the log-sum-exp shift.
 *
 * exp(score / 0.08) overflows to Infinity at a score of ~57 and underflows to
 * 0 well before that, so the maximum score is subtracted before exponentiating.
 * Every exponent is then <= 0, every weight lands in (0, 1], and the largest is
 * exactly 1 — the sum can neither overflow nor be zero while any finite score
 * is present. Weights are proportional, not probabilities; `sampleIndex`
 * normalises.
 *
 * Scores are deliberately NOT clamped to [0,1] anywhere in this codebase (see
 * score.ts) — a heavily penalised video must stay orderable below a zero-score
 * one. So negative scores, and wide spreads like [50, -50], must keep working.
 * A non-finite score is given weight 0 rather than allowed to poison the sum.
 *
 * A temperature of 0 (or a non-finite one) degenerates to greedy: all mass on
 * the highest score.
 */
export function softmaxWeights(scores: readonly number[], temperature: number): number[] {
  const n = scores.length;
  if (n === 0) return [];

  const finite = (s: number): number => (Number.isFinite(s) ? s : -Infinity);
  const t = Number.isFinite(temperature) && temperature > 0 ? temperature : 0;

  let max = -Infinity;
  for (const s of scores) {
    const v = finite(s);
    if (v > max) max = v;
  }
  // Nothing finite to weigh: refuse to invent a distribution.
  if (!Number.isFinite(max)) return scores.map(() => 0);

  if (t === 0) {
    let best = 0;
    for (let i = 1; i < n; i += 1) if (finite(scores[i]) > finite(scores[best])) best = i;
    return scores.map((_, i) => (i === best ? 1 : 0));
  }

  return scores.map((s) => (Number.isFinite(s) ? Math.exp((s - max) / t) : 0));
}

/**
 * Draw one index from a weight vector, consuming exactly one rng value.
 * Non-finite or negative weights count as 0. If no weight is positive the draw
 * is meaningless, so index 0 is returned without consuming the rng.
 */
export function sampleIndex(weights: readonly number[], rng: Rng): number {
  let total = 0;
  for (const w of weights) if (Number.isFinite(w) && w > 0) total += w;
  if (!(total > 0) || !Number.isFinite(total)) return 0;

  const u = rng();
  const r = (Number.isFinite(u) ? Math.min(Math.max(u, 0), 1) : 0) * total;

  let acc = 0;
  for (let i = 0; i < weights.length; i += 1) {
    const w = Number.isFinite(weights[i]) && weights[i] > 0 ? weights[i] : 0;
    acc += w;
    if (r < acc) return i;
  }
  // Floating-point tail (r === total): fall to the last positive weight.
  for (let i = weights.length - 1; i >= 0; i -= 1) {
    if (Number.isFinite(weights[i]) && weights[i] > 0) return i;
  }
  return 0;
}

/**
 * Pick one candidate from an ALREADY-ELIGIBLE, score-descending pool.
 *
 * Sampling is over the eligible set — candidates that violate an active
 * constraint are never in `pool`, so their probability is 0 by construction.
 * This is not rejection sampling: no draw is ever discarded and retried, which
 * is what keeps rng consumption a function of the slice shape alone (one draw
 * per contested position) and therefore replayable.
 *
 * `drew` reports whether the rng was actually consumed: a pool of one has
 * nothing to decide, so it isn't.
 */
export function softmaxPick<T extends { score: number }>(
  pool: readonly T[],
  temperature: number,
  rng: Rng
): { pick: T; drew: boolean } {
  if (pool.length === 1 || !(Number.isFinite(temperature) && temperature > 0)) {
    return { pick: pool[0], drew: false };
  }
  const weights = softmaxWeights(
    pool.map((c) => c.score),
    temperature
  );
  return { pick: pool[sampleIndex(weights, rng)], drew: true };
}

// ---------------------------------------------------------------------------
// Spec 6.6 — explore vs exploit, made explicit
// ---------------------------------------------------------------------------

/**
 * The softmax temperature as a function of how much the platform actually
 * knows about this viewer.
 *
 *   uncertainty = 1 - min(1, engagedEvents / 200)
 *   T           = base * (1 + 0.5 * uncertainty)
 *
 * At the default base of 0.08 that is exactly the spec's dial:
 *
 *     0 events -> T = 0.12   a wide, exploratory feed for a stranger
 *   100 events -> T = 0.10   halfway
 *   200+ events -> T = 0.08  tight and confident
 *
 * This is the mechanism behind "the algorithm got good after a week", and it
 * costs four lines. Nothing is trained, nothing is fitted, and it needs no
 * event corpus — only a count the caller already has, which is why it is
 * buildable today while §6.2's two-tower model (gated at ~500K events) is not.
 *
 * The count is a floor, not a cap: 500 engaged events and 200 both mean "we
 * know this viewer", because uncertainty is clamped at 0. Garbage in — a
 * negative count, NaN, Infinity — is read as "no evidence at all" and yields
 * the widest temperature, which is the safe direction to fail: an over-broad
 * feed loses a little RPM, an over-confident one traps the viewer in whatever
 * the cold-start model happened to guess first.
 *
 * `base` of exactly 0 is preserved as 0, so a caller that has deliberately
 * chosen greedy argmax (the simulation's 'greedy' strategy) does not get
 * silently handed a stochastic selector.
 */
export function adaptiveTemperature(
  engagedEvents: number,
  base: number = SELECTION.SOFTMAX_TEMPERATURE
): number {
  const events = Number.isFinite(engagedEvents) && engagedEvents > 0 ? engagedEvents : 0;
  const b = Number.isFinite(base) && base >= 0 ? base : SELECTION.SOFTMAX_TEMPERATURE;
  const uncertainty = 1 - Math.min(1, events / SELECTION.UNCERTAINTY_HORIZON_EVENTS);
  return b * (1 + SELECTION.MAX_EXPLORATION_WIDENING * uncertainty);
}

/**
 * Which temperature a `select` call actually runs at.
 *
 * An EXPLICIT finite temperature always wins. The offline simulation passes one
 * on every call (see simulate.ts's StrategyConfig) and must keep reproducing
 * byte-identically, so the adaptive dial is opt-in via `engagedEvents` and can
 * never reach in behind a caller that named its own temperature.
 */
export function resolveTemperature(o: {
  temperature?: number;
  engagedEvents?: number;
}): number {
  if (typeof o.temperature === 'number' && Number.isFinite(o.temperature)) return o.temperature;
  if (typeof o.engagedEvents === 'number') return adaptiveTemperature(o.engagedEvents);
  return SELECTION.SOFTMAX_TEMPERATURE;
}

/**
 * Draw one entry uniformly, consuming exactly one rng value — the deliberate
 * absence of scoring in the 1-in-20 random slot.
 *
 * Same contract as `softmaxPick`: a pool of one has nothing to decide, so it
 * does not draw. A misbehaving rng is clamped rather than allowed to index off
 * the end.
 */
export function uniformPick<T>(pool: readonly T[], rng: Rng): { pick: T; drew: boolean } {
  if (pool.length <= 1) return { pick: pool[0], drew: false };
  const u = rng();
  const r = Number.isFinite(u) ? Math.min(Math.max(u, 0), 1 - Number.EPSILON) : 0;
  return { pick: pool[Math.min(pool.length - 1, Math.floor(r * pool.length))], drew: true };
}

/**
 * The spec's own rate: one random slot per 20 positions.
 *
 * Pass the result to `select` as `randomSlots`. `select` defaults it to 0 — the
 * 1-in-20 slot is something a caller opts into, so PR #9's simulation numbers
 * stay reproducible.
 */
export function randomSlotsForSlice(sliceSize: number = SELECTION.SLICE_SIZE): number {
  const size = Math.max(0, Math.floor(numOr(sliceSize, 0)));
  return Math.floor(size / SELECTION.RANDOM_SLOT_INTERVAL);
}

/**
 * Which POSITIONS the random slots occupy. They are reserved up front, exactly
 * like constraint 4's fresh floor — a slot the scorer is never offered, not a
 * scored slice with a video swapped in afterwards. The difference matters: a
 * post-hoc swap discards a video the model chose, so it costs a known-good
 * impression AND biases whatever it displaces; a reservation costs one slot,
 * decided before anything competes for it.
 *
 * Two positions are off limits:
 *
 *   - index 0. Position 1 is the spec's one fixed point — the first video
 *     decides whether the session continues, so it is never gambled, and a
 *     random slot is the largest gamble in the module.
 *   - the last `freshFloor` indexes, where constraint 4's tail reservation
 *     lives. Exploration must not be paid for out of the fresh lane's floor;
 *     they are different guarantees serving different people (a random video
 *     serves the viewer, the fresh floor serves new sellers) and spending one
 *     on the other quietly deletes a guarantee.
 *
 * Within what is left the slots are spread evenly, and the answer is a pure
 * function of the slice shape — no rng — so which slot is random is fixed while
 * what lands in it is not. That keeps rng consumption a function of slice shape
 * alone, which is what makes a session replayable.
 */
export function randomSlotPositions(
  sliceSize: number,
  randomSlots: number,
  freshFloor: number = SELECTION.FRESH_FLOOR
): number[] {
  const size = Math.max(0, Math.floor(numOr(sliceSize, 0)));
  const reservedTail = Math.max(0, Math.floor(numOr(freshFloor, 0)));
  const want = Math.max(0, Math.floor(numOr(randomSlots, 0)));

  const first = 1;
  const last = size - reservedTail - 1;
  const usable = last - first + 1;
  if (want === 0 || usable <= 0) return [];

  const k = Math.min(want, usable);
  const taken = new Set<number>();
  for (let j = 1; j <= k; j += 1) {
    let idx = Math.min(last, Math.max(first, Math.floor((j * size) / (k + 1))));
    while (taken.has(idx) && idx < last) idx += 1;
    while (taken.has(idx) && idx > first) idx -= 1;
    if (taken.has(idx)) continue;
    taken.add(idx);
  }
  return [...taken].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Impression budget
// ---------------------------------------------------------------------------

/**
 * Is this video still owed guaranteed impressions? Pass `now` to also require
 * the 48h window to be open; omit it when the caller has already dropped the
 * budget for expired windows (the `Candidate.budget` doc says it is absent for
 * videos past their window). There is no implicit clock here — `now` is a
 * parameter or the check is skipped.
 */
export function isBudgetOwed(c: Candidate, now?: Date): boolean {
  const b = c.budget;
  if (!b) return false;
  if (b.satisfied) return false;
  if (!(b.impressionsDelivered < b.budgetTotal)) return false;
  if (now) {
    const endsAt = b.windowStart.getTime() + IMPRESSION_BUDGET_WINDOW_HOURS * 3_600_000;
    if (now.getTime() > endsAt) return false;
  }
  return true;
}

export function budgetOwedIds(cands: readonly Candidate[], now?: Date): Set<string> {
  const out = new Set<string>();
  for (const c of cands) if (isBudgetOwed(c, now)) out.add(c.videoId);
  return out;
}

// ---------------------------------------------------------------------------
// select
// ---------------------------------------------------------------------------

export type SelectOptions = {
  /** Required. Determinism is the contract: no Math.random in this module. */
  rng: Rng;
  /** Default SELECTION.SLICE_SIZE (20). */
  sliceSize?: number;
  /**
   * Default SELECTION.SOFTMAX_TEMPERATURE (0.08). 0 degenerates to greedy.
   * An explicit finite value always wins over `engagedEvents`.
   */
  temperature?: number;
  /**
   * Spec 6.6. How many engaged events this viewer has produced. When
   * `temperature` is NOT given, this derives one via `adaptiveTemperature`:
   * 0 events -> 0.12, 100 -> 0.10, 200+ -> 0.08. Omit both and the fixed 0.08
   * is used, exactly as before — this is an option, not a change of default.
   */
  engagedEvents?: number;
  /**
   * Spec 6.6. How many slots in this slice go to a uniformly random eligible
   * video with no scoring at all. `randomSlotsForSlice(sliceSize)` gives the
   * spec's 1-in-20 rate.
   *
   * DEFAULT 0 — off. The random slot changes which videos a slice contains, so
   * turning it on by default would silently move every number PR #9 reported.
   * The slots are reserved (see `randomSlotPositions`), never take position 1,
   * never take a slot constraint 4 has reserved for the fresh lane, and the
   * video that lands in one still has to satisfy every active hard constraint:
   * random does not mean broken.
   */
  randomSlots?: number;
  /**
   * Video ids still owed guaranteed impressions. They jump the queue into the
   * reserved fresh slots and nowhere else. Defaults to the ids derived from
   * each candidate's own `budget` field.
   */
  budgetOwed?: ReadonlySet<string>;
  /** Default SELECTION.FRESH_FLOOR (3). Never relaxed, whatever it is set to. */
  freshFloor?: number;
  /** Default SELECTION.FRESH_CEILING (6). Raised to the floor if set below it. */
  freshCeiling?: number;
  /**
   * Constraint 2's per-seller cap. Default 2, the spec's number — passing the
   * default changes nothing. Exists so feed_weights.max_per_seller_per_slice
   * (a per-variant column the schema has carried since 00009) actually
   * reaches the selector instead of being a dead knob. Floored at 1.
   */
  maxPerSeller?: number;
};

/** Most unseen-seller replacements to try before giving up on constraint 7. */
const MAX_UNSEEN_SWAP_CANDIDATES = 10;

function numOr(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Score-descending, videoId-ascending, one entry per videoId. */
function orderPool(scored: readonly ScoredCandidate[]): ScoredCandidate[] {
  const sorted = [...scored].sort((a, b) => {
    const sa = Number.isFinite(a.score) ? a.score : -Infinity;
    const sb = Number.isFinite(b.score) ? b.score : -Infinity;
    if (sa !== sb) return sb > sa ? 1 : -1;
    // A total order, so the slice does not depend on the caller's array order.
    return a.videoId < b.videoId ? -1 : a.videoId > b.videoId ? 1 : 0;
  });
  const seen = new Set<string>();
  const out: ScoredCandidate[] = [];
  for (const c of sorted) {
    if (seen.has(c.videoId)) continue;
    seen.add(c.videoId);
    out.push(c);
  }
  return out;
}

/**
 * The longest slice this pool could possibly yield, ignoring constraints.
 * Relaxation is only worth attempting while the slice is shorter than this: a
 * pool of 25 videos of which 20 are fresh can never fill 20 slots (the ceiling
 * allows 6 fresh + 5 others = 11), and relaxing constraints to chase the
 * missing 9 would trade diversity away for nothing.
 */
function attainableTarget(
  pool: readonly ScoredCandidate[],
  sliceSize: number,
  freshFloor: number,
  freshCeiling: number
): number {
  let fresh = 0;
  for (const c of pool) if (c.lane === 'fresh') fresh += 1;
  const others = pool.length - fresh;
  const maxFresh = Math.min(fresh, freshCeiling);
  // Reserved fresh slots the pool can never fill stay empty, shortening the slice.
  const shortfall = Math.max(0, freshFloor - maxFresh);
  const cap = Math.min(sliceSize, others + maxFresh);
  return Math.max(1, Math.min(cap, sliceSize - shortfall));
}

/**
 * Constraint 7 repair: if no placed video comes from a seller the viewer has
 * never seen, substitute one in rather than growing the slice.
 *
 * Deterministic on purpose — this is a repair, not a choice, so it consumes no
 * rng. Position 1 is never the victim (it is the spec's one fixed point), the
 * lowest-scoring entries are tried first, and the whole resulting slice is
 * re-validated so the repair cannot break constraints 1/2/3/6 or trade away a
 * fresh video the floor is counting on.
 *
 * A 6.6 random slot is off limits too (`protectedIndexes`). Its occupant was
 * picked with no scoring, so it is usually the lowest-scoring video in the
 * slice and would be the first victim every time — the repair would quietly
 * eat the exploration slot on most slices. The set is empty when
 * `randomSlots` is 0, so nothing about the old behaviour moves.
 */
function repairUnseenSeller(
  placed: ScoredCandidate[],
  pool: readonly ScoredCandidate[],
  used: Set<string>,
  seenSellerIds: ReadonlySet<string>,
  active: Active,
  freshFloor: number,
  freshCeiling: number,
  protectedIndexes: ReadonlySet<number>
): void {
  if (placed.length === 0) return;
  if (placed.some((p) => !seenSellerIds.has(p.sellerId))) return;

  const replacements = pool
    .filter((c) => !used.has(c.videoId) && !seenSellerIds.has(c.sellerId))
    .slice(0, MAX_UNSEEN_SWAP_CANDIDATES);
  if (replacements.length === 0) return;

  let freshBefore = 0;
  for (const p of placed) if (p.lane === 'fresh') freshBefore += 1;

  const victims = placed
    .map((p, i) => ({ p, i, s: Number.isFinite(p.score) ? p.score : -Infinity }))
    .slice(1)
    .filter((v) => !protectedIndexes.has(v.i))
    .sort((a, b) => (a.s === b.s ? a.i - b.i : a.s < b.s ? -1 : 1));

  for (const repl of replacements) {
    for (const v of victims) {
      const freshAfter =
        freshBefore - (v.p.lane === 'fresh' ? 1 : 0) + (repl.lane === 'fresh' ? 1 : 0);
      if (freshAfter < Math.min(freshBefore, freshFloor)) continue; // never spend the floor
      if (freshAfter > freshCeiling) continue;
      const trial = [...placed];
      trial[v.i] = repl;
      if (!validateSlice(trial, active)) continue;
      used.delete(v.p.videoId);
      used.add(repl.videoId);
      placed[v.i] = repl;
      return;
    }
  }
}

/**
 * Build one slice: position 1 deterministic, positions 2..N sampled from a
 * constrained softmax, relaxing constraints in RELAX_ORDER only while the slice
 * is shorter than the pool could attain.
 *
 * Eligibility is recomputed at EVERY position, because the constraints are
 * order-dependent — what is legal at position 7 depends on positions 1-6 — so
 * there is no static eligible set to sample from once. Spec 6.6's random slots
 * (opt-in, `randomSlots`) sample from that same eligible set, just uniformly
 * instead of by score, which is why they cannot break a constraint.
 *
 * Pure: the only inputs are the pool, the context and the options, and the only
 * source of randomness is `opts.rng`. Same pool + same seed => same slice.
 */
export function select(
  scored: readonly ScoredCandidate[],
  ctx: RecentContext,
  opts: SelectOptions
): SelectionResult {
  const sliceSize = Math.max(0, Math.floor(numOr(opts.sliceSize, SELECTION.SLICE_SIZE)));
  // Explicit temperature wins; `engagedEvents` only fills the gap when none was
  // named. See resolveTemperature — the simulation harness names one.
  const temperature = resolveTemperature(opts);
  const freshFloor = Math.max(0, Math.floor(numOr(opts.freshFloor, SELECTION.FRESH_FLOOR)));
  // A ceiling below the floor is a misconfiguration; the floor is the
  // non-negotiable of the two, so it wins.
  const freshCeiling = Math.max(
    freshFloor,
    Math.max(0, Math.floor(numOr(opts.freshCeiling, SELECTION.FRESH_CEILING)))
  );
  const { rng } = opts;

  const pool = orderPool(scored);
  if (pool.length === 0 || sliceSize === 0) return { slice: [], relaxed: [], sampled: false };

  const owed = opts.budgetOwed ?? budgetOwedIds(pool);

  // Spec 6.6's reserved random slots. Empty (and therefore free) at the default
  // randomSlots of 0, which is what keeps existing runs byte-identical.
  const randomAt = new Set(randomSlotPositions(sliceSize, numOr(opts.randomSlots, 0), freshFloor));

  const build = (active: Active): { placed: ScoredCandidate[]; drew: boolean } => {
    const placed: ScoredCandidate[] = [];
    const used = new Set<string>();
    let drew = false;
    let freshPlaced = 0;

    const place = (c: ScoredCandidate): void => {
      placed.push(c);
      used.add(c.videoId);
      if (c.lane === 'fresh') freshPlaced += 1;
    };

    // Position 1 is deterministic: the single highest-scoring candidate. The
    // first video decides whether the session continues, so it doesn't get
    // gambled. No constraint applies to it and no rng is consumed.
    place(pool[0]);

    while (placed.length < sliceSize) {
      const remaining = sliceSize - placed.length;
      const freshStillNeeded = Math.max(0, freshFloor - freshPlaced);
      // Constraint 4's reservation: once only as many slots remain as fresh
      // videos are still owed, the rest of the slice belongs to the fresh lane.
      // Reserving in the TAIL rather than up front means the floor costs the
      // slice as little quality as possible — fresh videos that can win a slot
      // on score already have, and each one they win releases a reserved slot.
      const reserved = remaining <= freshStillNeeded;

      let eligible = pool.filter((c) => {
        if (used.has(c.videoId)) return false;
        if (c.lane === 'fresh') {
          // Constraint 5: the ceiling is structural and is never relaxed.
          if (freshPlaced >= freshCeiling) return false;
        } else if (reserved) {
          // A reserved fresh slot is NEVER filled with a non-fresh video. If no
          // fresh video can take it, the slice comes back short instead.
          return false;
        }
        return !violates(c, placed, active);
      });

      if (reserved && eligible.length > 0) {
        // Videos still owed their guaranteed impression budget jump the queue —
        // but ONLY into the reserved fresh slots, never beyond them. Within the
        // owed set the pick is still sampled, so the guarantee is spread across
        // everything owed rather than always paid to the best-scoring one.
        const owedFirst = eligible.filter((c) => owed.has(c.videoId));
        if (owedFirst.length > 0) eligible = owedFirst;
      }

      if (eligible.length === 0) break;

      // Spec 6.6's exploration slot: no scoring at all, uniform over what is
      // eligible HERE — so every hard constraint still holds (the violating
      // candidates were filtered out above, exactly as for a scored pick) and
      // the video is still never a duplicate. `!reserved` is belt and braces:
      // randomSlotPositions already keeps these indexes out of the fresh tail.
      const useRandom = randomAt.has(placed.length) && !reserved;
      const { pick, drew: consumed } = useRandom
        ? uniformPick(eligible, rng)
        : softmaxPick(eligible, temperature, rng);
      if (consumed) drew = true;
      place(pick);
    }

    if (active.c7) {
      repairUnseenSeller(
        placed,
        pool,
        used,
        ctx.seenSellerIds,
        active,
        freshFloor,
        freshCeiling,
        randomAt
      );
    }

    return { placed, drew };
  };

  const active: Active = {
    c1: true,
    c2: true,
    c3: true,
    c6: true,
    c7: true,
    maxPerSeller: Math.max(1, Math.floor(numOr(opts.maxPerSeller, 2))),
  };
  const target = attainableTarget(pool, sliceSize, freshFloor, freshCeiling);

  let sampled = false;
  let best: ScoredCandidate[] = [];
  let bestRelaxed: number[] = [];

  for (let step = 0; step <= RELAX_ORDER.length; step += 1) {
    if (step > 0) {
      // Relaxation strictly in order: 6 -> 7 -> 2 -> 3 -> 1.
      const id = RELAX_ORDER[step - 1];
      if (id === 6) active.c6 = false;
      else if (id === 7) active.c7 = false;
      else if (id === 2) active.c2 = false;
      else if (id === 3) active.c3 = false;
      else active.c1 = false;
    }

    const attempt = build(active);
    sampled = sampled || attempt.drew;
    // Keep the best build, not the last one. Each rebuild resamples, so a more
    // relaxed pass can come back shorter by chance; reporting the relaxations
    // that actually produced the returned slice keeps `relaxed` honest.
    if (attempt.placed.length > best.length) {
      best = attempt.placed;
      bestRelaxed = RELAX_ORDER.slice(0, step);
    }
    if (best.length >= target) break;
  }

  return { slice: best, relaxed: bestRelaxed, sampled };
}
