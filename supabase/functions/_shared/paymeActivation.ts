// AUTHORITATIVE provider payment-activation state machine + PayMe request helpers
// (SERVER copy). Pure and dependency-free so it can be unit-tested under
// `node --test` and imported by every activation edge function.
//
// This module is the SOURCE OF TRUTH for orchestration. It never performs I/O:
// edge functions call fetch()/Supabase; this module only builds request bodies,
// parses responses, and computes the next state. Keep it free of Deno globals and
// imports.
//
// States are Regli-INTERNAL orchestration states, NOT PayMe seller statuses. The
// client copy (src/payments/providerActivationState.ts) MUST list the same states
// (guaranteed by a parity test).
//
// SECURITY: never build a request that embeds card/bank/KYC data. Credentials
// (client key, Regli's own seller id) are injected by the caller from server-side
// secrets — never hardcode them here.

export const PROVIDER_ACTIVATION_STATES = [
  'not_started',
  'ready',
  'fee_authorizing',
  'fee_authorized',
  'seller_creating',
  'seller_created',
  'kyc_pending',
  'kyc_approved',
  'fee_capturing',
  'fee_captured',
  'payment_ready',
  'authorization_expired',
  'activation_failed',
  'cancelled',
] as const

export type ProviderActivationState = (typeof PROVIDER_ACTIVATION_STATES)[number]

// ---------------------------------------------------------------------------
// Seller / KYC verification lifecycle — tracked INDEPENDENTLY of the activation
// (fee-authorization) state above. A single enum cannot represent both facts at
// once: e.g. the J5 authorization can EXPIRE while the PayMe Seller is (or later
// becomes) KYC-approved. Persisting this separately means KYC approval survives
// authorization expiry / re-authorization and is never lost.
//
// These are Regli-INTERNAL NORMALIZED statuses — deliberately NOT PayMe's external
// (undocumented) seller status names. `approved` may be set ONLY through the
// verified Phase-2C seam (applyVerifiedSellerVerification), never inferred from
// arbitrary callback data. The client copy mirrors this list (parity test).
// ---------------------------------------------------------------------------

export const SELLER_VERIFICATION_STATUSES = [
  'not_started', // no PayMe Seller / onboarding started yet
  'pending', // Seller created; Hosted Onboarding / KYC in progress
  'approved', // VERIFIED PayMe seller readiness (Phase 2C seam only)
  'rejected', // KYC rejected by PayMe
] as const

export type SellerVerificationStatus = (typeof SELLER_VERIFICATION_STATUSES)[number]

/** Whether the PayMe Seller has completed KYC (verified), independent of the fee. */
export function isSellerKycApproved(
  status: SellerVerificationStatus | null | undefined,
): boolean {
  return status === 'approved'
}

// 168h J5 authorization window. Capture after this fails; it cannot be extended.
export const AUTHORIZATION_WINDOW_HOURS = 168
const HOUR_MS = 60 * 60 * 1000

// PayMe endpoints. NOTE(payme-phase2c): confirm exact void path in Personal Sandbox.
export const PAYME_GENERATE_SALE_PATH = '/api/generate-sale'
export const PAYME_CAPTURE_SALE_PATH = '/api/capture-sale'
export const PAYME_VOID_SALE_PATH = '/api/void-sale'

/** PayMe success convention shared across seller + sale endpoints. */
export function isPaymeSuccess(raw: unknown): boolean {
  return !!raw && typeof raw === 'object' && (raw as { status_code?: unknown }).status_code === 0
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

// ---------------------------------------------------------------------------
// Guards (kept in lockstep with the client copy)
// ---------------------------------------------------------------------------

export function isProviderPaymentReady(state: ProviderActivationState | null | undefined): boolean {
  return state === 'payment_ready'
}

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

export function canCreateSellerForActivation(
  state: ProviderActivationState | null | undefined,
): boolean {
  return state === 'fee_authorized'
}

export function canCaptureActivationFee(
  state: ProviderActivationState | null | undefined,
): boolean {
  return state === 'kyc_approved'
}

export function canVoidActivation(state: ProviderActivationState | null | undefined): boolean {
  return (
    state === 'fee_authorizing' ||
    state === 'fee_authorized' ||
    state === 'seller_creating' ||
    state === 'seller_created' ||
    state === 'kyc_pending' ||
    state === 'kyc_approved'
  )
}

// ---------------------------------------------------------------------------
// 168h authorization window
// ---------------------------------------------------------------------------

/** authorized_at + 168h, as an ISO string. Returns null on unparseable input. */
export function computeAuthorizationExpiry(authorizedAtIso: string): string | null {
  const authorized = Date.parse(authorizedAtIso)
  if (Number.isNaN(authorized)) return null
  return new Date(authorized + AUTHORIZATION_WINDOW_HOURS * HOUR_MS).toISOString()
}

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

/**
 * If a live (uncaptured) authorization has passed its window, the state collapses
 * to `authorization_expired`. Captured/terminal states are never affected — once
 * captured, expiry is irrelevant.
 */
export function resolveExpiryState(
  state: ProviderActivationState,
  expiresAtIso: string | null | undefined,
  nowIso: string,
): ProviderActivationState {
  const hasLiveAuthorization =
    state === 'fee_authorizing' ||
    state === 'fee_authorized' ||
    state === 'seller_creating' ||
    state === 'seller_created' ||
    state === 'kyc_pending' ||
    state === 'kyc_approved'
  if (!hasLiveAuthorization) return state
  return isActivationAuthorizationExpired(expiresAtIso, nowIso) ? 'authorization_expired' : state
}

// ---------------------------------------------------------------------------
// Capture amount safety
// ---------------------------------------------------------------------------

/** Capture price must be positive and never exceed the authorized amount. */
export function isCaptureAmountValid(capturePriceAgorot: number, authorizedAgorot: number): boolean {
  return (
    Number.isInteger(capturePriceAgorot) &&
    capturePriceAgorot > 0 &&
    Number.isInteger(authorizedAgorot) &&
    authorizedAgorot > 0 &&
    capturePriceAgorot <= authorizedAgorot
  )
}

// ---------------------------------------------------------------------------
// PayMe request builders — credentials injected by caller (never hardcoded)
// ---------------------------------------------------------------------------

export interface AuthorizationRequestInput {
  clientKey: string // PAYME_PARTNER_CLIENT_KEY (secret)
  regliSellerId: string // PAYME_REGLI_SELLER_ID (secret) — Regli's OWN terminal
  amountAgorot: number // gross activation fee (from _shared/activationFeeConfig.ts)
  currency: string
  productName: string
  transactionId: string // idempotency key we control (our activation attempt id)
  saleReturnUrl?: string | null
  saleCallbackUrl?: string | null
}

/**
 * Build the J5 (authorize-only) generate-sale body. `sale_type: 'authorize'`
 * reserves the amount WITHOUT capturing it. NOTE(payme-phase2c): field names
 * confirmed against PayMe generate-sale; verify authorize semantics in Sandbox.
 * We never include card data — the buyer enters it on PayMe's hosted page.
 */
export function buildActivationAuthorizationRequest(input: AuthorizationRequestInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    seller_payme_id: input.regliSellerId,
    sale_type: 'authorize',
    sale_price: input.amountAgorot,
    currency: input.currency,
    product_name: input.productName,
    transaction_id: input.transactionId,
    installments: 1,
    language: 'he',
  }
  const returnUrl = asNonEmptyString(input.saleReturnUrl)
  const callbackUrl = asNonEmptyString(input.saleCallbackUrl)
  if (returnUrl) body.sale_return_url = returnUrl
  if (callbackUrl) body.sale_callback_url = callbackUrl
  return body
}

export interface CaptureRequestInput {
  clientKey: string
  paymeSaleId: string // payme_sale_id from the authorization
  salePriceAgorot: number // ≤ authorized amount
  installments?: number
}

/** Build the capture-sale body. Capture happens once, full or partial. */
export function buildActivationCaptureRequest(input: CaptureRequestInput): Record<string, unknown> {
  return {
    payme_sale_id: input.paymeSaleId,
    sale_price: input.salePriceAgorot,
    installments: input.installments && input.installments > 0 ? input.installments : 1,
  }
}

export interface VoidRequestInput {
  clientKey: string
  paymeSaleId: string
}

/** Build the void-sale body — releases an uncaptured authorization explicitly. */
export function buildActivationVoidRequest(input: VoidRequestInput): Record<string, unknown> {
  return { payme_sale_id: input.paymeSaleId }
}

// ---------------------------------------------------------------------------
// PayMe response parsers — extract ONLY safe, non-secret fields
// ---------------------------------------------------------------------------

export interface AuthorizationResult {
  ok: boolean
  paymeSaleId: string | null // payme_sale_id — safe to persist
  saleUrl: string | null // hosted J5 page for the provider (no card data to Regli)
  statusCode: number | null
}

export function parseAuthorizationResponse(raw: unknown): AuthorizationResult {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    ok: isPaymeSuccess(raw),
    paymeSaleId: asNonEmptyString(obj.payme_sale_id) ?? asNonEmptyString(obj.sale_id),
    saleUrl: asNonEmptyString(obj.sale_url) ?? asNonEmptyString(obj.payme_sale_url),
    statusCode: typeof obj.status_code === 'number' ? obj.status_code : null,
  }
}

export interface CaptureResult {
  ok: boolean
  paymeSaleId: string | null
  statusCode: number | null
}

export function parseCaptureResponse(raw: unknown): CaptureResult {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    ok: isPaymeSuccess(raw),
    paymeSaleId: asNonEmptyString(obj.payme_sale_id) ?? asNonEmptyString(obj.sale_id),
    statusCode: typeof obj.status_code === 'number' ? obj.status_code : null,
  }
}

export interface VoidResult {
  ok: boolean
  statusCode: number | null
}

export function parseVoidResponse(raw: unknown): VoidResult {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    ok: isPaymeSuccess(raw),
    statusCode: typeof obj.status_code === 'number' ? obj.status_code : null,
  }
}

// ---------------------------------------------------------------------------
// Transition seams (verified external confirmations)
// ---------------------------------------------------------------------------

/**
 * Given a VERIFIED fresh J5 authorization, resolve the next activation state using
 * the INDEPENDENT seller-verification status. This is what lets a re-authorization
 * after expiry proceed correctly:
 *   - seller already KYC-approved -> jump straight to kyc_approved (capture-ready);
 *     the existing Seller is reused, never recreated.
 *   - seller KYC still pending    -> kyc_pending (keep waiting for KYC; the Seller
 *     already exists, so no creation step).
 *   - no seller yet / rejected    -> fee_authorized (first-time path: create Seller).
 */
export function resolveStateAfterVerifiedAuthorization(
  sellerVerificationStatus: SellerVerificationStatus | null | undefined,
): ProviderActivationState {
  if (sellerVerificationStatus === 'approved') return 'kyc_approved'
  if (sellerVerificationStatus === 'pending') return 'kyc_pending'
  return 'fee_authorized'
}

/**
 * Transition an authorization we created (fee_authorizing) once PayMe has CONFIRMED
 * it succeeded. The next state depends on the persisted seller-verification status
 * (see resolveStateAfterVerifiedAuthorization) so a re-authorization honors KYC
 * that already completed. Returns null if the current state is not eligible.
 *
 * TODO(payme-phase2c): the trusted trigger (return-URL reconciliation or verified
 * callback) is not wired yet. Until then this is invoked only by tests.
 */
export function applyVerifiedAuthorization(
  state: ProviderActivationState,
  sellerVerificationStatus?: SellerVerificationStatus | null,
): ProviderActivationState | null {
  if (state !== 'fee_authorizing') return null
  return resolveStateAfterVerifiedAuthorization(sellerVerificationStatus)
}

/**
 * Phase 2C ONLY. Transition kyc_pending -> kyc_approved. This must be called
 * EXCLUSIVELY from a verified PayMe seller-readiness signal. It must NEVER be
 * driven by arbitrary/undocumented callback data. Returns null if not eligible.
 *
 * TODO(payme-phase2c): no production caller wires this yet — see
 * markProviderKycApprovedFromVerifiedPaymeStatus in the void/capture functions'
 * docs. Until a definitive signal is verified in the Personal Sandbox, providers
 * do not reach kyc_approved and therefore never become payment_ready.
 */
export function applyVerifiedKycApproval(
  state: ProviderActivationState,
): ProviderActivationState | null {
  return state === 'kyc_pending' ? 'kyc_approved' : null
}

/**
 * Phase 2C ONLY. Advance the INDEPENDENT seller-verification status pending ->
 * approved from a VERIFIED PayMe seller-readiness signal. Unlike
 * applyVerifiedKycApproval (which advances activation_state and therefore only
 * applies while the authorization is live/kyc_pending), this records the durable
 * KYC fact regardless of the current activation_state — so an approval that arrives
 * while the J5 authorization has already EXPIRED is persisted and NOT lost. Returns
 * null if not eligible (only 'pending' may be approved).
 */
export function applyVerifiedSellerVerification(
  status: SellerVerificationStatus | null | undefined,
): SellerVerificationStatus | null {
  return status === 'pending' ? 'approved' : null
}
