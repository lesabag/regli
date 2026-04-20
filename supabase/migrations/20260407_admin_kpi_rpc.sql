-- Admin KPI Dashboard — server-side aggregation function
-- Returns event counts, funnel time metrics, GMV, and operational health
-- in a single RPC call. Filterable by time window, service_category, platform.
--
-- Access control:
--   - postgres / service_role (SQL editor): always allowed (auth.uid() is NULL)
--   - authenticated admin: allowed (profiles.role = 'admin')
--   - authenticated non-admin: returns empty jsonb (no exception)
--
-- V1 event taxonomy used:
--   service_request_submitted, provider_matched, provider_accepted,
--   service_started, service_completed, payment_captured,
--   payment_failed, payout_failed

CREATE OR REPLACE FUNCTION admin_kpi_metrics(
  p_since            timestamptz DEFAULT now() - interval '24 hours',
  p_service_category text        DEFAULT NULL,
  p_platform         text        DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_counts jsonb;
  v_time   jsonb;
  v_gmv    numeric;
  v_ops    jsonb;
  v_empty  jsonb;
BEGIN
  -- ── Access control (soft guard — no exception) ────────
  -- Allow postgres / service_role (auth.uid() is NULL in SQL editor)
  -- Allow authenticated users with admin role
  -- Return empty result for non-admin authenticated users
  IF auth.uid() IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM profiles
       WHERE id = auth.uid() AND role = 'admin'
     )
  THEN
    v_empty := jsonb_build_object(
      'event_counts',  '{}'::jsonb,
      'time_metrics',  jsonb_build_object(
        'avg_request_to_match_sec',   NULL,
        'avg_match_to_accept_sec',    NULL,
        'avg_accept_to_complete_sec', NULL,
        'sample_count',               0
      ),
      'gmv',           0,
      'operational',   jsonb_build_object(
        'open_requests',         0,
        'available_providers',   0,
        'stuck_requests',        0,
        'failed_payments_recent',0,
        'failed_payouts_recent', 0
      )
    );
    RETURN v_empty;
  END IF;

  -- ── 1. Event counts by name ──────────────────────────
  SELECT coalesce(jsonb_object_agg(sub.evt, sub.cnt), '{}')
  INTO v_counts
  FROM (
    SELECT event_name AS evt, count(*)::int AS cnt
    FROM analytics_events
    WHERE created_at >= p_since
      AND (p_service_category IS NULL
           OR payload->>'service_category' = p_service_category)
      AND (p_platform IS NULL
           OR payload->>'platform' = p_platform)
    GROUP BY event_name
  ) sub;

  -- ── 2. Time metrics via request_id correlation ───────
  --    Computes avg seconds between lifecycle events
  --    for requests that have a request_id in their payload.
  WITH ev AS (
    SELECT
      payload->>'request_id' AS rid,
      event_name,
      min(created_at)        AS ts
    FROM analytics_events
    WHERE created_at >= p_since
      AND payload->>'request_id' IS NOT NULL
      AND event_name IN (
        'service_request_submitted',
        'provider_matched',
        'provider_accepted',
        'service_started',
        'service_completed'
      )
      AND (p_service_category IS NULL
           OR payload->>'service_category' = p_service_category)
      AND (p_platform IS NULL
           OR payload->>'platform' = p_platform)
    GROUP BY payload->>'request_id', event_name
  ),
  base AS (
    SELECT rid, min(ts) AS ts
    FROM ev WHERE event_name = 'service_request_submitted'
    GROUP BY rid
  ),
  matched AS (
    SELECT rid, min(ts) AS ts
    FROM ev WHERE event_name = 'provider_matched'
    GROUP BY rid
  ),
  accepted AS (
    SELECT rid, min(ts) AS ts
    FROM ev WHERE event_name = 'provider_accepted'
    GROUP BY rid
  ),
  started AS (
    SELECT rid, min(ts) AS ts
    FROM ev WHERE event_name = 'service_started'
    GROUP BY rid
  ),
  completed AS (
    SELECT rid, min(ts) AS ts
    FROM ev WHERE event_name = 'service_completed'
    GROUP BY rid
  ),
  paired AS (
    SELECT
      b.rid,
      extract(epoch from m.ts - b.ts)                          AS req_to_match,
      extract(epoch from a.ts - m.ts)                          AS match_to_accept,
      extract(epoch from c.ts - coalesce(a.ts, m.ts))         AS accept_to_complete
    FROM base b
    LEFT JOIN matched   m USING (rid)
    LEFT JOIN accepted  a USING (rid)
    LEFT JOIN started   s USING (rid)
    LEFT JOIN completed c USING (rid)
  )
  SELECT jsonb_build_object(
    'avg_request_to_match_sec',
      round(avg(CASE WHEN req_to_match > 0 THEN req_to_match END)),
    'avg_match_to_accept_sec',
      round(avg(CASE WHEN match_to_accept > 0 THEN match_to_accept END)),
    'avg_accept_to_complete_sec',
      round(avg(CASE WHEN accept_to_complete > 0 THEN accept_to_complete END)),
    'sample_count', count(*)::int
  ) INTO v_time
  FROM paired;

  -- ── 3. GMV from paid requests ────────────────────────
  SELECT coalesce(sum(price), 0)
  INTO v_gmv
  FROM walk_requests
  WHERE payment_status = 'paid'
    AND paid_at >= p_since;

  -- ── 4. Operational health (real-time, ignores time filter) ──
  SELECT jsonb_build_object(
    'open_requests',
      (SELECT count(*)::int FROM walk_requests
       WHERE status = 'open'),
    'available_providers',
      (SELECT count(*)::int FROM profiles
       WHERE role = 'walker' AND is_online = true),
    'stuck_requests',
      (SELECT count(*)::int FROM walk_requests
       WHERE status = 'accepted'
         AND created_at < now() - interval '2 hours'),
    'failed_payments_recent',
      (SELECT count(*)::int FROM analytics_events
       WHERE event_name = 'payment_failed'
         AND created_at >= p_since
         AND (p_platform IS NULL OR payload->>'platform' = p_platform)),
    'failed_payouts_recent',
      (SELECT count(*)::int FROM analytics_events
       WHERE event_name = 'payout_failed'
         AND created_at >= p_since
         AND (p_platform IS NULL OR payload->>'platform' = p_platform))
  ) INTO v_ops;

  -- ── Combine and return ───────────────────────────────
  RETURN jsonb_build_object(
    'event_counts',  v_counts,
    'time_metrics',  coalesce(v_time, '{}'),
    'gmv',           v_gmv,
    'operational',   v_ops
  );
END;
$$;

-- postgres and service_role inherit execute as superuser/owner.
-- Authenticated users can call; admin check is inside the function.
-- Non-admin authenticated users get an empty result (no crash).
REVOKE ALL ON FUNCTION admin_kpi_metrics(timestamptz, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_kpi_metrics(timestamptz, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION admin_kpi_metrics(timestamptz, text, text) TO service_role;
