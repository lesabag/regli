-- Retention & Cohort Analytics — server-side aggregation
-- Returns daily new/returning users, cohort retention (D1/D3/D7),
-- and repeat request rate.

CREATE OR REPLACE FUNCTION admin_retention_cohorts(
  p_since timestamptz DEFAULT now() - interval '30 days'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_daily     jsonb;
  v_cohorts   jsonb;
  v_repeat    jsonb;
BEGIN
  -- ── Soft auth guard ──────────────────────────────────
  IF auth.uid() IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM profiles
       WHERE id = auth.uid() AND role = 'admin'
     )
  THEN
    RETURN jsonb_build_object(
      'daily',   '[]'::jsonb,
      'cohorts', '[]'::jsonb,
      'repeat',  '{}'::jsonb
    );
  END IF;

  -- ── 1. Daily new vs returning users ──────────────────
  --    "new" = user whose first analytics event is on that day
  --    "returning" = user seen before that day
  WITH first_seen AS (
    SELECT
      user_id,
      (min(created_at) AT TIME ZONE 'UTC')::date AS first_day
    FROM analytics_events
    WHERE user_id IS NOT NULL
    GROUP BY user_id
  ),
  daily_users AS (
    SELECT DISTINCT
      (ae.created_at AT TIME ZONE 'UTC')::date AS day,
      ae.user_id
    FROM analytics_events ae
    WHERE ae.created_at >= p_since
      AND ae.user_id IS NOT NULL
  )
  SELECT coalesce(jsonb_agg(row_to_json(sub)::jsonb ORDER BY sub.day), '[]'::jsonb)
  INTO v_daily
  FROM (
    SELECT
      du.day::text AS day,
      count(*)::int AS total_users,
      count(*) FILTER (WHERE fs.first_day = du.day)::int AS new_users,
      count(*) FILTER (WHERE fs.first_day < du.day)::int AS returning_users
    FROM daily_users du
    JOIN first_seen fs ON fs.user_id = du.user_id
    GROUP BY du.day
  ) sub;

  -- ── 2. Cohort retention table ────────────────────────
  --    Cohort = day user first submitted a service request.
  --    Retention = % of cohort that submitted again on D1, D3, D7.
  WITH cohort_base AS (
    SELECT
      user_id,
      (min(created_at) AT TIME ZONE 'UTC')::date AS cohort_day
    FROM analytics_events
    WHERE event_name = 'service_request_submitted'
      AND user_id IS NOT NULL
      AND created_at >= p_since
    GROUP BY user_id
  ),
  activity AS (
    SELECT DISTINCT
      ae.user_id,
      (ae.created_at AT TIME ZONE 'UTC')::date AS active_day
    FROM analytics_events ae
    WHERE ae.event_name = 'service_request_submitted'
      AND ae.user_id IS NOT NULL
      AND ae.created_at >= p_since
  )
  SELECT coalesce(jsonb_agg(row_to_json(sub)::jsonb ORDER BY sub.cohort_day), '[]'::jsonb)
  INTO v_cohorts
  FROM (
    SELECT
      cb.cohort_day::text AS cohort_day,
      count(DISTINCT cb.user_id)::int AS cohort_size,
      count(DISTINCT CASE
        WHEN a.active_day = cb.cohort_day + 1
        THEN cb.user_id END)::int AS d1,
      count(DISTINCT CASE
        WHEN a.active_day = cb.cohort_day + 3
        THEN cb.user_id END)::int AS d3,
      count(DISTINCT CASE
        WHEN a.active_day = cb.cohort_day + 7
        THEN cb.user_id END)::int AS d7
    FROM cohort_base cb
    LEFT JOIN activity a ON a.user_id = cb.user_id
    WHERE cb.cohort_day <= (now() AT TIME ZONE 'UTC')::date - 1
    GROUP BY cb.cohort_day
  ) sub;

  -- ── 3. Repeat request rate ───────────────────────────
  --    Users with >1 service_request_submitted in the window.
  WITH user_counts AS (
    SELECT
      user_id,
      count(*)::int AS req_count
    FROM analytics_events
    WHERE event_name = 'service_request_submitted'
      AND user_id IS NOT NULL
      AND created_at >= p_since
    GROUP BY user_id
  )
  SELECT jsonb_build_object(
    'total_requestors',  (SELECT count(*)::int FROM user_counts),
    'repeat_requestors', (SELECT count(*)::int FROM user_counts WHERE req_count > 1),
    'avg_requests',      (SELECT round(avg(req_count), 1) FROM user_counts),
    'max_requests',      (SELECT coalesce(max(req_count), 0) FROM user_counts),
    'power_users',       (SELECT count(*)::int FROM user_counts WHERE req_count >= 5)
  ) INTO v_repeat;

  RETURN jsonb_build_object(
    'daily',   v_daily,
    'cohorts', v_cohorts,
    'repeat',  v_repeat
  );
END;
$$;

REVOKE ALL ON FUNCTION admin_retention_cohorts(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_retention_cohorts(timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION admin_retention_cohorts(timestamptz) TO service_role;
