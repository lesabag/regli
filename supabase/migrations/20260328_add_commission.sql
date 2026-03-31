-- Add commission columns to walk_requests
ALTER TABLE walk_requests
  ADD COLUMN platform_fee_percent NUMERIC NOT NULL DEFAULT 20,
  ADD COLUMN platform_fee NUMERIC(10,2),
  ADD COLUMN walker_earnings NUMERIC(10,2);
