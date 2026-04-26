-- Rollout guard: gate live Stripe transfers to opted-in walkers only.
-- During staged rollout, only walkers with live_payouts_enabled = true
-- will have Stripe transfers created. Others still get wallet credits
-- but skip the Stripe transfer step.
--
-- Admin can enable per walker:
--   UPDATE profiles SET live_payouts_enabled = true WHERE id = '<walker-id>';
--
-- To enable for all walkers (full rollout):
--   UPDATE profiles SET live_payouts_enabled = true WHERE role = 'walker';

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS live_payouts_enabled BOOLEAN NOT NULL DEFAULT false;

-- Index for quick lookups in transfer functions
CREATE INDEX IF NOT EXISTS idx_profiles_live_payouts
  ON public.profiles(id)
  WHERE live_payouts_enabled = true;
