import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import Stripe from 'https://esm.sh/stripe@17.5.0?target=denonext'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

    if (!stripeKey || !supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
      console.error('[capture-payment] Missing env vars')
      return new Response(
        JSON.stringify({ error: 'Server misconfigured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Missing authorization' }),
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
        JSON.stringify({ error: 'Invalid token' }),
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
        JSON.stringify({ error: 'Only walkers can capture payments' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Parse body
    let body: { jobId?: string }
    try {
      body = await req.json()
    } catch {
      return new Response(
        JSON.stringify({ error: 'Invalid request body' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const { jobId } = body
    if (!jobId) {
      return new Response(
        JSON.stringify({ error: 'Missing jobId' }),
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
        JSON.stringify({ error: 'Job not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log('[capture-payment] Job loaded:', {
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
        JSON.stringify({ error: 'Only the assigned walker can complete this job' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Idempotent: if job is already completed + paid, ensure wallet is credited and return success
    if (job.status === 'completed' && job.payment_status === 'paid') {
      console.log('[capture-payment] Job already completed and paid, ensuring wallet credit')
      const earnings = job.walker_amount ?? job.walker_earnings ?? (job.price != null ? Math.round(job.price * 0.8 * 100) / 100 : 0)
      if (earnings > 0) {
        await supabaseAdmin.rpc('credit_walker_wallet', {
          p_walker_id: job.walker_id,
          p_job_id: job.id,
          p_amount: earnings,
          p_description: `Walk completed: ${job.dog_name || 'walk'}`,
        }).catch((err: unknown) => console.error('[capture-payment] Wallet credit on idempotent path failed:', err))
      }
      // Also try transfer on idempotent path
      await tryCreateTransfer(supabaseAdmin, stripeKey, job).catch((err: unknown) =>
        console.error('[capture-payment] Transfer on idempotent path failed:', err)
      )
      return new Response(
        JSON.stringify({ success: true, jobId: job.id, paymentStatus: 'paid', alreadyCompleted: true }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Verify job state
    if (job.status !== 'accepted') {
      return new Response(
        JSON.stringify({ error: `Job cannot be completed: current status is "${job.status}"` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (job.payment_status !== 'authorized') {
      return new Response(
        JSON.stringify({ error: `Payment cannot be captured: current payment status is "${job.payment_status}"` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!job.stripe_payment_intent_id) {
      return new Response(
        JSON.stringify({ error: 'No PaymentIntent found for this job' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Capture the PaymentIntent
    const stripe = new Stripe(stripeKey, { apiVersion: '2024-12-18.acacia' })

    console.log('[capture-payment] Capturing PaymentIntent:', job.stripe_payment_intent_id)

    let capturedIntent: Stripe.PaymentIntent
    try {
      capturedIntent = await stripe.paymentIntents.capture(job.stripe_payment_intent_id)
    } catch (stripeErr: unknown) {
      console.error('[capture-payment] Stripe capture failed:', stripeErr)

      // Handle "already captured" gracefully
      const stripeError = stripeErr as { type?: string; code?: string; message?: string }
      if (stripeError.code === 'payment_intent_unexpected_state') {
        try {
          const existingPi = await stripe.paymentIntents.retrieve(job.stripe_payment_intent_id)
          if (existingPi.status === 'succeeded') {
            console.log('[capture-payment] PaymentIntent already succeeded, updating DB')
            const now = new Date().toISOString()
            await supabaseAdmin
              .from('walk_requests')
              .update({ status: 'completed', payment_status: 'paid', paid_at: now })
              .eq('id', jobId)
            // Try transfer
            await tryCreateTransfer(supabaseAdmin, stripeKey, job).catch((err: unknown) =>
              console.error('[capture-payment] Transfer after already-captured failed:', err)
            )
            return new Response(
              JSON.stringify({ success: true, jobId: job.id, paymentStatus: 'paid', alreadyCaptured: true }),
              { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            )
          }
        } catch (retrieveErr) {
          console.error('[capture-payment] Failed to retrieve PI after unexpected state:', retrieveErr)
        }
      }

      return new Response(
        JSON.stringify({ error: 'Payment capture failed' }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log('[capture-payment] Capture result:', { status: capturedIntent.status, id: capturedIntent.id })

    if (capturedIntent.status !== 'succeeded') {
      return new Response(
        JSON.stringify({ error: `Unexpected capture status: ${capturedIntent.status}` }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Update DB after successful capture
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
      console.error('[capture-payment] DB update after capture failed:', updateError)
      return new Response(
        JSON.stringify({ error: 'Payment captured but failed to update job status' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
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

    console.log('[capture-payment] Success: job', jobId, 'completed and paid')

    return new Response(
      JSON.stringify({
        success: true,
        jobId: job.id,
        paymentStatus: 'paid',
        paidAt: now,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    console.error('[capture-payment] Unhandled error:', err)
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
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
