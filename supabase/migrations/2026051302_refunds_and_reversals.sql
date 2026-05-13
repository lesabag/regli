-- Refund + transfer reversal metadata for marketplace dispute/admin flows

ALTER TABLE public.walk_requests
  ADD COLUMN IF NOT EXISTS refunded_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refund_currency TEXT,
  ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_stripe_refund_id TEXT;

ALTER TABLE public.walker_payouts
  ADD COLUMN IF NOT EXISTS reversed_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stripe_transfer_reversal_id TEXT;

ALTER TABLE public.wallet_transactions
  DROP CONSTRAINT IF EXISTS wallet_transactions_type_check;

ALTER TABLE public.wallet_transactions
  ADD CONSTRAINT wallet_transactions_type_check
  CHECK (type IN ('credit', 'debit', 'payout', 'refund', 'transfer_reversal'));

ALTER TABLE public.wallet_transactions
  DROP CONSTRAINT IF EXISTS wallet_transactions_status_check;

ALTER TABLE public.wallet_transactions
  ADD CONSTRAINT wallet_transactions_status_check
  CHECK (status IN ('pending', 'available', 'paid', 'reversed', 'partial', 'succeeded', 'failed'));

CREATE INDEX IF NOT EXISTS idx_walk_requests_refunded_at
  ON public.walk_requests (refunded_at DESC)
  WHERE refunded_at IS NOT NULL;

