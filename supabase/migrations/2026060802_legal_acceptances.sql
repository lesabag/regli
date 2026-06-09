create table if not exists public.legal_acceptances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  document_type text not null,
  document_version text not null,
  language text not null,
  accepted_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  constraint legal_acceptances_document_type_check
    check (document_type in ('terms_of_service', 'privacy_policy')),
  constraint legal_acceptances_document_version_check
    check (btrim(document_version) <> ''),
  constraint legal_acceptances_language_check
    check (language in ('en', 'he')),
  constraint legal_acceptances_metadata_object_check
    check (jsonb_typeof(metadata) = 'object')
);

create unique index if not exists legal_acceptances_user_doc_version_uidx
  on public.legal_acceptances (user_id, document_type, document_version);

create index if not exists legal_acceptances_user_id_idx
  on public.legal_acceptances (user_id, accepted_at desc);

create index if not exists legal_acceptances_document_type_idx
  on public.legal_acceptances (document_type, document_version);

alter table public.legal_acceptances enable row level security;

grant select, insert, update on public.legal_acceptances to authenticated;
grant select, insert, update, delete on public.legal_acceptances to service_role;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'legal_acceptances'
      and policyname = 'legal acceptances select own'
  ) then
    create policy "legal acceptances select own"
      on public.legal_acceptances
      for select
      to authenticated
      using (user_id = auth.uid());
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'legal_acceptances'
      and policyname = 'legal acceptances insert own'
  ) then
    create policy "legal acceptances insert own"
      on public.legal_acceptances
      for insert
      to authenticated
      with check (user_id = auth.uid());
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'legal_acceptances'
      and policyname = 'legal acceptances update own'
  ) then
    create policy "legal acceptances update own"
      on public.legal_acceptances
      for update
      to authenticated
      using (user_id = auth.uid())
      with check (user_id = auth.uid());
  end if;
end
$$;
