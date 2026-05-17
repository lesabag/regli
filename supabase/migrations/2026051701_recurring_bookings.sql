create table if not exists public.recurring_bookings (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.profiles(id) on delete cascade,
  provider_id uuid null references public.profiles(id) on delete set null,
  service_type text not null,
  dog_name text null,
  dog_count integer not null default 1,
  location text not null,
  address text null,
  notes text null,
  duration_minutes integer not null,
  price_per_visit numeric(10,2) not null,
  repeat_type text not null default 'weekly',
  repeat_days integer[] not null default '{}',
  repeat_starts_on date not null,
  repeat_ends_on date null,
  start_time time not null,
  recurring_status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint recurring_bookings_dog_count_check check (dog_count in (1, 2)),
  constraint recurring_bookings_repeat_type_check check (repeat_type in ('one_time', 'weekly')),
  constraint recurring_bookings_status_check check (recurring_status in ('active', 'paused', 'cancelled')),
  constraint recurring_bookings_repeat_days_range_check check (
    array_position(repeat_days, null) is null
    and repeat_days <@ array[0, 1, 2, 3, 4, 5, 6]::integer[]
  )
);

create index if not exists recurring_bookings_client_id_idx
  on public.recurring_bookings(client_id);

create index if not exists recurring_bookings_status_idx
  on public.recurring_bookings(recurring_status);

create index if not exists recurring_bookings_starts_on_idx
  on public.recurring_bookings(repeat_starts_on);

create or replace function public.set_recurring_bookings_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists recurring_bookings_set_updated_at on public.recurring_bookings;

create trigger recurring_bookings_set_updated_at
before update on public.recurring_bookings
for each row
execute function public.set_recurring_bookings_updated_at();

alter table public.recurring_bookings enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'recurring_bookings'
      and policyname = 'recurring bookings client read own'
  ) then
    create policy "recurring bookings client read own"
      on public.recurring_bookings
      for select
      to authenticated
      using (client_id = auth.uid() or provider_id = auth.uid());
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'recurring_bookings'
      and policyname = 'recurring bookings client insert own'
  ) then
    create policy "recurring bookings client insert own"
      on public.recurring_bookings
      for insert
      to authenticated
      with check (client_id = auth.uid());
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'recurring_bookings'
      and policyname = 'recurring bookings client update own'
  ) then
    create policy "recurring bookings client update own"
      on public.recurring_bookings
      for update
      to authenticated
      using (client_id = auth.uid())
      with check (client_id = auth.uid());
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'recurring_bookings'
      and policyname = 'recurring bookings client delete own'
  ) then
    create policy "recurring bookings client delete own"
      on public.recurring_bookings
      for delete
      to authenticated
      using (client_id = auth.uid());
  end if;
end
$$;
