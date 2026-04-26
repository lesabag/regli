-- Add commission columns to walk_requests
ALTER TABLE walk_requests
  ADD COLUMN IF NOT EXISTS platform_fee_percent NUMERIC NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS platform_fee NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS walker_earnings NUMERIC(10,2);
