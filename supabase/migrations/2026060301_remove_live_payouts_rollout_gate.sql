-- Remove obsolete live payouts rollout gate.
-- Provider payout eligibility now depends only on actual Stripe readiness:
-- - stripe_connect_account_id exists
-- - charges_enabled = true
-- - payouts_enabled = true

DROP INDEX IF EXISTS idx_profiles_live_payouts;

ALTER TABLE public.profiles
  DROP COLUMN IF EXISTS live_payouts_enabled;
