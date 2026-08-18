CREATE TABLE public.video_stats (
  video_id uuid PRIMARY KEY REFERENCES public.videos(id) ON DELETE CASCADE,

  impressions_1h integer NOT NULL DEFAULT 0,
  impressions_24h integer NOT NULL DEFAULT 0,
  impressions_7d integer NOT NULL DEFAULT 0,
  impressions_all bigint NOT NULL DEFAULT 0,

  completions_1h integer NOT NULL DEFAULT 0,
  completions_24h integer NOT NULL DEFAULT 0,
  completions_7d integer NOT NULL DEFAULT 0,
  completions_all bigint NOT NULL DEFAULT 0,

  skips_under_2s_1h integer NOT NULL DEFAULT 0,
  skips_under_2s_24h integer NOT NULL DEFAULT 0,
  skips_under_2s_7d integer NOT NULL DEFAULT 0,
  skips_under_2s_all bigint NOT NULL DEFAULT 0,

  product_taps_1h integer NOT NULL DEFAULT 0,
  product_taps_24h integer NOT NULL DEFAULT 0,
  product_taps_7d integer NOT NULL DEFAULT 0,
  product_taps_all bigint NOT NULL DEFAULT 0,

  add_to_carts_1h integer NOT NULL DEFAULT 0,
  add_to_carts_24h integer NOT NULL DEFAULT 0,
  add_to_carts_7d integer NOT NULL DEFAULT 0,
  add_to_carts_all bigint NOT NULL DEFAULT 0,

  -- purchases/gmv come from ORDERS, not from feed_events. See 3.3.
  purchases_1h integer NOT NULL DEFAULT 0,
  purchases_24h integer NOT NULL DEFAULT 0,
  purchases_7d integer NOT NULL DEFAULT 0,
  purchases_all bigint NOT NULL DEFAULT 0,

  gmv_cents_1h bigint NOT NULL DEFAULT 0,
  gmv_cents_24h bigint NOT NULL DEFAULT 0,
  gmv_cents_7d bigint NOT NULL DEFAULT 0,
  gmv_cents_all bigint NOT NULL DEFAULT 0,

  likes_1h integer NOT NULL DEFAULT 0,
  likes_24h integer NOT NULL DEFAULT 0,
  likes_7d integer NOT NULL DEFAULT 0,
  likes_all bigint NOT NULL DEFAULT 0,

  saves_1h integer NOT NULL DEFAULT 0,
  saves_24h integer NOT NULL DEFAULT 0,
  saves_7d integer NOT NULL DEFAULT 0,
  saves_all bigint NOT NULL DEFAULT 0,

  shares_1h integer NOT NULL DEFAULT 0,
  shares_24h integer NOT NULL DEFAULT 0,
  shares_7d integer NOT NULL DEFAULT 0,
  shares_all bigint NOT NULL DEFAULT 0,

  follows_driven_1h integer NOT NULL DEFAULT 0,
  follows_driven_24h integer NOT NULL DEFAULT 0,
  follows_driven_7d integer NOT NULL DEFAULT 0,
  follows_driven_all bigint NOT NULL DEFAULT 0,

  reports_all integer NOT NULL DEFAULT 0,
  not_interested_all integer NOT NULL DEFAULT 0,
  avg_loop_count numeric(6,3) NOT NULL DEFAULT 0,
  avg_watch_ratio numeric(5,4) NOT NULL DEFAULT 0,
  distinct_viewers_24h integer NOT NULL DEFAULT 0,
  -- 2.9's Herfindahl index over viewers per video; flag above 0.30.
  viewer_hhi_24h numeric(5,4),

  -- 2.8's 500-impression exploration budget, delivered over 48h.
  exploration_impressions integer NOT NULL DEFAULT 0,

  -- Derived rates: generated, not written by the rollup, so no rollup bug can
  -- ever desync a rate from its numerator. Only the 24h window is generated,
  -- because 2.3 reads only _24h rates and 2.4 reads only raw _1h counts.
  completion_rate_24h numeric(6,5) GENERATED ALWAYS AS (
    CASE WHEN impressions_24h > 0
         THEN LEAST(completions_24h::numeric / impressions_24h, 1) ELSE 0 END) STORED,
  tap_rate_24h numeric(6,5) GENERATED ALWAYS AS (
    CASE WHEN impressions_24h > 0
         THEN LEAST(product_taps_24h::numeric / impressions_24h, 1) ELSE 0 END) STORED,
  cart_rate_24h numeric(6,5) GENERATED ALWAYS AS (
    CASE WHEN impressions_24h > 0
         THEN LEAST(add_to_carts_24h::numeric / impressions_24h, 1) ELSE 0 END) STORED,
  purchase_rate_24h numeric(6,5) GENERATED ALWAYS AS (
    CASE WHEN impressions_24h > 0
         THEN LEAST(purchases_24h::numeric / impressions_24h, 1) ELSE 0 END) STORED,
  skip_under_2s_rate_24h numeric(6,5) GENERATED ALWAYS AS (
    CASE WHEN impressions_24h > 0
         THEN LEAST(skips_under_2s_24h::numeric / impressions_24h, 1) ELSE 0 END) STORED,
  revenue_per_impression_cents_24h numeric(12,4) GENERATED ALWAYS AS (
    CASE WHEN impressions_24h > 0
         THEN gmv_cents_24h::numeric / impressions_24h ELSE 0 END) STORED,

  -- 2.4's velocity score, verbatim, as a stored column. This makes the
  -- trending candidate lane a plain index scan instead of a computed sort.
  velocity_1h numeric(12,6) GENERATED ALWAYS AS (
    ((purchases_1h * 10 + add_to_carts_1h * 3 + product_taps_1h * 1)::numeric
      / (impressions_1h + 100))
    * log(10, (impressions_1h + 10)::numeric)
  ) STORED,

  last_computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_video_stats_velocity ON public.video_stats (velocity_1h DESC);
CREATE INDEX idx_video_stats_rpi      ON public.video_stats (revenue_per_impression_cents_24h DESC);
-- 2.8: which fresh videos still owe part of their 500-impression budget
CREATE INDEX idx_video_stats_exploration ON public.video_stats (exploration_impressions)
  WHERE exploration_impressions < 500;
-- 2.3's quality kill switch: skip_under_2s_rate > 0.6 with 200+ impressions
CREATE INDEX idx_video_stats_not_landing ON public.video_stats (skip_under_2s_rate_24h DESC)
  WHERE impressions_24h >= 200;

CREATE TABLE public.rollup_state (
  job_name         text PRIMARY KEY,
  watermark        timestamptz NOT NULL,
  last_run_at      timestamptz,
  last_duration_ms integer,
  rows_processed   bigint NOT NULL DEFAULT 0,
  last_error       text
);
INSERT INTO public.rollup_state (job_name, watermark) VALUES ('video_stats', now());

CREATE FUNCTION public.rollup_video_stats()
RETURNS TABLE (videos_touched int, window_from timestamptz, window_to timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_from timestamptz;
  v_to   timestamptz := now() - interval '90 seconds';
  v_started timestamptz := clock_timestamp();
  v_n int := 0;
BEGIN
  -- SKIP LOCKED: an overrun run must not stack on top of the previous one.
  SELECT watermark INTO v_from FROM public.rollup_state
   WHERE job_name = 'video_stats' FOR UPDATE SKIP LOCKED;
  IF NOT FOUND OR v_to <= v_from THEN
    RETURN QUERY SELECT 0, v_from, v_to; RETURN;
  END IF;

  CREATE TEMP TABLE _dirty ON COMMIT DROP AS
    SELECT DISTINCT video_id FROM public.feed_events
     WHERE created_at > v_from AND created_at <= v_to
    UNION
    SELECT DISTINCT video_id FROM public.orders
     WHERE updated_at > v_from AND updated_at <= v_to AND video_id IS NOT NULL
    UNION   -- a video whose 1h window is aging out has no new events but
            -- still needs recomputing, or velocity_1h goes stale forever
    SELECT video_id FROM public.video_stats
     WHERE impressions_1h > 0 AND last_computed_at < now() - interval '5 minutes';

  CREATE INDEX ON _dirty (video_id);
  SELECT count(*) INTO v_n FROM _dirty;
  IF v_n = 0 THEN
    UPDATE public.rollup_state SET watermark = v_to, last_run_at = now()
     WHERE job_name = 'video_stats';
    RETURN QUERY SELECT 0, v_from, v_to; RETURN;
  END IF;

  WITH
  -- ---- engagement windows: one pass over the trailing 7d of dirty videos ---
  win AS (
    SELECT e.video_id,
      count(*) FILTER (WHERE e.event_type='impression' AND e.created_at > now()-interval '1 hour')  AS imp_1h,
      count(*) FILTER (WHERE e.event_type='impression' AND e.created_at > now()-interval '24 hours') AS imp_24h,
      count(*) FILTER (WHERE e.event_type='impression')                                              AS imp_7d,

      count(*) FILTER (WHERE e.event_type='watch_progress' AND e.bucket='q95' AND e.created_at > now()-interval '1 hour')  AS comp_1h,
      count(*) FILTER (WHERE e.event_type='watch_progress' AND e.bucket='q95' AND e.created_at > now()-interval '24 hours') AS comp_24h,
      count(*) FILTER (WHERE e.event_type='watch_progress' AND e.bucket='q95')                                              AS comp_7d,

      count(*) FILTER (WHERE e.event_type='skip' AND e.watched_ms < 2000 AND e.created_at > now()-interval '1 hour')  AS skip2_1h,
      count(*) FILTER (WHERE e.event_type='skip' AND e.watched_ms < 2000 AND e.created_at > now()-interval '24 hours') AS skip2_24h,
      count(*) FILTER (WHERE e.event_type='skip' AND e.watched_ms < 2000)                                              AS skip2_7d,

      count(*) FILTER (WHERE e.event_type='product_tap' AND e.created_at > now()-interval '1 hour')  AS tap_1h,
      count(*) FILTER (WHERE e.event_type='product_tap' AND e.created_at > now()-interval '24 hours') AS tap_24h,
      count(*) FILTER (WHERE e.event_type='product_tap')                                              AS tap_7d,

      count(*) FILTER (WHERE e.event_type='add_to_cart' AND e.created_at > now()-interval '1 hour')  AS cart_1h,
      count(*) FILTER (WHERE e.event_type='add_to_cart' AND e.created_at > now()-interval '24 hours') AS cart_24h,
      count(*) FILTER (WHERE e.event_type='add_to_cart')                                              AS cart_7d,

      count(*) FILTER (WHERE e.event_type='like' AND e.created_at > now()-interval '1 hour')  AS like_1h,
      count(*) FILTER (WHERE e.event_type='like' AND e.created_at > now()-interval '24 hours') AS like_24h,
      count(*) FILTER (WHERE e.event_type='like')                                              AS like_7d,

      count(*) FILTER (WHERE e.event_type='save' AND e.created_at > now()-interval '1 hour')  AS save_1h,
      count(*) FILTER (WHERE e.event_type='save' AND e.created_at > now()-interval '24 hours') AS save_24h,
      count(*) FILTER (WHERE e.event_type='save')                                              AS save_7d,

      count(*) FILTER (WHERE e.event_type='share' AND e.created_at > now()-interval '1 hour')  AS share_1h,
      count(*) FILTER (WHERE e.event_type='share' AND e.created_at > now()-interval '24 hours') AS share_24h,
      count(*) FILTER (WHERE e.event_type='share')                                              AS share_7d,

      count(*) FILTER (WHERE e.event_type='follow' AND e.created_at > now()-interval '1 hour')  AS fol_1h,
      count(*) FILTER (WHERE e.event_type='follow' AND e.created_at > now()-interval '24 hours') AS fol_24h,
      count(*) FILTER (WHERE e.event_type='follow')                                              AS fol_7d,

      COALESCE(avg(e.loop_count) FILTER (WHERE e.event_type='skip'), 0)             AS avg_loops,
      COALESCE(avg(LEAST(e.watched_ms::numeric
              / NULLIF(e.video_duration_ms,0), 1))
               FILTER (WHERE e.event_type='skip' AND e.video_duration_ms > 0), 0)   AS avg_ratio,
      count(DISTINCT e.anon_id) FILTER (WHERE e.event_type='impression'
              AND e.created_at > now()-interval '24 hours')                          AS viewers_24h,
      count(*) FILTER (WHERE e.event_type='impression'
              AND e.lane = 'fresh')                                                  AS explore_7d
    FROM public.feed_events e
    JOIN _dirty d USING (video_id)
    WHERE e.created_at > now() - interval '7 days'
    GROUP BY e.video_id
  ),
  -- 2.9's Herfindahl index: sum of squared per-viewer impression shares.
  hhi AS (
    SELECT video_id, sum(share * share) AS hhi_24h
    FROM (
      SELECT e.video_id, e.anon_id,
             count(*)::numeric / sum(count(*)) OVER (PARTITION BY e.video_id) AS share
      FROM public.feed_events e JOIN _dirty d USING (video_id)
      WHERE e.event_type = 'impression' AND e.created_at > now() - interval '24 hours'
      GROUP BY e.video_id, e.anon_id
    ) s GROUP BY video_id
  ),
  -- ---- all-time engagement, advanced by the watermark delta ---------------
  delta AS (
    SELECT e.video_id,
      count(*) FILTER (WHERE e.event_type='impression')                            AS imp,
      count(*) FILTER (WHERE e.event_type='watch_progress' AND e.bucket='q95')     AS comp,
      count(*) FILTER (WHERE e.event_type='skip' AND e.watched_ms < 2000)          AS skip2,
      count(*) FILTER (WHERE e.event_type='product_tap')                           AS tap,
      count(*) FILTER (WHERE e.event_type='add_to_cart')                           AS cart,
      count(*) FILTER (WHERE e.event_type='like')                                  AS lik,
      count(*) FILTER (WHERE e.event_type='save')                                  AS sav,
      count(*) FILTER (WHERE e.event_type='share')                                 AS shr,
      count(*) FILTER (WHERE e.event_type='follow')                                AS fol,
      count(*) FILTER (WHERE e.event_type='report')                                AS rep,
      count(*) FILTER (WHERE e.event_type='not_interested')                        AS ni,
      count(*) FILTER (WHERE e.event_type='impression' AND e.lane='fresh')         AS explore
    FROM public.feed_events e JOIN _dirty d USING (video_id)
    WHERE e.created_at > v_from AND e.created_at <= v_to
    GROUP BY e.video_id
  ),
  -- ---- commerce: recomputed from ORDERS, all windows, every run -----------
  -- Refunded / disputed / canceled orders are simply absent, which is 2.9's
  -- retroactive subtraction with no extra machinery.
  ord AS (
    SELECT o.video_id,
      count(*)          FILTER (WHERE o.created_at > now()-interval '1 hour')   AS pur_1h,
      count(*)          FILTER (WHERE o.created_at > now()-interval '24 hours') AS pur_24h,
      count(*)          FILTER (WHERE o.created_at > now()-interval '7 days')   AS pur_7d,
      count(*)                                                                   AS pur_all,
      COALESCE(sum(o.total_cents) FILTER (WHERE o.created_at > now()-interval '1 hour'),0)   AS gmv_1h,
      COALESCE(sum(o.total_cents) FILTER (WHERE o.created_at > now()-interval '24 hours'),0) AS gmv_24h,
      COALESCE(sum(o.total_cents) FILTER (WHERE o.created_at > now()-interval '7 days'),0)   AS gmv_7d,
      COALESCE(sum(o.total_cents), 0)                                                        AS gmv_all
    FROM public.orders o JOIN _dirty d USING (video_id)
    WHERE o.status IN ('paid','label_created','shipped','delivered')
    GROUP BY o.video_id
  )
  INSERT INTO public.video_stats AS vs (
    video_id,
    impressions_1h, impressions_24h, impressions_7d, impressions_all,
    completions_1h, completions_24h, completions_7d, completions_all,
    skips_under_2s_1h, skips_under_2s_24h, skips_under_2s_7d, skips_under_2s_all,
    product_taps_1h, product_taps_24h, product_taps_7d, product_taps_all,
    add_to_carts_1h, add_to_carts_24h, add_to_carts_7d, add_to_carts_all,
    purchases_1h, purchases_24h, purchases_7d, purchases_all,
    gmv_cents_1h, gmv_cents_24h, gmv_cents_7d, gmv_cents_all,
    likes_1h, likes_24h, likes_7d, likes_all,
    saves_1h, saves_24h, saves_7d, saves_all,
    shares_1h, shares_24h, shares_7d, shares_all,
    follows_driven_1h, follows_driven_24h, follows_driven_7d, follows_driven_all,
    reports_all, not_interested_all, avg_loop_count, avg_watch_ratio,
    distinct_viewers_24h, viewer_hhi_24h, exploration_impressions, last_computed_at
  )
  SELECT d.video_id,
    COALESCE(w.imp_1h,0), COALESCE(w.imp_24h,0), COALESCE(w.imp_7d,0), COALESCE(dl.imp,0),
    COALESCE(w.comp_1h,0), COALESCE(w.comp_24h,0), COALESCE(w.comp_7d,0), COALESCE(dl.comp,0),
    COALESCE(w.skip2_1h,0), COALESCE(w.skip2_24h,0), COALESCE(w.skip2_7d,0), COALESCE(dl.skip2,0),
    COALESCE(w.tap_1h,0), COALESCE(w.tap_24h,0), COALESCE(w.tap_7d,0), COALESCE(dl.tap,0),
    COALESCE(w.cart_1h,0), COALESCE(w.cart_24h,0), COALESCE(w.cart_7d,0), COALESCE(dl.cart,0),
    COALESCE(o.pur_1h,0), COALESCE(o.pur_24h,0), COALESCE(o.pur_7d,0), COALESCE(o.pur_all,0),
    COALESCE(o.gmv_1h,0), COALESCE(o.gmv_24h,0), COALESCE(o.gmv_7d,0), COALESCE(o.gmv_all,0),
    COALESCE(w.like_1h,0), COALESCE(w.like_24h,0), COALESCE(w.like_7d,0), COALESCE(dl.lik,0),
    COALESCE(w.save_1h,0), COALESCE(w.save_24h,0), COALESCE(w.save_7d,0), COALESCE(dl.sav,0),
    COALESCE(w.share_1h,0), COALESCE(w.share_24h,0), COALESCE(w.share_7d,0), COALESCE(dl.shr,0),
    COALESCE(w.fol_1h,0), COALESCE(w.fol_24h,0), COALESCE(w.fol_7d,0), COALESCE(dl.fol,0),
    COALESCE(dl.rep,0), COALESCE(dl.ni,0),
    COALESCE(w.avg_loops,0), COALESCE(w.avg_ratio,0),
    COALESCE(w.viewers_24h,0), h.hhi_24h, COALESCE(dl.explore,0), now()
  FROM _dirty d
  LEFT JOIN win w  ON w.video_id  = d.video_id
  LEFT JOIN hhi h  ON h.video_id  = d.video_id
  LEFT JOIN delta dl ON dl.video_id = d.video_id
  LEFT JOIN ord o  ON o.video_id  = d.video_id
  ON CONFLICT (video_id) DO UPDATE SET
    -- windows: replace
    impressions_1h = EXCLUDED.impressions_1h,
    impressions_24h = EXCLUDED.impressions_24h,
    impressions_7d = EXCLUDED.impressions_7d,
    completions_1h = EXCLUDED.completions_1h,
    completions_24h = EXCLUDED.completions_24h,
    completions_7d = EXCLUDED.completions_7d,
    skips_under_2s_1h = EXCLUDED.skips_under_2s_1h,
    skips_under_2s_24h = EXCLUDED.skips_under_2s_24h,
    skips_under_2s_7d = EXCLUDED.skips_under_2s_7d,
    product_taps_1h = EXCLUDED.product_taps_1h,
    product_taps_24h = EXCLUDED.product_taps_24h,
    product_taps_7d = EXCLUDED.product_taps_7d,
    add_to_carts_1h = EXCLUDED.add_to_carts_1h,
    add_to_carts_24h = EXCLUDED.add_to_carts_24h,
    add_to_carts_7d = EXCLUDED.add_to_carts_7d,
    likes_1h = EXCLUDED.likes_1h, likes_24h = EXCLUDED.likes_24h, likes_7d = EXCLUDED.likes_7d,
    saves_1h = EXCLUDED.saves_1h, saves_24h = EXCLUDED.saves_24h, saves_7d = EXCLUDED.saves_7d,
    shares_1h = EXCLUDED.shares_1h, shares_24h = EXCLUDED.shares_24h, shares_7d = EXCLUDED.shares_7d,
    follows_driven_1h = EXCLUDED.follows_driven_1h,
    follows_driven_24h = EXCLUDED.follows_driven_24h,
    follows_driven_7d = EXCLUDED.follows_driven_7d,
    -- commerce: replace (recomputed from orders, mutable by refunds)
    purchases_1h = EXCLUDED.purchases_1h, purchases_24h = EXCLUDED.purchases_24h,
    purchases_7d = EXCLUDED.purchases_7d, purchases_all = EXCLUDED.purchases_all,
    gmv_cents_1h = EXCLUDED.gmv_cents_1h, gmv_cents_24h = EXCLUDED.gmv_cents_24h,
    gmv_cents_7d = EXCLUDED.gmv_cents_7d, gmv_cents_all = EXCLUDED.gmv_cents_all,
    -- all-time engagement: accumulate the watermark delta
    impressions_all = vs.impressions_all + EXCLUDED.impressions_all,
    completions_all = vs.completions_all + EXCLUDED.completions_all,
    skips_under_2s_all = vs.skips_under_2s_all + EXCLUDED.skips_under_2s_all,
    product_taps_all = vs.product_taps_all + EXCLUDED.product_taps_all,
    add_to_carts_all = vs.add_to_carts_all + EXCLUDED.add_to_carts_all,
    likes_all = vs.likes_all + EXCLUDED.likes_all,
    saves_all = vs.saves_all + EXCLUDED.saves_all,
    shares_all = vs.shares_all + EXCLUDED.shares_all,
    follows_driven_all = vs.follows_driven_all + EXCLUDED.follows_driven_all,
    reports_all = vs.reports_all + EXCLUDED.reports_all,
    not_interested_all = vs.not_interested_all + EXCLUDED.not_interested_all,
    exploration_impressions = vs.exploration_impressions + EXCLUDED.exploration_impressions,
    avg_loop_count = EXCLUDED.avg_loop_count,
    avg_watch_ratio = EXCLUDED.avg_watch_ratio,
    distinct_viewers_24h = EXCLUDED.distinct_viewers_24h,
    viewer_hhi_24h = EXCLUDED.viewer_hhi_24h,
    last_computed_at = now();

  UPDATE public.rollup_state
     SET watermark = v_to, last_run_at = now(),
         last_duration_ms = (extract(epoch FROM clock_timestamp() - v_started) * 1000)::int,
         rows_processed = rows_processed + v_n, last_error = NULL
   WHERE job_name = 'video_stats';

  RETURN QUERY SELECT v_n, v_from, v_to;
END;
$$;

CREATE FUNCTION public.refresh_category_counts() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE public.categories c SET live_video_count = COALESCE(x.n, 0)
  FROM (SELECT category_id, count(*) n FROM public.videos
         WHERE status = 'live' GROUP BY category_id) x
  WHERE x.category_id = c.id OR (c.live_video_count <> 0 AND x.category_id IS NULL);
$$;

CREATE TABLE public.feed_weights (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant       text NOT NULL UNIQUE CHECK (variant ~ '^[a-z0-9_-]{2,40}$'),
  is_active     boolean NOT NULL DEFAULT false,
  traffic_share numeric(4,3) NOT NULL DEFAULT 0 CHECK (traffic_share BETWEEN 0 AND 1),

  w_commerce    numeric(4,3) NOT NULL CHECK (w_commerce   BETWEEN 0 AND 1),
  w_engagement  numeric(4,3) NOT NULL CHECK (w_engagement BETWEEN 0 AND 1),
  w_affinity    numeric(4,3) NOT NULL CHECK (w_affinity   BETWEEN 0 AND 1),
  w_freshness   numeric(4,3) NOT NULL CHECK (w_freshness  BETWEEN 0 AND 1),
  w_trust       numeric(4,3) NOT NULL CHECK (w_trust      BETWEEN 0 AND 1),
  w_diversity   numeric(4,3) NOT NULL CHECK (w_diversity  BETWEEN 0 AND 1),
  p_fatigue     numeric(4,3) NOT NULL CHECK (p_fatigue    BETWEEN 0 AND 1),
  p_quality     numeric(4,3) NOT NULL CHECK (p_quality    BETWEEN 0 AND 1),

  lane_affinity numeric(4,3) NOT NULL DEFAULT 0.35 CHECK (lane_affinity BETWEEN 0 AND 1),
  lane_trending numeric(4,3) NOT NULL DEFAULT 0.25 CHECK (lane_trending BETWEEN 0 AND 1),
  lane_fresh    numeric(4,3) NOT NULL DEFAULT 0.20 CHECK (lane_fresh    BETWEEN 0 AND 1),
  lane_social   numeric(4,3) NOT NULL DEFAULT 0.10 CHECK (lane_social   BETWEEN 0 AND 1),
  lane_random   numeric(4,3) NOT NULL DEFAULT 0.10 CHECK (lane_random   BETWEEN 0 AND 1),

  -- cold-start rebalance (2.2): 40 trending / 30 fresh / 30 random, 0 affinity
  cold_lane_trending numeric(4,3) NOT NULL DEFAULT 0.40,
  cold_lane_fresh    numeric(4,3) NOT NULL DEFAULT 0.30,
  cold_lane_random   numeric(4,3) NOT NULL DEFAULT 0.30,

  bayes_alpha        smallint NOT NULL DEFAULT 50 CHECK (bayes_alpha BETWEEN 1 AND 5000),
  freshness_half_life_hours numeric(6,2) NOT NULL DEFAULT 72,
  candidate_pool_size smallint NOT NULL DEFAULT 500,
  slice_size          smallint NOT NULL DEFAULT 20,
  exploration_budget  smallint NOT NULL DEFAULT 500,
  min_fresh_per_slice smallint NOT NULL DEFAULT 3,   -- constraint #3, never relaxed
  max_per_seller_per_slice smallint NOT NULL DEFAULT 2,
  extra         jsonb NOT NULL DEFAULT '{}',
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- Loose, not sum = 1.0 exactly: a legitimate experiment may want to scale
  -- the whole positive side. A wildly-off sum is still a typo, and gets caught.
  CONSTRAINT feed_weights_positive_sum_sane CHECK (
    (w_commerce + w_engagement + w_affinity + w_freshness + w_trust + w_diversity)
      BETWEEN 0.50 AND 1.50),
  CONSTRAINT feed_weights_lane_sum CHECK (
    abs((lane_affinity + lane_trending + lane_fresh + lane_social + lane_random) - 1.0) < 0.001)
);

CREATE UNIQUE INDEX idx_feed_weights_one_control
  ON public.feed_weights ((true)) WHERE variant = 'control';

CREATE TRIGGER feed_weights_updated_at BEFORE UPDATE ON public.feed_weights
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Seeded with the spec's starting weights exactly.
INSERT INTO public.feed_weights
  (variant, is_active, traffic_share,
   w_commerce, w_engagement, w_affinity, w_freshness, w_trust, w_diversity,
   p_fatigue, p_quality, notes)
VALUES
  ('control', true, 1.000,
   0.350, 0.200, 0.200, 0.100, 0.100, 0.050,
   0.150, 0.250,
   'Spec 2.3 starting weights. Read by nothing until FEED_SCORING_ENABLED is on.');

ALTER TABLE public.feed_weights   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_stats    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rollup_state   ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.feed_weights, public.rollup_state
  FROM PUBLIC, anon, authenticated;

-- video_stats is the one derived table with a public face: the product bar's
-- urgency line (3.2) shows "N sold this week", and the like count renders on
-- the right rail. Everything else stays private — impressions and skip rates
-- would let a competitor read a seller's funnel, and would let anyone running
-- bot traffic verify that it landed.
CREATE POLICY video_stats_public_read ON public.video_stats
  FOR SELECT TO anon, authenticated USING (
    EXISTS (SELECT 1 FROM public.videos v
             WHERE v.id = video_stats.video_id AND v.status = 'live')
  );
REVOKE ALL ON public.video_stats FROM anon, authenticated;
GRANT SELECT (video_id, likes_all, purchases_7d, purchases_all)
  ON public.video_stats TO anon, authenticated;
-- A seller's own full stats come from a server route, not from a wider grant:
-- column privileges are per-role, so "sellers see more of their own row" is
-- not expressible in RLS. The dashboard route uses the service-role client.

-- Scheduling. pg_cron exists on Supabase but not on a bare Postgres, so the
-- whole block is conditional: the migration must apply identically in CI and
-- on a developer's local database, where the jobs simply are not scheduled.
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
    
    PERFORM cron.schedule('video-stats-rollup',      '* * * * *',
      $$SELECT public.rollup_video_stats()$$);
    PERFORM cron.schedule('feed-dedupe-sweep',       '*/5 * * * *',
      $$SELECT public.sweep_feed_event_dedupe()$$);
    PERFORM cron.schedule('category-counts',         '*/10 * * * *',
      $$SELECT public.refresh_category_counts()$$);
    PERFORM cron.schedule('feed-events-partitions',  '0 3 1 * *',
      $$SELECT public.ensure_feed_events_partitions(3)$$);
    PERFORM cron.schedule('feed-events-retention',   '30 3 1 * *',
      $$SELECT public.drop_old_feed_events_partitions(6)$$);
    PERFORM cron.schedule('viewer-counters-prune',   '0 4 * * 0',
      $$DELETE FROM public.viewer_video_counters
         WHERE last_event_at < now() - interval '180 days'$$);
  ELSE
    RAISE NOTICE 'pg_cron unavailable — rollup jobs not scheduled (expected outside Supabase)';
  END IF;
END
$cron$;