import { describe, expect, it } from 'vitest';
import {
  FACTOR_ORDER,
  MIN_CONTRIBUTION,
  MIN_RATE_EVIDENCE,
  explainVideo,
  helpingFactor,
  hurtingFactor,
  percentileLabel,
  scoreLabel,
  type AlgorithmInput,
  type FactorKey,
  type HelpingFactor,
  type HurtingFactor,
  type NegativeVerdict,
  type Verdict,
} from '../explain';

/* ═══════════════════════════════════════════════════════════════════════════
   FIXTURES

   `base` is a video we know nothing about: every factor null, so a test about
   ONE factor is never accidentally a test about the other seven.
   ═══════════════════════════════════════════════════════════════════════════ */

const POSTED = '2026-08-19T09:00:00Z';
/** Three hours after POSTED. Every fixture uses this pair; nothing reads a clock. */
const NOW = '2026-08-19T12:00:00Z';

const base = (over: Partial<AlgorithmInput> = {}): AlgorithmInput => ({
  videoId: 'vid_1',
  score: 0.71,
  percentilePct: 78,
  postedAt: POSTED,
  now: NOW,
  impressions: 500,
  conversion: null,
  watchThrough: null,
  fastSkip: null,
  flagged: null,
  dispatch: null,
  price: null,
  categoryRun: null,
  ...over,
});

/** Spec 7.4's worked example, reproduced input for input. */
const SPEC_EXAMPLE = base({
  conversion: { valuePct: 4, medianPct: 2 },
  fastSkip: { valuePct: 31, medianPct: 15 },
  dispatch: { days: 1, medianDays: 2 },
  categoryRun: { inARow: 3, categoryLabel: 'apparel' },
});

/** Strong on every measurable factor. */
const STRONG_EVERYWHERE = base({
  conversion: { valuePct: 5, medianPct: 2 },
  watchThrough: { valuePct: 62, medianPct: 40 },
  fastSkip: { valuePct: 6, medianPct: 24 },
  flagged: { valuePct: 0.2, medianPct: 2 },
  dispatch: { days: 1, medianDays: 3 },
  price: { priceCents: 4200, p25Cents: 3000, p75Cents: 6000 },
  categoryRun: { inARow: 1, categoryLabel: 'ceramics' },
});

/** Weak on every measurable factor, and stale besides. */
const WEAK_EVERYWHERE = base({
  score: -0.14,
  percentilePct: 4,
  postedAt: '2026-08-14T12:00:00Z', // 5 days before NOW
  conversion: { valuePct: 0.4, medianPct: 2 },
  watchThrough: { valuePct: 9, medianPct: 40 },
  fastSkip: { valuePct: 58, medianPct: 24 },
  flagged: { valuePct: 7, medianPct: 2 },
  dispatch: { days: 8, medianDays: 2 },
  price: { priceCents: 44000, p25Cents: 3000, p75Cents: 6000 },
  categoryRun: { inARow: 6, categoryLabel: 'apparel' },
});

const keysOf = (fs: { key: FactorKey }[]) => fs.map((f) => f.key);
const detailFor = (fs: { key: FactorKey; detail: string }[], key: FactorKey) =>
  fs.find((f) => f.key === key)?.detail;

/* ═══════════════════════════════════════════════════════════════════════════
   RULE 2, ENFORCED STRUCTURALLY — a negative factor without a lever cannot
   be constructed.

   The three locks, each tested where it actually lives.
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * LOCK 1 and LOCK 2 are compile-time. This function is never called; `tsc
 * --noEmit` is the assertion, and every `@ts-expect-error` below FAILS THE
 * BUILD if the error it expects ever stops happening. That is what makes the
 * rule enforcement rather than convention.
 */
function _compileTimeLocks(): void {
  // LOCK 1 — the authoring type every negative sentence passes through.
  // @ts-expect-error — a negative verdict without a lever does not typecheck.
  const noLever: NegativeVerdict = {
    label: 'Skip rate',
    detail: '31% leave in under 2 seconds',
  };

  // A positive verdict needs no lever, and that is the only asymmetry.
  const positive: Verdict = { label: 'Freshness', detail: 'posted 3h ago' };

  // LOCK 2 — the result type. `lever` is required on the hurting variant...
  // @ts-expect-error — `lever` is missing.
  const missing: HurtingFactor = {
    key: 'skip_rate',
    direction: 'hurting',
    label: 'Skip rate',
    detail: '31% leave in under 2 seconds',
    contribution: -0.09,
  };

  // ...and forbidden on the helping one, so it cannot be parked out of sight.
  const misplaced: HelpingFactor = {
    key: 'freshness',
    direction: 'helping',
    label: 'Freshness',
    detail: 'posted 3h ago',
    contribution: 0.09,
    // @ts-expect-error — a helping factor may not carry a lever.
    lever: 'post again',
  };

  // LOCK 3 — the brand is module-private, so even a COMPLETE literal cannot
  // be forged from outside `explain.ts`. The constructors are the only door.
  // @ts-expect-error — the brand cannot be named here.
  const forged: HurtingFactor = {
    key: 'skip_rate',
    direction: 'hurting',
    label: 'Skip rate',
    detail: '31% leave in under 2 seconds',
    contribution: -0.09,
    lever: 'the first frame is your biggest lever',
  };

  void noLever;
  void positive;
  void missing;
  void misplaced;
  void forged;
}

describe('the lever rule is structural, not conventional', () => {
  it('refuses to build a penalty with no lever at all', () => {
    const build = () =>
      hurtingFactor(
        'skip_rate',
        // @ts-expect-error — LOCK 1: `lever` is required. This is the
        // compile-time failure; the throw below is the runtime backstop for
        // JS callers and for anyone who reached for a cast.
        { label: 'Skip rate', detail: '31% leave in under 2 seconds' },
        -0.09
      );
    expect(build).toThrow(/lever/i);
  });

  it('refuses a lever that is present but blank', () => {
    expect(() =>
      hurtingFactor(
        'skip_rate',
        { label: 'Skip rate', detail: '31% leave in under 2 seconds', lever: '   ' },
        -0.09
      )
    ).toThrow(/lever/i);
  });

  it('names the factor and quotes the accusation when it refuses', () => {
    expect(() =>
      hurtingFactor(
        'conversion',
        { label: 'Conversion', detail: 'people tap, then do not buy', lever: '' },
        -0.2
      )
    ).toThrow(/conversion/i);
  });

  it('builds a penalty that does carry one', () => {
    const f = hurtingFactor(
      'skip_rate',
      {
        label: 'Skip rate',
        detail: '31% leave in under 2 seconds',
        lever: 'the first frame is your biggest lever',
      },
      -0.09
    );
    expect(f.direction).toBe('hurting');
    expect(f.lever).toBe('the first frame is your biggest lever');
  });

  it('builds a helping factor with no lever on it', () => {
    const f = helpingFactor('freshness', { label: 'Freshness', detail: 'posted 3h ago' }, 0.09);
    expect(f.direction).toBe('helping');
    expect(f.lever).toBeUndefined();
  });

  it('every penalty the explainer emits carries a non-blank lever', () => {
    for (const input of [SPEC_EXAMPLE, WEAK_EVERYWHERE, STRONG_EVERYWHERE]) {
      const { hurting } = explainVideo(input);
      for (const f of hurting) {
        expect(f.lever.trim().length).toBeGreaterThan(0);
        // A lever is an instruction, not a restatement of the number.
        expect(f.lever).not.toBe(f.detail);
      }
    }
  });

  it('never puts a lever on something that is helping', () => {
    const { helping } = explainVideo(STRONG_EVERYWHERE);
    expect(helping.length).toBeGreaterThan(0);
    for (const f of helping) expect(f.lever).toBeUndefined();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   RULE 1 — NEVER HIDE A PENALTY
   ═══════════════════════════════════════════════════════════════════════════ */

describe('nothing is hidden', () => {
  it('accounts for every factor exactly once, across all three lists', () => {
    for (const input of [base(), SPEC_EXAMPLE, STRONG_EVERYWHERE, WEAK_EVERYWHERE]) {
      const e = explainVideo(input);
      const seen = [...keysOf(e.helping), ...keysOf(e.hurting), ...keysOf(e.skipped)].sort();
      expect(seen).toEqual([...FACTOR_ORDER].sort());
    }
  });

  it('says the skip rate out loud, in those words, with the number', () => {
    const { hurting } = explainVideo(SPEC_EXAMPLE);
    expect(detailFor(hurting, 'skip_rate')).toBe('31% leave in under 2 seconds');
  });

  it('keeps naming the penalty even when the video is otherwise excellent', () => {
    const e = explainVideo({
      ...STRONG_EVERYWHERE,
      fastSkip: { valuePct: 44, medianPct: 20 },
    });
    expect(keysOf(e.hurting)).toContain('skip_rate');
    expect(detailFor(e.hurting, 'skip_rate')).toBe('44% leave in under 2 seconds');
  });

  it('names what it could not judge instead of dropping it', () => {
    // A brand-new video: the reach guarantee has barely started.
    const e = explainVideo(base({ impressions: 12, fastSkip: { valuePct: 80, medianPct: 20 } }));
    const skipped = e.skipped.find((s) => s.key === 'skip_rate');
    expect(skipped).toBeDefined();
    expect(skipped?.reason).toBe('unmeasured');
    expect(skipped?.note).toContain('12');
    expect(skipped?.note).toContain(String(MIN_RATE_EVIDENCE));
    // ...and it is not scored in EITHER direction on that little evidence.
    expect(keysOf(e.hurting)).not.toContain('skip_rate');
    expect(keysOf(e.helping)).not.toContain('skip_rate');
  });

  it('distinguishes "not measured" from "measured and neutral"', () => {
    const e = explainVideo(
      base({
        // Dead on the category median: measured, and moving nothing.
        conversion: { valuePct: 2, medianPct: 2 },
      })
    );
    expect(e.skipped.find((s) => s.key === 'conversion')?.reason).toBe('neutral');
    expect(e.skipped.find((s) => s.key === 'flagged')?.reason).toBe('unmeasured');
  });

  it('treats a missing or zero category median as no comparison, not a zero score', () => {
    for (const median of [null, 0]) {
      const e = explainVideo(base({ conversion: { valuePct: 9, medianPct: median } }));
      expect(e.skipped.find((s) => s.key === 'conversion')?.reason).toBe('unmeasured');
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   THE SPEC'S WORKED EXAMPLE
   ═══════════════════════════════════════════════════════════════════════════ */

describe("spec 7.4's example panel", () => {
  const e = explainVideo(SPEC_EXAMPLE);

  it('renders the score and the percentile as written', () => {
    expect(e.scoreLabel).toBe('0.71');
    expect(e.percentileLabel).toBe('top 22% of live videos');
  });

  it("lists what's helping in the order the spec shows", () => {
    expect(keysOf(e.helping)).toEqual(['conversion', 'freshness', 'ships_fast']);
    expect(detailFor(e.helping, 'conversion')).toBe(
      'people who tap are buying at 2x normal'
    );
    expect(detailFor(e.helping, 'freshness')).toBe('posted 3h ago');
    expect(detailFor(e.helping, 'ships_fast')).toBe('your 1-day dispatch is above average');
  });

  it("lists what's hurting in the order the spec shows, each with its lever", () => {
    expect(keysOf(e.hurting)).toEqual(['skip_rate', 'same_category']);
    expect(detailFor(e.hurting, 'skip_rate')).toBe('31% leave in under 2 seconds');
    expect(e.hurting[0].lever).toBe('the first frame is your biggest lever');
    expect(detailFor(e.hurting, 'same_category')).toBe(
      "you've posted 3 apparel videos in a row, so they compete for the same viewers"
    );
    expect(e.hurting[1].lever.length).toBeGreaterThan(0);
  });

  it('falls back to plain language when the category has no name', () => {
    const e2 = explainVideo(
      base({ categoryRun: { inARow: 4, categoryLabel: null } })
    );
    expect(detailFor(e2.hurting, 'same_category')).toBe(
      "you've posted 4 videos in a row in the same category, so they compete for the same viewers"
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   RANKING
   ═══════════════════════════════════════════════════════════════════════════ */

describe('factors rank by absolute contribution', () => {
  it('orders the helping list strongest first', () => {
    const { helping } = explainVideo(STRONG_EVERYWHERE);
    const weights = helping.map((f) => Math.abs(f.contribution));
    expect(weights).toEqual([...weights].sort((a, b) => b - a));
    expect(helping.length).toBeGreaterThan(2);
  });

  it('orders the hurting list strongest first', () => {
    const { hurting } = explainVideo(WEAK_EVERYWHERE);
    const weights = hurting.map((f) => Math.abs(f.contribution));
    expect(weights).toEqual([...weights].sort((a, b) => b - a));
    expect(hurting.length).toBeGreaterThan(2);
  });

  it('puts the bigger mover first even when the smaller one reads worse', () => {
    // Conversion at 0.2x is a smaller PERCENTAGE miss than a 5-in-a-row
    // category run is a count, but it moves the score far more.
    const e = explainVideo(
      base({
        conversion: { valuePct: 0.4, medianPct: 2 },
        categoryRun: { inARow: 5, categoryLabel: 'apparel' },
      })
    );
    expect(keysOf(e.hurting)).toEqual(['conversion', 'same_category']);
  });

  it('breaks ties in the canonical factor order, so output is stable', () => {
    // Two factors on identical footing: same deviation, same weight.
    const e = explainVideo(
      base({
        fastSkip: { valuePct: 48, medianPct: 24 },
        flagged: { valuePct: 4, medianPct: 2 },
      })
    );
    expect(e.hurting[0].contribution).toBeCloseTo(e.hurting[1].contribution, 10);
    expect(keysOf(e.hurting)).toEqual(['skip_rate', 'flagged']);
  });

  it('drops anything moving the score less than the noise floor', () => {
    const e = explainVideo(base({ conversion: { valuePct: 2.05, medianPct: 2 } }));
    expect(keysOf(e.helping)).not.toContain('conversion');
    expect(e.skipped.find((s) => s.key === 'conversion')?.reason).toBe('neutral');
    // The floor is a real published number, not a magic literal in here.
    expect(MIN_CONTRIBUTION).toBeGreaterThan(0);
  });

  it('signs contributions: helping positive, hurting negative', () => {
    const e = explainVideo(SPEC_EXAMPLE);
    for (const f of e.helping) expect(f.contribution).toBeGreaterThan(0);
    for (const f of e.hurting) expect(f.contribution).toBeLessThan(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   THE TWO EXTREMES
   ═══════════════════════════════════════════════════════════════════════════ */

describe('a video that is strong everywhere', () => {
  const e = explainVideo(STRONG_EVERYWHERE);

  it('yields an honest EMPTY hurting list rather than an invented weakness', () => {
    expect(e.hurting).toEqual([]);
  });

  it('still accounts for every factor, so the empty column is provable', () => {
    const seen = [...keysOf(e.helping), ...keysOf(e.skipped)].sort();
    expect(seen).toEqual([...FACTOR_ORDER].sort());
  });

  it('says the good things with their numbers', () => {
    expect(detailFor(e.helping, 'skip_rate')).toBe(
      'only 6% leave in under 2 seconds, against 24% normal'
    );
    expect(detailFor(e.helping, 'watch_through')).toBe(
      '62% watch it to the end, against 40% normal'
    );
    expect(detailFor(e.helping, 'price_fit')).toBe(
      'at $42.00 it sits right where your shoppers already spend'
    );
  });
});

describe('a video that is weak everywhere', () => {
  const e = explainVideo(WEAK_EVERYWHERE);

  it('gets a lever on every single negative', () => {
    expect(e.hurting.length).toBeGreaterThanOrEqual(6);
    for (const f of e.hurting) {
      expect(typeof f.lever).toBe('string');
      expect(f.lever.trim().length).toBeGreaterThan(0);
    }
  });

  it('gives every negative its OWN lever — no one instruction repeated', () => {
    const levers = e.hurting.map((f) => f.lever);
    expect(new Set(levers).size).toBe(levers.length);
  });

  it('does not pretend anything is helping', () => {
    expect(e.helping).toEqual([]);
  });

  it('renders a negative score honestly instead of flooring it at zero', () => {
    expect(e.scoreLabel).toBe('-0.14');
    expect(e.percentileLabel).toBe('bottom 4% of live videos');
  });

  it('tells a stale video to post again rather than to fix this one', () => {
    expect(detailFor(e.hurting, 'freshness')).toBe(
      'posted 5d ago — reach halves every 72 hours'
    );
    expect(e.hurting.find((f) => f.key === 'freshness')?.lever).toContain('post again');
  });
});

describe('a video we know nothing about', () => {
  const e = explainVideo(base({ impressions: 0, percentilePct: null }));

  it('claims only the one thing it actually knows', () => {
    // Freshness is a subtraction of two timestamps, not a sampled rate, so it
    // is knowable on a video with zero views. Everything else is not.
    expect(keysOf(e.helping)).toEqual(['freshness']);
    expect(e.hurting).toEqual([]);
  });

  it('lists every other factor as unmeasured, so the silence is explained', () => {
    expect(e.skipped).toHaveLength(FACTOR_ORDER.length - 1);
    for (const s of e.skipped) expect(s.reason).toBe('unmeasured');
    expect(keysOf(e.skipped)).not.toContain('freshness');
  });

  it('says how far off the evidence is, rather than going quiet', () => {
    const skip = e.skipped.find((s) => s.key === 'skip_rate');
    expect(skip?.note).toBe(
      `not enough views yet — 0 of the ${MIN_RATE_EVIDENCE} it takes to judge this`
    );
  });

  it('separates "no views yet" from "we never had this number"', () => {
    expect(e.skipped.find((s) => s.key === 'price_fit')?.note).toBe(
      'we do not have this number yet'
    );
  });

  it('renders no percentile rather than a made-up one', () => {
    expect(e.percentileLabel).toBeNull();
    expect(e.percentilePct).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   PERCENTILE PHRASING
   ═══════════════════════════════════════════════════════════════════════════ */

describe('percentile phrasing', () => {
  it('is correct at the boundaries', () => {
    expect(percentileLabel(99)).toBe('top 1% of live videos');
    expect(percentileLabel(50)).toBe('top 50% of live videos');
    expect(percentileLabel(10)).toBe('bottom 10% of live videos');
  });

  it('reads the far ends without ever saying "top 0%"', () => {
    expect(percentileLabel(100)).toBe('top 1% of live videos');
    expect(percentileLabel(99.7)).toBe('top 1% of live videos');
    expect(percentileLabel(0)).toBe('bottom 1% of live videos');
    expect(percentileLabel(0.3)).toBe('bottom 1% of live videos');
  });

  it('switches sides at the midpoint', () => {
    expect(percentileLabel(50.4)).toBe('top 50% of live videos');
    expect(percentileLabel(49.6)).toBe('bottom 50% of live videos');
  });

  it('names the smaller half in between', () => {
    expect(percentileLabel(78)).toBe('top 22% of live videos');
    expect(percentileLabel(22)).toBe('bottom 22% of live videos');
    expect(percentileLabel(90)).toBe('top 10% of live videos');
  });

  it('clamps a nonsense rank instead of printing it', () => {
    expect(percentileLabel(140)).toBe('top 1% of live videos');
    expect(percentileLabel(-20)).toBe('bottom 1% of live videos');
  });

  it('is null when there is no rank at all', () => {
    expect(percentileLabel(null)).toBeNull();
    expect(percentileLabel(undefined)).toBeNull();
    expect(percentileLabel(Number.NaN)).toBeNull();
  });

  it('formats the score to two places, sign kept', () => {
    expect(scoreLabel(0.71)).toBe('0.71');
    expect(scoreLabel(0)).toBe('0.00');
    expect(scoreLabel(-0.086)).toBe('-0.09');
    expect(scoreLabel(Number.NaN)).toBe('—');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   PRICE, DISPATCH AND THE OTHER PER-FACTOR EDGES
   ═══════════════════════════════════════════════════════════════════════════ */

describe('per-factor readings', () => {
  it('names both ends of the price band and points the right way', () => {
    const high = explainVideo(
      base({ price: { priceCents: 24000, p25Cents: 1500, p75Cents: 4000 } })
    );
    expect(detailFor(high.hurting, 'price_fit')).toBe(
      'at $240.00 it is above what most of your shoppers spend ($15.00 to $40.00)'
    );
    expect(high.hurting.find((f) => f.key === 'price_fit')?.lever).toContain('$40.00');

    const low = explainVideo(
      base({ price: { priceCents: 200, p25Cents: 4000, p75Cents: 9000 } })
    );
    expect(detailFor(low.hurting, 'price_fit')).toContain('below what most of your shoppers spend');
    expect(low.hurting.find((f) => f.key === 'price_fit')?.lever).toContain('$40.00');
  });

  it('refuses a nonsense price band rather than scoring it', () => {
    const e = explainVideo(
      base({ price: { priceCents: 4000, p25Cents: 9000, p75Cents: 1000 } })
    );
    expect(e.skipped.find((s) => s.key === 'price_fit')?.reason).toBe('unmeasured');
  });

  it('says same-day rather than 0-day dispatch', () => {
    const e = explainVideo(base({ dispatch: { days: 0, medianDays: 3 } }));
    expect(detailFor(e.helping, 'ships_fast')).toBe(
      'your same-day dispatch is above average'
    );
  });

  it('reads a slow dispatch with both numbers in it', () => {
    const e = explainVideo(base({ dispatch: { days: 9, medianDays: 2 } }));
    expect(detailFor(e.hurting, 'ships_fast')).toBe(
      'orders take 9 days to go out, against 2 normally'
    );
  });

  it('treats one post in a category as a small positive and two as neutral', () => {
    const one = explainVideo(base({ categoryRun: { inARow: 1, categoryLabel: 'ceramics' } }));
    expect(keysOf(one.helping)).toContain('same_category');
    expect(detailFor(one.helping, 'same_category')).toBe(
      'nothing else of yours is competing for the same viewers'
    );

    const two = explainVideo(base({ categoryRun: { inARow: 2, categoryLabel: 'ceramics' } }));
    expect(two.skipped.find((s) => s.key === 'same_category')?.reason).toBe('neutral');
  });

  it('keeps a tenth on a small rate and drops it on a large one', () => {
    const e = explainVideo(base({ flagged: { valuePct: 6.4, medianPct: 1.2 } }));
    expect(detailFor(e.hurting, 'flagged')).toBe(
      '6.4% of viewers hid it or reported it, against 1.2% normal'
    );
  });

  it('handles a future postedAt without inventing a decay', () => {
    const e = explainVideo(base({ postedAt: '2026-08-19T18:00:00Z' }));
    expect(detailFor(e.helping, 'freshness')).toBe('posted just now');
  });

  it('reports an unparseable timestamp as unmeasured', () => {
    const e = explainVideo(base({ postedAt: 'not-a-date' }));
    expect(e.skipped.find((s) => s.key === 'freshness')?.reason).toBe('unmeasured');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   VOICE AND PURITY
   ═══════════════════════════════════════════════════════════════════════════ */

/** Every string this module would put in front of a seller. */
function allCopy(input: AlgorithmInput): string[] {
  const e = explainVideo(input);
  return [
    e.scoreLabel,
    e.percentileLabel ?? '',
    ...e.helping.flatMap((f) => [f.label, f.detail]),
    ...e.hurting.flatMap((f) => [f.label, f.detail, f.lever]),
    ...e.skipped.flatMap((f) => [f.label, f.note]),
  ];
}

describe('it speaks seller, not ranker', () => {
  const JARGON =
    /\b(signal|component|evidence gate|gated|bayes\w*|softmax|lane|candidate|normalis\w+|normaliz\w+|shadowban\w*|impression)\b/i;

  it('uses no internal vocabulary anywhere a seller can see it', () => {
    for (const input of [base(), SPEC_EXAMPLE, STRONG_EVERYWHERE, WEAK_EVERYWHERE]) {
      for (const line of allCopy(input)) {
        expect(line).not.toMatch(JARGON);
      }
    }
  });

  it('never prints a raw contribution number in the copy', () => {
    for (const input of [SPEC_EXAMPLE, WEAK_EVERYWHERE]) {
      const e = explainVideo(input);
      for (const f of [...e.helping, ...e.hurting]) {
        expect(f.detail).not.toContain(String(f.contribution));
      }
    }
  });

  it('is deterministic — the same input twice is the same explanation', () => {
    expect(explainVideo(SPEC_EXAMPLE)).toEqual(explainVideo(SPEC_EXAMPLE));
    expect(explainVideo(WEAK_EVERYWHERE)).toEqual(explainVideo(WEAK_EVERYWHERE));
  });

  it('does not mutate its input', () => {
    const input = base({ conversion: { valuePct: 4, medianPct: 2 } });
    const snapshot = JSON.parse(JSON.stringify(input));
    explainVideo(input);
    expect(input).toEqual(snapshot);
  });

  it('carries the video id through', () => {
    expect(explainVideo(base({ videoId: 'vid_42' })).videoId).toBe('vid_42');
  });
});
