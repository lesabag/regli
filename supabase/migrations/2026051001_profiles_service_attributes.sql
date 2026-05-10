-- Add service_attributes JSONB column to profiles
-- Stores per-service onboarding data (dog_walker, baby_sitter, etc.)
-- Safe: ADD COLUMN IF NOT EXISTS, no data rewrite on existing rows with values

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS service_attributes JSONB DEFAULT '{}'::jsonb;

-- Backfill any existing NULL rows to empty object without overwriting real data
UPDATE public.profiles
  SET service_attributes = '{}'::jsonb
  WHERE service_attributes IS NULL;

COMMENT ON COLUMN public.profiles.service_attributes IS
  'Per-service onboarding attributes, keyed by service type. Example: {"dog_walker":{"petName":"Boki","dogSize":"M","energyLevel":"medium"}}';
