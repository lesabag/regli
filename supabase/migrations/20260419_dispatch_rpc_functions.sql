-- ============================================================================
-- Dispatch RPC Functions Migration
-- Defines critical RPC functions for smart dispatch workflow
-- ============================================================================

-- Table: dispatch_attempts (if not exists)
CREATE TABLE IF NOT EXISTS public.dispatch_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES public.walk_requests(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending, accepted, expired, cancelled
  offered_to_count INTEGER NOT NULL DEFAULT 0,
  attempts_made INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_by_walker_id UUID,
  responded_at TIMESTAMPTZ,
  response_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(request_id, attempt_no)
);

-- Table: dispatch_candidates (if not exists)
CREATE TABLE IF NOT EXISTS public.dispatch_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES public.walk_requests(id) ON DELETE CASCADE,
  walker_id UUID NOT NULL,
  rank INTEGER NOT NULL,
  score NUMERIC NOT NULL,
  meta JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_dispatch_attempts_request_id ON public.dispatch_attempts(request_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_attempts_status ON public.dispatch_attempts(status);
CREATE INDEX IF NOT EXISTS idx_dispatch_attempts_expires_at ON public.dispatch_attempts(expires_at);
CREATE INDEX IF NOT EXISTS idx_dispatch_candidates_request_id ON public.dispatch_candidates(request_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_candidates_walker_id ON public.dispatch_candidates(walker_id);

-- ============================================================================
-- RPC: accept_dispatch_attempt
-- Called when walker accepts an offer
-- ============================================================================
CREATE OR REPLACE FUNCTION public.accept_dispatch_attempt(
  p_request_id UUID,
  p_attempt_id UUID,
  p_walker_id UUID
)
RETURNS TABLE(ok BOOLEAN, message TEXT) AS $$
DECLARE
  v_request walk_requests;
  v_attempt dispatch_attempts;
BEGIN
  -- Fetch request
  SELECT * INTO v_request FROM walk_requests WHERE id = p_request_id;
  IF v_request IS NULL THEN
    RETURN QUERY SELECT FALSE, 'Request not found';
    RETURN;
  END IF;

  -- Fetch attempt
  SELECT * INTO v_attempt FROM dispatch_attempts WHERE id = p_attempt_id;
  IF v_attempt IS NULL THEN
    RETURN QUERY SELECT FALSE, 'Attempt not found';
    RETURN;
  END IF;

  -- Check if attempt is still pending
  IF v_attempt.status != 'pending' THEN
    RETURN QUERY SELECT FALSE, 'Attempt is not pending';
    RETURN;
  END IF;

  -- Check if request is still open
  IF v_request.status != 'open' THEN
    RETURN QUERY SELECT FALSE, 'Request is not open';
    RETURN;
  END IF;

  -- Check if walker is in candidates for this attempt
  IF NOT EXISTS (
    SELECT 1 FROM dispatch_candidates
    WHERE request_id = p_request_id AND walker_id = p_walker_id
  ) THEN
    RETURN QUERY SELECT FALSE, 'Walker is not a candidate';
    RETURN;
  END IF;

  -- Update attempt
  UPDATE dispatch_attempts SET
    status = 'accepted',
    accepted_by_walker_id = p_walker_id,
    responded_at = NOW()
  WHERE id = p_attempt_id;

  -- Update request
  UPDATE walk_requests SET
    walker_id = p_walker_id,
    status = 'accepted',
    updated_at = NOW()
  WHERE id = p_request_id;

  -- Cancel other pending attempts for this request
  UPDATE dispatch_attempts SET
    status = 'cancelled',
    responded_at = NOW(),
    response_note = 'cancelled due to acceptance by another walker'
  WHERE request_id = p_request_id AND id != p_attempt_id AND status = 'pending';

  RETURN QUERY SELECT TRUE, 'Accepted successfully';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- RPC: advance_dispatch_request
-- Creates next dispatch attempt or marks as exhausted
-- ============================================================================
CREATE OR REPLACE FUNCTION public.advance_dispatch_request(
  p_request_id UUID,
  p_timeout_seconds INTEGER DEFAULT 12
)
RETURNS TABLE(ok BOOLEAN, message TEXT, attempt_id UUID, attempt_no INTEGER) AS $$
DECLARE
  v_request walk_requests;
  v_last_attempt_no INTEGER;
  v_new_attempt_id UUID;
  v_expires_at TIMESTAMPTZ;
  v_candidate_count INTEGER;
  v_next_rank INTEGER;
BEGIN
  -- Fetch request
  SELECT * INTO v_request FROM walk_requests WHERE id = p_request_id;
  IF v_request IS NULL THEN
    RETURN QUERY SELECT FALSE, 'Request not found', NULL::UUID, NULL::INTEGER;
    RETURN;
  END IF;

  -- If request is no longer open, can't advance
  IF v_request.status NOT IN ('open', 'awaiting_payment') THEN
    RETURN QUERY SELECT FALSE, 'Request is not open', NULL::UUID, NULL::INTEGER;
    RETURN;
  END IF;

  -- Get last attempt number
  SELECT COALESCE(MAX(attempt_no), 0) INTO v_last_attempt_no
  FROM dispatch_attempts WHERE request_id = p_request_id;

  v_next_rank := v_last_attempt_no + 1;

  -- Count how many candidates we have
  SELECT COUNT(*) INTO v_candidate_count
  FROM dispatch_candidates WHERE request_id = p_request_id;

  -- If no more candidates, mark as exhausted
  IF v_next_rank > v_candidate_count THEN
    UPDATE walk_requests SET
      smart_dispatch_state = 'exhausted',
      updated_at = NOW()
    WHERE id = p_request_id;
    RETURN QUERY SELECT FALSE, 'All candidates exhausted', NULL::UUID, NULL::INTEGER;
    RETURN;
  END IF;

  -- Create new attempt
  v_expires_at := NOW() + (p_timeout_seconds || ' seconds')::INTERVAL;

  INSERT INTO dispatch_attempts (
    request_id, attempt_no, status, expires_at, created_at, updated_at
  ) VALUES (
    p_request_id, v_next_rank, 'pending', v_expires_at, NOW(), NOW()
  ) RETURNING id INTO v_new_attempt_id;

  -- Update request state
  UPDATE walk_requests SET
    smart_dispatch_state = 'dispatching',
    updated_at = NOW()
  WHERE id = p_request_id;

  RETURN QUERY SELECT TRUE, 'Attempt created', v_new_attempt_id, v_next_rank;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- RPC: log_dispatch_event
-- Logs dispatch events for debugging
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.dispatch_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES public.walk_requests(id) ON DELETE CASCADE,
  attempt_id UUID REFERENCES public.dispatch_attempts(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  payload JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dispatch_events_request_id ON public.dispatch_events(request_id);

CREATE OR REPLACE FUNCTION public.log_dispatch_event(
  p_request_id UUID,
  p_attempt_id UUID DEFAULT NULL,
  p_event_type TEXT DEFAULT 'unknown',
  p_payload JSONB DEFAULT '{}'
)
RETURNS VOID AS $$
BEGIN
  INSERT INTO dispatch_events (request_id, attempt_id, event_type, payload)
  VALUES (p_request_id, p_attempt_id, p_event_type, COALESCE(p_payload, '{}'));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION public.accept_dispatch_attempt(UUID, UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.advance_dispatch_request(UUID, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.log_dispatch_event(UUID, UUID, TEXT, JSONB) TO authenticated;

