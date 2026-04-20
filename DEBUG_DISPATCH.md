# DEBUG – Scheduled Order Does Not Reach Walker

## Current Bug

Scheduled / future order is created successfully.

The scheduled time arrives correctly.

But no walker receives the order.

---

## What the user sees

- Client creates a future order
- Order is saved
- When the scheduled time arrives, client UI may move into searching / tracking
- But no walker actually receives any incoming request
- Walkers are online / available

---

## What is already known

- This is NOT a basic availability issue
- Walkers are available
- Scheduled order time is reached correctly
- The bug is in the dispatch pipeline or walker-side visibility

---

## Expected Flow

1. Client creates scheduled order
2. Order stays queued/passive until dispatch time
3. At the correct time, dispatch starts
4. Dispatch creates candidates
5. Dispatch creates attempts
6. Walker receives incoming request
7. Walker can accept
8. Only then should client move into real active flow

---

## Actual Broken Flow

1. Client creates scheduled order
2. Dispatch time arrives
3. Client side may behave as if dispatch started
4. But no walker receives the order
5. Scheduled order flow is broken

---

## Main Goal

Find the exact point where the scheduled-dispatch pipeline stops.

Pipeline to trace:

scheduled job
-> run-scheduled-dispatch
-> start-dispatch
-> advance_dispatch_request
-> dispatch_candidates
-> dispatch_attempts
-> walker incoming job visibility

---

## The agent must PROVE where the flow stops

One of these must be identified:

A. run-scheduled-dispatch does not select the job  
B. start-dispatch is not invoked  
C. dispatch_candidates are not created  
D. dispatch_attempts are not created  
E. attempts exist but walker UI does not show them  
F. job is cancelled / exhausted too early

Do NOT guess.
Find the real stop point.

---

## Files to inspect first

Frontend:
- src/hooks/useClientFlow.ts
- src/screens/ClientDashboard.tsx
- src/screens/WalkerDashboard.tsx
- any walker hooks / subscriptions / incoming jobs logic

Backend:
- supabase/functions/run-scheduled-dispatch/index.ts
- supabase/functions/start-dispatch/index.ts

Database / SQL:
- advance_dispatch_request
- any dispatch cleanup / cancel / expire logic
- any trigger or cron that changes:
  - status
  - dispatch_state
  - smart_dispatch_state

---

## Required checks

For the latest scheduled request:

1. Was it selected by run-scheduled-dispatch?
2. Was start-dispatch called?
3. Were dispatch_candidates inserted?
4. Were dispatch_attempts inserted?
5. If inserted, why does walker UI not show them?
6. If not inserted, exactly where did the flow stop?
7. Is there any wrong walker-side filter for scheduled jobs?
8. Is there any premature state change to cancelled / exhausted?

---

## Search all writes to these fields

- status
- dispatch_state
- smart_dispatch_state

Especially search for:

- status = 'open'
- status = 'accepted'
- status = 'cancelled'
- dispatch_state = 'queued'
- dispatch_state = 'dispatched'
- dispatch_state = 'cancelled'
- smart_dispatch_state = 'idle'
- smart_dispatch_state = 'dispatching'
- smart_dispatch_state = 'assigned'
- smart_dispatch_state = 'exhausted'
- smart_dispatch_state = 'cancelled'

---

## Required fix outcome

After the fix:

- Scheduled order stays valid until dispatch time
- Dispatch starts correctly
- dispatch_candidates are created
- dispatch_attempts are created
- Walker actually receives the order
- Client does not enter fake active flow before real dispatch
- ASAP flow remains unchanged

---

## Agent instructions

- Focus ONLY on this bug
- Do NOT do broad refactors
- Do NOT change unrelated UX
- Do NOT break:
  - ASAP flow
  - tracking
  - walker acceptance
  - notifications
  - history
  - payments

Return:
- FULL updated files only
- exact file paths
- SQL migration only if truly required
- minimal explanation
