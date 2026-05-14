-- Ensure new requests start in a pre-dispatch state.
-- Some environments have shown walk_requests rows returning with
-- dispatch_state='dispatched' immediately on insert, before any candidate or
-- attempt exists. New requests must remain queued until the dispatch engine
-- creates live rows.

ALTER TABLE public.walk_requests
  ALTER COLUMN dispatch_state SET DEFAULT 'queued';

ALTER TABLE public.walk_requests
  ALTER COLUMN smart_dispatch_state SET DEFAULT 'idle';
