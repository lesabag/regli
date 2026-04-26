-- ============================================================
-- Payout system production hardening
-- Adds: processing + in_transit statuses, retry columns, refund tracking
-- ============================================================

-- 1. Expand the status CHECK constraint to include 'processing' and 'in_transit'
ALTER TABLE public.walker_payouts DROP CONSTRAINT IF EXISTS walker_payouts_status_check;
ALTER TABLE public.walker_payouts
  ADD CONSTRAINT walker_payouts_status_check
  CHECK (status IN ('pending', 'processing', 'transferred', 'in_transit', 'paid_out', 'failed', 'reversed', 'refunded'));

-- 2. Add retry columns
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'walker_payouts' AND column_name = 'retry_count'
  ) THEN
    ALTER TABLE public.walker_payouts ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'walker_payouts' AND column_name = 'next_retry_at'
  ) THEN
    ALTER TABLE public.walker_payouts ADD COLUMN next_retry_at TIMESTAMPTZ;
  END IF;
END $$;

-- 3. Index for retry queue lookups
CREATE INDEX IF NOT EXISTS idx_walker_payouts_retry_queue
  ON public.walker_payouts(status, next_retry_at)
  WHERE status = 'failed' AND retry_count < 5 AND next_retry_at IS NOT NULL;

-- 4. Index for processing timeout detection
CREATE INDEX IF NOT EXISTS idx_walker_payouts_processing
  ON public.walker_payouts(status, updated_at)
  WHERE status = 'processing';
