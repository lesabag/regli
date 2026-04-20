-- Lightweight pricing signals — returns supply/demand snapshot
-- for the dynamic pricing engine. Minimal computation, fast response.

CREATE OR REPLACE FUNCTION pricing_signals()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_providers_online int;
  v_open_requests    int;
  v_submitted_recent int;
  v_matched_recent   int;
BEGIN
  -- No auth guard: any authenticated user can read pricing signals.
  -- This is intentional — clients need this to display surge pricing.

  -- Providers currently online
  SELECT count(*) INTO v_providers_online
  FROM profiles
  WHERE role = 'walker' AND is_online = true;

  -- Open (unmatched) requests right now
  SELECT count(*) INTO v_open_requests
  FROM walk_requests
  WHERE status = 'open';

  -- Submissions & matches in the last 30 minutes
  SELECT
    count(*) FILTER (WHERE event_name = 'service_request_submitted'),
    count(*) FILTER (WHERE event_name = 'provider_matched')
  INTO v_submitted_recent, v_matched_recent
  FROM analytics_events
  WHERE created_at >= now() - interval '30 minutes'
    AND event_name IN ('service_request_submitted', 'provider_matched');

  RETURN jsonb_build_object(
    'providers_online',  v_providers_online,
    'open_requests',     v_open_requests,
    'submitted_recent',  v_submitted_recent,
    'matched_recent',    v_matched_recent
  );
END;
$$;

REVOKE ALL ON FUNCTION pricing_signals() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pricing_signals() TO authenticated;
GRANT EXECUTE ON FUNCTION pricing_signals() TO service_role;
