-- Allow providers to receive realtime/select visibility for their own
-- dispatch attempts only. This keeps dispatch_attempts private per walker
-- while enabling realtime delivery for rows addressed to auth.uid().

ALTER TABLE public.dispatch_attempts ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'dispatch_attempts'
      AND policyname = 'dispatch_attempts_walker_select_own'
  ) THEN
    CREATE POLICY "dispatch_attempts_walker_select_own"
      ON public.dispatch_attempts
      FOR SELECT
      TO authenticated
      USING (walker_id = auth.uid());
  END IF;
END
$$;
