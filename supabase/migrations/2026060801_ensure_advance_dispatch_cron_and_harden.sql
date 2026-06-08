-- Ensure expired dispatch attempts always advance in the background.
-- Root causes addressed:
-- 1) environments can miss/lose the advance-dispatch cron job entirely
-- 2) one bad request should not abort the entire expired-attempt sweep
-- 3) stale pending attempts on closed/assigned requests should be cleaned up

create or replace function public.process_expired_dispatch_attempts(
  p_limit integer default 100,
  p_timeout_seconds integer default 20
)
returns table(
  request_id uuid,
  ok boolean,
  message text,
  attempt_id uuid,
  attempt_no integer
) as $process_expired_dispatch_attempts$
declare
  v_timeout_seconds integer;
  v_limit integer;
  v_request record;
  v_result record;
begin
  v_timeout_seconds := greatest(3, least(60, coalesce(p_timeout_seconds, 20)));
  v_limit := greatest(1, least(500, coalesce(p_limit, 100)));

  update public.dispatch_attempts da
  set
    status = 'cancelled',
    responded_at = coalesce(da.responded_at, now()),
    response_note = coalesce(nullif(da.response_note, ''), 'cancelled during expired attempt cleanup'),
    updated_at = now()
  from public.walk_requests wr
  where wr.id = da.request_id
    and da.status = 'pending'
    and da.expires_at <= now()
    and (
      wr.status <> 'open'
      or wr.walker_id is not null
      or coalesce(wr.smart_dispatch_state::text, '') in ('assigned', 'cancelled', 'exhausted')
    );

  for v_request in
    select distinct da.request_id
    from public.dispatch_attempts da
    join public.walk_requests wr
      on wr.id = da.request_id
    where da.status = 'pending'
      and da.expires_at <= now()
      and wr.status = 'open'
      and wr.walker_id is null
      and coalesce(wr.smart_dispatch_state::text, '') not in ('cancelled', 'exhausted')
    order by da.request_id
    limit v_limit
  loop
    begin
      select *
      into v_result
      from public.advance_dispatch_request(v_request.request_id, v_timeout_seconds)
      limit 1;

      return query
      select
        v_request.request_id,
        coalesce(v_result.ok, false),
        coalesce(v_result.message, 'advance returned no message'),
        v_result.attempt_id,
        v_result.attempt_no;
    exception
      when others then
        perform public.log_dispatch_event(
          v_request.request_id,
          null,
          'dispatch_timeout_advance_failed',
          jsonb_build_object(
            'error', sqlerrm,
            'timeout_seconds', v_timeout_seconds
          )
        );

        return query
        select
          v_request.request_id,
          false,
          'advance failed: ' || sqlerrm,
          null::uuid,
          null::integer;
    end;
  end loop;

  return;
end;
$process_expired_dispatch_attempts$ language plpgsql security definer;

grant execute on function public.process_expired_dispatch_attempts(integer, integer) to authenticated;

create extension if not exists pg_cron with schema pg_catalog;

select cron.unschedule(jobid)
from cron.job
where jobname = 'advance-dispatch';

select cron.schedule(
  'advance-dispatch',
  '* * * * *',
  $$
  select * from public.process_expired_dispatch_attempts(100, 20);
  $$
);

-- Immediately sweep already-stale attempts on deploy.
select * from public.process_expired_dispatch_attempts(100, 20);
