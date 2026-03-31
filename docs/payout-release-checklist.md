# Payout System Release Checklist

Complete each item before enabling live payouts in production.

---

## Environment Configuration

- [ ] **Stripe keys configured** in Supabase Edge Function secrets:
  - `STRIPE_SECRET_KEY` — live mode key (starts with `sk_live_`)
  - `STRIPE_WEBHOOK_SECRET` — webhook signing secret for the production endpoint
- [ ] **Supabase secrets configured:**
  - `SUPABASE_URL` — production project URL
  - `SUPABASE_ANON_KEY` — production anon key
  - `SUPABASE_SERVICE_ROLE_KEY` — production service role key
- [ ] **Database app settings** for cron jobs:
  ```sql
  ALTER DATABASE postgres SET app.settings.supabase_url = 'https://<project>.supabase.co';
  ALTER DATABASE postgres SET app.settings.service_role_key = '<service-role-key>';
  ```

## Stripe Configuration

- [ ] **Webhook endpoint** created in Stripe Dashboard (live mode):
  - URL: `https://<project>.supabase.co/functions/v1/stripe-webhook`
  - Events subscribed:
    - `payment_intent.succeeded`
    - `payment_intent.payment_failed`
    - `payment_intent.canceled`
    - `account.updated`
    - `transfer.created`
    - `transfer.reversed`
    - `payout.created`
    - `payout.paid`
    - `payout.failed`
    - `charge.refunded`
- [ ] **Webhook signing secret** matches `STRIPE_WEBHOOK_SECRET` env var
- [ ] **Connect settings** configured in Stripe Dashboard:
  - Country: Israel
  - Currency: ILS
  - Account type: Express

## Database Migrations

- [ ] All migrations applied in order:
  ```
  20260327_add_payments.sql
  20260328_add_commission.sql
  20260328_wallet.sql
  20260328_notifications.sql
  20260329_fix_prepayment_job_flow.sql
  20260329_fix_notifications_identity.sql
  20260329_ratings.sql
  20260329_payout_requests.sql
  20260329_stripe_connect_setup.sql
  20260329_payment_intent_fields.sql
  20260330_walker_wallet.sql
  20260330_location_tracking.sql
  20260331_security_hardening.sql
  20260331_security_hardening_v2.sql
  20260331_ratings_realtime.sql
  20260331_stripe_connect_payouts.sql
  20260331_payout_hardening.sql
  20260331_balance_adjustments.sql
  20260331_rollout_guard.sql
  20260331_scheduled_jobs.sql
  ```
- [ ] `pg_cron` extension enabled
- [ ] `pg_net` extension enabled

## Scheduled Jobs

- [ ] **Verify cron jobs registered:**
  ```sql
  SELECT jobname, schedule, command FROM cron.job;
  ```
  Expected: `retry-failed-transfers` (*/5), `recover-stuck-payouts` (*/10)
- [ ] **Verify cron execution:**
  ```sql
  SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 5;
  ```
  Should show recent runs with `status = 'succeeded'`

## Edge Functions

- [ ] All edge functions deployed:
  - `create-payment-intent`
  - `capture-payment`
  - `create-transfer`
  - `retry-failed-transfers`
  - `recover-stuck-payouts`
  - `stripe-webhook`
  - `get-connect-status`
  - `create-connect-account`
  - `create-connect-onboarding-link`
- [ ] `config.toml` deployed with `verify_jwt = false` for all listed functions

## Admin Permissions

- [ ] At least one admin user exists in `profiles` with `role = 'admin'`
- [ ] Admin can access the Operations Dashboard
- [ ] Admin can see Stripe Transfers section with Retry / Recover buttons
- [ ] Admin can toggle `live_payouts_enabled` on walker profiles

## Test Walker Verification

- [ ] At least one test walker has completed Stripe Connect onboarding
- [ ] Test walker profile shows: `payouts_enabled = true`, `charges_enabled = true`
- [ ] Test walker has `live_payouts_enabled = true` set by admin
- [ ] Test walker's connected account ID is visible in Stripe Dashboard

## Happy Path Test (production-like)

- [ ] Client creates walk request with payment (test card `4000005780000007` for IL)
- [ ] Payment authorized, job becomes `open`
- [ ] Walker accepts job
- [ ] Walker completes job — payment captured
- [ ] Job shows `completed` + `paid`
- [ ] Walker wallet credited
- [ ] Stripe transfer created (visible in `walker_payouts` and Stripe Dashboard)
- [ ] Admin Dashboard shows transfer with all Stripe IDs

## Refund Scenario Test

- [ ] Issue refund via Stripe Dashboard on a paid job
- [ ] `charge.refunded` webhook received and processed
- [ ] Job payment_status updated to `refunded`
- [ ] Walker payout status updated to `refunded`
- [ ] Balance adjustment record created in `walker_balance_adjustments`
- [ ] Walker Dashboard shows deduction

## Failure Scenario Test

- [ ] Simulate transfer failure (e.g. use a walker without a valid connected account)
- [ ] Payout moves to `failed` with failure_reason
- [ ] Retry cron picks it up (or admin clicks Retry)
- [ ] After 5 failures: final failure status, walker notified

## Monitoring Access

- [ ] Supabase Dashboard accessible for DB queries
- [ ] Stripe Dashboard accessible for payment/transfer investigation
- [ ] Edge function logs accessible (Supabase Dashboard > Edge Functions > Logs)
- [ ] Admin Dashboard KPIs visible: stuck processing, failed, refunded counts

## Rollback Plan

If critical issues are discovered after enabling live payouts:

1. **Immediate stop:** Disable live payouts for all walkers:
   ```sql
   UPDATE profiles SET live_payouts_enabled = false WHERE role = 'walker';
   ```
2. **Pause cron jobs:**
   ```sql
   SELECT cron.unschedule('retry-failed-transfers');
   SELECT cron.unschedule('recover-stuck-payouts');
   ```
3. **Impact:** Walkers still get wallet credits (no change). Stripe transfers simply stop being created. Existing in-flight transfers continue through Stripe normally.
4. **Investigation:** Check edge function logs, `walker_payouts` table, Stripe Dashboard
5. **Recovery:** Fix the issue, re-enable `live_payouts_enabled` per walker, re-schedule cron jobs

---

## Sign-off

| Role | Name | Date | Status |
|------|------|------|--------|
| Developer | | | |
| Admin/Ops | | | |
