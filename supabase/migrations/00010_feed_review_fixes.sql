-- Fixes for defects found by adversarial review of 00007-00009, each verified
-- against a real Postgres before being written here.

-- ---------------------------------------------------------------------------
-- 1. avg_loop_count overflow — a platform-wide denial of service.
--
-- The column is numeric(6,3), so any value >= 1000 raises "numeric field
-- overflow". loop_count arrives from the client and the API accepted up to
-- 10,000, so ONE device sending a large loop_count makes avg() exceed the
-- column and aborts the whole rollup transaction — freezing video_stats for
-- every video on the platform, not just the attacker's.
--
-- Two independent layers, because either alone is brittle:
--   (a) widen the column so a legitimate outlier cannot abort the job, and
--   (b) clamp at ingestion (below, and in the API schema) so the stored value
--       is bounded at something physically possible for a <=60s clip.
-- ---------------------------------------------------------------------------
ALTER TABLE public.video_stats
  ALTER COLUMN avg_loop_count TYPE numeric(12,3);

-- A 60s clip looping 500 times is >8 hours of continuous watching. Anything
-- beyond this is a broken client or a hostile one; clamp rather than reject so
-- one bad field does not discard an otherwise good event.
CREATE OR REPLACE FUNCTION public.clamp_loop_count(p_loops integer)
RETURNS integer
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$ SELECT LEAST(GREATEST(COALESCE(p_loops, 0), 0), 500) $$;

REVOKE EXECUTE ON FUNCTION public.clamp_loop_count(integer) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.clamp_loop_count(integer) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. feed_slices.lane is NOT NULL, but the naive feed has no candidate lane —
-- it is reverse-chronological. recordSlice wrote NULL, so every insert failed
-- and no slice was ever attributed. Rather than making the column nullable
-- (which would hide the same bug once ranking lands), name the lane the naive
-- feed actually uses.
-- ---------------------------------------------------------------------------
ALTER TYPE public.candidate_lane ADD VALUE IF NOT EXISTS 'chrono';

-- ---------------------------------------------------------------------------
-- 3. SECURITY DEFINER maintenance functions were left executable by anon.
-- They are jobs, not APIs: rollup_video_stats() is expensive and
-- refresh_category_counts() rewrites a table the feed reads.
-- ---------------------------------------------------------------------------
DO $$
DECLARE fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef                       -- SECURITY DEFINER only
      AND p.proname IN (
        'rollup_video_stats', 'refresh_category_counts', 'sweep_feed_event_dedupe',
        'ensure_feed_events_partitions', 'drop_old_feed_events_partitions',
        'create_feed_events_partition', 'prune_viewer_counters'
      )
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn.sig);
    EXECUTE format('GRANT  EXECUTE ON FUNCTION %s TO service_role', fn.sig);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 4. decrement_product_inventory accepted any quantity, including a negative
-- one — which would ADD stock, since `inventory_count - (-5)` increases it,
-- and `inventory_count >= -5` is trivially true. Reachable from any path that
-- forwards a client-supplied quantity.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.decrement_product_inventory(
  p_product_id uuid,
  p_quantity smallint DEFAULT 1
)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE v_new integer;
BEGIN
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'decrement_product_inventory: quantity must be positive (got %)', p_quantity;
  END IF;

  UPDATE public.products
     SET inventory_count = inventory_count - p_quantity, updated_at = now()
   WHERE id = p_product_id AND inventory_count >= p_quantity
  RETURNING inventory_count INTO v_new;

  RETURN v_new;   -- NULL means insufficient stock
END;
$$;

REVOKE EXECUTE ON FUNCTION public.decrement_product_inventory(uuid, smallint)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.decrement_product_inventory(uuid, smallint)
  TO service_role;
