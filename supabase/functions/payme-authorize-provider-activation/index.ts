import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import {
  buildActivationAuthorizationRequest,
  computeAuthorizationExpiry,
  canRequestActivationAuthorization,
  isActivationAuthorizationExpired,
  parseAuthorizationResponse,
  PAYME_GENERATE_SALE_PATH,
  type ProviderActivationState,
} from '../_shared/paymeActivation.ts'
import { resolveActivationFeeQuote } from '../_shared/activationFeeConfig.ts'
import {
  claimActivationState,
  ensureActivationRow,
  loadActivationRow,
  patchActivation,
} from '../_shared/paymeActivationDb.ts'

// J5 Authorization for the one-time Provider Account Activation Fee.
//
// FLOW (per PayMe's confirmed flow): activation begins -> create a J5 authorization
// (amount RESERVED, not captured) via Regli's OWN Seller/terminal -> return the
// hosted sale_url so the provider enters their card on PayMe's page. Only AFTER a
// verified authorization does create-payme-seller run (a separate call, gated by
// canCreateSellerForActivation === state 'fee_authorized').
//
// SECURITY: the client never calls PayMe directly and never sends card data here.
// provider_id is taken from the JWT, never the body. PayMe credentials and Regli's
// own seller id are server-side secrets. We log field NAMES + status codes only —
// never raw PayMe bodies, card, or KYC data. Everything is gated OFF behind
// PAYME_SELLER_ONBOARDING_ENABLED (safe skip no-op when not "true").
//
// TODO(payme-phase2c): the verified transition fee_authorizing -> fee_authorized
// (return-URL reconciliation / verified callback) is not wired yet. Until then the
// authorization stays 'fee_authorizing' after the hosted page is issued.

const PAYME_DEFAULT_BASE_URL = 'https://sandbox.payme.io'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function fail(code: string, message: string, status: number): Response {
  return json({ success: false, code, message }, status)
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const clientKey = Deno.env.get('PAYME_PARTNER_CLIENT_KEY')
    const regliSellerId = Deno.env.get('PAYME_REGLI_SELLER_ID')
    const baseUrl = Deno.env.get('PAYME_BASE_URL') || PAYME_DEFAULT_BASE_URL
    const flagValue = Deno.env.get('PAYME_SELLER_ONBOARDING_ENABLED')

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

    if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
      return fail('SERVER_MISCONFIGURED', 'Server misconfigured', 500)
    }

    // ---- Authenticate the caller (provider_id ALWAYS from the JWT) ----
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return fail('UNAUTHENTICATED', 'Missing authorization', 401)

    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    })
    const {
      data: { user },
      error: authError,
    } = await supabaseUser.auth.getUser()
    if (authError || !user) return fail('UNAUTHENTICATED', 'Invalid token', 401)

    const admin = createClient(supabaseUrl, serviceRoleKey)

    const { data: profile, error: profileError } = await admin
      .from('profiles')
      .select('id, role, payme_ready_for_activation')
      .eq('id', user.id)
      .single()
    if (profileError || !profile) return fail('PROFILE_NOT_FOUND', 'Profile not found', 404)
    if (profile.role !== 'walker') {
      return fail('FORBIDDEN', 'Only providers can activate payments', 403)
    }
    // Stage A must be complete: the provider explicitly marked readiness first.
    if (profile.payme_ready_for_activation !== true) {
      return fail('NOT_READY_FOR_ACTIVATION', 'Provider is not ready for activation', 409)
    }

    await ensureActivationRow(admin, user.id, 'ready')
    const existing = await loadActivationRow(admin, user.id)
    const currentState: ProviderActivationState = existing?.activation_state ?? 'ready'
    const nowIso = new Date().toISOString()

    // Already payment-ready or capture in progress: nothing to authorize.
    if (
      currentState === 'payment_ready' ||
      currentState === 'fee_captured' ||
      currentState === 'fee_capturing'
    ) {
      return fail('ALREADY_ACTIVATED', 'Activation already completed', 409)
    }

    // Idempotency: a live (non-expired) authorization already exists -> return it,
    // do NOT create a second J5 (double-click / concurrent-device protection).
    if (
      (currentState === 'fee_authorizing' ||
        currentState === 'fee_authorized' ||
        currentState === 'seller_creating' ||
        currentState === 'seller_created' ||
        currentState === 'kyc_pending') &&
      !isActivationAuthorizationExpired(existing?.activation_fee_authorization_expires_at, nowIso)
    ) {
      return json(
        {
          success: true,
          state: currentState,
          authorizationExpiresAt: existing?.activation_fee_authorization_expires_at ?? null,
          reused: true,
        },
        200,
      )
    }

    // Otherwise we may (re)authorize. Expired/failed/cancelled/ready/not_started
    // are all valid start points; expiry recovery reuses the existing Seller.
    const startState: ProviderActivationState = isActivationAuthorizationExpired(
      existing?.activation_fee_authorization_expires_at,
      nowIso,
    )
      ? 'authorization_expired'
      : currentState

    if (!canRequestActivationAuthorization(startState)) {
      return fail('ACTIVATION_NOT_AUTHORIZABLE', 'Activation cannot be authorized now', 409)
    }

    // ---- Flag gate: everything below performs REAL PayMe calls ----
    if (flagValue !== 'true') {
      console.log(
        JSON.stringify({
          op: 'payme-authorize-provider-activation',
          userId: user.id,
          outcome: 'skipped_flag_disabled',
        }),
      )
      return json({ success: true, skipped: true, state: startState }, 200)
    }

    if (!clientKey || !regliSellerId) {
      return fail('PAYME_CONFIG_MISSING', 'PayMe is not configured', 500)
    }
    // Amount is SERVER-AUTHORITATIVE and comes from the SAME source as the quote
    // shown to the provider (_shared/activationFeeConfig.ts). We never trust any
    // amount sent by the client.
    const feeQuote = resolveActivationFeeQuote((key) => Deno.env.get(key))
    if (!feeQuote) {
      return fail('ACTIVATION_FEE_MISCONFIGURED', 'Activation fee is not configured', 500)
    }
    const amountAgorot = feeQuote.grossAgorot

    // ---- Concurrency claim: only one caller may move into fee_authorizing ----
    const allowedFrom: ProviderActivationState[] = [
      'not_started',
      'ready',
      'authorization_expired',
      'activation_failed',
      'cancelled',
    ]
    const nextAttempt = (existing?.activation_attempt ?? 0) + 1
    const claimed = await claimActivationState(admin, user.id, allowedFrom, 'fee_authorizing', {
      activation_attempt: nextAttempt,
      last_activation_error_code: null,
    })
    if (!claimed) {
      return fail('ACTIVATION_IN_PROGRESS', 'Activation is already in progress', 409)
    }

    // Idempotency key we control (never a PayMe secret).
    const transactionId = `regli-activation-${user.id}-${nextAttempt}`
    const requestBody = buildActivationAuthorizationRequest({
      clientKey,
      regliSellerId,
      amountAgorot,
      currency: 'ILS',
      productName: 'Regli provider account activation',
      transactionId,
    })

    let paymeResponse: Response
    try {
      paymeResponse = await fetch(`${baseUrl}${PAYME_GENERATE_SALE_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seller_payme_client_key: clientKey, ...requestBody }),
      })
    } catch (netErr) {
      // Transient network failure: do NOT void (nothing was confirmed). Mark
      // retryable and release the claim so the provider can try again.
      await patchActivation(admin, user.id, {
        activation_state: 'activation_failed',
        last_activation_error_code: 'PAYME_NETWORK_ERROR',
      })
      console.error(
        'payme-authorize network error:',
        netErr instanceof Error ? netErr.message : 'unknown',
      )
      return fail('PAYME_NETWORK_ERROR', 'Unable to reach PayMe', 502)
    }

    let raw: unknown = null
    try {
      raw = await paymeResponse.json()
    } catch (_err) {
      raw = null
    }
    const result = parseAuthorizationResponse(raw)

    console.log(
      JSON.stringify({
        op: 'payme-authorize-provider-activation',
        userId: user.id,
        attempt: nextAttempt,
        httpStatus: paymeResponse.status,
        statusCode: result.statusCode,
        hasSaleId: !!result.paymeSaleId,
        hasSaleUrl: !!result.saleUrl,
      }),
    )

    if (!paymeResponse.ok || !result.ok || !result.paymeSaleId) {
      await patchActivation(admin, user.id, {
        activation_state: 'activation_failed',
        last_activation_error_code: 'PAYME_AUTHORIZATION_FAILED',
      })
      return fail('PAYME_AUTHORIZATION_FAILED', 'Unable to authorize the activation fee', 502)
    }

    const authorizedAt = new Date().toISOString()
    const expiresAt = computeAuthorizationExpiry(authorizedAt)
    await patchActivation(admin, user.id, {
      // Stays 'fee_authorizing' until a verified confirmation flips it to
      // fee_authorized (TODO(payme-phase2c)).
      activation_fee_payme_sale_id: result.paymeSaleId,
      activation_fee_amount_agorot: amountAgorot,
      activation_fee_authorized_at: authorizedAt,
      activation_fee_authorization_expires_at: expiresAt,
      activation_fee_captured_at: null,
      activation_fee_voided_at: null,
      last_activation_error_code: null,
    })

    return json(
      {
        success: true,
        state: 'fee_authorizing',
        saleUrl: result.saleUrl, // hosted J5 page — provider enters card on PayMe
        authorizationExpiresAt: expiresAt,
      },
      200,
    )
  } catch (err) {
    console.error('payme-authorize error:', err instanceof Error ? err.message : 'unknown')
    return fail('INTERNAL_ERROR', 'Internal server error', 500)
  }
})
