import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import {
  buildCallbackAuditRecord,
  hasUsableCallbackFields,
  isAllowedCallbackMethod,
  parseCallbackBody,
  PAYME_PARTNER_CALLBACK,
} from './callback.ts'

// PayMe Partner-level callback receiver (Phase 2B).
//
// PayMe calls this endpoint SERVER-TO-SERVER for activities under our Partner
// account (including seller-related activity). It is therefore PUBLIC: PayMe
// cannot present a Regli end-user JWT, so this function is configured with
// verify_jwt = false in supabase/config.toml. create-payme-seller KEEPS
// verify_jwt = true — this setting change is scoped to THIS function only.
//
// TRUST MODEL — the callback is UNTRUSTED audit input:
//   RECEIVE -> SANITIZE -> AUDIT -> ACKNOWLEDGE.
// PayMe has not yet published the official callback payload/status contract NOR
// the authenticity/signature verification contract. Until then this function must
// NOT make any business decision from a callback: it never approves a seller,
// marks KYC complete, sets payment-ready/online, or changes payout/financial
// state. It only records a sanitized audit event.
//
// TODO(payme-callback-auth): Implement PayMe callback authenticity verification
// (signature / shared-secret / source validation) once PayMe provides the official
// verification contract. Only after that may callback data be treated as
// authoritative.
//
// TODO(payme-phase2c): Status reconciliation. Combine (a) authenticated Partner
// callbacks with (b) the PayMe "Get Sellers" API to reconcile a seller's real
// status, map ONLY documented PayMe statuses, and only then mark a Regli provider
// payment-ready. Do NOT implement Get Sellers or any status mapping until PayMe's
// exact API + status semantics are documented — no invented event names/statuses.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  // Accept POST only; reject any other method safely (never echo the request).
  if (!isAllowedCallbackMethod(req.method)) {
    return json({ error: 'method_not_allowed' }, 405)
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!supabaseUrl || !serviceRoleKey) {
      // Generic error; never leak configuration details.
      return json({ error: 'server_misconfigured' }, 500)
    }

    // Read the raw body defensively. Parsing never throws (see parseCallbackBody).
    let rawBody = ''
    try {
      rawBody = await req.text()
    } catch (_err) {
      rawBody = ''
    }

    const contentType = req.headers.get('content-type')
    const parsed = parseCallbackBody({ contentType, body: rawBody })

    // Truly-invalid request: nothing usable could be parsed (empty/malformed body).
    // Return a safe 4xx WITHOUT persisting — retrying an unparseable body cannot
    // help, so we do not ask PayMe to retry (unlike a DB failure -> 5xx below).
    if (!hasUsableCallbackFields(parsed)) {
      console.warn(
        JSON.stringify({
          op: 'payme-partner-callback',
          format: parsed.format,
          outcome: 'invalid_no_fields',
        }),
      )
      return json({ error: 'invalid_callback' }, 400)
    }

    const audit = buildCallbackAuditRecord(parsed)

    // Service-role client for the RLS-protected audit table (bypasses RLS).
    const admin = createClient(supabaseUrl, serviceRoleKey)

    // Best-effort correlation: if the callback names a seller we already know,
    // record the matching provider_id on the audit row. This is NOT a state
    // change — the provider's onboarding/payment status is left untouched.
    let matchedProviderId: string | null = null
    if (audit.sellerPaymeId) {
      try {
        const { data: match } = await admin
          .from('profiles')
          .select('id')
          .eq('payme_seller_id', audit.sellerPaymeId)
          .maybeSingle()
        const id = (match as { id?: unknown } | null)?.id
        if (typeof id === 'string' && id.length > 0) matchedProviderId = id
      } catch (_err) {
        matchedProviderId = null
      }
    }

    // Idempotent insert: the unique fingerprint dedupes PayMe retries. On conflict
    // we treat the callback as an already-recorded duplicate.
    let duplicate = false
    const { error: insertError } = await admin
      .from('payme_partner_callback_events')
      .insert({
        provider: audit.provider,
        event_scope: audit.eventScope,
        event_type: audit.eventType,
        external_id: audit.externalId,
        seller_payme_id: audit.sellerPaymeId,
        payme_sale_id: audit.paymeSaleId,
        transaction_id: audit.transactionId,
        provider_id: matchedProviderId,
        fingerprint: audit.fingerprint,
        payload: audit.payload,
        processing_status: audit.processingStatus,
      })

    if (insertError) {
      if ((insertError as { code?: string }).code === '23505') {
        // unique_violation on fingerprint -> the event was already recorded. This
        // is a successfully-handled retry/duplicate: ACK with duplicate:true.
        duplicate = true
      } else {
        // Unexpected persistence failure (e.g. DB temporarily unavailable). We must
        // NOT silently acknowledge an event we failed to store — return 5xx so
        // PayMe can retry later. No payload/PII in the log.
        console.error(
          JSON.stringify({
            op: 'payme-partner-callback',
            format: parsed.format,
            eventType: audit.eventType,
            outcome: 'audit_persist_failed',
            error: insertError.message,
          }),
        )
        return json({ error: 'audit_persist_failed' }, 503)
      }
    }

    // Safe logging: identifiers/type/format only — never the raw payload, headers,
    // secrets, or any PII/financial value.
    console.log(
      JSON.stringify({
        op: 'payme-partner-callback',
        eventScope: PAYME_PARTNER_CALLBACK.eventScope,
        format: parsed.format,
        eventType: audit.eventType,
        sellerPaymeId: audit.sellerPaymeId,
        paymeSaleId: audit.paymeSaleId,
        matchedProviderId,
        outcome: duplicate ? 'duplicate' : 'received',
      }),
    )

    // 2xx acknowledgement ONLY after the event was durably persisted (or was a
    // confirmed duplicate).
    return json({ received: true, ...(duplicate ? { duplicate: true } : {}) }, 200)
  } catch (err) {
    // Never throw a raw payload back to the caller.
    console.error(
      JSON.stringify({
        op: 'payme-partner-callback',
        outcome: 'error',
        error: err instanceof Error ? err.message : 'unknown',
      }),
    )
    return json({ error: 'internal_error' }, 500)
  }
})
