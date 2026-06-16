-- Track APNs token environment so sandbox/debug installs and TestFlight/App Store
-- installs can coexist and route to the correct APNs host.

ALTER TABLE public.push_tokens
  ADD COLUMN IF NOT EXISTS environment TEXT,
  ADD COLUMN IF NOT EXISTS install_source TEXT;

UPDATE public.push_tokens
SET environment = CASE
  WHEN platform = 'ios' THEN 'sandbox'
  ELSE 'production'
END
WHERE environment IS NULL;

UPDATE public.push_tokens
SET install_source = COALESCE(install_source, 'unknown')
WHERE install_source IS NULL;

ALTER TABLE public.push_tokens
  ALTER COLUMN environment SET DEFAULT 'production',
  ALTER COLUMN environment SET NOT NULL,
  ALTER COLUMN install_source SET DEFAULT 'unknown';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'push_tokens_environment_check'
      AND conrelid = 'public.push_tokens'::regclass
  ) THEN
    ALTER TABLE public.push_tokens
      ADD CONSTRAINT push_tokens_environment_check
      CHECK (environment IN ('sandbox', 'production'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'push_tokens_install_source_check'
      AND conrelid = 'public.push_tokens'::regclass
  ) THEN
    ALTER TABLE public.push_tokens
      ADD CONSTRAINT push_tokens_install_source_check
      CHECK (install_source IS NULL OR install_source IN ('xcode_debug', 'testflight', 'app_store', 'unknown'));
  END IF;
END $$;

ALTER TABLE public.push_tokens
  DROP CONSTRAINT IF EXISTS push_tokens_user_id_token_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_push_tokens_user_token_platform_environment_unique
  ON public.push_tokens(user_id, token, platform, environment);

CREATE INDEX IF NOT EXISTS idx_push_tokens_user_platform_environment_enabled
  ON public.push_tokens(user_id, platform, environment, enabled);
