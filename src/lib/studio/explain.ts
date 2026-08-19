/**
 * Studio — the honest algorithm panel (spec 7.4).
 *
 * This file turns one video's ranking into a ranked list of plain-English
 * reasons the feed is treating it the way it is. It is the answer to the only
 * question a seller actually has after an upload: *why*.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO RULES. THEY ARE THE WHOLE DESIGN.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 1. NEVER HIDE A PENALTY.
 *
 *    If a video is being suppressed for a high skip rate, this says so, in
 *    those words, with the number. The alternative is a seller who believes
 *    they have been shadowbanned — and they will be right that something
 *    happened and wrong about what, which is the worst possible combination.
 *
 *    Enforced by construction: {@link explainVideo} accounts for EVERY factor
 *    exactly once, across `helping`, `hurting` and `skipped`. A factor cannot
 *    quietly vanish because it was embarrassing; if it is not in a list, the
 *    output is wrong and {@link FACTOR_ORDER} makes that testable.
 *
 * 2. NEVER LET IT READ AS A SCOLDING.
 *
 *    "31% skip rate" is an accusation. "31% skip rate — the first frame is
 *    your biggest lever" is coaching. Every negative therefore carries a
 *    lever, and that is enforced by the TYPE, not by a convention someone can
 *    forget. See "HOW THE LEVER RULE IS ENFORCED" below.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW THE LEVER RULE IS ENFORCED — three independent locks
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   LOCK 1 — the authoring type. Every factor's copy is written as a
 *   {@link FactorSpec}, whose `hurting` member must return a
 *   {@link NegativeVerdict}: `{ label, detail, lever }`, all required. There
 *   is no way to write a negative detail and not write its lever, because the
 *   function's return type will not typecheck without one. The copy table is
 *   `Record<FactorKey, ...>`, so adding a factor key without writing both
 *   halves is also a compile error.
 *
 *   LOCK 2 — the result type. {@link HurtingFactor} declares `lever: string`
 *   (required), and {@link HelpingFactor} declares `lever?: never` so a lever
 *   cannot be parked on the wrong side of the panel either. `hurting` on the
 *   explanation is `HurtingFactor[]`, so every consumer — the panel included —
 *   gets a non-optional `lever` on every element it renders. A screen
 *   physically cannot list a penalty with nothing to do about it.
 *
 *   LOCK 3 — private construction. Both variants carry a module-private
 *   `unique symbol` brand. Outside this file the brand cannot be named, so a
 *   factor cannot be forged as an object literal at all: the only doors are
 *   {@link helpingFactor} and {@link hurtingFactor}, and the latter takes the
 *   lever as a required argument and throws on a blank one. (An `as any` cast
 *   still defeats it. Nothing in TypeScript survives a deliberate lie; this
 *   stops the accidental one, which is the failure that actually happens.)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * BOUNDARY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * NOTHING here imports `@/lib/scoring`. That module's component shape is free
 * to change; this one takes {@link AlgorithmInput} — seller-facing facts in
 * Studio's own conventions (`*Pct` percentage points, `*Cents` integer cents,
 * ISO-8601 strings for time, `null` means unknown) — and the caller does the
 * mapping. The weights below are a deliberate COPY of spec 2.2, not an
 * import, so a weight change over there is a decision to re-make here rather
 * than a silent behaviour change in the seller's explanation.
 *
 * PURE. No clock (`now` is an explicit parameter), no randomness, no I/O.
 * Two identical inputs produce two identical explanations, forever.
 *
 * PLAIN SELLER LANGUAGE ONLY. Nothing in the rendered strings says signal,
 * component, gate, lane, candidate, softmax or Bayesian. A seller reads
 * "people who tap are buying at 2x normal".
 */

import { money, pct, ratioLabel, sinceLabel } from './format';
import { FRESHNESS_HALF_LIFE_HOURS } from './types';

/* ═══════════════════════════════════════════════════════════════════════════
   FACTORS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Every reason the feed can give. Stable machine keys, so the panel can pick
 * an icon or a tone without string-matching the copy.
 */
export type FactorKey =
  | 'conversion'
  | 'watch_through'
  | 'skip_rate'
  | 'freshness'
  | 'ships_fast'
  | 'price_fit'
  | 'same_category'
  | 'flagged';

/**
 * Canonical order. Used as the tie-break when two factors move the score by
 * the same amount, so the same input always renders the same list, and used
 * by the tests to assert that every factor is accounted for.
 */
export const FACTOR_ORDER: readonly FactorKey[] = [
  'conversion',
  'watch_through',
  'skip_rate',
  'freshness',
  'ships_fast',
  'price_fit',
  'same_category',
  'flagged',
] as const;

/* ═══════════════════════════════════════════════════════════════════════════
   THE OUTPUT TYPES

   LOCK 2 and LOCK 3 live here.
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Module-private brand. `declare` means it exists only in the type system —
 * there is no runtime property, nothing to serialise, nothing to strip when
 * this crosses the server/client boundary as a prop.
 *
 * It is NOT exported, so no other module can write the key, so no other
 * module can produce a `HelpingFactor` or a `HurtingFactor` by hand.
 */
declare const FACTOR_BRAND: unique symbol;

/** A reason the feed is pushing this video up. Never carries a lever. */
export type HelpingFactor = {
  readonly [FACTOR_BRAND]: 'helping';
  key: FactorKey;
  direction: 'helping';
  /** Short noun phrase: "Conversion", "Freshness", "Ships fast". */
  label: string;
  /** The sentence under the label, with the number in it. */
  detail: string;
  /**
   * Score points this factor is worth, positive. Ordering and debugging only
   * — NEVER render it. "Commerce component 0.326" is exactly the language
   * this panel exists to replace.
   */
  contribution: number;
  /** A helping factor has nothing to fix, so it may not carry a lever. */
  lever?: never;
};

/**
 * A reason the feed is holding this video back.
 *
 * `lever` is required, and that is the point: the type makes an accusation
 * without a next step unrepresentable.
 */
export type HurtingFactor = {
  readonly [FACTOR_BRAND]: 'hurting';
  key: FactorKey;
  direction: 'hurting';
  label: string;
  detail: string;
  /** Score points, negative. Ordering and debugging only — never render it. */
  contribution: number;
  /** The one thing the seller can change. Always present, never blank. */
  lever: string;
};

export type AlgorithmFactor = HelpingFactor | HurtingFactor;

/**
 * Why a factor is in neither list.
 *
 * `'unmeasured'` — we do not have the number, or not enough views stand
 * behind it to say anything honest.
 * `'neutral'` — we DO have the number, and it is neither helping nor hurting.
 *
 * Both are published rather than dropped. A seller who can see that skip rate
 * is simply not judged yet does not invent a punishment that was never
 * applied.
 */
export type SkippedFactor = {
  key: FactorKey;
  label: string;
  reason: 'unmeasured' | 'neutral';
  /** Plain English, rendered verbatim. */
  note: string;
};

export type AlgorithmExplanation = {
  videoId: string;
  /** The raw score, unclamped, exactly as the ranker produced it. */
  score: number;
  /** Two decimals: "0.71". Negative scores render honestly as "-0.08". */
  scoreLabel: string;
  /** Percentile rank among live videos, 0-100 percentage points. */
  percentilePct: number | null;
  /** "top 22% of live videos". `null` when it could not be ranked. */
  percentileLabel: string | null;
  /** Strongest first. */
  helping: HelpingFactor[];
  /**
   * Strongest first. An EMPTY array is a real, common and honest answer —
   * a video that is strong everywhere has nothing wrong with it, and
   * inventing a weakness to fill the column is a lie.
   */
  hurting: HurtingFactor[];
  /** Everything in neither list, with the reason. Never silently dropped. */
  skipped: SkippedFactor[];
};

/* ═══════════════════════════════════════════════════════════════════════════
   THE AUTHORING TYPES

   LOCK 1 lives here. `NegativeVerdict.lever` is what makes a lever-less
   penalty impossible to write in the first place.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Copy for a factor that is helping. */
export type Verdict = {
  label: string;
  detail: string;
};

/**
 * Copy for a factor that is hurting. `lever` is required.
 *
 * This is the type every negative sentence in Studio has to pass through, and
 * it is why "31% leave in under 2 seconds" can never ship on its own.
 */
export type NegativeVerdict = {
  label: string;
  detail: string;
  /** The one thing the seller can change. Required. */
  lever: string;
};

/**
 * One factor's definition: how to measure it, how far off neutral that
 * reading is, and what to say in each direction.
 *
 * `M` is the factor's own measurement shape, so `helping` and `hurting` read
 * numbers that are already resolved and cannot disagree with `deviation`
 * about what they are describing.
 */
type FactorSpec<M> = {
  /** Direction-neutral name, used when the factor is not affecting anything. */
  name: string;
  /**
   * Score points at a full-strength reading, per direction. Asymmetric where
   * the ranker itself is asymmetric — posting variety earns a 0.05 bonus,
   * but repeating a category costs a 0.15 penalty, and pretending those are
   * the same number would mis-rank the list.
   */
  weight: { up: number; down: number };
  /**
   * True when the reading is a rate measured over this video's impressions,
   * so it means nothing until {@link MIN_RATE_EVIDENCE} of them exist.
   * Exactly the ranker's own division between gated and exact inputs.
   */
  needsViews: boolean;
  /** `null` when we cannot measure this factor at all. */
  measure: (input: AlgorithmInput) => M | null;
  /** -1 (as bad as it gets) to +1 (as good as it gets). 0 is neutral. */
  deviation: (m: M) => number;
  helping: (m: M) => Verdict;
  /** Must return a lever. There is no overload without one. */
  hurting: (m: M) => NegativeVerdict;
};

/** `FactorSpec` with its measurement type erased, so the table is uniform. */
type ResolvedFactor = {
  name: string;
  weight: { up: number; down: number };
  needsViews: boolean;
  evaluate: (
    input: AlgorithmInput
  ) => { deviation: number; helping: Verdict; hurting: NegativeVerdict } | null;
};

/**
 * Closes over the measurement type and evaluates BOTH directions eagerly.
 *
 * Eager on purpose: there is no code path where a hurting verdict is built
 * later, conditionally, by someone who might skip the lever. The lever is
 * computed at the same instant as the accusation or neither exists.
 */
function factor<M>(spec: FactorSpec<M>): ResolvedFactor {
  return {
    name: spec.name,
    weight: spec.weight,
    needsViews: spec.needsViews,
    evaluate: (input) => {
      const m = spec.measure(input);
      if (m === null) return null;
      return {
        deviation: clampDeviation(spec.deviation(m)),
        helping: spec.helping(m),
        hurting: spec.hurting(m),
      };
    },
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE INPUT

   Studio conventions, not the ranker's. `*Pct` is percentage points, `*Cents`
   is integer cents, time is an ISO-8601 string, and `null` means "we do not
   know" — which is a first-class answer here, not an error.
   ═══════════════════════════════════════════════════════════════════════════ */

/** A measured rate and the category median it is judged against. */
export type Benchmarked = {
  /** Percentage points. 31 means 31%. */
  valuePct: number;
  /**
   * Percentage points. `null` when the category has too few videos to have an
   * honest median — and a zero median is not a reference either, so both
   * suppress the comparison rather than fabricate one.
   */
  medianPct: number | null;
};

export type AlgorithmInput = {
  videoId: string;
  /**
   * The ranker's score. Deliberately unclamped there, so deliberately
   * unclamped here.
   */
  score: number;
  /**
   * Percentile rank among live videos, 0-100 percentage points: 78 means it
   * scores at or above 78% of them, which reads as "top 22%".
   * `null` when it could not be ranked at all.
   */
  percentilePct: number | null;
  /** ISO-8601. When it went live. */
  postedAt: string;
  /** ISO-8601. The clock, passed in. Nothing in this file reads one. */
  now: string;
  /** Impressions the rate factors below were measured over. */
  impressions: number;

  /** Buyers per tap, against the category median. */
  conversion: Benchmarked | null;
  /**
   * Watched to the end, against the category median.
   *
   * Pass `null` unless the completion counter is genuinely being written —
   * see the note in `funnel.ts` about `rollup_video_stats()` counting `q95`
   * against a client that emits `95`. A factor we cannot measure is reported
   * as unmeasured; it is never quietly scored as zero.
   */
  watchThrough: Benchmarked | null;
  /** Left inside two seconds, against the category median. Higher is worse. */
  fastSkip: Benchmarked | null;
  /** Hid it or reported it, against the category median. Higher is worse. */
  flagged: Benchmarked | null;

  /** Whole days from order to dispatch, and what is normal on the platform. */
  dispatch: { days: number; medianDays: number | null } | null;
  /** This video's price against the band this seller's shoppers buy in. */
  price: { priceCents: number; p25Cents: number; p75Cents: number } | null;
  /**
   * How many of this seller's most recent posts, counting this one, are in
   * the same category. 1 means this is the only one.
   */
  categoryRun: { inARow: number; categoryLabel: string | null } | null;
};

/* ═══════════════════════════════════════════════════════════════════════════
   THRESHOLDS AND WEIGHTS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Impressions before a rate is allowed to say anything. Mirrors the ranker's
 * own evidence threshold, and matches `MIN_FUNNEL_IMPRESSIONS` — a fifth of
 * the reach guarantee. Under this, rate factors are reported as unmeasured
 * rather than scored, because a 100% conversion rate over three views is not
 * a strength and a 60% skip rate over three views is not a penalty.
 */
export const MIN_RATE_EVIDENCE = 100;

/**
 * Score points a factor has to move before it is worth a line on the panel.
 *
 * This is what makes an empty "what's hurting" column possible and honest: a
 * video whose every reading is at or above neutral genuinely has nothing in
 * that column, and the alternative — always naming a "weakest" factor — turns
 * a good report into a manufactured complaint.
 */
export const MIN_CONTRIBUTION = 0.01;

/**
 * How far above the median counts as full marks. 2.5x, mirroring the ranker's
 * normalisation reference: at the median a factor is neutral, and the top of
 * the scale is reserved for genuine outperformance rather than handed to
 * anything merely average.
 */
const FULL_MARKS_RATIO = 2.5;

/* ═══════════════════════════════════════════════════════════════════════════
   SMALL MATHS — all pure, all total
   ═══════════════════════════════════════════════════════════════════════════ */

function isNum(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

function clampDeviation(d: number): number {
  if (!Number.isFinite(d)) return 0;
  return Math.max(-1, Math.min(1, d));
}

/**
 * A ratio against the category median, mapped to -1..1.
 *
 *   1x    ->  0     (dead on the median: neither helping nor hurting)
 *   2.5x+ -> +1     (full marks, at the ranker's own reference)
 *   0.4x  -> -0.6
 *   0x    -> -1
 *
 * Asymmetric because the underlying scale is: a rate can be 2.5 times the
 * median, but it cannot be 2.5 times *below* it — the floor is zero.
 */
function ratioDeviation(ratio: number): number {
  if (!isNum(ratio) || ratio < 0) return 0;
  if (ratio >= 1) return Math.min(1, (ratio - 1) / (FULL_MARKS_RATIO - 1));
  return Math.max(-1, ratio - 1);
}

/** `null` when there is no honest comparison to draw. */
function benchRatio(b: Benchmarked | null): number | null {
  if (!b || !isNum(b.valuePct) || !isNum(b.medianPct) || b.medianPct <= 0) return null;
  if (b.valuePct < 0) return null;
  return b.valuePct / b.medianPct;
}

/**
 * Percentage points, with a tenth kept only where it carries information —
 * the same rule `deltaLabel` uses in `format.ts`. "6.0%" states a precision
 * the number does not have, and "0%" for a 0.2% report rate hides one it does.
 */
function ratePhrase(n: number): string {
  const small = Math.abs(n) < 10;
  const hasTenth = Math.round(n * 10) % 10 !== 0;
  return pct(n, small && hasTenth ? 1 : 0);
}

/** Hours between two ISO strings. `null` when either is unparseable. */
function hoursBetween(fromIso: string, toIso: string): number | null {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return (to - from) / 3_600_000;
}

/** "same-day", "1-day", "4-day". */
function dispatchPhrase(days: number): string {
  return days <= 0 ? 'same-day' : `${Math.round(days)}-day`;
}

/**
 * Where a price sits in the band the seller's shoppers actually buy in.
 * 1 inside the band, decaying to 0 at 3x the top and 0.3x the bottom — the
 * same shape the feed uses, restated here so this file owns its own copy.
 */
function priceFit(priceCents: number, p25: number, p75: number): number {
  if (priceCents >= p25 && priceCents <= p75) return 1;
  if (priceCents > p75) {
    const zero = 3 * p75;
    if (priceCents >= zero) return 0;
    return 1 - (priceCents - p75) / (zero - p75);
  }
  const zero = 0.3 * p25;
  if (priceCents <= zero) return 0;
  return (priceCents - zero) / (p25 - zero);
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE COPY

   Every sentence a seller reads is in this table. Keeping them together is
   the only way to hear the panel's whole tone at once — and the tone is the
   product. Read the `hurting` column top to bottom: not one line of it is a
   telling-off.
   ═══════════════════════════════════════════════════════════════════════════ */

const FACTORS: Record<FactorKey, ResolvedFactor> = {
  /* ── Conversion — the reason this platform exists ────────────────────── */
  conversion: factor<{ ratio: number }>({
    name: 'Conversion',
    weight: { up: 0.35, down: 0.35 },
    needsViews: true,
    measure: (i) => {
      const ratio = benchRatio(i.conversion);
      return ratio === null ? null : { ratio };
    },
    deviation: (m) => ratioDeviation(m.ratio),
    helping: (m) => ({
      label: 'Conversion',
      detail: `people who tap are buying at ${ratioLabel(m.ratio)} normal`,
    }),
    hurting: (m) => ({
      label: 'Conversion',
      detail: `people tap, then don't buy — ${ratioLabel(m.ratio)} the normal rate`,
      lever:
        'the product page is where they stop — the price, the photos and the delivered total are what they read there',
    }),
  }),

  /* ── Watch-through ───────────────────────────────────────────────────── */
  watch_through: factor<{ ratio: number; valuePct: number; medianPct: number }>({
    name: 'Watch-through',
    weight: { up: 0.2, down: 0.2 },
    needsViews: true,
    measure: (i) => {
      const ratio = benchRatio(i.watchThrough);
      if (ratio === null || !i.watchThrough || i.watchThrough.medianPct === null) return null;
      return {
        ratio,
        valuePct: i.watchThrough.valuePct,
        medianPct: i.watchThrough.medianPct,
      };
    },
    deviation: (m) => ratioDeviation(m.ratio),
    helping: (m) => ({
      label: 'Watch-through',
      detail: `${ratePhrase(m.valuePct)} watch it to the end, against ${ratePhrase(m.medianPct)} normal`,
    }),
    hurting: (m) => ({
      label: 'Watch-through',
      detail: `${ratePhrase(m.valuePct)} watch it to the end, against ${ratePhrase(m.medianPct)} normal`,
      lever: 'cut the middle — show what it is, show it in use, stop',
    }),
  }),

  /* ── Skip rate — the strongest negative in the system ─────────────────── */
  skip_rate: factor<{ ratio: number; valuePct: number; medianPct: number }>({
    name: 'Skip rate',
    // Half of the ranker's quality penalty, which is weighted -0.25.
    weight: { up: 0.125, down: 0.125 },
    needsViews: true,
    measure: (i) => {
      const ratio = benchRatio(i.fastSkip);
      if (ratio === null || !i.fastSkip || i.fastSkip.medianPct === null) return null;
      return { ratio, valuePct: i.fastSkip.valuePct, medianPct: i.fastSkip.medianPct };
    },
    // Inverted: a HIGH skip rate is a LOW score.
    deviation: (m) => -ratioDeviation(m.ratio),
    helping: (m) => ({
      label: 'Holds attention',
      detail: `only ${ratePhrase(m.valuePct)} leave in under 2 seconds, against ${ratePhrase(m.medianPct)} normal`,
    }),
    hurting: (m) => ({
      label: 'Skip rate',
      detail: `${ratePhrase(m.valuePct)} leave in under 2 seconds`,
      lever: 'the first frame is your biggest lever',
    }),
  }),

  /* ── Freshness ───────────────────────────────────────────────────────── */
  freshness: factor<{ hours: number; postedAt: string; nowMs: number }>({
    name: 'Freshness',
    weight: { up: 0.1, down: 0.1 },
    needsViews: false,
    measure: (i) => {
      const hours = hoursBetween(i.postedAt, i.now);
      const nowMs = Date.parse(i.now);
      if (hours === null || Number.isNaN(nowMs)) return null;
      return { hours: Math.max(0, hours), postedAt: i.postedAt, nowMs };
    },
    // Exactly the ranker's decay, re-centred: full marks at zero hours,
    // neutral at one half-life, and falling away after that.
    deviation: (m) =>
      2 * Math.exp((-Math.LN2 * m.hours) / FRESHNESS_HALF_LIFE_HOURS) - 1,
    helping: (m) => ({
      label: 'Freshness',
      detail: `posted ${sinceLabel(m.postedAt, m.nowMs)}`,
    }),
    hurting: (m) => ({
      label: 'Freshness',
      detail: `posted ${sinceLabel(m.postedAt, m.nowMs)} — reach halves every ${FRESHNESS_HALF_LIFE_HOURS} hours`,
      lever: 'post again — a new video starts at full reach, and this one cannot go back',
    }),
  }),

  /* ── Dispatch speed ──────────────────────────────────────────────────── */
  ships_fast: factor<{ ratio: number; days: number; medianDays: number }>({
    name: 'Dispatch time',
    weight: { up: 0.1, down: 0.1 },
    needsViews: false,
    measure: (i) => {
      const d = i.dispatch;
      if (!d || !isNum(d.days) || d.days < 0 || !isNum(d.medianDays) || d.medianDays <= 0) {
        return null;
      }
      return { ratio: d.days / d.medianDays, days: d.days, medianDays: d.medianDays };
    },
    // Inverted: MORE days is worse.
    deviation: (m) => -ratioDeviation(m.ratio),
    helping: (m) => ({
      label: 'Ships fast',
      detail: `your ${dispatchPhrase(m.days)} dispatch is above average`,
    }),
    hurting: (m) => ({
      label: 'Dispatch time',
      detail: `orders take ${Math.round(m.days)} days to go out, against ${Math.round(m.medianDays)} normally`,
      lever: 'buy the label the day the order lands — this one clears itself once you do',
    }),
  }),

  /* ── Price fit ───────────────────────────────────────────────────────── */
  price_fit: factor<{ fit: number; priceCents: number; p25: number; p75: number }>({
    name: 'Price fit',
    // The price slice of the ranker's affinity term: 0.20 x 0.25.
    weight: { up: 0.05, down: 0.05 },
    needsViews: false,
    measure: (i) => {
      const p = i.price;
      if (!p || !isNum(p.priceCents) || !isNum(p.p25Cents) || !isNum(p.p75Cents)) return null;
      if (p.p25Cents <= 0 || p.p75Cents < p.p25Cents) return null;
      return {
        fit: priceFit(p.priceCents, p.p25Cents, p.p75Cents),
        priceCents: p.priceCents,
        p25: p.p25Cents,
        p75: p.p75Cents,
      };
    },
    deviation: (m) => 2 * m.fit - 1,
    helping: (m) => ({
      label: 'Price fit',
      detail: `at ${money(m.priceCents)} it sits right where your shoppers already spend`,
    }),
    hurting: (m) =>
      m.priceCents > m.p75
        ? {
            label: 'Price',
            detail: `at ${money(m.priceCents)} it is above what most of your shoppers spend (${money(m.p25)} to ${money(m.p75)})`,
            lever: `put something nearer ${money(m.p75)} in the same video so it can reach more of them`,
          }
        : {
            label: 'Price',
            detail: `at ${money(m.priceCents)} it is below what most of your shoppers spend (${money(m.p25)} to ${money(m.p75)})`,
            lever: `show it alongside something nearer ${money(m.p25)} so the video lands with the people who buy at that price`,
          },
  }),

  /* ── Posting the same category over and over ─────────────────────────── */
  same_category: factor<{ inARow: number; categoryLabel: string | null }>({
    name: 'Category mix',
    // Asymmetric, exactly as the ranker is: variety earns the 0.05 diversity
    // bonus, repetition pays the 0.15 fatigue penalty.
    weight: { up: 0.05, down: 0.15 },
    needsViews: false,
    measure: (i) => {
      const r = i.categoryRun;
      if (!r || !isNum(r.inARow) || r.inARow < 1) return null;
      return { inARow: Math.round(r.inARow), categoryLabel: r.categoryLabel };
    },
    // 1 in a row is a mild positive, 2 is neutral, and it falls away from
    // there: five of the same thing in a row is as self-competing as it gets.
    deviation: (m) =>
      m.inARow <= 1 ? 0.5 : -Math.min(1, (m.inARow - 2) / 3),
    helping: () => ({
      label: 'Fresh mix',
      detail: 'nothing else of yours is competing for the same viewers',
    }),
    hurting: (m) => ({
      label: 'Same category',
      detail: m.categoryLabel
        ? `you've posted ${m.inARow} ${m.categoryLabel} videos in a row, so they compete for the same viewers`
        : `you've posted ${m.inARow} videos in a row in the same category, so they compete for the same viewers`,
      lever: 'post something from a different category next, or space these out by a day',
    }),
  }),

  /* ── Hidden or reported ──────────────────────────────────────────────── */
  flagged: factor<{ ratio: number; valuePct: number; medianPct: number }>({
    name: 'Hidden or reported',
    // The other half of the quality penalty.
    weight: { up: 0.125, down: 0.125 },
    needsViews: true,
    measure: (i) => {
      const ratio = benchRatio(i.flagged);
      if (ratio === null || !i.flagged || i.flagged.medianPct === null) return null;
      return { ratio, valuePct: i.flagged.valuePct, medianPct: i.flagged.medianPct };
    },
    // Inverted: more people hiding it is worse.
    deviation: (m) => -ratioDeviation(m.ratio),
    helping: (m) => ({
      label: 'Nobody hides it',
      detail: `${ratePhrase(m.valuePct)} hide it or report it, against ${ratePhrase(m.medianPct)} normal`,
    }),
    hurting: (m) => ({
      label: 'Hidden or reported',
      detail: `${ratePhrase(m.valuePct)} of viewers hid it or reported it, against ${ratePhrase(m.medianPct)} normal`,
      lever:
        'check the caption and the hashtags match what is actually in the video — a mismatch is what people hide',
    }),
  }),
};

/* ═══════════════════════════════════════════════════════════════════════════
   THE CONSTRUCTORS

   LOCK 3. These are the only doors into a factor.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Build a helping factor. Positive contribution, no lever. */
export function helpingFactor(
  key: FactorKey,
  verdict: Verdict,
  contribution: number
): HelpingFactor {
  return {
    key,
    direction: 'helping',
    label: verdict.label,
    detail: verdict.detail,
    contribution,
  } as HelpingFactor;
}

/**
 * Build a hurting factor.
 *
 * `verdict` is a {@link NegativeVerdict}, so a caller cannot omit the lever
 * and typecheck. The runtime guard covers the one case the type cannot: a
 * lever that is present but empty, which would render as an accusation with a
 * blank line under it — the exact failure this whole design exists to stop.
 */
export function hurtingFactor(
  key: FactorKey,
  verdict: NegativeVerdict,
  contribution: number
): HurtingFactor {
  if (typeof verdict.lever !== 'string' || verdict.lever.trim() === '') {
    throw new Error(
      `Refusing to build the "${key}" penalty: every negative factor must carry a lever. ` +
        `"${verdict.detail}" on its own is an accusation, not coaching.`
    );
  }
  return {
    key,
    direction: 'hurting',
    label: verdict.label,
    detail: verdict.detail,
    contribution,
    lever: verdict.lever,
  } as HurtingFactor;
}

/* ═══════════════════════════════════════════════════════════════════════════
   PERCENTILE
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * "top 22% of live videos" / "bottom 10% of live videos".
 *
 *   percentileLabel(99) -> "top 1% of live videos"
 *   percentileLabel(78) -> "top 22% of live videos"
 *   percentileLabel(50) -> "top 50% of live videos"
 *   percentileLabel(10) -> "bottom 10% of live videos"
 *   percentileLabel(0)  -> "bottom 1% of live videos"
 *   percentileLabel(null) -> null
 *
 * `percentilePct` is the share of live videos this one scores at or above, in
 * percentage points, so "top" is its complement.
 *
 * The half that is smaller is the half that gets named: at or above the
 * midpoint it is a "top" statement, below it a "bottom" one. Both are
 * rounded to a whole percent and floored at 1 — "top 0%" is not a thing, and
 * a video in the 99.7th percentile is honestly described as top 1%.
 */
export function percentileLabel(percentilePct: number | null | undefined): string | null {
  if (!isNum(percentilePct)) return null;
  const p = Math.max(0, Math.min(100, percentilePct));
  const top = 100 - p;
  const share = top <= 50 ? top : p;
  const side = top <= 50 ? 'top' : 'bottom';
  return `${side} ${Math.max(1, Math.round(share))}% of live videos`;
}

/** Two decimals, sign kept. The number beside "Score" on the panel. */
export function scoreLabel(score: number): string {
  if (!isNum(score)) return '—';
  return score.toFixed(2);
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE EXPLANATION
   ═══════════════════════════════════════════════════════════════════════════ */

/** The note under a factor that could not be judged. */
function unmeasuredNote(needsViews: boolean, impressions: number): string {
  if (needsViews && impressions < MIN_RATE_EVIDENCE) {
    const seen = Math.max(0, Math.round(impressions));
    return `not enough views yet — ${seen} of the ${MIN_RATE_EVIDENCE} it takes to judge this`;
  }
  return 'we do not have this number yet';
}

/**
 * Turn one video's ranking into what the seller reads.
 *
 * THE ACCOUNTING GUARANTEE: every key in {@link FACTOR_ORDER} appears exactly
 * once across `helping`, `hurting` and `skipped`. Nothing can be dropped for
 * being awkward, and nothing can be counted twice to pad a column.
 *
 * Ranking is by absolute contribution — how many score points the factor is
 * actually moving — with {@link FACTOR_ORDER} as the tie-break, so identical
 * inputs always produce an identical list.
 */
export function explainVideo(input: AlgorithmInput): AlgorithmExplanation {
  const helping: HelpingFactor[] = [];
  const hurting: HurtingFactor[] = [];
  const skipped: SkippedFactor[] = [];

  const impressions = isNum(input.impressions) ? input.impressions : 0;

  for (const key of FACTOR_ORDER) {
    const spec = FACTORS[key];

    // A rate with too little behind it is not evidence, in either direction.
    // Suppressing it BOTH ways is the honest move: it stops a lucky first day
    // reading as a strength and a thin one reading as a punishment.
    const gated = spec.needsViews && impressions < MIN_RATE_EVIDENCE;
    const reading = gated ? null : spec.evaluate(input);

    if (reading === null) {
      skipped.push({
        key,
        label: spec.name,
        reason: 'unmeasured',
        note: unmeasuredNote(spec.needsViews, impressions),
      });
      continue;
    }

    const weight = reading.deviation >= 0 ? spec.weight.up : spec.weight.down;
    const contribution = weight * reading.deviation;

    if (Math.abs(contribution) < MIN_CONTRIBUTION) {
      skipped.push({
        key,
        label: spec.name,
        reason: 'neutral',
        note: 'measured, and it is neither helping nor hurting right now',
      });
      continue;
    }

    if (contribution > 0) {
      helping.push(helpingFactor(key, reading.helping, contribution));
    } else {
      hurting.push(hurtingFactor(key, reading.hurting, contribution));
    }
  }

  return {
    videoId: input.videoId,
    score: input.score,
    scoreLabel: scoreLabel(input.score),
    percentilePct: isNum(input.percentilePct) ? input.percentilePct : null,
    percentileLabel: percentileLabel(input.percentilePct),
    helping: rank(helping),
    hurting: rank(hurting),
    skipped,
  };
}

/**
 * Strongest first, by how far the factor actually moves the score.
 * {@link FACTOR_ORDER} breaks ties so the output is stable.
 */
function rank<T extends AlgorithmFactor>(factors: T[]): T[] {
  return [...factors].sort((a, b) => {
    const byWeight = Math.abs(b.contribution) - Math.abs(a.contribution);
    if (byWeight !== 0) return byWeight;
    return FACTOR_ORDER.indexOf(a.key) - FACTOR_ORDER.indexOf(b.key);
  });
}
