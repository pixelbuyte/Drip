import { bayesianRate, norm, safeRate } from './normalize';
import {
  TIER_BONUS,
  priceBandOf,
  type Candidate,
  type CandidateTrust,
  type CategoryPriors,
  type PriceBand,
  type RecentContext,
  type ViewerProfile,
  type Weights,
} from './types';

function priorsFor(c: Candidate, priors: CategoryPriors) {
  const key = c.categoryId ?? '';
  return {
    purchaseRate: priors.purchaseRate[key] ?? priors.fallback.purchaseRate,
    cartRate: priors.cartRate[key] ?? priors.fallback.cartRate,
    tapRate: priors.tapRate[key] ?? priors.fallback.tapRate,
  };
}

/** The reason this platform exists: purchase intent, not watch time. */
export function commerceSignal(c: Candidate, w: Weights, priors: CategoryPriors): number {
  const p = priorsFor(c, priors);
  const imp = c.stats.impressions24h;
  const purchase = bayesianRate(c.stats.purchases24h, imp, p.purchaseRate, w.bayesAlpha);
  const cart = bayesianRate(c.stats.addToCarts24h, imp, p.cartRate, w.bayesAlpha);
  const tap = bayesianRate(c.stats.productTaps24h, imp, p.tapRate, w.bayesAlpha);
  return (
    0.45 * norm(purchase, w.normCaps.purchaseRate) +
    0.3 * norm(cart, w.normCaps.cartRate) +
    0.25 * norm(tap, w.normCaps.tapRate)
  );
}

/**
 * Likes appear nowhere in this function, deliberately. The spec: "Explicitly do
 * not weight likes heavily. Likes are cheap and correlate poorly with purchase."
 */
export function engagementSignal(c: Candidate, w: Weights): number {
  const imp = c.stats.impressions24h;
  const completion = Math.min(1, safeRate(c.stats.completions24h, imp));
  const share = safeRate(c.stats.shares24h, imp);
  const save = safeRate(c.stats.saves24h, imp);
  return (
    0.4 * completion +
    0.25 * norm(c.stats.avgLoopCount, w.normCaps.avgLoopCount) +
    0.2 * norm(share, w.normCaps.shareRate) +
    0.15 * norm(save, w.normCaps.saveRate)
  );
}

/**
 * 1.0 inside the viewer's p25-p75 band, decaying linearly to 0 at 3x p75 and
 * 0.3x p25. Someone who buys $18 items should not get a wall of $400 items.
 * A viewer with no band yet gets 0.5 — neutral, not a zero that would bury
 * every candidate before the profile exists.
 */
export function priceBandFit(priceCents: number, band: PriceBand | null): number {
  if (!band) return 0.5;
  const { p25, p75 } = band;
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

export function affinitySignal(c: Candidate, v: ViewerProfile, w: Weights): number {
  void w;
  const category = c.categoryId ? (v.categoryAffinity[c.categoryId] ?? 0) : 0;
  const seller = v.sellerAffinity[c.sellerId] ?? 0;
  const hashtag =
    c.hashtags.length === 0
      ? 0
      : Math.min(
          1,
          c.hashtags.reduce((sum, h) => sum + (v.hashtagAffinity[h] ?? 0), 0)
        );
  return (
    0.4 * Math.min(1, category) +
    0.25 * priceBandFit(c.minPriceCents, v.priceBand) +
    0.2 * Math.min(1, seller) +
    0.15 * hashtag
  );
}

/** Exponential decay, half-life 72 hours. */
export function freshnessSignal(
  publishedAt: Date,
  now: Date,
  w: Weights,
  thinCategoryMultiplier = 1
): number {
  const hours = (now.getTime() - publishedAt.getTime()) / 3_600_000;
  if (!Number.isFinite(hours)) return 0;
  const base = Math.exp((-Math.LN2 * Math.max(0, hours)) / w.freshnessHalfLifeHours);
  return Math.min(1, base * thinCategoryMultiplier);
}

export function trustSignal(t: CandidateTrust, w: Weights): number {
  return (
    0.4 * Math.min(1, Math.max(0, t.fulfillmentScore)) +
    0.25 * (1 - Math.min(1, Math.max(0, t.disputeRate))) +
    0.2 * (t.ratingAvg === null ? 0 : norm(t.ratingAvg, w.normCaps.ratingAvg)) +
    0.15 * TIER_BONUS[t.tier]
  );
}

/** Small positive score for differing from the last 5 served. */
export function diversityBonus(c: Candidate, ctx: RecentContext): number {
  const recentSellers = ctx.sellerIds.slice(0, 5);
  const recentCategories = ctx.categoryIds.slice(0, 5);
  const recentBands = ctx.priceCents.slice(0, 5).map(priceBandOf);
  let score = 0;
  if (!recentSellers.includes(c.sellerId)) score += 0.4;
  if (!recentCategories.includes(c.categoryId)) score += 0.35;
  if (!recentBands.includes(priceBandOf(c.minPriceCents))) score += 0.25;
  return score;
}

export function fatiguePenalty(c: Candidate, ctx: RecentContext): number {
  const sellerIdx = ctx.sellerIds.indexOf(c.sellerId);
  const seller = sellerIdx === -1 ? 0 : sellerIdx < 3 ? 1 : sellerIdx < 8 ? 0.5 : 0;

  const catIdx = ctx.categoryIds.indexOf(c.categoryId);
  const category = catIdx === -1 ? 0 : catIdx < 2 ? 1 : catIdx < 5 ? 0.5 : 0;

  return 0.6 * seller + 0.4 * category;
}

/** The strongest negative signal in the system. */
export function qualityPenalty(c: Candidate, w: Weights): number {
  const skipRate = safeRate(c.stats.skipsUnder2s24h, c.stats.impressions24h);
  const reportRate = safeRate(c.stats.reportsAll, c.stats.impressionsAll);
  const notInterestedRate = safeRate(c.stats.notInterestedAll, c.stats.impressionsAll);
  return (
    0.5 * norm(skipRate, w.normCaps.skipUnder2sRate) +
    0.3 * norm(reportRate, w.normCaps.reportRate) +
    0.2 * norm(notInterestedRate, w.normCaps.notInterestedRate)
  );
}
