-- Balance adjustments table for tracking refund debits and other financial adjustments
-- Used to maintain financial correctness when charges are refunded after walker has been paid

CREATE TABLE IF NOT EXISTS public.walker_balance_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  walker_id UUID NOT NULL REFERENCES public.profiles(id),
  job_id UUID REFERENCES public.walk_requests(id),
  type TEXT NOT NULL CHECK (type IN ('refund_debit', 'manual_credit', 'manual_debit', 'correction')),
  amount NUMERIC(10,2) NOT NULL, -- negative for debits, positive for credits
  description TEXT,
  created_by UUID REFERENCES public.profiles(id), -- admin who created manual adjustment
  created_at TIMESTAMPTZ DEFAULT now(),

  -- Prevent duplicate refund debits for same job
  CONSTRAINT unique_refund_per_job UNIQUE (job_id, type)
);

-- Index for walker balance queries
CREATE INDEX IF NOT EXISTS idx_balance_adj_walker ON public.walker_balance_adjustments(walker_id);
CREATE INDEX IF NOT EXISTS idx_balance_adj_job ON public.walker_balance_adjustments(job_id);

-- RLS
ALTER TABLE public.walker_balance_adjustments ENABLE ROW LEVEL SECURITY;

-- Walkers can read their own adjustments
CREATE POLICY "ba_walker_read" ON public.walker_balance_adjustments
  FOR SELECT USING (walker_id = auth.uid());

-- Admins can read all
CREATE POLICY "ba_admin_read" ON public.walker_balance_adjustments
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- Only service_role inserts (via edge functions / webhooks)
-- No INSERT/UPDATE/DELETE policies for authenticated — all writes go through service_role

GRANT SELECT ON public.walker_balance_adjustments TO authenticated;

-- Enable realtime for walker subscriptions
ALTER PUBLICATION supabase_realtime ADD TABLE public.walker_balance_adjustments;
