-- =============================================================================
-- 00013  category_rate_medians
--
-- Closes the gap flagged in PR #9. Spec 2.2 moved every normalisation reference
-- from a global cap to `2.5 * median(rate | category)` — but nothing in the
-- application ever computed a category median. Only `computeCategoryMedians` in
-- src/lib/scoring/simulate.ts did, privately, over synthetic data. In
-- production `resolveMedian` would therefore see a category median of 0 for
-- every category, fall through to the shipped global default on every single
-- rate, and the 2.5x-of-category-median change would be inert: every video on
-- the platform measured against the same yardstick, which is exactly what 2.2
-- set out to stop.
--
-- This migration is the missing half: a table the scoring code can read, and a
-- job that fills it from video_stats. Shape and conventions follow 00009
-- (SECURITY DEFINER + SET search_path, REVOKE from PUBLIC/anon/authenticated,
-- service_role only, conditional pg_cron block that degrades to a NOTICE).
--
-- WHY A TABLE AND NOT A VIEW. A view would recompute nine percentile_cont
-- aggregates over the whole live catalogue on every feed request. The medians
-- move over days; the feed is served thousands of times a minute. This is the
-- same trade 00009 already made for velocity_1h.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The table
-- -----------------------------------------------------------------------------
-- One column per `NormalisableRate` in src/lib/scoring/types.ts. The names are
-- the snake_case of the TS keys and src/lib/scoring/medians.ts maps between them
-- in one place; adding a rate means touching that map, this table, and the
-- aggregate below, and nothing else.
--
-- Rate columns are NULLABLE on purpose. A NULL means "no median measured for
-- this rate", and the loader falls back PER RATE rather than discarding the
-- whole row — a category can have a trustworthy tap rate and no purchase
-- signal at all, and throwing away the tap rate because of that would be a
-- strictly worse feed.
--
-- The medians are stored exactly as measured, including a legitimate 0. The
-- "a zero is not a usable reference, fall through" rule lives in one place,
-- `resolveMedian` in normalize.ts (mirrored by medians.ts for the load path),
-- and inventing a positive number here would take that decision away from the
-- module that documents it.
CREATE TABLE IF NOT EXISTS public.category_rate_medians (
  -- NULL = the global fallback row. It does double duty, and both duties are
  -- the same number: it is the reference for UNCATEGORISED videos
  -- (videos.category_id IS NULL), and it is the fall-through for a category
  -- with too few samples to earn a row of its own. See `medianFor` in types.ts:
  -- the uncategorised bucket ('') is simply absent from `byCategory`, so it
  -- resolves to `fallback`, which is this row.
  category_id         uuid REFERENCES public.categories(id) ON DELETE CASCADE,

  purchase_rate       numeric CHECK (purchase_rate       >= 0),
  cart_rate           numeric CHECK (cart_rate           >= 0),
  tap_rate            numeric CHECK (tap_rate            >= 0),
  share_rate          numeric CHECK (share_rate          >= 0),
  save_rate           numeric CHECK (save_rate           >= 0),
  avg_loop_count      numeric CHECK (avg_loop_count      >= 0),
  skip_under_2s_rate  numeric CHECK (skip_under_2s_rate  >= 0),
  report_rate         numeric CHECK (report_rate         >= 0),
  not_interested_rate numeric CHECK (not_interested_rate >= 0),

  -- How many videos the medians were taken over. Kept so a reader can tell a
  -- median measured over 4,000 videos from one measured over the floor.
  sample_size         integer NOT NULL CHECK (sample_size >= 0),
  computed_at         timestamptz NOT NULL DEFAULT now()
);

-- category_id is nullable, so it cannot be the primary key. Two partial unique
-- indexes give the same guarantee without NULLS NOT DISTINCT (PG15+), keeping
-- the migration portable: at most one row per category, and at most one global
-- row. The ((true)) trick is 00009's, from idx_feed_weights_one_control.
CREATE UNIQUE INDEX IF NOT EXISTS idx_category_rate_medians_category
  ON public.category_rate_medians (category_id) WHERE category_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_category_rate_medians_global
  ON public.category_rate_medians ((true)) WHERE category_id IS NULL;

COMMENT ON TABLE public.category_rate_medians IS
  'Per-category median of each normalisable rate. reference = 2.5 * median (spec 2.2). '
  'category_id IS NULL is the global fallback row, used for uncategorised videos '
  'and for categories below the sample floor. Rebuilt by refresh_category_rate_medians().';

-- -----------------------------------------------------------------------------
-- 2. The job
-- -----------------------------------------------------------------------------
-- A TRUE median (percentile_cont(0.5)), not an average and not percentile_disc.
-- percentile_cont interpolates between the two middle values on an even sample
-- count, which is what "median" means; percentile_disc would snap to an actual
-- observation and make the reference jump discontinuously as videos enter and
-- leave the sample.
--
-- MINIMUM IMPRESSIONS. A video with 4 impressions and 1 tap has a tap rate of
-- 0.25 — six times a healthy category median, and pure noise. Left in, a
-- handful of such videos drags (or inflates) the very number every other video
-- in the category is measured against, and the damage is systemic rather than
-- local. p_min_impressions defaults to 30, matching MEDIAN_MIN_IMPRESSIONS in
-- simulate.ts so the offline simulation and production compute the same number.
--
-- MINIMUM SAMPLES. A median over three videos is not a category median. Below
-- p_min_samples a category gets no row at all and resolves to the global
-- fallback, which is a real measurement over the whole catalogue rather than a
-- fiction over three rows.
--
-- The sample is restricted to status = 'live': the median is the yardstick for
-- videos competing in the feed, and a removed video is not competing.
CREATE OR REPLACE FUNCTION public.refresh_category_rate_medians(
  p_min_impressions integer DEFAULT 30,
  p_min_samples     integer DEFAULT 20
)
RETURNS TABLE (rows_written integer, categories_written integer, global_written boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_now  timestamptz := now();
  v_rows integer := 0;
BEGIN
  -- Full rebuild, not an upsert. A category that has fallen back below the
  -- sample floor must LOSE its row so it resolves to the global fallback; an
  -- upsert would leave a stale median in place forever, and a stale reference
  -- is worse than no reference because nothing ever flags it. The whole
  -- function is one transaction, so a concurrent reader sees the old set or the
  -- new set, never a half-rebuilt one.
  DELETE FROM public.category_rate_medians;

  WITH sample AS (
    SELECT
      v.category_id,
      -- Denominators mirror `rateVector` in simulate.ts exactly: the 24h
      -- window for engagement and commerce, all-time for the two abuse rates,
      -- which are far too rare to have a meaningful 24h median.
      CASE WHEN vs.impressions_24h > 0
           THEN vs.purchases_24h::numeric      / vs.impressions_24h ELSE 0 END AS purchase_rate,
      CASE WHEN vs.impressions_24h > 0
           THEN vs.add_to_carts_24h::numeric   / vs.impressions_24h ELSE 0 END AS cart_rate,
      CASE WHEN vs.impressions_24h > 0
           THEN vs.product_taps_24h::numeric   / vs.impressions_24h ELSE 0 END AS tap_rate,
      CASE WHEN vs.impressions_24h > 0
           THEN vs.shares_24h::numeric         / vs.impressions_24h ELSE 0 END AS share_rate,
      CASE WHEN vs.impressions_24h > 0
           THEN vs.saves_24h::numeric          / vs.impressions_24h ELSE 0 END AS save_rate,
      vs.avg_loop_count::numeric                                               AS avg_loop_count,
      CASE WHEN vs.impressions_24h > 0
           THEN vs.skips_under_2s_24h::numeric / vs.impressions_24h ELSE 0 END AS skip_under_2s_rate,
      CASE WHEN vs.impressions_all > 0
           THEN vs.reports_all::numeric        / vs.impressions_all ELSE 0 END AS report_rate,
      CASE WHEN vs.impressions_all > 0
           THEN vs.not_interested_all::numeric / vs.impressions_all ELSE 0 END AS not_interested_rate
    FROM public.video_stats vs
    JOIN public.videos v ON v.id = vs.video_id
    WHERE v.status = 'live'
      AND vs.impressions_24h >= p_min_impressions
  ),
  agg AS (
    -- GROUPING SETS gives the per-category rows and the platform-wide row in a
    -- single pass. GROUPING(category_id) = 1 marks the grand total; it is the
    -- only way to tell it apart from the genuinely-uncategorised group, whose
    -- category_id is also NULL.
    SELECT
      category_id,
      GROUPING(category_id) AS is_global,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY purchase_rate)       AS purchase_rate,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY cart_rate)           AS cart_rate,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY tap_rate)            AS tap_rate,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY share_rate)          AS share_rate,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY save_rate)           AS save_rate,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY avg_loop_count)      AS avg_loop_count,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY skip_under_2s_rate)  AS skip_under_2s_rate,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY report_rate)         AS report_rate,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY not_interested_rate) AS not_interested_rate,
      count(*)::integer AS sample_size
    FROM sample
    GROUP BY GROUPING SETS ((category_id), ())
  )
  INSERT INTO public.category_rate_medians (
    category_id,
    purchase_rate, cart_rate, tap_rate, share_rate, save_rate,
    avg_loop_count, skip_under_2s_rate, report_rate, not_interested_rate,
    sample_size, computed_at
  )
  SELECT
    CASE WHEN is_global = 1 THEN NULL ELSE category_id END,
    purchase_rate, cart_rate, tap_rate, share_rate, save_rate,
    avg_loop_count, skip_under_2s_rate, report_rate, not_interested_rate,
    sample_size, v_now
  FROM agg
  WHERE sample_size >= p_min_samples
    -- Drop the uncategorised GROUP (category_id IS NULL, is_global = 0). Those
    -- videos are served by the global row, which is measured over the whole
    -- catalogue and is a better reference than the uncategorised bucket's own
    -- median would be. Keeping both would also collide on the global unique index.
    AND (is_global = 1 OR category_id IS NOT NULL);

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  RETURN QUERY
    SELECT v_rows,
           (SELECT count(*)::integer FROM public.category_rate_medians
             WHERE category_id IS NOT NULL),
           EXISTS (SELECT 1 FROM public.category_rate_medians
                    WHERE category_id IS NULL);
END;
$fn$;

COMMENT ON FUNCTION public.refresh_category_rate_medians(integer, integer) IS
  'Rebuilds public.category_rate_medians from video_stats. TRUE median via '
  'percentile_cont(0.5) over live videos with >= p_min_impressions 24h impressions; '
  'categories below p_min_samples are omitted and resolve to the global row.';

-- -----------------------------------------------------------------------------
-- 3. Privileges
-- -----------------------------------------------------------------------------
-- These medians are the exact yardstick every video is ranked against. Exposed
-- to anon they would tell a seller — or anyone farming the feed — precisely how
-- far above the category median a video must land to saturate a signal, which
-- is a recipe for gaming the ranker. Server-side only, like feed_weights.
ALTER TABLE public.category_rate_medians ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.category_rate_medians FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.category_rate_medians TO service_role;

REVOKE EXECUTE ON FUNCTION public.refresh_category_rate_medians(integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.refresh_category_rate_medians(integer, integer)
  TO service_role;
-- No RLS policy is declared, deliberately. service_role bypasses RLS; anon and
-- authenticated have no grant and no policy, so the table is closed to them
-- twice over. Same posture as rollup_state in 00009.

-- -----------------------------------------------------------------------------
-- 4. Seed the table so it is never empty between deploy and the first tick
-- -----------------------------------------------------------------------------
-- Without this the table sits empty until the first cron run and every rate
-- silently falls back to the shipped defaults in the meantime — the precise
-- failure this migration exists to end. On an empty or brand-new catalogue this
-- writes nothing, which is correct: an empty table means "use the defaults".
DO $seed$
DECLARE
  r record;
BEGIN
  SELECT * INTO r FROM public.refresh_category_rate_medians();
  RAISE NOTICE 'category_rate_medians seeded: % row(s), % categor(y/ies), global row %',
    r.rows_written, r.categories_written,
    CASE WHEN r.global_written THEN 'written' ELSE 'not written (too few samples)' END;
END
$seed$;

-- -----------------------------------------------------------------------------
-- 5. Scheduling
-- -----------------------------------------------------------------------------
-- Moved to 00016_schedule_cron_jobs.sql, together with 00009's jobs and for
-- the same reason: a pg_cron extension failure must cost "jobs not scheduled
-- yet", never a rollback of this file's schema work. See 00016's header.
