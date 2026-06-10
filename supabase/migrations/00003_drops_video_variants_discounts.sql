-- Step 3: video upload lifecycle, variants, discount codes, from-address.

-- Track the Mux direct upload and widen the drop lifecycle:
--   processing -> active (video ready) | rejected (errored / over 60s)
ALTER TABLE public.drops ADD COLUMN mux_upload_id TEXT;
ALTER TABLE public.drops DROP CONSTRAINT drops_status_check;
ALTER TABLE public.drops ADD CONSTRAINT drops_status_check
  CHECK (status IN ('processing', 'active', 'rejected', 'archived'));
ALTER TABLE public.drops ALTER COLUMN status SET DEFAULT 'processing';

-- Variants: up to 2 dimensions (e.g. Size, Color), validated in the API.
-- Shape: [{"name": "Size", "options": ["S", "M", "L"]}]
-- All variant combinations inherit the base price for MVP.
ALTER TABLE public.drops ADD COLUMN variants JSONB;

-- Seller discount codes. Backed by a Stripe coupon on the platform account;
-- applied per-seller at checkout (never via allow_promotion_codes, which
-- would let any platform code work on any seller's checkout).
CREATE TABLE public.discount_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  percent_off INTEGER NOT NULL CHECK (percent_off BETWEEN 1 AND 100),
  stripe_coupon_id TEXT,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE (seller_id, code)
);

CREATE INDEX idx_discount_codes_seller_id ON public.discount_codes(seller_id);

ALTER TABLE public.discount_codes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "discount_codes_seller_all" ON public.discount_codes
  FOR ALL USING (auth.uid() = seller_id) WITH CHECK (auth.uid() = seller_id);
