-- PayMe Partner-level callback audit (Phase 2B).
--
-- Purpose: durably RECEIVE and AUDIT server-to-server callbacks PayMe delivers on
-- our Partner account (including seller-related activity) WITHOUT making any
-- business decision from them yet. PayMe has not published the official callback
-- payload/status contract nor the authenticity/signature contract, so rows here
-- are UNTRUSTED audit input: nothing in Regli reads this table to approve sellers,
-- mark KYC complete, set payment-ready/online, or change payout/financial state.
--
-- No suitable existing table was found (there is no payment_events table; the only
-- events table, analytics_events, is user/session-scoped behavioral analytics and
-- is not appropriate for external provider webhooks). We therefore create the
-- smallest safe, explicitly RLS-protected audit table.
--
-- SECURITY: the edge function persists ONLY an allow-listed, non-sensitive subset
-- of callback fields (identifiers/type/status/currency/timestamps). It never
-- stores API keys, seller_payme_secret, authorization headers, card data, bank
-- details, KYC documents, or personal identity values. `payload` therefore holds
-- only sanitized, allow-listed fields.
create table if not exists public.payme_partner_callback_events (
  id uuid primary key default gen_random_uuid(),

  -- Fixed provenance for this audit stream.
  provider text not null default 'payme'
    check (provider in ('payme')),
  event_scope text not null default 'partner'
    check (event_scope in ('partner')),

  -- Best-effort, non-authoritative fields derived from the callback (may be null;
  -- PayMe's field contract is not yet documented, so nothing here is trusted).
  event_type text,
  external_id text,
  seller_payme_id text,
  payme_sale_id text,
  transaction_id text,

  -- Optional correlation to a Regli provider when seller_payme_id matches a known
  -- seller. Recorded for audit only; does NOT drive any status change.
  provider_id uuid references public.profiles(id) on delete set null,

  -- Deterministic dedup key for PayMe retries (see computeCallbackFingerprint).
  fingerprint text not null,

  -- Sanitized, allow-listed non-sensitive fields ONLY. Never the raw payload.
  payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(payload) = 'object'),

  -- Phase 2B assigns exactly one status; no state machine yet.
  processing_status text not null default 'received'
    check (processing_status in ('received')),

  received_at timestamptz not null default now()
);

-- Idempotency: identical retried callbacks collapse to one row.
create unique index if not exists payme_partner_callback_events_fingerprint_uidx
  on public.payme_partner_callback_events (fingerprint);

create index if not exists payme_partner_callback_events_seller_idx
  on public.payme_partner_callback_events (seller_payme_id);

create index if not exists payme_partner_callback_events_provider_idx
  on public.payme_partner_callback_events (provider_id);

create index if not exists payme_partner_callback_events_received_idx
  on public.payme_partner_callback_events (received_at desc);

alter table public.payme_partner_callback_events enable row level security;

-- Writes happen ONLY from the edge function via the service role (which bypasses
-- RLS). No authenticated/anon INSERT grant: end users can never write audit rows.
-- Admins may read for operational visibility.
grant select on public.payme_partner_callback_events to authenticated;
grant select, insert, update, delete on public.payme_partner_callback_events to service_role;

-- Admins can read all callback audit rows (mirrors analytics_events admin read).
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'payme_partner_callback_events'
      and policyname = 'payme partner callback events admin select'
  ) then
    create policy "payme partner callback events admin select"
      on public.payme_partner_callback_events
      for select
      to authenticated
      using (
        exists (
          select 1 from public.profiles
          where profiles.id = auth.uid() and profiles.role = 'admin'
        )
      );
  end if;
end
$$;
