-- Add payment tracking columns to walk_requests
ALTER TABLE walk_requests
  ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'unpaid'
    CONSTRAINT walk_requests_payment_status_check
    CHECK (payment_status IN ('unpaid', 'paid', 'failed', 'refunded')),
  ADD COLUMN stripe_payment_intent_id TEXT,
  ADD COLUMN paid_at TIMESTAMPTZ;
