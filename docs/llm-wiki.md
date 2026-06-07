# Regli LLM Wiki

# Wiki Governance

This document is the long-term source of truth for Regli.

Only add rules that are expected to remain valid for at least 3 months.

Before adding a rule, ask:

"Would we still want Codex to follow this rule 3–6 months from now?"

If the answer is not clearly yes, do not add it.

Do not add:

* temporary workarounds
* branch-specific notes
* implementation details
* backlog items
* future ideas
* debugging notes
* one-off migration instructions

Prefer durable:

* product decisions
* UX principles
* architecture rules
* matching rules
* testing expectations
* engineering standards

When a task is completed:

Do not automatically modify this file.

Instead propose:

Wiki candidates:

* candidate 1
* candidate 2
* candidate 3

and wait for approval before updating the wiki.


# Current Launch Scope

Client-facing services currently exposed:

- dog_walker
- baby_sitter

Additional services may exist in the codebase but remain hidden until launch readiness.

Do not remove future services from the architecture.
Hide them from the client UI until explicitly enabled.

## Product Identity

Regli is a general services marketplace.

Do not assume dog-walking specific behavior unless explicitly working on dog-walker flows.

Future services may include:

* Dog Walking
* Babysitter
* Electrician
* Cleaner
* Technician
* Additional service categories

Always prefer generic marketplace abstractions when possible.

---

## Core UX Principles

Preferred pattern:

Selector Pills
→ Single Active Card
→ Focused Editing

Favor:

* Compact layouts
* Mobile-first design
* Reduced visual density
* Premium iOS-style interactions

Avoid:

* Large forms
* Multiple nested cards
* Excessive vertical spacing

---
## Mobile UX

- Compact mobile sliders should keep a generous touch target.
- Nearby summary labels must not intercept slider pointer events.
- Prefer touch reliability over visual compactness.

## Launch Service Visibility

- Launch-visible services must be controlled from one shared allowlist.
- Hidden future services may remain in code and existing records.
- Future services must stay non-selectable in launch-facing UI until explicitly enabled.
- Client and provider service selectors must derive visible services from the same launch configuration.


## Development Rules

Unless explicitly requested:

Do NOT modify:

* Matching logic
* Dispatch logic
* Payment flows
* Availability logic
* Existing production database behavior

Keep changes focused on the requested scope.

---

## Database Rules

Never modify historical migrations.

Always create a new migration.

For new public tables:

* Create RLS policies
* Add explicit GRANT statements
* Follow least-privilege access

Build must pass before completion.

---

## Provider Model

Provider configuration is per service.

Examples:

Dog Walking:

* availability
* pricing
* capabilities

Babysitter:

* availability
* pricing
* capabilities

Do not assume settings are shared across services.

---

## Dog Size Rules

Valid values:

* S
* M
* L

Display only:

Hebrew:

* קטן
* בינוני
* גדול

English:

* Small
* Medium
* Large

Store only:

* S
* M
* L

---

## Matching Rules

Dog size matching applies only to dog_walker.

Rules:

1. Provider with no size preferences:
   accepts all dog sizes.

2. Provider with selected sizes:
   must support all known client dog sizes.

3. Unknown dog size:
   does not block matching.

4. Multi-dog requests:
   all known dog sizes must be compatible.

---

## Client Rules

Dog size belongs to the dog profile.

Dog size is not entered for every booking.

Selected dogs are the source of truth.

Name text fields must not become the source of truth for dog selection.

---

## UI Consistency

Preferred controls:

* Selector pills
* Compact cards
* Inline editing
* Lightweight payment rows
* Compact availability summaries

Avoid introducing new UI patterns when existing Regli patterns already solve the problem.

---

## Test Safety

- Smoke tests that can create live dispatch, payment, or notification side effects must require an explicit opt-in environment guard.
- Side-effecting integration tests must refuse to run against production-like service URLs and should default to safe skip behavior.
- Tests that create marketplace rows in shared infrastructure must clean up related records in `finally`, using a run-scoped identifier.

---

## QA Expectations

Required before completion:

* npm run build passes

When applicable:

* Relevant tests pass

Return:

FULL updated files only.

No partial snippets.
