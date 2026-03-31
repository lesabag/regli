-- Payout requests table
CREATE TABLE IF NOT EXISTS public.payout_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  walker_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'paid', 'rejected')),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX idx_payout_requests_walker_id ON public.payout_requests(walker_id);
CREATE INDEX idx_payout_requests_status ON public.payout_requests(status);
CREATE INDEX idx_payout_requests_created_at ON public.payout_requests(created_at DESC);

ALTER TABLE public.payout_requests ENABLE ROW LEVEL SECURITY;

-- Walker can read own payout requests
CREATE POLICY "payout_requests_walker_select" ON public.payout_requests
  FOR SELECT USING (walker_id = auth.uid());

-- Walker can insert own payout requests
CREATE POLICY "payout_requests_walker_insert" ON public.payout_requests
  FOR INSERT WITH CHECK (walker_id = auth.uid());

-- Admin can read all payout requests
CREATE POLICY "payout_requests_admin_select" ON public.payout_requests
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- Admin can update all payout requests
CREATE POLICY "payout_requests_admin_update" ON public.payout_requests
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

GRANT SELECT, INSERT ON public.payout_requests TO authenticated;
GRANT UPDATE ON public.payout_requests TO authenticated;
GRANT SELECT ON public.payout_requests TO anon;
