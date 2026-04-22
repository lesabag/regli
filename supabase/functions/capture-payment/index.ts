import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import Stripe from 'https://esm.sh/stripe@17.5.0?target=denonext'

const FUNCTION_VERSION = 'v3_payment_auth_failure_no_cancel_2026_04_22'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

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

    // Verify caller is a walker
    const { data: callerProfile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single()

    if (profileError || !callerProfile || callerProfile.role !== 'walker') {
      return new Response(
        JSON.stringify({ error: 'Only walkers can capture payments', _v: FUNCTION_VERSION }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Parse body
    let body: { jobId?: string }
    try {
      body = await req.json()
    } catch {
      return new Response(
        JSON.stringify({ error: 'Invalid request body', _v: FUNCTION_VERSION }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const { jobId } = body
    if (!jobId) {
      return new Response(
        JSON.stringify({ error: 'Missing jobId', _v: FUNCTION_VERSION }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Load the job
    const { data: job, error: jobError } = await supabaseAdmin
      .from('walk_requests')
      .select('id, walker_id, selected_walker_id, client_id, status, payment_status, stripe_payment_intent_id, dog_name, price, walker_earnings, walker_amount, platform_fee, amount, currency')
      .eq('id', jobId)
      .single()

    if (jobError || !job) {
      console.error('[capture-payment] Job lookup failed:', jobError?.message, 'jobId:', jobId)
      return new Response(
        JSON.stringify({ error: 'Job not found', _v: FUNCTION_VERSION }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log(`[capture-payment][${FUNCTION_VERSION}] Job loaded:`, {
      id: job.id,
      walker_id: job.walker_id,
      status: job.status,
      payment_status: job.payment_status,
      stripe_payment_intent_id: job.stripe_payment_intent_id,
    })

    // Verify caller is the assigned walker
    if (job.walker_id !== user.id) {
      console.warn('[capture-payment] Walker mismatch:', { caller: user.id, walker_id: job.walker_id })
      return new Response(
        JSON.stringify({ error: 'Only the assigned walker can complete this job', _v: FUNCTION_VERSION }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── Idempotent: already completed + paid ────────────────────
    if (job.status === 'completed' && job.payment_status === 'paid') {
      console.log(`[capture-payment][${FUNCTION_VERSION}] Job already completed and paid, ensuring wallet credit`)
      const earnings = job.walker_amount ?? job.walker_earnings ?? (job.price != null ? Math.round(job.price * 0.8 * 100) / 100 : 0)
      if (earnings > 0) {
        await supabaseAdmin.rpc('credit_walker_wallet', {
          p_walker_id: job.walker_id,
          p_job_id: job.id,
          p_amount: earnings,
          p_description: `Walk completed: ${job.dog_name || 'walk'}`,
        }).catch((err: unknown) => console.error('[capture-payment] Wallet credit on idempotent path failed:', err))
      }
      await tryCreateTransfer(supabaseAdmin, stripeKey, job).catch((err: unknown) =>
        console.error('[capture-payment] Transfer on idempotent path failed:', err)
      )
      return new Response(
        JSON.stringify({ success: true, jobId: job.id, paymentStatus: 'paid', alreadyCompleted: true, _v: FUNCTION_VERSION }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── Validate job is in a completable state ──────────────────
    // Allow both 'accepted' (normal) and 'completed' (race: status updated but payment not yet captured)
    if (job.status !== 'accepted' && job.status !== 'completed') {
      return new Response(
        JSON.stringify({
          error: `Job cannot be completed: current status is "${job.status}"`,
          details: `Expected status 'accepted' or 'completed', got '${job.status}'`,
          _v: FUNCTION_VERSION,
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // If there's no PaymentIntent, just mark as completed (free walk / test)
    if (!job.stripe_payment_intent_id) {
      console.log(`[capture-payment][${FUNCTION_VERSION}] No PaymentIntent — marking completed without capture`)
      const now = new Date().toISOString()
      await supabaseAdmin
        .from('walk_requests')
        .update({ status: 'completed', payment_status: 'paid', paid_at: now })
        .eq('id', jobId)
      return new Response(
        JSON.stringify({ success: true, jobId: job.id, paymentStatus: 'paid', noPayment: true, _v: FUNCTION_VERSION }),
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
      // Payment already captured (by a previous attempt or webhook) — reconcile DB
      console.log(`[capture-payment][${FUNCTION_VERSION}] PI already succeeded — reconciling DB`)
      const now = new Date().toISOString()
      await supabaseAdmin
        .from('walk_requests')
        .update({ status: 'completed', payment_status: 'paid', paid_at: now })
        .eq('id', jobId)

      const earnings = job.walker_amount ?? job.walker_earnings ?? (job.price != null ? Math.round(job.price * 0.8 * 100) / 100 : 0)
      if (earnings > 0) {
        await supabaseAdmin.rpc('credit_walker_wallet', {
          p_walker_id: job.walker_id,
          p_job_id: job.id,
          p_amount: earnings,
          p_description: `Walk completed: ${job.dog_name || 'walk'}`,
        }).catch((err: unknown) => console.error('[capture-payment] Wallet credit failed:', err))
      }

      await tryCreateTransfer(supabaseAdmin, stripeKey, job).catch((err: unknown) =>
        console.error('[capture-payment] Transfer failed:', err)
      )

      return new Response(
        JSON.stringify({ success: true, jobId: job.id, paymentStatus: 'paid', alreadyCaptured: true, _v: FUNCTION_VERSION }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (pi.status === 'canceled') {
      console.warn(`[capture-payment][${FUNCTION_VERSION}] PI is canceled — cannot capture`)
      await supabaseAdmin
        .from('walk_requests')
        .update({ status: 'completed', payment_status: 'failed' })
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

    let capturedIntent: Stripe.PaymentIntent
    try {
      capturedIntent = await stripe.paymentIntents.capture(job.stripe_payment_intent_id)
    } catch (stripeErr: unknown) {
      console.error(`[capture-payment][${FUNCTION_VERSION}] Stripe capture failed:`, stripeErr)

      const stripeError = stripeErr as { type?: string; code?: string; message?: string }

      // If capture failed with "unexpected state", re-check PI — it may have been captured
      // between our retrieve and capture calls (race condition)
      if (stripeError.code === 'payment_intent_unexpected_state') {
        try {
          const freshPi = await stripe.paymentIntents.retrieve(job.stripe_payment_intent_id)
          if (freshPi.status === 'succeeded') {
            console.log(`[capture-payment][${FUNCTION_VERSION}] PI succeeded between retrieve and capture — reconciling`)
            const now = new Date().toISOString()
            await supabaseAdmin
              .from('walk_requests')
              .update({ status: 'completed', payment_status: 'paid', paid_at: now })
              .eq('id', jobId)

            const earnings = job.walker_amount ?? job.walker_earnings ?? (job.price != null ? Math.round(job.price * 0.8 * 100) / 100 : 0)
            if (earnings > 0) {
              await supabaseAdmin.rpc('credit_walker_wallet', {
                p_walker_id: job.walker_id,
                p_job_id: job.id,
                p_amount: earnings,
                p_description: `Walk completed: ${job.dog_name || 'walk'}`,
              }).catch((err: unknown) => console.error('[capture-payment] Wallet credit failed:', err))
            }

            await tryCreateTransfer(supabaseAdmin, stripeKey, job).catch((err: unknown) =>
              console.error('[capture-payment] Transfer failed:', err)
            )

            return new Response(
              JSON.stringify({ success: true, jobId: job.id, paymentStatus: 'paid', alreadyCaptured: true, _v: FUNCTION_VERSION }),
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

    if (capturedIntent.status !== 'succeeded') {
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
      })
      .eq('id', jobId)

    if (updateError) {
      // Payment IS captured in Stripe — log hard but still return success
      // so the frontend knows the walk is done. DB will reconcile on next read.
      console.error(`[capture-payment][${FUNCTION_VERSION}] DB update after capture failed:`, updateError)
    }

    // Credit walker wallet (idempotent)
    const walkerEarnings = job.walker_amount ?? job.walker_earnings ?? (job.price != null ? Math.round(job.price * 0.8 * 100) / 100 : 0)
    if (walkerEarnings > 0) {
      const { error: walletErr } = await supabaseAdmin.rpc('credit_walker_wallet', {
        p_walker_id: job.walker_id,
        p_job_id: job.id,
        p_amount: walkerEarnings,
        p_description: `Walk completed: ${job.dog_name || 'walk'}`,
      })
      if (walletErr) {
        console.error('[capture-payment] Wallet credit failed (non-blocking):', walletErr)
      } else {
        console.log('[capture-payment] Wallet credited:', walkerEarnings, 'for walker', job.walker_id)
      }
    }

    // Create Stripe Transfer to walker (non-blocking — payment is already captured)
    await tryCreateTransfer(supabaseAdmin, stripeKey, job).catch((err: unknown) =>
      console.error('[capture-payment] Transfer creation failed (non-blocking):', err)
    )

    console.log(`[capture-payment][${FUNCTION_VERSION}] Success: job`, jobId, 'completed and paid')

    return new Response(
      JSON.stringify({
        success: true,
        jobId: job.id,
        paymentStatus: 'paid',
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
}

async function tryCreateTransfer(
  supabaseAdmin: ReturnType<typeof createClient>,
  stripeKey: string,
  job: JobRow
) {
  const walkerId = job.walker_id || job.selected_walker_id
  if (!walkerId) {
    console.warn('[transfer] No walker_id for job', job.id)
    return
  }

  // Check if transfer already exists (idempotent)
  const { data: existing } = await supabaseAdmin
    .from('walker_payouts')
    .select('id, status, stripe_transfer_id')
    .eq('job_id', job.id)
    .maybeSingle()

  if (existing?.stripe_transfer_id) {
    console.log('[transfer] Transfer already exists for job', job.id, ':', existing.stripe_transfer_id)
    return
  }

  // Skip if already processing (race condition guard)
  if (existing?.status === 'processing') {
    console.log('[transfer] Transfer already processing for job', job.id)
    return
  }

  // Get walker's connected account and rollout flag
  const { data: walkerProfile } = await supabaseAdmin
    .from('profiles')
    .select('stripe_connect_account_id, payouts_enabled, live_payouts_enabled')
    .eq('id', walkerId)
    .single()

  if (!walkerProfile?.stripe_connect_account_id) {
    console.warn('[transfer] Walker has no connected account, skipping transfer for job', job.id)
    return
  }

  // Rollout guard: skip transfer if walker is not enabled for live payouts
  if (!walkerProfile.live_payouts_enabled) {
    console.log('[transfer] Walker not enabled for live payouts, skipping transfer for job', job.id, 'walker', walkerId)
    return
  }

  // Calculate amounts
  const netAmount = job.walker_amount ?? job.walker_earnings ?? (job.price != null ? Math.round(job.price * 0.8 * 100) / 100 : 0)
  const grossAmount = job.price ?? (job.amount != null ? job.amount / 100 : 0)
  const platformFee = job.platform_fee ?? Math.round(grossAmount * 0.2 * 100) / 100

  if (netAmount <= 0) {
    console.warn('[transfer] Net amount is 0, skipping transfer for job', job.id)
    return
  }

  // Convert to smallest unit (cents/agorot) for Stripe
  const transferAmountSmallest = Math.round(netAmount * 100)

  // Get charge ID and real currency directly from the PaymentIntent
  // CRITICAL: Do NOT use job.currency — it may be wrong (e.g. 'ils' when Stripe charge is 'usd')
  const stripe = new Stripe(stripeKey, { apiVersion: '2024-12-18.acacia' })

  let chargeId: string | undefined
  let transferCurrency = 'usd' // safe default matching production Stripe account currency

  if (job.stripe_payment_intent_id) {
    try {
      const pi = await stripe.paymentIntents.retrieve(job.stripe_payment_intent_id)
      chargeId = pi.latest_charge as string | undefined
      transferCurrency = pi.currency // authoritative currency from Stripe

      console.log('[transfer] PI retrieved:', {
        jobId: job.id,
        piId: pi.id,
        piCurrency: pi.currency,
        chargeId: chargeId || 'none',
        jobCurrency: job.currency,
      })
    } catch (err) {
      console.error('[transfer] Failed to retrieve PI:', err)
      console.error('[transfer] ABORTING transfer — cannot determine currency without PI')
      return
    }
  } else {
    console.error('[transfer] No stripe_payment_intent_id on job', job.id, '— cannot determine currency')
    return
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
        currency: transferCurrency,
        status: 'processing',
      })

    if (insertErr) {
      if (!insertErr.message?.includes('duplicate')) {
        console.error('[transfer] Failed to insert walker_payouts:', insertErr)
        return
      }
    }
  } else {
    const { error: lockErr } = await supabaseAdmin
      .from('walker_payouts')
      .update({
        status: 'processing',
        currency: transferCurrency,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
      .in('status', ['pending', 'failed'])

    if (lockErr) {
      console.warn('[transfer] Failed to acquire processing lock for job', job.id)
      return
    }
  }

  // Create the Stripe Transfer
  try {
    console.log('[FINAL TRANSFER CALL]', {
      transferCurrency,
      jobCurrency: job.currency,
      amount: transferAmountSmallest,
      chargeId: chargeId || 'none',
      destination: walkerProfile.stripe_connect_account_id,
      hasSourceTransaction: !!chargeId,
    })

    const transferParams: Stripe.TransferCreateParams = {
      amount: transferAmountSmallest,
      currency: transferCurrency,
      destination: walkerProfile.stripe_connect_account_id,
      metadata: {
        job_id: job.id,
        walker_id: walkerId,
        payment_intent_id: job.stripe_payment_intent_id,
      },
    }

    // source_transaction links transfer to the specific charge.
    // Stripe inherits transfer_group from the charge, so we must NOT set it again.
    if (chargeId) {
      transferParams.source_transaction = chargeId
    } else {
      transferParams.transfer_group = job.id
    }

    const transfer = await stripe.transfers.create(transferParams)

    console.log('[transfer] Created:', transfer.id, 'for job', job.id, 'amount', transferAmountSmallest, transferCurrency)

    await supabaseAdmin
      .from('walker_payouts')
      .update({
        stripe_transfer_id: transfer.id,
        status: 'transferred',
        currency: transferCurrency,
        failure_reason: null,
        updated_at: new Date().toISOString(),
      })
      .eq('job_id', job.id)
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
  }
}
