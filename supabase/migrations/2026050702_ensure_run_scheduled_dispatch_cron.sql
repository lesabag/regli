-- Ensure the scheduled dispatch cron exists and calls the live Edge Function
-- every minute using the same pg_cron + net.http_post pattern already
-- used elsewhere in this repo.
--
-- This migration is idempotent:
--   - enables required extensions if missing
--   - unschedules any existing run-scheduled-dispatch jobs
--   - recreates the cron with the expected command/schedule
--
-- Verify after push:
--   SELECT jobid, jobname, schedule, command, active
--   FROM cron.job
--   WHERE jobname = 'run-scheduled-dispatch';
--
--   SELECT *
--   FROM cron.job_run_details
--   WHERE jobid IN (
--     SELECT jobid FROM cron.job WHERE jobname = 'run-scheduled-dispatch'
--   )
--   ORDER BY start_time DESC
--   LIMIT 20;
--
-- Example healthy result:
--   jobname = 'run-scheduled-dispatch'
--   schedule = '* * * * *'
--   active = true
--
-- Recent executions:
--   SELECT jobid, runid, status, return_message, start_time, end_time
--   FROM cron.job_run_details
--   WHERE jobid IN (
--     SELECT jobid FROM cron.job WHERE jobname = 'run-scheduled-dispatch'
--   )
--   ORDER BY start_time DESC
--   LIMIT 20;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'run-scheduled-dispatch';

SELECT cron.schedule(
  'run-scheduled-dispatch',
  '* * * * *',
  $$
  SELECT net.http_post(
    current_setting('app.settings.supabase_url', true) || '/functions/v1/run-scheduled-dispatch',
    '{}'::jsonb,
    '{}'::jsonb,
    jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
      'Content-Type', 'application/json'
    ),
    30000
  )
  WHERE current_setting('app.settings.supabase_url', true) IS NOT NULL
    AND current_setting('app.settings.service_role_key', true) IS NOT NULL;
  $$
);
