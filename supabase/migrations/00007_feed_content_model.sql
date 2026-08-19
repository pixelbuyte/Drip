-- Real enums, not TEXT+CHECK, for anything feed_events will reference:
-- an enum is 4 bytes where 'watch_progress' is 15. On the one table that
-- will hold billions of rows that difference is storage and rollup I/O.
CREATE TYPE public.video_status   AS ENUM ('processing', 'live', 'paused', 'removed');
CREATE TYPE public.product_status AS ENUM ('active', 'out_of_stock', 'archived');
CREATE TYPE public.trust_tier     AS ENUM ('new', 'building', 'trusted', 'elite');
CREATE TYPE public.candidate_lane AS ENUM ('affinity', 'trending', 'fresh', 'social', 'random');
CREATE TYPE public.feed_surface   AS ENUM (
  'for_you', 'following', 'category', 'seller_profile', 'search', 'shared_link'
);

CREATE TABLE public.categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{2,40}$'),
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  sort_order  smallint NOT NULL DEFAULT 100,
  is_active   boolean NOT NULL DEFAULT true,
  -- maintained by the rollup job; drives spec 2.8's thin-supply 1.2x
  -- freshness multiplier (categories with < 50 live videos).
  live_video_count integer NOT NULL DEFAULT 0 CHECK (live_video_count >= 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_categories_active ON public.categories (sort_order)
  WHERE is_active;

INSERT INTO public.categories (slug, name, sort_order) VALUES
  ('apparel',              'Apparel',                10),
  ('footwear',             'Footwear',               20),
  ('jewelry-accessories',  'Jewelry & Accessories',  30),
  ('beauty',               'Beauty',                 40),
  ('home-decor',           'Home & Decor',           50),
  ('vintage-thrift',       'Vintage & Thrift',       60),
  ('collectibles',         'Collectibles',           70),
  ('handmade-craft',       'Handmade & Craft',       80),
  ('tech-gadgets',         'Tech & Gadgets',         90),
  ('pet',                  'Pet',                   100),
  ('fitness',              'Fitness',               110),
  ('other',                'Other',                 120);

CREATE TABLE public.shipping_profiles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id   uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  weight_oz   numeric(10,2) NOT NULL CHECK (weight_oz BETWEEN 0.1 AND 1120),
  length_in   numeric(6,2)  NOT NULL CHECK (length_in BETWEEN 0.1 AND 108),
  width_in    numeric(6,2)  NOT NULL CHECK (width_in  BETWEEN 0.1 AND 108),
  height_in   numeric(6,2)  NOT NULL CHECK (height_in BETWEEN 0.1 AND 108),
  handling_days smallint NOT NULL DEFAULT 2 CHECK (handling_days BETWEEN 0 AND 14),
  is_default  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, seller_id)              -- target for the composite FK from products
);

CREATE INDEX idx_shipping_profiles_seller ON public.shipping_profiles (seller_id);
CREATE UNIQUE INDEX idx_shipping_profiles_one_default
  ON public.shipping_profiles (seller_id) WHERE is_default;

CREATE TRIGGER shipping_profiles_updated_at BEFORE UPDATE ON public.shipping_profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.products (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id               uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  slug                    text NOT NULL CHECK (slug ~ '^[a-z0-9-]{1,80}$'),
  title                   text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
  description             text CHECK (char_length(description) <= 2000),
  price_cents             integer NOT NULL CHECK (price_cents BETWEEN 100 AND 99999900),
  compare_at_price_cents  integer CHECK (compare_at_price_cents BETWEEN 100 AND 99999900),
  inventory_count         integer NOT NULL DEFAULT 0 CHECK (inventory_count >= 0),
  low_stock_threshold     smallint NOT NULL DEFAULT 5 CHECK (low_stock_threshold BETWEEN 0 AND 1000),
  -- [{id, name, options, price_delta_cents, inventory_count, sku}]
  variants                jsonb,
  images                  text[] NOT NULL DEFAULT '{}',
  shipping_profile_id     uuid,
  category_id             uuid REFERENCES public.categories(id) ON DELETE SET NULL,
  status                  public.product_status NOT NULL DEFAULT 'active',
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  UNIQUE (seller_id, slug),
  UNIQUE (id, seller_id),             -- target for the composite FK from video_products

  -- A seller must not be able to attach another seller's shipping profile:
  -- the label would be bought against the wrong from-address.
  CONSTRAINT products_shipping_profile_same_seller
    FOREIGN KEY (shipping_profile_id, seller_id)
    REFERENCES public.shipping_profiles (id, seller_id) ON DELETE SET NULL,

  CONSTRAINT products_compare_at_is_higher
    CHECK (compare_at_price_cents IS NULL OR compare_at_price_cents > price_cents),
  CONSTRAINT products_variants_shape
    CHECK (variants IS NULL
           OR (jsonb_typeof(variants) = 'array' AND jsonb_array_length(variants) <= 40)),
  CONSTRAINT products_images_bounded
    CHECK (array_length(images, 1) IS NULL OR array_length(images, 1) <= 8)
);

CREATE INDEX idx_products_seller_status ON public.products (seller_id, status);
CREATE INDEX idx_products_sellable
  ON public.products (category_id, price_cents)
  WHERE status = 'active' AND inventory_count > 0;
CREATE INDEX idx_products_price ON public.products (price_cents)
  WHERE status = 'active' AND inventory_count > 0;

CREATE TRIGGER products_updated_at BEFORE UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE FUNCTION public.sync_product_stock_status() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'archived' THEN
    NEW.status := CASE WHEN NEW.inventory_count > 0 THEN 'active'::public.product_status
                       ELSE 'out_of_stock'::public.product_status END;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.sync_product_stock_status() SET search_path = public, pg_temp;

CREATE TRIGGER products_sync_stock_status
  BEFORE INSERT OR UPDATE OF inventory_count, status ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.sync_product_stock_status();

CREATE TABLE public.videos (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id         uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  category_id       uuid REFERENCES public.categories(id) ON DELETE SET NULL,

  mux_upload_id     text,
  mux_asset_id      text UNIQUE,
  mux_playback_id   text UNIQUE,
  duration_seconds  numeric(7,3) CHECK (duration_seconds > 0 AND duration_seconds <= 600),
  aspect_ratio      text CHECK (aspect_ratio ~ '^\d{1,3}:\d{1,3}$'),
  thumbnail_url     text,
  preview_gif_url   text,

  caption           text CHECK (char_length(caption) <= 500),
  hashtags          text[] NOT NULL DEFAULT '{}',

  status            public.video_status NOT NULL DEFAULT 'processing',
  removed_reason    text CHECK (char_length(removed_reason) <= 200),

  published_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  UNIQUE (id, seller_id),             -- target for the composite FK from video_products

  CONSTRAINT videos_hashtags_bounded
    CHECK (array_length(hashtags, 1) IS NULL OR array_length(hashtags, 1) <= 10),
  CONSTRAINT videos_live_has_playback
    CHECK (status <> 'live' OR (mux_playback_id IS NOT NULL AND published_at IS NOT NULL))
);

-- Spec 1: (status, published_at desc), (seller_id, status), GIN on hashtags.
-- Written as partial indexes where the predicate is always 'live' at query
-- time, which is every candidate-generation query in 2.2.
CREATE INDEX idx_videos_live_published
  ON public.videos (published_at DESC) WHERE status = 'live';
CREATE INDEX idx_videos_status_published
  ON public.videos (status, published_at DESC);
CREATE INDEX idx_videos_seller_status
  ON public.videos (seller_id, status);
CREATE INDEX idx_videos_category_live
  ON public.videos (category_id, published_at DESC) WHERE status = 'live';
CREATE INDEX idx_videos_hashtags_gin
  ON public.videos USING GIN (hashtags);
-- the fresh/exploration lane (2.2): published in the last 48h
CREATE INDEX idx_videos_fresh
  ON public.videos (published_at DESC) WHERE status = 'live';
CREATE INDEX idx_videos_mux_upload ON public.videos (mux_upload_id)
  WHERE mux_upload_id IS NOT NULL;

CREATE TRIGGER videos_updated_at BEFORE UPDATE ON public.videos
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE FUNCTION public.normalize_video_hashtags() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.hashtags IS NULL THEN NEW.hashtags := '{}'; RETURN NEW; END IF;
  SELECT COALESCE(array_agg(DISTINCT tag ORDER BY tag), '{}')
    INTO NEW.hashtags
  FROM (
    SELECT left(lower(regexp_replace(t, '[^a-zA-Z0-9_]', '', 'g')), 30) AS tag
    FROM unnest(NEW.hashtags) AS t
  ) s
  WHERE tag <> '';
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.normalize_video_hashtags() SET search_path = public, pg_temp;

CREATE TRIGGER videos_normalize_hashtags
  BEFORE INSERT OR UPDATE OF hashtags ON public.videos
  FOR EACH ROW EXECUTE FUNCTION public.normalize_video_hashtags();

CREATE FUNCTION public.guard_video_status() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user IN ('postgres', 'service_role', 'supabase_admin') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.status := 'processing';
    NEW.published_at := NULL;
    NEW.removed_reason := NULL;
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status IN ('live', 'paused') AND NEW.status IN ('live', 'paused')) THEN
    RAISE EXCEPTION 'Only Drip can move a video out of "%" (attempted "%")',
      OLD.status, NEW.status;
  END IF;

  -- published_at is the freshness clock (2.3) and the 48h exploration window
  -- (2.8). A seller who could rewrite it could farm the fresh lane forever.
  NEW.published_at   := OLD.published_at;
  NEW.removed_reason := OLD.removed_reason;
  NEW.mux_asset_id   := OLD.mux_asset_id;
  NEW.mux_playback_id := OLD.mux_playback_id;
  NEW.duration_seconds := OLD.duration_seconds;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.guard_video_status() SET search_path = public, pg_temp;

CREATE TRIGGER videos_guard_status
  BEFORE INSERT OR UPDATE ON public.videos
  FOR EACH ROW EXECUTE FUNCTION public.guard_video_status();

CREATE TABLE public.video_products (
  video_id          uuid NOT NULL,
  product_id        uuid NOT NULL,
  seller_id         uuid NOT NULL,
  position          smallint NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 4),
  pinned_at_second  numeric(7,3) CHECK (pinned_at_second >= 0),
  created_at        timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (video_id, product_id),

  -- Both legs resolve through seller_id, so a row can only exist when the
  -- video and the product belong to the same seller. No trigger required.
  FOREIGN KEY (video_id,   seller_id) REFERENCES public.videos   (id, seller_id) ON DELETE CASCADE,
  FOREIGN KEY (product_id, seller_id) REFERENCES public.products (id, seller_id) ON DELETE CASCADE
);

CREATE INDEX idx_video_products_product ON public.video_products (product_id);
CREATE UNIQUE INDEX idx_video_products_position
  ON public.video_products (video_id, position);

-- Spec: "a video can sell 1-5 products".
CREATE FUNCTION public.guard_video_product_count() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.video_products WHERE video_id = NEW.video_id;
  IF n > 5 THEN
    RAISE EXCEPTION 'A video can sell at most 5 products (video %)', NEW.video_id;
  END IF;
  RETURN NULL;
END;
$$;
ALTER FUNCTION public.guard_video_product_count() SET search_path = public, pg_temp;

CREATE CONSTRAINT TRIGGER video_products_max_five
  AFTER INSERT OR UPDATE ON public.video_products
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.guard_video_product_count();

CREATE TABLE public.seller_trust (
  seller_id           uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  fulfillment_score   numeric(4,3) NOT NULL DEFAULT 0.700 CHECK (fulfillment_score BETWEEN 0 AND 1),
  avg_ship_time_hours numeric(8,2),
  dispute_rate        numeric(5,4) NOT NULL DEFAULT 0 CHECK (dispute_rate BETWEEN 0 AND 1),
  refund_rate         numeric(5,4) NOT NULL DEFAULT 0 CHECK (refund_rate  BETWEEN 0 AND 1),
  cancel_rate         numeric(5,4) NOT NULL DEFAULT 0 CHECK (cancel_rate  BETWEEN 0 AND 1),
  response_time_hours numeric(8,2),
  total_orders        integer NOT NULL DEFAULT 0 CHECK (total_orders >= 0),
  rating_avg          numeric(3,2) CHECK (rating_avg BETWEEN 1 AND 5),
  rating_count        integer NOT NULL DEFAULT 0 CHECK (rating_count >= 0),
  strikes             smallint NOT NULL DEFAULT 0 CHECK (strikes >= 0),
  trust_tier          public.trust_tier NOT NULL DEFAULT 'new',
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- 2.3's trust_signal reads this per candidate; keep the tier scan cheap.
CREATE INDEX idx_seller_trust_tier ON public.seller_trust (trust_tier);

-- Every seller gets a trust row at signup so the scorer never has to
-- COALESCE a missing join into a made-up default.
CREATE FUNCTION public.ensure_seller_trust() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.seller_trust (seller_id) VALUES (NEW.id)
  ON CONFLICT (seller_id) DO NOTHING;
  RETURN NULL;
END;
$$;
ALTER FUNCTION public.ensure_seller_trust() SET search_path = public, pg_temp;

CREATE TRIGGER profiles_ensure_trust AFTER INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.ensure_seller_trust();

INSERT INTO public.seller_trust (seller_id) SELECT id FROM public.profiles
  ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Backfill. Against production this touches zero rows (nothing was ever
-- applied and the project is paused). It exists so a developer who ran
-- 00001-00006 locally does not lose their fixtures.
-- ---------------------------------------------------------------------------

-- A drop is a video with exactly one product. Reuse the drop's uuid as the
-- video's so any hardcoded local link still resolves.
INSERT INTO public.videos
  (id, seller_id, mux_upload_id, mux_asset_id, mux_playback_id,
   caption, status, published_at, created_at, updated_at)
SELECT d.id, d.seller_id, d.mux_upload_id, NULL, d.mux_playback_id,
       d.description,
       CASE d.status WHEN 'active'   THEN 'live'::public.video_status
                     WHEN 'archived' THEN 'paused'::public.video_status
                     WHEN 'rejected' THEN 'removed'::public.video_status
                     ELSE 'processing'::public.video_status END,
       CASE WHEN d.status = 'active' THEN d.created_at END,
       d.created_at, d.updated_at
FROM public.drops d;

-- The drop's shipping metadata becomes a per-drop shipping profile.
INSERT INTO public.shipping_profiles
  (id, seller_id, name, weight_oz, length_in, width_in, height_in)
SELECT d.id, d.seller_id, left(d.title, 40),
       COALESCE(d.weight_oz, 8.0),
       COALESCE((d.dimensions->>'length_in')::numeric, 9.0),
       COALESCE((d.dimensions->>'width_in')::numeric, 6.0),
       COALESCE((d.dimensions->>'height_in')::numeric, 2.0)
FROM public.drops d;

INSERT INTO public.products
  (id, seller_id, slug, title, description, price_cents, inventory_count,
   variants, shipping_profile_id, status, created_at, updated_at)
SELECT d.id, d.seller_id, d.slug, d.title, d.description, d.price_cents,
       d.inventory, d.variants, d.id,
       CASE WHEN d.status = 'archived' THEN 'archived'::public.product_status
            WHEN d.inventory > 0       THEN 'active'::public.product_status
            ELSE 'out_of_stock'::public.product_status END,
       d.created_at, d.updated_at
FROM public.drops d;

INSERT INTO public.video_products (video_id, product_id, seller_id, position)
SELECT d.id, d.id, d.seller_id, 0 FROM public.drops d;

-- video_products_max_five is a DEFERRABLE INITIALLY DEFERRED constraint
-- trigger, so the insert above leaves an after-trigger event queued until
-- COMMIT, and Postgres refuses ALTER TABLE on a table that has pending trigger
-- events. Without this the ENABLE ROW LEVEL SECURITY below dies with
--     cannot ALTER TABLE "video_products" because it has pending trigger events
-- and both `supabase db push` and apply_migration run a migration inside one
-- transaction, so that is the production path, not a local artifact. Firing the
-- deferred check here does not weaken it -- the same count runs, just earlier.
-- Only reachable when the backfill actually inserted a row, which is why an
-- empty drops table never surfaced it. Applied statement-at-a-time instead
-- (psql without --single-transaction) this warns "SET CONSTRAINTS can only be
-- used in transaction blocks" and is a harmless no-op, because autocommit
-- leaves nothing pending. Do not delete it to silence that warning.
SET CONSTRAINTS public.video_products_max_five IMMEDIATE;

-- ---------------------------------------------------------------------------
-- orders. Buyers still have no accounts; every write is still service-role.
-- These columns are the minimum needed to delete drops. The checkout agent
-- owns anything beyond them.
-- ---------------------------------------------------------------------------
ALTER TABLE public.orders
  ADD COLUMN video_id         uuid REFERENCES public.videos(id) ON DELETE SET NULL,
  ADD COLUMN buyer_anon_id    uuid,
  ADD COLUMN buyer_viewer_id  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN session_id       uuid,
  ADD COLUMN surface          public.feed_surface,
  ADD COLUMN idempotency_key  text,
  ADD COLUMN stripe_payment_intent_id text,
  ADD COLUMN subtotal_cents   integer NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0),
  ADD COLUMN tax_cents        integer NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  ADD COLUMN total_cents      integer NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  ADD COLUMN platform_fee_cents integer NOT NULL DEFAULT 0 CHECK (platform_fee_cents >= 0),
  ADD COLUMN refunded_at      timestamptz,
  ADD COLUMN disputed_at      timestamptz;

UPDATE public.orders SET video_id = drop_id,
                         subtotal_cents = amount_cents,
                         total_cents = amount_cents + shipping_cents;

-- 2.9 needs a status vocabulary that can express "retroactively subtract this
-- order's commerce contribution".
ALTER TABLE public.orders DROP CONSTRAINT orders_status_check;
ALTER TABLE public.orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('pending','paid','label_created','shipped','delivered',
                    'canceled','refunded','disputed'));

CREATE UNIQUE INDEX idx_orders_idempotency_key
  ON public.orders (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX idx_orders_payment_intent
  ON public.orders (stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;
-- the rollup's commerce source (see 3.3): "orders for this video, by window"
CREATE INDEX idx_orders_video_created ON public.orders (video_id, created_at DESC)
  WHERE video_id IS NOT NULL;
CREATE INDEX idx_orders_updated_at ON public.orders (updated_at DESC);
CREATE INDEX idx_orders_buyer_anon ON public.orders (buyer_anon_id, created_at DESC)
  WHERE buyer_anon_id IS NOT NULL;

-- Spec 3.5: a same-seller cart can hold more than one product, which
-- orders.product_id could never represent. Snapshot title and price so a
-- later product edit cannot rewrite a completed order or a refund amount.
CREATE TABLE public.order_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  product_id        uuid REFERENCES public.products(id) ON DELETE SET NULL,
  seller_id         uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  video_id          uuid REFERENCES public.videos(id) ON DELETE SET NULL,
  variant_id        text CHECK (char_length(variant_id) <= 64),
  title_snapshot    text NOT NULL,
  variant_snapshot  text,
  unit_price_cents  integer NOT NULL CHECK (unit_price_cents >= 0),
  quantity          smallint NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 20),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_order_items_order  ON public.order_items (order_id);
CREATE INDEX idx_order_items_seller ON public.order_items (seller_id, created_at DESC);

INSERT INTO public.order_items
  (order_id, product_id, seller_id, video_id, title_snapshot, unit_price_cents, quantity)
SELECT o.id, o.drop_id, o.seller_id, o.drop_id, COALESCE(p.title, 'Item'),
       o.amount_cents, 1
FROM public.orders o LEFT JOIN public.products p ON p.id = o.drop_id;

-- ---------------------------------------------------------------------------
-- Repoint the remaining drops references, then delete the table.
-- ---------------------------------------------------------------------------
ALTER TABLE public.waitlist_entries
  ADD COLUMN product_id uuid REFERENCES public.products(id) ON DELETE CASCADE;
UPDATE public.waitlist_entries SET product_id = drop_id;
ALTER TABLE public.waitlist_entries
  ALTER COLUMN product_id SET NOT NULL,
  DROP COLUMN drop_id;
CREATE INDEX idx_waitlist_product ON public.waitlist_entries (product_id);
ALTER TABLE public.waitlist_entries
  ADD CONSTRAINT waitlist_entries_product_email_key UNIQUE (product_id, email);

ALTER TABLE public.reports
  ADD COLUMN video_id   uuid REFERENCES public.videos(id) ON DELETE CASCADE,
  ADD COLUMN product_id uuid REFERENCES public.products(id) ON DELETE SET NULL,
  ADD COLUMN reporter_anon_id uuid;
UPDATE public.reports SET video_id = drop_id, product_id = drop_id;
ALTER TABLE public.reports ALTER COLUMN video_id SET NOT NULL, DROP COLUMN drop_id;
CREATE INDEX idx_reports_video ON public.reports (video_id);

ALTER TABLE public.orders DROP COLUMN drop_id;

DROP FUNCTION IF EXISTS public.decrement_inventory(uuid);
DROP TRIGGER IF EXISTS drops_guard_status ON public.drops;
DROP FUNCTION IF EXISTS public.guard_drop_status();
DROP TABLE public.drops;

-- Replacement, same shape and same posture as 00004/00006: a single
-- conditional UPDATE, SECURITY INVOKER, service_role only.
CREATE FUNCTION public.decrement_product_inventory(
  p_product_id uuid, p_quantity smallint DEFAULT 1
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_new integer;
BEGIN
  UPDATE public.products
     SET inventory_count = inventory_count - p_quantity, updated_at = now()
   WHERE id = p_product_id AND inventory_count >= p_quantity
  RETURNING inventory_count INTO v_new;
  RETURN v_new;   -- NULL means insufficient stock
END;
$$;
ALTER FUNCTION public.decrement_product_inventory(uuid, smallint)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.decrement_product_inventory(uuid, smallint)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.decrement_product_inventory(uuid, smallint)
  TO service_role;

ALTER TABLE public.categories        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shipping_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.videos            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_products    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seller_trust      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items       ENABLE ROW LEVEL SECURITY;

-- categories -----------------------------------------------------------------
CREATE POLICY categories_public_read ON public.categories
  FOR SELECT TO anon, authenticated USING (is_active);
REVOKE ALL ON public.categories FROM anon, authenticated;
GRANT SELECT (id, slug, name, sort_order) ON public.categories TO anon, authenticated;
-- live_video_count is a supply-side metric; publishing it tells a gamer
-- exactly which category still carries 2.8's 1.2x thin-supply multiplier.

-- shipping_profiles ----------------------------------------------------------
-- Contains no buyer data but reveals a seller's operating detail. Sellers only.
CREATE POLICY shipping_profiles_owner_all ON public.shipping_profiles
  FOR ALL TO authenticated
  USING (auth.uid() = seller_id) WITH CHECK (auth.uid() = seller_id);
REVOKE ALL ON public.shipping_profiles FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.shipping_profiles TO authenticated;
GRANT UPDATE (name, weight_oz, length_in, width_in, height_in, handling_days, is_default)
  ON public.shipping_profiles TO authenticated;

-- products -------------------------------------------------------------------
-- Intent is unchanged: a product is publicly readable only when its seller can
-- actually take money. Only the location of that fact changed. charges_enabled
-- is no longer a column on profiles -- the out-of-band split_seller_pii
-- migration moved stripe_account_id, charges_enabled and from_address onto
-- public.seller_payments, because profiles carries profiles_public_read_handle
-- (USING (true)) and RLS filters rows, not columns: a payout destination and
-- the seller's physical home address must never sit in a table that every
-- anonymous storefront request already reads. That split is the design we keep.
--
-- Read the flag through public.seller_charges_enabled(uuid) (00012 section 5)
-- rather than querying seller_payments inline here. A policy expression is
-- evaluated with the QUERYING role's privileges, and seller_payments is
-- REVOKE ALL from anon, so an inline EXISTS over it would create fine at
-- migration time and then fail on the first anonymous page load with
--     ERROR:  permission denied for table seller_payments
-- The helper is SECURITY DEFINER; it discloses one boolean about a seller_id
-- the caller already holds, and no PII column is reachable through it.
CREATE POLICY products_public_read_sellable ON public.products
  FOR SELECT TO anon USING (
    status <> 'archived'
    AND public.seller_charges_enabled(products.seller_id)
  );
CREATE POLICY products_owner_all ON public.products
  FOR ALL TO authenticated
  USING (auth.uid() = seller_id) WITH CHECK (auth.uid() = seller_id);

REVOKE ALL ON public.products FROM anon;
GRANT SELECT (id, seller_id, slug, title, description, price_cents,
              compare_at_price_cents, inventory_count, low_stock_threshold,
              variants, images, category_id, status)
  ON public.products TO anon;
-- shipping_profile_id withheld: it is a join handle into a seller-private table.

REVOKE ALL ON public.products FROM authenticated;
GRANT SELECT, INSERT, DELETE ON public.products TO authenticated;
GRANT UPDATE (slug, title, description, price_cents, compare_at_price_cents,
              inventory_count, low_stock_threshold, variants, images,
              shipping_profile_id, category_id, status)
  ON public.products TO authenticated;
-- seller_id is not updatable: a seller must not be able to reassign a product
-- to another account and inherit its stats or its stock.

-- videos ---------------------------------------------------------------------
CREATE POLICY videos_public_read_live ON public.videos
  FOR SELECT TO anon USING (status = 'live');
CREATE POLICY videos_owner_all ON public.videos
  FOR ALL TO authenticated
  USING (auth.uid() = seller_id) WITH CHECK (auth.uid() = seller_id);

REVOKE ALL ON public.videos FROM anon;
GRANT SELECT (id, seller_id, category_id, mux_playback_id, duration_seconds,
              aspect_ratio, thumbnail_url, preview_gif_url, caption, hashtags,
              status, published_at)
  ON public.videos TO anon;
-- mux_asset_id and mux_upload_id are internal Mux handles; removed_reason is
-- moderation detail. None reach a browser.

REVOKE ALL ON public.videos FROM authenticated;
GRANT SELECT, INSERT, DELETE ON public.videos TO authenticated;
GRANT UPDATE (category_id, caption, hashtags, thumbnail_url, status)
  ON public.videos TO authenticated;
-- Everything else about a video is attested by Mux (service role) and pinned
-- by guard_video_status besides.

-- video_products -------------------------------------------------------------
CREATE POLICY video_products_public_read ON public.video_products
  FOR SELECT TO anon USING (
    EXISTS (SELECT 1 FROM public.videos v
             WHERE v.id = video_products.video_id AND v.status = 'live')
  );
CREATE POLICY video_products_owner_all ON public.video_products
  FOR ALL TO authenticated
  USING (auth.uid() = seller_id) WITH CHECK (auth.uid() = seller_id);
REVOKE ALL ON public.video_products FROM anon;
GRANT SELECT (video_id, product_id, position, pinned_at_second)
  ON public.video_products TO anon;
REVOKE ALL ON public.video_products FROM authenticated;
GRANT SELECT, INSERT, DELETE ON public.video_products TO authenticated;
GRANT UPDATE (position, pinned_at_second) ON public.video_products TO authenticated;

-- seller_trust ---------------------------------------------------------------
-- The product sheet's seller card (3.3) needs rating, ship time, order count.
-- dispute_rate / refund_rate / cancel_rate / strikes are never granted to any
-- browser role: a seller who can read their own strike count can calibrate
-- exactly how much abuse clears the threshold. Same reasoning 00006 used to
-- hide reports from sellers. The seller dashboard renders a curated summary
-- through a server route.
CREATE POLICY seller_trust_public_read ON public.seller_trust
  FOR SELECT TO anon, authenticated USING (true);
REVOKE ALL ON public.seller_trust FROM anon, authenticated;
GRANT SELECT (seller_id, avg_ship_time_hours, total_orders, rating_avg,
              rating_count, trust_tier)
  ON public.seller_trust TO anon, authenticated;

-- order_items ----------------------------------------------------------------
CREATE POLICY order_items_seller_read_own ON public.order_items
  FOR SELECT TO authenticated USING (auth.uid() = seller_id);
REVOKE ALL ON public.order_items FROM anon, authenticated;
GRANT SELECT ON public.order_items TO authenticated;
-- No INSERT/UPDATE for any browser role, for the reason 00006 gave when it
-- removed orders_insert_for_seller: a fabricated order row buys a real USPS
-- label on the platform's EasyPost account.