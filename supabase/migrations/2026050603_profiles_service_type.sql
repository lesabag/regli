alter table public.profiles
  add column if not exists service_type text;
