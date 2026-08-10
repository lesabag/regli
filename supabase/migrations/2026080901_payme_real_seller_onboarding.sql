-- PayMe Marketplace seller onboarding (Phase 2A: minimal seller + hardening).
--
-- Per PayMe's official guidance, KYC/banking is owned by PayMe Hosted Onboarding
-- (completed by the provider via seller_dashboard_signup_link). Regli therefore
-- stores NO sensitive KYC/bank data. This migration:
--   1. Adds the short-lived 'creating' claim state used to serialize concurrent
--      first-time seller creation (see create-payme-seller edge function).
--   2. Introduces a PRIVATE table (provider_payment_onboarding) holding only safe
--      operational metadata — chiefly the payme_signup_url capability token moved
--      off public.profiles. It contains NO KYC/bank fields.
--   3. Migrates any existing Phase-1 signup URL into the private table and drops
--      the cross-user-readable column from public.profiles.
--
-- Non-secret identifiers (payme_seller_id, payme_public_key_uuid,
-- payme_onboarding_status, payme_created_at) remain on public.profiles, on par
-- with the existing stripe_connect_* columns. `seller_payme_secret` is still
-- NEVER stored anywhere.

-- 1. -----------------------------------------------------------------------
-- Allow the 'creating' claim state. The Phase-1 inline column check was named
-- automatically (profiles_payme_onboarding_status_check); drop and re-add it as
-- an explicitly named constraint that includes 'creating'.
alter table public.profiles
  drop constraint if exists profiles_payme_onboarding_status_check;

alter table public.profiles
  add constraint profiles_payme_onboarding_status_check
  check (payme_onboarding_status in (
    'not_started', 'creating', 'created', 'pending', 'completed', 'failed'
  ));

-- 2. -----------------------------------------------------------------------
-- Private, owner-scoped table for safe PayMe seller operational metadata.
-- Mirrors the strict RLS pattern used by public.legal_acceptances
-- (2026060802_legal_acceptances.sql): owner-only reads/writes, service_role full
-- access, and it is NOT exposed by the broad profiles_select_authenticated policy.
--
-- SECURITY: NO KYC or bank fields live here (PayMe Hosted Onboarding owns them),
-- and seller_payme_secret is never persisted. payme_signup_url embeds a
-- capability token, which is why it lives here (owner only) rather than on the
-- broadly-readable public.profiles.
create table if not exists public.provider_payment_onboarding (
  provider_id uuid primary key references public.profiles(id) on delete cascade,
  payment_provider text not null default 'payme'
    check (payment_provider in ('payme')),

  -- Capability-token URL returned by PayMe. Owner-readable only.
  payme_signup_url text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.provider_payment_onboarding enable row level security;

-- Owner may read/insert/update ONLY their own row. Service role (edge function)
-- has full access and bypasses RLS regardless; granted explicitly for clarity.
grant select, insert, update on public.provider_payment_onboarding to authenticated;
grant select, insert, update, delete on public.provider_payment_onboarding to service_role;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'provider_payment_onboarding'
      and policyname = 'provider payment onboarding select own'
  ) then
    create policy "provider payment onboarding select own"
      on public.provider_payment_onboarding
      for select
      to authenticated
      using (provider_id = auth.uid());
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'provider_payment_onboarding'
      and policyname = 'provider payment onboarding insert own'
  ) then
    create policy "provider payment onboarding insert own"
      on public.provider_payment_onboarding
      for insert
      to authenticated
      with check (provider_id = auth.uid());
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'provider_payment_onboarding'
      and policyname = 'provider payment onboarding update own'
  ) then
    create policy "provider payment onboarding update own"
      on public.provider_payment_onboarding
      for update
      to authenticated
      using (provider_id = auth.uid())
      with check (provider_id = auth.uid());
  end if;
end
$$;

-- 3. -----------------------------------------------------------------------
-- Migrate existing Phase-1 signup URLs (e.g. the sandbox test seller) into the
-- private table, then remove the cross-user-readable column from public.profiles.
-- This preserves existing seller metadata; it only relocates the sensitive URL.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = 'payme_signup_url'
  ) then
    insert into public.provider_payment_onboarding (provider_id, payment_provider, payme_signup_url)
    select id, 'payme', payme_signup_url
    from public.profiles
    where payme_signup_url is not null
    on conflict (provider_id)
    do update set payme_signup_url = excluded.payme_signup_url,
                  updated_at = now();

    alter table public.profiles drop column payme_signup_url;
  end if;
end
$$;
