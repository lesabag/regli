-- PayMe Marketplace seller onboarding (Phase 1: seller creation + safe metadata).
--
-- Mirrors the existing Stripe Connect precedent (2026032906_stripe_connect_setup.sql):
-- a provider is a `profiles` row with role = 'walker', and external seller identity
-- is stored as columns on `public.profiles`. No secret values are ever stored here —
-- `seller_payme_secret` is intentionally NOT persisted (see docs / edge function).

alter table public.profiles
  add column if not exists payme_seller_id text,
  add column if not exists payme_public_key_uuid text,
  add column if not exists payme_signup_url text,
  add column if not exists payme_onboarding_status text not null default 'not_started'
    check (payme_onboarding_status in ('not_started', 'created', 'pending', 'completed', 'failed')),
  add column if not exists payme_created_at timestamptz;

-- Idempotency safety net at the database level: a given PayMe seller id can never
-- be attached to more than one provider row.
create unique index if not exists uq_profiles_payme_seller_id
  on public.profiles(payme_seller_id)
  where payme_seller_id is not null;

-- RLS / GRANTS -------------------------------------------------------------
-- `profiles` already has RLS enabled with the following policies (see
-- 2026033105_security_hardening.sql):
--   * profiles_select_authenticated — authenticated users may read profiles
--   * profiles_update_own           — a user may update only their own row
-- payme_seller_id / payme_public_key_uuid are non-secret identifiers (the public
-- key uuid is public by definition), on par with the existing stripe_connect_*
-- columns, so exposing them under the existing SELECT policy is acceptable.
-- Authoritative writes are performed exclusively by the create-payme-seller edge
-- function using the service_role key, which bypasses RLS. We re-assert RLS +
-- grants here so this migration is explicit and self-contained.
--
-- SECURITY TODO(payme-phase2): payme_signup_url embeds a capability token that
-- lets its bearer complete/update the seller's onboarding. The existing
-- profiles_select_authenticated policy allows ANY authenticated user to read ANY
-- profile row, so this column would be cross-user readable. In Phase 1 this is
-- not exposed (the client never reads it, and the automatic onboarding flow is
-- guarded from creating real sellers), but BEFORE real provider signup URLs are
-- stored in Phase 2 this column must be protected from cross-user reads
-- (column-level SELECT restriction, a dedicated restricted table, or serving the
-- URL only through an owner-scoped edge function).
alter table public.profiles enable row level security;

grant select, update on public.profiles to authenticated;
grant select on public.profiles to anon;
-- service_role bypasses RLS and is used by the edge function to write payme_* fields.
