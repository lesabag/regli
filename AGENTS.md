# Regli – Agent Instructions

## Project Overview
Regli is an on-demand + scheduled service platform (Uber-style).

Stack:
- React + TypeScript (frontend)
- Supabase (Postgres + Realtime)
- Supabase Edge Functions (dispatch logic)
- Stripe (payments)

Core flows:
1. Client creates request (ASAP or scheduled)
2. Dispatch system assigns walker
3. Walker accepts
4. Tracking starts
5. Job completes

---

## ⚠️ CRITICAL RULES

### DO NOT BREAK:
- ASAP request flow
- Client tracking flow
- Walker acceptance flow
- Notifications system
- History / completed jobs
- Payment flow

---

## Dispatch System

Flow:
1. Scheduled job created
2. run-scheduled-dispatch finds jobs
3. start-dispatch creates candidates
4. advance_dispatch_request creates attempts
5. Walker receives request

Important fields:
- status: open / accepted / completed / cancelled
- dispatch_state: queued / dispatched / cancelled
- smart_dispatch_state: idle / dispatching / assigned / exhausted / cancelled

---

## Time Handling Rules

- NEVER rely on implicit Date parsing
- scheduled_for must reflect exact user selection
- UI must show correct future time
- No timezone drift (+3 / -3 bugs)

---

## Code Requirements

- ALWAYS return FULL files (no snippets)
- NEVER shorten files
- TypeScript must pass build
- Keep existing logic intact unless required
- Prefer minimal, safe fixes

---

## Debugging Guidelines

When fixing issues:
1. Trace full flow (frontend → backend → DB → realtime)
2. Find root cause (not symptom)
3. Search all writes to:
   - status
   - dispatch_state
   - smart_dispatch_state
4. Check Supabase RPC logic
5. Validate walker visibility logic

---

## Expected Outcomes

- Scheduled jobs remain open until dispatch
- Dispatch creates candidates + attempts
- Walkers receive jobs
- No premature cancellation
- UI shows correct scheduled time
- ASAP flow unaffected
