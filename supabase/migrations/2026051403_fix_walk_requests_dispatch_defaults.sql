-- Ensure new requests start in a pre-dispatch state.
-- Some environments have shown walk_requests rows returning with
-- dispatch_state='dispatched' immediately on insert, before any candidate or
-- attempt exists. New requests must remain queued until the dispatch engine
-- creates live rows.
--
-- Repo inspection did not find a tracked walk_requests insert trigger that
-- should do this, which suggests a legacy/stray DB trigger or rule may still
-- exist in some environments. This migration both corrects defaults and
-- enforces the invariant at write time:
--   dispatch_state may be 'dispatched' only when a walker is assigned, or
--   real dispatch_candidates / pending dispatch_attempts already exist.

ALTER TABLE public.walk_requests
  ALTER COLUMN dispatch_state SET DEFAULT 'queued';

ALTER TABLE public.walk_requests
  ALTER COLUMN smart_dispatch_state SET DEFAULT 'idle';

CREATE OR REPLACE FUNCTION public.enforce_walk_request_pre_dispatch_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_has_candidates boolean := false;
  v_has_pending_attempts boolean := false;
BEGIN
  IF NEW.dispatch_state IS DISTINCT FROM 'dispatched' THEN
    RETURN NEW;
  END IF;

  IF NEW.walker_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.id IS NOT NULL THEN
    SELECT
      EXISTS (
        SELECT 1
        FROM public.dispatch_candidates dc
        WHERE dc.request_id = NEW.id
      ),
      EXISTS (
        SELECT 1
        FROM public.dispatch_attempts da
        WHERE da.request_id = NEW.id
          AND da.status = 'pending'
      )
    INTO v_has_candidates, v_has_pending_attempts;
  END IF;

  IF NOT v_has_candidates AND NOT v_has_pending_attempts THEN
    NEW.dispatch_state := 'queued';

    IF NEW.smart_dispatch_state IS NULL
      OR NEW.smart_dispatch_state = 'dispatching'
      OR NEW.smart_dispatch_state = 'idle'
    THEN
      NEW.smart_dispatch_state := 'idle';
    END IF;

    NEW.smart_dispatch_cursor := 0;
    NEW.smart_dispatch_started_at := NULL;
    NEW.smart_dispatch_completed_at := NULL;
    NEW.smart_dispatch_expires_at := NULL;
    NEW.smart_assigned_attempt_id := NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zzz_enforce_walk_request_pre_dispatch_state ON public.walk_requests;

CREATE TRIGGER zzz_enforce_walk_request_pre_dispatch_state
BEFORE INSERT OR UPDATE OF dispatch_state, smart_dispatch_state, walker_id
ON public.walk_requests
FOR EACH ROW
EXECUTE FUNCTION public.enforce_walk_request_pre_dispatch_state();
