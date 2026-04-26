-- Scheduled jobs for payout system maintenance
-- Uses pg_cron (built into Supabase) + pg_net (HTTP extension) to call edge functions on a schedule.
--
-- SETUP:
--   1. Enable extensions in Supabase Dashboard → Database → Extensions:
--      - pg_cron
--      - pg_net
--   2. Set the required app settings (Supabase Dashboard → SQL Editor):
--      ALTER DATABASE postgres SET app.settings.supabase_url = 'https://<project-ref>.supabase.co';
--      ALTER DATABASE postgres SET app.settings.service_role_key = '<your-service-role-key>';
--      (Or use Vault secrets if available on your plan)
--   3. Run this migration
--
-- VERIFY:
--   SELECT * FROM cron.job;
--   SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;
--
-- REMOVE:
--   SELECT cron.unschedule('retry-failed-transfers');
--   SELECT cron.unschedule('recover-stuck-payouts');

-- Enable extensions if not already enabled
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- ─── Retry failed transfers: every 5 minutes ───────────────────

SELECT cron.schedule(
  'retry-failed-transfers',
  '*/5 * * * *',
  $$
  SELECT extensions.http_post(
    url := current_setting('app.settings.supabase_url') || '/functions/v1/retry-failed-transfers',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- ─── Recover stuck payouts: every 10 minutes ───────────────────

SELECT cron.schedule(
  'recover-stuck-payouts',
  '*/10 * * * *',
  $$
  SELECT extensions.http_post(
    url := current_setting('app.settings.supabase_url') || '/functions/v1/recover-stuck-payouts',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
