-- Step 5: atomic inventory decrement (conditional UPDATE), waitlist,
-- and a refunded status for the concurrent-oversell edge case.

-- Single conditional UPDATE is safe under READ COMMITTED: the WHERE clause
-- re-evaluates after any concurrent writer commits, so two checkouts racing
-- for the last unit can never both succeed. Returns the new inventory,
-- or NULL when already sold out.
DROP FUNCTION IF EXISTS decrement_inventory(UUID);
CREATE FUNCTION decrement_inventory(drop_id_param UUID)
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
-- auto-refunded and recorded for audit.
ALTER TABLE public.orders DROP CONSTRAINT orders_status_check;
ALTER TABLE public.orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('paid', 'label_created', 'shipped', 'delivered', 'refunded'));

-- Sold-out waitlist: lead capture for the seller + back-in-stock emails (Step 6).
CREATE TABLE public.waitlist_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  drop_id UUID NOT NULL REFERENCES public.drops(id) ON DELETE CASCADE,
  seller_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  name TEXT,
  notified_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE (drop_id, email)
);

CREATE INDEX idx_waitlist_drop_id ON public.waitlist_entries(drop_id);
CREATE INDEX idx_waitlist_seller_id ON public.waitlist_entries(seller_id);

ALTER TABLE public.waitlist_entries ENABLE ROW LEVEL SECURITY;

-- Sellers can read their own waitlist; inserts go through the API
-- (service role) so buyers never need accounts.
CREATE POLICY "waitlist_seller_read" ON public.waitlist_entries
  FOR SELECT USING (auth.uid() = seller_id);
