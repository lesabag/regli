create or replace function public.get_run_scheduled_dispatch_cron_health()
returns table (
  cron_schema_available boolean,
  job_exists boolean,
  job_active boolean,
  job_schedule text,
  recent_run_status text,
  recent_return_message text,
  recent_started_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  cron_available boolean;
  target_job_id bigint;
begin
  select exists(
    select 1
    from pg_namespace
    where nspname = 'cron'
  )
  into cron_available;

  if not cron_available then
    return query
    select false, false, false, null::text, null::text, null::text, null::timestamptz;
    return;
  end if;

  select jobid, active, schedule
  into target_job_id, job_active, job_schedule
  from cron.job
  where jobname = 'run-scheduled-dispatch'
  order by active desc, jobid desc
  limit 1;

  if target_job_id is null then
    return query
    select true, false, false, null::text, null::text, null::text, null::timestamptz;
    return;
  end if;

  job_exists := true;

  select jrd.status, jrd.return_message, jrd.start_time
  into recent_run_status, recent_return_message, recent_started_at
  from cron.job_run_details jrd
  where jrd.jobid = target_job_id
  order by jrd.start_time desc
  limit 1;

  cron_schema_available := true;
  return next;
end;
$$;

grant execute on function public.get_run_scheduled_dispatch_cron_health() to authenticated;
