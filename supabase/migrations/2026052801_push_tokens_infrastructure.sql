-- Push tokens infrastructure hardening / extensibility
-- Keeps existing table and data, adds metadata needed for native push readiness.

ALTER TABLE public.push_tokens
  ADD COLUMN IF NOT EXISTS device_id TEXT,
  ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE public.push_tokens
SET
  enabled = COALESCE(enabled, TRUE),
  last_seen_at = COALESCE(last_seen_at, updated_at, created_at, now())
WHERE enabled IS DISTINCT FROM COALESCE(enabled, TRUE)
   OR last_seen_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_push_tokens_user_enabled
  ON public.push_tokens(user_id, enabled);

CREATE INDEX IF NOT EXISTS idx_push_tokens_device_id
  ON public.push_tokens(device_id)
  WHERE device_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_push_tokens_last_seen_at
  ON public.push_tokens(last_seen_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'push_tokens_platform_check'
      AND conrelid = 'public.push_tokens'::regclass
  ) THEN
    ALTER TABLE public.push_tokens
      ADD CONSTRAINT push_tokens_platform_check
      CHECK (platform IN ('ios', 'android', 'web'));
  END IF;
END $$;

ALTER TABLE public.push_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own push tokens" ON public.push_tokens;
CREATE POLICY "Users can read own push tokens"
  ON public.push_tokens FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own push tokens" ON public.push_tokens;
CREATE POLICY "Users can insert own push tokens"
  ON public.push_tokens FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own push tokens" ON public.push_tokens;
CREATE POLICY "Users can update own push tokens"
  ON public.push_tokens FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own push tokens" ON public.push_tokens;
CREATE POLICY "Users can delete own push tokens"
  ON public.push_tokens FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

REVOKE ALL ON public.push_tokens FROM PUBLIC;
REVOKE ALL ON public.push_tokens FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.push_tokens TO authenticated;
