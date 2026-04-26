-- Allow a walker to read the walk_request row for a live dispatch offer.
-- The walker app first reads active_dispatch_offers, then fetches walk_requests
-- by request_id. Scheduled jobs can have a live dispatch attempt before their
-- generic open-job payment visibility policy matches, so the second read must
-- be authorized by the offer itself.

DROP POLICY IF EXISTS "wr_walker_dispatch_offer_select" ON public.walk_requests;

GRANT SELECT ON public.dispatch_attempts TO authenticated;
GRANT SELECT ON public.dispatch_candidates TO authenticated;

CREATE POLICY "wr_walker_dispatch_offer_select" ON public.walk_requests
  FOR SELECT USING (
    EXISTS (
      SELECT 1
      FROM public.dispatch_attempts da
      JOIN public.dispatch_candidates dc
        ON dc.request_id = da.request_id
       AND dc.rank = da.attempt_no
      WHERE da.request_id = walk_requests.id
        AND da.status = 'pending'
        AND da.expires_at > now()
        AND dc.walker_id = auth.uid()
    )
  );
