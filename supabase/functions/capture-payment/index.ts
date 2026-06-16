import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import Stripe from 'https://esm.sh/stripe@17.5.0?target=denonext'

const FUNCTION_VERSION = 'v5_admin_dispute_capture_2026_05_05'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const DEFAULT_MARKET_CURRENCY = 'ils'

console.log(`[capture-payment] ====== FUNCTION LOADED — VERSION: ${FUNCTION_VERSION} ======`)

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  console.log(`[capture-payment][${FUNCTION_VERSION}] ── Request received ──`)

  try {
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

    if (!stripeKey || !supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
      console.error('[capture-payment] Missing env vars')
      return new Response(
        JSON.stringify({ error: 'Server misconfigured', _v: FUNCTION_VERSION }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Missing authorization', _v: FUNCTION_VERSION }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // User auth client
    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: {
          Authorization: authHeader,
        },
      },
    })

    const { data: { user }, error: authError } = await supabaseUser.auth.getUser()
    if (authError || !user) {
      console.error('[capture-payment] Auth failed:', authError?.message)
      return new Response(
        JSON.stringify({ error: 'Invalid token', _v: FUNCTION_VERSION }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Service role client for DB
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey)

    // Verify caller role for the completion path
    const { data: callerProfile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single()

    const callerRole = callerProfile?.role ?? null
    const callerIsAdmin = callerRole === 'admin'
    const callerIsClient = callerRole === 'client'
    if (profileError || !callerProfile || (!callerIsClient && !callerIsAdmin)) {
      console.error('[capture-payment] Caller role not allowed:', {
        request_id: 'unknown',
        action: 'capture_payment',
        caller_id: user.id,
        caller_role: callerRole,
        result: 'forbidden',
        error: profileError?.message ?? 'Only the client or an admin can capture payment',
      })
      return new Response(
        JSON.stringify({ error: 'Only the client or an admin can capture payment', _v: FUNCTION_VERSION }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Parse body
    let body: {
      jobId?: string
      request_id?: string
      requestId?: string
      adminDisputeApproval?: boolean
    }
    try {
      body = await req.json()
    } catch {
      return new Response(
        JSON.stringify({ error: 'Invalid request body', _v: FUNCTION_VERSION }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const rawJobId = body.jobId ?? body.request_id ?? body.requestId
    const jobId = typeof rawJobId === 'string' ? rawJobId.trim() : rawJobId

    console.log(`[capture-payment][${FUNCTION_VERSION}] Parsed body:`, {
      hasJobId: !!body.jobId,
      hasRequestIdSnake: !!body.request_id,
      hasRequestIdCamel: !!body.requestId,
      adminDisputeApproval: body.adminDisputeApproval === true,
      jobId,
      caller_id: user.id,
    })

    if (!jobId) {
      return new Response(
        JSON.stringify({ error: 'Missing jobId', _v: FUNCTION_VERSION }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Load the job with the service-role client. Use maybeSingle() so that
    // a true zero-row result can be reported separately from an actual query error.
    const { data: job, error: jobError } = await supabaseAdmin
      .from('walk_requests')
      .select('id, walker_id, selected_walker_id, client_id, status, payment_status, stripe_payment_intent_id, dog_name, price, walker_earnings, walker_amount, platform_fee, amount, currency, service_started_at, service_completed_at, notes')
      .eq('id', jobId)
      .maybeSingle()

    if (jobError) {
      console.error('[capture-payment] Job lookup query failed:', {
        jobId,
        caller_id: user.id,
        error: jobError.message,
      })
      return new Response(
        JSON.stringify({
          error: 'Job lookup failed',
          details: jobError.message,
          jobId,
          _v: FUNCTION_VERSION,
        }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!job) {
      console.error('[capture-payment] Job not found for id:', {
        jobId,
        caller_id: user.id,
      })
      return new Response(
        JSON.stringify({ error: 'Job not found', jobId, _v: FUNCTION_VERSION }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    let transferAttempted = false
    let captureResultStatus: string | null = null
    const providerId = job.walker_id ?? job.selected_walker_id ?? null
    const logCaptureInvocation = (stage: string) => {
      console.log('[capture-payment] invoked', {
        requestId: job.id,
        providerId,
        paymentIntentId: job.stripe_payment_intent_id ?? null,
        paymentStatusBeforeCapture: job.payment_status ?? null,
        captureResultStatus,
        transferAttempted,
        stage,
      })
    }

    console.log(`[capture-payment][${FUNCTION_VERSION}] Job loaded:`, {
      request_id: job.id,
      action: 'capture_payment',
      caller_id: user.id,
      caller_role: callerRole,
      id: job.id,
      walker_id: job.walker_id,
      client_id: job.client_id,
      status: job.status,
      payment_status: job.payment_status,
      stripe_payment_intent_id: job.stripe_payment_intent_id,
    })
    logCaptureInvocation('job_loaded')

    const callerOwnsJob = callerIsClient && job.client_id === user.id
    const jobIsDisputed = isCompletionReviewRequired(job.notes)
    const isAdminApproval = callerIsAdmin || body.adminDisputeApproval === true
    const canAdminResolveDisputedCapture = isAdminApproval && jobIsDisputed

    // Verify caller is the owning client, or an admin resolving a disputed job
    if (!callerOwnsJob && !canAdminResolveDisputedCapture) {
      console.warn('[capture-payment] Caller mismatch:', {
        request_id: job.id,
        action: 'capture_payment',
        caller: user.id,
        caller_role: callerRole,
        walker_id: job.walker_id,
        client_id: job.client_id,
        disputed: jobIsDisputed,
        admin_approval: isAdminApproval,
        result: 'forbidden',
      })
      return new Response(
        JSON.stringify({
          error: 'Only the client can confirm completion and capture payment',
          _v: FUNCTION_VERSION,
        }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── Idempotent: already completed + paid ────────────────────
    if (job.status === 'completed' && job.payment_status === 'paid') {
      captureResultStatus = 'already_paid'
      console.log(`[capture-payment][${FUNCTION_VERSION}] Job already completed and paid, ensuring wallet credit`)
      if (jobIsDisputed) {
        await supabaseAdmin
          .from('walk_requests')
          .update({ notes: removeCompletionReviewMarker(job.notes) })
          .eq('id', job.id)
      }
      const earnings = job.walker_amount ?? job.walker_earnings ?? (job.price != null ? Math.round(job.price * 0.8 * 100) / 100 : 0)
      if (earnings > 0) {
        const { error: walletCreditError } = await supabaseAdmin.rpc('credit_walker_wallet', {
          p_walker_id: job.walker_id,
          p_job_id: job.id,
          p_amount: earnings,
          p_currency: normalizeCurrency(job.currency) ?? DEFAULT_MARKET_CURRENCY,
          p_description: `Walk completed: ${job.dog_name || 'walk'}`,
        })
        if (walletCreditError) {
          console.error('[capture-payment] Wallet credit on idempotent path failed:', walletCreditError)
        }
        await notifyWalkerPaymentReceived(
          supabaseAdmin,
          job,
          earnings,
          normalizeCurrency(job.currency) ?? DEFAULT_MARKET_CURRENCY,
        ).catch((err: unknown) =>
          console.error('[capture-payment] Payment notification on idempotent path failed:', err)
        )
      }
      transferAttempted = true
      const transferResult = await tryCreateTransfer(supabaseAdmin, stripeKey, job).catch((err: unknown) => {
        console.error('[capture-payment] Transfer on idempotent path failed:', err)
        return 'failed' as const
      })
      if (transferResult === 'created') {
        console.log('[payout-push] transfer success reached', {
          jobId: job.id,
          providerId: job.walker_id,
          source: 'capture-payment',
          path: 'idempotent_paid',
        })
        await sendWalkerPayoutPush({ supabaseUrl, serviceRoleKey, job })
      }
      logCaptureInvocation('idempotent_paid_return')
      return new Response(
        JSON.stringify({
          success: true,
          jobId: job.id,
          status: 'completed',
          paymentStatus: 'paid',
          completedAt: job.service_completed_at,
          alreadyCompleted: true,
          _v: FUNCTION_VERSION,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── Validate job is in the client-confirmation completion state ────────
    if (job.status !== 'accepted') {
      return new Response(
        JSON.stringify({
          error: `Job cannot be completed: current status is "${job.status}"`,
          details: `Expected status 'accepted' for client confirmation, got '${job.status}'`,
          _v: FUNCTION_VERSION,
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!job.service_started_at) {
      return new Response(
        JSON.stringify({
          error: 'Service has not started yet',
          details: 'Completion is blocked until service_started_at is set.',
          _v: FUNCTION_VERSION,
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!job.service_completed_at) {
      return new Response(
        JSON.stringify({
          error: 'Service completion was not confirmed yet',
          details: 'Completion is blocked until service_completed_at is set.',
          _v: FUNCTION_VERSION,
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // If there's no PaymentIntent, just mark as completed (free walk / test)
    if (!job.stripe_payment_intent_id) {
      captureResultStatus = 'no_payment_intent'
      logCaptureInvocation('no_payment_intent')
      console.log(`[capture-payment][${FUNCTION_VERSION}] No PaymentIntent — marking completed without capture`)
      const now = new Date().toISOString()
      await supabaseAdmin
        .from('walk_requests')
        .update({
          status: 'completed',
          payment_status: 'paid',
          paid_at: now,
          service_completed_at: job.service_completed_at ?? now,
          currency: normalizeCurrency(job.currency) ?? DEFAULT_MARKET_CURRENCY,
          notes: removeCompletionReviewMarker(job.notes),
        })
        .eq('id', jobId)
      return new Response(
        JSON.stringify({
          success: true,
          jobId: job.id,
          status: 'completed',
          paymentStatus: 'paid',
          completedAt: now,
          noPayment: true,
          _v: FUNCTION_VERSION,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── Retrieve PaymentIntent from Stripe FIRST ────────────────
    // This is the single source of truth for payment state.
    const stripe = new Stripe(stripeKey, { apiVersion: '2024-12-18.acacia' })

    let pi: Stripe.PaymentIntent
    try {
      pi = await stripe.paymentIntents.retrieve(job.stripe_payment_intent_id)
      console.log(`[capture-payment][${FUNCTION_VERSION}] PI retrieved:`, { id: pi.id, status: pi.status, amount: pi.amount })
    } catch (retrieveErr: unknown) {
      console.error(`[capture-payment][${FUNCTION_VERSION}] Failed to retrieve PI:`, retrieveErr)
      const msg = retrieveErr instanceof Error ? retrieveErr.message : 'Unknown error'
      return new Response(
        JSON.stringify({
          error: 'Failed to verify payment status',
          details: `Could not retrieve PaymentIntent: ${msg}`,
          _v: FUNCTION_VERSION,
        }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── Handle PI based on its actual Stripe status ─────────────

    if (pi.status === 'succeeded') {
      captureResultStatus = pi.status
      // Payment already captured (by a previous attempt or webhook) — reconcile DB
      console.log(`[capture-payment][${FUNCTION_VERSION}] PI already succeeded — reconciling DB`)
      const now = new Date().toISOString()
      await supabaseAdmin
        .from('walk_requests')
        .update({
          status: 'completed',
          payment_status: 'paid',
          paid_at: now,
          service_completed_at: job.service_completed_at ?? now,
          notes: removeCompletionReviewMarker(job.notes),
        })
        .eq('id', jobId)

      const earnings = job.walker_amount ?? job.walker_earnings ?? (job.price != null ? Math.round(job.price * 0.8 * 100) / 100 : 0)
      if (earnings > 0) {
        const { error: walletCreditError } = await supabaseAdmin.rpc('credit_walker_wallet', {
          p_walker_id: job.walker_id,
          p_job_id: job.id,
          p_amount: earnings,
          p_currency: pi.currency,
          p_description: `Walk completed: ${job.dog_name || 'walk'}`,
        })
        if (walletCreditError) {
          console.error('[capture-payment] Wallet credit failed:', walletCreditError)
        }
        await notifyWalkerPaymentReceived(supabaseAdmin, job, earnings, pi.currency).catch((err: unknown) =>
          console.error('[capture-payment] Payment notification failed:', err)
        )
      }

      transferAttempted = true
      const transferResult = await tryCreateTransfer(supabaseAdmin, stripeKey, job).catch((err: unknown) => {
        console.error('[capture-payment] Transfer failed:', err)
        return 'failed' as const
      })
      if (transferResult === 'created') {
        console.log('[payout-push] transfer success reached', {
          jobId: job.id,
          providerId: job.walker_id,
          source: 'capture-payment',
          path: 'pi_already_succeeded',
        })
        await sendWalkerPayoutPush({ supabaseUrl, serviceRoleKey, job })
      }
      logCaptureInvocation('pi_already_succeeded_return')

      return new Response(
        JSON.stringify({
          success: true,
          jobId: job.id,
          status: 'completed',
          paymentStatus: 'paid',
          completedAt: now,
          alreadyCaptured: true,
          _v: FUNCTION_VERSION,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (pi.status === 'canceled') {
      captureResultStatus = pi.status
      logCaptureInvocation('pi_canceled')
      console.warn(`[capture-payment][${FUNCTION_VERSION}] PI is canceled — cannot capture`)
      const now = new Date().toISOString()
      await supabaseAdmin
        .from('walk_requests')
        .update({
          status: 'completed',
          payment_status: 'failed',
          service_completed_at: job.service_completed_at ?? now,
        })
        .eq('id', jobId)
      return new Response(
        JSON.stringify({
          error: 'Payment was canceled and cannot be captured',
          details: 'The PaymentIntent has been canceled. The walk is marked completed but payment failed.',
          _v: FUNCTION_VERSION,
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (pi.status === 'requires_payment_method' || pi.status === 'requires_confirmation') {
      captureResultStatus = pi.status
      logCaptureInvocation('pi_not_authorized')
      // Payment was never authorized. Do not mark the walk completed, and do not
      // auto-cancel here; the app keeps the active job visible with a clear error.
      console.error(`[capture-payment][${FUNCTION_VERSION}] PI in '${pi.status}' — payment was never authorized. Leaving job ${jobId} active`)
      await supabaseAdmin
        .from('walk_requests')
        .update({ payment_status: 'failed' })
        .eq('id', jobId)
      return new Response(
        JSON.stringify({
          code: 'payment_not_authorized',
          error: 'Payment was never authorized',
          paymentIntentStatus: pi.status,
          details: `PaymentIntent status is '${pi.status}'. The client's card was never charged. The walk was not completed.`,
          _v: FUNCTION_VERSION,
        }),
        { status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (pi.status !== 'requires_capture') {
      captureResultStatus = pi.status
      logCaptureInvocation('pi_unexpected_state')
      // PI is in another non-capturable state (processing, etc.)
      console.error(`[capture-payment][${FUNCTION_VERSION}] PI in unexpected state:`, pi.status)
      return new Response(
        JSON.stringify({
          error: `Payment is not ready for capture`,
          details: `PaymentIntent status is '${pi.status}'. Expected 'requires_capture'.`,
          _v: FUNCTION_VERSION,
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── PI status is 'requires_capture' — do the capture ────────
    console.log(`[capture-payment][${FUNCTION_VERSION}] Capturing PaymentIntent:`, job.stripe_payment_intent_id)
    console.log(`[payment-auth] capture_started`, {
      jobId,
      paymentIntentId: job.stripe_payment_intent_id,
    })

    let capturedIntent: Stripe.PaymentIntent
    try {
      capturedIntent = await stripe.paymentIntents.capture(job.stripe_payment_intent_id)
    } catch (stripeErr: unknown) {
      console.error(`[capture-payment][${FUNCTION_VERSION}] Stripe capture failed:`, stripeErr)
      console.error(`[payment-auth] capture_failed`, {
        jobId,
        paymentIntentId: job.stripe_payment_intent_id,
        error: stripeErr instanceof Error ? stripeErr.message : String(stripeErr),
      })

      const stripeError = stripeErr as { type?: string; code?: string; message?: string }

      // If capture failed with "unexpected state", re-check PI — it may have been captured
      // between our retrieve and capture calls (race condition)
      if (stripeError.code === 'payment_intent_unexpected_state') {
        try {
          const freshPi = await stripe.paymentIntents.retrieve(job.stripe_payment_intent_id)
          if (freshPi.status === 'succeeded') {
            captureResultStatus = freshPi.status
            console.log(`[capture-payment][${FUNCTION_VERSION}] PI succeeded between retrieve and capture — reconciling`)
            const now = new Date().toISOString()
            await supabaseAdmin
              .from('walk_requests')
              .update({
                status: 'completed',
                payment_status: 'paid',
                paid_at: now,
                service_completed_at: job.service_completed_at ?? now,
                currency: freshPi.currency,
                notes: removeCompletionReviewMarker(job.notes),
              })
              .eq('id', jobId)

            const earnings = job.walker_amount ?? job.walker_earnings ?? (job.price != null ? Math.round(job.price * 0.8 * 100) / 100 : 0)
            if (earnings > 0) {
              const { error: walletCreditError } = await supabaseAdmin.rpc('credit_walker_wallet', {
                p_walker_id: job.walker_id,
                p_job_id: job.id,
                p_amount: earnings,
                p_currency: freshPi.currency,
                p_description: `Walk completed: ${job.dog_name || 'walk'}`,
              })
              if (walletCreditError) {
                console.error('[capture-payment] Wallet credit failed:', walletCreditError)
              }
              await notifyWalkerPaymentReceived(supabaseAdmin, job, earnings, freshPi.currency).catch((err: unknown) =>
                console.error('[capture-payment] Payment notification failed:', err)
              )
            }

            transferAttempted = true
            const transferResult = await tryCreateTransfer(supabaseAdmin, stripeKey, job).catch((err: unknown) => {
              console.error('[capture-payment] Transfer failed:', err)
              return 'failed' as const
            })
            if (transferResult === 'created') {
              console.log('[payout-push] transfer success reached', {
                jobId: job.id,
                providerId: job.walker_id,
                source: 'capture-payment',
                path: 'capture_race_reconcile',
              })
              await sendWalkerPayoutPush({ supabaseUrl, serviceRoleKey, job })
            }
            logCaptureInvocation('capture_race_reconcile_return')

            return new Response(
              JSON.stringify({
                success: true,
                jobId: job.id,
                status: 'completed',
                paymentStatus: 'paid',
                completedAt: now,
                alreadyCaptured: true,
                _v: FUNCTION_VERSION,
              }),
              { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            )
          }
          console.error(`[capture-payment][${FUNCTION_VERSION}] PI state after race:`, freshPi.status)
        } catch (re) {
          console.error(`[capture-payment][${FUNCTION_VERSION}] Failed to re-retrieve PI:`, re)
        }
      }

      // For any Stripe error, return a 422 with details (NOT 502)
      const errMsg = stripeError.message || 'Unknown Stripe error'
      return new Response(
        JSON.stringify({
          error: 'Payment capture failed',
          details: `Stripe error: ${errMsg}`,
          code: stripeError.code || 'unknown',
          _v: FUNCTION_VERSION,
        }),
        { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log(`[capture-payment][${FUNCTION_VERSION}] Capture result:`, { status: capturedIntent.status, id: capturedIntent.id })
    captureResultStatus = capturedIntent.status
    console.log(`[payment-auth] capture_succeeded`, {
      jobId,
      paymentIntentId: capturedIntent.id,
      status: capturedIntent.status,
    })

    if (capturedIntent.status !== 'succeeded') {
      logCaptureInvocation('capture_unexpected_result')
      return new Response(
        JSON.stringify({
          error: `Unexpected capture result`,
          details: `PaymentIntent status after capture: '${capturedIntent.status}'`,
          _v: FUNCTION_VERSION,
        }),
        { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── Update DB after successful capture ──────────────────────
    const now = new Date().toISOString()
    const { error: updateError } = await supabaseAdmin
      .from('walk_requests')
      .update({
        status: 'completed',
        payment_status: 'paid',
        paid_at: now,
        currency: capturedIntent.currency,
        service_completed_at: job.service_completed_at ?? now,
        notes: removeCompletionReviewMarker(job.notes),
      })
      .eq('id', jobId)

    if (updateError) {
      // Payment IS captured in Stripe — log hard but still return success
      // so the frontend knows the walk is done. DB will reconcile on next read.
      console.error(`[capture-payment][${FUNCTION_VERSION}] DB update after capture failed:`, updateError)
    }

    // Credit walker wallet (idempotent)
    const walkerEarnings = job.walker_amount ?? job.walker_earnings ?? (job.price != null ? Math.round(job.price * 0.8 * 100) / 100 : 0)
    console.log(`[ProviderEarnings][${FUNCTION_VERSION}] Wallet credit calculation:`, {
      jobId: job.id,
      walkerId: job.walker_id,
      walkerAmount: job.walker_amount,
      walkerEarnings: job.walker_earnings,
      price: job.price,
      resolvedEarnings: walkerEarnings,
      source: job.walker_amount != null ? 'walker_amount' : job.walker_earnings != null ? 'walker_earnings' : 'price_fallback',
    })
    if (walkerEarnings > 0) {
      const { error: walletErr } = await supabaseAdmin.rpc('credit_walker_wallet', {
        p_walker_id: job.walker_id,
        p_job_id: job.id,
        p_amount: walkerEarnings,
        p_currency: capturedIntent.currency,
        p_description: `Walk completed: ${job.dog_name || 'walk'}`,
      })
      if (walletErr) {
        console.error('[capture-payment] Wallet credit failed (non-blocking):', walletErr)
      } else {
        console.log('[capture-payment] Wallet credited:', walkerEarnings, 'for walker', job.walker_id)
        await notifyWalkerPaymentReceived(
          supabaseAdmin,
          job,
          walkerEarnings,
          capturedIntent.currency,
        ).catch((err: unknown) =>
          console.error('[capture-payment] Payment notification failed (non-blocking):', err)
        )
      }
    }

    // Create Stripe Transfer to walker (non-blocking — payment is already captured)
    transferAttempted = true
    const transferResult = await tryCreateTransfer(supabaseAdmin, stripeKey, job).catch((err: unknown) => {
      console.error('[capture-payment] Transfer creation failed (non-blocking):', err)
      return 'failed' as const
    })
    if (transferResult === 'created') {
      console.log('[payout-push] transfer success reached', {
        jobId: job.id,
        providerId: job.walker_id,
        source: 'capture-payment',
        path: 'capture_success',
      })
      await sendWalkerPayoutPush({ supabaseUrl, serviceRoleKey, job })
    }
    logCaptureInvocation('capture_success_return')

    console.log(`[capture-payment][${FUNCTION_VERSION}] Success: job`, jobId, 'completed and paid')

    return new Response(
      JSON.stringify({
        success: true,
        jobId: job.id,
        status: 'completed',
        paymentStatus: 'paid',
        completedAt: now,
        paidAt: now,
        _v: FUNCTION_VERSION,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    console.error(`[capture-payment][${FUNCTION_VERSION}] Unhandled error:`, err)
    return new Response(
      JSON.stringify({ error: 'Internal server error', details: err instanceof Error ? err.message : 'Unknown', _v: FUNCTION_VERSION }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

// ─── Transfer helper ────────────────────────────────────────────

interface JobRow {
  id: string
  walker_id: string | null
  selected_walker_id?: string | null
  price: number | null
  walker_amount: number | null
  walker_earnings: number | null
  platform_fee: number | null
  amount: number | null
  currency: string | null
  dog_name: string | null
  stripe_payment_intent_id: string | null
  service_started_at?: string | null
  service_completed_at?: string | null
  notes?: string | null
}

const COMPLETION_REVIEW_MARKER = '[SYSTEM:COMPLETION_DISPUTED]'

function isCompletionReviewRequired(notes: string | null | undefined): boolean {
  return typeof notes === 'string'
    ? notes
        .split('\n')
        .some((line) => line.trim().startsWith(COMPLETION_REVIEW_MARKER))
    : false
}

function removeCompletionReviewMarker(notes: string | null | undefined): string | null {
  if (typeof notes !== 'string') return null
  const nextNotes = notes
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => !line.trim().startsWith(COMPLETION_REVIEW_MARKER))
    .join('\n')
    .trim()

  return nextNotes || null
}

function normalizeCurrency(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return /^[a-z]{3}$/.test(normalized) ? normalized : null
}

function currencyLabel(value: string | null | undefined): string {
  return (normalizeCurrency(value) ?? DEFAULT_MARKET_CURRENCY).toUpperCase()
}

function formatCurrencyAmountText(amount: number, currency: string | null | undefined): string {
  const normalizedCurrency = normalizeCurrency(currency) ?? DEFAULT_MARKET_CURRENCY
  const amountLabel = formatAmount(amount)
  if (normalizedCurrency === 'ils') return `₪${amountLabel}`
  return `${currencyLabel(normalizedCurrency)} ${amountLabel}`
}

function formatAmount(amount: number): string {
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2).replace(/\.?0+$/, '')
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

function toStripeAmountSmallest(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.round(value)
}

async function notifyWalkerPaymentReceived(
  supabaseAdmin: ReturnType<typeof createClient>,
  job: JobRow,
  amount: number,
  paymentCurrency: string | null | undefined
) {
  if (!job.walker_id || !(amount > 0)) return

  const amountText = formatCurrencyAmountText(amount, paymentCurrency)
  const { data: existing, error: existingError } = await supabaseAdmin
    .from('notifications')
    .select('id')
    .eq('user_id', job.walker_id)
    .eq('type', 'payment_received')
    .eq('related_job_id', job.id)
    .limit(1)
    .maybeSingle()

  if (existingError) throw existingError
  if (existing) return

  const { error: insertError } = await supabaseAdmin
    .from('notifications')
    .insert({
      user_id: job.walker_id,
      type: 'payment_received',
      title: `Payment received ${amountText} 💰`,
      message: 'Your service payment was sent to your payout account.',
      related_job_id: job.id,
    })

  if (insertError) throw insertError
}

async function sendWalkerPayoutPush(params: {
  supabaseUrl: string
  serviceRoleKey: string
  job: JobRow
}) {
  if (!params.job.walker_id) return
  const payoutAmount =
    params.job.walker_amount
    ?? params.job.walker_earnings
    ?? (params.job.price != null ? Math.round(params.job.price * 0.8 * 100) / 100 : 0)
  const amountText =
    payoutAmount > 0
      ? formatCurrencyAmountText(payoutAmount, params.job.currency)
      : null

  try {
    console.log('[payout-push] sending provider push', {
      providerId: params.job.walker_id,
      notificationType: 'payment_received',
      amountText,
      source: 'capture-payment',
    })

    const response = await fetch(`${params.supabaseUrl}/functions/v1/send-push-notification`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${params.serviceRoleKey}`,
        apikey: params.serviceRoleKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        targetUserId: params.job.walker_id,
        notificationType: 'payment_received',
        relatedJobId: params.job.id,
        deepLink: 'regli://wallet',
        source: 'capture_payment_transfer',
        data: {
          dedupId: `payout-transfer:${params.job.id}`,
          type: 'payment_received',
          source: 'capture_payment_transfer',
          ...(amountText ? { amountText } : {}),
        },
      }),
    })

    let responseBody: Record<string, unknown> | null = null
    try {
      responseBody = await response.json() as Record<string, unknown>
    } catch {
      responseBody = null
    }

    if (!response.ok) {
      console.warn('[payout-push] provider push failed', {
        jobId: params.job.id,
        providerId: params.job.walker_id,
        status: response.status,
        responseBody,
      })
      return
    }

    const sent = typeof responseBody?.sent === 'number' ? responseBody.sent : null
    const skipped = typeof responseBody?.skipped === 'string' ? responseBody.skipped : null
    const iosTotal = typeof responseBody?.iosTotal === 'number' ? responseBody.iosTotal : null

    if (!sent || sent < 1) {
      console.warn('[payout-push] provider push failed', {
        jobId: params.job.id,
        providerId: params.job.walker_id,
        sent,
        skipped,
        iosTotal,
        responseBody,
      })
      return
    }

    console.log('[payout-push] provider push sent', {
      jobId: params.job.id,
      providerId: params.job.walker_id,
      sent,
      iosTotal,
      responseBody,
    })
  } catch (error) {
    console.warn('[payout-push] provider push failed', {
      jobId: params.job.id,
      providerId: params.job.walker_id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

async function tryCreateTransfer(
  supabaseAdmin: ReturnType<typeof createClient>,
  stripeKey: string,
  job: JobRow
) {
  const walkerId = job.walker_id || job.selected_walker_id
  if (!walkerId) {
    console.warn('[transfer] No walker_id for job', job.id)
    console.log('[payout-transfer] skipped reason', {
      jobId: job.id,
      providerId: null,
      reason: 'missing_walker_id',
    })
    return 'skipped' as const
  }

  // Check if transfer already exists (idempotent)
  const { data: existing } = await supabaseAdmin
    .from('walker_payouts')
    .select('id, status, stripe_transfer_id')
    .eq('job_id', job.id)
    .maybeSingle()

  if (existing?.stripe_transfer_id) {
    console.log('[transfer] Transfer already exists for job', job.id, ':', existing.stripe_transfer_id)
    console.log('[payout-transfer] skipped reason', {
      jobId: job.id,
      providerId: walkerId,
      reason: 'existing_transfer',
      stripeTransferId: existing.stripe_transfer_id,
    })
    return 'existing' as const
  }

  // Skip if already processing (race condition guard)
  if (existing?.status === 'processing') {
    console.log('[transfer] Transfer already processing for job', job.id)
    console.log('[payout-transfer] skipped reason', {
      jobId: job.id,
      providerId: walkerId,
      reason: 'already_processing',
    })
    return 'processing' as const
  }

  // Get walker's connected account and Stripe payout readiness flags
  const { data: walkerProfile } = await supabaseAdmin
    .from('profiles')
    .select('stripe_connect_account_id, payouts_enabled, charges_enabled')
    .eq('id', walkerId)
    .single()

  if (!walkerProfile?.stripe_connect_account_id) {
    console.warn('[transfer] Walker has no connected account, skipping transfer for job', job.id)
    console.log('[payout-transfer] provider stripe account missing', {
      jobId: job.id,
      providerId: walkerId,
      payoutsEnabled: walkerProfile?.payouts_enabled ?? null,
      chargesEnabled: walkerProfile?.charges_enabled ?? null,
    })
    console.log('[payout-transfer] skipped reason', {
      jobId: job.id,
      providerId: walkerId,
      reason: 'missing_stripe_connect_account_id',
    })
    return 'skipped' as const
  }

  console.log('[payout-transfer] provider stripe account found', {
    jobId: job.id,
    providerId: walkerId,
    stripeConnectAccountId: walkerProfile.stripe_connect_account_id,
    payoutsEnabled: walkerProfile.payouts_enabled,
    chargesEnabled: walkerProfile.charges_enabled,
  })

  if (!walkerProfile.payouts_enabled || !walkerProfile.charges_enabled) {
    console.log('[payout-transfer] skipped reason', {
      jobId: job.id,
      providerId: walkerId,
      reason: 'stripe_connect_not_ready',
      stripeConnectAccountId: walkerProfile.stripe_connect_account_id,
      payoutsEnabled: walkerProfile.payouts_enabled,
      chargesEnabled: walkerProfile.charges_enabled,
    })
    return 'skipped' as const
  }

  // Calculate amounts
  const netAmount = job.walker_amount ?? job.walker_earnings ?? (job.price != null ? Math.round(job.price * 0.8 * 100) / 100 : 0)
  const grossAmount = job.price ?? (job.amount != null ? job.amount / 100 : 0)
  const platformFee = job.platform_fee ?? Math.round(grossAmount * 0.2 * 100) / 100

  if (netAmount <= 0) {
    console.warn('[transfer] Net amount is 0, skipping transfer for job', job.id)
    console.log('[payout-transfer] skipped reason', {
      jobId: job.id,
      providerId: walkerId,
      reason: 'net_amount_zero',
      netAmount,
    })
    return 'skipped' as const
  }

  // Get charge ID and real currency directly from the PaymentIntent
  // CRITICAL: Do NOT use job.currency — it may be wrong (e.g. 'ils' when Stripe charge is 'usd')
  const stripe = new Stripe(stripeKey, { apiVersion: '2024-12-18.acacia' })

  let paymentIntentId: string | null = job.stripe_payment_intent_id
  let paymentIntentCurrency: string | null = null
  let latestChargeId: string | null = null
  let chargeCurrency: string | null = null
  let balanceTransactionCurrency: string | null = null
  let balanceTransactionAmountSmallest: number | null = null
  let transferCurrencyUsed: string | null = null
  let sourceTransactionUsed: string | null = null
  let stripeTransferAmountUsed: number | null = null

  if (job.stripe_payment_intent_id) {
    try {
      const pi = await stripe.paymentIntents.retrieve(job.stripe_payment_intent_id, {
        expand: ['latest_charge.balance_transaction'],
      })
      paymentIntentCurrency = normalizeCurrency(pi.currency)
      const latestCharge = typeof pi.latest_charge === 'string' ? null : pi.latest_charge
      const balanceTransaction =
        latestCharge && typeof latestCharge.balance_transaction !== 'string'
          ? latestCharge.balance_transaction
          : null

      latestChargeId = latestCharge?.id ?? (typeof pi.latest_charge === 'string' ? pi.latest_charge : null)
      chargeCurrency = normalizeCurrency(latestCharge?.currency)
      balanceTransactionCurrency = normalizeCurrency(balanceTransaction?.currency)
      balanceTransactionAmountSmallest =
        typeof balanceTransaction?.amount === 'number' ? Math.abs(balanceTransaction.amount) : null
      transferCurrencyUsed = balanceTransactionCurrency ?? chargeCurrency ?? paymentIntentCurrency
      sourceTransactionUsed = latestChargeId
      const normalizedJobCurrency = normalizeCurrency(job.currency)
      if (normalizedJobCurrency && transferCurrencyUsed && normalizedJobCurrency !== transferCurrencyUsed) {
        console.error('[transfer] CURRENCY MISMATCH detected:', {
          jobId: job.id,
          jobCurrency: normalizedJobCurrency,
          paymentIntentId,
          paymentIntentCurrency,
          latestChargeId,
          chargeCurrency,
          balanceTransactionCurrency,
          balanceTransactionAmountSmallest,
          transferCurrencyUsed,
          sourceTransactionUsed,
        })
      }

      if (!latestChargeId || !transferCurrencyUsed || !balanceTransactionAmountSmallest) {
        console.error('[transfer] ABORTING transfer — missing charge or balance transaction details', {
          jobId: job.id,
          paymentIntentId: pi.id,
          paymentIntentCurrency,
          latestChargeId,
          chargeCurrency,
          balanceTransactionCurrency,
          balanceTransactionAmountSmallest,
          transferCurrencyUsed,
          sourceTransactionUsed,
        })
        console.log('[payout-transfer] skipped reason', {
          jobId: job.id,
          providerId: walkerId,
          reason: 'missing_charge_or_balance_transaction',
        })
        return 'failed' as const
      }

      console.log('[transfer] PI retrieved:', {
        jobId: job.id,
        piId: pi.id,
        piCurrency: paymentIntentCurrency,
        latestChargeId,
        chargeCurrency,
        balanceTransactionCurrency,
        balanceTransactionAmountSmallest,
        transferCurrencyUsed,
        sourceTransactionUsed,
        jobCurrency: job.currency,
      })
    } catch (err) {
      console.error('[transfer] Failed to retrieve PI:', err)
      console.error('[transfer] ABORTING transfer — cannot determine currency without PI')
      console.log('[payout-transfer] skipped reason', {
        jobId: job.id,
        providerId: walkerId,
        reason: 'payment_intent_retrieve_failed',
      })
      return 'failed' as const
    }
  } else {
    console.error('[transfer] No stripe_payment_intent_id on job', job.id, '— cannot determine currency')
    console.log('[payout-transfer] skipped reason', {
      jobId: job.id,
      providerId: walkerId,
      reason: 'missing_payment_intent_id',
    })
    return 'failed' as const
  }

  const netRatio = clampRatio(netAmount / grossAmount)
  stripeTransferAmountUsed = Math.round((balanceTransactionAmountSmallest ?? 0) * netRatio)
  const jobCurrency = normalizeCurrency(job.currency) ?? paymentIntentCurrency ?? chargeCurrency ?? transferCurrencyUsed
  const providerEarningsCurrency = paymentIntentCurrency ?? jobCurrency ?? transferCurrencyUsed
  const accountingFields = {
    job_currency: jobCurrency,
    provider_earnings_currency: providerEarningsCurrency,
    payment_intent_currency: paymentIntentCurrency,
    charge_currency: chargeCurrency,
    stripe_balance_transaction_currency: balanceTransactionCurrency,
    stripe_balance_transaction_amount: toStripeAmountSmallest(balanceTransactionAmountSmallest),
    stripe_transfer_currency: transferCurrencyUsed,
    stripe_transfer_amount: toStripeAmountSmallest(stripeTransferAmountUsed),
    earnings_share_ratio: Number(netRatio.toFixed(8)),
  }

  if (!(stripeTransferAmountUsed > 0)) {
    console.error('[transfer] ABORTING transfer — derived transfer amount is zero', {
      jobId: job.id,
      grossAmount,
      netAmount,
      netRatio,
      paymentIntentId,
      paymentIntentCurrency,
      latestChargeId,
      chargeCurrency,
      balanceTransactionCurrency,
      balanceTransactionAmountSmallest,
      transferCurrencyUsed,
      stripeTransferAmountUsed,
      sourceTransactionUsed,
    })
    console.log('[payout-transfer] skipped reason', {
      jobId: job.id,
      providerId: walkerId,
      reason: 'derived_transfer_amount_zero',
    })
    return 'failed' as const
  }

  // Insert pending payout record (or update existing)
  if (!existing) {
    const { error: insertErr } = await supabaseAdmin
      .from('walker_payouts')
      .insert({
        walker_id: walkerId,
        job_id: job.id,
        gross_amount: grossAmount,
        platform_fee: platformFee,
        net_amount: netAmount,
        currency: transferCurrencyUsed,
        status: 'processing',
        ...accountingFields,
      })

    if (insertErr) {
      if (!insertErr.message?.includes('duplicate')) {
        console.error('[transfer] Failed to insert walker_payouts:', insertErr)
        console.log('[payout-transfer] skipped reason', {
          jobId: job.id,
          providerId: walkerId,
          reason: 'walker_payout_insert_failed',
          error: insertErr.message,
        })
        return 'failed' as const
      }
    } else {
      console.log('[payout-transfer] walker_payouts upserted', {
        jobId: job.id,
        providerId: walkerId,
        mode: 'insert',
        status: 'processing',
      })
    }
  } else {
    const { error: lockErr } = await supabaseAdmin
      .from('walker_payouts')
      .update({
        status: 'processing',
        currency: transferCurrencyUsed,
        ...accountingFields,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
      .in('status', ['pending', 'failed'])

    if (lockErr) {
      console.warn('[transfer] Failed to acquire processing lock for job', job.id)
      console.log('[payout-transfer] skipped reason', {
        jobId: job.id,
        providerId: walkerId,
        reason: 'processing_lock_failed',
        error: lockErr.message,
      })
      return 'failed' as const
    }
    console.log('[payout-transfer] walker_payouts upserted', {
      jobId: job.id,
      providerId: walkerId,
      mode: 'update',
      status: 'processing',
      payoutId: existing.id,
    })
  }

  // Create the Stripe Transfer
  try {
    console.log('[payout-transfer] create transfer started', {
      jobId: job.id,
      providerId: walkerId,
      destination: walkerProfile.stripe_connect_account_id,
      amount: stripeTransferAmountUsed,
      currency: transferCurrencyUsed,
    })
    console.log('[FINAL TRANSFER CALL]', {
      paymentIntentId,
      paymentIntentCurrency,
      latestChargeId,
      chargeCurrency,
      balanceTransactionCurrency,
      balanceTransactionAmountSmallest,
      transferCurrencyUsed,
      stripeTransferAmountUsed,
      sourceTransactionUsed,
      jobCurrency: job.currency,
      destination: walkerProfile.stripe_connect_account_id,
      hasSourceTransaction: !!sourceTransactionUsed,
    })

    const transferParams: Stripe.TransferCreateParams = {
      amount: stripeTransferAmountUsed,
      currency: transferCurrencyUsed,
      destination: walkerProfile.stripe_connect_account_id,
      metadata: {
        job_id: job.id,
        walker_id: walkerId,
        payment_intent_id: job.stripe_payment_intent_id,
        payment_intent_currency: paymentIntentCurrency ?? '',
        charge_currency: chargeCurrency ?? '',
        balance_transaction_currency: balanceTransactionCurrency ?? '',
        balance_transaction_amount: String(balanceTransactionAmountSmallest ?? ''),
        stripe_transfer_amount_used: String(stripeTransferAmountUsed),
        job_currency: normalizeCurrency(job.currency) ?? '',
        job_gross_amount: grossAmount.toFixed(2),
        job_net_amount: netAmount.toFixed(2),
      },
    }

    if (!sourceTransactionUsed) {
      console.error('[transfer] ABORTING transfer — missing source_transaction', {
        jobId: job.id,
        paymentIntentId,
        paymentIntentCurrency,
        latestChargeId,
        chargeCurrency,
        balanceTransactionCurrency,
        transferCurrencyUsed,
        sourceTransactionUsed,
      })
      console.log('[payout-transfer] skipped reason', {
        jobId: job.id,
        providerId: walkerId,
        reason: 'missing_source_transaction',
      })
      return 'failed' as const
    }
    transferParams.source_transaction = sourceTransactionUsed

    const transfer = await stripe.transfers.create(transferParams)

    console.log('[transfer] Created:', transfer.id, 'for job', job.id, 'amount', stripeTransferAmountUsed, transferCurrencyUsed)
    console.log('[payout-transfer] create transfer succeeded', {
      jobId: job.id,
      providerId: walkerId,
      stripeTransferId: transfer.id,
      amount: stripeTransferAmountUsed,
      currency: transferCurrencyUsed,
    })

    await supabaseAdmin
      .from('walker_payouts')
      .update({
        stripe_transfer_id: transfer.id,
        status: 'transferred',
        currency: transferCurrencyUsed,
        ...accountingFields,
        failure_reason: null,
        updated_at: new Date().toISOString(),
      })
      .eq('job_id', job.id)
    console.log('[payout-transfer] walker_payouts upserted', {
      jobId: job.id,
      providerId: walkerId,
      mode: 'finalize',
      status: 'transferred',
      stripeTransferId: transfer.id,
    })
    return 'created' as const
  } catch (stripeErr: unknown) {
    console.error('[transfer] Stripe transfer failed for job', job.id, ':', stripeErr)

    const errMsg = stripeErr instanceof Error ? stripeErr.message : 'Unknown error'
    const nextRetryAt = new Date(Date.now() + 5 * 60 * 1000).toISOString()

    await supabaseAdmin
      .from('walker_payouts')
      .update({
        status: 'failed',
        failure_reason: errMsg,
        next_retry_at: nextRetryAt,
        updated_at: new Date().toISOString(),
      })
      .eq('job_id', job.id)
    console.log('[payout-transfer] skipped reason', {
      jobId: job.id,
      providerId: walkerId,
      reason: 'stripe_transfer_failed',
      error: errMsg,
    })
    return 'failed' as const
  }
}
