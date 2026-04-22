CREATE TABLE IF NOT EXISTS public.walker_tips (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  walk_request_id UUID NOT NULL REFERENCES public.walk_requests(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  walker_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL DEFAULT 'ILS',
  status TEXT NOT NULL DEFAULT 'pending_payment',
  stripe_payment_intent_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (walk_request_id, client_id)
);

CREATE INDEX IF NOT EXISTS idx_walker_tips_client_id
  ON public.walker_tips(client_id);

CREATE INDEX IF NOT EXISTS idx_walker_tips_walker_id
  ON public.walker_tips(walker_id);

CREATE INDEX IF NOT EXISTS idx_walker_tips_walk_request_id
  ON public.walker_tips(walk_request_id);

ALTER TABLE public.walker_tips ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "walker_tips_select_participants" ON public.walker_tips;
CREATE POLICY "walker_tips_select_participants"
  ON public.walker_tips
  FOR SELECT
  USING (client_id = auth.uid() OR walker_id = auth.uid());

DROP POLICY IF EXISTS "walker_tips_insert_own_completed_walks" ON public.walker_tips;
CREATE POLICY "walker_tips_insert_own_completed_walks"
  ON public.walker_tips
  FOR INSERT
  WITH CHECK (
    client_id = auth.uid()
    AND currency = 'ILS'
    AND status = 'pending_payment'
    AND EXISTS (
      SELECT 1
      FROM public.walk_requests wr
      WHERE wr.id = walk_request_id
        AND wr.client_id = auth.uid()
        AND wr.walker_id = walker_tips.walker_id
        AND wr.status = 'completed'
    )
  );

GRANT SELECT, INSERT ON public.walker_tips TO authenticated;
