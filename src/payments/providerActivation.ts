import { PaymentService } from './PaymentService'
import type {
  AuthorizeProviderActivationFeeResponse,
  CaptureProviderActivationFeeResponse,
  PaymentProviderResolverInput,
  ProviderActivationFeeQuote,
  VoidProviderActivationFeeResponse,
} from './types'
import {
  buildActivationError,
  interpretSellerAccountResponse,
  type ProviderPaymentActivationResult,
} from './providerActivationResult'

// ---------------------------------------------------------------------------
// Explicit provider payment activation
// ---------------------------------------------------------------------------
//
// COST INVARIANT: creating a PayMe Seller incurs a one-time, per-provider setup
// cost charged to Regli. Therefore seller creation MUST be driven only by a
// DELIBERATE provider action ("activate receiving paid orders"), never by
// registration, login, app load, dashboard visits, availability edits, going
// online, background hydration, or OAuth redirects.
//
// This module is the single, intentional activation boundary. It replaces the
// former onboardingTrigger.ts, which fired automatically after registration —
// do NOT reintroduce any automatic caller of this function.
//
// FLAG SAFETY: the real PayMe seller is created server-side only when
// PAYME_SELLER_ONBOARDING_ENABLED is true inside the create-payme-seller edge
// function. While the flag is false the edge function returns `skipped: true`
// and creates NOTHING (no seller, no cost) — surfaced as 'setup_unavailable'.
// This function does not read, bypass, or override that flag; it is architected
// so that flipping the server flag later makes the SAME explicit action create a
// real seller with zero client changes.
//
// NON-BLOCKING GUARANTEE FOR REGISTRATION/AUTH: this function is never invoked
// from the registration/auth path, so a PayMe failure cannot affect the Regli
// account. When it IS invoked (explicit activation), a failure is returned as a
// safe, retryable result — it never throws to the caller.

export type {
  ProviderPaymentActivationOutcome,
  ProviderPaymentActivationResult,
} from './providerActivationResult'
export { buildActivationError, interpretSellerAccountResponse } from './providerActivationResult'

/**
 * Explicitly activate receiving paid orders for the currently-authenticated
 * provider. MUST be called only in direct response to a deliberate provider
 * confirmation in the UI (never automatically).
 *
 * Security: the server (create-payme-seller, verify_jwt = true) derives the
 * provider identity from the caller's JWT — no provider_id is supplied here, so
 * a provider can only ever activate their own account. This function passes no
 * identity, secret, or KYC/bank data.
 *
 * Idempotency: the edge function is idempotent and concurrency-guarded, so a
 * repeated confirmation returns the existing seller rather than creating (and
 * paying for) another one. Callers should still prefer to RESUME when a seller
 * already exists — see shouldResumePaymeSetup in providerPaymentSetupState.ts.
 */
export async function activateProviderPayments(
  context: PaymentProviderResolverInput = { provider: 'payme' },
): Promise<ProviderPaymentActivationResult> {
  try {
    const paymentService = new PaymentService(context)
    const account = await paymentService.createSellerAccount()
    return interpretSellerAccountResponse(account)
  } catch (err) {
    return buildActivationError(err instanceof Error ? err.message : undefined)
  }
}

// ---------------------------------------------------------------------------
// Provider Account Activation Fee — client-facing orchestration wrappers
// ---------------------------------------------------------------------------
//
// Each wrapper delegates to the payment abstraction (PaymentService ->
// PayMeProvider -> secure edge function) and NEVER throws to the UI: a failure is
// returned as `{ success: false }` so the provider can retry safely. The client
// never touches PayMe directly, sends no card/KYC data, and passes no provider_id
// (the server derives it from the JWT). While PAYME_SELLER_ONBOARDING_ENABLED is
// false the server returns `skipped: true` and performs no real charge.
//
// Sequencing invariant (mirrors the server state machine): the UI must only call
// createSellerAccount() AFTER a confirmed fee_authorized state
// (canCreateSellerForActivation), and only ever calls capture after a VERIFIED
// kyc_approved state — which is a Phase 2C signal not wired in this phase.

/**
 * Fetch the authoritative activation-fee quote for display. The amount is decided
 * server-side (same value the J5 charges); the client only formats it. Never
 * throws — returns null on any failure so the UI can degrade gracefully.
 */
export async function getProviderActivationFeeQuote(
  context: PaymentProviderResolverInput = { provider: 'payme' },
): Promise<ProviderActivationFeeQuote | null> {
  try {
    const res = await new PaymentService(context).getProviderActivationFeeQuote()
    return res.success ? res.quote : null
  } catch {
    return null
  }
}

/** Begin the one-time activation fee: create a J5 authorization (safe on failure). */
export async function authorizeProviderActivationFee(
  context: PaymentProviderResolverInput = { provider: 'payme' },
): Promise<AuthorizeProviderActivationFeeResponse> {
  try {
    return await new PaymentService(context).authorizeProviderActivationFee()
  } catch (err) {
    return {
      success: false,
      provider: 'payme',
      raw: { error: err instanceof Error ? err.message : 'authorize_failed' },
    }
  }
}

/** Capture the authorized activation fee (Phase 2C; safe on failure). */
export async function captureProviderActivationFee(
  context: PaymentProviderResolverInput = { provider: 'payme' },
): Promise<CaptureProviderActivationFeeResponse> {
  try {
    return await new PaymentService(context).captureProviderActivationFee()
  } catch (err) {
    return {
      success: false,
      provider: 'payme',
      raw: { error: err instanceof Error ? err.message : 'capture_failed' },
    }
  }
}

/** Explicitly void an uncaptured authorization (provider cancel/reject; safe). */
export async function voidProviderActivationFee(
  context: PaymentProviderResolverInput = { provider: 'payme' },
): Promise<VoidProviderActivationFeeResponse> {
  try {
    return await new PaymentService(context).voidProviderActivationFee()
  } catch (err) {
    return {
      success: false,
      provider: 'payme',
      raw: { error: err instanceof Error ? err.message : 'void_failed' },
    }
  }
}
