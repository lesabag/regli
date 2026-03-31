-- Add location tracking columns to walk_requests
-- Used for live walker→client map tracking during active walks.

ALTER TABLE public.walk_requests
  ADD COLUMN IF NOT EXISTS walker_lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS walker_lng DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS user_lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS user_lng DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS last_location_update TIMESTAMPTZ;

-- Index for efficient realtime filtering on active jobs
CREATE INDEX IF NOT EXISTS idx_walk_requests_active_tracking
  ON public.walk_requests (walker_id, status)
  WHERE status = 'accepted';
