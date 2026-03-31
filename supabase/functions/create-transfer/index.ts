import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import Stripe from 'https://esm.sh/stripe@17.5.0?target=denonext'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

/**
 * Standalone transfer creation / retry.
 * Called manually (admin retry) or automatically after capture.
 * Idempotent: will not create a duplicate transfer for the same job.
 *
 * Body: { jobId: string }
 */
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

    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    })

    const { data: { user }, error: authError } = await supabaseUser.auth.getUser()
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Invalid token' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey)

    // Only admins or the assigned walker can trigger a transfer
    const { data: callerProfile } = await supabaseAdmin
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single()

    if (!callerProfile || !['walker', 'admin'].includes(callerProfile.role)) {
      return new Response(
        JSON.stringify({ error: 'Not authorized' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

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

    // Load job
    const { data: job, error: jobErr } = await supabaseAdmin
      .from('walk_requests')
      .select('id, walker_id, selected_walker_id, client_id, status, payment_status, stripe_payment_intent_id, dog_name, price, walker_earnings, walker_amount, platform_fee, amount, currency')
      .eq('id', jobId)
      .single()

    if (jobErr || !job) {
      return new Response(
        JSON.stringify({ error: 'Job not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // If caller is walker, must be the assigned walker
    if (callerProfile.role === 'walker' && job.walker_id !== user.id) {
      return new Response(
        JSON.stringify({ error: 'Not the assigned walker' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Job must be completed+paid
    if (job.status !== 'completed' || job.payment_status !== 'paid') {
      return new Response(
        JSON.stringify({ error: `Job must be completed and paid. Current: status=${job.status}, payment=${job.payment_status}` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Check if transfer already exists
    const { data: existing } = await supabaseAdmin
      .from('walker_payouts')
      .select('id, status, stripe_transfer_id')
      .eq('job_id', jobId)
      .maybeSingle()

    if (existing?.stripe_transfer_id && ['transferred', 'in_transit', 'paid_out'].includes(existing.status)) {
      return new Response(
        JSON.stringify({ success: true, transferId: existing.stripe_transfer_id, alreadyExists: true }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (existing?.status === 'processing') {
      return new Response(
        JSON.stringify({ error: 'Transfer is already being processed' }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (existing?.status === 'refunded') {
      return new Response(
        JSON.stringify({ error: 'Cannot transfer for a refunded job' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const walkerId = job.walker_id || job.selected_walker_id
    if (!walkerId) {
      return new Response(
        JSON.stringify({ error: 'No walker assigned to this job' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Get walker's connected account and rollout flag
    const { data: walkerProfile } = await supabaseAdmin
      .from('profiles')
      .select('stripe_connect_account_id, payouts_enabled, live_payouts_enabled')
      .eq('id', walkerId)
      .single()

    if (!walkerProfile?.stripe_connect_account_id) {
      return new Response(
        JSON.stringify({ error: 'Walker has no connected Stripe account' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Rollout guard: reject if walker is not enabled for live payouts
    if (!walkerProfile.live_payouts_enabled) {
      return new Response(
        JSON.stringify({ error: 'Live payouts not yet enabled for this walker' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Calculate amounts
    const netAmount = job.walker_amount ?? job.walker_earnings ?? (job.price != null ? Math.round(job.price * 0.8 * 100) / 100 : 0)
    const grossAmount = job.price ?? (job.amount != null ? job.amount / 100 : 0)
    const platformFee = job.platform_fee ?? Math.round(grossAmount * 0.2 * 100) / 100
    const transferAmountSmallest = Math.round(netAmount * 100)

    if (transferAmountSmallest <= 0) {
      return new Response(
        JSON.stringify({ error: 'Transfer amount is zero' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Get charge ID and real currency directly from Stripe PI
    // CRITICAL: Do NOT use job.currency — it may be wrong (e.g. 'ils' when Stripe charge is 'usd')
    const stripe = new Stripe(stripeKey, { apiVersion: '2024-12-18.acacia' })
    let chargeId: string | undefined
    let transferCurrency = 'usd' // safe default matching production Stripe account currency

    if (job.stripe_payment_intent_id) {
      try {
        const pi = await stripe.paymentIntents.retrieve(job.stripe_payment_intent_id)
        chargeId = pi.latest_charge as string | undefined
        transferCurrency = pi.currency // authoritative currency from Stripe
      } catch (err) {
        console.error('[create-transfer] Failed to get PI — cannot determine currency:', err)
        return new Response(
          JSON.stringify({ error: 'Failed to retrieve payment details from Stripe' }),
          { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
    } else {
      return new Response(
        JSON.stringify({ error: 'Job has no PaymentIntent — cannot determine transfer currency' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Ensure payout record exists with processing lock
    if (!existing) {
      await supabaseAdmin
        .from('walker_payouts')
        .insert({
          walker_id: walkerId,
          job_id: jobId,
          gross_amount: grossAmount,
          platform_fee: platformFee,
          net_amount: netAmount,
          currency: transferCurrency,
          status: 'processing',
        })
        .then(({ error: insErr }) => {
          if (insErr && !insErr.message?.includes('duplicate')) {
            console.error('[create-transfer] Insert payout record failed:', insErr)
          }
        })
    } else {
      await supabaseAdmin
        .from('walker_payouts')
        .update({
          status: 'processing',
          currency: transferCurrency,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
        .in('status', ['pending', 'failed'])
    }

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
        job_id: jobId,
        walker_id: walkerId,
        payment_intent_id: job.stripe_payment_intent_id,
      },
    }

    // source_transaction links transfer to the specific charge.
    // Stripe inherits transfer_group from the charge, so we must NOT set it again.
    if (chargeId) {
      transferParams.source_transaction = chargeId
    } else {
      transferParams.transfer_group = jobId
    }

    const transfer = await stripe.transfers.create(transferParams)

    console.log('[create-transfer] Created:', transfer.id, 'for job', jobId, 'currency', transferCurrency)

    await supabaseAdmin
      .from('walker_payouts')
      .update({
        stripe_transfer_id: transfer.id,
        status: 'transferred',
        currency: transferCurrency,
        failure_reason: null,
        updated_at: new Date().toISOString(),
      })
      .eq('job_id', jobId)

    return new Response(
      JSON.stringify({
        success: true,
        transferId: transfer.id,
        amount: transferAmountSmallest,
        currency: transferCurrency,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    console.error('[create-transfer] Unhandled error:', err)
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
