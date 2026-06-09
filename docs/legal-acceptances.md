# Legal Acceptances

## Purpose

This MVP implementation adds durable launch-ready acceptance records for:

- Terms of Service
- Privacy Policy

It is intentionally simple and does not include:

- document editing
- admin versioning UI
- full legal workflow management

## Table Structure

Table: `public.legal_acceptances`

Columns:

- `id`
- `user_id`
- `document_type`
- `document_version`
- `language`
- `accepted_at`
- `metadata`

Key constraints:

- `document_type` is limited to:
  - `terms_of_service`
  - `privacy_policy`
- unique record per:
  - `user_id`
  - `document_type`
  - `document_version`

## Acceptance Flow

### Client onboarding

Before account creation is completed, the user must accept:

- Terms of Service
- Privacy Policy

After successful account creation or OAuth login, Regli records the acceptance.

### Provider onboarding

Before provider onboarding is completed, the user must accept:

- Terms of Service
- Privacy Policy

Providers also see copy clarifying:

- the account owner must be an adult
- the account owner is responsible for payouts and legal agreements

This copy aligns with ADR-001 and is informational. It is not a separate legal document record in this MVP.

## Versioning Strategy

This MVP uses code-defined document versions.

Current versions:

- Terms of Service: `2026-06-launch-v1`
- Privacy Policy: `2026-06-launch-v1`

If the legal text changes in the future, create a new version string in code.
Existing records remain immutable history for the previous version.

## Idempotency

Acceptance writes are idempotent.

The app avoids duplicates by using a unique constraint on:

- `user_id`
- `document_type`
- `document_version`

Retry-safe behavior:

- duplicate submissions do not create extra rows
- pending acceptance context can be retried after signup/OAuth return if needed

## Relationship to ADR-001

ADR-001 states that MVP provider accounts must be adult-owned, with payouts and legal responsibility remaining with the account owner.

This legal acceptance MVP supports that decision by:

- recording client/provider agreement to Terms and Privacy
- showing provider-specific copy that the account owner must be an adult responsible for payouts and legal agreements

It does not implement:

- native minor onboarding
- guardian workflows
- Stripe minor payout handling
