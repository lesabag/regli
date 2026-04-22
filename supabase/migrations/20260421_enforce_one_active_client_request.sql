-- Enforce one effective active walk request per client.
--
-- Active here mirrors the client UI's current-request definition:
-- - request status is awaiting_payment, open, or accepted
-- - queued scheduled future orders are excluded until dispatch_state = dispatched
-- - cancelled/expired/exhausted/failed/refunded rows are excluded

WITH ranked_active AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY client_id
      ORDER BY created_at DESC NULLS LAST, id DESC
    ) AS rn
  FROM public.walk_requests
  WHERE client_id IS NOT NULL
    AND status IN ('awaiting_payment', 'open', 'accepted')
    AND (
      booking_timing IS NULL
      OR booking_timing = 'asap'
      OR dispatch_state = 'dispatched'
    )
    AND COALESCE(dispatch_state::text, '') NOT IN ('cancelled', 'expired')
    AND COALESCE(smart_dispatch_state::text, '') NOT IN ('cancelled', 'exhausted')
    AND COALESCE(payment_status::text, '') NOT IN ('failed', 'refunded')
)
UPDATE public.walk_requests wr
SET
  status = 'cancelled',
  dispatch_state = 'cancelled',
  smart_dispatch_state = 'cancelled',
  walker_id = NULL,
  selected_walker_id = NULL,
  walker_lat = NULL,
  walker_lng = NULL,
  last_location_update = NULL
FROM ranked_active ra
WHERE wr.id = ra.id
  AND ra.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_walk_requests_one_active_per_client
  ON public.walk_requests (client_id)
  WHERE client_id IS NOT NULL
    AND status IN ('awaiting_payment', 'open', 'accepted')
    AND (
      booking_timing IS NULL
      OR booking_timing = 'asap'
      OR dispatch_state = 'dispatched'
    )
    AND COALESCE(dispatch_state::text, '') NOT IN ('cancelled', 'expired')
    AND COALESCE(smart_dispatch_state::text, '') NOT IN ('cancelled', 'exhausted')
    AND COALESCE(payment_status::text, '') NOT IN ('failed', 'refunded');
