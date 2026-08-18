import { priceBandOf, type RecentContext, type ScoredCandidate } from './types';

/**
 * Constraint ids match the spec's numbering in 2.5:
 *   1 no more than 2 per seller per 20, never back-to-back
 *   2 no more than 4 of a category in a row
 *   3 at least 3 fresh-lane videos per slice   <- NEVER relaxed
 *   4 at least 1 seller the viewer has never seen
 *   5 within any 6-video window, >= 2 price bands
 *   6 position 1 is the highest-scoring video, always
 *
 * Relaxation order is 5 -> 4 -> 2 -> 1. Constraint 3 is what keeps new sellers
 * alive, so it is absent from this list by construction rather than by a
 * comment someone can ignore: if the pool cannot satisfy it, rerank returns a
 * SHORT slice instead of dropping the floor.
 */
export const RELAX_ORDER = [5, 4, 2, 1] as const;

const FRESH_FLOOR = 3;
const SLICE = 20;

type Active = { c1: boolean; c2: boolean; c4: boolean; c5: boolean };

function violates(
  cand: ScoredCandidate,
  placed: ScoredCandidate[],
  active: Active
): boolean {
  const last = placed[placed.length - 1];

  if (active.c1) {
    if (last && last.sellerId === cand.sellerId) return true; // never back-to-back
    const fromSeller = placed.filter((p) => p.sellerId === cand.sellerId).length;
    if (fromSeller >= 2) return true;
  }

  if (active.c2 && cand.categoryId !== null) {
    const tail = placed.slice(-4);
    if (tail.length === 4 && tail.every((p) => p.categoryId === cand.categoryId)) return true;
  }

  if (active.c5) {
    // Look at the 5 already placed that would share a 6-window with this one.
    const window = placed.slice(-5);
    if (window.length === 5) {
      const bands = new Set(window.map((p) => priceBandOf(p.minPriceCents)));
      bands.add(priceBandOf(cand.minPriceCents));
      if (bands.size < 2) return true;
    }
  }

  return false;
}

export function rerank(
  scored: ScoredCandidate[],
  ctx: RecentContext,
  sliceSize: number = SLICE
): { slice: ScoredCandidate[]; relaxed: number[] } {
  if (scored.length === 0) return { slice: [], relaxed: [] };

  const sorted = [...scored].sort((a, b) => b.score - a.score);
  const relaxed: number[] = [];
  const active: Active = { c1: true, c2: true, c4: true, c5: true };

  const build = (): ScoredCandidate[] => {
    const placed: ScoredCandidate[] = [];
    const used = new Set<string>();

    // Constraint 6: position 1 is the top scorer, before anything else applies.
    const first = sorted[0];
    placed.push(first);
    used.add(first.videoId);

    // Reserve the fresh floor. Chosen by score among fresh-lane candidates, so
    // the guarantee costs the slice as little quality as possible.
    const freshPool = sorted.filter((c) => c.lane === 'fresh' && !used.has(c.videoId));
    const reservedFresh = freshPool.slice(0, Math.max(0, FRESH_FLOOR));
    const reservedIds = new Set(reservedFresh.map((c) => c.videoId));

    // If the pool cannot supply the floor, the unfilled reserved slots stay
    // EMPTY — the slice comes back short rather than handing new sellers'
    // guaranteed placements to established ones. A short slice is also the
    // signal that candidate generation under-provisioned the fresh lane,
    // which is exactly what the admin dashboard's exploration metric watches
    // for. Filling the gap silently would hide the one failure this
    // constraint exists to prevent.
    const shortfall = Math.max(0, FRESH_FLOOR - reservedFresh.length);
    const effectiveSize = Math.max(1, sliceSize - shortfall);

    for (const cand of sorted) {
      if (placed.length >= effectiveSize) break;
      if (used.has(cand.videoId)) continue;
      if (reservedIds.has(cand.videoId)) continue; // placed in the tail pass

      const remaining = effectiveSize - placed.length;
      const stillNeeded = reservedFresh.filter((f) => !used.has(f.videoId)).length;
      if (remaining <= stillNeeded) break; // leave room for the floor

      if (violates(cand, placed, active)) continue;
      placed.push(cand);
      used.add(cand.videoId);
    }

    // Place the reserved fresh videos, spacing them rather than clumping at the
    // end: insert each at the latest position that does not break constraint 1.
    for (const f of reservedFresh) {
      if (placed.length >= effectiveSize) break;
      if (used.has(f.videoId)) continue;
      let inserted = false;
      for (let i = Math.min(placed.length, effectiveSize); i > 0; i--) {
        const before = placed[i - 1];
        const after = placed[i];
        if (before?.sellerId === f.sellerId) continue;
        if (after?.sellerId === f.sellerId) continue;
        placed.splice(i, 0, f);
        inserted = true;
        break;
      }
      if (!inserted) placed.push(f);
      used.add(f.videoId);
    }

    // Constraint 4: at least one seller the viewer has never seen.
    if (active.c4) {
      const hasUnseen = placed.some((p) => !ctx.seenSellerIds.has(p.sellerId));
      if (!hasUnseen) {
        const unseen = sorted.find(
          (c) => !used.has(c.videoId) && !ctx.seenSellerIds.has(c.sellerId)
        );
        if (unseen) {
          // Replace the lowest-scoring non-fresh entry rather than growing.
          const victim = [...placed]
            .map((p, i) => ({ p, i }))
            .filter(({ p }) => p.lane !== 'fresh' && p !== placed[0])
            .sort((a, b) => a.p.score - b.p.score)[0];
          if (victim) {
            used.delete(victim.p.videoId);
            placed[victim.i] = unseen;
            used.add(unseen.videoId);
          }
        }
      }
    }

    return placed.slice(0, effectiveSize);
  };

  let slice = build();

  // Only relax if the slice is short AND the pool could plausibly fill it.
  const target = Math.min(sliceSize, sorted.length);
  for (const id of RELAX_ORDER) {
    if (slice.length >= target) break;
    if (id === 5) active.c5 = false;
    if (id === 4) active.c4 = false;
    if (id === 2) active.c2 = false;
    if (id === 1) active.c1 = false;
    relaxed.push(id);
    slice = build();
  }

  return { slice, relaxed };
}
