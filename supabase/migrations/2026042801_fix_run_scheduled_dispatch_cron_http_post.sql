-- Ensure the scheduled dispatch cron points at the live Edge Function
-- using the exact same working pg_cron + extensions.http_post pattern used
-- by the other scheduled jobs in this repo.
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

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'run-scheduled-dispatch';

SELECT cron.schedule(
  'run-scheduled-dispatch',
  '* * * * *',
  $$
  SELECT extensions.http_post(
    url := current_setting('app.settings.supabase_url') || '/functions/v1/run-scheduled-dispatch',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
