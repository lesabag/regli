# Regli Launch Readiness Audit

Date: 2026-06-08
Status: Reviewed / Practical Founder Version

## Executive Summary

Launch readiness score: **80/100**

Regli is close to a controlled MVP launch. The core marketplace engine is materially stronger than a typical early MVP:

- Client booking flows exist and have been heavily tested.
- Provider onboarding, availability, online/offline, pricing preferences, and offer handling are in place.
- Dispatch reliability was recently improved with timeout auto-advance, cron backup hardening, and regression coverage.
- Push notifications, localization, payments, scheduled orders, recurring orders, pricing guidance, and admin tooling already exist.
- Provider performance audit showed stable CPU, memory, and network behavior.
- Provider minors strategy is now documented in ADR-001.

The product does not need more feature breadth before launch. The remaining work is mainly launch packaging, legal readiness, security review, and operational confidence.

## Launch Recommendation

Regli can move toward a **controlled launch** after the P0 items below are completed and validated on real devices with sandbox payments and real dispatch scenarios.

Recommended launch posture:

- Launch with parent-owned provider accounts for cases where minors perform the service.
- Do not implement native minor onboarding in MVP.
- Keep the service scope focused.
- Prioritize trust, payments, dispatch, and push reliability over additional features.

---

# P0 Launch Blockers

These should be closed before public launch.

## 1. Terms and Privacy acceptance

- Severity: **P0**
- Area: **Legal / Onboarding / App Store readiness**
- Impact: Users currently do not have a durable acceptance record for Terms and Privacy during onboarding. This creates legal, trust, and App Store review risk.
- Recommendation:
  - Add Terms and Privacy acceptance to client and provider onboarding.
  - Store durable acceptance records with document type, version, timestamp, actor/profile id, language, and source surface.
  - Keep this minimal for MVP.

Minimum MVP scope:

- Terms of Service acceptance
- Privacy Policy acceptance
- Versioned storage
- Required checkbox before account completion

Do not overbuild a full legal document management system yet.

## 2. Edge Functions security review

- Severity: **P0**
- Area: **Security / Backend / Supabase Edge Functions**
- Impact: Several sensitive functions use `verify_jwt = false`. Some likely need this for Stripe/webhook/internal invocation patterns, but every public edge function must have a clear auth contract before launch.
- Recommendation:
  - Review every edge function with `verify_jwt = false`.
  - Classify each function as one of:
    - public webhook with signature verification
    - authenticated user flow with internal profile/role validation
    - service-role-only/internal flow
    - admin-only flow
  - Add missing internal auth checks where needed.
  - Document the invocation boundary.

This is not necessarily a bug, but it is a launch-critical audit item.

## 3. Dispatch monitoring and recovery checks

- Severity: **P0**
- Area: **Dispatch / Marketplace reliability**
- Impact: Dispatch is the heart of the marketplace. Recent timeout bugs were fixed, but the system should be monitored before real users rely on it.
- Recommendation:
  - Keep the new timeout auto-advance behavior.
  - Keep cron as backup repair, not primary timing mechanism.
  - Add or document a simple operational check for stuck attempts.
  - Before launch, repeatedly verify:

```sql
select *
from dispatch_attempts
where status = 'pending'
  and expires_at < now();
```

Expected result: **0 rows**.

Also verify real E2E scenarios:

- first provider ignores → second provider receives offer within roughly 12–20 seconds
- all candidates ignore → client reaches correct exhausted/no-provider state
- client cancel cleans up active attempts correctly

---

# P1 Important Issues

These are important, but should not block a controlled MVP launch if P0 is handled.

## 1. Payment lifecycle QA

- Severity: **P1**
- Area: **Payments / Stripe / Payouts**
- Impact: Money movement bugs are expensive and damage trust.
- Recommendation: Run a focused sandbox payment checklist before launch.

Checklist:

- Add card
- Apple Pay if enabled
- Payment intent creation
- Payment confirmation
- Capture / completion
- Cancellation before acceptance
- Cancellation after acceptance, if supported
- Refund path
- Tip flow
- Provider payout / transfer path
- Failed payment handling
- Stripe webhook idempotency

## 2. Push notification real-device QA

- Severity: **P1**
- Area: **Mobile / Push / Provider responsiveness**
- Impact: Provider response depends heavily on push delivery. Silent push failures can make dispatch look broken.
- Recommendation: Run a real-device push matrix.

Checklist:

- Client foreground
- Client background
- Provider foreground
- Provider background
- Push permission denied
- Token rotation / logout / login
- Deep link opens correct screen
- Hebrew and English copy
- New offer push
- Accepted / arrived / completed push
- Rating / tip push

## 3. Scheduled and recurring E2E QA

- Severity: **P1**
- Area: **Scheduled / Recurring / Dispatch timing**
- Impact: Delayed flows are harder to detect because failures occur later.
- Recommendation: Validate these flows end-to-end.

Checklist:

- Create scheduled booking
- Scheduled dispatch wakes up at the right time
- Provider receives offer
- Client sees correct searching/tracking state
- Recurring booking creates next occurrence once
- No duplicate recurring jobs
- Cancel scheduled booking
- Provider unavailable at scheduled time

## 4. Basic operations handbook

- Severity: **P1**
- Area: **Admin / Operations**
- Impact: When something goes wrong, the team needs a simple runbook.
- Recommendation: Create a short `docs/operations/` handbook.

Minimum topics:

- Stuck dispatch request triage
- Payment/refund issue triage
- Payout issue triage
- Push delivery issue triage
- Dispute handling
- Admin emergency actions

## 5. RLS and GRANT audit

- Severity: **P1**
- Area: **Database security**
- Impact: Recent migrations added many tables and RPCs. A final security pass reduces launch risk.
- Recommendation:
  - Confirm every public table has intentional RLS.
  - Confirm every public RPC has intentional grants.
  - Confirm admin-only flows remain admin-only.
  - Confirm no accidental anonymous write path exists.
  - Continue adding explicit GRANTs for new public tables/functions, per Supabase policy changes.

---

# P2 Nice To Have

These are valuable but should not delay MVP launch.

## 1. Top-level README cleanup

- Severity: **P2**
- Area: **Developer experience**
- Recommendation: Replace boilerplate README with a short system overview later.

## 2. Extended analytics dashboards

- Severity: **P2**
- Area: **Product analytics**
- Recommendation: Improve funnel, no-provider, payment abandonment, and provider activation analytics after real usage begins.

## 3. Broader mobile QA matrix

- Severity: **P2**
- Area: **QA**
- Recommendation: Maintain a living matrix for iPhone models, iOS versions, permissions, and background behavior.

## 4. Marketplace health dashboards

- Severity: **P2**
- Area: **Operations**
- Recommendation: Add richer dashboards after launch usage creates meaningful data.

---

# Not Launch Blockers

## Native minor onboarding

Native minor onboarding is **not** required for MVP.

Decision is documented in:

`docs/adr/ADR-001-provider-minors-strategy.md`

Current MVP policy:

- No native minor onboarding in MVP.
- Provider account owner must be an adult.
- Parents may create and manage provider accounts on behalf of minors.
- Payments, Stripe onboarding, and legal agreements remain with the account owner.

Therefore, Regli does not need to build the following before MVP launch:

- minor DOB gate
- guardian consent flow
- minor Stripe flow
- minor-specific provider accounts
- native under-18 payout handling

This can be revisited after product-market fit, provider growth, and official Stripe guidance for Israel.

## Full provider agreement system

A full provider agreement flow is useful, but for MVP it can be folded into Terms / Provider terms copy if needed.

The immediate blocker is durable Terms and Privacy acceptance, not a full contract-management system.

---

# Key Risks

## Technical risks

- Dispatch remains business-critical and should be monitored closely.
- Edge-function auth boundaries must be explicitly reviewed.
- Payment states and Stripe async behavior require disciplined QA.
- Scheduled and recurring flows may fail later and require delayed validation.

## Product risks

- Thin supply can hurt client trust even if the app works correctly.
- No-provider messaging must be clear and fast.
- Provider onboarding friction must remain low.
- Parent-owned provider account policy must be communicated clearly enough to avoid confusion.

## Operational risks

- Launch support will depend on admin tooling and simple SQL/runbooks.
- Push failures can look like dispatch failures.
- Payment/payout incidents require fast manual triage.

---

# Recommended Next 30 Days

## Week 1 — Close P0

1. Implement Terms and Privacy acceptance.
2. Complete edge-function security review.
3. Add/document dispatch stuck-attempt monitoring.
4. Run dispatch E2E with two providers multiple times.

## Week 2 — Money and mobile confidence

1. Run full sandbox payment QA.
2. Run real-device push matrix.
3. Validate provider lifecycle on real iPhone.
4. Validate client cancellation and no-provider states.

## Week 3 — Async flows

1. Validate scheduled bookings end-to-end.
2. Validate recurring bookings end-to-end.
3. Confirm cron jobs are active and producing expected effects.
4. Confirm no stale pending attempts after repeated tests.

## Week 4 — Launch rehearsal

1. Create a clean test account set:
   - client
   - provider 1
   - provider 2
   - admin
2. Run complete launch rehearsal:
   - signup
   - payment setup
   - provider onboarding
   - dispatch
   - lifecycle
   - completion
   - rating
   - tip
   - payout/admin checks
3. Final go/no-go review.

---

# Final Assessment

Regli is not blocked by product functionality. The main remaining work is launch hardening.

Current practical score: **80/100**

Launch can be considered after:

- Terms and Privacy acceptance is implemented
- edge-function auth boundaries are reviewed
- dispatch monitoring/checks are in place
- payment and push QA pass on real devices

Regli is now closer to controlled launch readiness than to early MVP construction.
