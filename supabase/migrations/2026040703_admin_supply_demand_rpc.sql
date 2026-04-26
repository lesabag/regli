-- Supply / Demand Intelligence — server-side aggregation
-- Returns rates, hourly breakdown, category breakdown, platform breakdown
-- for the admin supply/demand dashboard panel.

CREATE OR REPLACE FUNCTION admin_supply_demand(
  p_since timestamptz DEFAULT now() - interval '7 days'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rates    jsonb;
  v_hourly   jsonb;
  v_by_cat   jsonb;
  v_by_plat  jsonb;
  v_by_zone  jsonb;
BEGIN
  -- ── Soft auth guard (same pattern as admin_kpi_metrics) ──
  IF auth.uid() IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM profiles
       WHERE id = auth.uid() AND role = 'admin'
     )
  THEN
    RETURN jsonb_build_object(
      'rates',       '{}'::jsonb,
      'hourly',      '[]'::jsonb,
      'by_category', '[]'::jsonb,
      'by_platform', '[]'::jsonb,
      'by_zone',     '[]'::jsonb
    );
  END IF;

  -- ── 1. Overall rates ─────────────────────────────────
  WITH counts AS (
    SELECT event_name, count(*)::int AS cnt
    FROM analytics_events
    WHERE created_at >= p_since
      AND event_name IN (
        'service_request_submitted',
        'provider_matched',
        'provider_accepted',
        'provider_rejected',
        'service_started',
        'service_completed',
        'service_request_cancelled'
      )
    GROUP BY event_name
  )
  SELECT jsonb_build_object(
    'submitted',  coalesce((SELECT cnt FROM counts WHERE event_name = 'service_request_submitted'), 0),
    'matched',    coalesce((SELECT cnt FROM counts WHERE event_name = 'provider_matched'), 0),
    'accepted',   coalesce((SELECT cnt FROM counts WHERE event_name = 'provider_accepted'), 0),
    'rejected',   coalesce((SELECT cnt FROM counts WHERE event_name = 'provider_rejected'), 0),
    'started',    coalesce((SELECT cnt FROM counts WHERE event_name = 'service_started'), 0),
    'completed',  coalesce((SELECT cnt FROM counts WHERE event_name = 'service_completed'), 0),
    'cancelled',  coalesce((SELECT cnt FROM counts WHERE event_name = 'service_request_cancelled'), 0),
    'providers_online', (SELECT count(*)::int FROM profiles WHERE role = 'walker' AND is_online = true),
    'open_requests',    (SELECT count(*)::int FROM walk_requests WHERE status = 'open')
  ) INTO v_rates;

  -- ── 2. Hourly breakdown ──────────────────────────────
  SELECT coalesce(jsonb_agg(row_to_json(sub)::jsonb ORDER BY sub.h), '[]'::jsonb)
  INTO v_hourly
  FROM (
    SELECT
      extract(hour from created_at)::int AS h,
      count(*) FILTER (WHERE event_name = 'service_request_submitted')::int AS submitted,
      count(*) FILTER (WHERE event_name = 'provider_matched')::int          AS matched,
      count(*) FILTER (WHERE event_name = 'service_completed')::int         AS completed,
      count(*) FILTER (WHERE event_name = 'service_request_cancelled')::int AS cancelled
    FROM analytics_events
    WHERE created_at >= p_since
      AND event_name IN (
        'service_request_submitted', 'provider_matched',
        'service_completed', 'service_request_cancelled'
      )
    GROUP BY extract(hour from created_at)::int
  ) sub;

  -- ── 3. By service category ───────────────────────────
  SELECT coalesce(jsonb_agg(row_to_json(sub)::jsonb ORDER BY sub.submitted DESC), '[]'::jsonb)
  INTO v_by_cat
  FROM (
    SELECT
      coalesce(payload->>'service_category', 'unknown') AS category,
      count(*) FILTER (WHERE event_name = 'service_request_submitted')::int AS submitted,
      count(*) FILTER (WHERE event_name = 'provider_matched')::int          AS matched,
      count(*) FILTER (WHERE event_name = 'service_completed')::int         AS completed,
      count(*) FILTER (WHERE event_name = 'service_request_cancelled')::int AS cancelled
    FROM analytics_events
    WHERE created_at >= p_since
      AND event_name IN (
        'service_request_submitted', 'provider_matched',
        'service_completed', 'service_request_cancelled'
      )
    GROUP BY coalesce(payload->>'service_category', 'unknown')
  ) sub;

  -- ── 4. By platform ──────────────────────────────────
  SELECT coalesce(jsonb_agg(row_to_json(sub)::jsonb ORDER BY sub.submitted DESC), '[]'::jsonb)
  INTO v_by_plat
  FROM (
    SELECT
      coalesce(payload->>'platform', 'unknown') AS platform,
      count(*) FILTER (WHERE event_name = 'service_request_submitted')::int AS submitted,
      count(*) FILTER (WHERE event_name = 'provider_matched')::int          AS matched,
      count(*) FILTER (WHERE event_name = 'service_completed')::int         AS completed,
      count(*) FILTER (WHERE event_name = 'service_request_cancelled')::int AS cancelled
    FROM analytics_events
    WHERE created_at >= p_since
      AND event_name IN (
        'service_request_submitted', 'provider_matched',
        'service_completed', 'service_request_cancelled'
      )
    GROUP BY coalesce(payload->>'platform', 'unknown')
  ) sub;

  -- ── 5. By city / zone (only if data exists) ─────────
  SELECT coalesce(jsonb_agg(row_to_json(sub)::jsonb ORDER BY sub.submitted DESC), '[]'::jsonb)
  INTO v_by_zone
  FROM (
    SELECT
      coalesce(payload->>'city', payload->>'zone') AS zone,
      count(*) FILTER (WHERE event_name = 'service_request_submitted')::int AS submitted,
      count(*) FILTER (WHERE event_name = 'provider_matched')::int          AS matched,
      count(*) FILTER (WHERE event_name = 'service_completed')::int         AS completed,
      count(*) FILTER (WHERE event_name = 'service_request_cancelled')::int AS cancelled
    FROM analytics_events
    WHERE created_at >= p_since
      AND event_name IN (
        'service_request_submitted', 'provider_matched',
        'service_completed', 'service_request_cancelled'
      )
      AND (payload->>'city' IS NOT NULL OR payload->>'zone' IS NOT NULL)
    GROUP BY coalesce(payload->>'city', payload->>'zone')
  ) sub;

  -- ── Combine ──────────────────────────────────────────
  RETURN jsonb_build_object(
    'rates',       v_rates,
    'hourly',      v_hourly,
    'by_category', v_by_cat,
    'by_platform', v_by_plat,
    'by_zone',     v_by_zone
  );
END;
$$;

REVOKE ALL ON FUNCTION admin_supply_demand(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_supply_demand(timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION admin_supply_demand(timestamptz) TO service_role;
