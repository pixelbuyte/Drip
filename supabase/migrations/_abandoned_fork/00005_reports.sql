-- Step 8: content reports for the manual moderation queue.
-- Inserts come from the public report API (service role); review happens
-- in Supabase directly for MVP.
CREATE TABLE public.reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  drop_id UUID NOT NULL REFERENCES public.drops(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('prohibited_item', 'copyright', 'scam', 'other')),
  details TEXT,
  reporter_email TEXT,
  resolved_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_reports_drop_id ON public.reports(drop_id);

-- Service role only: reporters are anonymous, sellers must not see reports.
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;
