CREATE OR REPLACE FUNCTION public.advance_dispatch_request(
  p_request_id UUID,
  p_timeout_seconds INTEGER DEFAULT 20
)
RETURNS TABLE(ok BOOLEAN, message TEXT, attempt_id UUID, attempt_no INTEGER) AS $dispatch_advance$
DECLARE
  v_request public.walk_requests%ROWTYPE;
  v_active_attempt public.dispatch_attempts%ROWTYPE;
  v_new_attempt_id UUID;
  v_expires_at TIMESTAMPTZ;
  v_candidate_count INTEGER;
  v_last_attempt_no INTEGER;
  v_timeout_seconds INTEGER;
  v_next_candidate public.dispatch_candidates%ROWTYPE;
BEGIN
  v_timeout_seconds := GREATEST(3, LEAST(60, COALESCE(p_timeout_seconds, 20)));

  SELECT * INTO v_request
  FROM public.walk_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF v_request.id IS NULL THEN
    RETURN QUERY SELECT FALSE, 'Request not found', NULL::UUID, NULL::INTEGER;
    RETURN;
  END IF;

  IF v_request.status <> 'open' THEN
    PERFORM public.log_dispatch_event(
      p_request_id,
      NULL,
      'dispatch_advance_skipped',
      jsonb_build_object(
        'reason', 'request_not_open',
        'request_status', v_request.status
      )
    );
    RETURN QUERY SELECT FALSE, 'Request is not open', NULL::UUID, NULL::INTEGER;
    RETURN;
  END IF;

  IF v_request.walker_id IS NOT NULL THEN
    UPDATE public.walk_requests
    SET smart_dispatch_state = 'assigned',
        updated_at = now()
    WHERE id = p_request_id;

    PERFORM public.log_dispatch_event(
      p_request_id,
      NULL,
      'dispatch_advance_skipped',
      jsonb_build_object(
        'reason', 'request_already_assigned',
        'walker_id', v_request.walker_id
      )
    );

    RETURN QUERY SELECT FALSE, 'Request already assigned', NULL::UUID, NULL::INTEGER;
    RETURN;
  END IF;

  UPDATE public.dispatch_attempts
  SET status = 'expired',
      responded_at = now(),
      response_note = 'expired by dispatcher advance',
      updated_at = now()
  WHERE request_id = p_request_id
    AND status = 'pending'
    AND expires_at <= now();

  SELECT *
  INTO v_active_attempt
  FROM public.dispatch_attempts
  WHERE request_id = p_request_id
    AND status = 'pending'
    AND expires_at > now()
  ORDER BY public.dispatch_attempts.attempt_no DESC
  LIMIT 1;

  IF v_active_attempt.id IS NOT NULL THEN
    PERFORM public.log_dispatch_event(
      p_request_id,
      v_active_attempt.id,
      'dispatch_advance_pending_still_active',
      jsonb_build_object(
        'current_attempt_rank', v_active_attempt.attempt_no,
        'reason', 'pending_attempt_still_active'
      )
    );

    RETURN QUERY
    SELECT TRUE, 'Pending attempt still active', v_active_attempt.id, v_active_attempt.attempt_no;
    RETURN;
  END IF;

  SELECT COALESCE(MAX(da.attempt_no), 0)
  INTO v_last_attempt_no
  FROM public.dispatch_attempts da
  WHERE da.request_id = p_request_id;

  SELECT COUNT(*)
  INTO v_candidate_count
  FROM public.dispatch_candidates dc
  WHERE dc.request_id = p_request_id;

  IF v_candidate_count = 0 THEN
    UPDATE public.walk_requests
    SET smart_dispatch_state = 'idle',
        smart_dispatch_last_error = 'No dispatch candidates',
        updated_at = now()
    WHERE id = p_request_id;

    PERFORM public.log_dispatch_event(
      p_request_id,
      NULL,
      'dispatch_advance_no_candidates',
      jsonb_build_object(
        'candidate_count', 0,
        'current_attempt_rank', v_last_attempt_no,
        'reason', 'no_dispatch_candidates'
      )
    );

    RETURN QUERY SELECT FALSE, 'No candidates available', NULL::UUID, NULL::INTEGER;
    RETURN;
  END IF;

  SELECT *
  INTO v_next_candidate
  FROM public.dispatch_candidates dc
  WHERE dc.request_id = p_request_id
    AND dc.rank > v_last_attempt_no
    AND NOT EXISTS (
      SELECT 1
      FROM public.dispatch_attempts da
      WHERE da.request_id = p_request_id
        AND da.attempt_no = dc.rank
    )
  ORDER BY dc.rank ASC, dc.score DESC, dc.walker_id ASC
  LIMIT 1;

  IF v_next_candidate.id IS NULL THEN
    UPDATE public.walk_requests
    SET smart_dispatch_state = 'exhausted',
        smart_dispatch_completed_at = now(),
        smart_dispatch_last_error = 'All candidates exhausted',
        updated_at = now()
    WHERE id = p_request_id;

    PERFORM public.log_dispatch_event(
      p_request_id,
      NULL,
      'dispatch_exhausted',
      jsonb_build_object(
        'candidate_count', v_candidate_count,
        'current_attempt_rank', v_last_attempt_no,
        'next_candidate_rank', NULL,
        'next_walker_id', NULL,
        'reason', 'no_next_candidate'
      )
    );

    RETURN QUERY SELECT FALSE, 'All candidates exhausted', NULL::UUID, NULL::INTEGER;
    RETURN;
  END IF;

  v_expires_at := now() + (v_timeout_seconds || ' seconds')::INTERVAL;

  INSERT INTO public.dispatch_attempts (
    request_id,
    walker_id,
    rank,
    attempt_no,
    status,
    expires_at,
    dispatch_version,
    created_at,
    updated_at
  )
  VALUES (
    p_request_id,
    v_next_candidate.walker_id,
    v_next_candidate.rank,
    v_next_candidate.rank,
    'pending',
    v_expires_at,
    1,
    now(),
    now()
  )
  RETURNING id INTO v_new_attempt_id;

  UPDATE public.walk_requests
  SET smart_dispatch_state = 'dispatching',
      smart_dispatch_cursor = v_next_candidate.rank,
      smart_dispatch_expires_at = v_expires_at,
      smart_dispatch_last_error = NULL,
      updated_at = now()
  WHERE id = p_request_id;

  PERFORM public.log_dispatch_event(
    p_request_id,
    v_new_attempt_id,
    'dispatch_attempt_created',
    jsonb_build_object(
      'current_attempt_rank', v_last_attempt_no,
      'next_candidate_rank', v_next_candidate.rank,
      'next_walker_id', v_next_candidate.walker_id,
      'dispatch_version', 1,
      'score', v_next_candidate.score,
      'expires_at', v_expires_at
    )
  );

  RETURN QUERY SELECT TRUE, 'Attempt created', v_new_attempt_id, v_next_candidate.rank;
END;
$dispatch_advance$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.decline_dispatch_attempt(
  p_request_id UUID,
  p_attempt_id UUID,
  p_walker_id UUID,
  p_timeout_seconds INTEGER DEFAULT 20
)
RETURNS TABLE(ok BOOLEAN, message TEXT, next_attempt_id UUID, next_attempt_no INTEGER) AS $dispatch_decline$
DECLARE
  v_attempt public.dispatch_attempts%ROWTYPE;
  v_candidate public.dispatch_candidates%ROWTYPE;
  v_next RECORD;
BEGIN
  SELECT * INTO v_attempt
  FROM public.dispatch_attempts
  WHERE id = p_attempt_id
    AND request_id = p_request_id
  FOR UPDATE;

  IF v_attempt.id IS NULL THEN
    RETURN QUERY SELECT FALSE, 'Attempt not found', NULL::UUID, NULL::INTEGER;
    RETURN;
  END IF;

  SELECT * INTO v_candidate
  FROM public.dispatch_candidates
  WHERE request_id = p_request_id
    AND walker_id = p_walker_id
    AND rank = v_attempt.attempt_no;

  IF v_candidate.id IS NULL THEN
    PERFORM public.log_dispatch_event(
      p_request_id,
      p_attempt_id,
      'dispatch_decline_rejected',
      jsonb_build_object(
        'current_attempt_rank', v_attempt.attempt_no,
        'walker_id', p_walker_id,
        'reason', 'walker_not_assigned_to_attempt'
      )
    );

    RETURN QUERY SELECT FALSE, 'Walker is not assigned to this attempt', NULL::UUID, NULL::INTEGER;
    RETURN;
  END IF;

  IF v_attempt.status = 'pending' THEN
    UPDATE public.dispatch_attempts
    SET status = 'rejected',
        responded_at = now(),
        response_note = 'declined by walker',
        updated_at = now()
    WHERE id = p_attempt_id;

    PERFORM public.log_dispatch_event(
      p_request_id,
      p_attempt_id,
      'dispatch_declined',
      jsonb_build_object(
        'walker_id', p_walker_id,
        'current_attempt_rank', v_attempt.attempt_no
      )
    );
  ELSE
    PERFORM public.log_dispatch_event(
      p_request_id,
      p_attempt_id,
      'dispatch_decline_ignored',
      jsonb_build_object(
        'walker_id', p_walker_id,
        'current_attempt_rank', v_attempt.attempt_no,
        'attempt_status', v_attempt.status
      )
    );
  END IF;

  SELECT *
  INTO v_next
  FROM public.advance_dispatch_request(p_request_id, p_timeout_seconds)
  LIMIT 1;

  PERFORM public.log_dispatch_event(
    p_request_id,
    p_attempt_id,
    'dispatch_decline_advanced',
    jsonb_build_object(
      'current_attempt_rank', v_attempt.attempt_no,
      'next_candidate_rank', v_next.attempt_no,
      'next_attempt_id', v_next.attempt_id,
      'message', v_next.message,
      'ok', v_next.ok
    )
  );

  RETURN QUERY
  SELECT
    COALESCE(v_next.ok, TRUE),
    COALESCE(v_next.message, 'Declined'),
    v_next.attempt_id,
    v_next.attempt_no;
END;
$dispatch_decline$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.advance_dispatch_request(UUID, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.decline_dispatch_attempt(UUID, UUID, UUID, INTEGER) TO authenticated;
