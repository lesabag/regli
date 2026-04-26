-- Store walker's last known GPS position for nearby-walker map feature.
-- Updated periodically while the walker is online.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS last_lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS last_lng DOUBLE PRECISION;
