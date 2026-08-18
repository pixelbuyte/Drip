import { describe, expect, it } from 'vitest';
import { RELAX_ORDER, rerank } from '../rerank';
import { priceBandOf, type CandidateLane, type RecentContext, type ScoredCandidate } from '../types';

let seq = 0;
function sc(over: Partial<ScoredCandidate> = {}): ScoredCandidate {
  seq += 1;
  return {
    videoId: `v${seq}`, sellerId: `s${seq}`, categoryId: `c${seq}`,
    lane: 'trending' as CandidateLane, publishedAt: new Date('2026-08-18T00:00:00Z'),
    minPriceCents: 4000, hashtags: [],
    stats: {
      impressions24h: 0, purchases24h: 0, addToCarts24h: 0, productTaps24h: 0,
      completions24h: 0, skipsUnder2s24h: 0, shares24h: 0, saves24h: 0,
      avgLoopCount: 0, reportsAll: 0, notInterestedAll: 0, impressionsAll: 0,
      impressions1h: 0, purchases1h: 0, addToCarts1h: 0, productTaps1h: 0,
    },
    trust: { fulfillmentScore: 1, disputeRate: 0, ratingAvg: 5, tier: 'trusted' },
    score: Math.random(),
    components: {
      commerce: 0, engagement: 0, affinity: 0, freshness: 0,
      trust: 0, diversity: 0, fatigue: 0, quality: 0,
    },
    ...over,
  };
}

const ctx = (over: Partial<RecentContext> = {}): RecentContext => ({
  sellerIds: [], categoryIds: [], priceCents: [], seenSellerIds: new Set(), ...over,
});

/** A varied, satisfiable pool. */
function pool(n: number) {
  return Array.from({ length: n }, (_, i) =>
    sc({
      sellerId: `s${i % 12}`,
      categoryId: `c${i % 5}`,
      minPriceCents: [1500, 4000, 12_000][i % 3],
      lane: i % 7 === 0 ? 'fresh' : 'trending',
      score: 1 - i / n,
    })
  );
}

describe('rerank', () => {
  it('handles an empty pool without throwing', () => {
    expect(rerank([], ctx())).toEqual({ slice: [], relaxed: [] });
  });

  it('puts the highest-scoring candidate at position 1, always', () => {
    const p = pool(60);
    const top = [...p].sort((a, b) => b.score - a.score)[0];
    expect(rerank(p, ctx()).slice[0].videoId).toBe(top.videoId);
  });

  it('never emits a duplicate video', () => {
    const { slice } = rerank(pool(60), ctx());
    expect(new Set(slice.map((s) => s.videoId)).size).toBe(slice.length);
  });

  it('never exceeds the slice size', () => {
    expect(rerank(pool(200), ctx()).slice.length).toBeLessThanOrEqual(20);
  });

  it('caps a seller at 2 per slice and never back-to-back', () => {
    const { slice } = rerank(pool(80), ctx());
    const counts = new Map<string, number>();
    for (const s of slice) counts.set(s.sellerId, (counts.get(s.sellerId) ?? 0) + 1);
    for (const [, n] of counts) expect(n).toBeLessThanOrEqual(2);
    for (let i = 1; i < slice.length; i++) {
      expect(slice[i].sellerId).not.toBe(slice[i - 1].sellerId);
    }
  });

  it('never runs more than 4 of a category consecutively', () => {
    const { slice } = rerank(pool(80), ctx());
    let run = 1;
    for (let i = 1; i < slice.length; i++) {
      run = slice[i].categoryId === slice[i - 1].categoryId ? run + 1 : 1;
      expect(run).toBeLessThanOrEqual(4);
    }
  });

  it('keeps at least 2 price bands in every 6-video window', () => {
    const { slice, relaxed } = rerank(pool(80), ctx());
    if (!relaxed.includes(5)) {
      for (let i = 0; i + 6 <= slice.length; i++) {
        const bands = new Set(slice.slice(i, i + 6).map((s) => priceBandOf(s.minPriceCents)));
        expect(bands.size).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('includes a seller the viewer has never seen', () => {
    const p = pool(60);
    const seen = new Set(p.slice(0, 6).map((c) => c.sellerId));
    const { slice } = rerank(p, ctx({ seenSellerIds: seen }));
    expect(slice.some((s) => !seen.has(s.sellerId))).toBe(true);
  });

  // The non-negotiable one. This is what keeps new sellers alive.
  it('always seats 3 fresh-lane videos even when they all score worst', () => {
    const fresh = Array.from({ length: 3 }, (_, i) =>
      sc({ sellerId: `fresh${i}`, categoryId: `fc${i}`, lane: 'fresh', score: -99 - i,
           minPriceCents: [1500, 4000, 12_000][i % 3] })
    );
    const rest = Array.from({ length: 97 }, (_, i) =>
      sc({ sellerId: `s${i % 15}`, categoryId: `c${i % 6}`, lane: 'trending',
           score: 1 - i / 100, minPriceCents: [1500, 4000, 12_000][i % 3] })
    );
    const { slice } = rerank([...rest, ...fresh], ctx());
    expect(slice.filter((s) => s.lane === 'fresh').length).toBeGreaterThanOrEqual(3);
  });

  it('never relaxes constraint 3, even when the pool cannot satisfy it', () => {
    // One seller, 20 videos, only 2 fresh: the floor is unsatisfiable.
    const starved = Array.from({ length: 20 }, (_, i) =>
      sc({ sellerId: 'only', categoryId: 'c1', lane: i < 2 ? 'fresh' : 'trending',
           score: 1 - i / 20, minPriceCents: 4000 })
    );
    const { slice, relaxed } = rerank(starved, ctx());
    expect(relaxed).not.toContain(3);
    expect(RELAX_ORDER).not.toContain(3 as never);
    // Rather than dropping the floor it returns a short slice.
    expect(slice.length).toBeLessThan(20);
  });

  it('relaxes in the documented order, starting with 5', () => {
    // Every candidate shares a price band, so constraint 5 is unsatisfiable
    // the moment a 6-window forms.
    const oneBand = Array.from({ length: 40 }, (_, i) =>
      sc({ sellerId: `s${i % 20}`, categoryId: `c${i % 6}`, lane: i % 7 === 0 ? 'fresh' : 'trending',
           score: 1 - i / 40, minPriceCents: 4000 })
    );
    const { relaxed } = rerank(oneBand, ctx());
    if (relaxed.length > 0) {
      expect(relaxed[0]).toBe(5);
      // whatever was relaxed must be a prefix of the documented order
      expect(relaxed).toEqual(RELAX_ORDER.slice(0, relaxed.length));
    }
  });
});

describe('rerank constraint 4 — the unseen-seller swap', () => {
  it('swaps in an unseen seller when every placed video is from a seen one', () => {
    // Enough seen sellers to fill 20 slots without tripping the 2-per-seller
    // cap (so no relaxation occurs — relaxation would legitimately drop
    // constraint 4 before this path could run), plus one unseen seller
    // scoring last.
    const seenSellers = Array.from({ length: 14 }, (_, i) => `seen${i}`);
    const seenVideos = Array.from({ length: 28 }, (_, i) =>
      sc({ sellerId: seenSellers[i % 14], categoryId: `c${i % 6}`, lane: i % 9 === 0 ? 'fresh' : 'trending',
           score: 1 - i / 100, minPriceCents: [1500, 4000, 12_000][i % 3] })
    );
    const stranger = sc({ sellerId: 'stranger', categoryId: 'cx', lane: 'trending',
                          score: 0.001, minPriceCents: 4000 });

    const { slice, relaxed } = rerank([...seenVideos, stranger], ctx({ seenSellerIds: new Set(seenSellers) }));
    expect(relaxed).toEqual([]);
    expect(slice.some((s) => s.sellerId === 'stranger')).toBe(true);
    expect(slice[0].score).toBeGreaterThan(0.9); // position 1 survived the swap
  });
});
