alter table public.walk_requests
  add column if not exists service_type text;

update public.walk_requests
set service_type = coalesce(service_type, 'dog')
where service_type is null;

alter table public.walk_requests
  alter column service_type set default 'dog';
