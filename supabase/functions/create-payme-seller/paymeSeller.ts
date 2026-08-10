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
  // `creating` is a short-lived claim state: exactly one request may transition
  // not_started/failed -> creating before contacting PayMe (see classifyClaimOutcome).
  creating: 'creating',
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
  status_additional_info?: unknown
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

// ==========================================================================
// EXPLICIT SOURCE CLASSIFICATION
// ==========================================================================
//
// There are exactly two recognized intents. Everything else fails safe so an
// arbitrary/unknown `source` can never accidentally bypass a safety gate or reach
// PayMe.
//
//   'onboarding'    -> REAL provider data; gated by PAYME_SELLER_ONBOARDING_ENABLED.
//                      flag != "true" => skip (no PayMe call).
//   'sandbox'       -> the fixed SANDBOX_SELLER_IDENTITY; explicit manual sandbox
//                      testing. A request with NO source is treated as sandbox to
//                      preserve the established manual invocation contract.
//   'unknown'       -> anything else; rejected, never contacts PayMe.
export type SellerRequestIntent = 'onboarding' | 'sandbox' | 'unknown'

export function classifySellerRequest(
  source: string | null | undefined,
): SellerRequestIntent {
  const s = typeof source === 'string' ? source.trim() : ''
  if (s === 'onboarding') return 'onboarding'
  // No source (established manual contract) or the explicit 'sandbox' token.
  if (s === '' || s === 'sandbox') return 'sandbox'
  return 'unknown'
}

export interface SellerRequestDecision {
  intent: SellerRequestIntent
  // 'proceed' -> build payloadKind and contact PayMe.
  // 'skip'    -> onboarding while the flag is off (safe no-op).
  // 'reject'  -> unknown/unsupported source; never contacts PayMe.
  action: 'proceed' | 'skip' | 'reject'
  payloadKind: 'provider' | 'sandbox' | null
}

/**
 * The single, explicit gate. Maps (source, flag) to exactly one decision. This
 * replaces the previous loose `source !== 'onboarding'` checks so unknown sources
 * fail safe and only the intended paths may reach PayMe.
 */
export function decideSellerRequest(params: {
  source: string | null | undefined
  flagValue: string | null | undefined
}): SellerRequestDecision {
  const intent = classifySellerRequest(params.source)
  switch (intent) {
    case 'onboarding':
      return params.flagValue === 'true'
        ? { intent, action: 'proceed', payloadKind: 'provider' }
        : { intent, action: 'skip', payloadKind: null }
    case 'sandbox':
      return { intent, action: 'proceed', payloadKind: 'sandbox' }
    case 'unknown':
    default:
      return { intent, action: 'reject', payloadKind: null }
  }
}

/**
 * The fixed sandbox identity may be built ONLY for the explicit sandbox intent.
 * The real-data onboarding path and unknown sources return false — the sandbox
 * identity is impossible from any path that could carry real provider data.
 */
export function mayUseSandboxSellerIdentity(
  source: string | null | undefined,
): boolean {
  return classifySellerRequest(source) === 'sandbox'
}

// ==========================================================================
// TEMPORARY SANDBOX SELLER IDENTITY — PHASE 1 MANUAL TESTING ONLY
// ==========================================================================
//
// These are the fixed, FAKE KYC values that were manually verified against the
// PayMe sandbox in Postman. They are not tied to any real provider and must
// NEVER be used to register a seller on behalf of a real provider.
//
// Reachability is intentionally constrained so this identity can never be created
// accidentally through ordinary provider registration or the manual test seam:
//   1. `decideSellerRequest()` classifies intent explicitly — only the 'sandbox'
//      intent (explicit/absent source) resolves to payloadKind 'sandbox'. The
//      real-data 'onboarding' intent never does, and unknown sources are rejected
//      before any payload is built.
//   2. `mayUseSandboxSellerIdentity()` returns true ONLY for the 'sandbox' intent,
//      so the onboarding path is refused this identity.
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

// ==========================================================================
// PHASE 2A — MINIMAL REAL PROVIDER SELLER PAYLOAD
// ==========================================================================
//
// Per PayMe's official guidance, create-seller only needs a minimal identity:
// seller_email, seller_first_name, seller_phone. The provider completes all
// KYC/banking directly in PayMe Hosted Onboarding (via seller_dashboard_signup_link),
// and PayMe owns that data — Regli deliberately does NOT collect or store social
// id, birthdate, gender, bank details, etc.
//
// The real-data 'onboarding' path builds this payload from the authenticated
// provider's OWN profile data — never from SANDBOX_SELLER_IDENTITY. Which payload
// a request may build is decided by decideSellerRequest() above.
//
// SECURITY: none of the functions below ever log identity values. Callers log
// only field NAMES (see `missing`) and non-secret status codes.

// Non-secret subset of a provider's profile used for the minimal PayMe seller.
// No KYC/bank fields: those are owned by PayMe Hosted Onboarding.
export interface ProviderProfileFields {
  email?: unknown
  full_name?: unknown
  whatsapp_number?: unknown
}

export interface NormalizedProviderSeller {
  firstName: string | null
  email: string | null
  phone: string | null
}

/**
 * Derive `seller_first_name` from Regli's single `full_name` field: the first
 * non-empty whitespace-delimited token. This is NOT an invented legal name and
 * NO last name is derived (PayMe does not require one for the minimal request).
 */
function deriveFirstName(fullName: string | null): string | null {
  if (!fullName) return null
  const first = fullName.trim().split(/\s+/).filter(Boolean)[0]
  return first ?? null
}

/**
 * Assemble the minimal seller input from data Regli already has. `seller_phone`
 * uses the provider's whatsapp number (Regli has no dedicated phone column).
 */
export function normalizeProviderSellerInput(
  profile: ProviderProfileFields | null | undefined,
): NormalizedProviderSeller {
  const p = profile ?? {}
  return {
    firstName: deriveFirstName(asNonEmptyString(p.full_name)),
    email: asNonEmptyString(p.email),
    phone: asNonEmptyString(p.whatsapp_number),
  }
}

// Minimal PayMe create-seller fields required before we may contact PayMe.
export const REQUIRED_PROVIDER_SELLER_FIELDS = [
  'seller_email',
  'seller_first_name',
  'seller_phone',
] as const

export type ProviderSellerValidation =
  | { ok: true }
  | { ok: false; missing: string[] }

/**
 * Validate that the minimal identity is present. Returns the missing PayMe field
 * NAMES (never values) so callers can log/return a safe, structured error.
 */
export function validateProviderSellerInput(
  n: NormalizedProviderSeller,
): ProviderSellerValidation {
  const missing: string[] = []
  if (!n.email) missing.push('seller_email')
  if (!n.firstName) missing.push('seller_first_name')
  if (!n.phone) missing.push('seller_phone')
  return missing.length === 0 ? { ok: true } : { ok: false, missing }
}

export type ProviderSellerBuildResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; missing: string[] }

/**
 * Build the MINIMAL PayMe create-seller request body from real provider data.
 * Injects PAYME_PARTNER_CLIENT_KEY server-side (never hardcoded) and returns a
 * structured validation error instead of a body when the minimal identity is
 * incomplete — the caller must NOT contact PayMe in that case.
 *
 * Only seller_email / seller_first_name / seller_phone are sent. KYC/banking is
 * collected by PayMe Hosted Onboarding. If a marketplace config requires an extra
 * field, PayMe returns error code 19 (see isPaymeRequiredFieldError).
 *
 * NEVER log the returned body: it carries the partner credential.
 */
export function buildProviderSellerRequestBody(
  clientKey: string,
  n: NormalizedProviderSeller,
): ProviderSellerBuildResult {
  const validation = validateProviderSellerInput(n)
  if (!validation.ok) return { ok: false, missing: validation.missing }

  return {
    ok: true,
    body: {
      payme_client_key: clientKey,
      seller_email: n.email,
      seller_first_name: n.firstName,
      seller_phone: n.phone,
    },
  }
}

// PayMe error code 19 = a marketplace-specific required field is missing; PayMe
// identifies it by name (via status_additional_info). This lets us surface a
// safe, actionable error without exposing any raw response contents.
export const PAYME_MISSING_FIELD_ERROR_CODE = 19

export function isPaymeRequiredFieldError(
  raw: PaymeCreateSellerRaw | null | undefined,
): boolean {
  return !!raw && raw.status_code !== 0 && raw.status_error_code === PAYME_MISSING_FIELD_ERROR_CODE
}

/**
 * Extract the missing field NAME from status_additional_info, but ONLY when it
 * is unambiguously a schema field name (e.g. `seller_last_name`). Anything that
 * could carry a value or free text is rejected -> null. Never returns values.
 */
export function extractSafeMissingFieldName(
  raw: PaymeCreateSellerRaw | null | undefined,
): string | null {
  const info = asNonEmptyString(raw?.status_additional_info)
  if (!info) return null
  return /^(seller|payme)_[a-z0-9_]+$/.test(info.trim()) ? info.trim() : null
}

/**
 * Decide what a request should do after attempting the atomic "claim" (the
 * conditional UPDATE not_started/failed -> creating). The claim itself is the
 * lock (enforced by Postgres row locking); this only interprets the result:
 *  - claimed              -> 'proceed'        (this request creates the seller)
 *  - not claimed + id     -> 'return_existing'(another request already created it)
 *  - not claimed + no id  -> 'in_progress'    (another request is creating it now)
 */
export function classifyClaimOutcome(params: {
  claimed: boolean
  existingSellerId: string | null | undefined
}): 'proceed' | 'return_existing' | 'in_progress' {
  if (params.claimed) return 'proceed'
  if (asNonEmptyString(params.existingSellerId)) return 'return_existing'
  return 'in_progress'
}
