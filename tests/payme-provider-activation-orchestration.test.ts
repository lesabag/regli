import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  PROVIDER_ACTIVATION_STATES as CLIENT_STATES,
  SELLER_VERIFICATION_STATUSES as CLIENT_SELLER_STATUSES,
  canCaptureActivationFee as clientCanCapture,
  canCreateSellerForActivation as clientCanCreateSeller,
  canRequestActivationAuthorization as clientCanAuthorize,
  canVoidActivation as clientCanVoid,
  isActivationAuthorizationExpired as clientIsExpired,
  isProviderPaymentReady as clientIsPaymentReady,
} from '../src/payments/providerActivationState.ts'
import {
  PROVIDER_ACTIVATION_STATES as SERVER_STATES,
  SELLER_VERIFICATION_STATUSES as SERVER_SELLER_STATUSES,
  AUTHORIZATION_WINDOW_HOURS,
  applyVerifiedAuthorization,
  applyVerifiedKycApproval,
  applyVerifiedSellerVerification,
  buildActivationAuthorizationRequest,
  buildActivationCaptureRequest,
  buildActivationVoidRequest,
  canCaptureActivationFee,
  canCreateSellerForActivation,
  canRequestActivationAuthorization,
  canVoidActivation,
  computeAuthorizationExpiry,
  isCaptureAmountValid,
  isProviderPaymentReady,
  isSellerKycApproved,
  parseAuthorizationResponse,
  parseCaptureResponse,
  resolveExpiryState,
  resolveStateAfterVerifiedAuthorization,
} from '../supabase/functions/_shared/paymeActivation.ts'
import {
  computeActivationFeeQuote,
  resolveActivationFeeQuote,
} from '../supabase/functions/_shared/activationFeeConfig.ts'
import { formatAgorotAmount } from '../src/config/activationFee.ts'
import { shouldResumePaymeSetup } from '../src/payments/providerPaymentSetupState.ts'

// ---------------------------------------------------------------------------
// Provider Account Activation Fee orchestration (Phase 2B).
//   Fee (299 ILS + VAT, from ONE config) -> J5 authorize (reserve, not capture)
//   -> create Seller (only after fee_authorized) -> Hosted Onboarding/KYC ->
//   (verified) capture -> payment_ready. Void releases an uncaptured J5.
// State transitions/guards are pure and tested here; async/PayMe I/O lives in the
// flag-gated edge functions and is asserted structurally.
// ---------------------------------------------------------------------------

function read(relPath: string): string {
  return readFileSync(new URL(`../${relPath}`, import.meta.url), 'utf8')
}

const repoRoot = fileURLToPath(new URL('../', import.meta.url))
function walk(dir: string): string[] {
  const out: string[] = []
  const abs = fileURLToPath(new URL(`../${dir}/`, import.meta.url))
  for (const entry of readdirSync(abs)) {
    const relPath = `${dir}/${entry}`
    if (statSync(`${repoRoot}${relPath}`).isDirectory()) out.push(...walk(relPath))
    else if (/\.(ts|tsx)$/.test(entry)) out.push(relPath)
  }
  return out
}

const AUTHORIZE_FN = 'supabase/functions/payme-authorize-provider-activation/index.ts'
const CAPTURE_FN = 'supabase/functions/payme-capture-provider-activation/index.ts'
const VOID_FN = 'supabase/functions/payme-void-provider-activation/index.ts'
const MIGRATION = 'supabase/migrations/2026081701_provider_activation.sql'
const QUOTE_FN = 'supabase/functions/payme-provider-activation-quote/index.ts'
const FEE_CONFIG = 'supabase/functions/_shared/activationFeeConfig.ts'
const ACTIVATION_DB = 'supabase/functions/_shared/paymeActivationDb.ts'
const ACTIVATION_FILES = [
  AUTHORIZE_FN,
  CAPTURE_FN,
  VOID_FN,
  QUOTE_FN,
  MIGRATION,
  FEE_CONFIG,
  'supabase/functions/_shared/paymeActivation.ts',
  ACTIVATION_DB,
]

const NON_START = SERVER_STATES.filter((s) => s !== 'fee_authorized')

// --- Parity: the client and server state models are identical -----------------
test('client and server activation state sets are identical (parity)', () => {
  assert.deepEqual([...CLIENT_STATES], [...SERVER_STATES])
})

// (1) Readiness does not create a J5 authorization.
test('req1: marking ready never authorizes or contacts PayMe', () => {
  const readiness = read('src/payments/providerReadiness.ts')
  assert.ok(!/authoriz/i.test(readiness))
  assert.ok(!/generate-sale|payme-authorize/i.test(readiness))
  // The Stage A card issues no authorize call either.
  const card = read('src/components/ProviderReadinessCard.tsx')
  assert.ok(!/authorizeProviderActivationFee|generate-sale/.test(card))
})

// (2) Activation confirmation creates a J5 only; generate-sale lives in one place.
test('req2: only the authorize edge function calls generate-sale', () => {
  assert.ok(clientCanAuthorize('ready'))
  assert.ok(clientCanAuthorize('not_started'))
  assert.ok(read(AUTHORIZE_FN).includes('PAYME_GENERATE_SALE_PATH'))
  assert.ok(!read(CAPTURE_FN).includes('GENERATE_SALE'))
  assert.ok(!read(VOID_FN).includes('GENERATE_SALE'))
})

// (3) Seller is NOT created before J5 success.
test('req3: seller creation blocked in every state except fee_authorized', () => {
  for (const s of NON_START) {
    assert.equal(canCreateSellerForActivation(s), false, `server allowed seller from ${s}`)
    assert.equal(clientCanCreateSeller(s), false, `client allowed seller from ${s}`)
  }
})

// (4) J5 success allows create-seller.
test('req4: fee_authorized allows create-seller', () => {
  assert.equal(canCreateSellerForActivation('fee_authorized'), true)
  assert.equal(clientCanCreateSeller('fee_authorized'), true)
})

// (5) Existing seller is reused, never recreated (idempotency preserved).
test('req5: existing seller is reused, authorize never recreates it', () => {
  // create-payme-seller reuses an existing seller (idempotency).
  assert.ok(read('supabase/functions/create-payme-seller/index.ts').includes('reused_existing'))
  // Once a seller exists, canCreateSeller is false, so no second creation.
  assert.equal(canCreateSellerForActivation('seller_created'), false)
})

// (6) A held signup URL resumes Hosted Onboarding.
test('req6: signup URL resumes onboarding', () => {
  assert.equal(
    shouldResumePaymeSetup({
      paymeSellerId: 'seller_1',
      onboardingStatus: 'created',
      signupUrl: 'https://sandbox.payme.io/onboard/abc',
    }),
    true,
  )
})

// (7) Authorization expiry is detected (client + server), and window is 168h.
test('req7: authorization expiry detection + 168h window', () => {
  assert.equal(AUTHORIZATION_WINDOW_HOURS, 168)
  const authorizedAt = '2026-01-01T00:00:00.000Z'
  const expiresAt = computeAuthorizationExpiry(authorizedAt)
  assert.equal(expiresAt, '2026-01-08T00:00:00.000Z') // +168h
  assert.equal(clientIsExpired(expiresAt, '2026-01-07T23:59:59.000Z'), false)
  assert.equal(clientIsExpired(expiresAt, '2026-01-08T00:00:01.000Z'), true)
})

// (8) An expired authorization can never be captured.
test('req8: expired authorization collapses and cannot capture', () => {
  const now = '2026-01-10T00:00:00.000Z'
  const past = '2026-01-08T00:00:00.000Z'
  assert.equal(resolveExpiryState('kyc_approved', past, now), 'authorization_expired')
  assert.equal(canCaptureActivationFee('authorization_expired'), false)
  assert.ok(read(CAPTURE_FN).includes('AUTHORIZATION_EXPIRED'))
})

// (9) An expired authorization permits a NEW authorization.
test('req9: authorization_expired permits re-authorization', () => {
  assert.equal(canRequestActivationAuthorization('authorization_expired'), true)
  assert.equal(clientCanAuthorize('authorization_expired'), true)
})

// (10) A new J5 does not recreate the Seller.
test('req10: authorize function never creates a seller', () => {
  const src = read(AUTHORIZE_FN)
  // The authorize function must not INVOKE seller creation (PayMe /api/create-seller
  // or the create-payme-seller edge function). It may mention it in comments.
  assert.ok(!src.includes('/api/create-seller'))
  assert.ok(!/invokeEdgeFunction|functions\.invoke/.test(src))
})

// (11) KYC pending never captures.
test('req11: kyc_pending cannot capture', () => {
  assert.equal(canCaptureActivationFee('kyc_pending'), false)
  assert.equal(clientCanCapture('kyc_pending'), false)
})

// (12) Verified KYC approval may capture.
test('req12: kyc_approved may capture (and only kyc_approved)', () => {
  assert.equal(canCaptureActivationFee('kyc_approved'), true)
  for (const s of SERVER_STATES.filter((x) => x !== 'kyc_approved')) {
    assert.equal(canCaptureActivationFee(s), false)
  }
  // Verified approval is the only path into kyc_approved.
  assert.equal(applyVerifiedKycApproval('kyc_pending'), 'kyc_approved')
  assert.equal(applyVerifiedKycApproval('seller_created'), null)
})

// (13) Capture success -> payment_ready (only in the capture success path).
test('req13: capture success transitions to payment_ready', () => {
  const src = read(CAPTURE_FN)
  // payment_ready is only ever WRITTEN by the capture success path.
  assert.ok(src.includes("activation_state: 'payment_ready'"))
  assert.ok(!read(AUTHORIZE_FN).includes("activation_state: 'payment_ready'"))
  assert.ok(!read(VOID_FN).includes("activation_state: 'payment_ready'"))
})

// (14) Capture failure -> NOT payment_ready (reverts to kyc_approved, retryable).
test('req14: capture failure does not become payment_ready', () => {
  const src = read(CAPTURE_FN)
  assert.ok(src.includes('PAYME_CAPTURE_FAILED'))
  assert.ok(src.includes("activation_state: 'kyc_approved'"))
})

// (15) Duplicate capture prevented (single-capture claim + amount cap).
test('req15: duplicate capture prevented', () => {
  const src = read(CAPTURE_FN)
  assert.ok(src.includes("['kyc_approved']"))
  assert.ok(src.includes('alreadyCaptured'))
  // Capture amount can never exceed the authorized amount.
  assert.equal(isCaptureAmountValid(100, 100), true)
  assert.equal(isCaptureAmountValid(101, 100), false)
  assert.equal(isCaptureAmountValid(0, 100), false)
})

// (16) Cancelled/rejected uses an explicit void path.
test('req16: uncaptured states are voidable via explicit void', () => {
  for (const s of ['fee_authorizing', 'fee_authorized', 'seller_created', 'kyc_pending', 'kyc_approved'] as const) {
    assert.equal(canVoidActivation(s), true)
    assert.equal(clientCanVoid(s), true)
  }
  assert.ok(read(VOID_FN).includes('PAYME_VOID_SALE_PATH'))
})

// (17) Duplicate void is safe (idempotent).
test('req17: duplicate void is idempotent and nothing-to-void is guarded', () => {
  assert.equal(canVoidActivation('cancelled'), false)
  const src = read(VOID_FN)
  assert.ok(src.includes('alreadyVoided'))
  assert.ok(src.includes("state === 'cancelled'"))
})

// (18) A J5 that is never captured has no refund flow (void != refund).
test('req18: no refund flow in this phase; captured cannot be voided', () => {
  assert.equal(canVoidActivation('payment_ready'), false)
  assert.equal(canVoidActivation('fee_captured'), false)
  // No refund is invoked here (void != refund). Comments may say "refund"; the
  // check is that no refund CALL/endpoint is wired.
  for (const f of [AUTHORIZE_FN, CAPTURE_FN, VOID_FN]) {
    assert.ok(!/createRefund|refund-payment|\/refund/i.test(read(f)), `${f} must not invoke refunds`)
  }
  assert.ok(read(VOID_FN).includes('CANNOT_VOID_CAPTURED'))
})

// (19) Provider registration is unaffected: activation lives behind explicit calls.
test('req19: registration/auth paths never import activation-fee calls', () => {
  const callers = walk('src').filter((f) => /authorizeProviderActivationFee/.test(read(f)))
  // Only the payment abstraction and the Stage B gate — never any auth/registration
  // /availability path.
  const allowed = /(PayMeProvider|PaymentService|PaymentProvider|StripeProvider|providerActivation)\.ts$|ProviderPaymentActivation\.tsx$/
  for (const f of callers) {
    assert.ok(allowed.test(f), `unexpected authorize caller: ${f}`)
  }
})

// (20) Availability is unaffected; eligibility is payment_ready only.
test('req20: paid-order eligibility is payment_ready only', () => {
  assert.equal(isProviderPaymentReady('payment_ready'), true)
  for (const s of SERVER_STATES.filter((x) => x !== 'payment_ready')) {
    assert.equal(isProviderPaymentReady(s), false, `${s} must not be payment-ready`)
    assert.equal(clientIsPaymentReady(s), false)
  }
  assert.ok(read('src/screens/WalkerDashboard.tsx').includes('isProviderPaymentReady(activationState)'))
})

// (21) Card / KYC / bank data are never persisted.
test('req21: no card/bank/secret field is stored anywhere in activation code', () => {
  const forbidden = [
    'card_number',
    'cvv',
    'iban',
    'bank_account',
    'social_id',
    'date_of_birth',
    'id_issue',
  ]
  for (const f of ACTIVATION_FILES) {
    const src = read(f)
    for (const token of forbidden) {
      assert.ok(!src.includes(token), `${f} must not contain ${token}`)
    }
  }
})

// (22) No seller secret is ever stored/returned.
test('req22: no seller secret anywhere in activation code', () => {
  for (const f of ACTIVATION_FILES) {
    assert.ok(!/seller_payme_secret|seller_secret/.test(read(f)), `${f} references a seller secret`)
  }
})

// (23) The activation fee is SERVER-AUTHORITATIVE with a single source of truth,
//      and the client never independently decides the amount.
test('req23: activation fee is server-authoritative, single source of truth', () => {
  // No price literal anywhere in the client anymore.
  assert.deepEqual(walk('src').filter((f) => read(f).includes('29900')), [])
  // The client fee module holds ONLY a formatter — no amount/VAT computation.
  const clientCfg = read('src/config/activationFee.ts')
  assert.ok(!/netAgorot|vatAgorot|grossAgorot|vatRate/.test(clientCfg))
  // The single source of truth is the server fee config.
  assert.ok(read(FEE_CONFIG).includes('29900'))
  // Quote math: 299.00 net + 18% VAT = 352.82 gross.
  const expected = { currency: 'ILS', netAgorot: 29900, vatAgorot: 5382, grossAgorot: 35282 }
  assert.deepEqual(computeActivationFeeQuote(29900, 0.18), expected)
  // The authoritative default resolves to the same quote (used by BOTH the quote
  // endpoint and the J5 authorization — so displayed and charged amounts can't drift).
  assert.deepEqual(resolveActivationFeeQuote(() => undefined), expected)
  // The J5 authorize function derives its amount from the shared config, not a literal.
  const authSrc = read(AUTHORIZE_FN)
  assert.ok(authSrc.includes('resolveActivationFeeQuote'))
  assert.ok(!authSrc.includes('29900'))
  // The quote endpoint returns the same authoritative config.
  assert.ok(read(QUOTE_FN).includes('resolveActivationFeeQuote'))
  assert.equal(formatAgorotAmount(35282), '352.82')
})

// (24) HE + EN activation copy exists.
test('req24: HE and EN activation copy present', () => {
  const i18n = read('src/i18n.ts')
  assert.ok(i18n.includes('Provider account activation'))
  assert.ok(i18n.includes('הפעלת חשבון ספק'))
  assert.ok(i18n.includes('providerActivation:'))
})

// (25) PAYME_SELLER_ONBOARDING_ENABLED remains false; all new fns gate on it.
test('req25: all new edge functions gate on PAYME_SELLER_ONBOARDING_ENABLED', () => {
  for (const f of [AUTHORIZE_FN, CAPTURE_FN, VOID_FN]) {
    const src = read(f)
    assert.ok(src.includes('PAYME_SELLER_ONBOARDING_ENABLED'))
    assert.ok(src.includes("flagValue !== 'true'"))
    assert.ok(src.includes('skipped'))
  }
})

// (26) The migration is additive, private, and RLS-guarded (owner read-only).
test('req26: migration adds a private, RLS-guarded, owner-read-only table', () => {
  const sql = read(MIGRATION)
  assert.ok(sql.includes('create table if not exists public.provider_activation'))
  assert.ok(sql.includes('enable row level security'))
  assert.ok(sql.includes('grant select on public.provider_activation to authenticated'))
  assert.ok(sql.includes('to service_role'))
  assert.ok(sql.includes('provider activation select own'))
  // Owner must NOT be able to mutate state: no insert/update policy for authenticated.
  assert.ok(!/for insert\s+to authenticated/i.test(sql))
  assert.ok(!/for update\s+to authenticated/i.test(sql))
})

// --- Seller/KYC verification is tracked INDEPENDENTLY of the fee lifecycle -----
// (Fix 1: a single enum cannot represent "authorization expired" AND "KYC approved"
// at the same time; KYC approval must survive expiry / re-authorization.)

test('parity: client and server seller-verification status sets are identical', () => {
  assert.deepEqual([...CLIENT_SELLER_STATUSES], [...SERVER_SELLER_STATUSES])
  assert.deepEqual([...SERVER_SELLER_STATUSES], ['not_started', 'pending', 'approved', 'rejected'])
})

test('schema persists seller verification independently of activation state', () => {
  const sql = read(MIGRATION)
  assert.ok(sql.includes('seller_verification_status'))
  assert.ok(sql.includes('seller_verified_at'))
  assert.ok(/'not_started', 'pending', 'approved', 'rejected'/.test(sql))
  // The DB row model exposes both columns to the orchestration layer.
  const db = read(ACTIVATION_DB)
  assert.ok(db.includes('seller_verification_status'))
  assert.ok(db.includes('seller_verified_at'))
})

test('KYC approval only ever comes from the verified seam (pending -> approved)', () => {
  assert.equal(applyVerifiedSellerVerification('pending'), 'approved')
  assert.equal(applyVerifiedSellerVerification('not_started'), null)
  assert.equal(applyVerifiedSellerVerification('approved'), null)
  assert.equal(applyVerifiedSellerVerification('rejected'), null)
  assert.equal(isSellerKycApproved('approved'), true)
  assert.equal(isSellerKycApproved('pending'), false)
})

test('race: authorization expired + KYC pending -> reauthorize keeps waiting for KYC', () => {
  const past = '2026-01-08T00:00:00.000Z'
  const now = '2026-01-10T00:00:00.000Z'
  // Expiry collapses the activation state; the (independent) KYC fact is untouched.
  assert.equal(resolveExpiryState('kyc_pending', past, now), 'authorization_expired')
  assert.equal(canRequestActivationAuthorization('authorization_expired'), true)
  // A fresh verified J5 with KYC still pending resumes waiting — no capture, and the
  // existing seller is NOT recreated.
  assert.equal(resolveStateAfterVerifiedAuthorization('pending'), 'kyc_pending')
  assert.equal(applyVerifiedAuthorization('fee_authorizing', 'pending'), 'kyc_pending')
  assert.equal(canCaptureActivationFee('kyc_pending'), false)
  assert.equal(canCreateSellerForActivation('kyc_pending'), false)
})

test('race: authorization expired + KYC approved -> reauthorize goes straight to capture', () => {
  const past = '2026-01-08T00:00:00.000Z'
  const now = '2026-01-10T00:00:00.000Z'
  // BOTH facts true at once: authorization expired AND seller KYC approved.
  assert.equal(resolveExpiryState('kyc_approved', past, now), 'authorization_expired')
  assert.equal(isSellerKycApproved('approved'), true)
  // A fresh verified J5 jumps straight to capture-ready, reusing the seller.
  assert.equal(resolveStateAfterVerifiedAuthorization('approved'), 'kyc_approved')
  assert.equal(applyVerifiedAuthorization('fee_authorizing', 'approved'), 'kyc_approved')
  assert.equal(canCaptureActivationFee('kyc_approved'), true)
  assert.equal(canCreateSellerForActivation('kyc_approved'), false)
})

test('first-time authorization (no seller yet) still creates the seller', () => {
  assert.equal(resolveStateAfterVerifiedAuthorization('not_started'), 'fee_authorized')
  assert.equal(resolveStateAfterVerifiedAuthorization(undefined), 'fee_authorized')
  assert.equal(applyVerifiedAuthorization('fee_authorizing'), 'fee_authorized')
  assert.equal(canCreateSellerForActivation('fee_authorized'), true)
})

test('KYC approval arriving during expiry is persisted independently, not lost', () => {
  // The verified-approval DB seam writes the durable seller_verification column and
  // only conditionally advances activation_state (gated on the LIVE kyc_pending
  // authorization). An approval during expiry therefore persists and is honored on
  // the next re-authorization.
  const db = read(ACTIVATION_DB)
  assert.ok(db.includes('applyVerifiedSellerVerification'))
  assert.ok(/seller_verification_status: nextStatus/.test(db))
  assert.ok(db.includes('seller_verified_at'))
  // Advancing activation_state stays gated on the live authorization.
  assert.ok(db.includes("['kyc_pending']"))
})

// --- PayMe request builders inject credentials, never card data ---------------
test('authorization request is authorize-type and carries no card data', () => {
  const body = buildActivationAuthorizationRequest({
    clientKey: 'ck',
    regliSellerId: 'MPL0000',
    amountAgorot: 35282,
    currency: 'ILS',
    productName: 'x',
    transactionId: 'regli-activation-abc-1',
  })
  assert.equal(body.sale_type, 'authorize')
  assert.equal(body.sale_price, 35282)
  assert.equal(body.seller_payme_id, 'MPL0000')
  const serialized = JSON.stringify(body)
  assert.ok(!/card|cvv|pan/i.test(serialized))
})

test('capture request never exceeds authorized amount contract', () => {
  const body = buildActivationCaptureRequest({ clientKey: 'ck', paymeSaleId: 's1', salePriceAgorot: 35282 })
  assert.equal(body.payme_sale_id, 's1')
  assert.equal(body.sale_price, 35282)
})

test('void request targets the authorization sale', () => {
  const body = buildActivationVoidRequest({ clientKey: 'ck', paymeSaleId: 's1' })
  assert.equal(body.payme_sale_id, 's1')
})

test('response parsers extract only safe fields', () => {
  const auth = parseAuthorizationResponse({ status_code: 0, payme_sale_id: 's1', sale_url: 'https://p' })
  assert.deepEqual(auth, { ok: true, paymeSaleId: 's1', saleUrl: 'https://p', statusCode: 0 })
  assert.equal(parseCaptureResponse({ status_code: 1 }).ok, false)
})

test('verified-authorization seam only advances from fee_authorizing', () => {
  assert.equal(applyVerifiedAuthorization('fee_authorizing'), 'fee_authorized')
  assert.equal(applyVerifiedAuthorization('ready'), null)
})
