-- Idempotent webhook processing: store processed event IDs from all providers.
-- UNIQUE constraint short-circuits duplicate deliveries (Stripe retries up to
-- 72h, delivers at-least-once and out-of-order).
CREATE TABLE public.processed_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('stripe', 'mux', 'easypost')),
  event_id TEXT NOT NULL,
  event_type TEXT,
  processed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE (provider, event_id)
);

-- Only the service role (webhook handlers) touches this table.
ALTER TABLE public.processed_events ENABLE ROW LEVEL SECURITY;
