-- Enable pg_cron extension if not already enabled
-- Note: This may require superuser privileges or manual setup in Supabase dashboard

-- Schedule the run-scheduled-dispatch edge function to run every 5 minutes
SELECT cron.schedule(
  'run-scheduled-dispatch',
  '*/5 * * * *',  -- Every 5 minutes
  $$
  SELECT net.http_post(
    url => 'https://your-project.supabase.co/functions/v1/run-scheduled-dispatch',
    headers => '{"Authorization": "Bearer ' || (SELECT value FROM vault.secrets WHERE name = 'service_role_key') || '"}'
  );
  $$
);

-- To unschedule later if needed:
-- SELECT cron.unschedule('run-scheduled-dispatch');
