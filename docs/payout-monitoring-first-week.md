# Payout System: First-Week Monitoring Guide

Daily monitoring metrics and queries for the first week after enabling live payouts.

---

## Dashboard Checks (Daily)

Open the Admin Dashboard and verify:

| KPI | Location | Healthy | Investigate If |
|-----|----------|---------|----------------|
| Stuck Processing | Payout health row | 0 | > 0 for more than 20 min |
| Failed / Retry Queue | Payout health row | 0 or decreasing | Growing over 24h |
| Final Failures | Operational health row | 0 | Any value > 0 |
| Refunded | Operational health row | Matches Stripe refunds | Mismatch with Stripe Dashboard |
| Live Payouts | Users row | Expected count | Fewer than expected |

---

## SQL Queries

Run these in Supabase SQL Editor or via `psql`.

### 1. Payout status distribution

```sql
SELECT
  status,
  count(*) AS count,
  round(sum(net_amount)::numeric, 2) AS total_ils
FROM walker_payouts
GROUP BY status
ORDER BY count DESC;
```

**Healthy:** Most payouts in `transferred`, `paid_out`. Few or zero in `failed`, `processing`.

### 2. Failed transfers detail

```sql
SELECT
  id,
  walker_id,
  job_id,
  net_amount,
  retry_count,
  failure_reason,
  next_retry_at,
  updated_at
FROM walker_payouts
WHERE status = 'failed'
ORDER BY updated_at DESC
LIMIT 20;
```

**Action:** If `retry_count >= 5`, the transfer is a final failure — needs manual investigation.

### 3. Stuck processing payouts

```sql
SELECT
  id,
  walker_id,
  job_id,
  net_amount,
  updated_at,
  now() - updated_at AS stuck_duration
FROM walker_payouts
WHERE status = 'processing'
  AND updated_at < now() - interval '15 minutes'
ORDER BY updated_at;
```

**Healthy:** Empty result set. The recovery cron should clear these every 10 minutes.

### 4. Retry queue size over time

```sql
SELECT
  date_trunc('hour', updated_at) AS hour,
  count(*) AS retry_queue_size
FROM walker_payouts
WHERE status = 'failed'
  AND retry_count < 5
  AND next_retry_at IS NOT NULL
GROUP BY hour
ORDER BY hour DESC
LIMIT 24;
```

**Healthy:** Stable or decreasing. Growing queue means retries are failing repeatedly.

### 5. Refund deductions

```sql
SELECT
  ba.id,
  ba.walker_id,
  ba.job_id,
  ba.amount,
  ba.description,
  ba.created_at,
  wp.status AS payout_status,
  wr.payment_status AS job_payment_status
FROM walker_balance_adjustments ba
LEFT JOIN walker_payouts wp ON wp.job_id = ba.job_id
LEFT JOIN walk_requests wr ON wr.id = ba.job_id
ORDER BY ba.created_at DESC
LIMIT 20;
```

**Verify:** Every refund debit should have a corresponding `payment_status = 'refunded'` job and `status = 'refunded'` payout.

### 6. Average time: completed to transferred

```sql
SELECT
  round(avg(extract(epoch FROM (wp.created_at - wr.paid_at)) / 60)::numeric, 1) AS avg_minutes,
  round(min(extract(epoch FROM (wp.created_at - wr.paid_at)) / 60)::numeric, 1) AS min_minutes,
  round(max(extract(epoch FROM (wp.created_at - wr.paid_at)) / 60)::numeric, 1) AS max_minutes,
  count(*) AS sample_size
FROM walker_payouts wp
JOIN walk_requests wr ON wr.id = wp.job_id
WHERE wp.status IN ('transferred', 'in_transit', 'paid_out')
  AND wr.paid_at IS NOT NULL
  AND wp.created_at > now() - interval '7 days';
```

**Healthy:** < 5 minutes average. Transfer happens inline during payment capture.

### 7. Average time: transferred to paid_out

```sql
SELECT
  round(avg(extract(epoch FROM (
    CASE WHEN wp.status = 'paid_out' THEN wp.updated_at ELSE now() END
    - wp.created_at
  )) / 3600)::numeric, 1) AS avg_hours,
  count(*) FILTER (WHERE wp.status = 'paid_out') AS paid_out_count,
  count(*) FILTER (WHERE wp.status IN ('transferred', 'in_transit')) AS pending_count
FROM walker_payouts wp
WHERE wp.status IN ('transferred', 'in_transit', 'paid_out')
  AND wp.created_at > now() - interval '7 days';
```

**Healthy:** 24-72 hours (depends on Stripe's payout schedule and Israeli banking days).

### 8. Cron job health

```sql
SELECT
  jobname,
  start_time,
  end_time,
  status,
  return_message
FROM cron.job_run_details
ORDER BY start_time DESC
LIMIT 20;
```

**Healthy:** All recent runs show `status = 'succeeded'`. If `status = 'failed'`, check `return_message`.

### 9. Webhook processing health

```sql
SELECT
  type,
  count(*) AS event_count,
  min(created_at) AS first_seen,
  max(created_at) AS last_seen
FROM stripe_events
WHERE created_at > now() - interval '24 hours'
GROUP BY type
ORDER BY event_count DESC;
```

**Verify:** Event types match expected flow. `payment_intent.succeeded` count should roughly match `transfer.created` count.

### 10. Walker balance consistency check

```sql
SELECT
  ww.walker_id,
  p.full_name,
  ww.available_balance AS wallet_available,
  ww.total_earned AS wallet_total,
  coalesce(sum(ba.amount), 0) AS total_adjustments,
  ww.available_balance + coalesce(sum(ba.amount), 0) AS effective_available
FROM walker_wallets ww
JOIN profiles p ON p.id = ww.walker_id
LEFT JOIN walker_balance_adjustments ba ON ba.walker_id = ww.walker_id
GROUP BY ww.walker_id, p.full_name, ww.available_balance, ww.total_earned
HAVING coalesce(sum(ba.amount), 0) < 0
ORDER BY total_adjustments;
```

**Purpose:** Shows walkers with refund deductions. `effective_available` should never be negative (clamped to 0 in the UI).

---

## Daily Checklist (Copy-Paste)

```
Day ___  Date: ___________

[ ] Stuck Processing count: ___  (target: 0)
[ ] Failed / Retry Queue:   ___  (target: 0 or decreasing)
[ ] Final Failures:          ___  (target: 0)
[ ] Refunded count:          ___  (matches Stripe)
[ ] Cron jobs running:       ___  (last run < 15 min ago)
[ ] Webhook errors:          ___  (target: 0 in Stripe Dashboard)
[ ] Avg completed->transferred: ___ min  (target: < 5)
[ ] Balance consistency:     ___  (no negative effective balances)

Notes:
_______________________________________________
```

---

## Alert Thresholds

If you have alerting infrastructure, set these thresholds:

| Metric | Warning | Critical |
|--------|---------|----------|
| Stuck processing count | > 0 for 20 min | > 0 for 45 min |
| Failed transfers (1h window) | > 3 | > 10 |
| Final failures (ever) | > 0 | > 2 |
| Cron job last success | > 15 min ago | > 30 min ago |
| Completed-to-transferred time | > 10 min avg | > 30 min avg |

---

## Escalation

| Situation | Action |
|-----------|--------|
| Single failed transfer | Check failure reason in admin. Usually auto-retries. |
| Multiple failures, same walker | Check walker's Stripe Connect status. May need to re-onboard. |
| Multiple failures, different walkers | Check platform Stripe balance. May be insufficient funds. |
| Stuck processing won't clear | Check edge function logs. May be a deploy issue. |
| Final failure | Investigate in Stripe Dashboard using transfer/PI IDs. Consider manual retry via admin. |
| Balance mismatch | Run consistency query #10. Compare with `wallet_transactions` ledger. |
