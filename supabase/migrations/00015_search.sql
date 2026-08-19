-- =============================================================================
-- 00015  search
--
-- Adds Part B of the ranking-engine-and-search plan: full-text search over
-- the video feed, the only surface a viewer actually browses. Nothing in the
-- app exposes search today beyond a non-wired <input> on the landing page.
--
-- SHAPE. Two generated tsvector columns (products.search_vector,
-- videos.caption_search) + GIN indexes, matching this repo's existing
-- generated-column conventions. Ranking spans BOTH: a query can match a
-- video's own caption OR any of its attached sellable products' title/
-- description -- "chunky white sneakers" should surface the video whose
-- caption says nothing about shoes but whose pinned product is titled
-- exactly that. Hashtags are matched separately via array overlap against
-- the pre-existing idx_videos_hashtags_gin index, not folded into the
-- tsvector: a hashtag is a discrete tag, not prose, and `websearch_to_tsquery`
-- would drop a bare "#drip" token's meaning.
--
-- WHY A FUNCTION, NOT A PostgREST .textSearch() CALL. supabase-js can filter
-- on a tsvector column directly, but it cannot express "rank across two
-- joined tables and return the higher score" as a single declarative query --
-- that needs real SQL. Same rationale as refresh_category_rate_medians
-- (00013) and ingest_feed_events (00008): SECURITY DEFINER + SET search_path,
-- REVOKE from PUBLIC/anon/authenticated, GRANT to service_role only, since
-- every caller here is the admin client (an anon device has no JWT to reach
-- PostgREST with in the first place -- same posture as the rest of the feed).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Generated tsvector columns + GIN indexes
-- -----------------------------------------------------------------------------

ALTER TABLE public.products ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) STORED;

CREATE INDEX idx_products_search_vector ON public.products USING GIN (search_vector);

ALTER TABLE public.videos ADD COLUMN caption_search tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(caption, ''))) STORED;

CREATE INDEX idx_videos_caption_search ON public.videos USING GIN (caption_search);

-- -----------------------------------------------------------------------------
-- 2. search_feed_videos — ranked video ids for a free-text query
-- -----------------------------------------------------------------------------

-- Same commerce-eligibility filters slice.ts and pool.ts already apply:
-- status='live', a sellable (active, in-stock) attached product, seller
-- charges_enabled. A search result a viewer cannot buy from is a dead end,
-- same rule the naive and ranked feeds both already enforce.
CREATE OR REPLACE FUNCTION public.search_feed_videos(
  p_query          text,
  p_category_slug  text    DEFAULT NULL,
  p_seller_handle  text    DEFAULT NULL,
  p_limit          integer DEFAULT 20,
  p_exclude_ids    uuid[]  DEFAULT '{}'::uuid[]
)
RETURNS TABLE (video_id uuid, rank real)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  WITH q AS (
    SELECT
      websearch_to_tsquery('english', coalesce(p_query, '')) AS tsq,
      -- Bare lowercase words, for the hashtag overlap check below --
      -- websearch_to_tsquery stems and drops stopwords, which is wrong for
      -- an exact tag match ("running" must not match a video tagged #run).
      -- The split alphabet must match normalize_video_hashtags' (00007),
      -- which deliberately PRESERVES underscores: splitting on '[^a-z0-9]+'
      -- treated '_' as a delimiter, so a query word could never contain one
      -- and a video tagged 'desk_setup' was unreachable through the hashtag
      -- branch by any query at all.
      array_remove(regexp_split_to_array(lower(coalesce(p_query, '')), '[^a-z0-9_]+'), '') AS words
  ),
  product_rank AS (
    SELECT vp.video_id, max(ts_rank(p.search_vector, q.tsq)) AS rank
    FROM public.video_products vp
    JOIN public.products p ON p.id = vp.product_id
    CROSS JOIN q
    WHERE p.status = 'active' AND p.inventory_count > 0
      AND p.search_vector @@ q.tsq
    GROUP BY vp.video_id
  )
  SELECT v.id AS video_id,
         GREATEST(
           ts_rank(v.caption_search, q.tsq),
           coalesce(pr.rank, 0),
           CASE WHEN v.hashtags && q.words THEN 0.5 ELSE 0 END
         ) AS rank
  FROM public.videos v
  CROSS JOIN q
  JOIN public.profiles sel ON sel.id = v.seller_id
  JOIN public.seller_payments sp ON sp.seller_id = sel.id AND sp.charges_enabled = true
  LEFT JOIN public.categories c ON c.id = v.category_id
  LEFT JOIN product_rank pr ON pr.video_id = v.id
  WHERE v.status = 'live'
    AND v.published_at IS NOT NULL
    AND NOT (v.id = ANY(p_exclude_ids))
    AND (p_category_slug IS NULL OR c.slug = p_category_slug)
    AND (p_seller_handle IS NULL OR sel.handle = p_seller_handle)
    AND EXISTS (
      SELECT 1 FROM public.video_products vp2
      JOIN public.products p2 ON p2.id = vp2.product_id
      WHERE vp2.video_id = v.id AND p2.status = 'active' AND p2.inventory_count > 0
    )
    AND (
      v.caption_search @@ q.tsq
      OR pr.video_id IS NOT NULL
      OR v.hashtags && q.words
    )
  ORDER BY rank DESC, v.published_at DESC
  LIMIT greatest(p_limit, 0);
$fn$;

COMMENT ON FUNCTION public.search_feed_videos(text, text, text, integer, uuid[]) IS
  'Ranked video ids for a free-text search: matches a video''s own caption, '
  'any attached sellable product''s title/description, or an exact hashtag '
  'word, ranked by the best of the three. Commerce-eligibility filters match '
  'slice.ts/pool.ts exactly.';

REVOKE EXECUTE ON FUNCTION public.search_feed_videos(text, text, text, integer, uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.search_feed_videos(text, text, text, integer, uuid[])
  TO service_role;
