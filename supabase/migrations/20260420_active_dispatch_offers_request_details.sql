-- Expose the request fields the walker app needs directly on live dispatch
-- offers. The walker UI already proves visibility by reading this view; doing
-- a second RLS-gated walk_requests read can hide scheduled offers even when
-- candidates and attempts exist.

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
  AND wr.walker_id IS NULL;

GRANT SELECT ON public.active_dispatch_offers TO authenticated;
