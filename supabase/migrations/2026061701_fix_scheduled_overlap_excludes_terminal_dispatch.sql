-- Bug: declined / exhausted scheduled dispatches kept blocking new scheduled
-- bookings around the same time. find_client_booking_overlaps only excluded
-- status='cancelled' and payment_status in ('failed','refunded'), but a
-- scheduled request whose dispatch failed has status='open' with
-- smart_dispatch_state='exhausted' (or 'cancelled'). That terminal marker is
-- the canonical "still-alive" predicate used by the unique-active-client index
-- (2026051401_fix_walk_requests_active_client_index.sql), the dispatch timeout
-- fix (2026042601_dispatch_timeout_exhausted_state_fix.sql), the active client
-- request enforcement (20260421_enforce_one_active_client_request.sql), and
-- the analytics RPC (2026051301_admin_search_analytics_rpc.sql). The overlap
-- query was written before that pattern existed and never updated.
--
-- Fix: exclude rows whose smart_dispatch_state is a terminal-failed value
-- ('cancelled' or 'exhausted'). When all providers decline or the candidate
-- list runs out, advance_dispatch_request already sets smart_dispatch_state
-- to 'exhausted' (see 20260428_fix_advance_dispatch_cursor.sql:97); this
-- migration just teaches the overlap check to honor that marker. No change to
-- decline_dispatch_attempt / advance_dispatch_request / scheduled dispatch
-- behavior — only the overlap predicate changes.
--
-- Still-active scheduled requests (smart_dispatch_state in 'idle' / 'queued'
-- / 'dispatching' / 'assigned' / NULL) continue to block as before, which is
-- correct: a dispatch still searching for a provider should keep blocking
-- duplicate bookings until it either finds one or exhausts.

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
    and (
      wr.smart_dispatch_state is null
      or wr.smart_dispatch_state not in ('cancelled', 'exhausted')
    )
    and wr.scheduled_for between
      p_scheduled_for - make_interval(mins => greatest(coalesce(p_window_minutes, 60), 0))
      and
      p_scheduled_for + make_interval(mins => greatest(coalesce(p_window_minutes, 60), 0));
$$;

grant execute on function public.find_client_booking_overlaps(uuid, timestamptz, integer) to authenticated;
grant execute on function public.find_client_booking_overlaps(uuid, timestamptz, integer) to service_role;
