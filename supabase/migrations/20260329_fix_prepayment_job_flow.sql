-- Fix marketplace flow: jobs must be paid before walkers can see them
-- Add 'awaiting_payment' to the status enum

-- Drop old constraint
ALTER TABLE walk_requests
  DROP CONSTRAINT IF EXISTS walk_requests_status_check;

-- Add new constraint with awaiting_payment
ALTER TABLE walk_requests
  ADD CONSTRAINT walk_requests_status_check
  CHECK (status IN ('awaiting_payment', 'open', 'accepted', 'completed', 'cancelled'));

-- Migrate any existing unpaid open jobs to awaiting_payment
UPDATE walk_requests
  SET status = 'awaiting_payment'
  WHERE status = 'open'
    AND payment_status = 'unpaid'
    AND walker_id IS NULL;
