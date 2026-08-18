// Pure, dependency-free helpers describing a provider's PayMe payment-setup state
// (i.e. their PayMe Seller / Hosted Onboarding progress).
//
// NOT to be confused with provider activation READINESS (providerReadiness.ts): that
// is a Regli-only "I want to receive orders" intent flag with zero PayMe cost. This
// module is strictly about the LATER payment-activation stage — the state of a PayMe
// Seller once one has been (or is being) created. Dispatch eligibility depends on
// the chain: registered -> readiness -> payment activation requested -> seller
// created -> PayMe onboarding -> complete. Readiness alone never appears here, and
// nothing in this module reads the readiness flag.
//
// COST INVARIANT: creating a PayMe Seller incurs a per-provider setup cost charged
// to Regli. These helpers only READ existing, already-persisted seller state — they
// never create anything. Seller creation happens exclusively behind the explicit
// payment-activation action (see providerActivation.ts). Do not add any
// create/network call here.
//
// Phase 2C NOTE: PayMe's official seller approval / status contract is not yet
// implemented. We therefore do NOT invent an "approved" status. Paid-order
// eligibility is derived ONLY from states already representable in the current
// schema (profiles.payme_onboarding_status CHECK:
// not_started | creating | created | pending | completed | failed). Until Phase 2C
// maps a definitive readiness signal, a provider stays BLOCKED from paid-order
// activation unless the status is the schema's terminal-complete value.

export interface PaymeSellerSnapshot {
  // profiles.payme_seller_id
  paymeSellerId?: string | null
  // profiles.payme_onboarding_status
  onboardingStatus?: string | null
  // provider_payment_onboarding.payme_signup_url (owner-scoped, private)
  signupUrl?: string | null
}

// UI-facing setup state. Deliberately NOT a claim of PayMe approval.
export type PaymePaymentSetupState =
  | 'not_started' // no seller yet — provider must explicitly activate
  | 'creating' // a seller creation attempt is in flight (concurrency claim)
  | 'in_progress' // seller exists; provider must finish PayMe Hosted Onboarding
  | 'complete' // definitively complete per existing schema (status === 'completed')

function asNonEmpty(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/**
 * Classify the provider's PayMe setup state from persisted data only.
 *
 *  - no seller id                      -> 'not_started' (also covers a prior 'failed'
 *                                          attempt, which is safely retryable)
 *  - status 'completed'                -> 'complete'
 *  - status 'creating'                 -> 'creating'
 *  - seller id + created/pending/other -> 'in_progress' (resume Hosted Onboarding)
 */
export function resolvePaymeSetupState(
  snapshot: PaymeSellerSnapshot | null | undefined,
): PaymePaymentSetupState {
  const sellerId = asNonEmpty(snapshot?.paymeSellerId)
  const status = asNonEmpty(snapshot?.onboardingStatus)

  if (status === 'completed') return 'complete'
  if (!sellerId) return 'not_started'
  if (status === 'creating') return 'creating'
  if (status === 'failed') return 'not_started'
  return 'in_progress'
}

/**
 * Whether the provider is eligible to receive PAID orders via PayMe.
 *
 * Payment activation (this) is INTENTIONALLY distinct from availability
 * configuration: a provider may configure services/availability with setup
 * incomplete, but must not be paid-order eligible until setup is definitively
 * complete. Until Phase 2C provides real approval semantics, only the schema's
 * terminal-complete status qualifies — so this stays false for every provider
 * whose setup has not been marked complete by a future, trusted reconciliation.
 */
export function isPaymePaidOrderEligible(
  snapshot: PaymeSellerSnapshot | null | undefined,
): boolean {
  return resolvePaymeSetupState(snapshot) === 'complete'
}

/**
 * Whether the provider should RESUME an existing PayMe Hosted Onboarding session
 * (a seller already exists and we hold a private signup URL) rather than starting a
 * brand-new seller creation. Prevents creating (and paying for) a second Seller.
 */
export function shouldResumePaymeSetup(
  snapshot: PaymeSellerSnapshot | null | undefined,
): boolean {
  const state = resolvePaymeSetupState(snapshot)
  return (state === 'in_progress' || state === 'creating') && !!asNonEmpty(snapshot?.signupUrl)
}

/**
 * Whether an explicit activation action is allowed to attempt NEW seller creation.
 * True only when no seller exists yet (or a prior attempt failed). An existing
 * seller must never be recreated — the edge function is idempotent, but we also
 * gate here so the UI resumes instead of re-invoking.
 */
export function canCreatePaymeSeller(
  snapshot: PaymeSellerSnapshot | null | undefined,
): boolean {
  return resolvePaymeSetupState(snapshot) === 'not_started'
}
