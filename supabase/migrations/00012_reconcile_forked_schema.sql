-- =============================================================================
-- 00012_reconcile_forked_schema.sql
--
-- WHY THIS FILE EXISTS
-- --------------------
-- In June 2026 this repo's migration chain and the live Supabase project
-- (tkppdmrkvyjixaiocwmd) forked. They have described two different schemas
-- ever since. This migration is the join point that makes them one again.
--
-- What production actually ran:
--     20260612224627  initial_schema                <- repo 00001
--     20260612224637  webhook_events                <- repo 00002
--     20260613050858  mvp_storefront_and_security   <- no repo counterpart
--     20260613051035  checkout_drop_info_fn         <- no repo counterpart
--     20260613051159  public_profiles_view          <- no repo counterpart
--     20260613133236  split_seller_pii              <- no repo counterpart
--     20260613133520  drop_checkout_drop_info_fn    <- no repo counterpart
--
-- What the repo has but production never applied:
--     00003_drops_video_variants_discounts
--     00004_orders_waitlist
--     00005_reports
--     00006_lock_down_rls
--
-- The divergence was discovered when 00007_feed_content_model could not be
-- applied: it reads drops.mux_upload_id and drops.variants, alters
-- waitlist_entries and reports, and filters on profiles.charges_enabled --
-- none of which exist in production. Every one of those is a name-resolution
-- failure at parse time, so an empty table does not save you; the statement
-- fails before it touches a row.
--
-- This migration replays 00003, 00004 and 00005 as-written, and replays 00006
-- ADAPTED to production's schema, so that 00007 onward can apply unchanged.
-- It preserves the live data (1 profile, 1 drop, 1 seller_payments row); the
-- alternative -- resetting the database -- was considered and rejected.
--
--
-- THE LOAD-BEARING DESIGN DECISION: SELLER PII STAYS OFF `profiles`
-- -----------------------------------------------------------------
-- READ THIS BEFORE "FIXING" ANYTHING BELOW.
--
-- profiles.stripe_account_id, profiles.charges_enabled and
-- profiles.from_address DO NOT EXIST any more. The out-of-band
-- `split_seller_pii` migration moved them to public.seller_payments, and
-- that is the design we are keeping. It is not an accident to be undone.
--
-- The reason: public.profiles carries `profiles_public_read_handle`, a SELECT
-- policy with USING (true). RLS filters ROWS, not COLUMNS -- a public read
-- policy publishes every column of every row it admits. stripe_account_id is
-- a payout destination and from_address is the seller's physical home
-- address. Neither may live in a publicly readable table.
--
-- Repo 00006 tried to solve this with column-level GRANTs on profiles.
-- That works, but it is one `GRANT SELECT ON profiles TO anon` away from a
-- full PII disclosure, and it leaves the secrets sitting in the table that
-- every anonymous storefront request already reads. split_seller_pii solved
-- the same problem strictly better, by moving the columns out of reach
-- entirely. Production already runs that better design, with real data in it.
--
-- So the reconciliation adapts the REPO to production's split, never the
-- reverse. Concretely, versus repo 00006:
--   * the column GRANTs on profiles.stripe_account_id / from_address are
--     GONE, because the columns are gone. The equivalent protection is
--     applied to seller_payments instead (section 6b).
--   * the UNIQUE constraint 00006 put on profiles.stripe_account_id goes on
--     seller_payments.stripe_account_id instead (section 6b).
--   * 00006's GRANT UPDATE (from_address) to `authenticated` has no
--     successor: nothing on seller_payments is browser-writable at all. The
--     app already matches this -- src/app/api/settings/address/route.ts
--     writes from_address with the service role.
-- Anything in this codebase that reads charges_enabled / stripe_account_id /
-- from_address off `profiles` is a BUG to fix, not a contract to satisfy.
--
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- --------------------------------------------
--   * It does not move seller PII back onto profiles. See above.
--   * It does not drop, truncate or delete from profiles, drops,
--     seller_payments or orders. The live rows survive.
--   * It does not touch public_profiles_view (20260613051159). Its real
--     definition was never captured, and nothing in this repo references it.
--     If it was created WITH (security_invoker = true), the profiles REVOKEs
--     in section 6a will change what anon can read THROUGH it -- confirm the
--     view's definition against production before applying.
--   * It does not enumerate the RLS work that `mvp_storefront_and_security`
--     may have done. That migration's name implies policy/grant changes that
--     are not reconstructible from a column list. Policies are OR'd, so an
--     unknown leftover policy WIDENS access past what section 6 intends.
--     Enumerate pg_policies on production and reconcile by hand before
--     trusting the lockdown below to be complete.
--
-- Written to be re-runnable: this migration reconciles a divergence, which is
-- exactly the kind that gets interrupted half-way and re-applied.
-- =============================================================================


-- =============================================================================
-- SECTION 1 -- replay of 00003: video upload lifecycle, variants, discounts
-- =============================================================================

-- 00007:322 reads d.mux_upload_id and 00007:346 reads d.variants. Both are
-- plain 00003 columns that production never got.
ALTER TABLE public.drops ADD COLUMN IF NOT EXISTS mux_upload_id TEXT;
ALTER TABLE public.drops ADD COLUMN IF NOT EXISTS variants JSONB;

-- Widen the drop lifecycle:  processing -> active (video ready)
--                                       -> rejected (errored / over 60s)
-- Production is still on 00001's two-value vocabulary ('active','archived').
ALTER TABLE public.drops DROP CONSTRAINT IF EXISTS drops_status_check;
ALTER TABLE public.drops ADD CONSTRAINT drops_status_check
  CHECK (status IN ('processing', 'active', 'rejected', 'archived'));
ALTER TABLE public.drops ALTER COLUMN status SET DEFAULT 'processing';

-- Seller discount codes. Backed by a Stripe coupon on the platform account;
-- applied per-seller at checkout (never via allow_promotion_codes, which
-- would let any platform code work on any seller's checkout).
CREATE TABLE IF NOT EXISTS public.discount_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  percent_off INTEGER NOT NULL CHECK (percent_off BETWEEN 1 AND 100),
  stripe_coupon_id TEXT,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE (seller_id, code)
);

CREATE INDEX IF NOT EXISTS idx_discount_codes_seller_id
  ON public.discount_codes(seller_id);

ALTER TABLE public.discount_codes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "discount_codes_seller_all" ON public.discount_codes;
CREATE POLICY "discount_codes_seller_all" ON public.discount_codes
  FOR ALL USING (auth.uid() = seller_id) WITH CHECK (auth.uid() = seller_id);


-- =============================================================================
-- SECTION 2 -- replay of 00004: atomic decrement, refunds, waitlist
-- =============================================================================

-- Production still has 00001's decrement_inventory, which returns BOOLEAN and
-- does SELECT ... FOR UPDATE then UPDATE. 00004 replaced it with a single
-- conditional UPDATE returning the new count. Safe under READ COMMITTED: the
-- WHERE clause re-evaluates after any concurrent writer commits, so two
-- checkouts racing for the last unit can never both succeed.
-- The return type changes, so this is a DROP + CREATE, not a REPLACE.
DROP FUNCTION IF EXISTS public.decrement_inventory(UUID);
CREATE FUNCTION public.decrement_inventory(drop_id_param UUID)
RETURNS INTEGER AS $$
DECLARE
  v_new_inventory INTEGER;
BEGIN
  UPDATE public.drops
  SET inventory = inventory - 1, updated_at = NOW()
  WHERE id = drop_id_param AND inventory >= 1
  RETURNING inventory INTO v_new_inventory;

  RETURN v_new_inventory; -- NULL means sold out
END;
$$ LANGUAGE plpgsql;

-- If two sessions complete concurrently for the last unit, the loser is
-- auto-refunded and recorded for audit. 00007 widens this vocabulary further;
-- it does so with DROP CONSTRAINT + ADD CONSTRAINT, so it needs the
-- constraint to exist under this exact name.
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE public.orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('paid', 'label_created', 'shipped', 'delivered', 'refunded'));

-- Sold-out waitlist. 00007:426-434 repoints this table's drop_id at
-- products.id, so the table has to be here first.
CREATE TABLE IF NOT EXISTS public.waitlist_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  drop_id UUID NOT NULL REFERENCES public.drops(id) ON DELETE CASCADE,
  seller_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  name TEXT,
  notified_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE (drop_id, email)
);

CREATE INDEX IF NOT EXISTS idx_waitlist_drop_id
  ON public.waitlist_entries(drop_id);
CREATE INDEX IF NOT EXISTS idx_waitlist_seller_id
  ON public.waitlist_entries(seller_id);

ALTER TABLE public.waitlist_entries ENABLE ROW LEVEL SECURITY;

-- Sellers can read their own waitlist; inserts go through the API
-- (service role) so buyers never need accounts.
DROP POLICY IF EXISTS "waitlist_seller_read" ON public.waitlist_entries;
CREATE POLICY "waitlist_seller_read" ON public.waitlist_entries
  FOR SELECT USING (auth.uid() = seller_id);


-- =============================================================================
-- SECTION 3 -- replay of 00005: moderation reports
-- =============================================================================

-- 00007:436-442 repoints this table at videos/products, so it has to exist.
CREATE TABLE IF NOT EXISTS public.reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  drop_id UUID NOT NULL REFERENCES public.drops(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('prohibited_item', 'copyright', 'scam', 'other')),
  details TEXT,
  reporter_email TEXT,
  resolved_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reports_drop_id ON public.reports(drop_id);

-- Service role only: reporters are anonymous, sellers must not see reports.
-- RLS on with zero policies is the deny-all that enforces it.
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;


-- =============================================================================
-- SECTION 4 -- data reconciliation: video-less drops are not 'active'
-- =============================================================================
--
-- Production's one drop is status='active' with mux_playback_id IS NULL: the
-- out-of-band storefront migration added drops.image_url and allowed an
-- image-only listing, which 00001's lifecycle had no way to express and
-- 00003's ('processing' -> 'active' when the video is ready) forbids.
--
-- This is not cosmetic. 00007:319-330 backfills public.videos with
--     CASE d.status WHEN 'active' THEN 'live' ... END
-- and videos carries
--     CONSTRAINT videos_live_has_playback
--       CHECK (status <> 'live' OR (mux_playback_id IS NOT NULL
--                                   AND published_at IS NOT NULL))
-- so an 'active' drop with no playback id fails that CHECK on the way in:
--     new row for relation "videos" violates check constraint
--     "videos_live_has_playback"
-- An empty drops table hides this; production's single row does not.
--
-- The reconciliation cannot invent a Mux playback id, so it corrects the
-- status instead. 'processing' is the honest value -- the listing has no
-- video yet -- and it routes the row through 00007's ELSE branch to
-- video_status 'processing' with a NULL published_at, which the CHECK allows.
--
-- Consequence, stated plainly: this row stops matching
-- drops_public_read_active, so the demo storefront page goes blank for
-- anonymous visitors. It would have gone blank at 00007 regardless -- the
-- feed model only publishes videos, and this listing has none.
--
-- Run before the guard trigger in section 6d exists. It would be bypassed
-- anyway (migrations run as `postgres`), but not depending on that is free.
UPDATE public.drops
   SET status = 'processing'
 WHERE status = 'active'
   AND mux_playback_id IS NULL;


-- =============================================================================
-- SECTION 5 -- charges_enabled, readable from profiles WITHOUT storing it there
-- =============================================================================
--
-- 00007:499-504 creates:
--
--     CREATE POLICY products_public_read_sellable ON public.products
--       FOR SELECT TO anon USING (
--         status <> 'archived'
--         AND EXISTS (SELECT 1 FROM public.profiles pr
--                      WHERE pr.id = products.seller_id AND pr.charges_enabled)
--       );
--
-- `pr.charges_enabled` cannot resolve: split_seller_pii moved that column to
-- seller_payments. Adding the column back to profiles is NOT the fix -- see
-- the design decision at the top of this file.
--
-- The fix is this function, which 00007 now calls as
--     public.seller_charges_enabled(products.seller_id)
-- in place of the profiles subquery. THIS IS A CONTRACT: 00007's
-- products_public_read_sellable policy depends on this function existing,
-- with this name and signature. Postgres records that dependency, so the
-- function cannot be dropped while the policy stands -- but do not rename it.
--
-- SECURITY DEFINER is load-bearing, not laziness. seller_payments is
-- REVOKE ALL from anon and authenticated (section 6b), and an RLS policy
-- expression is evaluated with the *querying* role's privileges. A policy
-- that reads seller_payments inline therefore does NOT fail at migration
-- time -- it fails later, on the first anonymous page load:
--
--     ERROR:  permission denied for table seller_payments
--
-- which is the worst failure mode available: it passes migration CI green and
-- takes the storefront down in production. Routing through a definer function
-- is the only formulation that works for anon. It discloses one boolean about
-- a seller_id the caller already holds; no PII column is reachable through it.
--
-- Rejected alternative, recorded so nobody re-derives it: PostgreSQL treats
-- `pr.charges_enabled` and `charges_enabled(pr)` as equivalent, so defining
-- charges_enabled(public.profiles) makes 00007's ORIGINAL profiles subquery
-- parse and return the right answer with no edit to 00007 at all. It works,
-- but it compiles to a WHOLE-ROW read (`charges_enabled(pr.*)`), and Postgres
-- checks whole-row reads with pg_attribute_aclcheck_all -- the querying role
-- must hold SELECT on EVERY column of profiles. That forces the anon grant in
-- section 6a wide open and re-breaks on every future column. Calling the
-- helper by seller_id needs no privilege on profiles at all.

CREATE OR REPLACE FUNCTION public.seller_charges_enabled(p_seller_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT COALESCE(
    (SELECT sp.charges_enabled
       FROM public.seller_payments sp
      WHERE sp.seller_id = p_seller_id),
    false)
$$;
ALTER FUNCTION public.seller_charges_enabled(uuid) SET search_path = public, pg_temp;

-- Policy evaluation happens as the querying role, so anon needs EXECUTE.
-- Granted explicitly rather than relying on Supabase's default privileges.
REVOKE EXECUTE ON FUNCTION public.seller_charges_enabled(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seller_charges_enabled(uuid)
  TO anon, authenticated, service_role;


-- =============================================================================
-- SECTION 6 -- replay of 00006, adapted to the PII split
-- =============================================================================
-- Two facts drive every statement below, unchanged from 00006:
--   1. RLS filters ROWS. It has no column dimension, so a "public read" policy
--      publishes every column of every row it admits.
--   2. Supabase grants ALL on public tables to anon and authenticated by
--      default, so column privileges are the only thing that can narrow a
--      SELECT * or an UPDATE of a column the app never meant to expose.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 6a. profiles
--
-- 00006's block for this table was mostly about stripe_account_id and
-- from_address. Those columns are gone, so what survives here is the narrowing
-- of the public read, and the shape/format constraints on handle.
-- -----------------------------------------------------------------------------

-- Scoping the public policy TO anon also stops one signed-in seller reading
-- every other seller's row: authenticated now only matches profiles_self_read.
DROP POLICY IF EXISTS "profiles_public_read_handle" ON public.profiles;
CREATE POLICY "profiles_public_read_handle" ON public.profiles
  FOR SELECT TO anon USING (true);

-- The public drop page and thanks page need exactly these four columns.
-- Enumerated rather than a table-level GRANT so this stays a decision: a new
-- column on profiles is not auto-published to the internet. If a new column
-- is sensitive it belongs on seller_payments, not in this list.
--
-- This four-column grant is only safe because NOTHING reads profiles with a
-- whole-row reference. Postgres checks a whole-row read (`pr.*`) with
-- pg_attribute_aclcheck_all, which demands SELECT on EVERY column of the
-- table, and a column grant can never satisfy it -- anon would get
--     ERROR:  permission denied for table profiles
-- at query time, not migration time. That is precisely why section 5's helper
-- takes a seller_id instead of a profiles row. Keep it that way.
REVOKE ALL ON public.profiles FROM anon;
GRANT SELECT (id, handle, display_name, avatar_url) ON public.profiles TO anon;

-- Sellers edit their storefront identity. 00006 also granted
-- UPDATE (from_address) here; that column now lives on seller_payments, which
-- no browser role may write at all -- the ship-from address is changed through
-- a service-role server route instead. See section 6b.
REVOKE ALL ON public.profiles FROM authenticated;
GRANT SELECT ON public.profiles TO authenticated;   -- own row only, via RLS
GRANT INSERT (id, handle, display_name, avatar_url) ON public.profiles TO authenticated;
GRANT UPDATE (display_name, avatar_url) ON public.profiles TO authenticated;

-- handle becomes a public URL segment (/@handle/slug) and was written straight
-- from the browser. Mirror the client-side zod rules in the database.
-- NOTE: these validate the existing live row. The one production profile is
-- handle='demo', display_name='Demo Threads', which satisfies all three.
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_handle_format;
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_handle_not_reserved;
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_display_name_len;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_handle_format
    CHECK (handle ~ '^[a-z0-9_]{3,30}$'),
  ADD CONSTRAINT profiles_handle_not_reserved
    CHECK (handle NOT IN ('api', 'auth', 'dashboard', 'onboarding', 'legal',
                          'admin', 'drip', 'support', 'settings', 'static')),
  ADD CONSTRAINT profiles_display_name_len
    CHECK (char_length(display_name) BETWEEN 1 AND 50);

-- -----------------------------------------------------------------------------
-- 6b. seller_payments -- where 00006's profiles-PII protections actually land
--
-- This table did not exist when 00006 was written. It is the successor to
-- 00006's column GRANTs on profiles.stripe_account_id / from_address, and the
-- protection is strictly stronger than what 00006 could achieve: instead of
-- withholding two columns of a publicly readable table, no browser role holds
-- any privilege on this table at all, and RLS is on with no policy granting
-- one. Every read and write goes through the service role.
--
-- Re-asserted rather than assumed: split_seller_pii is believed to have done
-- this already, but it is not in the repo and re-stating it is free.
-- -----------------------------------------------------------------------------
ALTER TABLE public.seller_payments ENABLE ROW LEVEL SECURITY;

-- Payout destination and a physical home address. No browser role, ever.
REVOKE ALL ON public.seller_payments FROM anon, authenticated;

-- 00006 put this UNIQUE on profiles.stripe_account_id. The column moved, so
-- the constraint moves with it. account.updated resolves the seller by
-- equality on this column, and a duplicate would make that lookup ambiguous.
-- Guarded because split_seller_pii may already have created it, as either a
-- constraint or a bare unique index.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_attribute a ON a.attrelid = c.oid
                         AND a.attnum = ANY (i.indkey)
     WHERE c.relname = 'seller_payments'
       AND c.relnamespace = 'public'::regnamespace
       AND i.indisunique
       AND i.indnatts = 1
       AND a.attname = 'stripe_account_id'
  ) THEN
    ALTER TABLE public.seller_payments
      ADD CONSTRAINT seller_payments_stripe_account_id_key
      UNIQUE (stripe_account_id);
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- 6c. orders
-- Buyers have no accounts: every order write is a service-role write from a
-- signature-verified webhook. Seller INSERT/UPDATE was pure attack surface --
-- a fabricated 'paid' row makes /api/orders/[id]/retry-label buy a real USPS
-- label on the platform's EasyPost account, and pollutes revenue reporting.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "orders_insert_for_seller" ON public.orders;
DROP POLICY IF EXISTS "orders_seller_update_own" ON public.orders;

REVOKE ALL ON public.orders FROM anon, authenticated;
GRANT SELECT ON public.orders TO authenticated;  -- own rows via orders_seller_read_own

-- The EasyPost webhook resolves an order by tracking_code with .single();
-- a collision would silently drop a shipped/delivered transition.
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_tracking_code
  ON public.orders (tracking_code) WHERE tracking_code IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 6d. drops
-- -----------------------------------------------------------------------------

-- Same reasoning as profiles: scope the public policy to anon, then narrow the
-- columns. weight_oz, dimensions, mux_asset_id and mux_upload_id are internal.
DROP POLICY IF EXISTS "drops_public_read_active" ON public.drops;
CREATE POLICY "drops_public_read_active" ON public.drops
  FOR SELECT TO anon USING (status = 'active');

-- video_url and image_url are not in 00006's list because 00006 predates them:
-- they came from the out-of-band mvp_storefront_and_security migration. They
-- are public media URLs rendered on the storefront page -- the same class of
-- thing as mux_playback_id, which 00006 does publish -- so they are granted.
REVOKE ALL ON public.drops FROM anon;
GRANT SELECT (id, seller_id, title, slug, description, price_cents, inventory,
              variants, mux_playback_id, status, video_url, image_url)
  ON public.drops TO anon;

-- video_url / image_url are deliberately absent from the UPDATE list: like
-- mux_playback_id they are written by the upload pipeline (service role),
-- not typed in by the seller.
REVOKE ALL ON public.drops FROM authenticated;
GRANT SELECT, INSERT, DELETE ON public.drops TO authenticated;
GRANT UPDATE (title, description, price_cents, inventory, weight_oz,
              dimensions, variants, mux_upload_id, status) ON public.drops TO authenticated;

-- status is the moderation gate: Mux decides processing -> active | rejected.
-- A seller may only archive/unarchive, and may only create in 'processing', so
-- a rejected (prohibited, errored, or over-60s) video can never be published
-- by writing the table directly through PostgREST.
-- (CREATE OR REPLACE, and the trigger re-created, so this file re-runs.
-- search_path is pinned, which 00006 omitted and every function in 00007 does.)
CREATE OR REPLACE FUNCTION public.guard_drop_status() RETURNS TRIGGER AS $$
BEGIN
  IF current_user IN ('postgres', 'service_role', 'supabase_admin') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.status := 'processing';
  ELSIF NEW.status IS DISTINCT FROM OLD.status
        AND NOT (OLD.status IN ('active', 'archived')
                 AND NEW.status IN ('active', 'archived')) THEN
    RAISE EXCEPTION 'Only Drip can move a drop out of "%" (attempted "%")',
      OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
ALTER FUNCTION public.guard_drop_status() SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS drops_guard_status ON public.drops;
CREATE TRIGGER drops_guard_status
  BEFORE INSERT OR UPDATE ON public.drops
  FOR EACH ROW EXECUTE FUNCTION public.guard_drop_status();

-- -----------------------------------------------------------------------------
-- 6e. decrement_inventory
-- Only the Stripe webhook (service role) may spend stock. Deliberately left
-- SECURITY INVOKER: DEFINER would run as the table owner and bypass RLS on
-- drops, turning this into a cross-tenant inventory-destruction primitive.
-- Section 2 re-created this function, so it carries default privileges again
-- and these REVOKEs are doing real work.
-- -----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.decrement_inventory(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.decrement_inventory(UUID) TO service_role;
ALTER FUNCTION public.decrement_inventory(UUID) SET search_path = public, pg_temp;
