import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildCallbackAuditRecord,
  computeCallbackFingerprint,
  extractCorrelation,
  hasUsableCallbackFields,
  isAllowedCallbackMethod,
  parseCallbackBody,
  sanitizeCallbackFields,
} from '../supabase/functions/payme-partner-callback/callback.ts'

test('(1) form-urlencoded callback parses successfully', () => {
  const parsed = parseCallbackBody({
    contentType: 'application/x-www-form-urlencoded',
    body: 'event_type=seller.updated&seller_payme_id=MPL16121-abc&currency=ILS',
  })
  assert.equal(parsed.format, 'form')
  assert.equal(parsed.fields.event_type, 'seller.updated')
  assert.equal(parsed.fields.seller_payme_id, 'MPL16121-abc')
  assert.equal(parsed.fields.currency, 'ILS')
})

test('(2) JSON callback parses defensively when sent as JSON', () => {
  const parsed = parseCallbackBody({
    contentType: 'application/json',
    body: JSON.stringify({
      event_type: 'sale.completed',
      payme_sale_id: 'SALE-1',
      status_code: 0,
      // nested objects/arrays must be ignored, not flattened.
      nested: { secret: 'x' },
      list: [1, 2, 3],
    }),
  })
  assert.equal(parsed.format, 'json')
  assert.equal(parsed.fields.event_type, 'sale.completed')
  assert.equal(parsed.fields.payme_sale_id, 'SALE-1')
  assert.equal(parsed.fields.status_code, '0') // coerced to string
  assert.equal('nested' in parsed.fields, false)
  assert.equal('list' in parsed.fields, false)
})

test('(3) only POST is accepted; other methods are rejected', () => {
  assert.equal(isAllowedCallbackMethod('POST'), true)
  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH', 'HEAD', undefined, null]) {
    assert.equal(isAllowedCallbackMethod(method), false)
  }
})

test('(4) safe seller_payme_id extraction (with seller_id fallback)', () => {
  assert.equal(
    extractCorrelation({ seller_payme_id: 'MPL-1' }).sellerPaymeId,
    'MPL-1',
  )
  // Falls back to seller_id when seller_payme_id is absent.
  assert.equal(extractCorrelation({ seller_id: 'S-2' }).sellerPaymeId, 'S-2')
  // Absent -> null (never fabricated).
  assert.equal(extractCorrelation({}).sellerPaymeId, null)
})

test('(5) safe payme_sale_id extraction (with sale_id fallback)', () => {
  assert.equal(extractCorrelation({ payme_sale_id: 'SALE-9' }).paymeSaleId, 'SALE-9')
  assert.equal(extractCorrelation({ sale_id: 'SALE-fallback' }).paymeSaleId, 'SALE-fallback')
  assert.equal(extractCorrelation({}).paymeSaleId, null)
})

test('(6) unknown fields never become trusted business state', () => {
  const parsed = parseCallbackBody({
    contentType: 'application/x-www-form-urlencoded',
    body: 'event_type=whatever&seller_approved=true&payment_ready=true&onboarding_status=completed&make_online=1',
  })
  const record = buildCallbackAuditRecord(parsed)

  // Unknown/business-decision fields are dropped from the persisted payload.
  for (const key of ['seller_approved', 'payment_ready', 'onboarding_status', 'make_online']) {
    assert.equal(key in record.payload, false)
  }
  // The record carries only the fixed audit status — no approval/ready flag.
  assert.equal(record.processingStatus, 'received')
  assert.equal('sellerApproved' in record, false)
  assert.equal('paymentReady' in record, false)
  assert.equal('onboardingStatus' in record, false)
})

test('(7) sensitive-looking fields are excluded from persisted audit metadata', () => {
  const fields = {
    // safe, allow-listed:
    event_type: 'seller.updated',
    seller_payme_id: 'MPL-1',
    // sensitive / not allow-listed — must all be stripped:
    seller_payme_secret: 'super-secret',
    api_key: 'k',
    authorization: 'Bearer x',
    access_token: 't',
    seller_email: 'dana@example.com',
    seller_phone: '+972500000000',
    seller_first_name: 'Dana',
    seller_bank_account_number: '123456',
    seller_bank_code: '54',
    seller_social_id: '9999999999',
    card_number: '4111111111111111',
    cvv: '123',
    iban: 'IL000',
  }
  const safe = sanitizeCallbackFields(fields)

  assert.deepEqual(Object.keys(safe).sort(), ['event_type', 'seller_payme_id'])

  const serialized = JSON.stringify(safe)
  for (const forbidden of [
    'secret', 'api_key', 'authoriz', 'token', 'email', 'phone',
    'first_name', 'bank', 'social', 'card', 'cvv', 'iban',
    'super-secret', 'dana@example.com', '4111', '9999999999',
  ]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden, 'i'))
  }
})

test('(8) duplicate fingerprint is stable for the same callback; distinct for different', () => {
  const a1 = buildCallbackAuditRecord(
    parseCallbackBody({
      contentType: 'application/x-www-form-urlencoded',
      body: 'event_type=seller.updated&seller_payme_id=MPL-1',
    }),
  )
  const a2 = buildCallbackAuditRecord(
    parseCallbackBody({
      // same fields, different order -> same fingerprint (canonical sort).
      contentType: 'application/x-www-form-urlencoded',
      body: 'seller_payme_id=MPL-1&event_type=seller.updated',
    }),
  )
  assert.equal(a1.fingerprint, a2.fingerprint)

  const b = buildCallbackAuditRecord(
    parseCallbackBody({
      contentType: 'application/x-www-form-urlencoded',
      body: 'event_type=seller.updated&seller_payme_id=MPL-2',
    }),
  )
  assert.notEqual(a1.fingerprint, b.fingerprint)

  // An explicit event id drives the fingerprint deterministically.
  assert.equal(
    computeCallbackFingerprint({ event_id: 'EVT-42', event_type: 'x' }),
    'payme:partner:evt:EVT-42',
  )
})

test('(9) malformed / empty payloads are handled safely (no throw)', () => {
  for (const body of ['', '   ', 'not=', '%%%not-valid%%%', '{"broken":', 'garbage-without-delims']) {
    const parsed = parseCallbackBody({ contentType: 'application/json', body })
    const record = buildCallbackAuditRecord(parsed)
    // Never throws; always produces a stable, safe record.
    assert.equal(typeof record.fingerprint, 'string')
    assert.ok(record.fingerprint.length > 0)
    assert.equal(record.processingStatus, 'received')
  }
  // A body with no recoverable fields yields the deterministic empty fingerprint.
  const empty = buildCallbackAuditRecord(parseCallbackBody({ contentType: '', body: '' }))
  assert.equal(empty.fingerprint, 'payme:partner:empty')
})

test('(10) callback record never carries a provider onboarding / payment-ready transition', () => {
  const record = buildCallbackAuditRecord(
    parseCallbackBody({
      contentType: 'application/x-www-form-urlencoded',
      // Even if PayMe were to send a "status", it stays audit-only metadata.
      body: 'event_type=seller.status&seller_payme_id=MPL-1&status=approved',
    }),
  )

  // 'status' is allow-listed as opaque audit metadata, but it is NEVER mapped to a
  // Regli seller/payment state: the record's only status field is the fixed audit
  // processing status, and there is no approval / payment-ready / online field.
  assert.equal(record.processingStatus, 'received')
  assert.equal(record.payload.status, 'approved') // retained as raw audit metadata only
  assert.equal('providerOnboardingStatus' in record, false)
  assert.equal('paymentReady' in record, false)
  assert.equal('online' in record, false)
  assert.equal('approved' in record, false)

  // The module exposes NO function that mutates seller/provider state — assert the
  // audit record shape is exactly the known safe keys.
  assert.deepEqual(Object.keys(record).sort(), [
    'eventScope',
    'eventType',
    'externalId',
    'fingerprint',
    'payload',
    'paymeSaleId',
    'processingStatus',
    'provider',
    'sellerPaymeId',
    'transactionId',
  ])
})

test('(11) usable-fields gate distinguishes truly-invalid bodies (drives the safe 4xx)', () => {
  // Truly invalid = no recoverable fields at all (empty/whitespace body, or an
  // empty JSON object). The function returns a safe 4xx WITHOUT persisting; there
  // is nothing to store and a retry cannot help. This is deliberately DISTINCT
  // from a DB persistence failure, which returns 5xx so PayMe retries.
  for (const [contentType, body] of [
    ['application/json', ''],
    ['application/x-www-form-urlencoded', ''],
    ['application/json', '   '],
    ['application/json', '{}'],
    [null, ''],
  ] as const) {
    const parsed = parseCallbackBody({ contentType, body })
    assert.equal(hasUsableCallbackFields(parsed), false)
  }

  // Any body with at least one parsed field is usable and proceeds to persistence
  // (best-effort audit) — we do NOT 4xx legitimate callbacks over undocumented
  // field names. Malformed-but-nonempty still yields a safe, deduped audit row.
  for (const [contentType, body] of [
    ['application/x-www-form-urlencoded', 'event_type=seller.updated'],
    ['application/json', '{"seller_payme_id":"MPL-1"}'],
    ['application/x-www-form-urlencoded', 'some_unknown_future_field=x'],
  ] as const) {
    const parsed = parseCallbackBody({ contentType, body })
    assert.equal(hasUsableCallbackFields(parsed), true)
  }
})
