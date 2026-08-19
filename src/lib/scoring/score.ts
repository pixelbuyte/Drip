import {
  affinitySignal, commerceSignal, diversityBonus, engagementSignal,
  fatiguePenalty, freshnessSignal, qualityPenalty, trustSignal,
} from './signals';
import type {
  Candidate, CategoryMedians, RecentContext, ScoredCandidate, ViewerProfile, Weights,
} from './types';

/**
 * Scores are deliberately NOT clamped to [0,1]. A heavily penalized video must
 * remain orderable below a zero-score one, or every bad video ties at 0 and
 * their relative order becomes arbitrary.
 *
 * `medians` replaces v1's `priors` in the same position and is the same object:
 * a category median is both the Bayesian prior for a rate and, at 2.5x, its
 * normalisation reference. The v1 alias `CategoryPriors` still names this type.
 *
 * Pure: `now` is the only clock, and nothing here samples.
 */
export function scoreCandidate(
  c: Candidate,
  v: ViewerProfile,
  ctx: RecentContext,
  w: Weights,
  medians: CategoryMedians,
  now: Date,
  thinCategoryMultiplier = 1
): ScoredCandidate {
  const components = {
    commerce: commerceSignal(c, w, medians),
    engagement: engagementSignal(c, w, medians),
    affinity: affinitySignal(c, v, w),
    freshness: freshnessSignal(c.publishedAt, now, w, thinCategoryMultiplier),
    trust: trustSignal(c.trust, w),
    diversity: diversityBonus(c, ctx),
    fatigue: fatiguePenalty(c, ctx),
    quality: qualityPenalty(c, w, medians),
  };

  const score =
    w.wCommerce * components.commerce +
    w.wEngagement * components.engagement +
    w.wAffinity * components.affinity +
    w.wFreshness * components.freshness +
    w.wTrust * components.trust +
    w.wDiversity * components.diversity -
    w.pFatigue * components.fatigue -
    w.pQuality * components.quality;

  return { ...c, score, components };
}

export function scoreAll(
  cs: Candidate[],
  v: ViewerProfile,
  ctx: RecentContext,
  w: Weights,
  medians: CategoryMedians,
  now: Date
): ScoredCandidate[] {
  return cs.map((c) => scoreCandidate(c, v, ctx, w, medians, now));
}
