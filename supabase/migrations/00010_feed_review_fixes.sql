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

-- ---------------------------------------------------------------------------
-- 5. Liking a video deleted its save, and saving deleted its like.
--
-- The upsert recomputed BOTH columns from the current batch alone and treated
-- "absent from this batch" as "clear it", never falling back to the stored
-- value. A batch containing only a `like` therefore wrote saved_at = NULL,
-- silently unsaving something the viewer had put on their list — the single
-- most visible data loss available in this schema, since the shopping list is
-- the reason they come back.
--
-- COALESCE to the existing row, and only clear on an explicit unlike/unsave.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_video_reactions(
  p_anon_id uuid,
  p_video_id uuid,
  p_liked boolean,      -- true = like, false = unlike, null = untouched
  p_saved boolean       -- true = save, false = unsave, null = untouched
)
RETURNS void
LANGUAGE sql
SET search_path = public, pg_temp
AS $$
  INSERT INTO public.viewer_video_reactions AS r (anon_id, video_id, liked_at, saved_at)
  VALUES (
    p_anon_id, p_video_id,
    CASE WHEN p_liked THEN now() END,
    CASE WHEN p_saved THEN now() END
  )
  ON CONFLICT (anon_id, video_id) DO UPDATE SET
    liked_at = CASE
                 WHEN p_liked IS NULL     THEN r.liked_at   -- untouched
                 WHEN p_liked             THEN COALESCE(r.liked_at, now())
                 ELSE NULL                                  -- explicit unlike
               END,
    saved_at = CASE
                 WHEN p_saved IS NULL     THEN r.saved_at
                 WHEN p_saved             THEN COALESCE(r.saved_at, now())
                 ELSE NULL
               END,
    updated_at = now();
$$;

REVOKE EXECUTE ON FUNCTION public.apply_video_reactions(uuid, uuid, boolean, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.apply_video_reactions(uuid, uuid, boolean, boolean)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 6. The rollup's staleness sweep was gated on impressions_1h > 0, so a video
-- whose impressions aged out of the 1h window but which still has taps, carts
-- or purchases in it was never recomputed again — velocity_1h froze at its
-- last value forever. Combined with the catch-all dedupe allowance that is how
-- one device could pin a video's velocity permanently.
--
-- Sweep on ANY non-zero 1h counter, not impressions alone.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.stale_video_stat_ids(p_older_than interval DEFAULT interval '5 minutes')
RETURNS TABLE (video_id uuid)
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT vs.video_id
  FROM public.video_stats vs
  WHERE vs.last_computed_at < now() - p_older_than
    AND (vs.impressions_1h > 0
      OR vs.product_taps_1h > 0
      OR vs.add_to_carts_1h > 0
      OR vs.purchases_1h > 0
      OR vs.velocity_1h > 0);
$$;

REVOKE EXECUTE ON FUNCTION public.stale_video_stat_ids(interval) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.stale_video_stat_ids(interval) TO service_role;

-- ---------------------------------------------------------------------------
-- 7. link_anon_identity let a SECOND account seize an anon identity already
-- claimed by a first: the null-canonical branch repointed the row without
-- checking whether auth_user_id was already set to somebody else. Signing in
-- on a shared or borrowed device could therefore graft one person's browsing
-- history onto another person's account.
--
-- Claim only an UNCLAIMED identity; if it already belongs to another account,
-- leave it alone and let the new account start clean.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_anon_identity(
  p_anon_id uuid,
  p_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE v_owner uuid;
BEGIN
  SELECT auth_user_id INTO v_owner
  FROM public.viewer_identities
  WHERE anon_id = p_anon_id
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.viewer_identities (anon_id, canonical_anon_id, auth_user_id, linked_at)
    VALUES (p_anon_id, p_anon_id, p_user_id, now());
    RETURN true;
  END IF;

  IF v_owner IS NULL THEN
    UPDATE public.viewer_identities
       SET auth_user_id = p_user_id, linked_at = now()
     WHERE anon_id = p_anon_id;
    RETURN true;
  END IF;

  -- Already claimed. Same user: idempotent success. Different user: refuse,
  -- rather than transplanting one person's history onto another's account.
  RETURN v_owner = p_user_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_anon_identity(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.claim_anon_identity(uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 8. refresh_category_counts corrupted the counts it maintains.
--
-- The UPDATE ... FROM joined against a subquery that only contains categories
-- WITH live videos, then tried to handle the empty case with
-- `OR (c.live_video_count <> 0 AND x.category_id IS NULL)`. In an UPDATE FROM
-- that disjunct does not mean "no matching row" — it matches when a row in x
-- has a NULL category_id (videos with no category), and then pairs that single
-- row against EVERY category with a non-zero count, assigning all of them the
-- uncategorized total. A category that drops to zero live videos also keeps
-- its stale count, because no row in x matches it at all.
--
-- These counts drive spec 2.8's thin-supply freshness multiplier, so a wrong
-- value silently mis-weights the ranker for a whole category.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refresh_category_counts()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.categories c
     SET live_video_count = sub.n
    FROM (
      SELECT c2.id,
             (SELECT count(*)
                FROM public.videos v
               WHERE v.category_id = c2.id
                 AND v.status = 'live')::integer AS n
        FROM public.categories c2
    ) sub
   WHERE sub.id = c.id
     AND c.live_video_count IS DISTINCT FROM sub.n;
$$;

REVOKE EXECUTE ON FUNCTION public.refresh_category_counts() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.refresh_category_counts() TO service_role;
