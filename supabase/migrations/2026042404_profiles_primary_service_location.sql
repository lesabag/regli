alter table public.profiles
  add column if not exists primary_service text,
  add column if not exists location_address text;
