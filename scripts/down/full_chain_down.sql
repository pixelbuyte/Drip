-- =============================================================================
-- scripts/down/full_chain_down.sql
--
-- COMPLETE down-migration for the reconciled chain 00006..00016.
-- Takes a POST-CHAIN database back to the PRE-CHAIN production state of
-- Supabase project tkppdmrkvyjixaiocwmd (tables profiles / drops / orders /
-- seller_payments / processed_events; policies by production's REAL names as
-- per the read-only pg_policies dump of 2026-08-19; 00001's BOOLEAN
-- decrement_inventory; Supabase-default grants on profiles and orders).
--
-- Lives OUTSIDE supabase/migrations/ on purpose: no version-ordered tool may
-- ever auto-apply it. Apply deliberately, with plain psql:
--     psql ... -v ON_ERROR_STOP=1 -f scripts/down/full_chain_down.sql
-- The file is one explicit transaction; any failure rolls everything back.
--
-- KNOWN, ACCEPTED IRREVERSIBILITIES (all vacuous for today's production data,
-- every one verified against the replica; they matter only if the chain has
-- been live long enough to accrue feed-era data):
--   * All feed-era rows (videos beyond the backfilled drops, products,
--     order_items, feed_events, viewer_*, categories, weights, stats...) are
--     DESTROYED. That is the point of a down-migration to a pre-feed schema.
--   * 00007's backfill COALESCEd NULL drop shipping fields to defaults
--     (8.0 oz / 9x6x2). A drop whose weight/dimensions were NULL pre-chain
--     comes back with those defaults instead of NULL. Production's one drop
--     has real values, so this path is not taken.
--   * drops.video_url has no post-chain home (00007 discards it with a
--     WARNING); it is restored as NULL. NULL for every production row.
--   * drops.mux_asset_id was backfilled into videos as NULL (00007 line 338);
--     restored from videos.mux_asset_id, i.e. NULL. NULL in production.
--   * videos in status 'removed' (no pre-chain equivalent) map to 'archived';
--     'processing' maps back to 'active' — this inverts 00006 section 4's
--     demotion of the video-less demo drop, which is the required data flip.
--   * A post-chain order with video_id IS NULL cannot be expressed pre-chain
--     (drop_id was NOT NULL); the SET NOT NULL below fails loudly rather
--     than inventing data. Production has 0 orders.
--   * orders.drop_id is re-added via ALTER TABLE, so its column position is
--     at the end instead of position 2. Postgres cannot reorder columns
--     without a full table rewrite; semantically identical.
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. Unschedule the cron jobs (inverse of 00016), with 00016's own guard
--    pattern: skip cleanly where pg_cron does not exist.
-- =============================================================================
DO $cron$
DECLARE
  v_job record;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron')
     AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    FOR v_job IN
      SELECT jobid, jobname FROM cron.job
       WHERE jobname IN ('video-stats-rollup', 'feed-dedupe-sweep',
                         'category-counts', 'feed-events-partitions',
                         'feed-events-retention', 'viewer-counters-prune',
                         'category-rate-medians')
    LOOP
      PERFORM cron.unschedule(v_job.jobid);
    END LOOP;
    -- The extension itself is left installed: enabling it was a dashboard
    -- action, not a chain effect, and dropping it could break unrelated jobs.
  ELSE
    RAISE NOTICE 'pg_cron unavailable/not installed - nothing to unschedule';
  END IF;
END
$cron$;

-- =============================================================================
-- 2. Restore the pre-chain DEFAULT PRIVILEGES (inverse of 00008's two ALTER
--    DEFAULT PRIVILEGES REVOKEs). Done FIRST so the drops table recreated
--    below is born with the same Supabase-default grants the original had.
-- =============================================================================
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated;

-- =============================================================================
-- 3. Reconstruct public.drops: 00001's shape verbatim, plus the two
--    out-of-band columns (video_url, image_url) production carries, in
--    production's column order. Original constraint names come from the same
--    inline syntax 00001 used.
-- =============================================================================
CREATE TABLE public.drops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 100),
  inventory INTEGER NOT NULL CHECK (inventory >= 0),
  weight_oz DECIMAL(10, 2),
  dimensions JSONB,
  mux_asset_id TEXT,
  mux_playback_id TEXT,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  video_url TEXT,
  image_url TEXT,
  UNIQUE(seller_id, slug)
);

CREATE INDEX idx_drops_seller_id ON public.drops(seller_id);
CREATE INDEX idx_drops_slug ON public.drops(slug);

ALTER TABLE public.drops ENABLE ROW LEVEL SECURITY;

-- Production's real policy set for drops (pg_policies dump 2026-08-19):
-- both policies apply to {public}, not TO anon.
CREATE POLICY "drops_seller_read_write_own" ON public.drops
  FOR ALL USING (auth.uid() = seller_id) WITH CHECK (auth.uid() = seller_id);
CREATE POLICY "drops_public_read_active" ON public.drops
  FOR SELECT USING (status = 'active');

CREATE TRIGGER drops_updated_at
  BEFORE UPDATE ON public.drops
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ---------------------------------------------------------------------------
-- Backfill: precise inversion of 00007's drops -> videos/products/
-- shipping_profiles backfill. All three kept the drop's uuid as their own id,
-- so the join is by id:
--   * title/slug/description/price/inventory come back from products
--     (00007 copied them verbatim; drops.title was only TRUNCATED into
--     shipping_profiles.name, products.title kept it whole);
--   * weight/dimensions come back from the per-drop shipping profile
--     (::float8 strips the numeric(6,2) trailing zeros so the rebuilt jsonb
--     numbers render exactly like the originals);
--   * image_url comes back from videos.thumbnail_url (00007 carried it there);
--   * mux ids come back from videos;
--   * status inverts 00007's CASE: live->active, paused->archived, and
--     processing->active, which un-does 00006 section 4's demotion of the
--     video-less demo drop (the required active flip-back). removed (no
--     pre-chain word for it) maps to archived.
--   * created_at survives untouched (00007 copied it into videos.created_at).
-- INSERT fires no BEFORE UPDATE trigger, so updated_at is written as given.
-- ---------------------------------------------------------------------------
INSERT INTO public.drops
  (id, seller_id, title, slug, description, price_cents, inventory, weight_oz,
   dimensions, mux_asset_id, mux_playback_id, status, created_at, updated_at,
   video_url, image_url)
SELECT v.id,
       v.seller_id,
       p.title,
       p.slug,
       p.description,
       p.price_cents,
       p.inventory_count,
       sp.weight_oz,
       CASE WHEN sp.id IS NOT NULL THEN
         jsonb_build_object('length_in', sp.length_in::float8,
                            'width_in',  sp.width_in::float8,
                            'height_in', sp.height_in::float8)
       END,
       v.mux_asset_id,
       v.mux_playback_id,
       CASE v.status WHEN 'live'    THEN 'active'
                     WHEN 'paused'  THEN 'archived'
                     WHEN 'removed' THEN 'archived'
                     ELSE 'active' END,   -- 'processing': invert 00006 sect 4
       v.created_at,
       v.updated_at,
       NULL,                              -- video_url: discarded by 00007, NULL in prod
       v.thumbnail_url
FROM public.videos v
LEFT JOIN public.products          p  ON p.id  = v.id
LEFT JOIN public.shipping_profiles sp ON sp.id = v.id;

-- =============================================================================
-- 4. Orders back to 00001's shape (must precede DROP TABLE videos: the chain
--    put an FK on orders.video_id).
-- =============================================================================
ALTER TABLE public.orders
  ADD COLUMN drop_id UUID REFERENCES public.drops(id) ON DELETE CASCADE;

-- Inversion of 00007's `UPDATE orders SET video_id = drop_id` (video ids ARE
-- the old drop ids). 0 rows in production; fails the NOT NULL below rather
-- than inventing a drop_id if a post-chain feed order (video_id NULL) exists.
UPDATE public.orders SET drop_id = video_id;
ALTER TABLE public.orders ALTER COLUMN drop_id SET NOT NULL;

ALTER TABLE public.orders
  DROP COLUMN video_id,
  DROP COLUMN buyer_anon_id,
  DROP COLUMN buyer_viewer_id,
  DROP COLUMN session_id,
  DROP COLUMN surface,
  DROP COLUMN idempotency_key,
  DROP COLUMN stripe_payment_intent_id,
  DROP COLUMN subtotal_cents,
  DROP COLUMN tax_cents,
  DROP COLUMN total_cents,
  DROP COLUMN platform_fee_cents,
  DROP COLUMN refunded_at,
  DROP COLUMN disputed_at;
-- (idx_orders_idempotency_key / _payment_intent / _video_created / _buyer_anon
--  fell with their columns.)

-- 00007 made stripe_session_id nullable for PaymentIntent-only feed orders;
-- pre-chain it is NOT NULL.
ALTER TABLE public.orders ALTER COLUMN stripe_session_id SET NOT NULL;

-- Status vocabulary back to 00001's four values (00006 added 'refunded',
-- 00007 widened further).
ALTER TABLE public.orders DROP CONSTRAINT orders_status_check;
ALTER TABLE public.orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('paid', 'label_created', 'shipped', 'delivered'));

CREATE INDEX idx_orders_drop_id ON public.orders(drop_id);
DROP INDEX public.idx_orders_updated_at;      -- 00007
DROP INDEX public.idx_orders_tracking_code;   -- 00006

-- Policies 00006 removed, by production's names and 00001's definitions.
CREATE POLICY "orders_insert_for_seller" ON public.orders
  FOR INSERT WITH CHECK (auth.uid() = seller_id);
CREATE POLICY "orders_seller_update_own" ON public.orders
  FOR UPDATE USING (auth.uid() = seller_id) WITH CHECK (auth.uid() = seller_id);

-- Grants: pre-chain, Supabase's defaults gave anon and authenticated ALL.
GRANT ALL ON public.orders TO anon, authenticated;

-- =============================================================================
-- 5. Drop every chain-added table, children before parents (no CASCADE:
--    an unexpected dependent must abort, not vanish silently).
-- =============================================================================
DROP TRIGGER profiles_ensure_trust ON public.profiles;   -- 00007, on a kept table

DROP TABLE public.order_items;             -- 00007
DROP TABLE public.waitlist_entries;        -- 00006 (repointed by 00007)
DROP TABLE public.reports;                 -- 00006 (repointed by 00007)
DROP TABLE public.video_products;          -- 00007
DROP TABLE public.video_stats;             -- 00009
DROP TABLE public.viewer_video_reactions;  -- 00008
DROP TABLE public.category_rate_medians;   -- 00013
DROP TABLE public.feed_slices;             -- 00008
DROP TABLE public.feed_events;             -- 00008 (partitions + owned sequence fall with it)
DROP TABLE public.feed_event_dedupe;       -- 00008
DROP TABLE public.viewer_profiles;         -- 00008
DROP TABLE public.viewer_blocks;           -- 00008
DROP TABLE public.viewer_video_counters;   -- 00008
DROP TABLE public.viewer_identities;       -- 00008
DROP TABLE public.follows;                 -- 00008
DROP TABLE public.products;                -- 00007
DROP TABLE public.shipping_profiles;       -- 00007
DROP TABLE public.videos;                  -- 00007
DROP TABLE public.categories;              -- 00007
DROP TABLE public.seller_trust;            -- 00007
DROP TABLE public.discount_codes;          -- 00006
DROP TABLE public.feed_weights;            -- 00009 (00014's row goes with it)
DROP TABLE public.rollup_state;            -- 00009

-- =============================================================================
-- 6. Drop every chain-added function (tables and triggers that used them are
--    gone), then the chain's enum types.
-- =============================================================================
DROP FUNCTION public.seller_charges_enabled(uuid);                       -- 00006
DROP FUNCTION public.sync_product_stock_status();                        -- 00007
DROP FUNCTION public.normalize_video_hashtags();                        -- 00007
DROP FUNCTION public.guard_video_status();                               -- 00007
DROP FUNCTION public.guard_video_product_count();                        -- 00007
DROP FUNCTION public.ensure_seller_trust();                              -- 00007
DROP FUNCTION public.decrement_product_inventory(uuid, smallint);        -- 00007/00010
DROP FUNCTION public.create_feed_events_partition(date);                 -- 00008
DROP FUNCTION public.ensure_feed_events_partitions(int);                 -- 00008
DROP FUNCTION public.drop_old_feed_events_partitions(int);               -- 00008
DROP FUNCTION public.sweep_feed_event_dedupe(int);                       -- 00008
DROP FUNCTION public.ingest_feed_events(uuid, uuid, public.feed_surface, jsonb); -- 00008
DROP FUNCTION public.feed_event_dedupe_key(uuid, uuid, public.feed_event_type,
                                           uuid, uuid, text, int, bigint); -- 00008
DROP FUNCTION public.feed_event_cap_class(public.feed_event_type);       -- 00008
DROP FUNCTION public.rollup_video_stats();                               -- 00009
DROP FUNCTION public.refresh_category_counts();                          -- 00009/00010
DROP FUNCTION public.clamp_loop_count(integer);                          -- 00010
DROP FUNCTION public.apply_video_reactions(uuid, uuid, boolean, boolean);-- 00010
DROP FUNCTION public.stale_video_stat_ids(interval);                     -- 00010
DROP FUNCTION public.claim_anon_identity(uuid, uuid);                    -- 00010
DROP FUNCTION public.refresh_category_rate_medians(integer, integer);    -- 00013
DROP FUNCTION public.search_feed_videos(text, text, text, integer, uuid[]); -- 00015
-- link_anon_identity (00008) needs nothing: 00011 already dropped it, and it
-- never existed pre-chain.

DROP TYPE public.feed_event_type;   -- 00008
DROP TYPE public.video_status;      -- 00007
DROP TYPE public.product_status;    -- 00007
DROP TYPE public.trust_tier;        -- 00007
DROP TYPE public.candidate_lane;    -- 00007 (+00010's 'chrono' value)
DROP TYPE public.feed_surface;      -- 00007

-- =============================================================================
-- 7. Restore 00001's BOOLEAN decrement_inventory verbatim (00006 replaced it
--    with the INTEGER version, 00007 dropped that). Recreated under the
--    restored default privileges, so its ACL matches the original's.
-- =============================================================================
CREATE FUNCTION decrement_inventory(drop_id_param UUID)
RETURNS BOOLEAN AS $$
DECLARE
  v_current_inventory INTEGER;
BEGIN
  -- Get current inventory with row lock
  SELECT inventory INTO v_current_inventory
  FROM public.drops
  WHERE id = drop_id_param
  FOR UPDATE;

  -- Check if inventory is available
  IF v_current_inventory <= 0 THEN
    RETURN FALSE;
  END IF;

  -- Decrement inventory
  UPDATE public.drops
  SET inventory = inventory - 1, updated_at = NOW()
  WHERE id = drop_id_param;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- 8. profiles back to the pre-chain state.
-- =============================================================================
-- The three constraints 00006 added.
ALTER TABLE public.profiles
  DROP CONSTRAINT profiles_handle_format,
  DROP CONSTRAINT profiles_handle_not_reserved,
  DROP CONSTRAINT profiles_display_name_len;

-- 00006 replaced production's wide-open policy with an anon-scoped one under
-- the repo name. Restore production's REAL policy name and shape
-- (pg_policies dump 2026-08-19: profiles_public_read, SELECT, {public},
-- USING true).
DROP POLICY "profiles_public_read_handle" ON public.profiles;
CREATE POLICY "profiles_public_read" ON public.profiles
  FOR SELECT USING (true);

-- Undo 00006's column-level grants, then restore the Supabase-default
-- table-level ALL. (REVOKE of a table privilege does not touch column
-- privileges, so they must be revoked explicitly.)
REVOKE ALL (id, handle, display_name, avatar_url) ON public.profiles
  FROM anon, authenticated;
GRANT ALL ON public.profiles TO anon, authenticated;

-- =============================================================================
-- 9. seller_payments: restore the three production self-access policies the
--    amended 00006 drops (pg_policies dump 2026-08-19). The table, its
--    unique constraint, index, trigger, RLS and revoked browser grants are
--    all unchanged by the chain (00006 section 0/6b re-stated the existing
--    state), so nothing else to do here.
-- =============================================================================
CREATE POLICY "seller_payments_self_read" ON public.seller_payments
  FOR SELECT USING (auth.uid() = seller_id);
CREATE POLICY "seller_payments_self_update" ON public.seller_payments
  FOR UPDATE USING (auth.uid() = seller_id);
CREATE POLICY "seller_payments_self_insert" ON public.seller_payments
  FOR INSERT WITH CHECK (auth.uid() = seller_id);

-- =============================================================================
-- 10. Sequence grants: 00008 revoked anon/authenticated from ALL sequences,
--     which caught processed_events' identity sequence. Restore the
--     Supabase-default ALL (the only sequences left are pre-chain ones).
-- =============================================================================
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;

COMMIT;
