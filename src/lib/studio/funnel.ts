/**
 * Studio funnel maths (spec 7.3).
 *
 * PURE. No imports beyond the sibling contracts and formatters, no I/O, no
 * clock, no randomness. Every function here is a total function of its
 * arguments, which is the only reason the drop-off diagnosis can be trusted:
 * it is the single highest-consequence sentence in the whole dashboard, and a
 * plausible-but-wrong one wastes the one change a seller will actually make.
 *
 * THE MEASUREMENT BASIS, stated once so nothing downstream has to guess:
 *
 *   impressions  video_stats.impressions_all
 *   stayed       impressions_all - skips_under_2s_all
 *   taps         video_stats.product_taps_all
 *   addToCarts   video_stats.add_to_carts_all
 *   purchases    video_stats.purchases_all   (from ORDERS, not from events)
 *
 * `stayed` deliberately does NOT use `completions_*`. Two reasons, both
 * material:
 *
 *   1. `rollup_video_stats()` counts completions with `bucket = 'q95'`, and
 *      the client emits `String(95)` — the counter is therefore always 0.
 *      Building the second rung of the funnel on it would tell every seller
 *      that nobody watches their videos.
 *   2. Sub-2s skipping is the rung the seller can actually move, and it is
 *      the one the ranker punishes: spec 2.3 throttles a video whose 2s skip
 *      rate passes 60% with 200+ impressions. Principle 3 — never show a
 *      metric the seller cannot influence — points at the same column.
 *
 * Both the subject video and its category peers are measured this way, so
 * every ratio on the screen compares like with like.
 */

import {
  FRESHNESS_HALF_LIFE_HOURS,
  REACH_GUARANTEE_IMPRESSIONS,
  type DropOffDiagnosis,
  type FunnelStep,
  type FunnelStepKey,
  type VideoFunnel,
} from './types';
import { DASH, count, money, pct, ratioLabel } from './format';

/* ═══════════════════════════════════════════════════════════════════════════
   THRESHOLDS

   Each one exists to stop the diagnosis firing on noise. They are exported
   because the screens quote them back to the seller — "we need about 100
   impressions before this comparison means anything" is honest copy, and it
   only stays honest if the number in the sentence is the number in the code.
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Category peers required before a median is published at all. Four videos do
 * not have a median, they have an anecdote — and `FunnelStep.medianRatePct`
 * is explicitly documented to be null rather than drawn from too few videos.
 */
export const MIN_MEDIAN_SAMPLE = 5;

/**
 * Impressions on the subject video before any comparison is drawn. A fifth of
 * the reach guarantee: enough that a rate is not one person's behaviour,
 * early enough that the seller is not left staring at nothing for two days.
 */
export const MIN_FUNNEL_IMPRESSIONS = Math.round(REACH_GUARANTEE_IMPRESSIONS / 5);

/**
 * People who must have reached a rung before its conversion is diagnosable.
 * At 500 impressions a healthy funnel puts ~11 people in the cart, so this
 * cannot be much higher without making the last rung permanently undiagnosable
 * — which is exactly the rung the spec's flagship example is about.
 */
export const MIN_STEP_SAMPLE = 10;

/**
 * How far below the category median counts as a leak. Anything inside 15% is
 * inside the noise of a 500-impression sample, and "fix this" would be a
 * guess dressed as advice.
 */
export const MEANINGFUL_SHORTFALL = 0.15;

/** Shopper language, never internal language. */
export const FUNNEL_STEP_LABELS: Record<FunnelStepKey, string> = {
  impressions: 'Seen in the feed',
  watched: 'Stayed past 2 seconds',
  taps: 'Tapped the product',
  add_to_cart: 'Added to cart',
  purchases: 'Bought it',
};

/** Widest to narrowest. The order every consumer must render in. */
export const FUNNEL_ORDER: readonly FunnelStepKey[] = [
  'impressions',
  'watched',
  'taps',
  'add_to_cart',
  'purchases',
] as const;

/* ═══════════════════════════════════════════════════════════════════════════
   INPUTS
   ═══════════════════════════════════════════════════════════════════════════ */

/** One video's raw funnel, in people. See the measurement basis above. */
export type FunnelCounts = {
  impressions: number;
  /** Impressions that were not skipped inside the first two seconds. */
  stayed: number;
  taps: number;
  addToCarts: number;
  purchases: number;
};

/**
 * Extra facts that let the diagnosis name a specific cause instead of a
 * generic one. Every field is optional and every field is something the
 * schema can actually answer — nothing here is inferred from the video
 * itself, because Studio cannot watch it.
 */
export type FunnelEvidence = {
  /** `feed_events` checkout_open count. Lets the last rung be split honestly. */
  checkoutOpens?: number | null;
  /** The video is still selling something with no inventory. */
  productSoldOut?: boolean;
  /** `video_products.pinned_at_second` — when the seller pinned the product. */
  pinnedAtSecond?: number | null;
  /** Watch-percentage at which half the plays were over. From the retention curve. */
  medianDropOffPct?: number | null;
  /** `videos.duration_seconds`, for turning a percentage into a timestamp. */
  durationSeconds?: number | null;
  /** Median `orders.shipping_cents` on this video. Null until it has an order. */
  shippingChargedCents?: number | null;
  /** Median `orders.shipping_cents` across the category. */
  categoryShippingCents?: number | null;
};

export type FunnelInput = {
  videoId: string;
  counts: FunnelCounts;
  /**
   * Other live videos in the same category, measured identically. The caller
   * must exclude the subject video — a video benchmarked against itself is
   * pulled toward its own number.
   */
  peers?: readonly FunnelCounts[];
  evidence?: FunnelEvidence;
};

/**
 * Category medians, in percentage points, one per transition. `null` on any
 * of them means the category could not produce an honest median for that
 * rung — fewer than {@link MIN_MEDIAN_SAMPLE} peers had anyone reach it.
 */
export type CategoryMedians = {
  /** Median impressions, a COUNT not a rate — the spec's first row. */
  impressions: number | null;
  watchedPct: number | null;
  tapPct: number | null;
  cartPct: number | null;
  purchasePct: number | null;
  /** Peer videos the medians were drawn from. */
  sampleSize: number;
};

export const EMPTY_MEDIANS: CategoryMedians = {
  impressions: null,
  watchedPct: null,
  tapPct: null,
  cartPct: null,
  purchasePct: null,
  sampleSize: 0,
};

/* ═══════════════════════════════════════════════════════════════════════════
   SMALL MATHS
   ═══════════════════════════════════════════════════════════════════════════ */

/** Non-negative integer, or 0. Guards against nulls, NaN and negative counters. */
function n(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const rounded = Math.round(value);
  return rounded > 0 ? rounded : 0;
}

/**
 * The median of a sample. `null` for an empty sample — never 0, which would
 * read as "the category converts at zero" rather than "we do not know".
 * Even-length samples average the middle pair.
 */
export function median(values: readonly number[]): number | null {
  const usable = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (usable.length === 0) return null;
  const sorted = [...usable].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Conversion from one rung to the next, in percentage points.
 *
 * `null` when the previous rung is empty — 0 of 0 is not 0%, it is unknown.
 * Clamped at 100 because the counters do not share a de-duplication rule:
 * `viewer_video_counters` caps impressions at one per viewer per video but
 * does not cap taps, so a viewer who taps twice can legitimately produce more
 * taps than impressions. `video_stats`' own generated rate columns clamp with
 * `LEAST(x, 1)`; this matches them rather than rendering "137% tapped".
 */
export function conversionPct(from: number, to: number): number | null {
  const prev = n(from);
  if (prev <= 0) return null;
  return Math.min(100, (n(to) / prev) * 100);
}

/** `ratePct / medianRatePct`. Null unless both sides are real and the median is above 0. */
export function stepRatio(ratePct: number | null, medianRatePct: number | null): number | null {
  if (ratePct === null || medianRatePct === null) return null;
  if (!Number.isFinite(ratePct) || !Number.isFinite(medianRatePct)) return null;
  if (medianRatePct <= 0) return null;
  return ratePct / medianRatePct;
}

/* ═══════════════════════════════════════════════════════════════════════════
   MEDIANS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Category medians from the peer set.
 *
 * Each rung is averaged over only the peers that could answer it: a video
 * nobody tapped contributes no tap→cart rate, because 0 of 0 is unknown, and
 * including it as a 0% would drag every median toward zero and make every
 * seller look like a genius.
 *
 * A rung is published only when at least {@link MIN_MEDIAN_SAMPLE} peers
 * could answer it. `sampleSize` reports the peer count so a screen can say
 * "3 other videos in Footwear" rather than implying a benchmark it does not have.
 */
export function categoryMedians(peers: readonly FunnelCounts[] = []): CategoryMedians {
  if (peers.length === 0) return EMPTY_MEDIANS;

  const impressions: number[] = [];
  const watched: number[] = [];
  const tap: number[] = [];
  const cart: number[] = [];
  const purchase: number[] = [];

  for (const peer of peers) {
    impressions.push(n(peer.impressions));
    const w = conversionPct(peer.impressions, peer.stayed);
    const t = conversionPct(peer.stayed, peer.taps);
    const c = conversionPct(peer.taps, peer.addToCarts);
    const p = conversionPct(peer.addToCarts, peer.purchases);
    if (w !== null) watched.push(w);
    if (t !== null) tap.push(t);
    if (c !== null) cart.push(c);
    if (p !== null) purchase.push(p);
  }

  const enough = (sample: number[]): number | null =>
    sample.length >= MIN_MEDIAN_SAMPLE ? median(sample) : null;

  return {
    impressions: enough(impressions),
    watchedPct: enough(watched),
    tapPct: enough(tap),
    cartPct: enough(cart),
    purchasePct: enough(purchase),
    sampleSize: peers.length,
  };
}

/** The spec's first row: a count against a count, not a rate against a rate. */
export type ReachBenchmark = { medianImpressions: number | null; ratio: number | null };

export function reachBenchmark(
  impressions: number,
  medians: CategoryMedians
): ReachBenchmark {
  const med = medians.impressions;
  if (med === null || med <= 0) return { medianImpressions: med, ratio: null };
  return { medianImpressions: med, ratio: n(impressions) / med };
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE STEPS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Five rungs, widest to narrowest, each benchmarked.
 *
 * Counts are reported raw — over-delivery and double-tapping are real and
 * hiding them would be a lie. Only the RATES are clamped; see conversionPct.
 */
export function buildSteps(counts: FunnelCounts, medians: CategoryMedians): FunnelStep[] {
  const impressions = n(counts.impressions);
  const stayed = n(counts.stayed);
  const taps = n(counts.taps);
  const carts = n(counts.addToCarts);
  const purchases = n(counts.purchases);

  const rows: Array<{
    key: FunnelStepKey;
    value: number;
    ratePct: number | null;
    medianRatePct: number | null;
  }> = [
    { key: 'impressions', value: impressions, ratePct: null, medianRatePct: null },
    {
      key: 'watched',
      value: stayed,
      ratePct: conversionPct(impressions, stayed),
      medianRatePct: medians.watchedPct,
    },
    {
      key: 'taps',
      value: taps,
      ratePct: conversionPct(stayed, taps),
      medianRatePct: medians.tapPct,
    },
    {
      key: 'add_to_cart',
      value: carts,
      ratePct: conversionPct(taps, carts),
      medianRatePct: medians.cartPct,
    },
    {
      key: 'purchases',
      value: purchases,
      ratePct: conversionPct(carts, purchases),
      medianRatePct: medians.purchasePct,
    },
  ];

  return rows.map((row) => ({
    key: row.key,
    label: FUNNEL_STEP_LABELS[row.key],
    count: row.value,
    ratePct: row.ratePct,
    medianRatePct: row.medianRatePct,
    ratio: stepRatio(row.ratePct, row.medianRatePct),
  }));
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE DIAGNOSIS

   The selection rule, in one sentence: among the rungs that have a median,
   have enough people on the rung above to be more than noise, and sit at
   least MEANINGFUL_SHORTFALL below that median, pick the one with the LOWEST
   ratio to median — the worst RELATIVE drop, not the largest absolute one.

   Why relative: the largest absolute drop is impressions→watched on every
   video ever measured, because that rung starts with every impression. A
   dashboard that always says "fix your hook" is a dashboard nobody reads
   twice. Ranking by shortfall-against-peers finds the rung where this video
   is unlike other videos in its category, which is the only rung where the
   seller has something specific to change.
   ═══════════════════════════════════════════════════════════════════════════ */

export type FunnelAssessment =
  | { kind: 'no_impressions' }
  | { kind: 'too_early'; impressions: number; needed: number }
  | { kind: 'no_benchmark'; sampleSize: number; needed: number }
  | {
      kind: 'healthy';
      bestStep: FunnelStepKey;
      aboveMedianEverywhere: boolean;
      headline: string;
      detail: string;
    }
  | { kind: 'drop_off'; diagnosis: DropOffDiagnosis };

/** m:ss from seconds. `clockLabel(4)` -> "0:04". */
export function clockLabel(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return DASH;
  const whole = Math.round(seconds);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** The timestamp a watch-percentage lands on, when the duration is known. */
function atSecond(
  sharePct: number | null | undefined,
  durationSeconds: number | null | undefined
): number | null {
  if (typeof sharePct !== 'number' || !Number.isFinite(sharePct)) return null;
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds)) return null;
  if (durationSeconds <= 0) return null;
  return (durationSeconds * sharePct) / 100;
}

type Candidate = {
  step: FunnelStep;
  index: number;
  previous: FunnelStep;
  ratio: number;
  /** People lost relative to what the category median would have delivered. */
  lostVsMedian: number;
};

/**
 * The rungs eligible for diagnosis, in funnel order.
 *
 * A rung is eligible when it has a rate, has a median above zero, and had at
 * least {@link MIN_STEP_SAMPLE} people on the rung above it. The last test is
 * what stops "1 of 3 people bought, that is 33% against a 40% median, fix
 * your checkout" — advice built on two people.
 */
function candidates(steps: FunnelStep[]): Candidate[] {
  const out: Candidate[] = [];
  for (let i = 1; i < steps.length; i += 1) {
    const step = steps[i];
    const previous = steps[i - 1];
    if (step.ratio === null || step.ratePct === null || step.medianRatePct === null) continue;
    if (previous.count < MIN_STEP_SAMPLE) continue;
    out.push({
      step,
      index: i,
      previous,
      ratio: step.ratio,
      lostVsMedian: (previous.count * (step.medianRatePct - step.ratePct)) / 100,
    });
  }
  return out;
}

/**
 * Pick the leak.
 *
 * Sort key, in order:
 *   1. lowest ratio to the category median — the worst RELATIVE drop;
 *   2. most people lost versus what the median would have delivered — a real
 *      tie-break, and it prefers the rung where the loss is largest rather
 *      than an arbitrary one;
 *   3. earliest rung — fully deterministic, and fixing an early rung
 *      compounds through every rung below it.
 */
function worst(list: Candidate[]): Candidate | null {
  let best: Candidate | null = null;
  for (const candidate of list) {
    if (best === null) {
      best = candidate;
      continue;
    }
    if (candidate.ratio < best.ratio) {
      best = candidate;
    } else if (candidate.ratio === best.ratio) {
      if (candidate.lostVsMedian > best.lostVsMedian) best = candidate;
      // equal ratio AND equal loss: keep the earlier rung, already held in `best`.
    }
  }
  return best;
}

/**
 * One rung's gap, cause and lever.
 *
 * Exactly one cause and exactly one lever. A seller handed five things to
 * change learns nothing from the outcome, because they cannot tell which one
 * worked — and in practice they do none of them.
 */
function diagnose(candidate: Candidate, evidence: FunnelEvidence): DropOffDiagnosis {
  const { step, previous } = candidate;
  const rate = pct(step.ratePct, step.ratePct !== null && step.ratePct < 10 ? 1 : 0);
  const med = pct(
    step.medianRatePct,
    step.medianRatePct !== null && step.medianRatePct < 10 ? 1 : 0
  );

  if (step.key === 'watched') {
    const gapDescription =
      `${count(step.count)} of the ${count(previous.count)} people who saw this stayed past ` +
      `the first two seconds — ${rate}. The category median is ${med}, so you are keeping ` +
      `${ratioLabel(step.ratio)} as many as a typical video here.`;

    const pinned = evidence.pinnedAtSecond;
    if (typeof pinned === 'number' && Number.isFinite(pinned) && pinned >= 2) {
      return {
        step: 'watched',
        gapDescription,
        oneCause:
          `You pinned the product at ${clockLabel(pinned)}, and the people you are losing are ` +
          `gone before it arrives — they are deciding on the opening frame alone.`,
        oneLever: `Re-cut so the product is on screen at 0:00 and pin it there.`,
      };
    }

    return {
      step: 'watched',
      gapDescription,
      oneCause:
        `The opening frame is not stopping the scroll. This is also the one rung the ranker ` +
        `punishes directly: past a 60% two-second skip rate the feed stops promoting a video, ` +
        `so a weak first second costs you impressions as well as viewers.`,
      oneLever: `Start on the product filling the frame — no intro, no title card, no talking to camera first.`,
    };
  }

  if (step.key === 'taps') {
    return {
      step: 'taps',
      gapDescription:
        `${count(step.count)} of the ${count(previous.count)} people who watched opened the ` +
        `product — ${rate}. The category median is ${med}.`,
      oneCause:
        `They watched and never got a reason to tap. The product bar shows a title and a price; ` +
        `everything that creates the want has to come from the video itself.`,
      oneLever: `Show the product in use — worn, held, opened — instead of described.`,
    };
  }

  if (step.key === 'add_to_cart') {
    const gapDescription =
      `${count(step.count)} of the ${count(previous.count)} people who opened the product ` +
      `added it — ${rate}. The category median is ${med}.`;

    if (evidence.productSoldOut) {
      return {
        step: 'add_to_cart',
        gapDescription,
        oneCause: `The product is out of stock, so the sheet opens with nothing anyone can add.`,
        oneLever: `Restock it, or swap this video's product for one you can ship today.`,
      };
    }

    return {
      step: 'add_to_cart',
      gapDescription,
      oneCause:
        `They opened the sheet and did not find the detail that decides it — on Drip that is ` +
        `almost always sizing, condition or measurements.`,
      oneLever: `Add that one line to the product description — the question you get asked most.`,
    };
  }

  // purchases
  const opens = evidence.checkoutOpens;
  const hasOpens = typeof opens === 'number' && Number.isFinite(opens) && opens > 0;
  const abandoned = hasOpens ? Math.max(0, opens - step.count) : 0;

  const gapDescription = hasOpens
    ? `${count(opens)} of the ${count(previous.count)} people who added it opened checkout, and ` +
      `${count(abandoned)} did not finish. ${count(step.count)} bought — ${rate} of carts, ` +
      `against a category median of ${med}.`
    : `${count(step.count)} of the ${count(previous.count)} people who added it bought — ` +
      `${rate}. The category median is ${med}.`;

  const mine = evidence.shippingChargedCents;
  const theirs = evidence.categoryShippingCents;
  const shippingIsHigh =
    typeof mine === 'number' &&
    typeof theirs === 'number' &&
    Number.isFinite(mine) &&
    Number.isFinite(theirs) &&
    theirs > 0 &&
    mine - theirs >= 100 &&
    mine / theirs >= 1.2;

  if (shippingIsHigh) {
    return {
      step: 'purchases',
      gapDescription,
      oneCause:
        `The most common reason on Drip is shipping landing higher than expected on the last ` +
        `screen — yours is ${money(mine)}, the category median is ${money(theirs)}.`,
      oneLever:
        `Cut the package down on this product's shipping profile — the rate is priced off the ` +
        `weight and box size you entered, so a smaller box is a smaller number at checkout.`,
    };
  }

  return {
    step: 'purchases',
    gapDescription,
    oneCause:
      `Checkout is where a number they had not seen shows up: shipping and tax are added on ` +
      `that last screen, after they have already decided.`,
    oneLever: `Say the delivered price out loud in the video — "$X shipped" — so the last screen confirms instead of surprising.`,
  };
}

/**
 * What this funnel says, all in.
 *
 * Deliberately a union rather than a nullable diagnosis: "no impressions yet",
 * "too early to tell", "no category to compare against" and "nothing is
 * leaking" are four different things to put on a screen, and collapsing them
 * into one empty state is how a healthy seller ends up being shown a blank
 * box that reads as failure.
 */
export function assessFunnel(steps: FunnelStep[], evidence: FunnelEvidence = {}): FunnelAssessment {
  const impressions = steps[0]?.count ?? 0;

  if (impressions <= 0) return { kind: 'no_impressions' };

  if (impressions < MIN_FUNNEL_IMPRESSIONS) {
    return { kind: 'too_early', impressions, needed: MIN_FUNNEL_IMPRESSIONS };
  }

  const benchmarked = steps.filter((s) => s.medianRatePct !== null);
  if (benchmarked.length === 0) {
    return { kind: 'no_benchmark', sampleSize: 0, needed: MIN_MEDIAN_SAMPLE };
  }

  const eligible = candidates(steps);
  if (eligible.length === 0) {
    return { kind: 'too_early', impressions, needed: MIN_FUNNEL_IMPRESSIONS };
  }

  const leaking = eligible.filter((c) => c.ratio < 1 - MEANINGFUL_SHORTFALL);
  const worstLeak = worst(leaking);

  if (worstLeak) {
    return { kind: 'drop_off', diagnosis: diagnose(worstLeak, evidence) };
  }

  // Nothing is meaningfully below median. Say so — and give the seller the one
  // action that still applies, because a number with no implied action is
  // decoration (principle 1).
  let best = eligible[0];
  for (const candidate of eligible) {
    if (candidate.ratio > best.ratio) best = candidate;
  }
  const aboveMedianEverywhere = eligible.every((c) => c.ratio >= 1);

  return {
    kind: 'healthy',
    bestStep: best.step.key,
    aboveMedianEverywhere,
    headline: aboveMedianEverywhere
      ? 'Nothing is leaking — you are at or above the category median at every step.'
      : 'Nothing here is leaking badly enough to be worth changing.',
    detail:
      `Your strongest step is “${best.step.label.toLowerCase()}” at ` +
      `${pct(best.step.ratePct, best.step.ratePct !== null && best.step.ratePct < 10 ? 1 : 0)} ` +
      `against a category median of ` +
      `${pct(best.step.medianRatePct, best.step.medianRatePct !== null && best.step.medianRatePct < 10 ? 1 : 0)} ` +
      `— ${ratioLabel(best.ratio)}. The lever now is another video, not a fix: ranking freshness ` +
      `halves every ${FRESHNESS_HALF_LIFE_HOURS} hours, and the next thing you post starts again ` +
      `at the full ${count(REACH_GUARANTEE_IMPRESSIONS)}.`,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE WHOLE THING
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * A {@link VideoFunnel} plus everything the screen needs to explain it.
 * Structurally assignable to `VideoFunnel`, so it satisfies the shared
 * contract while carrying the extra context Studio renders around it.
 */
export type StudioVideoFunnel = VideoFunnel & {
  assessment: FunnelAssessment;
  medians: CategoryMedians;
  reach: ReachBenchmark;
};

export function buildFunnel(input: FunnelInput): StudioVideoFunnel {
  const medians = categoryMedians(input.peers ?? []);
  const steps = buildSteps(input.counts, medians);
  const assessment = assessFunnel(steps, input.evidence ?? {});

  return {
    videoId: input.videoId,
    steps,
    dropOff: assessment.kind === 'drop_off' ? assessment.diagnosis : null,
    assessment,
    medians,
    reach: reachBenchmark(input.counts.impressions, medians),
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   RETENTION

   `feed_events` carries a watch_progress event at 25/50/75/95% of the video.
   The buckets re-arm on every loop, so these are PLAYS reaching a point, not
   distinct people — the curve is labelled that way on screen rather than
   quietly presented as headcount.
   ═══════════════════════════════════════════════════════════════════════════ */

export type RetentionBuckets = { q25: number; q50: number; q75: number; q95: number };

export type RetentionPoint = {
  /** Percentage through the video. */
  atPct: number;
  /** Plays that reached this point. */
  plays: number;
  /** Share of impressions still watching, 0-100. */
  sharePct: number;
  /** Seconds into the video, when the duration is known. */
  atSeconds: number | null;
};

export type RetentionCurve = {
  /** Always five points: 0, 25, 50, 75, 95. */
  points: RetentionPoint[];
  /** Watch-percentage at which half the audience is gone. Null if half never leave. */
  medianDropOffPct: number | null;
  medianDropOffSeconds: number | null;
  /** True when more than half of the plays reached 95%. */
  mostFinish: boolean;
  /** False when there is nothing to draw. */
  hasData: boolean;
};

/**
 * The retention curve, monotonic by construction.
 *
 * Later buckets are clamped to earlier ones (and all of them to impressions):
 * a viewer who loops re-fires the buckets, so raw counts can rise as the
 * video goes on, which is an artefact of the event contract rather than
 * people rejoining a video they already left. Clamping is the honest read.
 */
export function buildRetentionCurve(
  impressions: number,
  buckets: RetentionBuckets,
  durationSeconds?: number | null
): RetentionCurve {
  const start = n(impressions);
  const duration =
    typeof durationSeconds === 'number' && Number.isFinite(durationSeconds) && durationSeconds > 0
      ? durationSeconds
      : null;

  const raw = [
    { atPct: 0, plays: start },
    { atPct: 25, plays: n(buckets.q25) },
    { atPct: 50, plays: n(buckets.q50) },
    { atPct: 75, plays: n(buckets.q75) },
    { atPct: 95, plays: n(buckets.q95) },
  ];

  let ceiling = start;
  const points: RetentionPoint[] = raw.map((point) => {
    const plays = Math.min(point.plays, ceiling);
    ceiling = plays;
    return {
      atPct: point.atPct,
      plays,
      sharePct: start > 0 ? (plays / start) * 100 : 0,
      atSeconds: atSecond(point.atPct, duration),
    };
  });

  if (start <= 0) {
    return {
      points,
      medianDropOffPct: null,
      medianDropOffSeconds: null,
      mostFinish: false,
      hasData: false,
    };
  }

  const half = start / 2;
  let medianDropOffPct: number | null = null;
  for (let i = 1; i < points.length; i += 1) {
    const before = points[i - 1];
    const here = points[i];
    if (here.plays <= half && before.plays > half) {
      const span = before.plays - here.plays;
      const share = span > 0 ? (before.plays - half) / span : 0;
      medianDropOffPct = before.atPct + (here.atPct - before.atPct) * share;
      break;
    }
  }

  const last = points[points.length - 1];
  return {
    points,
    medianDropOffPct,
    medianDropOffSeconds: atSecond(medianDropOffPct, duration),
    mostFinish: last.plays > half,
    // One bucket firing anywhere is enough to draw something honest.
    hasData: points.slice(1).some((p) => p.plays > 0),
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   TRAFFIC SOURCES

   Seller language, not internal language. `candidate_lane` is an enum the
   ranker uses; nobody outside this repository knows what "affinity" means.
   ═══════════════════════════════════════════════════════════════════════════ */

export type TrafficSourceKey =
  | 'affinity'
  | 'trending'
  | 'fresh'
  | 'social'
  | 'random'
  | 'chrono'
  | 'shared';

export type TrafficSource = {
  key: TrafficSourceKey;
  label: string;
  /** One line of honest explanation of why the feed picked this video. */
  explanation: string;
  impressions: number;
  sharePct: number;
};

const TRAFFIC_COPY: Record<TrafficSourceKey, { label: string; explanation: string }> = {
  affinity: {
    label: 'For You (matched to interests)',
    explanation: 'Shown to people whose recent taps and purchases look like your product.',
  },
  fresh: {
    label: 'New post boost',
    explanation: `The first-day guarantee — ${REACH_GUARANTEE_IMPRESSIONS} impressions every video gets, follower count ignored.`,
  },
  trending: {
    label: 'Trending',
    explanation: 'Picked up because it was converting faster than usual in the last hour.',
  },
  social: {
    label: 'Your followers',
    explanation: 'Shown to people who follow you, or who follow someone who engaged with it.',
  },
  random: {
    label: 'Discovery mix',
    explanation: 'A slice of every feed is deliberately unranked, so new sellers surface at all.',
  },
  // The naive chronological feed stamps lane 'chrono' on every impression it
  // serves — which today is 100% of feed traffic, since the ranked pipeline
  // is dark. Leaving this lane out made the sources section claim "Nothing
  // served yet" under a funnel full of impressions, or attribute the entire
  // feed audience to shared links.
  chrono: {
    label: 'Newest-first feed',
    explanation: 'Served by the launch feed, which shows the newest posts to everyone.',
  },
  shared: {
    label: 'Shared links',
    explanation: 'Opened from a link somebody sent — the only lane you can grow yourself.',
  },
};

/** Ordered by size, empties dropped. Returns [] when nothing has been served. */
export function buildTrafficSources(
  impressionsBySource: Partial<Record<TrafficSourceKey, number>>
): TrafficSource[] {
  const keys = Object.keys(TRAFFIC_COPY) as TrafficSourceKey[];
  const rows = keys.map((key) => ({ key, impressions: n(impressionsBySource[key]) }));
  const total = rows.reduce((sum, row) => sum + row.impressions, 0);
  if (total <= 0) return [];

  return rows
    .filter((row) => row.impressions > 0)
    .sort((a, b) => b.impressions - a.impressions || a.key.localeCompare(b.key))
    .map((row) => ({
      key: row.key,
      label: TRAFFIC_COPY[row.key].label,
      explanation: TRAFFIC_COPY[row.key].explanation,
      impressions: row.impressions,
      sharePct: (row.impressions / total) * 100,
    }));
}
