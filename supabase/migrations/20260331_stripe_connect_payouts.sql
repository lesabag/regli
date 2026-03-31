-- ============================================================
-- Stripe Connect Payouts — walker_payouts + stripe_events
-- ============================================================

-- walker_payouts: tracks per-job transfers from platform to walker
CREATE TABLE IF NOT EXISTS public.walker_payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  walker_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  job_id UUID NOT NULL REFERENCES public.walk_requests(id) ON DELETE CASCADE,
  gross_amount NUMERIC(10,2) NOT NULL,
  platform_fee NUMERIC(10,2) NOT NULL,
  net_amount NUMERIC(10,2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'ils',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'transferred', 'paid_out', 'failed', 'reversed')),
  stripe_transfer_id TEXT,
  stripe_payout_id TEXT,
  stripe_balance_transaction_id TEXT,
  available_at TIMESTAMPTZ,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(job_id)  -- one transfer per job
);

CREATE INDEX idx_walker_payouts_walker_id ON public.walker_payouts(walker_id);
CREATE INDEX idx_walker_payouts_status ON public.walker_payouts(status);
CREATE INDEX idx_walker_payouts_stripe_transfer_id ON public.walker_payouts(stripe_transfer_id);

-- stripe_events: idempotent webhook event log
CREATE TABLE IF NOT EXISTS public.stripe_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  payload JSONB,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_stripe_events_type ON public.stripe_events(type);

-- RLS
ALTER TABLE public.walker_payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_events ENABLE ROW LEVEL SECURITY;

-- Walkers can read their own payouts
CREATE POLICY "walker_payouts_select_own" ON public.walker_payouts
  FOR SELECT USING (walker_id = auth.uid());

-- Admin (service_role) handles all inserts/updates via edge functions
-- No insert/update policies for authenticated — only service_role writes

-- stripe_events: no user access — only service_role writes/reads
-- (no policies = no authenticated access, which is correct)

-- Grants
GRANT SELECT ON public.walker_payouts TO authenticated;
GRANT SELECT ON public.stripe_events TO service_role;
GRANT INSERT, UPDATE ON public.walker_payouts TO service_role;
GRANT INSERT ON public.stripe_events TO service_role;

-- Add walker_payouts to realtime publication
ALTER PUBLICATION supabase_realtime ADD TABLE public.walker_payouts;

-- Add details_submitted field to profiles if missing
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'stripe_details_submitted'
  ) THEN
    ALTER TABLE public.profiles ADD COLUMN stripe_details_submitted BOOLEAN DEFAULT false;
  END IF;
END $$;
