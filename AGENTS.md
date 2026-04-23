# Regli – Agent Instructions

## Project Overview

Regli is an on-demand + scheduled service platform (Uber-style).

Stack:

* React + TypeScript (frontend)
* Supabase (Postgres + Realtime)
* Supabase Edge Functions (dispatch logic)
* Stripe (payments)

Core flows:

1. Client creates request (ASAP or scheduled)
2. Dispatch system assigns walker
3. Walker accepts
4. Tracking starts
5. Job completes

---

## ⚠️ CRITICAL RULES

### DO NOT BREAK:

* ASAP request flow
* Client tracking flow
* Walker acceptance flow
* Notifications system
* History / completed jobs
* Payment flow

### NEVER:

* Introduce race conditions
* Reset state on transient errors
* Break realtime subscriptions
* Clear valid data due to partial updates

---

## State Ownership Rules

* DB is the single source of truth for:

  * requests
  * dispatch_state
  * walker assignment

* Frontend must NEVER invent state

* Frontend may only:

  * reflect DB state
  * optimistically update with rollback

* Realtime must NOT override valid in-memory state with null/empty values

---

## Realtime Rules

* Realtime updates are PARTIAL, not authoritative
* NEVER replace full state from realtime payloads
* ALWAYS merge into existing state

Bad:
setRequests([])

Good:
mergeRequests(prev, incoming)

---

## Dispatch System

Flow:

1. Scheduled job created
2. run-scheduled-dispatch finds jobs
3. start-dispatch creates candidates
4. advance_dispatch_request creates attempts
5. Walker receives request

Important fields:

* status: open / accepted / completed / cancelled
* dispatch_state: queued / dispatched / cancelled
* smart_dispatch_state: idle / dispatching / assigned / exhausted / cancelled

Rules:

* Dispatch must NOT mark job as dispatched without active attempt
* Jobs must remain open until assignment
* No silent state transitions

---

## Time Handling Rules

* NEVER rely on implicit Date parsing
* scheduled_for must reflect exact user selection
* UI must show correct future time
* No timezone drift (+3 / -3 bugs)
* Always store and compare using consistent timezone logic

---

## UI State Rules

* UI must be driven by explicit state machine:

  * idle
  * searching
  * matched
  * tracking
  * completed

* NEVER derive screen state from loose conditions

* ALWAYS use explicit state variable (screenPhase)

* Keep booking form mounted (do not unmount on state changes)

---

## Stripe Rules

* ALWAYS use PaymentIntent currency for transfers

* NEVER hardcode currency

* Transfer must match charge currency

* Prefer source_transaction when possible

* Explicitly handle all states:

  * requires_payment_method
  * requires_capture
  * succeeded
  * canceled

---

## Idempotency & Retry Rules

* Edge functions MUST be idempotent

* Re-running must NOT duplicate:

  * dispatch attempts
  * transfers
  * assignments

* Always check existing state before writing

* Retry logic must be safe and bounded

---

## Database Rules

* NEVER break existing schema behavior
* Prefer additive changes (new columns)
* Always handle null / undefined safely
* Ensure backward compatibility

---

## Logging Rules

* Every edge function must log:

  * request_id
  * action
  * result
  * error (if any)

* Logs must allow tracing full flow:
  request → dispatch → attempt → assignment → completion

---

## Performance Rules

* No white screen on app start
* First interaction must respond < 200ms
* No blocking async on initial render
* Avoid unnecessary re-renders
* Avoid parallel duplicate requests on startup

---

## Debugging Guidelines

When fixing issues:

1. Trace full flow (frontend → backend → DB → realtime)
2. Find root cause (NOT symptom)
3. Search all writes to:

   * status
   * dispatch_state
   * smart_dispatch_state
4. Check Supabase RPC logic
5. Validate walker visibility logic
6. Validate realtime merge behavior (not overwrite)

---

## QA Critical Flows

Must ALWAYS work:

### Client

* Create ASAP request
* Create scheduled request
* Searching state persists correctly
* Walker gets assigned
* Tracking works with live updates
* Completion flow works
* Rating / review works

### Walker

* Receive request
* Accept / reject
* See tracking
* Complete job

### System

* Dispatch triggers correctly
* No duplicate assignments
* No stuck jobs
* Payments captured correctly
* History is accurate

---

## Expected Outcomes

* Scheduled jobs remain open until dispatch
* Dispatch creates candidates + attempts
* Walkers receive jobs reliably
* No premature cancellation
* UI shows correct scheduled time
* ASAP flow remains fast and stable
* No state flickering or resets

