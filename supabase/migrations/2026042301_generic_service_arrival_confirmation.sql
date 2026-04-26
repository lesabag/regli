alter table public.walk_requests
  add column if not exists provider_arrived_at timestamptz,
  add column if not exists client_arrival_confirmed_at timestamptz,
  add column if not exists service_started_at timestamptz,
  add column if not exists service_completed_at timestamptz;

update public.walk_requests
set
  service_completed_at = coalesce(service_completed_at, paid_at, created_at),
  service_started_at = coalesce(service_started_at, paid_at, created_at),
  client_arrival_confirmed_at = coalesce(client_arrival_confirmed_at, service_started_at, service_completed_at, paid_at, created_at),
  provider_arrived_at = coalesce(provider_arrived_at, client_arrival_confirmed_at, service_started_at, service_completed_at, paid_at, created_at)
where
  status = 'completed'
  and (
    service_completed_at is null
    or service_started_at is null
    or client_arrival_confirmed_at is null
    or provider_arrived_at is null
  );
