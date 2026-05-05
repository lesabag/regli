ALTER TABLE public.wallet_transactions
  ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'ils';

CREATE OR REPLACE FUNCTION public.credit_walker_wallet(
  p_walker_id UUID,
  p_job_id UUID,
  p_amount NUMERIC(10,2),
  p_currency TEXT DEFAULT 'ils',
  p_description TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_count INTEGER;
  v_currency TEXT;
BEGIN
  v_currency := lower(trim(coalesce(p_currency, 'ils')));

  IF v_currency !~ '^[a-z]{3}$' THEN
    v_currency := 'ils';
  END IF;

  INSERT INTO public.wallet_transactions (walker_id, job_id, type, status, amount, currency, description)
  VALUES (p_walker_id, p_job_id, 'credit', 'available', p_amount, v_currency, p_description)
  ON CONFLICT (walker_id, job_id, type) DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;

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

GRANT EXECUTE ON FUNCTION public.credit_walker_wallet(UUID, UUID, NUMERIC, TEXT, TEXT) TO service_role;
