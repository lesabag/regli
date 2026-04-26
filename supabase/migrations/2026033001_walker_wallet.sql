-- Persistent wallet system for walkers
-- Two tables: walker_wallets (summary) + wallet_transactions (ledger)
-- Deduplication: UNIQUE(walker_id, job_id, type) prevents double-crediting

-- ─── walker_wallets ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.walker_wallets (
  walker_id UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  available_balance NUMERIC(10,2) NOT NULL DEFAULT 0,
  pending_balance NUMERIC(10,2) NOT NULL DEFAULT 0,
  total_earned NUMERIC(10,2) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.walker_wallets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "wallet_select_own" ON public.walker_wallets;
CREATE POLICY wallet_select_own ON public.walker_wallets
  FOR SELECT USING (walker_id = auth.uid());

DROP POLICY IF EXISTS "wallet_select_admin" ON public.walker_wallets;
CREATE POLICY wallet_select_admin ON public.walker_wallets
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- ─── wallet_transactions ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.wallet_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  walker_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  job_id UUID REFERENCES public.walk_requests(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('credit', 'debit', 'payout')),
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('pending', 'available', 'paid', 'reversed')),
  amount NUMERIC(10,2) NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (walker_id, job_id, type)
);

CREATE INDEX IF NOT EXISTS idx_wallet_tx_walker ON public.wallet_transactions (walker_id);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_job ON public.wallet_transactions (job_id);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_created ON public.wallet_transactions (created_at DESC);

ALTER TABLE public.wallet_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "wallet_tx_select_own" ON public.wallet_transactions;
CREATE POLICY wallet_tx_select_own ON public.wallet_transactions
  FOR SELECT USING (walker_id = auth.uid());

DROP POLICY IF EXISTS "wallet_tx_select_admin" ON public.wallet_transactions;
CREATE POLICY wallet_tx_select_admin ON public.wallet_transactions
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- ─── credit_walker_wallet function ───────────────────────────
-- Called from edge functions after successful payment capture.
-- Idempotent: if transaction already exists for this job, does nothing.
-- Returns true if credit was applied, false if already existed.
-- Uses INSERT...ON CONFLICT DO NOTHING + row count check (no nested BEGIN/EXCEPTION).

CREATE OR REPLACE FUNCTION public.credit_walker_wallet(
  p_walker_id UUID,
  p_job_id UUID,
  p_amount NUMERIC(10,2),
  p_description TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_count INTEGER;
BEGIN
  -- Try to insert the transaction; ON CONFLICT DO NOTHING avoids duplicate error
  INSERT INTO public.wallet_transactions (walker_id, job_id, type, status, amount, description)
  VALUES (p_walker_id, p_job_id, 'credit', 'available', p_amount, p_description)
  ON CONFLICT (walker_id, job_id, type) DO NOTHING;

  -- Check if the insert actually happened
  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- Only update wallet summary if we actually inserted a new transaction
  IF v_count > 0 THEN
    INSERT INTO public.walker_wallets (walker_id, available_balance, pending_balance, total_earned, updated_at)
    VALUES (p_walker_id, p_amount, 0, p_amount, now())
    ON CONFLICT (walker_id) DO UPDATE SET
      available_balance = walker_wallets.available_balance + p_amount,
      total_earned = walker_wallets.total_earned + p_amount,
      updated_at = now();
    RETURN true;
  END IF;

  RETURN false;
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.credit_walker_wallet TO service_role;

-- ─── Backfill existing completed+paid jobs ───────────────────

INSERT INTO public.walker_wallets (walker_id, available_balance, pending_balance, total_earned, updated_at)
SELECT
  walker_id,
  COALESCE(SUM(walker_earnings), 0),
  0,
  COALESCE(SUM(walker_earnings), 0),
  now()
FROM public.walk_requests
WHERE status = 'completed'
  AND payment_status = 'paid'
  AND walker_id IS NOT NULL
  AND walker_earnings IS NOT NULL
  AND walker_earnings > 0
GROUP BY walker_id
ON CONFLICT (walker_id) DO UPDATE SET
  available_balance = EXCLUDED.available_balance,
  total_earned = EXCLUDED.total_earned,
  updated_at = now();

INSERT INTO public.wallet_transactions (walker_id, job_id, type, status, amount, description)
SELECT
  walker_id,
  id,
  'credit',
  'available',
  walker_earnings,
  'Backfill: completed walk'
FROM public.walk_requests
WHERE status = 'completed'
  AND payment_status = 'paid'
  AND walker_id IS NOT NULL
  AND walker_earnings IS NOT NULL
  AND walker_earnings > 0
ON CONFLICT (walker_id, job_id, type) DO NOTHING;
