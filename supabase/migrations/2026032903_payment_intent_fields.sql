-- Add payment intent fields to walk_requests for Stripe Connect destination charges
-- Run this AFTER the previous migrations (add_payments, add_commission, fix_prepayment_job_flow)

-- New columns for PaymentIntent + Connect flow
ALTER TABLE walk_requests
  ADD COLUMN IF NOT EXISTS amount INTEGER,
  ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'ils',
  ADD COLUMN IF NOT EXISTS stripe_client_secret TEXT,
  ADD COLUMN IF NOT EXISTS payment_authorized_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS selected_walker_id UUID REFERENCES profiles(id),
  ADD COLUMN IF NOT EXISTS walker_amount NUMERIC(10,2);

-- Update payment_status to include 'authorized'
ALTER TABLE walk_requests
  DROP CONSTRAINT IF EXISTS walk_requests_payment_status_check;

ALTER TABLE walk_requests
  ADD CONSTRAINT walk_requests_payment_status_check
  CHECK (payment_status IN ('unpaid', 'authorized', 'paid', 'failed', 'refunded'));
