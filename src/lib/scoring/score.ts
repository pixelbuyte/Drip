import {
  affinitySignal, commerceSignal, diversityBonus, engagementSignal,
  fatiguePenalty, freshnessSignal, qualityPenalty, trustSignal,
} from './signals';
import type {
  Candidate, CategoryPriors, RecentContext, ScoredCandidate, ViewerProfile, Weights,
} from './types';

/**
 * Scores are deliberately NOT clamped to [0,1]. A heavily penalized video must
 * remain orderable below a zero-score one, or every bad video ties at 0 and
 * their relative order becomes arbitrary.
 */
export function scoreCandidate(
  c: Candidate,
  v: ViewerProfile,
  ctx: RecentContext,
  w: Weights,
  priors: CategoryPriors,
  now: Date,
  thinCategoryMultiplier = 1
): ScoredCandidate {
  const components = {
    commerce: commerceSignal(c, w, priors),
    engagement: engagementSignal(c, w),
    affinity: affinitySignal(c, v, w),
    freshness: freshnessSignal(c.publishedAt, now, w, thinCategoryMultiplier),
    trust: trustSignal(c.trust, w),
    diversity: diversityBonus(c, ctx),
    fatigue: fatiguePenalty(c, ctx),
    quality: qualityPenalty(c, w),
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
  priors: CategoryPriors,
  now: Date
): ScoredCandidate[] {
  return cs.map((c) => scoreCandidate(c, v, ctx, w, priors, now));
}
