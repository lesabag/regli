-- ============================================================================
-- Scheduled Dispatch Flow Fix
--
-- Keeps scheduled walk requests open until dispatch starts, maps each dispatch
-- attempt to exactly one walker candidate, and exposes active offers to walkers.
-- ============================================================================

-- A walker receives the pending attempt whose attempt_no matches their candidate
-- rank. The frontend already reads this view from useWalkerFlow/useWalkerDispatch.
CREATE OR REPLACE VIEW public.active_dispatch_offers AS
SELECT
  da.id,
  da.request_id,
  dc.walker_id,
  dc.rank,
  dc.score,
  da.created_at AS offered_at,
  da.expires_at,
  da.attempt_no,
  wr.status AS request_status,
  COALESCE(wr.dispatch_state::text, 'queued') AS dispatch_state,
  da.status
FROM public.dispatch_attempts da
JOIN public.dispatch_candidates dc
  ON dc.request_id = da.request_id
 AND dc.rank = da.attempt_no
JOIN public.walk_requests wr
  ON wr.id = da.request_id
WHERE da.status = 'pending'
  AND da.expires_at > now()
  AND wr.status = 'open'
  AND wr.walker_id IS NULL;

GRANT SELECT ON public.active_dispatch_offers TO authenticated;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.dispatch_attempts;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.dispatch_candidates;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

-- ============================================================================
-- RPC: accept_dispatch_attempt
-- ============================================================================
CREATE OR REPLACE FUNCTION public.accept_dispatch_attempt(
  p_request_id UUID,
  p_attempt_id UUID,
  p_walker_id UUID
)
RETURNS TABLE(ok BOOLEAN, message TEXT) AS $$
DECLARE
  v_request public.walk_requests%ROWTYPE;
  v_attempt public.dispatch_attempts%ROWTYPE;
  v_candidate public.dispatch_candidates%ROWTYPE;
BEGIN
  SELECT * INTO v_request
  FROM public.walk_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF v_request.id IS NULL THEN
    RETURN QUERY SELECT FALSE, 'Request not found';
    RETURN;
  END IF;

  SELECT * INTO v_attempt
  FROM public.dispatch_attempts
  WHERE id = p_attempt_id
    AND request_id = p_request_id
  FOR UPDATE;

  IF v_attempt.id IS NULL THEN
    RETURN QUERY SELECT FALSE, 'Attempt not found';
    RETURN;
  END IF;

  IF v_attempt.status <> 'pending' THEN
    RETURN QUERY SELECT FALSE, 'Attempt is not pending';
    RETURN;
  END IF;

  IF v_attempt.expires_at <= now() THEN
    UPDATE public.dispatch_attempts
    SET status = 'expired',
        responded_at = now(),
        response_note = 'expired before accept',
        updated_at = now()
    WHERE id = p_attempt_id;

    RETURN QUERY SELECT FALSE, 'Attempt expired';
    RETURN;
  END IF;

  IF v_request.status <> 'open' THEN
    RETURN QUERY SELECT FALSE, 'Request is not open';
    RETURN;
  END IF;

  IF v_request.walker_id IS NOT NULL THEN
    RETURN QUERY SELECT FALSE, 'Request already assigned';
    RETURN;
  END IF;

  SELECT * INTO v_candidate
  FROM public.dispatch_candidates
  WHERE request_id = p_request_id
    AND walker_id = p_walker_id
    AND rank = v_attempt.attempt_no;

  IF v_candidate.id IS NULL THEN
    RETURN QUERY SELECT FALSE, 'Walker is not assigned to this attempt';
    RETURN;
  END IF;

  UPDATE public.dispatch_attempts
  SET status = 'accepted',
      accepted_by_walker_id = p_walker_id,
      responded_at = now(),
      updated_at = now()
  WHERE id = p_attempt_id;

  UPDATE public.dispatch_attempts
  SET status = 'cancelled',
      responded_at = now(),
      response_note = 'cancelled due to acceptance by another walker',
      updated_at = now()
  WHERE request_id = p_request_id
    AND id <> p_attempt_id
    AND status = 'pending';

  UPDATE public.walk_requests
  SET walker_id = p_walker_id,
      selected_walker_id = p_walker_id,
      status = 'accepted',
      dispatch_state = 'dispatched',
      smart_dispatch_state = 'assigned',
      smart_assigned_attempt_id = p_attempt_id,
      smart_dispatch_completed_at = now(),
      smart_dispatch_last_error = NULL,
      updated_at = now()
  WHERE id = p_request_id;

  PERFORM public.log_dispatch_event(
    p_request_id,
    p_attempt_id,
    'dispatch_accepted',
    jsonb_build_object('walker_id', p_walker_id)
  );

  RETURN QUERY SELECT TRUE, 'Accepted successfully';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- RPC: advance_dispatch_request
-- ============================================================================
CREATE OR REPLACE FUNCTION public.advance_dispatch_request(
  p_request_id UUID,
  p_timeout_seconds INTEGER DEFAULT 12
)
RETURNS TABLE(ok BOOLEAN, message TEXT, attempt_id UUID, attempt_no INTEGER) AS $$
DECLARE
  v_request public.walk_requests%ROWTYPE;
  v_last_attempt_no INTEGER;
  v_new_attempt_id UUID;
  v_expires_at TIMESTAMPTZ;
  v_candidate_count INTEGER;
  v_next_rank INTEGER;
  v_timeout_seconds INTEGER;
BEGIN
  v_timeout_seconds := GREATEST(3, LEAST(60, COALESCE(p_timeout_seconds, 12)));

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

  SELECT COALESCE(MAX(attempt_no), 0)
  INTO v_last_attempt_no
  FROM public.dispatch_attempts
  WHERE request_id = p_request_id;

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
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- RPC: decline_dispatch_attempt
-- ============================================================================
CREATE OR REPLACE FUNCTION public.decline_dispatch_attempt(
  p_request_id UUID,
  p_attempt_id UUID,
  p_walker_id UUID,
  p_timeout_seconds INTEGER DEFAULT 12
)
RETURNS TABLE(ok BOOLEAN, message TEXT, next_attempt_id UUID, next_attempt_no INTEGER) AS $$
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.accept_dispatch_attempt(UUID, UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.advance_dispatch_request(UUID, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.decline_dispatch_attempt(UUID, UUID, UUID, INTEGER) TO authenticated;
