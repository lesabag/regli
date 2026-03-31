# Payout Admin Runbook

Operational guide for managing the Regli Stripe Connect payouts system.

---

## Payout Status Reference

| Status | Meaning | Action Required |
|--------|---------|-----------------|
| **pending** | Payout record created, transfer not yet attempted | None — will be picked up automatically |
| **processing** | Transfer creation in progress | Wait. If stuck >15 min, use Recover Stuck |
| **transferred** | Stripe transfer created successfully | Funds in walker's Stripe balance, awaiting bank payout |
| **in_transit** | Stripe is sending funds to walker's bank | Typically 1-3 business days |
| **paid_out** | Funds deposited in walker's bank account | Terminal — all done |
| **failed** | Transfer or payout failed | Check failure reason. Use Retry or investigate |
| **reversed** | Stripe reversed the transfer | Contact support. Walker notified automatically |
| **refunded** | The original charge was refunded | Balance adjustment deducted from walker. No further action unless disputed |

---

## Admin Dashboard Actions

### Retry (failed transfers)

**When to use:** A transfer has `status=failed` — could be a temporary Stripe error, network issue, or resolved account problem.

**How:**
1. Go to Admin Dashboard > Stripe Transfers section
2. Find the failed transfer row
3. Click the **Retry** button
4. This calls `create-transfer` which re-attempts the Stripe transfer

**What happens:**
- If the walker's connected account issue is resolved, the transfer succeeds
- If it fails again, the payout stays in `failed` with an updated failure reason
- The automatic retry cron will also pick it up based on the backoff schedule

**Automatic retries:** The `retry-failed-transfers` cron runs every 5 minutes and processes up to 10 failed payouts per run with exponential backoff:
- Retry 1: after 5 minutes
- Retry 2: after 15 minutes
- Retry 3: after 1 hour
- Retry 4: after 4 hours
- Retry 5: after 24 hours
- After 5 failures: marked as final failure, walker notified

### Recover Stuck (processing payouts)

**When to use:** The "Stuck Processing" KPI shows a count > 0 — meaning payouts have been in `processing` status for more than 15 minutes without completing.

**How:**
1. The **Recover Stuck** button appears in the Stripe Transfers section header when stuck payouts exist
2. Click the button
3. Confirmation dialog explains what will happen

**What happens:**
- For each stuck payout, the system checks Stripe for an existing transfer
- If a transfer exists in Stripe: the DB is repaired to match (`transferred` status, transfer ID recorded)
- If no transfer exists: the payout is moved to `failed` with retry scheduling

**Automatic recovery:** The `recover-stuck-payouts` cron runs every 10 minutes and handles this automatically. The manual button is for immediate intervention.

---

## Investigating Issues Using Stripe IDs

### Where to find Stripe IDs

- **Payment Intent ID:** Admin Dashboard > expand a job row > "Stripe Payment Intent" field
- **Transfer ID:** Admin Dashboard > Stripe Transfers table > "Transfer ID" column (full ID shown)
- **Payout ID:** Admin Dashboard > Stripe Transfers table > below the transfer ID
- **All IDs together:** Expand a job row to see PI + transfer + payout IDs in one view

### How to investigate in Stripe Dashboard

1. **Payment issue:** Copy the Payment Intent ID (starts with `pi_`), search in Stripe Dashboard > Payments
2. **Transfer issue:** Copy the Transfer ID (starts with `tr_`), search in Stripe Dashboard > Connect > Transfers
3. **Payout issue:** Copy the Payout ID (starts with `po_`), go to the connected account in Stripe Dashboard > Payouts
4. **Connected account:** The walker's Stripe account ID is visible in Admin Dashboard > Users > Stripe Connect column

### Common failure reasons

| Failure Reason | Cause | Resolution |
|---------------|-------|------------|
| `Insufficient funds` | Platform balance too low for transfer | Add funds to platform Stripe account |
| `account_closed` | Walker closed their Stripe account | Contact walker to reconnect |
| `could not determine charge` | PI has no charge (e.g. not captured) | Check job payment_status, may need manual capture |
| `No connected Stripe account` | Walker hasn't completed onboarding | Ask walker to complete Stripe Connect onboarding |
| `Stuck in processing` | Network timeout or edge function crash | Recover Stuck handles this automatically |

---

## Refund Deductions

### How refunds work

When a charge is refunded in Stripe:

1. The `charge.refunded` webhook fires
2. The job's `payment_status` is set to `refunded`
3. If a payout record exists, its status becomes `refunded`
4. A **balance adjustment** record is created: a negative debit equal to the walker's net earnings for that job
5. The walker is notified that the payment was refunded

### Impact on walker earnings

- The deduction is subtracted from the walker's **available balance** in real-time
- The walker sees "Includes X ILS in refund deductions" on their wallet card
- The "Balance Adjustments" section on their dashboard lists all deductions
- Future payout requests are limited to the adjusted available balance

### Impact on future transfers

- The `create-transfer` edge function rejects transfers for jobs with `status=refunded` (HTTP 400)
- No duplicate deductions: the `unique_refund_per_job` constraint prevents multiple debits for the same job

### Admin visibility

- "Refunded" count appears in the operational health KPI row
- Refunded transfers show a "refunded" badge in the Stripe Transfers table
- The expanded job detail shows `payment_status=refunded`

---

## Monitoring Checklist

Check these daily during the first week after launch:

| Check | Where | Healthy Value |
|-------|-------|---------------|
| Stuck Processing | Admin Dashboard KPI | 0 |
| Failed / Retry Queue | Admin Dashboard KPI | 0 (or decreasing) |
| Final Failures | Admin Dashboard KPI | 0 |
| Cron jobs running | `SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;` | Recent runs with `status='succeeded'` |
| Webhook errors | Stripe Dashboard > Webhooks > endpoint | 0 failures |

---

## Scheduled Jobs

| Job | Schedule | Function | Purpose |
|-----|----------|----------|---------|
| `retry-failed-transfers` | Every 5 min | `retry-failed-transfers` | Retries failed transfers with exponential backoff |
| `recover-stuck-payouts` | Every 10 min | `recover-stuck-payouts` | Repairs or requeues payouts stuck in processing |

### Verifying cron jobs

```sql
-- List all scheduled jobs
SELECT * FROM cron.job;

-- View recent execution history
SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;

-- Manually unschedule a job
SELECT cron.unschedule('retry-failed-transfers');
```
