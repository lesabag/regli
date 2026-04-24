CREATE OR REPLACE FUNCTION public.advance_dispatch_request(
  p_request_id UUID,
  p_timeout_seconds INTEGER DEFAULT 20
)
RETURNS TABLE(ok BOOLEAN, message TEXT, attempt_id UUID, attempt_no INTEGER) AS $dispatch_advance$
DECLARE
  v_request public.walk_requests%ROWTYPE;
  v_last_attempt_no INTEGER;
  v_new_attempt_id UUID;
  v_expires_at TIMESTAMPTZ;
  v_candidate_count INTEGER;
  v_next_rank INTEGER;
  v_timeout_seconds INTEGER;
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
    RETURN QUERY SELECT FALSE, 'Request is not open', NULL::UUID, NULL::INTEGER;
    RETURN;
  END IF;

  IF v_request.walker_id IS NOT NULL THEN
    UPDATE public.walk_requests
    SET smart_dispatch_state = 'assigned',
        updated_at = now()
    WHERE id = p_request_id;

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

  IF EXISTS (
    SELECT 1
    FROM public.dispatch_attempts
    WHERE request_id = p_request_id
      AND status = 'pending'
      AND expires_at > now()
  ) THEN
    RETURN QUERY
    SELECT TRUE, 'Pending attempt still active', da.id, da.attempt_no
    FROM public.dispatch_attempts da
    WHERE da.request_id = p_request_id
      AND da.status = 'pending'
      AND da.expires_at > now()
    ORDER BY da.attempt_no DESC
    LIMIT 1;
    RETURN;
  END IF;

  SELECT COALESCE(MAX(da.attempt_no), 0)
  INTO v_last_attempt_no
  FROM public.dispatch_attempts da
  WHERE da.request_id = p_request_id;

  v_next_rank := v_last_attempt_no + 1;

  SELECT COUNT(*)
  INTO v_candidate_count
  FROM public.dispatch_candidates
  WHERE request_id = p_request_id;

  IF v_candidate_count = 0 THEN
    UPDATE public.walk_requests
    SET smart_dispatch_state = 'idle',
        smart_dispatch_last_error = 'No dispatch candidates',
        updated_at = now()
    WHERE id = p_request_id;

    RETURN QUERY SELECT FALSE, 'No candidates available', NULL::UUID, NULL::INTEGER;
    RETURN;
  END IF;

  IF v_next_rank > v_candidate_count THEN
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
      jsonb_build_object('candidate_count', v_candidate_count)
    );

    RETURN QUERY SELECT FALSE, 'All candidates exhausted', NULL::UUID, NULL::INTEGER;
    RETURN;
  END IF;

  v_expires_at := now() + (v_timeout_seconds || ' seconds')::INTERVAL;

  INSERT INTO public.dispatch_attempts (
    request_id,
    attempt_no,
    status,
    expires_at,
    created_at,
    updated_at
  )
  VALUES (
    p_request_id,
    v_next_rank,
    'pending',
    v_expires_at,
    now(),
    now()
  )
  RETURNING id INTO v_new_attempt_id;

  UPDATE public.walk_requests
  SET smart_dispatch_state = 'dispatching',
      smart_dispatch_cursor = v_next_rank,
      smart_dispatch_expires_at = v_expires_at,
      smart_dispatch_last_error = NULL,
      updated_at = now()
  WHERE id = p_request_id;

  PERFORM public.log_dispatch_event(
    p_request_id,
    v_new_attempt_id,
    'dispatch_attempt_created',
    jsonb_build_object('attempt_no', v_next_rank, 'expires_at', v_expires_at)
  );

  RETURN QUERY SELECT TRUE, 'Attempt created', v_new_attempt_id, v_next_rank;
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
      jsonb_build_object('walker_id', p_walker_id)
    );
  END IF;

  SELECT *
  INTO v_next
  FROM public.advance_dispatch_request(p_request_id, p_timeout_seconds)
  LIMIT 1;

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
