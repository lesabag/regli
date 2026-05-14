-- Rebuild the one-active-request rule so only truly live client requests count.
--
-- Excludes terminal or stale rows such as:
-- - cancelled / completed requests
-- - exhausted / cancelled smart dispatch states
-- - failed / refunded payment states
-- - scheduled future rows that have not actually entered dispatch yet
-- - legacy dispatched rows with no real provider assignment

DROP INDEX IF EXISTS public.idx_walk_requests_one_active_per_client;

DO $$
DECLARE
  active_predicate TEXT;
  hidden_predicate TEXT := '';
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'walk_requests'
      AND column_name = 'hidden'
  ) THEN
    hidden_predicate := hidden_predicate || ' AND COALESCE(hidden, false) = false';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'walk_requests'
      AND column_name = 'is_hidden'
  ) THEN
    hidden_predicate := hidden_predicate || ' AND COALESCE(is_hidden, false) = false';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'walk_requests'
      AND column_name = 'hidden_by_client'
  ) THEN
    hidden_predicate := hidden_predicate || ' AND COALESCE(hidden_by_client, false) = false';
  END IF;

  active_predicate := $predicate$
    client_id IS NOT NULL
    AND status IN ('awaiting_payment', 'open', 'accepted')
    AND (
      booking_timing IS NULL
      OR booking_timing = 'asap'
      OR (
        dispatch_state = 'dispatched'
        AND (
          walker_id IS NOT NULL
          OR selected_walker_id IS NOT NULL
          OR smart_dispatch_state = 'assigned'
        )
      )
    )
    AND (dispatch_state IS NULL OR dispatch_state NOT IN ('cancelled', 'expired'))
    AND (smart_dispatch_state IS NULL OR smart_dispatch_state NOT IN ('cancelled', 'exhausted'))
    AND (payment_status IS NULL OR payment_status NOT IN ('failed', 'refunded'))
    AND (
      status <> 'accepted'
      OR walker_id IS NOT NULL
      OR selected_walker_id IS NOT NULL
      OR smart_dispatch_state = 'assigned'
    )
  $predicate$ || hidden_predicate;

  EXECUTE format(
    $sql$
      WITH ranked_active AS (
        SELECT
          id,
          row_number() OVER (
            PARTITION BY client_id
            ORDER BY created_at DESC NULLS LAST, id DESC
          ) AS rn
        FROM public.walk_requests
        WHERE %1$s
      )
      UPDATE public.walk_requests wr
      SET
        status = 'cancelled',
        dispatch_state = 'cancelled',
        smart_dispatch_state = 'cancelled',
        walker_id = NULL,
        selected_walker_id = NULL,
        walker_lat = NULL,
        walker_lng = NULL,
        last_location_update = NULL
      FROM ranked_active ra
      WHERE wr.id = ra.id
        AND ra.rn > 1
    $sql$,
    active_predicate
  );

  EXECUTE format(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_walk_requests_one_active_per_client ON public.walk_requests (client_id) WHERE %s',
    active_predicate
  );
END $$;
