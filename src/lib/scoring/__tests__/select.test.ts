import { describe, expect, it } from 'vitest';
import { mulberry32, type Rng } from '../rng';
import {
  RELAX_ORDER,
  budgetOwedIds,
  isBudgetOwed,
  sampleIndex,
  select,
  softmaxPick,
  softmaxWeights,
  type SelectOptions,
} from '../select';
import {
  IMPRESSION_BUDGET_TOTAL,
  SELECTION,
  priceBandOf,
  type CandidateLane,
  type ImpressionBudget,
  type RecentContext,
  type ScoredCandidate,
} from '../types';

// ---------------------------------------------------------------------------
// Fixtures. No Math.random anywhere — every score is explicit so a failure is
// reproducible from the test source alone.
// ---------------------------------------------------------------------------

const PRICES = [1500, 4000, 12_000]; // one per price band: low / mid / high

let seq = 0;
function sc(over: Partial<ScoredCandidate> = {}): ScoredCandidate {
  seq += 1;
  return {
    videoId: `v${seq}`,
    sellerId: `s${seq}`,
    categoryId: `c${seq}`,
    lane: 'trending' as CandidateLane,
    publishedAt: new Date('2026-08-18T00:00:00Z'),
    minPriceCents: 4000,
    hashtags: [],
    stats: {
      impressions24h: 0, purchases24h: 0, addToCarts24h: 0, productTaps24h: 0,
      completions24h: 0, skipsUnder2s24h: 0, shares24h: 0, saves24h: 0,
      avgLoopCount: 0, reportsAll: 0, notInterestedAll: 0, impressionsAll: 0,
      impressions1h: 0, purchases1h: 0, addToCarts1h: 0, productTaps1h: 0,
    },
    trust: { fulfillmentScore: 1, disputeRate: 0, ratingAvg: 5, tier: 'trusted' },
    score: 0,
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

const opts = (over: Partial<SelectOptions> & { seed?: number } = {}): SelectOptions => {
  const { seed = 1, ...rest } = over;
  return { rng: mulberry32(seed), ...rest };
};

/** A varied, satisfiable pool: 20 sellers, 6 categories, all 3 price bands. */
function pool(n: number): ScoredCandidate[] {
  return Array.from({ length: n }, (_, i) =>
    sc({
      videoId: `p${String(i).padStart(3, '0')}`,
      sellerId: `s${i % 20}`,
      categoryId: `c${i % 6}`,
      minPriceCents: PRICES[i % 3],
      lane: i % 7 === 0 ? 'fresh' : 'trending',
      score: 1 - i / n,
    })
  );
}

function counting(seed: number): { rng: Rng; draws: () => number } {
  const inner = mulberry32(seed);
  let n = 0;
  return {
    rng: () => {
      n += 1;
      return inner();
    },
    draws: () => n,
  };
}

const ids = (slice: ScoredCandidate[]): string[] => slice.map((s) => s.videoId);
const freshCount = (slice: ScoredCandidate[]): number =>
  slice.filter((s) => s.lane === 'fresh').length;

/** Independent re-derivation of the hard constraints from the spec text. */
function assertConstraints(slice: ScoredCandidate[], relaxed: number[]): void {
  expect(new Set(ids(slice)).size).toBe(slice.length); // never a duplicate

  if (!relaxed.includes(1)) {
    for (let i = 1; i < slice.length; i += 1) {
      expect(slice[i].sellerId).not.toBe(slice[i - 1].sellerId);
    }
  }
  if (!relaxed.includes(2)) {
    const counts = new Map<string, number>();
    for (const s of slice) counts.set(s.sellerId, (counts.get(s.sellerId) ?? 0) + 1);
    for (const [, n] of counts) expect(n).toBeLessThanOrEqual(2);
  }
  if (!relaxed.includes(3)) {
    let run = 1;
    for (let i = 1; i < slice.length; i += 1) {
      run = slice[i].categoryId !== null && slice[i].categoryId === slice[i - 1].categoryId ? run + 1 : 1;
      expect(run).toBeLessThanOrEqual(4);
    }
  }
  if (!relaxed.includes(6)) {
    for (let i = 0; i + 6 <= slice.length; i += 1) {
      const bands = new Set(slice.slice(i, i + 6).map((s) => priceBandOf(s.minPriceCents)));
      expect(bands.size).toBeGreaterThanOrEqual(2);
    }
  }
  // 5 is never relaxable.
  expect(freshCount(slice)).toBeLessThanOrEqual(SELECTION.FRESH_CEILING);
}

// ---------------------------------------------------------------------------

describe('softmaxWeights — the log-sum-exp shift', () => {
  it('survives a spread that overflows a naive exp(score / 0.08)', () => {
    // The hazard, demonstrated: at T = 0.08 a naive exp(score / T) blows past
    // Number.MAX_VALUE at a score of ~57, and Infinity / (Infinity + x) is NaN.
    expect(Math.exp(60 / 0.08)).toBe(Infinity);
    expect(Infinity / (Infinity + Math.exp(-60 / 0.08))).toBeNaN();

    const w = softmaxWeights([50, -50], 0.08);
    expect(w.every((x) => Number.isFinite(x))).toBe(true);
    expect(w.some((x) => Number.isNaN(x))).toBe(false);
    expect(w[0]).toBe(1); // the max always weighs exactly exp(0)
    expect(w[1]).toBe(0); // underflow is fine: probability 0, not NaN
    expect(w.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  it('stays finite for huge but near-equal scores', () => {
    expect(Math.exp(1000 / 0.08)).toBe(Infinity); // naive: every weight Infinity
    const w = softmaxWeights([1000, 999.9, 999.8], 0.08);
    expect(w.every(Number.isFinite)).toBe(true);
    expect(w[0]).toBeGreaterThan(w[1]);
    expect(w[1]).toBeGreaterThan(w[2]);
  });

  it('handles negative scores, which this codebase produces on purpose', () => {
    const w = softmaxWeights([-0.4, -0.5, -3], 0.08);
    expect(w.every((x) => Number.isFinite(x) && x >= 0)).toBe(true);
    expect(w[0]).toBe(1);
    expect(w[0]).toBeGreaterThan(w[1]);
  });

  it('gives a non-finite score zero weight instead of poisoning the sum', () => {
    const w = softmaxWeights([1, Number.NaN, 2, Infinity, -Infinity], 0.08);
    expect(w.every(Number.isFinite)).toBe(true);
    expect(w[1]).toBe(0);
    expect(w[3]).toBe(0);
    expect(w[4]).toBe(0);
    expect(w[2]).toBe(1); // 2 is the largest finite score
  });

  it('collapses to greedy at temperature 0', () => {
    expect(softmaxWeights([0.1, 0.9, 0.5], 0)).toEqual([0, 1, 0]);
    expect(softmaxWeights([0.1, 0.9, 0.5], Number.NaN)).toEqual([0, 1, 0]);
  });

  it('returns an all-zero vector when nothing is finite', () => {
    expect(softmaxWeights([Number.NaN, Infinity], 0.08)).toEqual([0, 0]);
  });
});

describe('sampleIndex', () => {
  it('maps the unit interval onto the cumulative distribution', () => {
    const weights = [1, 1, 2]; // 25% / 25% / 50%
    const at = (u: number) => sampleIndex(weights, () => u);
    expect(at(0)).toBe(0);
    expect(at(0.24)).toBe(0);
    expect(at(0.26)).toBe(1);
    expect(at(0.49)).toBe(1);
    expect(at(0.51)).toBe(2);
    expect(at(0.999999)).toBe(2);
  });

  it('consumes exactly one draw', () => {
    const c = counting(7);
    sampleIndex([1, 2, 3], c.rng);
    expect(c.draws()).toBe(1);
  });

  it('never returns a zero-weight index, even at the boundaries', () => {
    for (const u of [0, 0.5, 1, 1 - Number.EPSILON]) {
      expect(sampleIndex([1, 0, 0], () => u)).toBe(0);
      expect(sampleIndex([0, 0, 1], () => u)).toBe(2);
    }
  });

  it('tolerates an rng that misbehaves', () => {
    expect(sampleIndex([1, 1], () => Number.NaN)).toBe(0);
    expect(sampleIndex([1, 1], () => 5)).toBe(1);
    expect(sampleIndex([1, 1], () => -5)).toBe(0);
  });

  it('does not draw when no weight is positive', () => {
    const c = counting(3);
    expect(sampleIndex([0, 0], c.rng)).toBe(0);
    expect(c.draws()).toBe(0);
  });
});

describe('softmaxPick — the temperature actually does something', () => {
  const two = (a: number, b: number) => [{ score: a, id: 'hi' }, { score: b, id: 'lo' }];
  const runs = 2000;

  function winRate(a: number, b: number, temperature: number, seed = 99): number {
    const rng = mulberry32(seed);
    let hi = 0;
    for (let i = 0; i < runs; i += 1) {
      if (softmaxPick(two(a, b), temperature, rng).pick.id === 'hi') hi += 1;
    }
    return hi / runs;
  }

  // The headline property: at T = 0.08 the higher scorer wins the large
  // majority. A tolerance band, not an exact count — the point is the regime,
  // not the seed.
  it('lets the 0.9 candidate beat the 0.1 candidate the large majority of the time', () => {
    const rate = winRate(0.9, 0.1, SELECTION.SOFTMAX_TEMPERATURE);
    expect(rate).toBeGreaterThan(0.95);
    expect(rate).toBeLessThanOrEqual(1);
  });

  // Not uniform: a coin flip would sit at ~0.5 for the same pair.
  it('is not degenerating to uniform', () => {
    expect(winRate(1, 0, SELECTION.SOFTMAX_TEMPERATURE)).toBeGreaterThan(0.9);
  });

  // Not argmax: near-ties genuinely swap, which is the whole reason for
  // sampling. exp(0.02/0.08) / (1 + exp(0.02/0.08)) = 0.562.
  it('is not degenerating to argmax — near-ties swap at the predicted rate', () => {
    const rate = winRate(0.9, 0.88, SELECTION.SOFTMAX_TEMPERATURE);
    expect(rate).toBeGreaterThan(0.5);
    expect(rate).toBeLessThan(0.63);
  });

  it('collapses to argmax at temperature 0 without consuming the rng', () => {
    const c = counting(5);
    expect(softmaxPick(two(0.9, 0.88), 0, c.rng).pick.id).toBe('hi');
    expect(c.draws()).toBe(0);
  });

  it('does not draw for a pool of one', () => {
    const c = counting(5);
    const r = softmaxPick([{ score: 1 }], SELECTION.SOFTMAX_TEMPERATURE, c.rng);
    expect(r.drew).toBe(false);
    expect(c.draws()).toBe(0);
  });
});

describe('select — shape and invariants', () => {
  it('handles an empty pool without throwing', () => {
    expect(select([], ctx(), opts())).toEqual({ slice: [], relaxed: [], sampled: false });
  });

  it('handles a single-candidate pool and reports that nothing was sampled', () => {
    const only = sc({ videoId: 'only', score: 0.5 });
    const r = select([only], ctx(), opts());
    expect(ids(r.slice)).toEqual(['only']);
    expect(r.sampled).toBe(false);
  });

  it('puts the highest-scoring candidate at position 1 for every seed', () => {
    const p = pool(60);
    const top = [...p].sort((a, b) => b.score - a.score)[0];
    for (let seed = 0; seed < 40; seed += 1) {
      expect(select(p, ctx(), opts({ seed })).slice[0].videoId).toBe(top.videoId);
    }
  });

  it('never exceeds the slice size', () => {
    for (let seed = 0; seed < 10; seed += 1) {
      expect(select(pool(200), ctx(), opts({ seed })).slice.length).toBeLessThanOrEqual(20);
    }
    expect(select(pool(200), ctx(), opts({ sliceSize: 5 })).slice.length).toBe(5);
  });

  it('never emits a duplicate videoId, even when the pool contains duplicates', () => {
    const dup = sc({ videoId: 'twin', sellerId: 'a', categoryId: 'ca', score: 0.9 });
    const twin = sc({ videoId: 'twin', sellerId: 'b', categoryId: 'cb', score: 0.8 });
    const p = [dup, twin, ...pool(40)];
    for (let seed = 0; seed < 20; seed += 1) {
      const { slice } = select(p, ctx(), opts({ seed }));
      expect(new Set(ids(slice)).size).toBe(slice.length);
      expect(slice.filter((s) => s.videoId === 'twin').length).toBeLessThanOrEqual(1);
    }
  });

  it('holds every hard constraint it did not relax, across many seeds', () => {
    for (let seed = 0; seed < 40; seed += 1) {
      const { slice, relaxed } = select(pool(60), ctx(), opts({ seed }));
      assertConstraints(slice, relaxed);
    }
  });

  it('does not choke on NaN or infinite scores', () => {
    const weird = [
      sc({ videoId: 'nan', sellerId: 'a', categoryId: 'ca', score: Number.NaN }),
      sc({ videoId: 'inf', sellerId: 'b', categoryId: 'cb', score: Infinity }),
      sc({ videoId: 'ninf', sellerId: 'c', categoryId: 'cc', score: -Infinity }),
      ...pool(20),
    ];
    const { slice } = select(weird, ctx(), opts({ seed: 4 }));
    expect(slice.length).toBeGreaterThan(0);
    expect(new Set(ids(slice)).size).toBe(slice.length);
    // -Infinity sorts last, so it can only appear once real candidates run out.
    expect(slice[0].videoId).not.toBe('ninf');
  });

  it('reports sampled=false when the temperature makes it greedy, and consumes no rng', () => {
    const c = counting(11);
    const r = select(pool(60), ctx(), { rng: c.rng, temperature: 0 });
    expect(r.sampled).toBe(false);
    expect(c.draws()).toBe(0);
    expect(r.slice.length).toBe(20);
  });
});

describe('select — sampling is over the eligible set, not rejection over the full set', () => {
  // A decoy that outscores everything but position 1's own seller-mate. If the
  // sampler drew from the full pool and retried on violation, it would draw the
  // decoy essentially every time (exp((9.9 - 1)/0.08) is astronomically large)
  // and burn an unbounded number of rng values before landing anywhere legal.
  const anchor = sc({ videoId: 'anchor', sellerId: 'A', categoryId: 'ca', score: 10, minPriceCents: 1500 });
  const decoy = sc({ videoId: 'decoy', sellerId: 'A', categoryId: 'ca', score: 9.9, minPriceCents: 1500 });
  const b = sc({ videoId: 'b', sellerId: 'B', categoryId: 'cb', score: 1, minPriceCents: 4000 });
  const d = sc({ videoId: 'd', sellerId: 'D', categoryId: 'cd', score: 1, minPriceCents: 12_000 });

  it('gives a constraint-violating candidate probability 0 at that position', () => {
    for (let seed = 0; seed < 200; seed += 1) {
      // freshFloor 0 keeps this test about constraint 1 alone.
      const { slice } = select([anchor, decoy, b, d], ctx(), opts({ seed, sliceSize: 2, freshFloor: 0 }));
      expect(slice[0].videoId).toBe('anchor');
      expect(slice[1].videoId).not.toBe('decoy');
    }
  });

  it('consumes at most one rng draw per sampled position', () => {
    const c = counting(21);
    const { slice } = select([anchor, decoy, b, d], ctx(), {
      rng: c.rng, sliceSize: 2, freshFloor: 0,
    });
    expect(slice.length).toBe(2);
    expect(c.draws()).toBe(1); // exactly one contested position, exactly one draw
  });

  it('never spends more draws than positions on a full 20-slice', () => {
    const c = counting(22);
    const { slice } = select(pool(60), ctx(), { rng: c.rng });
    expect(slice.length).toBe(20);
    expect(c.draws()).toBeLessThanOrEqual(slice.length - 1);
  });
});

describe('select — determinism', () => {
  const p = pool(60);

  it('returns a byte-identical slice for the same seed and input', () => {
    const a = select(p, ctx(), opts({ seed: 4242 }));
    const b = select(p, ctx(), opts({ seed: 4242 }));
    expect(ids(a.slice)).toEqual(ids(b.slice));
    expect(a.relaxed).toEqual(b.relaxed);
    expect(a.sampled).toBe(b.sampled);
  });

  it('does not depend on the caller’s array order', () => {
    const shuffled = [...p].reverse();
    expect(ids(select(p, ctx(), opts({ seed: 7 })).slice)).toEqual(
      ids(select(shuffled, ctx(), opts({ seed: 7 })).slice)
    );
  });

  it('explores different slices for different seeds', () => {
    // 30 candidates on identical scores: pure exploration, so any two seeds
    // that agree would mean the rng is not reaching the selector.
    const flat = Array.from({ length: 30 }, (_, i) =>
      sc({
        videoId: `e${String(i).padStart(2, '0')}`,
        sellerId: `es${i}`,
        categoryId: `ec${i % 5}`,
        minPriceCents: PRICES[i % 3],
        score: 0.5,
      })
    );
    const seen = new Set<string>();
    for (let seed = 0; seed < 20; seed += 1) {
      seen.add(ids(select(flat, ctx(), opts({ seed, freshFloor: 0 })).slice).join(','));
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('select — constraint 4, the fresh floor that is never relaxed', () => {
  it('seats 3 fresh videos even when all three score worst in the pool', () => {
    const fresh = Array.from({ length: 3 }, (_, i) =>
      sc({
        videoId: `f${i}`, sellerId: `fs${i}`, categoryId: `fc${i}`,
        lane: 'fresh', score: -99 - i, minPriceCents: PRICES[i % 3],
      })
    );
    const rest = Array.from({ length: 97 }, (_, i) =>
      sc({
        videoId: `r${String(i).padStart(3, '0')}`, sellerId: `rs${i % 25}`, categoryId: `rc${i % 6}`,
        lane: 'trending', score: 1 - i / 100, minPriceCents: PRICES[i % 3],
      })
    );
    for (let seed = 0; seed < 20; seed += 1) {
      const { slice } = select([...rest, ...fresh], ctx(), opts({ seed }));
      expect(slice.length).toBe(20);
      expect(freshCount(slice)).toBeGreaterThanOrEqual(SELECTION.FRESH_FLOOR);
      // Reserved in the tail: the floor is paid out of the last slots.
      expect(slice.slice(-3).every((s) => s.lane === 'fresh')).toBe(true);
    }
  });

  it('returns a SHORT slice rather than filling a reserved fresh slot', () => {
    // 20 healthy non-fresh videos and exactly one fresh: two of the three
    // reserved slots can never be filled, so the slice must come back at 18.
    const p = [
      ...Array.from({ length: 20 }, (_, i) =>
        sc({
          videoId: `n${String(i).padStart(2, '0')}`, sellerId: `ns${i}`, categoryId: `nc${i % 6}`,
          lane: 'trending', score: 1 - i / 100, minPriceCents: PRICES[i % 3],
        })
      ),
      sc({ videoId: 'lonefresh', sellerId: 'lf', categoryId: 'lfc', lane: 'fresh', score: -50, minPriceCents: 12_000 }),
    ];
    for (let seed = 0; seed < 10; seed += 1) {
      const { slice, relaxed } = select(p, ctx(), opts({ seed }));
      expect(slice.length).toBe(18); // 20 - 2 unfillable reserved slots
      expect(freshCount(slice)).toBe(1);
      expect(relaxed).not.toContain(4);
      // Nothing non-fresh was promoted into the reserved tail.
      expect(slice[slice.length - 1].videoId).toBe('lonefresh');
    }
  });

  it('keeps constraint 4 out of the relaxation ladder entirely', () => {
    expect(RELAX_ORDER).not.toContain(4 as never);
    expect(RELAX_ORDER).not.toContain(5 as never);
    // Even a pool that forces every available relaxation never lists 4.
    const starved = Array.from({ length: 20 }, (_, i) =>
      sc({
        videoId: `x${String(i).padStart(2, '0')}`, sellerId: 'only', categoryId: 'c1',
        lane: i < 2 ? 'fresh' : 'trending', score: 1 - i / 20, minPriceCents: 4000,
      })
    );
    const { slice, relaxed } = select(starved, ctx(), opts({ seed: 3 }));
    expect(relaxed).not.toContain(4);
    expect(relaxed.length).toBeGreaterThan(0);
    expect(freshCount(slice)).toBeLessThanOrEqual(2);
    expect(slice.length).toBeLessThan(20); // the missing fresh slot stays empty
  });
});

describe('select — constraint 5, the fresh ceiling', () => {
  const mostlyFresh = [
    ...Array.from({ length: 20 }, (_, i) =>
      sc({
        videoId: `mf${String(i).padStart(2, '0')}`, sellerId: `mfs${i}`, categoryId: `mfc${i % 5}`,
        lane: 'fresh', score: 1 - i / 100, minPriceCents: PRICES[i % 3],
      })
    ),
    ...Array.from({ length: 5 }, (_, i) =>
      sc({
        videoId: `mo${i}`, sellerId: `mos${i}`, categoryId: `moc${i}`,
        lane: 'trending', score: 0.5 - i / 100, minPriceCents: PRICES[i % 3],
      })
    ),
  ];

  it('caps fresh at 6 with a pool of 20 fresh and 5 non-fresh', () => {
    for (let seed = 0; seed < 25; seed += 1) {
      const { slice, relaxed } = select(mostlyFresh, ctx(), opts({ seed }));
      expect(freshCount(slice)).toBe(SELECTION.FRESH_CEILING);
      // 6 fresh + the 5 non-fresh is everything the ceiling permits.
      expect(slice.length).toBe(11);
      // The slice being short of 20 is a ceiling effect, not a failure to try:
      // relaxing constraints could not have added a 12th video.
      expect(relaxed).toEqual([]);
      assertConstraints(slice, relaxed);
    }
  });

  it('caps fresh at 6 even when the pool is nothing but fresh', () => {
    const allFresh = Array.from({ length: 30 }, (_, i) =>
      sc({
        videoId: `af${String(i).padStart(2, '0')}`, sellerId: `afs${i}`, categoryId: `afc${i % 5}`,
        lane: 'fresh', score: 1 - i / 100, minPriceCents: PRICES[i % 3],
      })
    );
    for (let seed = 0; seed < 10; seed += 1) {
      const { slice } = select(allFresh, ctx(), opts({ seed }));
      expect(slice.length).toBe(SELECTION.FRESH_CEILING);
      expect(freshCount(slice)).toBe(SELECTION.FRESH_CEILING);
    }
  });

  it('raises a ceiling set below the floor rather than making the floor unsatisfiable', () => {
    const { slice } = select(pool(60), ctx(), opts({ freshCeiling: 1, freshFloor: 3 }));
    expect(freshCount(slice)).toBeGreaterThanOrEqual(3);
  });
});

describe('select — the impression-budget queue jump', () => {
  const owedBudget: ImpressionBudget = {
    impressionsDelivered: 12,
    budgetTotal: IMPRESSION_BUDGET_TOTAL,
    windowStart: new Date('2026-08-18T00:00:00Z'),
    satisfied: false,
  };

  const nonFresh = [5, 4, 3].map((score, i) =>
    sc({
      videoId: `nf${i}`, sellerId: `nfs${i}`, categoryId: `nfc${i}`,
      lane: 'trending', score, minPriceCents: PRICES[i % 3],
    })
  );
  const richFresh = [2.0, 1.9, 1.8, 1.7].map((score, i) =>
    sc({
      videoId: `rf${i}`, sellerId: `rfs${i}`, categoryId: `rfc${i}`,
      lane: 'fresh', score, minPriceCents: PRICES[i % 3],
    })
  );
  const owedFresh = sc({
    videoId: 'owed', sellerId: 'owedSeller', categoryId: 'owedCat',
    lane: 'fresh', score: -5, minPriceCents: 12_000, budget: owedBudget,
  });

  it('derives the owed set from each candidate’s own budget', () => {
    expect(isBudgetOwed(owedFresh)).toBe(true);
    expect(isBudgetOwed(richFresh[0])).toBe(false);
    expect(isBudgetOwed({ ...owedFresh, budget: { ...owedBudget, satisfied: true } })).toBe(false);
    expect(
      isBudgetOwed({ ...owedFresh, budget: { ...owedBudget, impressionsDelivered: IMPRESSION_BUDGET_TOTAL } })
    ).toBe(false);
    // The 48h window only closes the guarantee when a clock is supplied.
    expect(isBudgetOwed(owedFresh, new Date('2026-08-19T00:00:00Z'))).toBe(true);
    expect(isBudgetOwed(owedFresh, new Date('2026-08-21T00:00:00Z'))).toBe(false);
    expect(budgetOwedIds([...richFresh, owedFresh])).toEqual(new Set(['owed']));
  });

  it('lets an owed video jump into a reserved fresh slot ahead of better-scoring fresh', () => {
    const p = [...nonFresh, ...richFresh, owedFresh];
    for (let seed = 0; seed < 30; seed += 1) {
      const { slice } = select(p, ctx(), opts({ seed, sliceSize: 6 }));
      expect(ids(slice)).toContain('owed');
      // It never outranks its way into the body of the slice: the first
      // reserved slot is index 3 and that is exactly where it lands.
      expect(ids(slice).indexOf('owed')).toBe(3);
      expect(slice.slice(0, 3).every((s) => s.lane !== 'fresh')).toBe(true);
    }
  });

  it('gives an owed video no queue jump outside the reserved fresh slots', () => {
    // Same shape, but the owed video is not in the fresh lane, so no reserved
    // slot will take it and its score has to earn the place. It cannot.
    const owedTrending = sc({
      videoId: 'owedTrending', sellerId: 'ots', categoryId: 'otc',
      lane: 'trending', score: -5, minPriceCents: 4000, budget: owedBudget,
    });
    const p = [...nonFresh, ...richFresh, owedTrending];
    for (let seed = 0; seed < 30; seed += 1) {
      const { slice } = select(p, ctx(), opts({ seed, sliceSize: 6 }));
      expect(ids(slice)).not.toContain('owedTrending');
    }
  });

  it('still honours the ceiling when the whole pool is owed', () => {
    const owedPool = Array.from({ length: 30 }, (_, i) =>
      sc({
        videoId: `ow${String(i).padStart(2, '0')}`, sellerId: `ows${i}`, categoryId: `owc${i % 5}`,
        lane: 'fresh', score: 1 - i / 100, minPriceCents: PRICES[i % 3],
        budget: { ...owedBudget, impressionsDelivered: i },
      })
    );
    for (let seed = 0; seed < 10; seed += 1) {
      const { slice } = select(owedPool, ctx(), opts({ seed }));
      expect(freshCount(slice)).toBeLessThanOrEqual(SELECTION.FRESH_CEILING);
      expect(slice.length).toBe(SELECTION.FRESH_CEILING);
    }
  });

  it('accepts an explicit owed set that overrides the candidates’ own budgets', () => {
    const p = [...nonFresh, ...richFresh, owedFresh];
    const { slice } = select(p, ctx(), opts({ sliceSize: 6, budgetOwed: new Set(['rf3']) }));
    // rf3 is the worst-scoring rich-fresh video; the override hands it the
    // first reserved slot and demotes the (still fresh) 'owed' video.
    expect(ids(slice)[3]).toBe('rf3');
  });
});

describe('select — constraint 7, at least one unseen seller', () => {
  it('includes a seller the viewer has never seen', () => {
    const p = pool(60);
    const seen = new Set(p.slice(0, 8).map((c) => c.sellerId));
    for (let seed = 0; seed < 20; seed += 1) {
      const { slice, relaxed } = select(p, ctx({ seenSellerIds: seen }), opts({ seed }));
      if (!relaxed.includes(7)) {
        expect(slice.some((s) => !seen.has(s.sellerId))).toBe(true);
      }
    }
  });

  it('substitutes an unseen seller in when every placed video came from a seen one', () => {
    const seenSellers = Array.from({ length: 16 }, (_, i) => `seen${i}`);
    const seenVideos = Array.from({ length: 32 }, (_, i) =>
      sc({
        videoId: `sv${String(i).padStart(2, '0')}`, sellerId: seenSellers[i % 16], categoryId: `svc${i % 6}`,
        lane: i % 9 === 0 ? 'fresh' : 'trending', score: 1 - i / 100, minPriceCents: PRICES[i % 3],
      })
    );
    const stranger = sc({
      videoId: 'stranger', sellerId: 'stranger', categoryId: 'strangerCat',
      lane: 'trending', score: 0.001, minPriceCents: 4000,
    });
    const seen = new Set(seenSellers);
    for (let seed = 0; seed < 20; seed += 1) {
      const { slice, relaxed } = select([...seenVideos, stranger], ctx({ seenSellerIds: seen }), opts({ seed }));
      expect(slice.some((s) => s.sellerId === 'stranger')).toBe(true);
      // The repair never touches position 1 and never breaks another constraint.
      expect(slice[0].videoId).toBe('sv00');
      expect(slice[0].sellerId).not.toBe('stranger');
      assertConstraints(slice, relaxed);
    }
  });

  it('never spends a fresh-floor video to satisfy the unseen-seller rule', () => {
    // The only unseen seller is non-fresh, and exactly 3 fresh videos exist —
    // swapping one out to make room would break the floor, so the repair must
    // pick a non-fresh victim (or decline).
    const seenSellers = ['a', 'b', 'c', 'd', 'e'];
    const body = Array.from({ length: 10 }, (_, i) =>
      sc({
        videoId: `bd${i}`, sellerId: seenSellers[i % 5], categoryId: `bdc${i % 4}`,
        lane: 'trending', score: 1 - i / 100, minPriceCents: PRICES[i % 3],
      })
    );
    const fresh = Array.from({ length: 3 }, (_, i) =>
      sc({
        videoId: `fr${i}`, sellerId: seenSellers[i], categoryId: `frc${i}`,
        lane: 'fresh', score: -1 - i, minPriceCents: PRICES[i % 3],
      })
    );
    const stranger = sc({
      videoId: 'str2', sellerId: 'zz', categoryId: 'zzc', lane: 'trending',
      score: -20, minPriceCents: 4000,
    });
    for (let seed = 0; seed < 15; seed += 1) {
      const { slice } = select([...body, ...fresh, stranger], ctx({ seenSellerIds: new Set(seenSellers) }),
        opts({ seed, sliceSize: 10 }));
      expect(freshCount(slice)).toBeGreaterThanOrEqual(SELECTION.FRESH_FLOOR);
    }
  });
});

describe('select — relaxation', () => {
  it('relaxes in the documented order, starting with 6', () => {
    // Every candidate sits in the same price band, so constraint 6 becomes
    // unsatisfiable the moment a 6-video window forms.
    const oneBand = Array.from({ length: 40 }, (_, i) =>
      sc({
        videoId: `ob${String(i).padStart(2, '0')}`, sellerId: `obs${i % 20}`, categoryId: `obc${i % 6}`,
        lane: i % 7 === 0 ? 'fresh' : 'trending', score: 1 - i / 40, minPriceCents: 4000,
      })
    );
    for (let seed = 0; seed < 15; seed += 1) {
      const { slice, relaxed } = select(oneBand, ctx(), opts({ seed }));
      expect(relaxed[0]).toBe(6);
      expect(relaxed).toEqual(RELAX_ORDER.slice(0, relaxed.length));
      expect(slice.length).toBe(20);
    }
  });

  it('walks the full ladder in order when the pool is hostile, and never past it', () => {
    const starved = Array.from({ length: 30 }, (_, i) =>
      sc({
        videoId: `hs${String(i).padStart(2, '0')}`, sellerId: 'sole', categoryId: 'onecat',
        lane: i < 4 ? 'fresh' : 'trending', score: 1 - i / 30, minPriceCents: 4000,
      })
    );
    const { relaxed } = select(starved, ctx(), opts({ seed: 8 }));
    expect(relaxed).toEqual([...RELAX_ORDER]);
    expect(relaxed).not.toContain(4);
  });

  it('does not relax anything when the first pass already fills the slice', () => {
    for (let seed = 0; seed < 20; seed += 1) {
      const { slice, relaxed } = select(pool(120), ctx(), opts({ seed }));
      expect(slice.length).toBe(20);
      expect(relaxed).toEqual([]);
    }
  });

  it('reports the relaxations that actually produced the returned slice', () => {
    // Each rebuild resamples, so a later pass can come back shorter; whatever
    // is reported must match the slice that was returned.
    for (let seed = 0; seed < 25; seed += 1) {
      const { slice, relaxed } = select(pool(24), ctx(), opts({ seed }));
      expect(relaxed).toEqual(RELAX_ORDER.slice(0, relaxed.length));
      assertConstraints(slice, relaxed);
    }
  });
});
