import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import {
  buildProviderSellerRequestBody,
  buildSafeSellerResult,
  buildSandboxSellerRequestBody,
  classifyClaimOutcome,
  decideSellerRequest,
  extractSafeMissingFieldName,
  extractSafeSellerMetadata,
  isPaymeRequiredFieldError,
  isPaymeSuccess,
  normalizeProviderSellerInput,
  PAYME_DEFAULT_BASE_URL,
  PAYME_ONBOARDING_STATUS,
  resolveExistingSeller,
  type PaymeCreateSellerRaw,
} from './paymeSeller.ts'

// PayMe Marketplace seller onboarding.
//
// Phase 1: create a seller and persist safe onboarding metadata.
// Phase 2: build the seller payload from REAL provider data for the automatic
// onboarding path (still gated OFF behind PAYME_SELLER_ONBOARDING_ENABLED), move
// the capability-token signup URL to a private table, and serialize concurrent
// first-time creations. This function never creates payments and never touches
// Stripe.
//
// SECURITY: partner credentials and seller_payme_secret are server-side only and
// are never logged or returned to the client. Provider PII values are never
// logged — only field NAMES (for missing-data diagnostics) and non-secret codes.
//
// KYC/banking is owned by PayMe: the provider completes it inside PayMe Hosted
// Onboarding via seller_dashboard_signup_link. Regli stores none of it.
//
// TODO(payme-webhook): implement the PayMe seller onboarding completion callback
// (and/or Get Sellers status reconciliation) once PayMe delivers the official
// event/status contract. Do not invent event types or seller statuses here.

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

// Best-effort: record that onboarding failed, releasing the `creating` claim so a
// later retry can proceed. Never throws.
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

// Owner-scoped signup URL lives in the private provider_payment_onboarding table.
async function loadSignupUrl(
  admin: ReturnType<typeof createClient>,
  userId: string,
): Promise<string | null> {
  try {
    const { data } = await admin
      .from('provider_payment_onboarding')
      .select('payme_signup_url')
      .eq('provider_id', userId)
      .maybeSingle()
    const url = (data as { payme_signup_url?: unknown } | null)?.payme_signup_url
    return typeof url === 'string' && url.length > 0 ? url : null
  } catch (_err) {
    return null
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

    // ---- Read ONLY the request `source` (never any seller identity fields) ----
    // Classification is explicit (see decideSellerRequest): 'onboarding' or
    // explicit/absent sandbox. No identity (email/name/phone/provider_id) is ever
    // read from the body — the real-data onboarding path uses the authenticated
    // walker's own profile exclusively.
    let source: string | null = null
    try {
      const parsed = await req.json()
      if (parsed && typeof parsed === 'object') {
        const raw = (parsed as Record<string, unknown>).source
        if (typeof raw === 'string') source = raw
      }
    } catch (_err) {
      // no/invalid JSON body — treated as an explicit manual sandbox invocation
    }

    // Service-role client for RLS-bypassing reads/writes.
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey)

    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select(
        'id, email, full_name, whatsapp_number, role, payme_seller_id, payme_public_key_uuid, payme_onboarding_status',
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
    // The capability-token signup URL now lives in the private table.
    if (typeof profile.payme_seller_id === 'string' && profile.payme_seller_id.length > 0) {
      const signupUrl = await loadSignupUrl(supabaseAdmin, user.id)
      const existing = resolveExistingSeller({
        payme_seller_id: profile.payme_seller_id,
        payme_onboarding_status: profile.payme_onboarding_status as string | null,
        payme_signup_url: signupUrl,
      })
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
    }

    // ---- Explicit source decision (single safety gate) ----
    // Exactly two recognized intents; everything else fails safe:
    //   'onboarding' -> REAL data, gated by PAYME_SELLER_ONBOARDING_ENABLED.
    //                   flag != "true" => skip (safe no-op, no PayMe call).
    //   sandbox      -> explicit/absent source; fixed SANDBOX_SELLER_IDENTITY.
    //   unknown      -> rejected; never contacts PayMe.
    const decision = decideSellerRequest({ source, flagValue })

    if (decision.action === 'reject') {
      console.warn(
        JSON.stringify({
          op: 'create-payme-seller',
          userId: user.id,
          outcome: 'unsupported_source',
          intent: decision.intent,
        }),
      )
      return fail('UNSUPPORTED_SOURCE', 'Unsupported request source', 400)
    }

    if (decision.action === 'skip') {
      console.log(
        JSON.stringify({
          op: 'create-payme-seller',
          userId: user.id,
          outcome: 'skipped_flag_disabled',
          intent: decision.intent,
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

    // ---- PayMe configuration required beyond this point ----
    if (!clientKey) {
      return fail('PAYME_CONFIG_MISSING', 'PayMe is not configured', 500)
    }

    // ---- Build the request body (two strictly separated payloads) ----
    // decision.payloadKind is derived ONLY from the explicit intent above:
    //   'provider' = REAL provider data (the 'onboarding' intent only).
    //   'sandbox'  = fixed sandbox identity (explicit/absent source only).
    // The onboarding path can NEVER resolve to the sandbox identity, and the
    // sandbox path can never read provider data.
    const kind = decision.payloadKind
    let requestBody: Record<string, unknown>

    if (kind === 'provider') {
      // Minimal identity only (email / first name / phone), read SERVER-SIDE from
      // the authenticated walker's OWN profile — never from the request body. KYC +
      // banking are completed by the provider inside PayMe Hosted Onboarding, so
      // Regli reads no sensitive data here.
      const normalized = normalizeProviderSellerInput({
        email: profile.email,
        full_name: profile.full_name,
        whatsapp_number: profile.whatsapp_number,
      })

      const built = buildProviderSellerRequestBody(clientKey, normalized)
      if (!built.ok) {
        // Do NOT claim and do NOT contact PayMe. Provider registration itself is
        // unaffected (the client trigger is non-blocking). Log field NAMES only.
        console.warn(
          JSON.stringify({
            op: 'create-payme-seller',
            userId: user.id,
            outcome: 'provider_data_incomplete',
            missing: built.missing,
          }),
        )
        return fail(
          'PAYME_PROVIDER_DATA_INCOMPLETE',
          'Provider payment onboarding data is incomplete',
          422,
        )
      }
      requestBody = built.body
    } else {
      // Manual/sandbox path — never reachable from automatic onboarding.
      requestBody = buildSandboxSellerRequestBody(clientKey)
    }

    // ---- Concurrency claim: only ONE request may create the seller ----
    // Atomic conditional UPDATE (Postgres row lock is the actual lock): flip
    // not_started/failed -> creating. If we don't win the claim, another request
    // either already created the seller or is creating it right now.
    const { data: claimedRows, error: claimError } = await supabaseAdmin
      .from('profiles')
      .update({ payme_onboarding_status: PAYME_ONBOARDING_STATUS.creating })
      .eq('id', user.id)
      .is('payme_seller_id', null)
      .in('payme_onboarding_status', [
        PAYME_ONBOARDING_STATUS.notStarted,
        PAYME_ONBOARDING_STATUS.failed,
      ])
      .select('id')

    if (claimError) {
      console.error('create-payme-seller claim error:', claimError.message)
      return fail('PAYME_SELLER_PERSIST_FAILED', 'Unable to start seller creation', 500)
    }

    const claimed = Array.isArray(claimedRows) && claimedRows.length > 0

    if (!claimed) {
      // Re-read to decide whether it is already done or still in progress.
      const { data: fresh } = await supabaseAdmin
        .from('profiles')
        .select('payme_seller_id, payme_onboarding_status')
        .eq('id', user.id)
        .single()

      const outcome = classifyClaimOutcome({
        claimed: false,
        existingSellerId: (fresh?.payme_seller_id as string | null) ?? null,
      })

      if (outcome === 'return_existing') {
        const signupUrl = await loadSignupUrl(supabaseAdmin, user.id)
        const existing = resolveExistingSeller({
          payme_seller_id: fresh?.payme_seller_id as string | null,
          payme_onboarding_status: fresh?.payme_onboarding_status as string | null,
          payme_signup_url: signupUrl,
        })
        if (existing) return json(existing, 200)
      }

      console.log(
        JSON.stringify({
          op: 'create-payme-seller',
          userId: user.id,
          outcome: 'creation_in_progress',
        }),
      )
      return fail(
        'PAYME_SELLER_CREATION_IN_PROGRESS',
        'PayMe seller creation is already in progress',
        409,
      )
    }

    // ---- Call PayMe (server-side only) ----
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

    // Log only non-secret diagnostic fields (never the raw PayMe body / PII).
    console.log(
      JSON.stringify({
        op: 'create-payme-seller',
        userId: user.id,
        kind,
        httpStatus: paymeResponse.status,
        statusCode: raw?.status_code ?? null,
        statusErrorCode: raw?.status_error_code ?? null,
      }),
    )

    if (!paymeResponse.ok || !isPaymeSuccess(raw)) {
      await markFailed(supabaseAdmin, user.id)

      // PayMe error 19: a marketplace-specific field is required. Surface a safe,
      // actionable code, including the missing field NAME only when PayMe gives a
      // clear schema field name (never a value).
      if (isPaymeRequiredFieldError(raw)) {
        const field = extractSafeMissingFieldName(raw)
        console.warn(
          JSON.stringify({
            op: 'create-payme-seller',
            userId: user.id,
            outcome: 'payme_required_field_missing',
            field,
          }),
        )
        return json(
          {
            success: false,
            code: 'PAYME_REQUIRED_FIELD_MISSING',
            message: 'PayMe requires an additional seller field',
            ...(field ? { field } : {}),
          },
          422,
        )
      }

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

    // ---- Persist safe metadata ----
    // Non-secret identifiers + status stay on public.profiles.
    const { error: updateError } = await supabaseAdmin
      .from('profiles')
      .update({
        payme_seller_id: metadata.sellerPaymeId,
        payme_public_key_uuid: metadata.publicKeyUuid,
        payme_onboarding_status: PAYME_ONBOARDING_STATUS.created,
        payme_created_at: new Date().toISOString(),
      })
      .eq('id', user.id)

    if (updateError) {
      console.error('create-payme-seller persist error:', updateError.message)
      await markFailed(supabaseAdmin, user.id)
      return fail(
        'PAYME_SELLER_PERSIST_FAILED',
        'PayMe seller created but could not be saved',
        500,
      )
    }

    // Capability-token signup URL goes to the private, owner-scoped table.
    if (metadata.signupUrl) {
      const { error: urlError } = await supabaseAdmin
        .from('provider_payment_onboarding')
        .upsert(
          {
            provider_id: user.id,
            payment_provider: 'payme',
            payme_signup_url: metadata.signupUrl,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'provider_id' },
        )
      if (urlError) {
        // Non-fatal: the seller exists and safe identifiers are saved. Log without
        // the URL value.
        console.error('create-payme-seller signup url persist error:', urlError.message)
      }
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
