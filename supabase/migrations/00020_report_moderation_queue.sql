-- =============================================================================
-- 00020 -- a report lands in a moderation queue and hides the video
-- =============================================================================
--
-- WHY (App Store guideline 1.2)
-- -----------------------------
-- The native app reports a video by sending a feed event with t = 'report'
-- to POST /api/events, which calls ingest_feed_events. Until now a report
-- only fed the ranking signal (video_stats.reports_all, 00009/00013):
--   * nothing wrote public.reports, so the owner had no queue to review, and
--   * the video was not hidden from the reporter, so it could come back.
-- Guideline 1.2 asks for a way to report objectionable content AND for the
-- developer to act on reports; a reporter seeing the same video again reads
-- as "reporting does nothing".
--
-- WHAT THIS FILE DOES
-- -------------------
--   1. A unique index on public.reports (reporter_anon_id, video_id): one
--      queue row per reporter per video. NULL reporter ids (the legacy,
--      drop-era rows from 00005/00006) never conflict with each other, so the
--      index builds on any existing data. A partial index on open reports
--      backs the review query in docs/DRIP_BACKEND_INTEGRATION.md.
--   2. CREATE OR REPLACE ingest_feed_events: the 00017 body unchanged except
--      one new block, after the not_interested blocks. For every ADMITTED
--      'report' event (passed sanity, won its dedupe key, under its cap --
--      exactly the rows that reach feed_events):
--        a. INSERT one public.reports row (video_id, product_id, reporter =
--           p_anon_id, reason, details), ON CONFLICT DO NOTHING on (1).
--             - product_id: the event's 'p' (already verified to be on the
--               video by the sane CTE), else the video's product when it has
--               exactly one, else NULL. Never a guess between several.
--             - reason: reports.reason is NOT NULL with CHECK IN
--               ('prohibited_item','copyright','scam','other'). The client's
--               meta.reason is free text (iOS sends "Prohibited item",
--               "Misleading", "Inappropriate", "Spam"), so it is normalised
--               (lower-case, non-letters -> '_') and kept when it names an
--               allowed value, else 'other'. The raw text is always kept,
--               truncated to 500 chars, in details, so nothing is lost.
--        b. INSERT a permanent viewer_blocks row (subject_type 'video',
--           reason 'report', expires_at NULL). loadViewerBlocks
--           (src/lib/feed/blocks.ts) reads every unexpired row regardless of
--           reason, and the naive feed, ranked feed (notInterestedVideoIds)
--           and search all exclude its blockedVideos, so the video never
--           reappears for that viewer. An existing block on the same video
--           (e.g. from not_interested) is upgraded to permanent with reason
--           'report'; an 'admin' block keeps its reason.
--      Signature, LANGUAGE, SECURITY DEFINER, search_path and return type are
--      identical to 00017; CREATE OR REPLACE keeps owner and privileges, and
--      the REVOKE/GRANT from 00008 is restated below anyway.
--   3. Backfill: report events already in feed_events (sent before this
--      migration) get their reports and viewer_blocks rows, through the same
--      rules. Their dedupe keys ('rep:<anon>:<video>') are already claimed, so
--      without this a viewer who reported before 00020 could never get a
--      queue row by reporting again. Idempotent (ON CONFLICT). feed_events is
--      scanned once filtered on event_type; pre-launch volume makes that
--      cheap. Rows whose video no longer exists are skipped (reports.video_id
--      is an FK; feed_events is deliberately FK-free).
--   4. Grants. Nothing new is created except two indexes. reports stays
--      service-role only, now explicitly: 00006 created it as "service role
--      only: reporters are anonymous, sellers must not see reports" (RLS on,
--      zero policies), and 00019 noted that its anon/authenticated
--      privileges come only from old Supabase defaults and that a REVOKE
--      would match intent. It now holds reporter anon ids, so make it
--      explicit. No code reads reports with a browser role (grep src/, ios/).
--
-- Why not on the TS side: the route already forwards meta and p unchanged,
-- and the side effects must be atomic with the event's admission (same
-- transaction, same advisory lock, same dedupe claim) or a retried batch
-- could write a report without its event or vice versa.
--
-- Part of the 00006+ chain: apply after 00017 (it replaces 00017's body).
-- Idempotent: re-running it changes nothing.
-- =============================================================================

-- 1. ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS reports_reporter_video_key
  ON public.reports (reporter_anon_id, video_id);

CREATE INDEX IF NOT EXISTS idx_reports_open
  ON public.reports (created_at)
  WHERE resolved_at IS NULL;

-- 2. ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ingest_feed_events(
  p_anon_id    uuid,
  p_session_id uuid,
  p_surface    public.feed_surface,
  p_events     jsonb
) RETURNS TABLE (accepted int, deduped int, discarded int)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_total int := jsonb_array_length(p_events);
  v_kept  int := 0;
  v_sane  int := 0;
BEGIN
  IF v_total = 0 THEN RETURN QUERY SELECT 0, 0, 0; RETURN; END IF;
  IF v_total > 50 THEN RAISE EXCEPTION 'batch too large (% events)', v_total; END IF;

  -- Serialize this device's batches. Without it two concurrent flushes both
  -- read impressions = 0 and both admit an impression. A single client flushes
  -- serially, so contention is nil and the lock costs nothing.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_anon_id::text, 0));

  INSERT INTO public.viewer_identities (anon_id, canonical_anon_id)
  VALUES (p_anon_id, p_anon_id)
  ON CONFLICT (anon_id) DO UPDATE SET last_seen_at = now();

  CREATE TEMP TABLE _batch ON COMMIT DROP AS
  WITH raw AS (
    SELECT
      ord,
      (e->>'t')::public.feed_event_type              AS event_type,
      (e->>'v')::uuid                                AS video_id,
      NULLIF(e->>'p','')::uuid                       AS product_id,
      NULLIF(e->>'wm','')::int                       AS watched_ms,
      NULLIF(e->>'dm','')::int                       AS client_duration_ms,
      COALESCE(NULLIF(e->>'lc','')::int, 0)          AS loop_count,
      NULLIF(e->>'pos','')::int                      AS position_in_feed,
      left(NULLIF(e->>'b',''), 32)                   AS bucket,
      COALESCE(NULLIF(e->>'ts','')::bigint,
               (extract(epoch FROM now())*1000)::bigint) AS ts_ms,
      CASE WHEN jsonb_typeof(e->'meta') = 'object' THEN e->'meta' END AS meta
    FROM jsonb_array_elements(p_events) WITH ORDINALITY AS t(e, ord)
  ),
  joined AS (
    SELECT r.*,
           v.seller_id,
           (v.duration_seconds * 1000)::int AS server_duration_ms,
           vi.auth_user_id                  AS viewer_id,
           fs.lane
    FROM raw r
    JOIN public.videos v ON v.id = r.video_id
    LEFT JOIN public.viewer_identities vi ON vi.anon_id = p_anon_id
    LEFT JOIN public.feed_slices fs
           ON fs.session_id = p_session_id AND fs.video_id = r.video_id
  ),
  sane AS (
    SELECT * FROM joined j
    WHERE
      -- 2.9 watched_ms sanity. Checked against the SERVER's duration, not the
      -- client's: a client that can inflate video_duration_ms can defeat its
      -- own sanity check, which makes the rule decorative. The client value is
      -- still stored, for measuring how far off clients are.
      (j.watched_ms IS NULL
        OR (j.watched_ms >= 0
            AND (j.server_duration_ms IS NULL OR j.server_duration_ms = 0
                 OR j.watched_ms <= j.server_duration_ms * (j.loop_count + 1) * 1.1)))
      -- A product_id must actually be on this video. Otherwise a viewer can
      -- attribute taps and carts to any product in the catalog.
      AND (j.product_id IS NULL OR EXISTS (
            SELECT 1 FROM public.video_products vp
             WHERE vp.video_id = j.video_id AND vp.product_id = j.product_id))
  ),
  keyed AS (
    SELECT DISTINCT ON (dedupe_key) *
    FROM (
      SELECT s.*, public.feed_event_dedupe_key(
               p_anon_id, p_session_id, s.event_type, s.video_id,
               s.product_id, s.bucket, s.loop_count, s.ts_ms) AS dedupe_key
      FROM sane s
    ) k
    ORDER BY dedupe_key, ord      -- collapse duplicates inside the batch too
  )
  SELECT * FROM keyed;

  SELECT count(*) INTO v_sane FROM _batch;

  -- Claim the dedupe keys. Only rows we win are eligible.
  CREATE TEMP TABLE _fresh ON COMMIT DROP AS
  WITH claimed AS (
    INSERT INTO public.feed_event_dedupe (dedupe_key)
    SELECT dedupe_key FROM _batch
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING dedupe_key
  )
  SELECT b.* FROM _batch b JOIN claimed c USING (dedupe_key);

  -- Apply the 2.9 per-anon-per-video caps against the durable counters.
  CREATE TEMP TABLE _admitted ON COMMIT DROP AS
  SELECT f.*
  FROM (
    SELECT f.*,
           public.feed_event_cap_class(f.event_type) AS cap_class,
           row_number() OVER (
             PARTITION BY f.video_id, public.feed_event_cap_class(f.event_type)
             ORDER BY f.ord) AS rn,
           COALESCE(c.impressions, 0)     AS cur_imp,
           COALESCE(c.purchases, 0)       AS cur_pur,
           COALESCE(c.progress_events, 0) AS cur_prog,
           COALESCE(c.other_events, 0)    AS cur_other
    FROM _fresh f
    LEFT JOIN public.viewer_video_counters c
           ON c.anon_id = p_anon_id AND c.video_id = f.video_id
  ) f
  WHERE CASE f.cap_class
          WHEN 'impression' THEN f.cur_imp   + f.rn <= 1
          WHEN 'purchase'   THEN f.cur_pur   + f.rn <= 1
          WHEN 'progress'   THEN f.cur_prog  + f.rn <= 20
          ELSE                   f.cur_other + f.rn <= 200
        END;

  INSERT INTO public.feed_events
    (anon_id, viewer_id, video_id, seller_id, product_id, session_id,
     watched_ms, video_duration_ms, loop_count, position_in_feed,
     event_type, surface, lane, bucket, meta)
  SELECT p_anon_id, a.viewer_id, a.video_id, a.seller_id, a.product_id, p_session_id,
         a.watched_ms, a.client_duration_ms, a.loop_count, a.position_in_feed,
         a.event_type, p_surface, a.lane, a.bucket, a.meta
  FROM _admitted a;
  GET DIAGNOSTICS v_kept = ROW_COUNT;

  INSERT INTO public.viewer_video_counters AS c
    (anon_id, video_id, impressions, purchases, progress_events, other_events)
  SELECT p_anon_id, a.video_id,
         count(*) FILTER (WHERE a.cap_class = 'impression'),
         count(*) FILTER (WHERE a.cap_class = 'purchase'),
         count(*) FILTER (WHERE a.cap_class = 'progress'),
         count(*) FILTER (WHERE a.cap_class = 'other')
  FROM _admitted a GROUP BY a.video_id
  ON CONFLICT (anon_id, video_id) DO UPDATE SET
    impressions     = LEAST(c.impressions     + EXCLUDED.impressions,     1),
    purchases       = LEAST(c.purchases       + EXCLUDED.purchases,       1),
    progress_events = LEAST(c.progress_events + EXCLUDED.progress_events, 20),
    other_events    = LEAST(c.other_events    + EXCLUDED.other_events,    200),
    last_event_at   = now();

  -- ---- state side effects, all idempotent so a retried batch is harmless ----

  -- 2.7: not_interested hard-blocks the seller for 30 days, and the video
  -- permanently.
  INSERT INTO public.viewer_blocks (anon_id, subject_type, subject_id, expires_at)
  SELECT p_anon_id, 'video', a.video_id, NULL
  FROM _admitted a WHERE a.event_type = 'not_interested'
  ON CONFLICT DO NOTHING;

  INSERT INTO public.viewer_blocks (anon_id, subject_type, subject_id, expires_at)
  SELECT DISTINCT p_anon_id, 'seller', a.seller_id, now() + interval '30 days'
  FROM _admitted a WHERE a.event_type = 'not_interested'
  ON CONFLICT (anon_id, subject_type, subject_id)
    DO UPDATE SET expires_at = now() + interval '30 days';

  -- 00020: a report goes to the moderation queue (one row per reporter per
  -- video) and hides the video from the reporter permanently. Both are
  -- idempotent, like every side effect here. See the file header.
  INSERT INTO public.reports (video_id, product_id, reporter_anon_id, reason, details)
  SELECT DISTINCT ON (a.video_id)
         a.video_id,
         COALESCE(a.product_id,
                  (SELECT CASE WHEN count(*) = 1 THEN (array_agg(vp.product_id))[1] END
                     FROM public.video_products vp
                    WHERE vp.video_id = a.video_id)),
         p_anon_id,
         CASE lower(regexp_replace(btrim(COALESCE(a.meta->>'reason', '')),
                                   '[^A-Za-z]+', '_', 'g'))
           WHEN 'prohibited_item' THEN 'prohibited_item'
           WHEN 'copyright'       THEN 'copyright'
           WHEN 'scam'            THEN 'scam'
           ELSE 'other'
         END,
         left(NULLIF(btrim(a.meta->>'reason'), ''), 500)
  FROM _admitted a
  WHERE a.event_type = 'report'
  ORDER BY a.video_id, a.ord
  ON CONFLICT (reporter_anon_id, video_id) DO NOTHING;

  INSERT INTO public.viewer_blocks AS vb
    (anon_id, subject_type, subject_id, reason, expires_at)
  SELECT DISTINCT p_anon_id, 'video', a.video_id, 'report', NULL::timestamptz
  FROM _admitted a WHERE a.event_type = 'report'
  ON CONFLICT (anon_id, subject_type, subject_id)
    DO UPDATE SET reason     = CASE WHEN vb.reason = 'admin' THEN 'admin' ELSE 'report' END,
                  expires_at = NULL;

  -- Like and save are independent: each column changes only when its own
  -- kind of event is in the batch, and the LAST such event (batch order)
  -- wins. The 00008 upsert wrote NULL into the other column, so liking a
  -- saved video un-saved it. apply_video_reactions (00010) already has the
  -- right semantics; it was simply never called.
  PERFORM public.apply_video_reactions(p_anon_id, x.video_id, x.liked, x.saved)
  FROM (
    SELECT a.video_id,
           (array_agg(a.event_type = 'like' ORDER BY a.ord DESC)
              FILTER (WHERE a.event_type IN ('like','unlike')))[1] AS liked,
           (array_agg(a.event_type = 'save' ORDER BY a.ord DESC)
              FILTER (WHERE a.event_type IN ('save','unsave')))[1] AS saved
    FROM _admitted a
    WHERE a.event_type IN ('like','unlike','save','unsave')
    GROUP BY a.video_id
  ) x;

  INSERT INTO public.follows (anon_id, seller_id)
  SELECT DISTINCT p_anon_id, a.seller_id
  FROM _admitted a WHERE a.event_type = 'follow'
  ON CONFLICT DO NOTHING;

  DELETE FROM public.follows f
  USING _admitted a
  WHERE f.anon_id = p_anon_id AND f.seller_id = a.seller_id
    AND a.event_type = 'unfollow';

  UPDATE public.viewer_identities
     SET events_seen = events_seen + v_kept, last_seen_at = now()
   WHERE anon_id = p_anon_id;

  RETURN QUERY SELECT v_kept, (v_sane - v_kept), (v_total - v_sane);
END;
$$;

-- Unchanged from 00008; CREATE OR REPLACE already kept these, restated so the
-- file is self-describing.
REVOKE EXECUTE ON FUNCTION public.ingest_feed_events(uuid, uuid, public.feed_surface, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.ingest_feed_events(uuid, uuid, public.feed_surface, jsonb)
  TO service_role;

-- 3. Backfill reports sent before this migration ------------------------------
INSERT INTO public.reports (video_id, product_id, reporter_anon_id, reason, details, created_at)
SELECT DISTINCT ON (fe.anon_id, fe.video_id)
       fe.video_id,
       COALESCE(
         (SELECT vp.product_id FROM public.video_products vp
           WHERE vp.video_id = fe.video_id AND vp.product_id = fe.product_id),
         (SELECT CASE WHEN count(*) = 1 THEN (array_agg(vp.product_id))[1] END
            FROM public.video_products vp
           WHERE vp.video_id = fe.video_id)),
       fe.anon_id,
       CASE lower(regexp_replace(btrim(COALESCE(fe.meta->>'reason', '')),
                                 '[^A-Za-z]+', '_', 'g'))
         WHEN 'prohibited_item' THEN 'prohibited_item'
         WHEN 'copyright'       THEN 'copyright'
         WHEN 'scam'            THEN 'scam'
         ELSE 'other'
       END,
       left(NULLIF(btrim(fe.meta->>'reason'), ''), 500),
       fe.created_at
FROM public.feed_events fe
JOIN public.videos v ON v.id = fe.video_id
WHERE fe.event_type = 'report'
ORDER BY fe.anon_id, fe.video_id, fe.created_at
ON CONFLICT (reporter_anon_id, video_id) DO NOTHING;

INSERT INTO public.viewer_blocks AS vb
  (anon_id, subject_type, subject_id, reason, expires_at)
SELECT DISTINCT fe.anon_id, 'video', fe.video_id, 'report', NULL::timestamptz
FROM public.feed_events fe
WHERE fe.event_type = 'report'
ON CONFLICT (anon_id, subject_type, subject_id)
  DO UPDATE SET reason     = CASE WHEN vb.reason = 'admin' THEN 'admin' ELSE 'report' END,
                expires_at = NULL;

-- 4. Grants --------------------------------------------------------------------
-- Explicit, per supabase/migrations/README.md. reports: service role only (see
-- header); viewer_blocks: unchanged from 00008/00019, restated.
REVOKE ALL ON public.reports FROM PUBLIC, anon, authenticated;
GRANT  ALL ON public.reports       TO service_role;
GRANT  ALL ON public.viewer_blocks TO service_role;
