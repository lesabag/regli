-- Provider payment-activation orchestration state (Phase 2B).
--
-- Records the lifecycle of the one-time Provider Account Activation Fee: a J5
-- authorization (amount reserved, not captured), PayMe Seller creation, Hosted
-- Onboarding/KYC, and the final Capture that makes the provider payment-ready.
-- See supabase/functions/_shared/paymeActivation.ts for the authoritative state
-- machine and src/payments/providerActivationState.ts for the client mirror.
--
-- SECURITY / DATA MINIMIZATION:
--   * This table holds ONLY safe orchestration metadata. It stores NO card
--     details, NO buyer token, NO seller secret, NO KYC/bank data, NO API keys,
--     and NO Authorization headers. PayMe owns all KYC/banking via Hosted
--     Onboarding; Regli never persists it.
--   * activation_state is SERVER-AUTHORITATIVE. Owners may READ their own row
--     (all columns here are safe to expose to the owner) but may NOT mutate it —
--     every state transition happens in an edge function via service_role. Hence,
--     unlike provider_payment_onboarding, we grant authenticated SELECT only.
--   * It is a SEPARATE private table (not columns on the broadly-readable
--     public.profiles) so payment-operation references never leak across users.
--
-- Existing PayMe sellers (Phase 2A) are unaffected: seller identity stays on
-- public.profiles / provider_payment_onboarding and is reused as-is. A provider
-- with a seller but no activation row simply has no row here yet.

create table if not exists public.provider_activation (
  provider_id uuid primary key references public.profiles(id) on delete cascade,

  -- Regli-internal orchestration state. CHECK mirrors PROVIDER_ACTIVATION_STATES.
  activation_state text not null default 'not_started'
    check (activation_state in (
      'not_started',
      'ready',
      'fee_authorizing',
      'fee_authorized',
      'seller_creating',
      'seller_created',
      'kyc_pending',
      'kyc_approved',
      'fee_capturing',
      'fee_captured',
      'payment_ready',
      'authorization_expired',
      'activation_failed',
      'cancelled'
    )),

  -- PayMe Seller / KYC verification lifecycle, tracked INDEPENDENTLY of the
  -- fee-authorization lifecycle above. A single activation_state cannot represent
  -- both facts at once (e.g. authorization expired AND KYC approved), and KYC
  -- approval must survive J5 expiry / re-authorization. These are Regli-internal
  -- NORMALIZED statuses — never raw/undocumented PayMe external status names.
  -- 'approved' is set ONLY via the verified Phase-2C seam
  -- (markProviderKycApprovedFromVerifiedPaymeStatus), never inferred from callbacks.
  seller_verification_status text not null default 'not_started'
    check (seller_verification_status in ('not_started', 'pending', 'approved', 'rejected')),
  seller_verified_at timestamptz,

  -- J5 authorization sale id (safe, non-secret). Used for capture/void.
  activation_fee_payme_sale_id text,
  -- Authorized (gross) amount in agorot; capture must never exceed this.
  activation_fee_amount_agorot integer
    check (activation_fee_amount_agorot is null or activation_fee_amount_agorot > 0),

  activation_fee_authorized_at timestamptz,
  -- authorized_at + 168h. Capture after this fails; re-authorization required.
  activation_fee_authorization_expires_at timestamptz,
  activation_fee_captured_at timestamptz,
  activation_fee_voided_at timestamptz,

  -- Monotonic attempt counter — each new J5 authorization increments it.
  activation_attempt integer not null default 0
    check (activation_attempt >= 0),
  -- Safe, non-secret error classification only (never raw PayMe bodies).
  last_activation_error_code text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Idempotency for re-runs where the table already exists without these columns.
alter table public.provider_activation
  add column if not exists seller_verification_status text not null default 'not_started';
alter table public.provider_activation
  add column if not exists seller_verified_at timestamptz;
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'provider_activation_seller_verification_status_check'
  ) then
    alter table public.provider_activation
      add constraint provider_activation_seller_verification_status_check
      check (seller_verification_status in ('not_started', 'pending', 'approved', 'rejected'));
  end if;
end
$$;

alter table public.provider_activation enable row level security;

-- Owner: read-only. Service role (edge functions): full access for all mutations.
grant select on public.provider_activation to authenticated;
grant select, insert, update, delete on public.provider_activation to service_role;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'provider_activation'
      and policyname = 'provider activation select own'
  ) then
    create policy "provider activation select own"
      on public.provider_activation
      for select
      to authenticated
      using (provider_id = auth.uid());
  end if;
end
$$;

-- Deliberately NO insert/update/delete policies for `authenticated`: state is
-- mutated exclusively by edge functions using the service role (which bypasses
-- RLS). This prevents a client from forging its own activation progression.

-- Indexes for the reconciliation / expiry-sweep access patterns.
create index if not exists provider_activation_state_idx
  on public.provider_activation (activation_state);
create index if not exists provider_activation_sale_id_idx
  on public.provider_activation (activation_fee_payme_sale_id)
  where activation_fee_payme_sale_id is not null;
create index if not exists provider_activation_expires_idx
  on public.provider_activation (activation_fee_authorization_expires_at)
  where activation_fee_authorization_expires_at is not null;
