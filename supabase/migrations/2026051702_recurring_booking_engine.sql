alter table public.walk_requests
  add column if not exists recurring_booking_id uuid null references public.recurring_bookings(id) on delete set null;

create index if not exists walk_requests_recurring_booking_id_idx
  on public.walk_requests(recurring_booking_id);

create unique index if not exists walk_requests_recurring_booking_occurrence_uidx
  on public.walk_requests(recurring_booking_id, scheduled_for)
  where recurring_booking_id is not null and scheduled_for is not null;

create or replace function public.find_client_booking_overlaps(
  p_client_id uuid,
  p_scheduled_for timestamptz,
  p_window_minutes integer default 60
)
returns table (
  request_id uuid,
  scheduled_for timestamptz,
  service_type text,
  booking_timing text,
  recurring_booking_id uuid
)
language sql
security definer
set search_path = public
as $$
  select
    wr.id as request_id,
    wr.scheduled_for,
    wr.service_type,
    wr.booking_timing,
    wr.recurring_booking_id
  from public.walk_requests wr
  where wr.client_id = p_client_id
    and wr.booking_timing = 'scheduled'
    and wr.scheduled_for is not null
    and wr.status <> 'cancelled'
    and coalesce(wr.payment_status, '') not in ('failed', 'refunded')
    and wr.scheduled_for between
      p_scheduled_for - make_interval(mins => greatest(coalesce(p_window_minutes, 60), 0))
      and
      p_scheduled_for + make_interval(mins => greatest(coalesce(p_window_minutes, 60), 0));
$$;

grant execute on function public.find_client_booking_overlaps(uuid, timestamptz, integer) to authenticated;
grant execute on function public.find_client_booking_overlaps(uuid, timestamptz, integer) to service_role;

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select cron.unschedule(jobid)
from cron.job
where jobname = 'generate-recurring-bookings';

select cron.schedule(
  'generate-recurring-bookings',
  '0 * * * *',
  $$
  select extensions.http_post(
    url := current_setting('app.settings.supabase_url') || '/functions/v1/generate-recurring-bookings',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
