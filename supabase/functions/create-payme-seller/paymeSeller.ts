// Pure, dependency-free helpers for the `create-payme-seller` edge function.
//
// This module deliberately avoids Deno globals and remote (https://) imports so
// that the same logic can run inside Deno (the edge function) AND be unit-tested
// under Node's built-in runner (`node --test --experimental-strip-types`).
//
// SECURITY: nothing in here ever reads, returns, or logs `seller_payme_secret`
// or the PayMe partner credentials beyond building the outbound request body.

export const PAYME_DEFAULT_BASE_URL = 'https://sandbox.payme.io'

// Status values persisted to profiles.payme_onboarding_status. Kept in sync with
// the CHECK constraint in 2026080701_payme_seller_onboarding.sql.
export const PAYME_ONBOARDING_STATUS = {
  notStarted: 'not_started',
  created: 'created',
  pending: 'pending',
  completed: 'completed',
  failed: 'failed',
} as const

export type PaymeOnboardingStatus =
  (typeof PAYME_ONBOARDING_STATUS)[keyof typeof PAYME_ONBOARDING_STATUS]

// Shape of the PayMe /api/create-seller response. Only the safe, non-secret
// fields are modelled; `seller_payme_secret` is intentionally omitted so it is
// never read in typed code.
export interface PaymeCreateSellerRaw {
  status_code?: unknown
  status_error_code?: unknown
  status_error_details?: unknown
  seller_payme_id?: unknown
  seller_public_key?: { uuid?: unknown } | null
  seller_dashboard_signup_link?: unknown
  [key: string]: unknown
}

export interface SafeSellerMetadata {
  sellerPaymeId: string
  publicKeyUuid: string | null
  signupUrl: string | null
}

// The only shape ever returned to the client — contains no secrets.
export interface SafeSellerResult {
  success: true
  sellerPaymeId: string
  onboardingStatus: PaymeOnboardingStatus
  signupUrl: string | null
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

/**
 * PayMe success is determined from the response structure, not just HTTP 200.
 * A successful create-seller response has `status_code === 0`.
 */
export function isPaymeSuccess(raw: PaymeCreateSellerRaw | null | undefined): boolean {
  return !!raw && raw.status_code === 0
}

/**
 * Extract only the safe, non-secret fields from a PayMe create-seller response.
 * Returns null when the response is missing the seller id we must persist.
 */
export function extractSafeSellerMetadata(
  raw: PaymeCreateSellerRaw,
): SafeSellerMetadata | null {
  const sellerPaymeId = asNonEmptyString(raw.seller_payme_id)
  if (!sellerPaymeId) return null

  const publicKey = raw.seller_public_key
  const publicKeyUuid =
    publicKey && typeof publicKey === 'object'
      ? asNonEmptyString((publicKey as { uuid?: unknown }).uuid)
      : null

  return {
    sellerPaymeId,
    publicKeyUuid,
    signupUrl: asNonEmptyString(raw.seller_dashboard_signup_link),
  }
}

export function buildSafeSellerResult(
  sellerPaymeId: string,
  onboardingStatus: PaymeOnboardingStatus,
  signupUrl: string | null,
): SafeSellerResult {
  return { success: true, sellerPaymeId, onboardingStatus, signupUrl }
}

// Idempotency & gating decisions ------------------------------------------

export interface ExistingSellerFields {
  payme_seller_id?: string | null
  payme_onboarding_status?: string | null
  payme_signup_url?: string | null
}

/**
 * Idempotency: if a provider already has a payme_seller_id we must NEVER call
 * PayMe again — return the existing (safe) seller metadata instead.
 */
export function resolveExistingSeller(
  profile: ExistingSellerFields | null | undefined,
): SafeSellerResult | null {
  const existingId = asNonEmptyString(profile?.payme_seller_id)
  if (!existingId) return null

  const status = (asNonEmptyString(profile?.payme_onboarding_status) ??
    PAYME_ONBOARDING_STATUS.created) as PaymeOnboardingStatus

  return buildSafeSellerResult(
    existingId,
    status,
    asNonEmptyString(profile?.payme_signup_url),
  )
}

/**
 * Whether the request is allowed to actually contact PayMe.
 *
 * The automatic provider-onboarding path sends `source: 'onboarding'` and is
 * gated by the server-side PAYME_SELLER_ONBOARDING_ENABLED flag (must equal the
 * string "true"). Any other invocation (e.g. an explicit manual/test call that
 * omits `source`) bypasses the flag so the function stays callable for testing.
 */
export function shouldContactPayme(params: {
  source: string | null | undefined
  flagValue: string | null | undefined
}): boolean {
  if (params.source !== 'onboarding') return true
  return params.flagValue === 'true'
}

/**
 * The static, sandbox-verified seller identity produced by
 * {@link buildCreateSellerRequestBody} may ONLY be used for manual integration
 * testing. It must NEVER be used by the automatic provider-onboarding flow,
 * because doing so would register real PayMe sellers under a fixed fake test
 * identity. Returns true only for explicit/manual invocations (source is not
 * 'onboarding').
 */
export function mayUseSandboxSellerIdentity(
  source: string | null | undefined,
): boolean {
  return source !== 'onboarding'
}

// ==========================================================================
// TEMPORARY SANDBOX SELLER IDENTITY — PHASE 1 MANUAL TESTING ONLY
// ==========================================================================
//
// These are the fixed, FAKE KYC values that were manually verified against the
// PayMe sandbox in Postman. They are not tied to any real provider and must
// NEVER be used to register a seller on behalf of a real provider.
//
// Reachability is intentionally constrained on TWO axes so this identity can
// never be created accidentally through ordinary provider registration:
//   1. `shouldContactPayme()` — the onboarding path only reaches PayMe when the
//      PAYME_SELLER_ONBOARDING_ENABLED flag is exactly "true".
//   2. `mayUseSandboxSellerIdentity()` — even then, the onboarding path is
//      refused; only explicit/manual invocations (no `source: 'onboarding'`)
//      may build this payload.
//
// PHASE 2 TODO(payme-phase2): DELETE this constant and replace it with real
// per-provider field mapping (name, social id, birthdate, bank details, contact
// info) derived from the authenticated provider's profile. Automatic onboarding
// must not create sellers until that mapping exists.
//
// Note: `payme_client_key` is deliberately NOT part of this identity — the
// partner credential is injected at build time from the secret, never hardcoded.
export const SANDBOX_SELLER_IDENTITY = {
  seller_first_name: 'Test',
  seller_last_name: 'Seller',
  seller_social_id: '9999999999',
  seller_birthdate: '01/01/2000',
  seller_social_id_issued: '01/01/2020',
  seller_gender: 0,
  seller_email: 'regli.support+payme2@gmail.com',
  seller_phone: '+972502000000',
  seller_contact_email: 'test@example.com',
  seller_contact_phone: '+972502000000',
  seller_bank_code: 54,
  seller_bank_branch: 123,
  seller_bank_account_number: '123456',
  seller_description: 'Regli sandbox test seller',
  seller_site_url: 'https://regli.vercel.app',
} as const

/**
 * Build the PayMe create-seller request body for MANUAL sandbox integration
 * testing ONLY.
 *
 * Combines the fixed {@link SANDBOX_SELLER_IDENTITY} with the partner
 * credential, which is injected from the PAYME_PARTNER_CLIENT_KEY secret rather
 * than hardcoded (credentials must never live in source). The
 * `/api/create-seller` request does NOT include an api-id field, so none is sent.
 *
 * SANDBOX-ONLY: callers MUST first pass the `mayUseSandboxSellerIdentity(source)`
 * guard — this must never run for the automatic provider-onboarding flow.
 *
 * NEVER log the returned object — it carries the partner credential.
 *
 * PHASE 2 TODO(payme-phase2): replace SANDBOX_SELLER_IDENTITY with real
 * per-provider mapping and rework this builder accordingly.
 */
export function buildSandboxSellerRequestBody(
  clientKey: string,
): Record<string, unknown> {
  return {
    payme_client_key: clientKey,
    ...SANDBOX_SELLER_IDENTITY,
  }
}
