create table if not exists public.provider_capabilities (
  provider_id uuid not null references public.profiles(id) on delete cascade,
  capability_scope text not null,
  capabilities jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (provider_id, capability_scope),
  constraint provider_capabilities_capabilities_object_check
    check (jsonb_typeof(capabilities) = 'object')
);

alter table public.provider_capabilities enable row level security;

grant select, insert, update on public.provider_capabilities to authenticated;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'provider_capabilities'
      and policyname = 'provider_capabilities_select_own'
  ) then
    create policy provider_capabilities_select_own
      on public.provider_capabilities
      for select
      to authenticated
      using (provider_id = auth.uid());
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'provider_capabilities'
      and policyname = 'provider_capabilities_insert_own'
  ) then
    create policy provider_capabilities_insert_own
      on public.provider_capabilities
      for insert
      to authenticated
      with check (provider_id = auth.uid());
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'provider_capabilities'
      and policyname = 'provider_capabilities_update_own'
  ) then
    create policy provider_capabilities_update_own
      on public.provider_capabilities
      for update
      to authenticated
      using (provider_id = auth.uid())
      with check (provider_id = auth.uid());
  end if;
end $$;

insert into public.provider_capabilities (provider_id, capability_scope, capabilities)
select
  p.id,
  'provider_profile',
  jsonb_strip_nulls(
    coalesce(
      case
        when jsonb_typeof(p.service_attributes -> 'provider_profile') = 'object'
          then p.service_attributes -> 'provider_profile'
        else '{}'::jsonb
      end,
      '{}'::jsonb
    ) || case
      when p.short_bio is not null and btrim(p.short_bio) <> ''
        then jsonb_build_object('shortBio', p.short_bio)
      else '{}'::jsonb
    end
  )
from public.profiles p
where (
    (jsonb_typeof(p.service_attributes -> 'provider_profile') = 'object')
    or (p.short_bio is not null and btrim(p.short_bio) <> '')
  )
  and not exists (
    select 1
    from public.provider_capabilities pc
    where pc.provider_id = p.id
      and pc.capability_scope = 'provider_profile'
  );

insert into public.provider_capabilities (provider_id, capability_scope, capabilities)
select
  p.id,
  entry.key,
  entry.value
from public.profiles p
cross join lateral jsonb_each(coalesce(p.service_attributes, '{}'::jsonb)) as entry(key, value)
where entry.key <> 'provider_profile'
  and jsonb_typeof(entry.value) = 'object'
  and not exists (
    select 1
    from public.provider_capabilities pc
    where pc.provider_id = p.id
      and pc.capability_scope = entry.key
  );
