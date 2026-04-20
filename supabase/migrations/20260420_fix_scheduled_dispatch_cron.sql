-- Force the scheduled-dispatch cron to call the live run-scheduled-dispatch
-- Edge Function. Earlier setup could leave an old placeholder job named
-- run-scheduled-dispatch in place, so future orders entered the dispatch
-- window without the backend dispatch runner actually being invoked.

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
    url := current_setting('app.settings.supabase_url', true) || '/functions/v1/run-scheduled-dispatch',
    body := '{}'::jsonb,
    params := '{}'::jsonb,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true),
      'Content-Type', 'application/json'
    ),
    timeout_milliseconds := 30000
  )
  WHERE current_setting('app.settings.supabase_url', true) IS NOT NULL
    AND current_setting('app.settings.service_role_key', true) IS NOT NULL;
  $$
);
