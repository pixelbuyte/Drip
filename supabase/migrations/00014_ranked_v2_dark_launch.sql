-- =============================================================================
-- 00014  ranked_v2 dark launch
--
-- Phase 6 of wiring the v2 ranking engine (src/lib/feed/ranked-slice.ts) into
-- the live feed: insert the row that lets a non-'control' feed_weights
-- variant actually be selected, WITHOUT sending it any traffic yet.
--
-- feed_weights already has a 'control' row (migration 00009), is_active=true,
-- traffic_share=1.000 -- but getRankedFeedSlice treats 'control' specially
-- and never lets it turn ranking on (see ranked-slice.ts's CONTROL_VARIANT
-- comment: that row is the spec's baseline weights, not an opt-in switch).
-- So today, with zero non-control active rows, every request falls through
-- to the naive chronological feed regardless of what this migration adds.
--
-- This migration changes that by ~0%: 'ranked_v2' is inserted ACTIVE but at
-- traffic_share = 0.00. pickWeightsRow (src/lib/scoring/weights.ts) buckets
-- by cumulative traffic_share in insertion order, and 'control' still owns
-- 1.000 of the [0,1) range ahead of it, so no bucketValue can ever land past
-- 'control' onto 'ranked_v2' while control's share stays at 1.000. The
-- ranked code path becomes selectable in principle -- and the loader/tests
-- prove the row round-trips into Weights/LaneShares correctly -- but zero
-- real viewers see it until an operator deliberately lowers 'control' and
-- raises 'ranked_v2' together (they need not sum to exactly 1.000 -- see
-- pickWeightsRow's own doc comment on how a misconfigured sum degrades).
--
-- Rollout, per the plan (raise in steps, watch not_interested/skip rates in
-- feed_events at each one):
--   UPDATE feed_weights SET traffic_share = 0.99 WHERE variant = 'control';
--   UPDATE feed_weights SET traffic_share = 0.01 WHERE variant = 'ranked_v2';
--   -- then 0.95/0.05, 0.75/0.25, 0/1.00 -- watched, not scripted.
--
-- Rollback at any point, zero deploy:
--   UPDATE feed_weights SET traffic_share = 0.00 WHERE variant = 'ranked_v2';
--   UPDATE feed_weights SET traffic_share = 1.00 WHERE variant = 'control';
--
-- Weights and lane shares below are identical to 'control''s (migration
-- 00009) and to every column's own schema default -- this migration is pure
-- rollout plumbing, not a weight change. Once ranked_v2 is actually serving
-- traffic, tuning its weights is a data-only UPDATE, not a migration.
-- =============================================================================

INSERT INTO public.feed_weights
  (variant, is_active, traffic_share,
   w_commerce, w_engagement, w_affinity, w_freshness, w_trust, w_diversity,
   p_fatigue, p_quality, notes)
VALUES
  ('ranked_v2', true, 0.000,
   0.350, 0.200, 0.200, 0.100, 0.100, 0.050,
   0.150, 0.250,
   'Dark launch (00014): same starting weights as control. traffic_share '
   'raised deliberately, in steps, once the ranked pipeline has a preview '
   'deployment check. See ranked-slice.ts for why control alone never '
   'activates ranking.')
ON CONFLICT (variant) DO NOTHING;
