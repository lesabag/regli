import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import {
  buildActivationVoidRequest,
  canVoidActivation,
  parseVoidResponse,
  PAYME_VOID_SALE_PATH,
  type ProviderActivationState,
} from '../_shared/paymeActivation.ts'
import {
  claimActivationState,
  loadActivationRow,
  patchActivation,
} from '../_shared/paymeActivationDb.ts'

// Explicitly VOID an uncaptured Provider Account Activation Fee authorization.
//
// We do NOT rely on authorization expiry or automatic issuer release. A void is
// triggered by an EXPLICIT provider action: cancelling before KYC, an explicit
// rejection/abandonment, or another safe failure. It is never triggered
// automatically on a transient network error.
//
// There is no fee for a J5 that is never captured, so a void costs the provider
// nothing. After a successful void: state = cancelled, payment_ready stays false.
// Post-capture refunds are out of scope for this phase (see TASK 14): void is only
// valid while the authorization is uncaptured (canVoidActivation).

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
    if (profile.role !== 'walker') return fail('FORBIDDEN', 'Only providers can void', 403)

    const existing = await loadActivationRow(admin, user.id)
    if (!existing) return fail('NO_ACTIVATION', 'No activation to void', 409)

    const state = existing.activation_state

    // Idempotent: already cancelled -> success (duplicate void / callback retry).
    if (state === 'cancelled') {
      return json({ success: true, state, alreadyVoided: true }, 200)
    }
    // NEVER void after capture — no post-capture refund path in this phase.
    if (state === 'payment_ready' || state === 'fee_captured') {
      return fail('CANNOT_VOID_CAPTURED', 'A captured activation cannot be voided', 409)
    }
    if (!canVoidActivation(state)) {
      return fail('NOTHING_TO_VOID', 'No uncaptured authorization to void', 409)
    }

    const saleId = existing.activation_fee_payme_sale_id

    if (flagValue !== 'true') {
      // Safe no-op: record the intent locally so the UX reflects cancellation.
      await patchActivation(admin, user.id, {
        activation_state: 'cancelled',
        activation_fee_voided_at: new Date().toISOString(),
      })
      console.log(
        JSON.stringify({
          op: 'payme-void-provider-activation',
          userId: user.id,
          outcome: 'skipped_flag_disabled',
        }),
      )
      return json({ success: true, skipped: true, state: 'cancelled' }, 200)
    }
    if (!clientKey) return fail('PAYME_CONFIG_MISSING', 'PayMe is not configured', 500)
    if (!saleId) return fail('VOID_STATE_INVALID', 'No authorization sale id to void', 409)

    // Claim the void: any voidable state -> a transient 'cancelled' intent. Losing
    // the claim means another void already ran (duplicate-void safe).
    const voidableFrom: ProviderActivationState[] = [
      'fee_authorizing',
      'fee_authorized',
      'seller_creating',
      'seller_created',
      'kyc_pending',
      'kyc_approved',
    ]
    const claimed = await claimActivationState(admin, user.id, voidableFrom, 'cancelled', {})
    if (!claimed) {
      const fresh = await loadActivationRow(admin, user.id)
      if (fresh?.activation_state === 'cancelled') {
        return json({ success: true, state: 'cancelled', alreadyVoided: true }, 200)
      }
      return fail('VOID_IN_PROGRESS', 'Void already in progress', 409)
    }

    const voidBody = buildActivationVoidRequest({ clientKey, paymeSaleId: saleId })

    let paymeResponse: Response
    try {
      paymeResponse = await fetch(`${baseUrl}${PAYME_VOID_SALE_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seller_payme_client_key: clientKey, ...voidBody }),
      })
    } catch (netErr) {
      // Do NOT flip back to an authorized state automatically. Record the failure;
      // the explicit void can be retried (cancelled -> void again is idempotent).
      await patchActivation(admin, user.id, { last_activation_error_code: 'PAYME_NETWORK_ERROR' })
      console.error(
        'payme-void network error:',
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
    const result = parseVoidResponse(raw)

    console.log(
      JSON.stringify({
        op: 'payme-void-provider-activation',
        userId: user.id,
        httpStatus: paymeResponse.status,
        statusCode: result.statusCode,
      }),
    )

    if (!paymeResponse.ok || !result.ok) {
      await patchActivation(admin, user.id, { last_activation_error_code: 'PAYME_VOID_FAILED' })
      return fail('PAYME_VOID_FAILED', 'Unable to void the authorization', 502)
    }

    await patchActivation(admin, user.id, {
      activation_state: 'cancelled',
      activation_fee_voided_at: new Date().toISOString(),
      last_activation_error_code: null,
    })

    return json({ success: true, state: 'cancelled' }, 200)
  } catch (err) {
    console.error('payme-void error:', err instanceof Error ? err.message : 'unknown')
    return fail('INTERNAL_ERROR', 'Internal server error', 500)
  }
})
