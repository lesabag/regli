import type { CreateSellerAccountResponse } from './types'

// Pure, dependency-free activation-result logic. Kept separate from
// providerActivation.ts (which imports PaymentService -> the Supabase client) so
// the outcome mapping is deterministic and unit-testable with no network/env.
//
// COST INVARIANT: nothing here creates a PayMe Seller. This module only
// INTERPRETS the response of a seller-creation call that already happened behind
// the explicit activation boundary.

export type ProviderPaymentActivationOutcome =
  // A seller now exists (created just now or already existed) AND we hold a
  // private signup URL to (re)start PayMe Hosted Onboarding.
  | 'onboarding_ready'
  // A seller exists but no signup URL is available yet (rare / transitional).
  | 'seller_ready'
  // The server flag is off: no seller was created (no cost). Payment setup is
  // not available yet — a safe, non-error "come back later" state.
  | 'setup_unavailable'
  // The explicit activation attempt failed; safe to retry. Regli account intact.
  | 'error'

export interface ProviderPaymentActivationResult {
  ok: boolean
  outcome: ProviderPaymentActivationOutcome
  // Owner-scoped PayMe Hosted Onboarding URL, when available. Never persisted or
  // logged by the client beyond navigating the owning provider to it.
  signupUrl: string | null
  sellerId: string | null
  onboardingStatus: string | null
  // True when the server flag left the operation a no-op (nothing created).
  skipped: boolean
  // Present only when outcome === 'error'. Safe, non-sensitive message for UI.
  error?: string
}

// Shape of the client-safe edge response carried in CreateSellerAccountResponse.raw
// (see PayMeProvider / supabase/functions/create-payme-seller). Never includes any
// PayMe secret.
type PaymeSellerRaw = {
  success?: boolean
  skipped?: boolean
  sellerPaymeId?: string | null
  onboardingStatus?: string | null
  signupUrl?: string | null
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/**
 * Pure mapping from the create-seller response to an activation result.
 *
 *  - skipped (server flag off)       -> 'setup_unavailable' (nothing created, ok)
 *  - seller + signup URL             -> 'onboarding_ready'  (navigate to PayMe)
 *  - seller without signup URL       -> 'seller_ready'
 */
export function interpretSellerAccountResponse(
  account: CreateSellerAccountResponse,
): ProviderPaymentActivationResult {
  const raw = (account.raw ?? {}) as PaymeSellerRaw
  const skipped = raw.skipped === true
  const signupUrl = nonEmpty(raw.signupUrl)
  const sellerId = nonEmpty(account.accountId) ?? nonEmpty(raw.sellerPaymeId)
  const onboardingStatus = nonEmpty(raw.onboardingStatus)

  if (skipped) {
    // Server flag off: nothing was created, no cost incurred. Not an error.
    return {
      ok: true,
      outcome: 'setup_unavailable',
      signupUrl: null,
      sellerId: null,
      onboardingStatus: onboardingStatus ?? 'not_started',
      skipped: true,
    }
  }

  return {
    ok: true,
    outcome: signupUrl ? 'onboarding_ready' : 'seller_ready',
    signupUrl,
    sellerId,
    onboardingStatus,
    skipped: false,
  }
}

/**
 * A safe, retryable error result. A failed activation must never corrupt the
 * Regli account/session — the caller shows this and lets the provider try again.
 */
export function buildActivationError(message?: string): ProviderPaymentActivationResult {
  return {
    ok: false,
    outcome: 'error',
    signupUrl: null,
    sellerId: null,
    onboardingStatus: null,
    skipped: false,
    error: nonEmpty(message) ?? 'activation_failed',
  }
}
