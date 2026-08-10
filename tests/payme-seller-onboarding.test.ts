import assert from 'node:assert/strict'
import test from 'node:test'

import { runNonBlocking } from '../src/payments/nonBlocking.ts'
import {
  buildProviderSellerRequestBody,
  buildSafeSellerResult,
  buildSandboxSellerRequestBody,
  classifyClaimOutcome,
  classifySellerRequest,
  decideSellerRequest,
  extractSafeMissingFieldName,
  extractSafeSellerMetadata,
  isPaymeRequiredFieldError,
  isPaymeSuccess,
  mayUseSandboxSellerIdentity,
  normalizeProviderSellerInput,
  PAYME_ONBOARDING_STATUS,
  resolveExistingSeller,
  SANDBOX_SELLER_IDENTITY,
  validateProviderSellerInput,
  type PaymeCreateSellerRaw,
} from '../supabase/functions/create-payme-seller/paymeSeller.ts'

// A complete minimal real-provider profile. KYC/banking is owned by PayMe Hosted
// Onboarding, so Regli only needs email / a derivable first name / phone.
const COMPLETE_PROFILE = {
  email: 'dana@example.com',
  full_name: 'Dana Cohen',
  whatsapp_number: '+972501112233',
}

// A representative successful PayMe /api/create-seller response. It deliberately
// includes `seller_payme_secret` to prove we never surface it.
const SUCCESS_RESPONSE: PaymeCreateSellerRaw = {
  status_code: 0,
  seller_payme_id: 'MPL16121-abc',
  seller_payme_secret: 'super-secret-value-should-never-leak',
  seller_public_key: {
    uuid: 'pk-uuid-123',
    description: 'PayMe-Public-Key',
    is_active: true,
  },
  seller_id: null,
  seller_dashboard_signup_link: 'https://sandbox.payme.io/onboarding/abc',
  session: 'sess-1',
}

test('(1) existing seller is returned as-is and never recreated', () => {
  const existing = resolveExistingSeller({
    payme_seller_id: 'MPL-existing',
    payme_onboarding_status: 'created',
    payme_signup_url: 'https://sandbox.payme.io/onboarding/existing',
  })

  assert.ok(existing, 'expected an existing-seller result')
  assert.equal(existing?.sellerPaymeId, 'MPL-existing')
  assert.equal(existing?.onboardingStatus, 'created')
  assert.equal(existing?.signupUrl, 'https://sandbox.payme.io/onboarding/existing')

  // No seller id yet -> null so the caller proceeds to create one.
  assert.equal(resolveExistingSeller({ payme_seller_id: null }), null)
  assert.equal(resolveExistingSeller(null), null)
})

test('(2) successful response yields safe seller metadata to persist', () => {
  const metadata = extractSafeSellerMetadata(SUCCESS_RESPONSE)
  assert.ok(metadata)
  assert.equal(metadata?.sellerPaymeId, 'MPL16121-abc')
  assert.equal(metadata?.publicKeyUuid, 'pk-uuid-123')
  assert.equal(metadata?.signupUrl, 'https://sandbox.payme.io/onboarding/abc')

  // Missing seller id -> null (treated as failure by the edge function).
  assert.equal(extractSafeSellerMetadata({ status_code: 0 }), null)
})

test('(3) seller_payme_secret is never extracted or returned to the client', () => {
  const metadata = extractSafeSellerMetadata(SUCCESS_RESPONSE)
  assert.ok(metadata)

  const result = buildSafeSellerResult(
    metadata!.sellerPaymeId,
    PAYME_ONBOARDING_STATUS.created,
    metadata!.signupUrl,
  )

  const serialized = JSON.stringify({ metadata, result })
  assert.doesNotMatch(serialized, /secret/i)
  assert.doesNotMatch(serialized, /super-secret-value/)

  // The client result exposes only the safe, whitelisted keys.
  assert.deepEqual(Object.keys(result).sort(), [
    'onboardingStatus',
    'sellerPaymeId',
    'signupUrl',
    'success',
  ])
})

test('(4) HTTP 200 with status_code != 0 is treated as failure', () => {
  assert.equal(isPaymeSuccess(SUCCESS_RESPONSE), true)
  assert.equal(isPaymeSuccess({ status_code: 1 }), false)
  assert.equal(isPaymeSuccess({ status_code: '0' }), false) // string, not number
  assert.equal(isPaymeSuccess({}), false)
  assert.equal(isPaymeSuccess(null), false)
})

test('(5) onboarding trigger failures never propagate (registration stays valid)', async () => {
  const failure = await runNonBlocking(async () => {
    throw new Error('PayMe unreachable')
  })
  assert.deepEqual(failure, { ok: false })

  const success = await runNonBlocking(async () => {
    /* no-op */
  })
  assert.deepEqual(success, { ok: true })
})

test('(6) the feature flag gates ONLY the automatic onboarding path', () => {
  // Automatic onboarding is gated by the flag: proceeds (real data) only when
  // the flag is exactly "true"; otherwise it is a safe skip (no PayMe call).
  assert.deepEqual(decideSellerRequest({ source: 'onboarding', flagValue: 'true' }), {
    intent: 'onboarding',
    action: 'proceed',
    payloadKind: 'provider',
  })
  for (const flagValue of [undefined, 'false', '1', '']) {
    assert.deepEqual(decideSellerRequest({ source: 'onboarding', flagValue }), {
      intent: 'onboarding',
      action: 'skip',
      payloadKind: null,
    })
  }

  // Explicit/absent-source sandbox invocations stay callable regardless of the flag.
  assert.deepEqual(decideSellerRequest({ source: null, flagValue: undefined }), {
    intent: 'sandbox',
    action: 'proceed',
    payloadKind: 'sandbox',
  })
  assert.deepEqual(decideSellerRequest({ source: 'sandbox', flagValue: 'false' }), {
    intent: 'sandbox',
    action: 'proceed',
    payloadKind: 'sandbox',
  })
})

test('(7) the sandbox identity is reachable ONLY by the explicit sandbox intent', () => {
  // The real-data onboarding intent may never build the fixed sandbox identity —
  // even if the feature flag is later flipped to "true".
  assert.equal(mayUseSandboxSellerIdentity('onboarding'), false)

  // Explicit/absent-source sandbox invocations may use it for integration testing.
  assert.equal(mayUseSandboxSellerIdentity('sandbox'), true)
  assert.equal(mayUseSandboxSellerIdentity(null), true)
  assert.equal(mayUseSandboxSellerIdentity(undefined), true)

  // Unknown sources (including the removed provider_test seam) never reach the
  // sandbox identity.
  assert.equal(mayUseSandboxSellerIdentity('manual'), false)
  assert.equal(mayUseSandboxSellerIdentity('provider_test'), false)
  assert.equal(mayUseSandboxSellerIdentity('anything-else'), false)

  // Even with the flag ON, onboarding resolves to real data, never sandbox.
  const onboardingOn = decideSellerRequest({ source: 'onboarding', flagValue: 'true' })
  assert.equal(onboardingOn.payloadKind, 'provider')
})

test('(8) sandbox seller payload is isolated and only injects the credential', () => {
  // The fixed test identity is a distinct, clearly named constant and must NOT
  // carry the partner credential (that is injected at build time from a secret).
  assert.equal(
    Object.prototype.hasOwnProperty.call(SANDBOX_SELLER_IDENTITY, 'payme_client_key'),
    false,
  )

  const body = buildSandboxSellerRequestBody('newpartners_TESTKEY')

  // Only difference vs the isolated identity is the injected credential.
  assert.equal(body.payme_client_key, 'newpartners_TESTKEY')
  for (const [key, value] of Object.entries(SANDBOX_SELLER_IDENTITY)) {
    assert.equal(body[key], value)
  }
  assert.deepEqual(
    Object.keys(body).sort(),
    ['payme_client_key', ...Object.keys(SANDBOX_SELLER_IDENTITY)].sort(),
  )
})

test('(9) source classification is explicit — exactly two intents, everything else fails safe', () => {
  // The two recognized intents.
  assert.equal(classifySellerRequest('onboarding'), 'onboarding')
  assert.equal(classifySellerRequest('sandbox'), 'sandbox')

  // Absent source preserves the established manual sandbox contract.
  assert.equal(classifySellerRequest(null), 'sandbox')
  assert.equal(classifySellerRequest(undefined), 'sandbox')
  assert.equal(classifySellerRequest(''), 'sandbox')
  assert.equal(classifySellerRequest('   '), 'sandbox')

  // Anything else is 'unknown' and must never bypass a gate or reach PayMe.
  assert.equal(classifySellerRequest('manual'), 'unknown')
  assert.equal(classifySellerRequest('ONBOARDING'), 'unknown')
  assert.deepEqual(decideSellerRequest({ source: 'manual', flagValue: 'true' }), {
    intent: 'unknown',
    action: 'reject',
    payloadKind: null,
  })
  // An unknown source cannot bypass anything even with the flag on.
  assert.equal(decideSellerRequest({ source: 'anything', flagValue: 'true' }).action, 'reject')
})

test('(9a) the removed provider_test seam is rejected as an unsupported source', () => {
  // provider_test was a temporary E2E seam and has been fully removed. It must now
  // be classified as unknown and REJECTED — never falling back to sandbox.
  assert.equal(classifySellerRequest('provider_test'), 'unknown')
  assert.equal(classifySellerRequest('provider_test '), 'unknown')
  assert.equal(mayUseSandboxSellerIdentity('provider_test'), false)

  // Rejected regardless of the feature flag; never proceeds, never sandbox.
  for (const flagValue of [undefined, 'false', 'true']) {
    assert.deepEqual(decideSellerRequest({ source: 'provider_test', flagValue }), {
      intent: 'unknown',
      action: 'reject',
      payloadKind: null,
    })
  }
})

test('(10) minimal provider input is normalized from profile only (no KYC/bank)', () => {
  const n = normalizeProviderSellerInput(COMPLETE_PROFILE)

  // first name = first token of full_name; no last name is derived.
  assert.equal(n.firstName, 'Dana')
  assert.equal(n.email, 'dana@example.com')
  assert.equal(n.phone, '+972501112233')

  // The normalized shape carries ONLY the minimal identity — no KYC/bank keys.
  assert.deepEqual(Object.keys(n).sort(), ['email', 'firstName', 'phone'])
})

test('(11) complete minimal data builds exactly the minimal PayMe body (no KYC, no sandbox, no secret)', () => {
  const n = normalizeProviderSellerInput(COMPLETE_PROFILE)
  assert.deepEqual(validateProviderSellerInput(n), { ok: true })

  const built = buildProviderSellerRequestBody('newpartners_TESTKEY', n)
  assert.equal(built.ok, true)
  if (!built.ok) return

  // Exactly the minimal identity fields + injected credential — nothing else.
  assert.deepEqual(Object.keys(built.body).sort(), [
    'payme_client_key',
    'seller_email',
    'seller_first_name',
    'seller_phone',
  ])
  assert.equal(built.body.payme_client_key, 'newpartners_TESTKEY')
  assert.equal(built.body.seller_first_name, 'Dana')
  assert.equal(built.body.seller_email, 'dana@example.com')
  assert.equal(built.body.seller_phone, '+972501112233')

  // No KYC/bank fields are ever sent.
  const serialized = JSON.stringify(built.body)
  for (const forbidden of [
    'social_id',
    'birthdate',
    'gender',
    'bank_code',
    'bank_branch',
    'bank_account',
    'secret',
  ]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden, 'i'))
  }

  // Must NOT be the fixed sandbox identity.
  assert.notEqual(built.body.seller_email, SANDBOX_SELLER_IDENTITY.seller_email)
})

test('(12) missing email / first name / phone each block the PayMe call', () => {
  // Missing email.
  const noEmail = normalizeProviderSellerInput({ ...COMPLETE_PROFILE, email: null })
  const vEmail = validateProviderSellerInput(noEmail)
  assert.equal(vEmail.ok, false)
  if (!vEmail.ok) assert.deepEqual(vEmail.missing, ['seller_email'])

  // Missing/underivable first name (empty full_name).
  const noName = normalizeProviderSellerInput({ ...COMPLETE_PROFILE, full_name: '   ' })
  const vName = validateProviderSellerInput(noName)
  assert.equal(vName.ok, false)
  if (!vName.ok) assert.deepEqual(vName.missing, ['seller_first_name'])

  // Missing phone (no whatsapp number).
  const noPhone = normalizeProviderSellerInput({ ...COMPLETE_PROFILE, whatsapp_number: null })
  const vPhone = validateProviderSellerInput(noPhone)
  assert.equal(vPhone.ok, false)
  if (!vPhone.ok) assert.deepEqual(vPhone.missing, ['seller_phone'])

  // In every incomplete case the builder returns NO body.
  for (const bad of [noEmail, noName, noPhone]) {
    const built = buildProviderSellerRequestBody('newpartners_TESTKEY', bad)
    assert.equal(built.ok, false)
  }
})

test('(13) PayMe error code 19 maps to PAYME_REQUIRED_FIELD_MISSING with a safe field name', () => {
  const raw: PaymeCreateSellerRaw = {
    status_code: 1,
    status_error_code: 19,
    status_additional_info: 'seller_last_name',
  }
  assert.equal(isPaymeRequiredFieldError(raw), true)
  assert.equal(extractSafeMissingFieldName(raw), 'seller_last_name')

  // Not a schema field name (could be free text / a value) -> not surfaced.
  assert.equal(
    extractSafeMissingFieldName({
      status_code: 1,
      status_error_code: 19,
      status_additional_info: 'Please contact support 12345',
    }),
    null,
  )

  // Other error codes are not treated as a required-field error.
  assert.equal(isPaymeRequiredFieldError({ status_code: 1, status_error_code: 7 }), false)
  assert.equal(isPaymeRequiredFieldError({ status_code: 0 }), false)
})

test('(14) concurrent creation: only the claim winner proceeds', () => {
  // The atomic conditional UPDATE (not_started/failed -> creating) is the lock;
  // classifyClaimOutcome interprets the result for the losers.
  assert.equal(classifyClaimOutcome({ claimed: true, existingSellerId: null }), 'proceed')
  assert.equal(
    classifyClaimOutcome({ claimed: false, existingSellerId: 'MPL-existing' }),
    'return_existing',
  )
  assert.equal(
    classifyClaimOutcome({ claimed: false, existingSellerId: null }),
    'in_progress',
  )
})

test('(15) Phase-1 seller metadata stays compatible; signup URL is owner-scoped', () => {
  // Phase-1 rows still resolve — the signup URL is now supplied from the private,
  // owner-only provider_payment_onboarding table (cross-user isolation is enforced
  // by that table's RLS policy; not unit-testable without a live DB).
  const providerA = resolveExistingSeller({
    payme_seller_id: 'MPL-A',
    payme_onboarding_status: 'created',
    payme_signup_url: 'https://newpartners.payme.io/update-details?t=A-token',
  })
  assert.ok(providerA)
  assert.equal(providerA?.sellerPaymeId, 'MPL-A')
  assert.equal(providerA?.signupUrl, 'https://newpartners.payme.io/update-details?t=A-token')

  // A provider whose signup URL was not loaded (e.g. not theirs) never receives one.
  const providerB = resolveExistingSeller({
    payme_seller_id: 'MPL-B',
    payme_onboarding_status: 'created',
    payme_signup_url: null,
  })
  assert.equal(providerB?.signupUrl, null)
})
