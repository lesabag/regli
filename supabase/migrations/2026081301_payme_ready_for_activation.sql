-- Provider activation READINESS (Regli-only intent flag).
--
-- Business rule: creating a PayMe Seller incurs a one-time, per-provider setup
-- cost charged to Regli. Therefore a provider expressing "I'm ready to receive
-- orders" MUST NOT create a PayMe Seller. This migration adds a Regli-only
-- readiness flag that records that intent and NOTHING else:
--
--   REGISTERED -> READY_FOR_ACTIVATION -> still NO PayMe Seller -> still zero
--   PayMe seller-setup cost.
--
-- These columns carry NO payment/financial meaning and NO PayMe state. They are
-- deliberately independent from the payme_seller_* columns (2026080701) and from
-- provider_payment_onboarding (2026080901). Actual PayMe Seller creation happens
-- later, behind a separate, explicit payment-activation boundary — never here.

alter table public.profiles
  -- True when the provider has explicitly said they want to receive orders. A
  -- provider may withdraw readiness by setting this back to false. Setting this
  -- flag NEVER contacts PayMe and NEVER makes the provider dispatch-eligible.
  add column if not exists payme_ready_for_activation boolean not null default false,
  -- When readiness was last turned on (nulled again on withdrawal). Audit only.
  add column if not exists payme_ready_for_activation_at timestamptz;

-- RLS / GRANTS -------------------------------------------------------------
-- `profiles` already has RLS enabled (2026033105_security_hardening.sql):
--   * profiles_select_authenticated — authenticated users may read profiles
--   * profiles_update_own           — a user may update ONLY their own row
-- The readiness flag is owner-controlled by design: the provider marks/withdraws
-- their own readiness through profiles_update_own. It exposes no secret and no
-- payment capability, so the existing SELECT policy is acceptable. We re-assert
-- RLS + grants here so this migration is explicit and self-contained.
alter table public.profiles enable row level security;

grant select, update on public.profiles to authenticated;
grant select on public.profiles to anon;
-- service_role bypasses RLS; readiness needs no service_role writer (unlike the
-- payme_seller_* columns, which are written only by the create-payme-seller edge
-- function). Readiness is a plain owner-writable profile flag.
