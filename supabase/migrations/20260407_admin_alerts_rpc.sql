-- Alerts & Auto-Remediation — server-side alert detection
-- Returns current alerts, recovery activity, 24h history, and live snapshot.
-- Uses analytics_events + walk_requests. No schema changes needed.

-- Drop prior single-arg overload if it exists (avoids ambiguity).
DROP FUNCTION IF EXISTS admin_alerts_check(int);

CREATE OR REPLACE FUNCTION admin_alerts_check(
  p_short_window int DEFAULT 15,   -- minutes: payment / payout window
  p_long_window  int DEFAULT 30    -- minutes: cancel / no-match window
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_alerts     jsonb := '[]'::jsonb;
  v_recovery   jsonb;
  v_history    jsonb;
  v_now        timestamptz := now();
  v_short      timestamptz := now() - (p_short_window || ' minutes')::interval;
  v_long       timestamptz := now() - (p_long_window  || ' minutes')::interval;
  v_24h        timestamptz := now() - interval '24 hours';

  -- Short window counts (payment / payout)
  v_pay_captured   int;   -- payment_captured  = successful capture
  v_pay_failed     int;   -- payment_failed    = failed capture
  v_payout_failed  int;   -- payout_failed     = failed transfer/payout

  -- Long window counts (cancel / no-match)
  v_submitted      int;
  v_matched        int;
  v_cancelled      int;

  -- Real-time counts
  v_stuck_pay      int;
  v_stuck_open     int;
  v_stuck_accepted int;
  v_stuck_total    int;
  v_providers_online int;
  v_open_requests    int;

  -- Computed denominators & rates
  v_pay_attempts     int;   -- captured + failed
  v_pay_fail_rate    numeric;
  v_payout_fail_rate numeric;
  v_cancel_rate      numeric;
  v_nomatch_rate     numeric;
  v_unmatched        int;
BEGIN
  -- ── Auth guard ───────────────────────────────────────
  IF auth.uid() IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM profiles
       WHERE id = auth.uid() AND role = 'admin'
     )
  THEN
    RETURN jsonb_build_object(
      'alerts',   '[]'::jsonb,
      'recovery', '[]'::jsonb,
      'history',  '[]'::jsonb,
      'snapshot', '{}'::jsonb
    );
  END IF;

  -- ── 1a. Short-window events (15 min) ────────────────
  --    payment_captured  = denominator for payment success
  --    payment_failed    = numerator for payment failure
  --    payout_failed     = payout failures (denominator = pay_captured)
  SELECT
    count(*) FILTER (WHERE event_name = 'payment_captured'),
    count(*) FILTER (WHERE event_name = 'payment_failed'),
    count(*) FILTER (WHERE event_name = 'payout_failed')
  INTO v_pay_captured, v_pay_failed, v_payout_failed
  FROM analytics_events
  WHERE created_at >= v_short;

  -- ── 1b. Long-window events (30 min) ─────────────────
  SELECT
    count(*) FILTER (WHERE event_name = 'service_request_submitted'),
    count(*) FILTER (WHERE event_name = 'provider_matched'),
    count(*) FILTER (WHERE event_name = 'service_request_cancelled')
  INTO v_submitted, v_matched, v_cancelled
  FROM analytics_events
  WHERE created_at >= v_long;

  -- ── 2. Stuck requests (real-time) ───────────────────
  SELECT
    count(*) FILTER (WHERE status = 'awaiting_payment' AND created_at < v_now - interval '15 minutes'),
    count(*) FILTER (WHERE status = 'open'             AND created_at < v_now - interval '30 minutes'),
    count(*) FILTER (WHERE status = 'accepted'         AND created_at < v_now - interval '2 hours')
  INTO v_stuck_pay, v_stuck_open, v_stuck_accepted
  FROM walk_requests
  WHERE status IN ('awaiting_payment', 'open', 'accepted');

  v_stuck_total := v_stuck_pay + v_stuck_open + v_stuck_accepted;

  -- ── 3. Provider availability (real-time) ────────────
  SELECT count(*) INTO v_providers_online
  FROM profiles WHERE role = 'walker' AND is_online = true;

  SELECT count(*) INTO v_open_requests
  FROM walk_requests WHERE status = 'open';

  -- ── 4. Compute rates (clamped 0–100) ────────────────

  -- Payment failure rate = payment_failed / (payment_captured + payment_failed)
  v_pay_attempts  := v_pay_captured + v_pay_failed;
  v_pay_fail_rate := CASE WHEN v_pay_attempts > 0
                     THEN LEAST(100, round((v_pay_failed::numeric / v_pay_attempts) * 100, 1))
                     ELSE 0 END;

  -- Payout failure rate = payout_failed / payment_captured
  -- (every captured payment should trigger a payout attempt)
  v_payout_fail_rate := CASE WHEN v_pay_captured > 0
                        THEN LEAST(100, round((v_payout_failed::numeric / v_pay_captured) * 100, 1))
                        ELSE 0 END;

  -- Cancellation rate = cancelled / submitted
  v_cancel_rate := CASE WHEN v_submitted > 0
                   THEN LEAST(100, round((v_cancelled::numeric / v_submitted) * 100, 1))
                   ELSE 0 END;

  -- No-match rate = max(0, submitted - matched) / submitted
  v_unmatched   := GREATEST(0, v_submitted - v_matched);
  v_nomatch_rate := CASE WHEN v_submitted > 0
                    THEN LEAST(100, round((v_unmatched::numeric / v_submitted) * 100, 1))
                    ELSE 0 END;

  -- ── 5. Evaluate alert conditions ────────────────────
  --    All rate alerts require min 5 events in denominator
  --    to suppress noise from tiny samples.

  -- Payment failure rate > 10%  (min 5 payment attempts)
  IF v_pay_fail_rate > 10 AND v_pay_attempts >= 5 THEN
    v_alerts := v_alerts || jsonb_build_object(
      'id',            'payment_failed_high',
      'severity',      CASE WHEN v_pay_fail_rate > 40 THEN 'high' WHEN v_pay_fail_rate > 20 THEN 'medium' ELSE 'low' END,
      'title',         'High Payment Failure Rate',
      'metric',        'payment_failed_rate',
      'message',       format('Payment failure rate is %s%% — %s failed out of %s payment attempts in the last %s min', v_pay_fail_rate, v_pay_failed, v_pay_attempts, p_short_window),
      'current_value', v_pay_fail_rate,
      'threshold',     10,
      'window_minutes', p_short_window,
      'affected_count', v_pay_failed,
      'auto_action',   'retry_failed_payments',
      'detected_at',   v_now
    );
  END IF;

  -- Payout failure rate > 10%  (min 5 captured payments as denominator)
  IF v_payout_fail_rate > 10 AND v_pay_captured >= 5 THEN
    v_alerts := v_alerts || jsonb_build_object(
      'id',            'payout_failed_high',
      'severity',      CASE WHEN v_payout_fail_rate > 40 THEN 'high' WHEN v_payout_fail_rate > 20 THEN 'medium' ELSE 'low' END,
      'title',         'High Payout Failure Rate',
      'metric',        'payout_failed_rate',
      'message',       format('Payout failure rate is %s%% — %s failed out of %s captured payments in the last %s min', v_payout_fail_rate, v_payout_failed, v_pay_captured, p_short_window),
      'current_value', v_payout_fail_rate,
      'threshold',     10,
      'window_minutes', p_short_window,
      'affected_count', v_payout_failed,
      'auto_action',   'retry_failed_payouts',
      'detected_at',   v_now
    );
  END IF;

  -- Cancellation rate > 20%  (min 5 submissions)
  IF v_cancel_rate > 20 AND v_submitted >= 5 THEN
    v_alerts := v_alerts || jsonb_build_object(
      'id',            'cancellation_high',
      'severity',      CASE WHEN v_cancel_rate > 50 THEN 'high' WHEN v_cancel_rate > 35 THEN 'medium' ELSE 'low' END,
      'title',         'High Cancellation Rate',
      'metric',        'cancellation_rate',
      'message',       format('Cancellation rate is %s%% — %s of %s service requests cancelled in the last %s min', v_cancel_rate, v_cancelled, v_submitted, p_long_window),
      'current_value', v_cancel_rate,
      'threshold',     20,
      'window_minutes', p_long_window,
      'affected_count', v_cancelled,
      'auto_action',   null,
      'detected_at',   v_now
    );
  END IF;

  -- No-match rate > 25%  (min 5 submissions)
  IF v_nomatch_rate > 25 AND v_submitted >= 5 THEN
    v_alerts := v_alerts || jsonb_build_object(
      'id',            'nomatch_high',
      'severity',      CASE WHEN v_nomatch_rate > 60 THEN 'high' WHEN v_nomatch_rate > 40 THEN 'medium' ELSE 'low' END,
      'title',         'No-Match Spike',
      'metric',        'nomatch_rate',
      'message',       format('No-match rate is %s%% — %s unmatched of %s service requests in the last %s min', v_nomatch_rate, v_unmatched, v_submitted, p_long_window),
      'current_value', v_nomatch_rate,
      'threshold',     25,
      'window_minutes', p_long_window,
      'affected_count', v_unmatched,
      'auto_action',   null,
      'detected_at',   v_now
    );
  END IF;

  -- Stuck requests > 5
  IF v_stuck_total > 5 THEN
    v_alerts := v_alerts || jsonb_build_object(
      'id',            'stuck_requests_high',
      'severity',      CASE WHEN v_stuck_total > 15 THEN 'high' WHEN v_stuck_total > 8 THEN 'medium' ELSE 'low' END,
      'title',         'Stuck Requests Spike',
      'metric',        'stuck_requests',
      'message',       format('%s stuck service requests: %s awaiting payment, %s open, %s accepted', v_stuck_total, v_stuck_pay, v_stuck_open, v_stuck_accepted),
      'current_value', v_stuck_total,
      'threshold',     5,
      'window_minutes', null,
      'affected_count', v_stuck_total,
      'auto_action',   'flag_stuck_requests',
      'detected_at',   v_now
    );
  END IF;

  -- Provider availability < 2 (only relevant when there is demand)
  IF v_open_requests > 0 AND v_providers_online < 2 THEN
    v_alerts := v_alerts || jsonb_build_object(
      'id',            CASE WHEN v_providers_online = 0 THEN 'no_providers_online' ELSE 'low_provider_availability' END,
      'severity',      CASE WHEN v_providers_online = 0 THEN 'high' ELSE 'medium' END,
      'title',         CASE WHEN v_providers_online = 0 THEN 'No Providers Online' ELSE 'Low Provider Availability' END,
      'metric',        'provider_availability',
      'message',       format('%s provider(s) online with %s open service request(s)', v_providers_online, v_open_requests),
      'current_value', v_providers_online,
      'threshold',     2,
      'window_minutes', null,
      'affected_count', v_open_requests,
      'auto_action',   null,
      'detected_at',   v_now
    );
  END IF;

  -- Provider shortage (demand > 2x supply, only when supply >= 2)
  IF v_providers_online >= 2 AND v_open_requests > v_providers_online * 2 THEN
    v_alerts := v_alerts || jsonb_build_object(
      'id',            'provider_shortage',
      'severity',      CASE WHEN v_open_requests > v_providers_online * 4 THEN 'high' ELSE 'medium' END,
      'title',         'Provider Shortage',
      'metric',        'provider_availability',
      'message',       format('Demand exceeds supply: %s open requests vs %s providers (ratio %sx)', v_open_requests, v_providers_online, round(v_open_requests::numeric / v_providers_online, 1)),
      'current_value', v_providers_online,
      'threshold',     v_open_requests,
      'window_minutes', null,
      'affected_count', v_open_requests - v_providers_online,
      'auto_action',   null,
      'detected_at',   v_now
    );
  END IF;

  -- ── 6. Recovery activity (last 24h) ─────────────────
  SELECT coalesce(jsonb_agg(row_to_json(sub)::jsonb ORDER BY sub.ts DESC), '[]'::jsonb)
  INTO v_recovery
  FROM (
    SELECT
      event_name,
      coalesce(payload->>'request_id', '') AS request_id,
      coalesce(payload->>'reason_code', '') AS reason_code,
      CASE
        WHEN payload->>'retry_count' ~ '^\d+$'
        THEN (payload->>'retry_count')::int
        ELSE null
      END AS retry_count,
      created_at AS ts
    FROM analytics_events
    WHERE created_at >= v_24h
      AND event_name IN (
        'recovery_attempt_started',
        'recovery_attempt_succeeded',
        'recovery_attempt_failed'
      )
    ORDER BY created_at DESC
    LIMIT 50
  ) sub;

  -- ── 7. Alert history (last 24h, hourly buckets) ─────
  SELECT coalesce(jsonb_agg(row_to_json(sub)::jsonb ORDER BY sub.hour DESC), '[]'::jsonb)
  INTO v_history
  FROM (
    SELECT
      date_trunc('hour', created_at)::text AS hour,
      count(*) FILTER (WHERE event_name = 'payment_failed')::int              AS payment_failures,
      count(*) FILTER (WHERE event_name = 'payout_failed')::int               AS payout_failures,
      count(*) FILTER (WHERE event_name = 'service_request_cancelled')::int   AS cancellations,
      count(*) FILTER (WHERE event_name = 'service_request_submitted')::int   AS submissions,
      count(*) FILTER (WHERE event_name = 'provider_matched')::int            AS matches
    FROM analytics_events
    WHERE created_at >= v_24h
      AND event_name IN (
        'payment_failed', 'payout_failed', 'service_request_cancelled',
        'service_request_submitted', 'provider_matched'
      )
    GROUP BY date_trunc('hour', created_at)
    HAVING count(*) > 0
  ) sub;

  -- ── Return ──────────────────────────────────────────
  RETURN jsonb_build_object(
    'alerts',   v_alerts,
    'recovery', v_recovery,
    'history',  v_history,
    'snapshot', jsonb_build_object(
      'short_window',    p_short_window,
      'long_window',     p_long_window,
      'submitted',       v_submitted,
      'matched',         v_matched,
      'cancelled',       v_cancelled,
      'pay_captured',    v_pay_captured,
      'pay_failed',      v_pay_failed,
      'payout_failed',   v_payout_failed,
      'stuck_total',     v_stuck_total,
      'stuck_pay',       v_stuck_pay,
      'stuck_open',      v_stuck_open,
      'stuck_accepted',  v_stuck_accepted,
      'providers_online', v_providers_online,
      'open_requests',   v_open_requests,
      'checked_at',      v_now
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION admin_alerts_check(int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_alerts_check(int, int) TO authenticated;
GRANT EXECUTE ON FUNCTION admin_alerts_check(int, int) TO service_role;
