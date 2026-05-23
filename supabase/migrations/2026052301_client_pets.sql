create table if not exists public.client_pets (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  pet_type text not null default 'dog',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists client_pets_client_id_idx
  on public.client_pets (client_id);

create index if not exists client_pets_client_active_idx
  on public.client_pets (client_id, is_active);

create or replace function public.set_client_pets_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists client_pets_set_updated_at on public.client_pets;

create trigger client_pets_set_updated_at
before update on public.client_pets
for each row
execute function public.set_client_pets_updated_at();

alter table public.client_pets enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'client_pets'
      and policyname = 'client pets select own'
  ) then
    create policy "client pets select own"
      on public.client_pets
      for select
      to authenticated
      using (client_id = auth.uid());
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'client_pets'
      and policyname = 'client pets insert own'
  ) then
    create policy "client pets insert own"
      on public.client_pets
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
      and tablename = 'client_pets'
      and policyname = 'client pets update own'
  ) then
    create policy "client pets update own"
      on public.client_pets
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
      and tablename = 'client_pets'
      and policyname = 'client pets delete own'
  ) then
    create policy "client pets delete own"
      on public.client_pets
      for delete
      to authenticated
      using (client_id = auth.uid());
  end if;
end
$$;
