CREATE OR REPLACE FUNCTION public.advance_dispatch_request(p_request_id uuid, p_timeout_seconds integer DEFAULT 20)
RETURNS TABLE(ok boolean, message text, attempt_id uuid, attempt_no integer)
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
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

  SELECT *
  INTO v_active_attempt
  FROM public.dispatch_attempts
  WHERE request_id = p_request_id
    AND status = 'pending'
    AND expires_at > now()
  ORDER BY attempt_no DESC
  LIMIT 1;

  IF v_active_attempt.id IS NOT NULL THEN
    RETURN QUERY SELECT TRUE, 'Pending attempt still active', v_active_attempt.id, v_active_attempt.attempt_no;
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

    RETURN QUERY SELECT FALSE, 'No candidates available', NULL::UUID, NULL::INTEGER;
    RETURN;
  END IF;

  SELECT *
  INTO v_next_candidate
  FROM public.dispatch_candidates dc
  WHERE dc.request_id = p_request_id
    AND dc.rank > COALESCE(v_request.smart_dispatch_cursor, 0)
  ORDER BY dc.rank ASC, dc.score DESC, dc.walker_id ASC
  LIMIT 1;

  IF v_next_candidate.id IS NULL THEN
    UPDATE public.walk_requests
    SET smart_dispatch_state = 'exhausted',
        smart_dispatch_completed_at = now(),
        smart_dispatch_last_error = 'All candidates exhausted',
        updated_at = now()
    WHERE id = p_request_id;

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

  RETURN QUERY SELECT TRUE, 'Attempt created', v_new_attempt_id, v_next_candidate.rank;
END;
$function$;
