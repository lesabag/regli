-- Walker online/offline availability toggle
-- Stored on profiles table for simplicity. Default to offline.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_online BOOLEAN NOT NULL DEFAULT false;

-- Index for fast filtering of online walkers
CREATE INDEX IF NOT EXISTS idx_profiles_is_online
  ON public.profiles(is_online) WHERE role = 'walker';
