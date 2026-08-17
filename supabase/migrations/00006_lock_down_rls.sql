-- Step 9: close the privilege gaps in 00001-00005.
--
-- Two facts drive every statement below:
--   1. RLS filters ROWS. It has no column dimension, so a "public read" policy
--      publishes every column of every row it admits.
--   2. Supabase grants ALL on public tables to anon and authenticated by
--      default, so column privileges are the only thing that can narrow a
--      SELECT * or an UPDATE of a column the app never meant to expose.

-- ---------------------------------------------------------------------------
-- profiles
-- from_address is the seller's physical ship-from address (a home, for these
-- sellers) and stripe_account_id is their payout destination. Neither may
-- leave the server, and neither may be written by the seller.
-- ---------------------------------------------------------------------------

-- Scoping the public policy TO anon also stops one signed-in seller reading
-- every other seller's row: authenticated now only matches profiles_self_read.
DROP POLICY "profiles_public_read_handle" ON public.profiles;
CREATE POLICY "profiles_public_read_handle" ON public.profiles
  FOR SELECT TO anon USING (true);

-- The public drop page and thanks page need exactly these four columns.
REVOKE ALL ON public.profiles FROM anon;
GRANT SELECT (id, handle, display_name, avatar_url) ON public.profiles TO anon;

-- Sellers edit their storefront identity and ship-from address. They may NOT
-- write stripe_account_id or charges_enabled: those are attested by Stripe and
-- written only by the service role (onboarding routes + account.updated).
-- Without this a seller sets charges_enabled = true to skip KYC, or points
-- stripe_account_id at someone else's connected account to divert payouts.
REVOKE ALL ON public.profiles FROM authenticated;
GRANT SELECT ON public.profiles TO authenticated;   -- own row only, via RLS
GRANT INSERT (id, handle, display_name, avatar_url) ON public.profiles TO authenticated;
GRANT UPDATE (display_name, avatar_url, from_address) ON public.profiles TO authenticated;

-- account.updated resolves the seller by equality on this column.
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_stripe_account_id_key UNIQUE (stripe_account_id);

-- handle becomes a public URL segment (/@handle/slug) and was written straight
-- from the browser. Mirror the client-side zod rules in the database.
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_handle_format
    CHECK (handle ~ '^[a-z0-9_]{3,30}$'),
  ADD CONSTRAINT profiles_handle_not_reserved
    CHECK (handle NOT IN ('api', 'auth', 'dashboard', 'onboarding', 'legal',
                          'admin', 'drip', 'support', 'settings', 'static')),
  ADD CONSTRAINT profiles_display_name_len
    CHECK (char_length(display_name) BETWEEN 1 AND 50);

-- ---------------------------------------------------------------------------
-- orders
-- Buyers have no accounts: every order write is a service-role write from a
-- signature-verified webhook. Seller INSERT/UPDATE was pure attack surface —
-- a fabricated 'paid' row makes /api/orders/[id]/retry-label buy a real USPS
-- label on the platform's EasyPost account, and pollutes revenue reporting.
-- ---------------------------------------------------------------------------
DROP POLICY "orders_insert_for_seller" ON public.orders;
DROP POLICY "orders_seller_update_own" ON public.orders;

REVOKE ALL ON public.orders FROM anon, authenticated;
GRANT SELECT ON public.orders TO authenticated;  -- own rows via orders_seller_read_own

-- The EasyPost webhook resolves an order by tracking_code with .single();
-- a collision would silently drop a shipped/delivered transition.
CREATE UNIQUE INDEX idx_orders_tracking_code
  ON public.orders (tracking_code) WHERE tracking_code IS NOT NULL;

-- ---------------------------------------------------------------------------
-- drops
-- ---------------------------------------------------------------------------

-- Same reasoning as profiles: scope the public policy to anon, then narrow the
-- columns. weight_oz, dimensions, mux_asset_id and mux_upload_id are internal.
DROP POLICY "drops_public_read_active" ON public.drops;
CREATE POLICY "drops_public_read_active" ON public.drops
  FOR SELECT TO anon USING (status = 'active');

REVOKE ALL ON public.drops FROM anon;
GRANT SELECT (id, seller_id, title, slug, description, price_cents, inventory,
              variants, mux_playback_id, status) ON public.drops TO anon;

REVOKE ALL ON public.drops FROM authenticated;
GRANT SELECT, INSERT, DELETE ON public.drops TO authenticated;
GRANT UPDATE (title, description, price_cents, inventory, weight_oz,
              dimensions, variants, mux_upload_id, status) ON public.drops TO authenticated;

-- status is the moderation gate: Mux decides processing -> active | rejected.
-- A seller may only archive/unarchive, and may only create in 'processing', so
-- a rejected (prohibited, errored, or over-60s) video can never be published
-- by writing the table directly through PostgREST.
CREATE FUNCTION public.guard_drop_status() RETURNS TRIGGER AS $$
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

CREATE TRIGGER drops_guard_status
  BEFORE INSERT OR UPDATE ON public.drops
  FOR EACH ROW EXECUTE FUNCTION public.guard_drop_status();

-- ---------------------------------------------------------------------------
-- decrement_inventory
-- Only the Stripe webhook (service role) may spend stock. Deliberately left
-- SECURITY INVOKER: DEFINER would run as the table owner and bypass RLS on
-- drops, turning this into a cross-tenant inventory-destruction primitive.
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.decrement_inventory(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.decrement_inventory(UUID) TO service_role;
ALTER FUNCTION public.decrement_inventory(UUID) SET search_path = public, pg_temp;
