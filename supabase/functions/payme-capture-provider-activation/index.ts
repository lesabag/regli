import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import {
  buildActivationCaptureRequest,
  canCaptureActivationFee,
  isActivationAuthorizationExpired,
  isCaptureAmountValid,
  parseCaptureResponse,
  PAYME_CAPTURE_SALE_PATH,
  type ProviderActivationState,
} from '../_shared/paymeActivation.ts'
import {
  claimActivationState,
  loadActivationRow,
  patchActivation,
} from '../_shared/paymeActivationDb.ts'

// Capture the previously-authorized Provider Account Activation Fee.
//
// PRECONDITIONS (all enforced server-side): state === 'kyc_approved' (a VERIFIED
// PayMe seller-readiness signal — never inferred from arbitrary callbacks), the
// 168h authorization window has NOT elapsed, and capture has not already happened.
// Capture runs at most once; sale_price never exceeds the authorized amount.
//
// On success: kyc_approved -> fee_capturing -> fee_captured -> payment_ready.
// On failure: NOT payment_ready — revert to kyc_approved so it stays retryable
// (subject to the authorization window).
//
// TODO(payme-phase2c): reaching 'kyc_approved' requires a verified PayMe seller
// status. That trigger is not wired yet, so in this phase this function is not
// reachable in production — it is exercised by tests and ready for Phase 2C.

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
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const clientKey = Deno.env.get('PAYME_PARTNER_CLIENT_KEY')
    const baseUrl = Deno.env.get('PAYME_BASE_URL') || PAYME_DEFAULT_BASE_URL
    const flagValue = Deno.env.get('PAYME_SELLER_ONBOARDING_ENABLED')

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
      return fail('SERVER_MISCONFIGURED', 'Server misconfigured', 500)
    }

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
      .select('id, role')
      .eq('id', user.id)
      .single()
    if (profileError || !profile) return fail('PROFILE_NOT_FOUND', 'Profile not found', 404)
    if (profile.role !== 'walker') return fail('FORBIDDEN', 'Only providers can be captured', 403)

    const existing = await loadActivationRow(admin, user.id)
    if (!existing) return fail('NO_ACTIVATION', 'No activation in progress', 409)

    const state = existing.activation_state
    const nowIso = new Date().toISOString()

    // Already captured / payment-ready: idempotent success, never a second capture.
    if (state === 'payment_ready' || state === 'fee_captured') {
      return json({ success: true, state, alreadyCaptured: true }, 200)
    }

    if (!canCaptureActivationFee(state)) {
      return fail('CAPTURE_NOT_ALLOWED', 'Activation is not ready to capture', 409)
    }

    // Expired authorization can NEVER be captured — re-authorization is required.
    if (isActivationAuthorizationExpired(existing.activation_fee_authorization_expires_at, nowIso)) {
      await patchActivation(admin, user.id, { activation_state: 'authorization_expired' })
      return fail('AUTHORIZATION_EXPIRED', 'Authorization window has expired', 409)
    }

    const saleId = existing.activation_fee_payme_sale_id
    const authorizedAgorot = existing.activation_fee_amount_agorot ?? 0
    if (!saleId || !isCaptureAmountValid(authorizedAgorot, authorizedAgorot)) {
      return fail('CAPTURE_STATE_INVALID', 'Activation authorization is incomplete', 409)
    }

    if (flagValue !== 'true') {
      console.log(
        JSON.stringify({
          op: 'payme-capture-provider-activation',
          userId: user.id,
          outcome: 'skipped_flag_disabled',
        }),
      )
      return json({ success: true, skipped: true, state }, 200)
    }
    if (!clientKey) return fail('PAYME_CONFIG_MISSING', 'PayMe is not configured', 500)

    // ---- Single-capture claim: kyc_approved -> fee_capturing ----
    const claimed = await claimActivationState(
      admin,
      user.id,
      ['kyc_approved'],
      'fee_capturing',
      {},
    )
    if (!claimed) return fail('CAPTURE_IN_PROGRESS', 'Capture already in progress', 409)

    // Capture the full authorized amount (never more — see isCaptureAmountValid).
    const captureBody = buildActivationCaptureRequest({
      clientKey,
      paymeSaleId: saleId,
      salePriceAgorot: authorizedAgorot,
      installments: 1,
    })

    let paymeResponse: Response
    try {
      paymeResponse = await fetch(`${baseUrl}${PAYME_CAPTURE_SALE_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seller_payme_client_key: clientKey, ...captureBody }),
      })
    } catch (netErr) {
      // Revert to kyc_approved: capture is unconfirmed and remains retryable.
      await patchActivation(admin, user.id, {
        activation_state: 'kyc_approved',
        last_activation_error_code: 'PAYME_NETWORK_ERROR',
      })
      console.error(
        'payme-capture network error:',
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
    const result = parseCaptureResponse(raw)

    console.log(
      JSON.stringify({
        op: 'payme-capture-provider-activation',
        userId: user.id,
        httpStatus: paymeResponse.status,
        statusCode: result.statusCode,
      }),
    )

    if (!paymeResponse.ok || !result.ok) {
      await patchActivation(admin, user.id, {
        activation_state: 'kyc_approved',
        last_activation_error_code: 'PAYME_CAPTURE_FAILED',
      })
      return fail('PAYME_CAPTURE_FAILED', 'Unable to capture the activation fee', 502)
    }

    // Success: fee_captured -> payment_ready (the ONLY path to payment_ready).
    await patchActivation(admin, user.id, {
      activation_state: 'payment_ready',
      activation_fee_captured_at: new Date().toISOString(),
      last_activation_error_code: null,
    })

    return json({ success: true, state: 'payment_ready' }, 200)
  } catch (err) {
    console.error('payme-capture error:', err instanceof Error ? err.message : 'unknown')
    return fail('INTERNAL_ERROR', 'Internal server error', 500)
  }
})
