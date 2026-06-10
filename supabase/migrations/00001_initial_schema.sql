-- Profiles table for sellers
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE,
  handle TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  stripe_account_id TEXT,
  charges_enabled BOOLEAN DEFAULT FALSE,
  from_address JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Drops table (product listings)
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
  UNIQUE(seller_id, slug)
);

-- Orders table
CREATE TABLE public.orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  drop_id UUID NOT NULL REFERENCES public.drops(id) ON DELETE CASCADE,
  seller_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  stripe_session_id TEXT UNIQUE NOT NULL,
  buyer_email TEXT NOT NULL,
  buyer_name TEXT NOT NULL,
  shipping_address JSONB,
  amount_cents INTEGER NOT NULL,
  shipping_cents INTEGER NOT NULL,
  status TEXT DEFAULT 'paid' CHECK (status IN ('paid', 'label_created', 'shipped', 'delivered')),
  easypost_shipment_id TEXT,
  tracking_code TEXT,
  label_url TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes
CREATE INDEX idx_drops_seller_id ON public.drops(seller_id);
CREATE INDEX idx_drops_slug ON public.drops(slug);
CREATE INDEX idx_orders_drop_id ON public.orders(drop_id);
CREATE INDEX idx_orders_seller_id ON public.orders(seller_id);
CREATE INDEX idx_orders_status ON public.orders(status);
CREATE INDEX idx_orders_stripe_session_id ON public.orders(stripe_session_id);

-- Enable RLS
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.drops ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

-- RLS Policies for profiles
CREATE POLICY "profiles_self_read" ON public.profiles
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "profiles_self_update" ON public.profiles
  FOR UPDATE USING (auth.uid() = id);

CREATE POLICY "profiles_insert" ON public.profiles
  FOR INSERT WITH CHECK (auth.uid() = id);

CREATE POLICY "profiles_public_read_handle" ON public.profiles
  FOR SELECT USING (true);

-- RLS Policies for drops
CREATE POLICY "drops_seller_read_write_own" ON public.drops
  FOR ALL USING (auth.uid() = seller_id) WITH CHECK (auth.uid() = seller_id);

CREATE POLICY "drops_public_read_active" ON public.drops
  FOR SELECT USING (status = 'active');

-- RLS Policies for orders
CREATE POLICY "orders_seller_read_own" ON public.orders
  FOR SELECT USING (auth.uid() = seller_id);

CREATE POLICY "orders_insert_for_seller" ON public.orders
  FOR INSERT WITH CHECK (auth.uid() = seller_id);

CREATE POLICY "orders_seller_update_own" ON public.orders
  FOR UPDATE USING (auth.uid() = seller_id) WITH CHECK (auth.uid() = seller_id);

-- Function to atomically decrement inventory
CREATE OR REPLACE FUNCTION decrement_inventory(drop_id_param UUID)
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

-- Update function for profiles and drops
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER drops_updated_at
  BEFORE UPDATE ON public.drops
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER orders_updated_at
  BEFORE UPDATE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
