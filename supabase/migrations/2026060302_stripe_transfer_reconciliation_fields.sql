ALTER TABLE public.walker_payouts
  ADD COLUMN IF NOT EXISTS job_currency TEXT,
  ADD COLUMN IF NOT EXISTS provider_earnings_currency TEXT,
  ADD COLUMN IF NOT EXISTS payment_intent_currency TEXT,
  ADD COLUMN IF NOT EXISTS charge_currency TEXT,
  ADD COLUMN IF NOT EXISTS stripe_balance_transaction_currency TEXT,
  ADD COLUMN IF NOT EXISTS stripe_balance_transaction_amount BIGINT,
  ADD COLUMN IF NOT EXISTS stripe_transfer_currency TEXT,
  ADD COLUMN IF NOT EXISTS stripe_transfer_amount BIGINT,
  ADD COLUMN IF NOT EXISTS earnings_share_ratio NUMERIC(12,8);

UPDATE public.walker_payouts AS wp
SET
  stripe_transfer_currency = COALESCE(wp.stripe_transfer_currency, wp.currency),
  provider_earnings_currency = COALESCE(wp.provider_earnings_currency, wr.currency, wp.currency),
  job_currency = COALESCE(wp.job_currency, wr.currency, wp.provider_earnings_currency, wp.currency)
FROM public.walk_requests AS wr
WHERE wr.id = wp.job_id
  AND (
    wp.stripe_transfer_currency IS NULL
    OR wp.provider_earnings_currency IS NULL
    OR wp.job_currency IS NULL
  );
