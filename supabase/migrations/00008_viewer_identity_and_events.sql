CREATE TABLE public.viewer_identities (
  anon_id            uuid PRIMARY KEY,
  -- Self-pointing by default. On sign-in this is repointed at the account's
  -- canonical anon_id; that is the entire merge mechanism.
  canonical_anon_id  uuid NOT NULL,
  auth_user_id       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  linked_at          timestamptz,
  -- sha256(ip || ANON_ID_SECRET). Never the raw address: US-only consumer
  -- traffic, no accounts, no reason to hold a plaintext IP. Feeds the 2.9
  -- Herfindahl / identity-farming checks.
  issued_ip_hash     bytea,
  user_agent_hash    bytea,
  events_seen        bigint NOT NULL DEFAULT 0,
  is_flagged         boolean NOT NULL DEFAULT false,
  flagged_reason     text
);

ALTER TABLE public.viewer_identities
  ADD CONSTRAINT viewer_identities_canonical_fk
  FOREIGN KEY (canonical_anon_id) REFERENCES public.viewer_identities(anon_id)
  ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- Exactly one canonical identity per account.
CREATE UNIQUE INDEX idx_viewer_identities_one_canonical
  ON public.viewer_identities (auth_user_id)
  WHERE auth_user_id IS NOT NULL AND canonical_anon_id = anon_id;
CREATE INDEX idx_viewer_identities_canonical ON public.viewer_identities (canonical_anon_id);
CREATE INDEX idx_viewer_identities_ip ON public.viewer_identities (issued_ip_hash, first_seen_at DESC);

CREATE TABLE public.viewer_profiles (
  anon_id             uuid PRIMARY KEY
                        REFERENCES public.viewer_identities(anon_id) ON DELETE CASCADE,
  category_affinity   jsonb NOT NULL DEFAULT '{}',   -- {category_id: score}
  seller_affinity     jsonb NOT NULL DEFAULT '{}',
  hashtag_affinity    jsonb NOT NULL DEFAULT '{}',
  price_band          jsonb,                          -- {p25, p50, p75}
  interest_picks      uuid[],                         -- 2.8 weak prior, weight 0.3
  interest_picks_at   timestamptz,
  avg_watch_ratio     numeric(4,3),
  session_count       integer NOT NULL DEFAULT 0,
  scored_impressions  integer NOT NULL DEFAULT 0,
  total_purchases     integer NOT NULL DEFAULT 0,
  ltv_cents           bigint  NOT NULL DEFAULT 0,
  -- 2.8: flips true after 20 scored impressions.
  cold_start_complete boolean NOT NULL
    GENERATED ALWAYS AS (scored_impressions >= 20) STORED,
  affinity_computed_at timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT viewer_profiles_affinity_is_object
    CHECK (jsonb_typeof(category_affinity) = 'object'
       AND jsonb_typeof(seller_affinity)   = 'object'
       AND jsonb_typeof(hashtag_affinity)  = 'object')
);
CREATE INDEX idx_viewer_profiles_stale ON public.viewer_profiles (affinity_computed_at NULLS FIRST);

-- 2.7: not_interested hard-blocks the seller for 30 days. A hard filter in
-- 2.2 reads this on every candidate query, so it must be one indexed probe.
CREATE TABLE public.viewer_blocks (
  anon_id      uuid NOT NULL,
  subject_type text NOT NULL CHECK (subject_type IN ('video','seller')),
  subject_id   uuid NOT NULL,
  reason       text NOT NULL DEFAULT 'not_interested'
                 CHECK (reason IN ('not_interested','report','admin')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,     -- NULL = permanent (video-level)
  PRIMARY KEY (anon_id, subject_type, subject_id)
);
CREATE INDEX idx_viewer_blocks_active ON public.viewer_blocks (anon_id, subject_type)
  INCLUDE (subject_id);

-- Like / save are UI state, not just events: the heart renders filled.
-- Deriving it from the event log on every slide would be a scan per video.
CREATE TABLE public.viewer_video_reactions (
  anon_id   uuid NOT NULL,
  video_id  uuid NOT NULL REFERENCES public.videos(id) ON DELETE CASCADE,
  liked_at  timestamptz,
  saved_at  timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (anon_id, video_id)
);
CREATE INDEX idx_reactions_saved ON public.viewer_video_reactions (anon_id, saved_at DESC)
  WHERE saved_at IS NOT NULL;
CREATE INDEX idx_reactions_video_liked ON public.viewer_video_reactions (video_id)
  WHERE liked_at IS NOT NULL;

-- The Following feed (3.6) and the social-graph candidate lane (2.2).
-- Keyed on anon_id, not auth user: following requires no account, like
-- everything else a viewer can do.
CREATE TABLE public.follows (
  anon_id    uuid NOT NULL,
  seller_id  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (anon_id, seller_id)
);
CREATE INDEX idx_follows_seller ON public.follows (seller_id);

CREATE TABLE public.feed_slices (
  session_id  uuid NOT NULL,
  video_id    uuid NOT NULL,
  anon_id     uuid NOT NULL,
  lane        public.candidate_lane NOT NULL,
  position    smallint NOT NULL,
  score       numeric(6,5),
  weights_id  uuid,
  served_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, video_id)
);
CREATE INDEX idx_feed_slices_anon    ON public.feed_slices (anon_id, served_at DESC);
CREATE INDEX idx_feed_slices_video   ON public.feed_slices (video_id, served_at DESC);
CREATE INDEX idx_feed_slices_served  ON public.feed_slices USING BRIN (served_at);

CREATE TYPE public.feed_event_type AS ENUM (
  'impression', 'watch_progress', 'skip', 'replay',
  'product_tap', 'variant_select', 'add_to_cart',
  'checkout_open', 'checkout_abandon', 'purchase',
  'like', 'unlike', 'save', 'unsave', 'share',
  'seller_profile_tap', 'follow', 'unfollow',
  'not_interested', 'report', 'video_error'
);
-- 'unsave' and 'video_error' are additions: 3.7 gives save a toggle and 3.9
-- specifies a video_error event. ALTER TYPE ... ADD VALUE covers later ones.

CREATE SEQUENCE public.feed_events_id_seq AS bigint;

-- Column order is deliberate: 8-byte, then 16-byte uuids, then 4-byte ints and
-- enums, then variable-width. Saves ~16 bytes of alignment padding per row,
-- which on the only billion-row table in the system is not a rounding error.
CREATE TABLE public.feed_events (
  created_at        timestamptz NOT NULL DEFAULT now(),
  id                bigint NOT NULL DEFAULT nextval('public.feed_events_id_seq'),

  anon_id           uuid NOT NULL,
  viewer_id         uuid,                -- nullable per spec; resolved server-side
  video_id          uuid NOT NULL,
  seller_id         uuid NOT NULL,       -- denormalized from videos, never client-sent
  product_id        uuid,
  session_id        uuid NOT NULL,

  watched_ms        integer CHECK (watched_ms IS NULL OR watched_ms BETWEEN 0 AND 86400000),
  video_duration_ms integer CHECK (video_duration_ms IS NULL OR video_duration_ms BETWEEN 0 AND 3600000),
  loop_count        smallint CHECK (loop_count IS NULL OR loop_count BETWEEN 0 AND 10000),
  position_in_feed  smallint CHECK (position_in_feed IS NULL OR position_in_feed BETWEEN 0 AND 5000),

  event_type        public.feed_event_type NOT NULL,
  surface           public.feed_surface NOT NULL,
  lane              public.candidate_lane,      -- denormalized from feed_slices

  bucket            text CHECK (bucket IS NULL OR char_length(bucket) <= 32),
  meta              jsonb CHECK (meta IS NULL OR pg_column_size(meta) <= 2048),

  PRIMARY KEY (created_at, id)          -- must contain the partition key
) PARTITION BY RANGE (created_at);

ALTER SEQUENCE public.feed_events_id_seq OWNED BY public.feed_events.id;

-- Deliberately FK-free. An FK on video_id would put a referential check on the
-- hottest write path in the system and would block DETACH/DROP of old
-- partitions. Referential validity is guaranteed instead by the ingestion RPC,
-- which will not write an event whose video_id does not resolve.

-- Declared on the parent; Postgres propagates them to every partition,
-- existing and future.
CREATE INDEX idx_feed_events_video_type
  ON public.feed_events (video_id, event_type, created_at DESC);
CREATE INDEX idx_feed_events_anon
  ON public.feed_events (anon_id, created_at DESC);
CREATE INDEX idx_feed_events_viewer
  ON public.feed_events (viewer_id, created_at DESC) WHERE viewer_id IS NOT NULL;
CREATE INDEX idx_feed_events_session
  ON public.feed_events (session_id, created_at);
-- BRIN, not btree, for the rollup's range scans: append-ordered data, and the
-- index is kilobytes where a btree over a billion rows is tens of gigabytes.
CREATE INDEX idx_feed_events_created_brin
  ON public.feed_events USING BRIN (created_at) WITH (pages_per_range = 32);

CREATE FUNCTION public.create_feed_events_partition(p_month date)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_start date := date_trunc('month', p_month)::date;
  v_end   date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_name  text := format('feed_events_%s', to_char(v_start, 'YYYY_MM'));
BEGIN
  IF to_regclass('public.' || v_name) IS NOT NULL THEN RETURN v_name; END IF;

  EXECUTE format(
    'CREATE TABLE public.%I PARTITION OF public.feed_events
       FOR VALUES FROM (%L) TO (%L)', v_name, v_start, v_end);

  -- THIS IS THE PART THAT MATTERS. Supabase's ALTER DEFAULT PRIVILEGES grants
  -- ALL on new tables in schema public to anon and authenticated, and RLS on a
  -- partitioned parent does NOT cover direct access to a child. Without these
  -- three statements, every month silently publishes a world-readable,
  -- world-writable copy of the entire event stream at
  -- /rest/v1/feed_events_2026_09.
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', v_name);
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_name);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', v_name);

  RETURN v_name;
END;
$$;
ALTER FUNCTION public.create_feed_events_partition(date) SET search_path = public, pg_temp;

CREATE FUNCTION public.ensure_feed_events_partitions(p_months_ahead int DEFAULT 3)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE i int;
BEGIN
  FOR i IN 0..p_months_ahead LOOP
    PERFORM public.create_feed_events_partition(
      (date_trunc('month', now()) + (i || ' months')::interval)::date);
  END LOOP;
END;
$$;
ALTER FUNCTION public.ensure_feed_events_partitions(int) SET search_path = public, pg_temp;

SELECT public.ensure_feed_events_partitions(3);

-- A default partition is a liability (it blocks attaching a real partition
-- that would cover rows it already holds) and an insurance policy (a clock
-- skew or a missed cron never turns into a failed INSERT on the hot path).
-- Losing events is worse than a fixable ops problem, so: keep it, and monitor.
CREATE TABLE public.feed_events_default PARTITION OF public.feed_events DEFAULT;
REVOKE ALL ON public.feed_events_default FROM PUBLIC, anon, authenticated;
ALTER TABLE public.feed_events_default ENABLE ROW LEVEL SECURITY;
-- If this is ever non-empty: DETACH it, create the missing month, INSERT the
-- rows back through the parent, re-ATTACH the emptied default.

-- Retention. 2.7 reads at most 90 days, 3.x reads at most 7. Keep 6 months.
CREATE FUNCTION public.drop_old_feed_events_partitions(p_keep_months int DEFAULT 6)
RETURNS SETOF text LANGUAGE plpgsql AS $$
DECLARE r record; v_cutoff date := (date_trunc('month', now())
                                    - (p_keep_months || ' months')::interval)::date;
BEGIN
  FOR r IN
    SELECT c.relname FROM pg_class c
      JOIN pg_inherits i ON i.inhrelid = c.oid
     WHERE i.inhparent = 'public.feed_events'::regclass
       AND c.relname ~ '^feed_events_\d{4}_\d{2}$'
       AND to_date(right(c.relname, 7), 'YYYY_MM') < v_cutoff
  LOOP
    EXECUTE format('DROP TABLE public.%I', r.relname);
    RETURN NEXT r.relname;
  END LOOP;
END;
$$;
ALTER FUNCTION public.drop_old_feed_events_partitions(int) SET search_path = public, pg_temp;

-- (1) Retry guard. Short-lived, high-churn, disposable. UNLOGGED: this table
-- writes no WAL, and the only consequence of losing it in a crash is that a
-- flush retried across the crash could double-count one batch of impressions.
-- Change the word UNLOGGED to make it durable if that trade stops being worth it.
CREATE UNLOGGED TABLE public.feed_event_dedupe (
  dedupe_key text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_feed_event_dedupe_created
  ON public.feed_event_dedupe USING BRIN (created_at);

CREATE FUNCTION public.sweep_feed_event_dedupe(p_max_rows int DEFAULT 100000)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
  WITH doomed AS (
    SELECT ctid FROM public.feed_event_dedupe
     WHERE created_at < now() - interval '48 hours'
     LIMIT p_max_rows
  )
  DELETE FROM public.feed_event_dedupe d USING doomed
   WHERE d.ctid = doomed.ctid;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;
ALTER FUNCTION public.sweep_feed_event_dedupe(int) SET search_path = public, pg_temp;
-- Upgrade path when the sweep stops keeping up: partition by a plain
-- bucket_day date DEFAULT (now() AT TIME ZONE 'UTC')::date and DROP partitions
-- instead of deleting rows. Not needed at step-7 volume; the sweep is simpler.

-- (2) The durable 2.9 caps: 1 impression, 1 purchase, 20 progress events per
-- anon per video, for the lifetime of the pair. Doubles as the server-side
-- seen-set that step 8's candidate generation subtracts, and as the input to
-- the 2.9 Herfindahl index over viewers per video.
CREATE TABLE public.viewer_video_counters (
  anon_id         uuid NOT NULL,
  video_id        uuid NOT NULL,
  impressions     smallint NOT NULL DEFAULT 0 CHECK (impressions     BETWEEN 0 AND 1),
  purchases       smallint NOT NULL DEFAULT 0 CHECK (purchases       BETWEEN 0 AND 1),
  progress_events smallint NOT NULL DEFAULT 0 CHECK (progress_events BETWEEN 0 AND 20),
  other_events    smallint NOT NULL DEFAULT 0 CHECK (other_events    BETWEEN 0 AND 200),
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_event_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (anon_id, video_id)
);
CREATE INDEX idx_vvc_video ON public.viewer_video_counters (video_id);
CREATE INDEX idx_vvc_stale ON public.viewer_video_counters USING BRIN (last_event_at);
-- Growth is one row per (device, video) ever served, ~60 bytes. Prune rows
-- untouched for 180 days; the affinity window is 90.

CREATE FUNCTION public.feed_event_dedupe_key(
  p_anon_id    uuid,
  p_session_id uuid,
  p_type       public.feed_event_type,
  p_video_id   uuid,
  p_product_id uuid,
  p_bucket     text,
  p_loop       int,
  p_ts_ms      bigint
) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_type
    -- Anon-scoped, session-independent: these ARE the 2.9 caps expressed as
    -- identity, so a new session cannot buy a second impression.
    WHEN 'impression' THEN 'imp:'  || p_anon_id || ':' || p_video_id
    WHEN 'purchase'   THEN 'pur:'  || p_anon_id || ':' || p_video_id
    WHEN 'not_interested' THEN 'ni:' || p_anon_id || ':' || p_video_id
    WHEN 'report'     THEN 'rep:'  || p_anon_id || ':' || p_video_id

    -- Progress: 4 quartiles + up to 16 loop-completes = the spec's 20.
    WHEN 'watch_progress' THEN
      'wp:' || p_anon_id || ':' || p_video_id || ':' || COALESCE(p_bucket, 'q0')
    WHEN 'replay' THEN
      'wp:' || p_anon_id || ':' || p_video_id || ':loop' || LEAST(COALESCE(p_loop,0), 16)

    -- Session-scoped with a coarse time bucket: a retried flush collapses,
    -- a genuine second tap ten seconds later does not.
    WHEN 'skip' THEN
      'skip:' || p_session_id || ':' || p_video_id || ':' || COALESCE(p_loop, 0)
    ELSE
      p_type::text || ':' || p_session_id || ':' || p_video_id || ':' ||
      COALESCE(p_product_id::text, '-') || ':' ||
      COALESCE(p_bucket, '-') || ':' || (p_ts_ms / 2000)::text
  END;
$$;
ALTER FUNCTION public.feed_event_dedupe_key(uuid, uuid, public.feed_event_type,
  uuid, uuid, text, int, bigint) SET search_path = public, pg_temp;

CREATE FUNCTION public.feed_event_cap_class(p_type public.feed_event_type)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_type = 'impression' THEN 'impression'
    WHEN p_type = 'purchase'   THEN 'purchase'
    WHEN p_type IN ('watch_progress','replay') THEN 'progress'
    ELSE 'other' END;
$$;
ALTER FUNCTION public.feed_event_cap_class(public.feed_event_type)
  SET search_path = public, pg_temp;

CREATE FUNCTION public.ingest_feed_events(
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

  INSERT INTO public.viewer_video_reactions AS r (anon_id, video_id, liked_at, saved_at)
  SELECT p_anon_id, a.video_id,
         max(CASE WHEN a.event_type = 'like' THEN now() END),
         max(CASE WHEN a.event_type = 'save' THEN now() END)
  FROM _admitted a
  WHERE a.event_type IN ('like','unlike','save','unsave')
  GROUP BY a.video_id
  ON CONFLICT (anon_id, video_id) DO UPDATE SET
    liked_at = CASE WHEN EXCLUDED.liked_at IS NOT NULL THEN EXCLUDED.liked_at
                    ELSE NULL END,
    saved_at = CASE WHEN EXCLUDED.saved_at IS NOT NULL THEN EXCLUDED.saved_at
                    ELSE NULL END,
    updated_at = now();

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

REVOKE EXECUTE ON FUNCTION public.ingest_feed_events(uuid, uuid, public.feed_surface, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.ingest_feed_events(uuid, uuid, public.feed_surface, jsonb)
  TO service_role;

CREATE FUNCTION public.link_anon_identity(p_anon_id uuid, p_auth_user_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_canonical uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_auth_user_id::text, 1));

  INSERT INTO public.viewer_identities (anon_id, canonical_anon_id)
  VALUES (p_anon_id, p_anon_id) ON CONFLICT (anon_id) DO NOTHING;

  SELECT anon_id INTO v_canonical
  FROM public.viewer_identities
  WHERE auth_user_id = p_auth_user_id AND canonical_anon_id = anon_id;

  IF v_canonical IS NULL THEN
    -- First device for this account: it becomes canonical.
    UPDATE public.viewer_identities
       SET auth_user_id = p_auth_user_id, canonical_anon_id = anon_id,
           linked_at = now()
     WHERE anon_id = p_anon_id;
    v_canonical := p_anon_id;
  ELSE
    -- Second device: alias it. History is NOT rewritten. The affinity job
    -- (step 9) resolves through canonical_anon_id, so past events on this
    -- device still count; and because the caller rewrites the cookie to the
    -- canonical id, no future event needs resolving at all.
    UPDATE public.viewer_identities
       SET auth_user_id = p_auth_user_id, canonical_anon_id = v_canonical,
           linked_at = now()
     WHERE anon_id = p_anon_id;
  END IF;

  INSERT INTO public.viewer_profiles (anon_id) VALUES (v_canonical)
  ON CONFLICT DO NOTHING;

  RETURN v_canonical;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.link_anon_identity(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.link_anon_identity(uuid, uuid) TO service_role;

ALTER TABLE public.viewer_identities      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.viewer_profiles        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.viewer_blocks          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.viewer_video_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.follows                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feed_slices            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feed_events            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feed_event_dedupe      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.viewer_video_counters  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.viewer_identities, public.viewer_profiles,
              public.viewer_blocks, public.viewer_video_reactions,
              public.follows, public.feed_slices, public.feed_events,
              public.feed_event_dedupe, public.viewer_video_counters
  FROM PUBLIC, anon, authenticated;

-- Stops the next table anyone adds from being world-accessible by default.
-- It changes behaviour for every future CREATE TABLE in public, so land it
-- deliberately rather than as a side effect.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated;
-- ---------------------------------------------------------------------------
-- Sequence privileges. Revoking table grants is not enough: Supabase's default
-- privileges also grant USAGE on sequences, so anon could call nextval() on
-- feed_events_id_seq and burn identifiers without ever inserting a row.
-- Verified against a real Postgres before adding this.
-- ---------------------------------------------------------------------------
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
