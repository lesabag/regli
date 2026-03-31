# Payout System Staged Rollout Plan

Three-phase rollout to minimize risk and validate the system under real production load.

---

## Overview

The `live_payouts_enabled` flag on the `profiles` table controls which walkers receive live Stripe transfers. This flag is toggled per-walker by an admin via the Operations Dashboard (Users section) or directly in the database.

**Walkers without the flag:** Still get wallet credits on job completion. Stripe transfers are simply skipped. No user-facing errors — the existing payment flow works as before.

**Walkers with the flag:** Full end-to-end flow — wallet credit + Stripe transfer to their connected account.

---

## Phase 1: Internal / Test Walkers

**Duration:** 3-5 days

### Entry Criteria
- [ ] Release checklist 100% complete
- [ ] All migrations applied to production
- [ ] Cron jobs running and verified
- [ ] Stripe webhook receiving events
- [ ] 1-2 internal/team walkers with completed Stripe Connect onboarding

### Actions
```sql
-- Enable for specific internal walkers
UPDATE profiles SET live_payouts_enabled = true
WHERE id IN ('<internal-walker-id-1>', '<internal-walker-id-2>');
```

### Monitoring Expectations
- 0 stuck processing payouts
- 0 unexpected failures (failures from bad test data are OK)
- All transfers resolve to `transferred` or `paid_out` within 48h
- Refund test produces correct balance adjustment
- Cron jobs executing every 5/10 minutes without errors

### Success Criteria to Advance
- [ ] At least 3 successful end-to-end payment cycles (create -> capture -> transfer -> paid_out)
- [ ] At least 1 refund cycle tested (refund -> balance adjustment -> walker sees deduction)
- [ ] At least 1 retry cycle tested (failure -> automatic retry -> success)
- [ ] No stuck processing for more than 1 cron cycle
- [ ] Admin Dashboard shows correct data for all KPIs

### Rollback Triggers
- Transfer created with wrong amount
- Duplicate transfers for same job
- Wallet balance inconsistent with transfer records
- Webhook processing errors > 5% of events
- Any data corruption in `walker_payouts` or `walker_balance_adjustments`

---

## Phase 2: Limited Beta Walkers

**Duration:** 5-7 days

### Entry Criteria
- [ ] Phase 1 success criteria met
- [ ] No open bugs from Phase 1
- [ ] At least 3 days of clean Phase 1 operation

### Actions
```sql
-- Enable for beta walkers (those with completed onboarding + payouts enabled)
UPDATE profiles SET live_payouts_enabled = true
WHERE role = 'walker'
  AND payouts_enabled = true
  AND charges_enabled = true
  AND stripe_connect_onboarding_complete = true;
```

Or selectively enable 5-10 active walkers via the Admin Dashboard toggle.

### Monitoring Expectations
- Failed transfer rate < 5% of total transfers
- Retry success rate > 80% (retries that eventually succeed)
- Stuck processing count stays at 0 between cron cycles
- No balance inconsistencies
- Check daily:
  - `SELECT status, count(*) FROM walker_payouts GROUP BY status;`
  - `SELECT count(*) FROM walker_balance_adjustments;`
  - Admin Dashboard KPI row

### Success Criteria to Advance
- [ ] At least 20 successful end-to-end payment cycles across multiple walkers
- [ ] Failed transfer rate < 2% after retries
- [ ] No manual intervention required for any transfer
- [ ] Refund deductions working correctly across multiple walkers
- [ ] Walker Dashboard earnings match DB records
- [ ] At least 5 days of clean operation

### Rollback Triggers
- Failed transfer rate > 10% sustained for 24h
- Any case where walker receives incorrect amount
- Balance adjustment not created after refund
- Admin Dashboard KPIs diverge from DB reality
- Walker complaints about missing or incorrect earnings
- Any security issue (unauthorized transfer, wrong destination)

---

## Phase 3: Full Rollout

**Duration:** Ongoing

### Entry Criteria
- [ ] Phase 2 success criteria met
- [ ] No open bugs from Phase 2
- [ ] At least 5 days of clean Phase 2 operation
- [ ] Team confidence in system stability

### Actions
```sql
-- Enable for all walkers with completed onboarding
UPDATE profiles SET live_payouts_enabled = true
WHERE role = 'walker'
  AND stripe_connect_onboarding_complete = true;
```

Optionally, set the default for new walkers who complete onboarding. Update the `account.updated` webhook handler to auto-enable:

```sql
-- Make live payouts the default for new onboarded walkers
-- (apply after Phase 3 entry criteria met)
ALTER TABLE profiles ALTER COLUMN live_payouts_enabled SET DEFAULT true;
```

### Monitoring
- Continue daily checks for first 2 weeks
- Move to weekly checks after 2 clean weeks
- Keep cron jobs running permanently
- Set up alerts if available:
  - Stuck processing > 0 for more than 30 minutes
  - Failed transfers > 5 in any 1-hour window
  - Final failures (retry_count >= 5) > 0

### Rollback
Same as Phase 2 — disable `live_payouts_enabled` globally if needed. Existing in-flight transfers continue normally through Stripe.

---

## Rollback Quick Reference

| Severity | Action | Command |
|----------|--------|---------|
| Pause new transfers | Disable flag globally | `UPDATE profiles SET live_payouts_enabled = false WHERE role = 'walker';` |
| Pause retries | Unschedule cron | `SELECT cron.unschedule('retry-failed-transfers');` |
| Pause recovery | Unschedule cron | `SELECT cron.unschedule('recover-stuck-payouts');` |
| Full stop | All of the above | Run all three commands |
| Resume | Re-enable | Reverse the commands above |

**Important:** Disabling the flag does NOT affect:
- Already-completed transfers (they continue through Stripe)
- Wallet credits (walkers still get credited on job completion)
- Payment capture (clients still pay, walkers still complete jobs)

The only thing that stops is the creation of new Stripe transfers.
