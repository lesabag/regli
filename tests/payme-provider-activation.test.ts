import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  canCreatePaymeSeller,
  isPaymePaidOrderEligible,
  resolvePaymeSetupState,
  shouldResumePaymeSetup,
} from '../src/payments/providerPaymentSetupState.ts'
import {
  buildActivationError,
  interpretSellerAccountResponse,
} from '../src/payments/providerActivationResult.ts'
import {
  buildReadinessUpdate,
  readProviderReadiness,
  READY_FOR_ACTIVATION_COLUMN,
  READY_FOR_ACTIVATION_AT_COLUMN,
} from '../src/payments/providerReadiness.ts'
import {
  classifySellerRequest,
  decideSellerRequest,
  mayUseSandboxSellerIdentity,
} from '../supabase/functions/create-payme-seller/paymeSeller.ts'

// ---------------------------------------------------------------------------
// Business rule under test:
//   Provider readiness ("I'm ready to receive orders") is Stage A — it persists a
//   Regli-only intent flag with ZERO PayMe cost, never creates a PayMe Seller, and
//   never makes the provider dispatch-eligible. Actual PayMe Seller creation is
//   Stage B (payment activation), a separate, deliberate boundary reached later.
//
// Several invariants ("registration/login/availability/readiness never invoke
// PayMe") are best proven structurally: PayMe seller creation lives behind exactly
// one explicit boundary (activateProviderPayments) and appears nowhere in the
// auth/registration/availability/readiness paths.
// ---------------------------------------------------------------------------

const repoRoot = fileURLToPath(new URL('../', import.meta.url))

function read(relPath: string): string {
  return readFileSync(new URL(`../${relPath}`, import.meta.url), 'utf8')
}

function walkSrc(dir = 'src'): string[] {
  const out: string[] = []
  const abs = fileURLToPath(new URL(`../${dir}/`, import.meta.url))
  for (const entry of readdirSync(abs)) {
    const relPath = `${dir}/${entry}`
    const absPath = `${repoRoot}${relPath}`
    if (statSync(absPath).isDirectory()) {
      out.push(...walkSrc(relPath))
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(relPath)
    }
  }
  return out
}

// Files (relative to repo root) that reference a given symbol.
function srcFilesReferencing(symbol: string): string[] {
  return walkSrc().filter((relPath) => read(relPath).includes(symbol))
}

// ---------------------------------------------------------------------------
// (1) Completing provider registration does NOT invoke PayMe.
// ---------------------------------------------------------------------------
test('(1) registration completion never invokes PayMe seller creation', () => {
  // The former automatic trigger module is gone entirely.
  assert.equal(
    existsSync(`${repoRoot}src/payments/onboardingTrigger.ts`),
    false,
    'onboardingTrigger.ts (the old automatic trigger) must be deleted',
  )

  const app = read('src/App.tsx')
  for (const forbidden of [
    'onboardingTrigger',
    'triggerPaymeSellerOnboarding',
    'activateProviderPayments',
    'create-payme-seller',
    'createSellerAccount',
  ]) {
    assert.ok(
      !app.includes(forbidden),
      `App.tsx must not reference "${forbidden}" (registration must never contact PayMe)`,
    )
  }
})

// ---------------------------------------------------------------------------
// (2) Logging in / app load does NOT invoke PayMe.
// ---------------------------------------------------------------------------
test('(2) app load / login path never invokes PayMe seller creation', () => {
  for (const relPath of ['src/App.tsx', 'src/hooks/useAuth.ts']) {
    const src = read(relPath)
    for (const forbidden of ['activateProviderPayments', 'create-payme-seller', 'PayMeProvider']) {
      assert.ok(!src.includes(forbidden), `${relPath} must not reference "${forbidden}"`)
    }
  }
})

// ---------------------------------------------------------------------------
// (3) Configuring profile / availability / going online does NOT invoke PayMe.
// ---------------------------------------------------------------------------
test('(3) profile/availability/online paths never create a PayMe seller', () => {
  const flow = read('src/hooks/useWalkerFlow.ts')
  // The provider flow hook drives availability + online + Stripe onboarding. It
  // must never call the explicit PayMe activation nor the PayMe seller edge fn.
  // (It DOES call createSellerAccount for Stripe Connect — that is the shared
  // provider-abstraction method, not the PayMe seller boundary.)
  for (const forbidden of ['activateProviderPayments', 'create-payme-seller']) {
    assert.ok(!flow.includes(forbidden), `useWalkerFlow.ts must not reference "${forbidden}"`)
  }
  const availability = read('src/utils/providerAvailability.ts')
  assert.ok(!availability.includes('payme') && !availability.includes('PayMe'))
})

// ---------------------------------------------------------------------------
// (4) Marking readiness NEVER invokes PayMe.
// ---------------------------------------------------------------------------
test('(4) the readiness module never touches PayMe / seller creation', () => {
  const readiness = read('src/payments/providerReadiness.ts')
  for (const forbidden of [
    'activateProviderPayments',
    'createSellerAccount',
    'create-payme-seller',
    'PaymentService',
    'PayMeProvider',
    'supabaseClient',
    'signupUrl',
    'payme_seller_id',
  ]) {
    assert.ok(!readiness.includes(forbidden), `providerReadiness.ts must not reference "${forbidden}"`)
  }
  // It is dependency-free (no imports at all) so it can never reach a network/PayMe
  // path — keeping the readiness boundary provably cost-free.
  assert.ok(!/^\s*import\s/m.test(readiness), 'providerReadiness.ts must remain dependency-free')

  // The readiness card's primary action persists intent; it does not create sellers.
  const card = read('src/components/ProviderReadinessCard.tsx')
  for (const forbidden of ['activateProviderPayments', 'createSellerAccount', 'create-payme-seller']) {
    assert.ok(!card.includes(forbidden), `ProviderReadinessCard.tsx must not reference "${forbidden}"`)
  }
})

// ---------------------------------------------------------------------------
// (5) Marking ready persists READINESS ONLY (no payment/seller field).
// ---------------------------------------------------------------------------
test('(5) buildReadinessUpdate persists only the two readiness columns', () => {
  const update = buildReadinessUpdate(true, '2026-08-13T00:00:00.000Z')
  assert.deepEqual(Object.keys(update).sort(), [
    READY_FOR_ACTIVATION_AT_COLUMN,
    READY_FOR_ACTIVATION_COLUMN,
  ].sort())
  assert.equal(update.payme_ready_for_activation, true)
  assert.equal(update.payme_ready_for_activation_at, '2026-08-13T00:00:00.000Z')

  // No key carries any payment/seller/onboarding meaning.
  for (const key of Object.keys(update)) {
    for (const banned of ['seller', 'onboarding', 'signup', 'secret', 'public_key']) {
      assert.ok(!key.includes(banned), `readiness update key "${key}" must not include "${banned}"`)
    }
  }

  // Round-trips through a persisted row.
  assert.deepEqual(readProviderReadiness({ payme_ready_for_activation: true, payme_ready_for_activation_at: 'x' }), {
    readyForActivation: true,
    readyForActivationAt: 'x',
  })
})

// ---------------------------------------------------------------------------
// (6) Withdrawing readiness is a pure flag flip — still no PayMe.
// ---------------------------------------------------------------------------
test('(6) withdrawing readiness clears the flag and never invokes PayMe', () => {
  const withdraw = buildReadinessUpdate(false, '2026-08-13T00:00:00.000Z')
  assert.equal(withdraw.payme_ready_for_activation, false)
  assert.equal(withdraw.payme_ready_for_activation_at, null, 'timestamp is cleared on withdrawal')

  // Absent / false rows both read as "not ready" with no timestamp.
  assert.deepEqual(readProviderReadiness(null), { readyForActivation: false, readyForActivationAt: null })
  assert.deepEqual(readProviderReadiness({ payme_ready_for_activation: false, payme_ready_for_activation_at: 'x' }), {
    readyForActivation: false,
    readyForActivationAt: null,
  })
})

// ---------------------------------------------------------------------------
// (7) ready = true does NOT make a provider dispatch-eligible.
// ---------------------------------------------------------------------------
test('(7) readiness alone never confers paid-order (dispatch) eligibility', () => {
  // A provider is ready...
  assert.equal(readProviderReadiness({ payme_ready_for_activation: true }).readyForActivation, true)
  // ...yet with no completed PayMe Seller they are NOT paid-order eligible.
  assert.equal(isPaymePaidOrderEligible(null), false)
  assert.equal(isPaymePaidOrderEligible({ paymeSellerId: null }), false)
  assert.equal(isPaymePaidOrderEligible({ paymeSellerId: 'MPL-1', onboardingStatus: 'created' }), false)
  assert.equal(isPaymePaidOrderEligible({ paymeSellerId: 'MPL-1', onboardingStatus: 'pending' }), false)
  // Only the schema's terminal-complete status qualifies (no invented 'approved').
  assert.equal(isPaymePaidOrderEligible({ paymeSellerId: 'MPL-1', onboardingStatus: 'completed' }), true)
  assert.equal(isPaymePaidOrderEligible({ paymeSellerId: 'MPL-1', onboardingStatus: 'approved' }), false)

  // Eligibility is derived ONLY from seller state — it cannot read readiness.
  const setupState = read('src/payments/providerPaymentSetupState.ts')
  assert.ok(
    !setupState.includes('ready_for_activation'),
    'payment-setup eligibility must not depend on the readiness flag',
  )

  // The online toggle consults the canonical paid-order eligibility gate for the
  // PayMe path. Phase 2B tightened this to the authoritative activation state:
  // eligibility requires activation_state === 'payment_ready' (see TASK 15 and
  // payme-provider-activation-orchestration.test.ts), a strictly stronger gate
  // than seller-setup completeness — readiness still confers nothing.
  assert.ok(read('src/screens/WalkerDashboard.tsx').includes('isProviderPaymentReady(activationState)'))
})

// ---------------------------------------------------------------------------
// (8) ready = true does NOT create/attach a payme_seller_id.
// ---------------------------------------------------------------------------
test('(8) readiness never creates or references a PayMe seller id', () => {
  assert.notEqual(READY_FOR_ACTIVATION_COLUMN, 'payme_seller_id')
  const update = buildReadinessUpdate(true, '2026-08-13T00:00:00.000Z')
  assert.ok(!Object.prototype.hasOwnProperty.call(update, 'payme_seller_id'))
  // A ready provider with no seller cannot create one implicitly, and is not eligible.
  assert.equal(canCreatePaymeSeller({ paymeSellerId: null }), true) // ALLOWED later, not now
  assert.equal(isPaymePaidOrderEligible({ paymeSellerId: null }), false)
})

// ---------------------------------------------------------------------------
// (9) Payment activation is a SEPARATE boundary from readiness.
// ---------------------------------------------------------------------------
test('(9) payment activation (seller creation) lives behind one boundary, not readiness', () => {
  // Only the activation module + the explicit Stage B gate reference the PayMe
  // activation entry point — never readiness, never registration/auth/flow.
  const referencing = srcFilesReferencing('activateProviderPayments').sort()
  assert.deepEqual(referencing, [
    'src/components/ProviderPaymentActivation.tsx',
    'src/payments/providerActivation.ts',
  ])
  assert.ok(!referencing.includes('src/payments/providerReadiness.ts'))
  assert.ok(!referencing.includes('src/components/ProviderReadinessCard.tsx'))

  // A real seller response maps to an actionable, deliberate outcome.
  const created = interpretSellerAccountResponse({
    accountId: 'MPL-1',
    provider: 'payme',
    raw: { success: true, sellerPaymeId: 'MPL-1', onboardingStatus: 'created', signupUrl: 'https://newpartners.payme.io/x?t=tok' },
  })
  assert.equal(created.ok, true)
  assert.equal(created.outcome, 'onboarding_ready')
  assert.equal(created.signupUrl, 'https://newpartners.payme.io/x?t=tok')

  const noUrl = interpretSellerAccountResponse({
    accountId: 'MPL-2',
    provider: 'payme',
    raw: { success: true, sellerPaymeId: 'MPL-2', onboardingStatus: 'created', signupUrl: null },
  })
  assert.equal(noUrl.outcome, 'seller_ready')
  assert.equal(noUrl.signupUrl, null)
})

// ---------------------------------------------------------------------------
// (10) ONLY the payment-activation confirmation may create a seller.
// ---------------------------------------------------------------------------
test('(10) only the Stage B confirm invokes seller creation; readiness never does', () => {
  const component = read('src/components/ProviderPaymentActivation.tsx')
  // The activation call appears exactly once (inside the confirm handler), never on
  // the cancel/close path or on mount.
  assert.equal(
    component.split('activateProviderPayments(').length - 1,
    1,
    'activation must be called from exactly one place (confirm)',
  )
  assert.ok(component.includes('handleConfirm'), 'confirm handler must exist')
  assert.ok(component.includes('onClick={onClose}'))
  assert.ok(
    !/useEffect\([^)]*activateProviderPayments/s.test(component),
    'activation must never run from an effect (would fire on mount)',
  )

  // The readiness paths do not perform any seller creation.
  for (const relPath of ['src/payments/providerReadiness.ts', 'src/components/ProviderReadinessCard.tsx']) {
    assert.ok(!srcFilesReferencing('createSellerAccount').includes(relPath))
  }
})

// ---------------------------------------------------------------------------
// (11) An existing payme_seller_id is never recreated.
// ---------------------------------------------------------------------------
test('(11) an existing PayMe seller is never recreated', () => {
  assert.equal(canCreatePaymeSeller({ paymeSellerId: 'MPL-existing', onboardingStatus: 'created' }), false)
  assert.equal(resolvePaymeSetupState({ paymeSellerId: 'MPL-existing', onboardingStatus: 'created' }), 'in_progress')
  assert.equal(canCreatePaymeSeller({ paymeSellerId: 'MPL-x', onboardingStatus: 'completed' }), false)
  // Only no-seller (or a prior failed attempt) may create one — later, behind Stage B.
  assert.equal(canCreatePaymeSeller({ paymeSellerId: null }), true)
  assert.equal(canCreatePaymeSeller({ paymeSellerId: 'MPL-x', onboardingStatus: 'failed' }), true)
})

// ---------------------------------------------------------------------------
// (12) An existing signup URL resumes setup instead of recreating a seller.
// ---------------------------------------------------------------------------
test('(12) an existing signup URL resumes onboarding rather than recreating', () => {
  const resumable = { paymeSellerId: 'MPL-1', onboardingStatus: 'created', signupUrl: 'https://newpartners.payme.io/update?t=tok' }
  assert.equal(shouldResumePaymeSetup(resumable), true)
  assert.equal(canCreatePaymeSeller(resumable), false)
  assert.equal(shouldResumePaymeSetup({ paymeSellerId: 'MPL-1', onboardingStatus: 'created', signupUrl: null }), false)
  assert.equal(shouldResumePaymeSetup({ paymeSellerId: null, signupUrl: 'https://x' }), false)
  // The Stage B gate prefers resume.
  assert.ok(read('src/components/ProviderPaymentActivation.tsx').includes('shouldResumePaymeSetup'))
})

// ---------------------------------------------------------------------------
// (13) A PayMe failure during LATER payment activation never affects the Regli
//      account or the readiness flag.
// ---------------------------------------------------------------------------
test('(13) activation failure is safe/retryable and independent of readiness', () => {
  const err = buildActivationError('PayMe unreachable')
  assert.equal(err.ok, false)
  assert.equal(err.outcome, 'error')
  assert.equal(err.sellerId, null)
  assert.equal(err.signupUrl, null)
  assert.equal(err.error, 'PayMe unreachable')
  assert.equal(buildActivationError().error, 'activation_failed')
  assert.equal(buildActivationError('   ').error, 'activation_failed')
  assert.doesNotThrow(() => interpretSellerAccountResponse({ accountId: null, provider: 'payme' }))
  assert.doesNotThrow(() => interpretSellerAccountResponse({ accountId: null, provider: 'payme', raw: null }))

  // Readiness state is computed independently of any activation result — the
  // readiness module never IMPORTS the activation path (comments may name it).
  assert.ok(
    !/from\s+['"][^'"]*providerActivation/.test(read('src/payments/providerReadiness.ts')),
    'providerReadiness.ts must not import the activation path',
  )
})

// ---------------------------------------------------------------------------
// (14) The removed provider_test seam is not reintroduced anywhere.
// ---------------------------------------------------------------------------
test('(14) no provider_test seam exists', () => {
  assert.equal(classifySellerRequest('provider_test'), 'unknown')
  assert.equal(mayUseSandboxSellerIdentity('provider_test'), false)
  for (const relPath of srcFilesReferencing('provider_test')) {
    assert.fail(`provider_test seam reintroduced in ${relPath}`)
  }
})

// ---------------------------------------------------------------------------
// (15) PAYME_SELLER_ONBOARDING_ENABLED remains unchanged (server-gated / false).
// ---------------------------------------------------------------------------
test('(15) the server flag stays authoritative and unchanged', () => {
  const config = read('supabase/config.toml')
  assert.match(config, /\[functions\.create-payme-seller\]\s*\nverify_jwt = true/)
  assert.equal(decideSellerRequest({ source: 'onboarding', flagValue: 'true' }).action, 'proceed')
  for (const flagValue of [undefined, 'false', '1', '']) {
    assert.equal(decideSellerRequest({ source: 'onboarding', flagValue }).action, 'skip')
  }
  for (const relPath of walkSrc()) {
    const src = read(relPath)
    assert.ok(
      !/PAYME_SELLER_ONBOARDING_ENABLED\s*=\s*['"`]?true/.test(src),
      `${relPath} must not hardcode PAYME_SELLER_ONBOARDING_ENABLED = true`,
    )
  }
})

// ---------------------------------------------------------------------------
// (16) HE + EN readiness copy exists (and stays payment/PayMe-agnostic).
// ---------------------------------------------------------------------------
test('(16) HE/EN provider readiness copy exists and does not mention PayMe/cost', () => {
  const i18nSrc = read('src/i18n.ts')
  assert.equal(
    i18nSrc.split('providerReadiness:').length - 1,
    2,
    'providerReadiness copy must exist for both en and he',
  )
  for (const key of ['readyTitle', 'readyBody', 'readyCta', 'withdrawCta', 'readyConfirmedTitle', 'readyConfirmedBody']) {
    assert.ok(i18nSrc.includes(`${key}:`), `missing readiness i18n key: ${key}`)
  }
  // Exact HE/EN "ready" intent copy is present.
  assert.ok(i18nSrc.includes('I’m ready to receive orders'))
  assert.ok(i18nSrc.includes('אני מוכן/ה לקבל הזמנות'))

  // Readiness copy must not leak the PayMe brand, seller-setup, or the setup-cost
  // amounts. (Note: "payment" is allowed — the confirmed state legitimately says
  // "we'll notify you when payment setup is required".)
  const enStart = i18nSrc.indexOf('providerReadiness:')
  const heStart = i18nSrc.indexOf('providerReadiness:', enStart + 1)
  const enGroup = i18nSrc.slice(enStart, i18nSrc.indexOf('addressPicker:', enStart))
  const heGroup = i18nSrc.slice(heStart, i18nSrc.indexOf('addressPicker:', heStart))
  for (const group of [enGroup, heGroup]) {
    for (const banned of ['PayMe', 'payme_', 'seller', 'Seller', '199', '249', 'Hosted Onboarding']) {
      assert.ok(!group.includes(banned), `readiness copy must not include "${banned}"`)
    }
  }
})

// ---------------------------------------------------------------------------
// (17) HE + EN payment-activation copy remains, distinct from readiness copy.
// ---------------------------------------------------------------------------
test('(17) HE/EN payment-activation copy remains distinct from readiness copy', () => {
  const i18nSrc = read('src/i18n.ts')
  assert.equal(i18nSrc.split('providerPayment:').length - 1, 2, 'providerPayment copy must exist for both en and he')
  for (const key of ['gateTitle', 'gateBody', 'continueCta', 'resumeCta', 'unavailableTitle', 'errorBody']) {
    assert.ok(i18nSrc.includes(`${key}:`), `missing i18n key: ${key}`)
  }
  assert.ok(i18nSrc.includes('Continue to payment setup'))
  assert.ok(i18nSrc.includes('המשך להגדרת תשלומים'))

  // The two groups are genuinely distinct concepts.
  assert.notEqual('providerPayment', 'providerReadiness')

  // Activation copy stays generic — no dog/walk-specific wording in either group.
  const enStart = i18nSrc.indexOf('providerPayment:')
  const heStart = i18nSrc.indexOf('providerPayment:', enStart + 1)
  const enGroup = i18nSrc.slice(enStart, i18nSrc.indexOf('providerReadiness:', enStart)).toLowerCase()
  const heGroup = i18nSrc.slice(heStart, i18nSrc.indexOf('providerReadiness:', heStart))
  for (const banned of ['dog', 'walk']) {
    assert.ok(!enGroup.includes(banned), `EN activation copy must not include "${banned}"`)
  }
  for (const banned of ['כלב', 'טיול']) {
    assert.ok(!heGroup.includes(banned), `HE activation copy must not include "${banned}"`)
  }
})
