# Payout System QA Checklist

End-to-end test matrix for the Regli Stripe Connect payouts system.

**Pre-requisites:**
- Stripe test mode with a Connect Express account onboarded
- At least one walker with `payouts_enabled: true`
- At least one client with a test card
- Supabase edge functions deployed
- Stripe webhook endpoint configured for all events

---

## 1. Happy Path: Full Payment Lifecycle

| # | Step | Expected Result | Verify In |
|---|------|-----------------|-----------|
| 1.1 | Client creates a walk request with payment | `walk_requests` row: `status=awaiting_payment`, `payment_status=unpaid` | DB |
| 1.2 | Client completes Stripe checkout | `payment_status=authorized`, `stripe_payment_intent_id` populated | DB |
| 1.3 | Walk request becomes visible to walkers | Status changes to `open` | Walker Dashboard |
| 1.4 | Walker accepts job | `status=accepted`, `walker_id` set | Walker Dashboard |
| 1.5 | Walker clicks "Mark Complete" | `capture-payment` called, PI captured | Edge function logs |
| 1.6 | After capture | `status=completed`, `payment_status=paid`, `paid_at` set | DB, Admin Dashboard |
| 1.7 | Wallet credited | `walker_wallets.available_balance` increased by `walker_earnings` | DB, Walker Dashboard |
| 1.8 | Transfer created | `walker_payouts` row: `status=transferred`, `stripe_transfer_id` set | DB, Admin Dashboard > Stripe Transfers |
| 1.9 | `payment_intent.succeeded` webhook fires | Job already paid, wallet credit idempotent (no duplicate) | Stripe webhook logs |
| 1.10 | `transfer.created` webhook fires | Payout record updated (idempotent) | Stripe webhook logs |
| 1.11 | `payout.created` webhook fires | `status=in_transit`, `stripe_payout_id` set, `available_at` set | DB |
| 1.12 | `payout.paid` webhook fires | `status=paid_out` | DB, Walker Dashboard shows "Paid to bank" |
| 1.13 | Walker sees final state | Transfer Breakdown shows amount in "Paid Out", earnings history shows "Paid to bank" | Walker Dashboard |
| 1.14 | Admin sees final state | Stripe Transfers table shows `paid_out` badge, full Stripe IDs visible | Admin Dashboard |

---

## 2. Transfer Failure and Retry

| # | Step | Expected Result | Verify In |
|---|------|-----------------|-----------|
| 2.1 | Capture succeeds but transfer fails (e.g. invalid connected account) | `walker_payouts`: `status=failed`, `failure_reason` set, `retry_count=0`, `next_retry_at` ~5m from now | DB |
| 2.2 | Wait for `retry-failed-transfers` cron (or trigger manually) | Payout picked up, `status=processing` during attempt | Edge function logs |
| 2.3 | If retry succeeds | `status=transferred`, `stripe_transfer_id` set, `retry_count=1` | DB |
| 2.4 | If retry fails again | `retry_count` incremented, `next_retry_at` updated with exponential backoff (5m, 15m, 60m, 4h, 24h) | DB |
| 2.5 | Admin sees failure in dashboard | Red "failed" badge, failure reason shown, retry count visible, "Retry" button available | Admin Dashboard > Stripe Transfers |
| 2.6 | Admin clicks "Retry" button | `create-transfer` edge function called, transfer re-attempted | Admin Dashboard |

---

## 3. Stuck Processing Recovery

| # | Step | Expected Result | Verify In |
|---|------|-----------------|-----------|
| 3.1 | Simulate stuck payout: manually set `status=processing`, `updated_at` to 20min ago | Payout appears in "Stuck Processing" KPI count | Admin Dashboard |
| 3.2 | Wait for `recover-stuck-payouts` cron (or click "Recover Stuck" button) | Function runs, checks Stripe for matching transfer | Edge function logs |
| 3.3a | If Stripe transfer exists | DB repaired: `status=transferred`, `stripe_transfer_id` set | DB |
| 3.3b | If no Stripe transfer | `status=failed`, `failure_reason` set, `next_retry_at` scheduled | DB |
| 3.4 | Admin sees recovery result | Alert with counts: repaired / retried / final failures | Admin Dashboard |
| 3.5 | "Stuck Processing" KPI returns to 0 | Count updated after recovery | Admin Dashboard |

---

## 4. Refund Handling

### 4a. Refund before transfer
| # | Step | Expected Result | Verify In |
|---|------|-----------------|-----------|
| 4a.1 | Issue Stripe refund on a paid job before transfer is created | `charge.refunded` webhook fires | Stripe webhook logs |
| 4a.2 | Job updated | `payment_status=refunded` | DB |
| 4a.3 | No payout record exists | Balance adjustment created: `type=refund_debit`, `amount=-{earnings}` | `walker_balance_adjustments` table |
| 4a.4 | Walker balance updated | Available balance reduced by debit amount | Walker Dashboard |
| 4a.5 | Walker notified | Notification: "Payment Refunded" | Notifications |

### 4b. Refund after transfer (before bank payout)
| # | Step | Expected Result | Verify In |
|---|------|-----------------|-----------|
| 4b.1 | Issue Stripe refund on a job with `status=transferred` | `charge.refunded` webhook fires | Stripe webhook logs |
| 4b.2 | Job updated | `payment_status=refunded` | DB |
| 4b.3 | Payout record updated | `status=refunded`, `failure_reason='Charge was refunded'` | DB |
| 4b.4 | Balance adjustment created | `type=refund_debit`, `amount=-{net_amount}` | `walker_balance_adjustments` |
| 4b.5 | Walker sees deduction | "Includes X ILS in refund deductions" on wallet card, Balance Adjustments section visible | Walker Dashboard |
| 4b.6 | `create-transfer` rejects future attempts | Returns 400: "Cannot transfer for a refunded job" | Edge function |

### 4c. Refund after paid_out
| # | Step | Expected Result | Verify In |
|---|------|-----------------|-----------|
| 4c.1 | Issue Stripe refund on a job with `status=paid_out` | `charge.refunded` webhook fires | Stripe webhook logs |
| 4c.2 | Payout status updated | `status=refunded` (overrides paid_out) | DB |
| 4c.3 | Balance adjustment created | Negative debit recorded | `walker_balance_adjustments` |
| 4c.4 | Admin sees refunded status | "Refunded" KPI incremented, badge shows in transfers table | Admin Dashboard |
| 4c.5 | Future payout availability reduced | Walker's available balance accounts for the deduction | Walker Dashboard |

### 4d. Duplicate refund webhook
| # | Step | Expected Result | Verify In |
|---|------|-----------------|-----------|
| 4d.1 | Same `charge.refunded` event delivered twice | Second insert to `stripe_events` fails with duplicate | Stripe webhook logs |
| 4d.2 | No duplicate processing | Event skipped, HTTP 200 returned with `duplicate: true` | Webhook response |
| 4d.3 | Balance adjustment idempotent | `unique_refund_per_job` constraint prevents duplicate debit | DB |

---

## 5. Webhook Idempotency

| # | Step | Expected Result | Verify In |
|---|------|-----------------|-----------|
| 5.1 | Replay any webhook event with same `event.id` | `stripe_events` duplicate check triggers | Stripe webhook logs |
| 5.2 | Response is 200 with `duplicate: true` | No DB changes made | Webhook response |
| 5.3 | `payment_intent.succeeded` replayed on already-paid job | Wallet credit is idempotent (`credit_walker_wallet` RPC handles this) | DB |
| 5.4 | `transfer.created` replayed | Payout record already has transfer_id, update is a no-op | DB |

---

## 6. Final Failure (5 retries exhausted)

| # | Step | Expected Result | Verify In |
|---|------|-----------------|-----------|
| 6.1 | Transfer fails 5 consecutive times | `retry_count=5`, `next_retry_at=null`, `status=failed` | DB |
| 6.2 | Walker notified | Notification: "Your payout of X ILS failed after multiple attempts. Our team has been notified." | Notifications |
| 6.3 | `retry-failed-transfers` cron skips it | `retry_count < 5` filter excludes this payout | Edge function logs |
| 6.4 | Admin sees final failure | "Final Failures" KPI shows count > 0 | Admin Dashboard |
| 6.5 | Admin can still manually retry | "Retry" button calls `create-transfer` which does not check retry_count | Admin Dashboard |

---

## 7. Edge Cases

| # | Scenario | Expected Result |
|---|----------|-----------------|
| 7.1 | Walker has no connected Stripe account | Transfer skipped with log warning, no payout record or `failure_reason` set |
| 7.2 | Double-click "Mark Complete" | Second call is idempotent — returns `alreadyCompleted: true` |
| 7.3 | Webhook arrives before capture-payment finishes | `payment_intent.succeeded` handler finds job and marks paid; capture-payment handles already-paid gracefully |
| 7.4 | Job cancelled after payment authorized | `payment_intent.canceled` webhook marks `payment_status=failed`, `status=cancelled` |
| 7.5 | Payout created for wrong connected account | `payout.created` handler finds no matching profile, logs warning, no crash |
| 7.6 | Service temporarily down during transfer | Processing lock prevents race conditions; recovery cron picks up stuck records |

---

## Smoke Test Sequence (Minimum Viable)

Run these in order to validate the core flow works:

1. Create walk request as client (with payment)
2. Accept as walker
3. Complete as walker (captures payment)
4. Verify: job completed+paid, wallet credited, transfer created
5. Check Admin Dashboard: job appears with all Stripe IDs
6. Check Walker Dashboard: earnings show, transfer status visible
7. Issue refund in Stripe Dashboard
8. Verify: webhook fires, job refunded, balance adjustment created, walker balance reduced
