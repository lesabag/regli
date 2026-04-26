-- Keep terminal "no providers" outcomes as exhausted instead of cancelled,
-- and ensure timeout advancement runs in the background without requiring any
-- client or walker session to stay open.
--
-- VERIFY CRON:
--   SELECT jobid, jobname, schedule, active
--   FROM cron.job
--   WHERE jobname = 'advance-dispatch';
--
-- VERIFY EXPIRED PENDING ATTEMPTS:
--   SELECT da.request_id, da.id AS attempt_id, da.attempt_no, da.expires_at, wr.status, wr.dispatch_state, wr.smart_dispatch_state, wr.walker_id
--   FROM public.dispatch_attempts da
--   JOIN public.walk_requests wr ON wr.id = da.request_id
--   WHERE da.status = 'pending'
--     AND da.expires_at <= now()
--   ORDER BY da.expires_at ASC;
--
-- MANUAL ADVANCE FOR A REQUEST:
--   SELECT * FROM public.advance_dispatch_request('<request-id>'::uuid, 20);

-- Repair legacy rows that were cancelled even though dispatch simply exhausted.
UPDATE public.walk_requests
SET
  status = 'open',
  smart_dispatch_state = 'exhausted',
  smart_dispatch_last_error = COALESCE(NULLIF(smart_dispatch_last_error, ''), 'All candidates exhausted'),
  smart_dispatch_completed_at = COALESCE(smart_dispatch_completed_at, now()),
  smart_dispatch_expires_at = NULL
WHERE walker_id IS NULL
  AND status = 'cancelled'
  AND (
    COALESCE(smart_dispatch_last_error, '') ILIKE '%all candidates exhausted%'
    OR (
      COALESCE(dispatch_state::text, '') = 'dispatched'
      AND COALESCE(smart_dispatch_state::text, '') = 'cancelled'
    )
  );

-- Rebuild the one-active-request rule so only truly assigned dispatched rows
-- count as active. Exhausted/unassigned dispatch rows should not be force-
-- cancelled during cleanup.
DROP INDEX IF EXISTS public.idx_walk_requests_one_active_per_client;

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
      OR (dispatch_state = 'dispatched' AND walker_id IS NOT NULL)
    )
    AND (dispatch_state IS NULL OR dispatch_state NOT IN ('cancelled', 'expired'))
    AND (smart_dispatch_state IS NULL OR smart_dispatch_state NOT IN ('cancelled', 'exhausted'))
    AND (payment_status IS NULL OR payment_status NOT IN ('failed', 'refunded'))
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
WHERE wr.client_id IS NOT NULL
  AND wr.status IN ('awaiting_payment', 'open', 'accepted')
  AND (
    wr.booking_timing IS NULL
    OR wr.booking_timing = 'asap'
    OR (wr.dispatch_state = 'dispatched' AND wr.walker_id IS NOT NULL)
  )
  AND (wr.dispatch_state IS NULL OR wr.dispatch_state NOT IN ('cancelled', 'expired'))
  AND (wr.smart_dispatch_state IS NULL OR wr.smart_dispatch_state NOT IN ('cancelled', 'exhausted'))
  AND (wr.payment_status IS NULL OR wr.payment_status NOT IN ('failed', 'refunded'))
  AND EXISTS (
    SELECT 1
    FROM public.walk_requests newer
    WHERE newer.client_id = wr.client_id
      AND newer.id <> wr.id
      AND newer.status IN ('awaiting_payment', 'open', 'accepted')
      AND (
        newer.booking_timing IS NULL
        OR newer.booking_timing = 'asap'
        OR (newer.dispatch_state = 'dispatched' AND newer.walker_id IS NOT NULL)
      )
      AND (newer.dispatch_state IS NULL OR newer.dispatch_state NOT IN ('cancelled', 'expired'))
      AND (newer.smart_dispatch_state IS NULL OR newer.smart_dispatch_state NOT IN ('cancelled', 'exhausted'))
      AND (newer.payment_status IS NULL OR newer.payment_status NOT IN ('failed', 'refunded'))
      AND (
        newer.created_at > wr.created_at
        OR (newer.created_at = wr.created_at AND newer.id > wr.id)
        OR (newer.created_at IS NOT NULL AND wr.created_at IS NULL)
      )
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_walk_requests_one_active_per_client
  ON public.walk_requests (client_id)
  WHERE client_id IS NOT NULL
    AND status IN ('awaiting_payment', 'open', 'accepted')
    AND (
      booking_timing IS NULL
      OR booking_timing = 'asap'
      OR (dispatch_state = 'dispatched' AND walker_id IS NOT NULL)
    )
    AND (dispatch_state IS NULL OR dispatch_state NOT IN ('cancelled', 'expired'))
    AND (smart_dispatch_state IS NULL OR smart_dispatch_state NOT IN ('cancelled', 'exhausted'))
    AND (payment_status IS NULL OR payment_status NOT IN ('failed', 'refunded'));

CREATE OR REPLACE FUNCTION public.process_expired_dispatch_attempts(
  p_limit INTEGER DEFAULT 100,
  p_timeout_seconds INTEGER DEFAULT 20
)
RETURNS TABLE(
  request_id UUID,
  ok BOOLEAN,
  message TEXT,
  attempt_id UUID,
  attempt_no INTEGER
) AS $process_expired_dispatch_attempts$
DECLARE
  v_timeout_seconds INTEGER;
  v_limit INTEGER;
  v_request RECORD;
  v_result RECORD;
BEGIN
  v_timeout_seconds := GREATEST(3, LEAST(60, COALESCE(p_timeout_seconds, 20)));
  v_limit := GREATEST(1, LEAST(500, COALESCE(p_limit, 100)));

  FOR v_request IN
    SELECT DISTINCT da.request_id
    FROM public.dispatch_attempts da
    JOIN public.walk_requests wr
      ON wr.id = da.request_id
    WHERE da.status = 'pending'
      AND da.expires_at <= now()
      AND wr.status = 'open'
      AND wr.walker_id IS NULL
      AND COALESCE(wr.smart_dispatch_state::text, '') NOT IN ('cancelled', 'exhausted')
    ORDER BY da.request_id
    LIMIT v_limit
  LOOP
    SELECT *
    INTO v_result
    FROM public.advance_dispatch_request(v_request.request_id, v_timeout_seconds)
    LIMIT 1;

    RETURN QUERY
    SELECT
      v_request.request_id,
      v_result.ok,
      v_result.message,
      v_result.attempt_id,
      v_result.attempt_no;
  END LOOP;

  RETURN;
END;
$process_expired_dispatch_attempts$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.process_expired_dispatch_attempts(INTEGER, INTEGER) TO authenticated;

-- Process any already-expired pending attempts immediately on deploy so
-- stranded open/dispatching requests move to the correct next state.
SELECT * FROM public.process_expired_dispatch_attempts(100, 20);

-- Background timeout advancement: expired pending attempts should advance even
-- when no walker or client session is active, without relying on an HTTP edge call.
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;

SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'advance-dispatch';

SELECT cron.schedule(
  'advance-dispatch',
  '* * * * *',
  $$
  SELECT * FROM public.process_expired_dispatch_attempts(100, 20);
  $$
);
