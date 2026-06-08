# ADR-001 – Provider Minors Strategy

Date: 2026-06-08

Status: Accepted

## Context

Regli expects a significant percentage of service providers
(babysitters and dog walkers) to be between ages 14–17.

We evaluated native minor onboarding using Stripe Connect.

Research indicated that Stripe minor onboarding support
is country-dependent and Israel support is unclear or not officially documented.

Implementing native minor onboarding would require:

* Guardian consent flows
* Minor-specific onboarding
* Additional legal requirements
* Additional compliance handling
* Additional support burden

We also evaluated the operational reality that many minors performing babysitting and dog walking services already operate under parental supervision and financial responsibility.

## Decision

No native minor onboarding in MVP.

Provider account owner must be an adult.

Parents may create and manage provider accounts on behalf of minors.

Payments, Stripe onboarding and legal agreements remain with the account owner.

For MVP:

* Provider account = Parent account
* Stripe account = Parent account
* Payout recipient = Parent account
* Legal responsibility = Account owner
* Minor may perform the service under the parent's responsibility

## Consequences

### Pros

* Simpler onboarding
* Faster launch
* Lower legal complexity
* Lower compliance burden
* No dependency on Stripe minor support
* No guardian workflow required
* No minor-specific payout architecture required

### Cons

* Minor providers do not have their own platform accounts
* Future guardian flow may still be required
* Future minor-specific identity verification may still be required

## Alternatives Considered

### Option A — Native Minor Accounts

Rejected for MVP.

Would require:

* Guardian consent flow
* Minor-specific onboarding
* Additional legal review
* Additional compliance work
* Additional Stripe validation

### Option B — Parent-Owned Provider Accounts

Accepted.

Provides the lowest-risk and fastest path to launch.

## Revisit

Re-evaluate after:

* Product-market fit
* Significant provider growth
* Official Stripe guidance for Israel
* Expansion to additional countries
* Future trust and safety requirements

## Related Topics

Future ADRs may cover:

* Legal Acceptances
* Terms & Privacy Versioning
* Provider Verification Strategy
* Trust & Safety Framework
* Emergency Contact Policy
* Marketplace Compliance Strategy
