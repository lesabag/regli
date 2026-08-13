// Pure, dependency-free helpers for the `payme-partner-callback` edge function.
//
// Like paymeSeller.ts, this module avoids Deno globals and remote (https://)
// imports so the exact same logic runs inside Deno (the edge function) AND under
// Node's built-in test runner (`node --test --experimental-strip-types`).
//
// SCOPE (Phase 2B): PayMe Partner-level callbacks are RECEIVED, SANITIZED,
// AUDITED and ACKNOWLEDGED only. Nothing here maps callbacks to seller approval,
// KYC completion, payment-readiness, payout eligibility, or any financial/online
// state. PayMe has not yet published the official callback payload/status or the
// authenticity/signature contract, so callbacks are treated as UNTRUSTED audit
// input until that contract exists.
//
// SECURITY: only an explicit allow-list of clearly non-sensitive fields is ever
// retained; a denylist provides defense-in-depth so secrets/PII/bank/card/KYC
// values can never be persisted even if the allow-list is later widened.

export const PAYME_PARTNER_CALLBACK = {
  provider: 'payme',
  eventScope: 'partner',
  // The ONLY processing status Phase 2B may assign. We do not advance state.
  processingStatus: 'received',
} as const

// Only POST is accepted for server-to-server callback delivery.
export function isAllowedCallbackMethod(method: string | null | undefined): boolean {
  return method === 'POST'
}

/**
 * Whether a parsed callback contains at least one usable field. An empty or
 * genuinely unparseable body yields no fields; the edge function treats that as a
 * truly-invalid request (safe 4xx) rather than persisting a meaningless audit row.
 * A DB/persistence failure is a DIFFERENT case (5xx, so PayMe may retry).
 */
export function hasUsableCallbackFields(parsed: ParsedCallback): boolean {
  return Object.keys(parsed.fields).length > 0
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export type CallbackFormat = 'form' | 'json' | 'none'

export interface ParsedCallback {
  format: CallbackFormat
  // Flat map of top-level primitive fields, values coerced to strings. This is
  // the RAW parsed view (pre-sanitization) — never persisted or logged directly.
  fields: Record<string, string>
}

function coercePrimitive(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  return null // objects / arrays / null / undefined are ignored (never flattened)
}

function detectFormat(contentType: string | null | undefined): CallbackFormat {
  const ct = (contentType ?? '').toLowerCase()
  if (ct.includes('application/x-www-form-urlencoded')) return 'form'
  if (ct.includes('application/json')) return 'json'
  return 'none'
}

/**
 * Parse a PayMe callback body safely. Supports form-urlencoded (PayMe's stated
 * partner-callback format) and, defensively, JSON. Never throws: a malformed or
 * unrecognized body yields `{ format, fields: {} }`.
 *
 * Only TOP-LEVEL primitive values are captured. Nested objects/arrays are
 * intentionally dropped so unknown, potentially-sensitive nested structures are
 * never absorbed before PayMe's contract is confirmed.
 */
export function parseCallbackBody(params: {
  contentType: string | null | undefined
  body: string | null | undefined
}): ParsedCallback {
  const body = typeof params.body === 'string' ? params.body : ''
  const declared = detectFormat(params.contentType)
  const fields: Record<string, string> = {}

  if (body.trim().length === 0) {
    return { format: declared === 'none' ? 'none' : declared, fields }
  }

  // Try JSON when declared as JSON, or when the body clearly looks like JSON.
  const looksJson = body.trim().startsWith('{')
  if (declared === 'json' || (declared === 'none' && looksJson)) {
    try {
      const parsed = JSON.parse(body)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          const coerced = coercePrimitive(value)
          if (coerced !== null) fields[key] = coerced
        }
        return { format: 'json', fields }
      }
    } catch (_err) {
      // fall through to form parsing / empty result
    }
  }

  // Form-urlencoded (default for partner callbacks). URLSearchParams never throws.
  try {
    const params2 = new URLSearchParams(body)
    for (const [key, value] of params2.entries()) {
      // Last value wins for repeated keys; adequate for audit purposes.
      fields[key] = value
    }
    if (Object.keys(fields).length > 0) return { format: 'form', fields }
  } catch (_err) {
    // ignore — return whatever we have (possibly empty)
  }

  return { format: declared, fields }
}

// ---------------------------------------------------------------------------
// Sanitization (allow-list + denylist)
// ---------------------------------------------------------------------------

// Clearly non-sensitive fields we are willing to persist for audit: identifiers,
// event/action types, status codes, currency and timestamps. NO amounts, names,
// contact details, banking, KYC, secrets or tokens. Extend only with fields
// confirmed non-sensitive by PayMe's official contract.
export const SAFE_FIELD_ALLOWLIST: readonly string[] = [
  'event',
  'event_type',
  'action',
  'type',
  'notify_type',
  'status',
  'status_code',
  'status_error_code',
  'seller_payme_id',
  'seller_id',
  'payme_sale_id',
  'sale_id',
  'payme_transaction_id',
  'transaction_id',
  'currency',
  'create_date',
  'update_date',
  'event_id',
  'payme_event_id',
]

// Defense-in-depth: any key matching these patterns is ALWAYS stripped, even if
// it somehow appears in the allow-list. Guards against secrets/PII/financial data.
const SENSITIVE_KEY_PATTERN =
  /(secret|token|authoriz|api[-_ ]?key|password|passwd|card|cvv|cvc|\bpan\b|iban|swift|bank|account|routing|social|birth|gender|kyc|email|phone|mobile|first[-_ ]?name|last[-_ ]?name|full[-_ ]?name|\bname\b|address|passport|id[-_ ]?number|ssn|tax)/i

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key)
}

/**
 * Reduce raw parsed fields to the allow-listed, non-sensitive subset that is safe
 * to persist. A field is retained ONLY when it is in the allow-list AND does not
 * match the sensitive-key pattern.
 */
export function sanitizeCallbackFields(
  fields: Record<string, string>,
): Record<string, string> {
  const safe: Record<string, string> = {}
  for (const key of SAFE_FIELD_ALLOWLIST) {
    if (isSensitiveKey(key)) continue
    const value = fields[key]
    if (typeof value === 'string' && value.length > 0) safe[key] = value
  }
  return safe
}

// ---------------------------------------------------------------------------
// Correlation (best-effort, never authoritative)
// ---------------------------------------------------------------------------

export interface CallbackCorrelation {
  sellerPaymeId: string | null
  paymeSaleId: string | null
  transactionId: string | null
  eventType: string | null
  // Best available stable external identifier for the audit row.
  externalId: string | null
}

function firstPresent(
  fields: Record<string, string>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = fields[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return null
}

const SELLER_ID_KEYS = ['seller_payme_id', 'seller_id'] as const
const SALE_ID_KEYS = ['payme_sale_id', 'sale_id'] as const
const TRANSACTION_ID_KEYS = ['payme_transaction_id', 'transaction_id'] as const
const EVENT_TYPE_KEYS = ['event_type', 'event', 'action', 'type', 'notify_type'] as const
const EVENT_ID_KEYS = ['event_id', 'payme_event_id'] as const

/**
 * Extract only known-safe correlation identifiers when present. Field names are
 * best-effort (PayMe's contract is undocumented); nothing here is treated as
 * authoritative and NONE of it drives a seller/payment state change.
 */
export function extractCorrelation(
  fields: Record<string, string>,
): CallbackCorrelation {
  const sellerPaymeId = firstPresent(fields, SELLER_ID_KEYS)
  const paymeSaleId = firstPresent(fields, SALE_ID_KEYS)
  const transactionId = firstPresent(fields, TRANSACTION_ID_KEYS)
  const eventType = firstPresent(fields, EVENT_TYPE_KEYS)
  // external_id prefers an explicit event id, then a seller/sale/transaction id.
  const externalId =
    firstPresent(fields, EVENT_ID_KEYS) ??
    sellerPaymeId ??
    paymeSaleId ??
    transactionId

  return { sellerPaymeId, paymeSaleId, transactionId, eventType, externalId }
}

// ---------------------------------------------------------------------------
// Idempotency fingerprint
// ---------------------------------------------------------------------------

// Small, deterministic, dependency-free hash (FNV-1a, 32-bit) rendered as hex.
// Used ONLY as a dedup key for an audit table — not for any security decision.
function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    // 32-bit FNV prime multiply via shifts to stay in integer range.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * Deterministic, stable fingerprint for duplicate/retry tolerance.
 *  - If PayMe supplies an explicit event id, the fingerprint is derived from it.
 *  - Otherwise it is derived from a canonical, sorted view of the SANITIZED
 *    (allow-listed, non-sensitive) fields, so identical retried callbacks collapse
 *    to one audit row while genuinely different callbacks stay distinct.
 *
 * The canonical length is appended to reduce accidental hash collisions. This is
 * a best-effort dedup key, never an authenticity check.
 */
export function computeCallbackFingerprint(
  safeFields: Record<string, string>,
): string {
  const explicitEventId = firstPresent(safeFields, EVENT_ID_KEYS)
  if (explicitEventId) {
    return `payme:partner:evt:${explicitEventId}`
  }

  const canonical = Object.keys(safeFields)
    .sort()
    .map((key) => `${key}=${safeFields[key]}`)
    .join('&')

  if (canonical.length === 0) return 'payme:partner:empty'
  return `payme:partner:h:${fnv1aHex(canonical)}:${canonical.length}`
}

// ---------------------------------------------------------------------------
// Audit record assembly
// ---------------------------------------------------------------------------

export interface CallbackAuditRecord {
  provider: 'payme'
  eventScope: 'partner'
  eventType: string | null
  externalId: string | null
  sellerPaymeId: string | null
  paymeSaleId: string | null
  transactionId: string | null
  fingerprint: string
  // Only the sanitized, allow-listed subset — never the raw payload.
  payload: Record<string, string>
  processingStatus: 'received'
}

/**
 * Build the complete, safe audit record from a parsed callback. The result
 * contains ONLY sanitized fields and carries a fixed `processingStatus` of
 * 'received' — it deliberately has no seller-status/payment-ready/approval field,
 * so persisting it can never transition business state.
 */
export function buildCallbackAuditRecord(
  parsed: ParsedCallback,
): CallbackAuditRecord {
  const safe = sanitizeCallbackFields(parsed.fields)
  const correlation = extractCorrelation(safe)

  return {
    provider: PAYME_PARTNER_CALLBACK.provider,
    eventScope: PAYME_PARTNER_CALLBACK.eventScope,
    eventType: correlation.eventType,
    externalId: correlation.externalId,
    sellerPaymeId: correlation.sellerPaymeId,
    paymeSaleId: correlation.paymeSaleId,
    transactionId: correlation.transactionId,
    fingerprint: computeCallbackFingerprint(safe),
    payload: safe,
    processingStatus: PAYME_PARTNER_CALLBACK.processingStatus,
  }
}
