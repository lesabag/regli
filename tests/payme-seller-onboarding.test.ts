import assert from 'node:assert/strict'
import test from 'node:test'

import { runNonBlocking } from '../src/payments/nonBlocking.ts'
import {
  buildSafeSellerResult,
  buildSandboxSellerRequestBody,
  extractSafeSellerMetadata,
  isPaymeSuccess,
  mayUseSandboxSellerIdentity,
  PAYME_ONBOARDING_STATUS,
  resolveExistingSeller,
  SANDBOX_SELLER_IDENTITY,
  shouldContactPayme,
  type PaymeCreateSellerRaw,
} from '../supabase/functions/create-payme-seller/paymeSeller.ts'

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

test('(6) feature flag gates the automatic onboarding path only', () => {
  // Automatic onboarding path is gated by the flag.
  assert.equal(shouldContactPayme({ source: 'onboarding', flagValue: 'true' }), true)
  assert.equal(shouldContactPayme({ source: 'onboarding', flagValue: undefined }), false)
  assert.equal(shouldContactPayme({ source: 'onboarding', flagValue: 'false' }), false)
  assert.equal(shouldContactPayme({ source: 'onboarding', flagValue: '1' }), false)

  // Explicit / manual invocations stay callable regardless of the flag.
  assert.equal(shouldContactPayme({ source: null, flagValue: undefined }), true)
  assert.equal(shouldContactPayme({ source: 'manual', flagValue: 'false' }), true)
})

test('(7) sandbox test identity is never usable by the automatic onboarding flow', () => {
  // The automatic onboarding path may never create sellers from the fixed
  // sandbox identity — even if the feature flag is later flipped to "true".
  assert.equal(mayUseSandboxSellerIdentity('onboarding'), false)

  // Manual / explicit invocations may use it for integration testing.
  assert.equal(mayUseSandboxSellerIdentity('manual'), true)
  assert.equal(mayUseSandboxSellerIdentity(null), true)
  assert.equal(mayUseSandboxSellerIdentity(undefined), true)

  // End-to-end gating matrix for the onboarding path:
  //   flag off -> skipped (never contacts PayMe)
  //   flag on  -> contact allowed by flag, but sandbox identity is still blocked
  assert.equal(shouldContactPayme({ source: 'onboarding', flagValue: 'false' }), false)
  assert.equal(shouldContactPayme({ source: 'onboarding', flagValue: 'true' }), true)
  assert.equal(mayUseSandboxSellerIdentity('onboarding'), false)
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
