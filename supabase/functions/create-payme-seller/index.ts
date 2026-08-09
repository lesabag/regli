import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import {
  buildSafeSellerResult,
  buildSandboxSellerRequestBody,
  extractSafeSellerMetadata,
  isPaymeSuccess,
  mayUseSandboxSellerIdentity,
  PAYME_DEFAULT_BASE_URL,
  PAYME_ONBOARDING_STATUS,
  resolveExistingSeller,
  shouldContactPayme,
  type PaymeCreateSellerRaw,
} from './paymeSeller.ts'

// Phase 1: create a PayMe Marketplace seller and persist safe onboarding
// metadata. This function does NOT create payments and never touches Stripe.
//
// SECURITY: partner credentials and seller_payme_secret are server-side only and
// are never logged or returned to the client.

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

// Best-effort: record that onboarding failed, without ever throwing.
async function markFailed(
  admin: ReturnType<typeof createClient>,
  userId: string,
): Promise<void> {
  try {
    await admin
      .from('profiles')
      .update({ payme_onboarding_status: PAYME_ONBOARDING_STATUS.failed })
      .eq('id', userId)
  } catch (_err) {
    // swallow — this is a best-effort status write
  }
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

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

    // ---- Authenticate the caller ----
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return fail('UNAUTHENTICATED', 'Missing authorization', 401)
    }

    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    })

    const {
      data: { user },
      error: authError,
    } = await supabaseUser.auth.getUser()

    if (authError || !user) {
      return fail('UNAUTHENTICATED', 'Invalid token', 401)
    }

    // ---- Read the request source ('onboarding' | anything else = manual) ----
    let source: string | null = null
    try {
      const parsed = await req.json()
      if (parsed && typeof parsed === 'object') {
        const raw = (parsed as Record<string, unknown>).source
        if (typeof raw === 'string') source = raw
      }
    } catch (_err) {
      // no/invalid JSON body — treat as a manual invocation
    }

    // Service-role client for RLS-bypassing reads/writes.
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey)

    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select(
        'id, email, full_name, role, payme_seller_id, payme_public_key_uuid, payme_signup_url, payme_onboarding_status',
      )
      .eq('id', user.id)
      .single()

    if (profileError || !profile) {
      return fail('PROFILE_NOT_FOUND', 'Profile not found', 404)
    }

    // A provider is a profiles row with role = 'walker'.
    if (profile.role !== 'walker') {
      return fail('FORBIDDEN', 'Only providers can create a PayMe seller', 403)
    }

    // ---- Idempotency: never recreate an existing seller ----
    const existing = resolveExistingSeller(profile)
    if (existing) {
      console.log(
        JSON.stringify({
          op: 'create-payme-seller',
          userId: user.id,
          outcome: 'reused_existing',
          sellerPaymeId: existing.sellerPaymeId,
        }),
      )
      return json(existing, 200)
    }

    // ---- Feature-flag gate for the automatic onboarding path ----
    if (!shouldContactPayme({ source, flagValue })) {
      console.log(
        JSON.stringify({
          op: 'create-payme-seller',
          userId: user.id,
          outcome: 'skipped_flag_disabled',
          source,
        }),
      )
      return json(
        {
          success: true,
          skipped: true,
          onboardingStatus: PAYME_ONBOARDING_STATUS.notStarted,
          signupUrl: null,
        },
        200,
      )
    }

    // ---- Guard: the automatic onboarding flow must NEVER create sellers from
    // the fixed sandbox identity (that would register fake sellers). Only manual
    // invocations may use it, for integration testing. This is reachable from
    // the onboarding path only when the flag is 'true' (see gate above).
    //
    // TODO(payme-phase2): before automatic onboarding may create sellers, replace
    // the static sandbox identity in buildCreateSellerRequestBody with real
    // per-provider data mapping, then remove this guard.
    if (!mayUseSandboxSellerIdentity(source)) {
      console.warn(
        JSON.stringify({
          op: 'create-payme-seller',
          userId: user.id,
          outcome: 'blocked_sandbox_identity_on_onboarding',
        }),
      )
      return fail(
        'PAYME_ONBOARDING_NOT_READY',
        'Automatic PayMe onboarding is enabled but real provider data mapping is not implemented yet',
        501,
      )
    }

    // ---- PayMe configuration required beyond this point ----
    if (!clientKey) {
      return fail('PAYME_CONFIG_MISSING', 'PayMe is not configured', 500)
    }

    // ---- Call PayMe (server-side only) ----
    // Uses the TEMPORARY sandbox-only seller identity; only the partner
    // credential is injected from the secret (never hardcoded). Reachable only
    // for manual invocations (guarded above by mayUseSandboxSellerIdentity).
    const requestBody = buildSandboxSellerRequestBody(clientKey)

    let paymeResponse: Response
    try {
      paymeResponse = await fetch(`${baseUrl}/api/create-seller`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      })
    } catch (netErr) {
      console.error(
        'create-payme-seller network error:',
        netErr instanceof Error ? netErr.message : 'unknown',
      )
      await markFailed(supabaseAdmin, user.id)
      return fail('PAYME_NETWORK_ERROR', 'Unable to reach PayMe', 502)
    }

    let raw: PaymeCreateSellerRaw | null = null
    try {
      raw = (await paymeResponse.json()) as PaymeCreateSellerRaw
    } catch (_err) {
      raw = null
    }

    // Log only non-secret diagnostic fields.
    console.log(
      JSON.stringify({
        op: 'create-payme-seller',
        userId: user.id,
        httpStatus: paymeResponse.status,
        statusCode: raw?.status_code ?? null,
        statusErrorCode: raw?.status_error_code ?? null,
      }),
    )

    if (!paymeResponse.ok || !isPaymeSuccess(raw)) {
      await markFailed(supabaseAdmin, user.id)
      return fail('PAYME_SELLER_CREATION_FAILED', 'Unable to create PayMe seller', 502)
    }

    const metadata = extractSafeSellerMetadata(raw as PaymeCreateSellerRaw)
    if (!metadata) {
      await markFailed(supabaseAdmin, user.id)
      return fail(
        'PAYME_SELLER_CREATION_FAILED',
        'PayMe response was missing a seller id',
        502,
      )
    }

    // ---- Persist safe metadata (NEVER seller_payme_secret) ----
    const { error: updateError } = await supabaseAdmin
      .from('profiles')
      .update({
        payme_seller_id: metadata.sellerPaymeId,
        payme_public_key_uuid: metadata.publicKeyUuid,
        payme_signup_url: metadata.signupUrl,
        payme_onboarding_status: PAYME_ONBOARDING_STATUS.created,
        payme_created_at: new Date().toISOString(),
      })
      .eq('id', user.id)

    if (updateError) {
      console.error('create-payme-seller persist error:', updateError.message)
      return fail(
        'PAYME_PERSIST_FAILED',
        'PayMe seller created but could not be saved',
        500,
      )
    }

    console.log(
      JSON.stringify({
        op: 'create-payme-seller',
        userId: user.id,
        outcome: 'created',
        sellerPaymeId: metadata.sellerPaymeId,
      }),
    )

    return json(
      buildSafeSellerResult(
        metadata.sellerPaymeId,
        PAYME_ONBOARDING_STATUS.created,
        metadata.signupUrl,
      ),
      200,
    )
  } catch (err) {
    console.error(
      'create-payme-seller error:',
      err instanceof Error ? err.message : 'unknown',
    )
    return fail('INTERNAL_ERROR', 'Internal server error', 500)
  }
})
