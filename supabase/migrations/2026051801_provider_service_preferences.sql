do $$
begin
  if not exists (
    select 1
    from pg_type
    where typnamespace = 'public'::regnamespace
      and typname = 'service_pricing_model'
  ) then
    create type public.service_pricing_model as enum (
      'time_based',
      'visit_based',
      'hybrid'
    );
  end if;
end
$$;

create table if not exists public.provider_service_preferences (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.profiles(id) on delete cascade,
  service_type text not null,
  pricing_model public.service_pricing_model not null default 'time_based',
  booking_type text not null,
  is_enabled boolean not null default true,
  hourly_rate_min numeric(10,2) null,
  hourly_rate_preferred numeric(10,2) null,
  minimum_billable_hours numeric(4,2) null,
  service_radius_km numeric(6,2) null,
  max_travel_minutes integer null,
  accepts_multi_item boolean not null default false,
  max_item_count integer null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint provider_service_preferences_booking_type_check
    check (booking_type in ('asap', 'scheduled')),
  constraint provider_service_preferences_hourly_rate_min_check
    check (hourly_rate_min is null or hourly_rate_min >= 0),
  constraint provider_service_preferences_hourly_rate_preferred_check
    check (hourly_rate_preferred is null or hourly_rate_preferred >= 0),
  constraint provider_service_preferences_hourly_rate_order_check
    check (
      hourly_rate_min is null
      or hourly_rate_preferred is null
      or hourly_rate_preferred >= hourly_rate_min
    ),
  constraint provider_service_preferences_minimum_billable_hours_check
    check (minimum_billable_hours is null or minimum_billable_hours > 0),
  constraint provider_service_preferences_service_radius_km_check
    check (service_radius_km is null or service_radius_km >= 0),
  constraint provider_service_preferences_max_travel_minutes_check
    check (max_travel_minutes is null or max_travel_minutes >= 0),
  constraint provider_service_preferences_max_item_count_check
    check (max_item_count is null or max_item_count >= 1)
);

create unique index if not exists provider_service_preferences_provider_service_booking_uidx
  on public.provider_service_preferences(provider_id, service_type, booking_type);

create index if not exists provider_service_preferences_provider_id_idx
  on public.provider_service_preferences(provider_id);

create index if not exists provider_service_preferences_service_type_idx
  on public.provider_service_preferences(service_type);

create or replace function public.set_provider_service_preferences_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists provider_service_preferences_set_updated_at
  on public.provider_service_preferences;

create trigger provider_service_preferences_set_updated_at
before update on public.provider_service_preferences
for each row
execute function public.set_provider_service_preferences_updated_at();

alter table public.provider_service_preferences enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'provider_service_preferences'
      and policyname = 'provider service preferences manage own rows'
  ) then
    create policy "provider service preferences manage own rows"
      on public.provider_service_preferences
      for all
      to authenticated
      using (provider_id = auth.uid())
      with check (provider_id = auth.uid());
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'provider_service_preferences'
      and policyname = 'provider service preferences admin all'
  ) then
    create policy "provider service preferences admin all"
      on public.provider_service_preferences
      for all
      to authenticated
      using (public.is_admin())
      with check (public.is_admin());
  end if;
end
$$;
