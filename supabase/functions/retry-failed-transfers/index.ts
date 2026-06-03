import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import Stripe from 'https://esm.sh/stripe@17.5.0?target=denonext'

function normalizeCurrency(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return /^[a-z]{3}$/.test(normalized) ? normalized : null
}

/**
 * Retry failed transfers with exponential backoff.
 * Intended to be called via cron (e.g. every 5 minutes) or manually by admin.
 *
 * Picks up walker_payouts where:
 *   status = 'failed', retry_count < 5, next_retry_at <= now()
 *
 * For each, attempts to re-create the Stripe transfer.
 * Max 5 retries with exponential backoff: 5m, 15m, 60m, 4h, 24h.
 */
serve(async (req: Request) => {
  // Allow both POST (cron) and GET (manual trigger)
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      },
    })
  }

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')

  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey || !stripeKey) {
    return new Response(
      JSON.stringify({ error: 'Server misconfigured' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // Auth: allow service_role key (cron) or admin user
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return new Response(
      JSON.stringify({ error: 'Missing authorization' }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  const token = authHeader.replace('Bearer ', '')
  const isCron = token === serviceRoleKey

  if (!isCron) {
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

    const supabaseAdminAuth = createClient(supabaseUrl, serviceRoleKey)
    const { data: callerProfile } = await supabaseAdminAuth
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single()

    if (!callerProfile || callerProfile.role !== 'admin') {
      return new Response(
        JSON.stringify({ error: 'Admin only' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey)
  const stripe = new Stripe(stripeKey, { apiVersion: '2024-12-18.acacia' })

  // Find retryable payouts
  const { data: retryable, error: queryErr } = await supabaseAdmin
    .from('walker_payouts')
    .select('id, walker_id, job_id, net_amount, currency, retry_count, failure_reason')
    .eq('status', 'failed')
    .lt('retry_count', 5)
    .lte('next_retry_at', new Date().toISOString())
    .order('next_retry_at', { ascending: true })
    .limit(10) // Process max 10 per invocation

  if (queryErr) {
    console.error('[retry-failed-transfers] Query failed:', queryErr)
    return new Response(
      JSON.stringify({ error: 'Failed to query retryable payouts' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }

  if (!retryable || retryable.length === 0) {
    return new Response(
      JSON.stringify({ retried: 0, message: 'No retryable payouts found' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  }

  const results: { job_id: string; success: boolean; error?: string }[] = []

  for (const payout of retryable) {
    try {
      // Lock: set to processing
      const { error: lockErr } = await supabaseAdmin
        .from('walker_payouts')
        .update({ status: 'processing', updated_at: new Date().toISOString() })
        .eq('id', payout.id)
        .eq('status', 'failed') // Optimistic lock

      if (lockErr) {
        results.push({ job_id: payout.job_id, success: false, error: 'Lock failed' })
        continue
      }

      // Load job for transfer details
      const { data: job } = await supabaseAdmin
        .from('walk_requests')
        .select('id, status, payment_status, stripe_payment_intent_id, currency')
        .eq('id', payout.job_id)
        .single()

      if (!job || job.status !== 'completed' || job.payment_status !== 'paid') {
        await supabaseAdmin
          .from('walker_payouts')
          .update({
            status: 'failed',
            failure_reason: 'Job not in completed+paid state',
            retry_count: payout.retry_count + 1,
            next_retry_at: null, // No more retries for invalid jobs
            updated_at: new Date().toISOString(),
          })
          .eq('id', payout.id)
        results.push({ job_id: payout.job_id, success: false, error: 'Job state invalid' })
        continue
      }

      // Get walker's connected account and Stripe payout readiness flags
      const { data: walkerProfile } = await supabaseAdmin
        .from('profiles')
        .select('stripe_connect_account_id, payouts_enabled, charges_enabled')
        .eq('id', payout.walker_id)
        .single()

      if (!walkerProfile?.stripe_connect_account_id) {
        await supabaseAdmin
          .from('walker_payouts')
          .update({
            status: 'failed',
            failure_reason: 'Walker has no connected Stripe account',
            retry_count: payout.retry_count + 1,
            next_retry_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', payout.id)
        results.push({ job_id: payout.job_id, success: false, error: 'No connected account' })
        continue
      }

      if (!walkerProfile.payouts_enabled || !walkerProfile.charges_enabled) {
        await supabaseAdmin
          .from('walker_payouts')
          .update({
            status: 'failed',
            failure_reason: 'Walker Stripe Connect account is not payout-ready',
            updated_at: new Date().toISOString(),
          })
          .eq('id', payout.id)
        results.push({ job_id: payout.job_id, success: false, error: 'Walker Stripe Connect not payout-ready' })
        continue
      }

      // Get charge ID and real currency directly from Stripe PI
      // CRITICAL: Do NOT use payout.currency or job.currency — may be wrong
      let chargeId: string | undefined
      let transferCurrency: string | null = normalizeCurrency(job.currency) ?? normalizeCurrency(payout.currency)

      if (job.stripe_payment_intent_id) {
        try {
          const pi = await stripe.paymentIntents.retrieve(job.stripe_payment_intent_id)
          chargeId = pi.latest_charge as string | undefined
          transferCurrency = pi.currency // authoritative currency from Stripe
          const normalizedJobCurrency = normalizeCurrency(job.currency)
          if (normalizedJobCurrency && normalizedJobCurrency !== pi.currency) {
            console.error('[retry] CURRENCY MISMATCH detected:', {
              jobId: payout.job_id,
              jobCurrency: normalizedJobCurrency,
              payoutCurrency: payout.currency,
              stripeCurrency: pi.currency,
              paymentIntentId: pi.id,
            })
          }
        } catch (err) {
          console.error(`[retry] Failed to get PI for job ${payout.job_id}:`, err)
          // Revert to failed — cannot determine currency without PI
          await supabaseAdmin
            .from('walker_payouts')
            .update({
              status: 'failed',
              failure_reason: 'Failed to retrieve PaymentIntent from Stripe',
              updated_at: new Date().toISOString(),
            })
            .eq('id', payout.id)
          results.push({ job_id: payout.job_id, success: false, error: 'PI retrieval failed' })
          continue
        }
      } else {
        await supabaseAdmin
          .from('walker_payouts')
          .update({
            status: 'failed',
            failure_reason: 'Job has no PaymentIntent — cannot determine transfer currency',
            retry_count: payout.retry_count + 1,
            next_retry_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', payout.id)
        results.push({ job_id: payout.job_id, success: false, error: 'No PI on job' })
        continue
      }

      if (!transferCurrency) {
        await supabaseAdmin
          .from('walker_payouts')
          .update({
            status: 'failed',
            failure_reason: 'Job has no currency — cannot determine transfer currency',
            retry_count: payout.retry_count + 1,
            next_retry_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', payout.id)
        results.push({ job_id: payout.job_id, success: false, error: 'No currency on job' })
        continue
      }

      const transferAmountSmallest = Math.round(payout.net_amount * 100)

      console.log('[FINAL TRANSFER CALL]', {
        transferCurrency,
        jobCurrency: job.currency,
        payoutCurrency: payout.currency,
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
          job_id: payout.job_id,
          walker_id: payout.walker_id,
          retry_count: String(payout.retry_count + 1),
          payment_intent_id: job.stripe_payment_intent_id,
        },
      }

      // source_transaction links transfer to the specific charge.
      // Stripe inherits transfer_group from the charge, so we must NOT set it again.
      if (chargeId) {
        transferParams.source_transaction = chargeId
      } else {
        transferParams.transfer_group = payout.job_id
      }

      const transfer = await stripe.transfers.create(transferParams)

      // Success — update payout with correct currency
      await supabaseAdmin
        .from('walker_payouts')
        .update({
          stripe_transfer_id: transfer.id,
          status: 'transferred',
          currency: transferCurrency,
          failure_reason: null,
          retry_count: payout.retry_count + 1,
          next_retry_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', payout.id)

      console.log(`[retry] Transfer ${transfer.id} created for job ${payout.job_id} (retry #${payout.retry_count + 1}) currency ${transferCurrency}`)
      results.push({ job_id: payout.job_id, success: true })
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error'
      console.error(`[retry] Failed for job ${payout.job_id}:`, errMsg)

      const newRetryCount = payout.retry_count + 1
      // Exponential backoff: 5m, 15m, 60m, 4h, 24h
      const backoffMinutes = [5, 15, 60, 240, 1440]
      const nextRetryAt = newRetryCount < 5
        ? new Date(Date.now() + (backoffMinutes[newRetryCount] ?? 1440) * 60 * 1000).toISOString()
        : null

      await supabaseAdmin
        .from('walker_payouts')
        .update({
          status: 'failed',
          failure_reason: errMsg,
          retry_count: newRetryCount,
          next_retry_at: nextRetryAt,
          updated_at: new Date().toISOString(),
        })
        .eq('id', payout.id)

      // Notify admin on final failure
      if (newRetryCount >= 5) {
        await supabaseAdmin
          .from('notifications')
          .insert({
            user_id: payout.walker_id,
            type: 'transfer_failed_final',
            title: 'Payout Failed',
            message: `Your payout of ${payout.net_amount} failed after multiple attempts. Our team has been notified.`,
            related_job_id: payout.job_id,
          })
          .then(({ error }) => {
            if (error) console.error('[retry] Failed to notify walker:', error)
          })
      }

      results.push({ job_id: payout.job_id, success: false, error: errMsg })
    }
  }

  const succeeded = results.filter((r) => r.success).length
  const failed = results.filter((r) => !r.success).length

  console.log(`[retry-failed-transfers] Done: ${succeeded} succeeded, ${failed} failed out of ${results.length}`)

  return new Response(
    JSON.stringify({ retried: results.length, succeeded, failed, results }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
})
