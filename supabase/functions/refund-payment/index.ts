import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import Stripe from 'https://esm.sh/stripe@17.5.0?target=denonext'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

type SupabaseAdmin = ReturnType<typeof createClient>

function normalizeCurrency(value: string | null | undefined): string {
  if (typeof value !== 'string') return 'ils'
  const normalized = value.trim().toLowerCase()
  return /^[a-z]{3}$/.test(normalized) ? normalized : 'ils'
}

function toMajor(amountMinor: number): number {
  return Math.round((amountMinor / 100) * 100) / 100
}

function toMinor(amountMajor: number): number {
  return Math.max(0, Math.round(amountMajor * 100))
}

function roundMajor(value: number): number {
  return Math.round(value * 100) / 100
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

async function upsertWalletTransaction(
  supabaseAdmin: SupabaseAdmin,
  params: {
    walkerId: string
    jobId: string
    type: 'refund' | 'transfer_reversal'
    amount: number
    currency: string
    status: 'partial' | 'succeeded' | 'failed'
    description: string
  },
) {
  const { data: existing, error: existingError } = await supabaseAdmin
    .from('wallet_transactions')
    .select('id')
    .eq('walker_id', params.walkerId)
    .eq('job_id', params.jobId)
    .eq('type', params.type)
    .maybeSingle()

  if (existingError) {
    console.error('[Refund] wallet transaction lookup failed', { jobId: params.jobId, type: params.type, error: existingError.message })
    throw existingError
  }

  if (existing?.id) {
    const { error } = await supabaseAdmin
      .from('wallet_transactions')
      .update({
        amount: params.amount,
        currency: params.currency,
        status: params.status,
        description: params.description,
      })
      .eq('id', existing.id)

    if (error) {
      console.error('[Refund] wallet transaction update failed', { jobId: params.jobId, type: params.type, error: error.message })
      throw error
    }
    return
  }

  const { error } = await supabaseAdmin
    .from('wallet_transactions')
    .insert({
      walker_id: params.walkerId,
      job_id: params.jobId,
      type: params.type,
      status: params.status,
      amount: params.amount,
      currency: params.currency,
      description: params.description,
    })

  if (error && error.code !== '23505') {
    console.error('[Refund] wallet transaction insert failed', { jobId: params.jobId, type: params.type, error: error.message })
    throw error
  }
}

async function upsertBalanceAdjustment(
  supabaseAdmin: SupabaseAdmin,
  params: {
    walkerId: string
    jobId: string
    amount: number
    description: string
  },
) {
  const { data: existing, error: existingError } = await supabaseAdmin
    .from('walker_balance_adjustments')
    .select('id')
    .eq('walker_id', params.walkerId)
    .eq('job_id', params.jobId)
    .eq('type', 'refund_debit')
    .maybeSingle()

  if (existingError) {
    console.error('[Refund] balance adjustment lookup failed', { jobId: params.jobId, error: existingError.message })
    throw existingError
  }

  if (existing?.id) {
    const { error } = await supabaseAdmin
      .from('walker_balance_adjustments')
      .update({
        amount: params.amount,
        description: params.description,
      })
      .eq('id', existing.id)

    if (error) {
      console.error('[Refund] balance adjustment update failed', { jobId: params.jobId, error: error.message })
      throw error
    }
    return
  }

  const { error } = await supabaseAdmin
    .from('walker_balance_adjustments')
    .insert({
      walker_id: params.walkerId,
      job_id: params.jobId,
      type: 'refund_debit',
      amount: params.amount,
      description: params.description,
    })

  if (error && error.code !== '23505') {
    console.error('[Refund] balance adjustment insert failed', { jobId: params.jobId, error: error.message })
    throw error
  }
}

async function upsertNotification(
  supabaseAdmin: SupabaseAdmin,
  params: {
    userId: string | null | undefined
    type: string
    title: string
    message: string
    relatedJobId: string
  },
) {
  if (!params.userId) return

  const { data: existing, error: existingError } = await supabaseAdmin
    .from('notifications')
    .select('id')
    .eq('user_id', params.userId)
    .eq('type', params.type)
    .eq('related_job_id', params.relatedJobId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (existingError) {
    console.error('[Refund] notification lookup failed', {
      userId: params.userId,
      type: params.type,
      relatedJobId: params.relatedJobId,
      error: existingError.message,
    })
    return
  }

  if (existing?.id) {
    const { error } = await supabaseAdmin
      .from('notifications')
      .update({
        title: params.title,
        message: params.message,
      })
      .eq('id', existing.id)

    if (error) {
      console.error('[Refund] notification update failed', {
        userId: params.userId,
        type: params.type,
        relatedJobId: params.relatedJobId,
        error: error.message,
      })
    }
    return
  }

  const { error } = await supabaseAdmin
    .from('notifications')
    .insert({
      user_id: params.userId,
      type: params.type,
      title: params.title,
      message: params.message,
      related_job_id: params.relatedJobId,
    })

  if (error) {
    console.error('[Refund] notification insert failed', {
      userId: params.userId,
      type: params.type,
      relatedJobId: params.relatedJobId,
      error: error.message,
    })
  }
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
      return new Response(
        JSON.stringify({ error: 'Server misconfigured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Missing authorization' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    })

    const {
      data: { user },
      error: authError,
    } = await supabaseUser.auth.getUser()

    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Invalid token' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey)
    const { data: callerProfile } = await supabaseAdmin
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single()

    if (!callerProfile || callerProfile.role !== 'admin') {
      return new Response(
        JSON.stringify({ error: 'Admin only' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    let body: { jobId?: string; amount?: number | string | null }
    try {
      body = await req.json()
    } catch {
      return new Response(
        JSON.stringify({ error: 'Invalid request body' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const jobId = typeof body.jobId === 'string' ? body.jobId.trim() : ''
    if (!jobId) {
      return new Response(
        JSON.stringify({ error: 'Missing jobId' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const requestedAmountMajor =
      typeof body.amount === 'number'
        ? body.amount
        : typeof body.amount === 'string' && body.amount.trim()
          ? Number(body.amount)
          : null

    if (requestedAmountMajor != null && (!Number.isFinite(requestedAmountMajor) || requestedAmountMajor <= 0)) {
      return new Response(
        JSON.stringify({ error: 'Invalid refund amount' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const { data: job, error: jobError } = await supabaseAdmin
      .from('walk_requests')
      .select(`
        id,
        client_id,
        walker_id,
        selected_walker_id,
        status,
        payment_status,
        stripe_payment_intent_id,
        dog_name,
        price,
        walker_earnings,
        walker_amount,
        currency,
        refunded_amount,
        refund_currency,
        refunded_at,
        last_stripe_refund_id
      `)
      .eq('id', jobId)
      .maybeSingle()

    if (jobError) {
      return new Response(
        JSON.stringify({ error: 'Job lookup failed', details: jobError.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    if (!job) {
      return new Response(
        JSON.stringify({ error: 'Job not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    if (!job.stripe_payment_intent_id) {
      return new Response(
        JSON.stringify({ error: 'Missing Stripe PaymentIntent on request' }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const stripe = new Stripe(stripeKey, { apiVersion: '2024-12-18.acacia' })
    const pi = await stripe.paymentIntents.retrieve(job.stripe_payment_intent_id, {
      expand: ['latest_charge'],
    })

    const latestCharge =
      typeof pi.latest_charge === 'string'
        ? await stripe.charges.retrieve(pi.latest_charge)
        : pi.latest_charge

    if (!latestCharge) {
      return new Response(
        JSON.stringify({ error: 'Stripe charge not found for refund' }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const capturedAmountMinor = Math.max(
      typeof latestCharge.amount_captured === 'number' ? latestCharge.amount_captured : 0,
      typeof latestCharge.amount === 'number' ? latestCharge.amount : 0,
    )
    const alreadyRefundedMinor = Math.max(0, latestCharge.amount_refunded ?? 0)
    const remainingRefundableMinor = Math.max(0, capturedAmountMinor - alreadyRefundedMinor)
    const currency = normalizeCurrency(latestCharge.currency || pi.currency || job.currency)

    console.log('[Refund]', {
      requestId: jobId,
      action: 'prepare_refund',
      result: 'loaded',
      paymentIntentId: pi.id,
      capturedAmountMinor,
      alreadyRefundedMinor,
      remainingRefundableMinor,
      requestedAmountMajor,
      currency,
    })

    if (capturedAmountMinor <= 0) {
      return new Response(
        JSON.stringify({ error: 'Payment was not captured yet' }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    if (remainingRefundableMinor <= 0) {
      return new Response(
        JSON.stringify({
          success: true,
          alreadyRefunded: true,
          refundStatus: 'already_refunded',
          refundedAmount: toMajor(alreadyRefundedMinor),
          currency,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const desiredRefundMinor =
      requestedAmountMajor == null
        ? remainingRefundableMinor
        : clamp(toMinor(requestedAmountMajor), 1, remainingRefundableMinor)

    const refund = await stripe.refunds.create(
      {
        payment_intent: pi.id,
        amount: desiredRefundMinor,
        metadata: {
          request_id: jobId,
          admin_id: user.id,
          refund_kind: desiredRefundMinor === remainingRefundableMinor ? 'full_or_remaining' : 'partial',
        },
      },
      {
        idempotencyKey: `regli_refund_${jobId}_${alreadyRefundedMinor}_${desiredRefundMinor}`,
      },
    )

    const refreshedCharge = await stripe.charges.retrieve(latestCharge.id)
    const totalRefundedMinor = Math.max(0, refreshedCharge.amount_refunded ?? (alreadyRefundedMinor + desiredRefundMinor))
    const isFullyRefunded = totalRefundedMinor >= capturedAmountMinor
    const refundStatus = isFullyRefunded ? 'refunded' : 'partially_refunded'

    let reversalStatus: 'not_needed' | 'pending' | 'reversed' | 'partial' | 'failed' = 'not_needed'
    let reversalAmountMajor = 0
    let transferId: string | null = null
    let transferReversalId: string | null = null

    const walkerId = job.walker_id || job.selected_walker_id
    const providerNetMajor = roundMajor(
      job.walker_amount ??
        job.walker_earnings ??
        (job.price != null ? Math.round(job.price * 0.8 * 100) / 100 : 0),
    )
    const providerTargetRefundMajor = roundMajor(
      capturedAmountMinor > 0
        ? clamp((providerNetMajor * totalRefundedMinor) / capturedAmountMinor, 0, providerNetMajor)
        : providerNetMajor,
    )

    const { data: payout } = await supabaseAdmin
      .from('walker_payouts')
      .select('id, walker_id, status, net_amount, currency, stripe_transfer_id, reversed_amount, stripe_transfer_reversal_id')
      .eq('job_id', jobId)
      .maybeSingle()

    if (payout?.stripe_transfer_id) {
      transferId = payout.stripe_transfer_id
      try {
        const transfer = await stripe.transfers.retrieve(payout.stripe_transfer_id)
        const transferAmountMinor = Math.max(0, transfer.amount ?? 0)
        const currentReversedMinor = Math.max(
          typeof transfer.amount_reversed === 'number' ? transfer.amount_reversed : 0,
          toMinor(payout.reversed_amount ?? 0),
        )
        const targetReversedMinor =
          capturedAmountMinor > 0
            ? clamp(Math.round((transferAmountMinor * totalRefundedMinor) / capturedAmountMinor), 0, transferAmountMinor)
            : transferAmountMinor
        const reversalDeltaMinor = Math.max(0, targetReversedMinor - currentReversedMinor)

        if (reversalDeltaMinor > 0) {
          const reversal = await stripe.transfers.createReversal(
            payout.stripe_transfer_id,
            {
              amount: reversalDeltaMinor,
              metadata: {
                request_id: jobId,
                refund_id: refund.id,
                payment_intent_id: pi.id,
              },
            },
            {
              idempotencyKey: `regli_transfer_reversal_${jobId}_${currentReversedMinor}_${reversalDeltaMinor}`,
            },
          )

          transferReversalId = reversal.id
          reversalAmountMajor = toMajor(currentReversedMinor + reversalDeltaMinor)
          reversalStatus = currentReversedMinor + reversalDeltaMinor >= transferAmountMinor ? 'reversed' : 'partial'

          console.log('[TransferReversal]', {
            requestId: jobId,
            oldProviderId: walkerId,
            action: 'create_reversal',
            result: reversalStatus,
            transferId: payout.stripe_transfer_id,
            reversalId: reversal.id,
            reversalDeltaMinor,
            targetReversedMinor,
            transferAmountMinor,
          })

          const { error: payoutUpdateError } = await supabaseAdmin
            .from('walker_payouts')
            .update({
              status: currentReversedMinor + reversalDeltaMinor >= transferAmountMinor ? 'reversed' : payout.status,
              reversed_amount: reversalAmountMajor,
              reversed_at: new Date().toISOString(),
              stripe_transfer_reversal_id: reversal.id,
              failure_reason: null,
              updated_at: new Date().toISOString(),
            })
            .eq('id', payout.id)

          if (payoutUpdateError) {
            console.error('[TransferReversal] payout update failed', { requestId: jobId, error: payoutUpdateError.message })
          }
        } else {
          reversalAmountMajor = toMajor(currentReversedMinor)
          reversalStatus = currentReversedMinor >= transferAmountMinor ? 'reversed' : 'partial'
        }

        if (walkerId && reversalAmountMajor > 0) {
          await upsertWalletTransaction(supabaseAdmin, {
            walkerId,
            jobId,
            type: 'transfer_reversal',
            amount: -reversalAmountMajor,
            currency,
            status: reversalStatus === 'reversed' ? 'succeeded' : 'partial',
            description: `Transfer reversal for ${job.dog_name || 'service refund'}`,
          })
        }
      } catch (reversalError) {
        reversalStatus = 'failed'
        console.error('[TransferReversal] failed', {
          requestId: jobId,
          oldProviderId: walkerId,
          action: 'create_reversal',
          result: 'failed',
          transferId: payout.stripe_transfer_id,
          error: reversalError instanceof Error ? reversalError.message : 'Unknown',
        })
      }
    }

    if (walkerId && providerTargetRefundMajor > 0) {
      await upsertBalanceAdjustment(supabaseAdmin, {
        walkerId,
        jobId,
        amount: -providerTargetRefundMajor,
        description: `Refund debit: ${job.dog_name || 'service'} (${refundStatus.replace('_', ' ')})`,
      })

      await upsertWalletTransaction(supabaseAdmin, {
        walkerId,
        jobId,
        type: 'refund',
        amount: -providerTargetRefundMajor,
        currency,
        status: isFullyRefunded ? 'succeeded' : 'partial',
        description: `Customer refund for ${job.dog_name || 'service'}`,
      })
    }

    const { error: jobUpdateError } = await supabaseAdmin
      .from('walk_requests')
      .update({
        payment_status: isFullyRefunded ? 'refunded' : job.payment_status,
        refunded_amount: toMajor(totalRefundedMinor),
        refund_currency: currency,
        refunded_at: new Date().toISOString(),
        last_stripe_refund_id: refund.id,
      })
      .eq('id', jobId)

    if (jobUpdateError) {
      console.error('[Refund] job update failed', { requestId: jobId, error: jobUpdateError.message })
    }

    console.log('[Refund]', {
      requestId: jobId,
      action: 'refund',
      result: refundStatus,
      refundId: refund.id,
      refundAmountMinor: desiredRefundMinor,
      totalRefundedMinor,
      remainingRefundableMinor: Math.max(0, capturedAmountMinor - totalRefundedMinor),
      transferId,
      transferReversalId,
      reversalStatus,
    })

    const clientNotificationTitle = isFullyRefunded ? 'Refund issued' : 'Partial refund issued'
    const clientNotificationMessage = isFullyRefunded
      ? `Your payment of ₪${toMajor(capturedAmountMinor)} was fully refunded.`
      : `₪${toMajor(desiredRefundMinor)} was refunded to your payment method.`

    await upsertNotification(supabaseAdmin, {
      userId: job.client_id,
      type: 'refund_issued',
      title: clientNotificationTitle,
      message: clientNotificationMessage,
      relatedJobId: jobId,
    })

    if (walkerId && providerTargetRefundMajor > 0) {
      const walkerNotificationType = reversalStatus === 'failed' ? 'payout_adjusted' : 'transfer_reversed'
      const walkerNotificationTitle =
        reversalStatus === 'reversed'
          ? 'Transfer reversed'
          : reversalStatus === 'partial'
            ? 'Partial payout reversal'
            : 'Payout adjusted'
      const walkerNotificationMessage =
        reversalStatus === 'reversed'
          ? `Your payout of ₪${providerNetMajor} was fully reversed due to a refund.`
          : reversalStatus === 'partial'
            ? `₪${reversalAmountMajor || providerTargetRefundMajor} was deducted from your payout due to a partial refund.`
            : `₪${providerTargetRefundMajor} was deducted from your payout due to a refund.`

      await upsertNotification(supabaseAdmin, {
        userId: walkerId,
        type: walkerNotificationType,
        title: walkerNotificationTitle,
        message: walkerNotificationMessage,
        relatedJobId: jobId,
      })
    }

    return new Response(
      JSON.stringify({
        success: true,
        jobId,
        refundId: refund.id,
        refundStatus,
        refundedAmount: toMajor(totalRefundedMinor),
        currency,
        transferId,
        transferReversalId,
        reversalStatus,
        reversalAmount: reversalAmountMajor,
        alreadyRefunded: false,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  } catch (err) {
    console.error('[Refund] unhandled error', err)
    return new Response(
      JSON.stringify({
        error: 'Internal server error',
        details: err instanceof Error ? err.message : 'Unknown',
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }
})
