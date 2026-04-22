-- Prevent failed or unauthorised payment requests from entering the live
-- dispatch/accept flow. Existing bad rows are made inactive first so the new
-- view/RPC definitions can be applied safely.

UPDATE public.walk_requests
SET
  status = 'cancelled',
  dispatch_state = 'cancelled',
  smart_dispatch_state = 'cancelled',
  smart_dispatch_last_error = 'payment authorization missing'
WHERE status IN ('awaiting_payment', 'open', 'accepted')
  AND (
    payment_status IS DISTINCT FROM 'authorized'
    OR stripe_payment_intent_id IS NULL
  );

DROP VIEW IF EXISTS public.active_dispatch_offers;

CREATE VIEW public.active_dispatch_offers AS
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
  da.status,
  wr.client_id,
  wr.selected_walker_id,
  wr.dog_name,
  wr.location,
  wr.address,
  wr.notes,
  wr.created_at AS request_created_at,
  wr.price,
  wr.platform_fee,
  wr.walker_earnings,
  wr.payment_status,
  wr.paid_at,
  wr.stripe_payment_intent_id,
  wr.booking_timing,
  wr.scheduled_for,
  wr.smart_dispatch_state,
  client.full_name AS client_full_name,
  client.email AS client_email
FROM public.dispatch_attempts da
JOIN public.dispatch_candidates dc
  ON dc.request_id = da.request_id
 AND dc.rank = da.attempt_no
JOIN public.walk_requests wr
  ON wr.id = da.request_id
LEFT JOIN public.profiles client
  ON client.id = wr.client_id
WHERE da.status = 'pending'
  AND da.expires_at > now()
  AND wr.status = 'open'
  AND wr.payment_status = 'authorized'
  AND wr.stripe_payment_intent_id IS NOT NULL
  AND wr.walker_id IS NULL;

GRANT SELECT ON public.active_dispatch_offers TO authenticated;

CREATE OR REPLACE FUNCTION public.accept_dispatch_attempt(
  p_request_id UUID,
  p_attempt_id UUID,
  p_walker_id UUID
)
RETURNS TABLE(
  ok BOOLEAN,
  message TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_request RECORD;
  v_attempt RECORD;
BEGIN
  SELECT *
  INTO v_request
  FROM public.walk_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, 'Request not found';
    RETURN;
  END IF;

  IF v_request.status <> 'open' THEN
    RETURN QUERY SELECT FALSE, 'Request is no longer open';
    RETURN;
  END IF;

  IF v_request.payment_status <> 'authorized' OR v_request.stripe_payment_intent_id IS NULL THEN
    UPDATE public.walk_requests
    SET
      status = 'cancelled',
      dispatch_state = 'cancelled',
      smart_dispatch_state = 'cancelled',
      smart_dispatch_last_error = 'payment authorization missing'
    WHERE id = p_request_id
      AND status = 'open';

    RETURN QUERY SELECT FALSE, 'Payment authorization is required before accepting';
    RETURN;
  END IF;

  SELECT *
  INTO v_attempt
  FROM public.dispatch_attempts
  WHERE id = p_attempt_id
    AND request_id = p_request_id
    AND status = 'pending'
    AND expires_at > now()
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, 'Dispatch attempt is no longer available';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.dispatch_candidates
    WHERE request_id = p_request_id
      AND walker_id = p_walker_id
      AND rank = v_attempt.attempt_no
  ) THEN
    RETURN QUERY SELECT FALSE, 'Walker is not assigned to this attempt';
    RETURN;
  END IF;

  UPDATE public.walk_requests
  SET
    status = 'accepted',
    walker_id = p_walker_id,
    selected_walker_id = p_walker_id,
    smart_dispatch_state = 'assigned',
    smart_assigned_attempt_id = p_attempt_id,
    smart_dispatch_completed_at = now(),
    smart_dispatch_expires_at = null,
    smart_dispatch_last_error = null
  WHERE id = p_request_id;

  UPDATE public.dispatch_attempts
  SET
    status = 'accepted',
    accepted_by_walker_id = p_walker_id,
    responded_at = now()
  WHERE id = p_attempt_id;

  UPDATE public.dispatch_attempts
  SET
    status = 'cancelled',
    responded_at = now()
  WHERE request_id = p_request_id
    AND id <> p_attempt_id
    AND status = 'pending';

  PERFORM public.log_dispatch_event(
    p_request_id,
    p_attempt_id,
    'attempt_accepted',
    jsonb_build_object('walker_id', p_walker_id)
  );

  RETURN QUERY SELECT TRUE, 'Dispatch attempt accepted';
END;
$$;

GRANT EXECUTE ON FUNCTION public.accept_dispatch_attempt(UUID, UUID, UUID) TO authenticated;
