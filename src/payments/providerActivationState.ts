// AUTHORITATIVE provider payment-activation state model (CLIENT copy).
//
// One state model — do NOT scatter activation booleans across components. The
// server holds the source of truth (provider_activation.activation_state); the
// client mirrors this enum only to render UX and to gate which action it may
// request. A parity test (tests/payme-provider-activation-orchestration.test.ts)
// guarantees this list stays identical to the server copy in
// supabase/functions/_shared/paymeActivation.ts.
//
// These are Regli-INTERNAL orchestration states. They are NOT PayMe external
// seller statuses — we deliberately avoid inventing PayMe's approval vocabulary.
//
// Phase 2C boundary: `kyc_approved` may ONLY be set from a verified PayMe
// seller-readiness signal (see markProviderKycApprovedFromVerifiedPaymeStatus on
// the server). It must NEVER be inferred from an undocumented callback. Until that
// signal is verified in the Personal Sandbox, providers never reach `payment_ready`.

export const PROVIDER_ACTIVATION_STATES = [
  'not_started', // provider registered; no activation intent yet
  'ready', // provider marked "ready to receive orders" (Regli-only, no PayMe cost)
  'fee_authorizing', // J5 authorization for the activation fee is in flight
  'fee_authorized', // J5 authorization confirmed (amount reserved, NOT captured)
  'seller_creating', // create-payme-seller in flight (only after fee_authorized)
  'seller_created', // PayMe Seller exists; ready to start Hosted Onboarding
  'kyc_pending', // provider sent to PayMe Hosted Onboarding / KYC; awaiting result
  'kyc_approved', // VERIFIED PayMe seller readiness (Phase 2C only)
  'fee_capturing', // capture-sale in flight
  'fee_captured', // activation fee captured
  'payment_ready', // TERMINAL success — provider may receive paid orders
  'authorization_expired', // 168h window elapsed with no capture; re-authorize needed
  'activation_failed', // a step failed; safely retryable
  'cancelled', // provider cancelled / rejected; authorization voided
] as const

export type ProviderActivationState = (typeof PROVIDER_ACTIVATION_STATES)[number]

// Seller / KYC verification lifecycle — tracked INDEPENDENTLY of the activation
// (fee-authorization) state above, so KYC approval survives J5 expiry and a single
// enum never has to represent both facts at once. Regli-INTERNAL normalized
// statuses (NOT PayMe external status names). Mirrors the server list in
// supabase/functions/_shared/paymeActivation.ts (guaranteed by the parity test).
// `approved` is set ONLY via the verified Phase-2C seam on the server.
export const SELLER_VERIFICATION_STATUSES = [
  'not_started',
  'pending',
  'approved',
  'rejected',
] as const

export type SellerVerificationStatus = (typeof SELLER_VERIFICATION_STATUSES)[number]

/** Whether the PayMe Seller has completed KYC (verified), independent of the fee. */
export function isSellerKycApproved(
  status: SellerVerificationStatus | null | undefined,
): boolean {
  return status === 'approved'
}

/** The one and only condition under which a provider may receive PAID orders. */
export function isProviderPaymentReady(
  state: ProviderActivationState | null | undefined,
): boolean {
  return state === 'payment_ready'
}

/**
 * States from which the provider may START (or RE-start) a J5 authorization.
 * Never while an authorization/seller/capture is already in flight, and never
 * once payment_ready. `authorization_expired` is included: re-authorization is
 * the documented recovery path (a NEW J5, reusing the existing Seller).
 */
export function canRequestActivationAuthorization(
  state: ProviderActivationState | null | undefined,
): boolean {
  return (
    state === 'not_started' ||
    state === 'ready' ||
    state === 'authorization_expired' ||
    state === 'activation_failed' ||
    state === 'cancelled'
  )
}

/** create-payme-seller may run ONLY once the fee authorization is confirmed. */
export function canCreateSellerForActivation(
  state: ProviderActivationState | null | undefined,
): boolean {
  return state === 'fee_authorized'
}

/** Capture is allowed ONLY after VERIFIED KYC approval, and only once. */
export function canCaptureActivationFee(
  state: ProviderActivationState | null | undefined,
): boolean {
  return state === 'kyc_approved'
}

/**
 * Whether an outstanding (uncaptured) authorization exists that can be voided.
 * There is nothing to void before authorization, and NO void after capture
 * (post-capture refunds are out of scope for this phase — see TASK 14).
 */
export function canVoidActivation(
  state: ProviderActivationState | null | undefined,
): boolean {
  return (
    state === 'fee_authorizing' ||
    state === 'fee_authorized' ||
    state === 'seller_creating' ||
    state === 'seller_created' ||
    state === 'kyc_pending' ||
    state === 'kyc_approved'
  )
}

/** Whether the 168h authorization window has elapsed at `nowIso`. */
export function isActivationAuthorizationExpired(
  expiresAtIso: string | null | undefined,
  nowIso: string,
): boolean {
  if (!expiresAtIso) return false
  const expires = Date.parse(expiresAtIso)
  const now = Date.parse(nowIso)
  if (Number.isNaN(expires) || Number.isNaN(now)) return false
  return expires <= now
}
