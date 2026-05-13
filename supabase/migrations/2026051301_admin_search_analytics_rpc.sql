-- Admin Search Analytics / Matching Funnel
-- Read-only aggregation for request search outcomes and matching conversion.

CREATE OR REPLACE FUNCTION admin_search_analytics(
  p_since timestamptz DEFAULT now() - interval '24 hours'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_summary jsonb;
  v_by_service jsonb;
  v_failure_reasons jsonb;
  v_empty jsonb;
BEGIN
  IF auth.uid() IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM profiles
       WHERE id = auth.uid() AND role = 'admin'
     )
  THEN
    v_empty := jsonb_build_object(
      'summary', jsonb_build_object(
        'searches_started', 0,
        'successful_matches', 0,
        'searches_exhausted', 0,
        'client_cancelled_while_searching', 0,
        'match_conversion_rate', 0,
        'exhaustion_rate', 0,
        'avg_time_to_match_sec', NULL,
        'sample_matched_count', 0
      ),
      'by_service_type', '[]'::jsonb,
      'failure_reasons', '[]'::jsonb
    );
    RETURN v_empty;
  END IF;

  WITH attempt_rollup AS (
    SELECT
      request_id,
      min(created_at) AS first_attempt_at,
      min(
        CASE
          WHEN status = 'accepted' THEN coalesce(responded_at, offered_at, created_at)
          ELSE NULL
        END
      ) AS first_accepted_at,
      count(*)::int AS attempt_count
    FROM dispatch_attempts
    GROUP BY request_id
  ),
  filtered_requests AS (
    SELECT
      wr.id,
      coalesce(nullif(wr.service_type, ''), 'unknown') AS service_type,
      wr.status,
      wr.booking_timing,
      nullif(btrim(wr.dispatch_state::text), '') AS dispatch_state_text,
      nullif(btrim(wr.smart_dispatch_state::text), '') AS smart_dispatch_state_text,
      wr.smart_dispatch_last_error,
      wr.walker_id,
      wr.notes,
      wr.created_at,
      ar.first_attempt_at,
      ar.first_accepted_at,
      coalesce(ar.attempt_count, 0) AS attempt_count,
      (
        coalesce(nullif(btrim(wr.smart_dispatch_state::text), ''), '') = 'exhausted'
        OR coalesce(wr.smart_dispatch_last_error, '') ILIKE '%all candidates exhausted%'
        OR coalesce(wr.smart_dispatch_last_error, '') ILIKE '%no matching providers for service_type%'
        OR coalesce(wr.smart_dispatch_last_error, '') ILIKE '%no matching providers for service type%'
        OR coalesce(wr.smart_dispatch_last_error, '') ILIKE '%no providers available%'
      ) AS is_exhausted,
      (
        wr.walker_id IS NOT NULL
        OR wr.status IN ('accepted', 'completed')
        OR ar.first_accepted_at IS NOT NULL
        OR coalesce(nullif(btrim(wr.smart_dispatch_state::text), ''), '') = 'assigned'
      ) AS is_matched
    FROM walk_requests wr
    LEFT JOIN attempt_rollup ar
      ON ar.request_id = wr.id
    WHERE wr.created_at >= p_since
      AND (
        wr.booking_timing IS DISTINCT FROM 'scheduled'
        OR coalesce(nullif(btrim(wr.dispatch_state::text), ''), '') = 'dispatched'
        OR coalesce(nullif(btrim(wr.smart_dispatch_state::text), ''), '') IN ('dispatching', 'assigned', 'exhausted', 'cancelled')
        OR coalesce(ar.attempt_count, 0) > 0
      )
  ),
  classified_requests AS (
    SELECT
      fr.*,
      (
        fr.status = 'cancelled'
        AND fr.walker_id IS NULL
        AND NOT fr.is_exhausted
        AND (
          fr.attempt_count > 0
          OR coalesce(fr.smart_dispatch_state_text, '') IN ('idle', 'dispatching', 'cancelled')
          OR coalesce(fr.dispatch_state_text, '') IN ('queued', 'dispatched')
        )
        AND coalesce(fr.notes, '') NOT ILIKE '%[SYSTEM:PROVIDER_REPORTED_ISSUE]%'
      ) AS is_client_cancelled_while_searching
    FROM filtered_requests fr
  ),
  summary_counts AS (
    SELECT
      count(*)::int AS searches_started,
      count(*) FILTER (WHERE is_matched)::int AS successful_matches,
      count(*) FILTER (WHERE is_exhausted)::int AS searches_exhausted,
      count(*) FILTER (WHERE is_client_cancelled_while_searching)::int AS client_cancelled_while_searching,
      round(
        avg(
          CASE
            WHEN is_matched AND first_accepted_at IS NOT NULL AND first_accepted_at > created_at
              THEN extract(epoch FROM first_accepted_at - created_at)
            ELSE NULL
          END
        )
      )::int AS avg_time_to_match_sec,
      count(*) FILTER (
        WHERE is_matched AND first_accepted_at IS NOT NULL AND first_accepted_at > created_at
      )::int AS sample_matched_count
    FROM classified_requests
  )
  SELECT jsonb_build_object(
    'searches_started', searches_started,
    'successful_matches', successful_matches,
    'searches_exhausted', searches_exhausted,
    'client_cancelled_while_searching', client_cancelled_while_searching,
    'match_conversion_rate',
      CASE
        WHEN searches_started > 0
          THEN round((successful_matches::numeric / searches_started::numeric) * 100, 1)
        ELSE 0
      END,
    'exhaustion_rate',
      CASE
        WHEN searches_started > 0
          THEN round((searches_exhausted::numeric / searches_started::numeric) * 100, 1)
        ELSE 0
      END,
    'avg_time_to_match_sec', avg_time_to_match_sec,
    'sample_matched_count', sample_matched_count
  )
  INTO v_summary
  FROM summary_counts;

  WITH attempt_rollup AS (
    SELECT
      request_id,
      min(created_at) AS first_attempt_at,
      min(
        CASE
          WHEN status = 'accepted' THEN coalesce(responded_at, offered_at, created_at)
          ELSE NULL
        END
      ) AS first_accepted_at,
      count(*)::int AS attempt_count
    FROM dispatch_attempts
    GROUP BY request_id
  ),
  filtered_requests AS (
    SELECT
      wr.id,
      coalesce(nullif(wr.service_type, ''), 'unknown') AS service_type,
      wr.status,
      wr.booking_timing,
      nullif(btrim(wr.dispatch_state::text), '') AS dispatch_state_text,
      nullif(btrim(wr.smart_dispatch_state::text), '') AS smart_dispatch_state_text,
      wr.smart_dispatch_last_error,
      wr.walker_id,
      wr.notes,
      wr.created_at,
      ar.first_attempt_at,
      ar.first_accepted_at,
      coalesce(ar.attempt_count, 0) AS attempt_count,
      (
        coalesce(nullif(btrim(wr.smart_dispatch_state::text), ''), '') = 'exhausted'
        OR coalesce(wr.smart_dispatch_last_error, '') ILIKE '%all candidates exhausted%'
        OR coalesce(wr.smart_dispatch_last_error, '') ILIKE '%no matching providers for service_type%'
        OR coalesce(wr.smart_dispatch_last_error, '') ILIKE '%no matching providers for service type%'
        OR coalesce(wr.smart_dispatch_last_error, '') ILIKE '%no providers available%'
      ) AS is_exhausted,
      (
        wr.walker_id IS NOT NULL
        OR wr.status IN ('accepted', 'completed')
        OR ar.first_accepted_at IS NOT NULL
        OR coalesce(nullif(btrim(wr.smart_dispatch_state::text), ''), '') = 'assigned'
      ) AS is_matched
    FROM walk_requests wr
    LEFT JOIN attempt_rollup ar
      ON ar.request_id = wr.id
    WHERE wr.created_at >= p_since
      AND (
        wr.booking_timing IS DISTINCT FROM 'scheduled'
        OR coalesce(nullif(btrim(wr.dispatch_state::text), ''), '') = 'dispatched'
        OR coalesce(nullif(btrim(wr.smart_dispatch_state::text), ''), '') IN ('dispatching', 'assigned', 'exhausted', 'cancelled')
        OR coalesce(ar.attempt_count, 0) > 0
      )
  ),
  classified_requests AS (
    SELECT
      fr.*,
      (
        fr.status = 'cancelled'
        AND fr.walker_id IS NULL
        AND NOT fr.is_exhausted
        AND (
          fr.attempt_count > 0
          OR coalesce(fr.smart_dispatch_state_text, '') IN ('idle', 'dispatching', 'cancelled')
          OR coalesce(fr.dispatch_state_text, '') IN ('queued', 'dispatched')
        )
        AND coalesce(fr.notes, '') NOT ILIKE '%[SYSTEM:PROVIDER_REPORTED_ISSUE]%'
      ) AS is_client_cancelled_while_searching
    FROM filtered_requests fr
  ),
  grouped AS (
    SELECT
      service_type,
      count(*)::int AS searches_started,
      count(*) FILTER (WHERE is_matched)::int AS successful_matches,
      count(*) FILTER (WHERE is_exhausted)::int AS searches_exhausted,
      count(*) FILTER (WHERE is_client_cancelled_while_searching)::int AS client_cancelled_while_searching,
      round(
        avg(
          CASE
            WHEN is_matched AND first_accepted_at IS NOT NULL AND first_accepted_at > created_at
              THEN extract(epoch FROM first_accepted_at - created_at)
            ELSE NULL
          END
        )
      )::int AS avg_time_to_match_sec
    FROM classified_requests
    GROUP BY service_type
  )
  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'service_type', service_type,
        'searches_started', searches_started,
        'successful_matches', successful_matches,
        'searches_exhausted', searches_exhausted,
        'client_cancelled_while_searching', client_cancelled_while_searching,
        'match_conversion_rate',
          CASE
            WHEN searches_started > 0
              THEN round((successful_matches::numeric / searches_started::numeric) * 100, 1)
            ELSE 0
          END,
        'exhaustion_rate',
          CASE
            WHEN searches_started > 0
              THEN round((searches_exhausted::numeric / searches_started::numeric) * 100, 1)
            ELSE 0
          END,
        'avg_time_to_match_sec', avg_time_to_match_sec
      )
      ORDER BY searches_started DESC, service_type
    ),
    '[]'::jsonb
  )
  INTO v_by_service
  FROM grouped;

  WITH attempt_rollup AS (
    SELECT request_id, count(*)::int AS attempt_count
    FROM dispatch_attempts
    GROUP BY request_id
  ),
  filtered_requests AS (
    SELECT
      wr.smart_dispatch_last_error,
      nullif(btrim(wr.dispatch_state::text), '') AS dispatch_state_text,
      nullif(btrim(wr.smart_dispatch_state::text), '') AS smart_dispatch_state_text
    FROM walk_requests wr
    LEFT JOIN attempt_rollup ar
      ON ar.request_id = wr.id
    WHERE wr.created_at >= p_since
      AND (
        wr.booking_timing IS DISTINCT FROM 'scheduled'
        OR coalesce(nullif(btrim(wr.dispatch_state::text), ''), '') = 'dispatched'
        OR coalesce(nullif(btrim(wr.smart_dispatch_state::text), ''), '') IN ('dispatching', 'assigned', 'exhausted', 'cancelled')
        OR coalesce(ar.attempt_count, 0) > 0
      )
      AND (
        coalesce(nullif(btrim(wr.smart_dispatch_state::text), ''), '') = 'exhausted'
        OR coalesce(wr.smart_dispatch_last_error, '') ILIKE '%all candidates exhausted%'
        OR coalesce(wr.smart_dispatch_last_error, '') ILIKE '%no matching providers for service_type%'
        OR coalesce(wr.smart_dispatch_last_error, '') ILIKE '%no matching providers for service type%'
        OR coalesce(wr.smart_dispatch_last_error, '') ILIKE '%no providers available%'
      )
  ),
  grouped AS (
    SELECT
      CASE
        WHEN coalesce(smart_dispatch_last_error, '') ILIKE '%all candidates exhausted%' THEN 'All candidates exhausted'
        WHEN coalesce(smart_dispatch_last_error, '') ILIKE '%no matching providers for service_type%' THEN 'No matching providers for service type'
        WHEN coalesce(smart_dispatch_last_error, '') ILIKE '%no matching providers for service type%' THEN 'No matching providers for service type'
        WHEN coalesce(smart_dispatch_last_error, '') ILIKE '%no providers available%' THEN 'No providers available'
        WHEN nullif(trim(coalesce(smart_dispatch_last_error, '')), '') IS NOT NULL THEN trim(smart_dispatch_last_error)
        ELSE 'Unknown'
      END AS reason,
      count(*)::int AS total
    FROM filtered_requests
    GROUP BY 1
    ORDER BY total DESC, reason
    LIMIT 5
  )
  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'reason', reason,
        'total', total
      )
      ORDER BY total DESC, reason
    ),
    '[]'::jsonb
  )
  INTO v_failure_reasons
  FROM grouped;

  RETURN jsonb_build_object(
    'summary', v_summary,
    'by_service_type', v_by_service,
    'failure_reasons', v_failure_reasons
  );
END;
$$;

REVOKE ALL ON FUNCTION admin_search_analytics(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_search_analytics(timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION admin_search_analytics(timestamptz) TO service_role;
