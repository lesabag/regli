create table if not exists public.provider_availability (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.profiles(id) on delete cascade,
  service_type text not null,
  day_of_week integer not null,
  start_time time not null,
  end_time time not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint provider_availability_day_of_week_check check (day_of_week between 0 and 6),
  constraint provider_availability_time_range_check check (end_time > start_time)
);

create unique index if not exists provider_availability_provider_service_day_unique
  on public.provider_availability(provider_id, service_type, day_of_week);

create index if not exists provider_availability_provider_id_idx
  on public.provider_availability(provider_id);

create index if not exists provider_availability_service_type_idx
  on public.provider_availability(service_type);

create index if not exists provider_availability_day_of_week_idx
  on public.provider_availability(day_of_week);

create or replace function public.set_provider_availability_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists provider_availability_set_updated_at on public.provider_availability;

create trigger provider_availability_set_updated_at
before update on public.provider_availability
for each row
execute function public.set_provider_availability_updated_at();

alter table public.provider_availability enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'provider_availability'
      and policyname = 'provider availability read authenticated'
  ) then
    create policy "provider availability read authenticated"
      on public.provider_availability
      for select
      to authenticated
      using (true);
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'provider_availability'
      and policyname = 'provider availability manage own rows'
  ) then
    create policy "provider availability manage own rows"
      on public.provider_availability
      for all
      to authenticated
      using (provider_id = auth.uid())
      with check (provider_id = auth.uid());
  end if;
end
$$;
