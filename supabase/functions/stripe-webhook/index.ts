import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import Stripe from 'https://esm.sh/stripe@17.5.0?target=denonext'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, stripe-signature',
}

type SupabaseAdmin = ReturnType<typeof createClient>
type LogCtx = { event_id: string; event_type: string }

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
    console.error('[webhook] wallet tx lookup failed', { job_id: params.jobId, type: params.type, error: existingError.message })
    return
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
      console.error('[webhook] wallet tx update failed', { job_id: params.jobId, type: params.type, error: error.message })
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
    console.error('[webhook] wallet tx insert failed', { job_id: params.jobId, type: params.type, error: error.message })
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
    console.error('[webhook] balance adjustment lookup failed', { job_id: params.jobId, error: existingError.message })
    return
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
      console.error('[webhook] balance adjustment update failed', { job_id: params.jobId, error: error.message })
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
    console.error('[webhook] balance adjustment insert failed', { job_id: params.jobId, error: error.message })
  }
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')
  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')

  if (!supabaseUrl || !serviceRoleKey || !stripeKey || !webhookSecret) {
    console.error('stripe-webhook: missing env vars')
    return new Response(
      JSON.stringify({ error: 'Server misconfigured' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }

  // Verify Stripe signature
  const signature = req.headers.get('stripe-signature')
  if (!signature) {
    return new Response(
      JSON.stringify({ error: 'Missing stripe-signature header' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    )
  }

  const body = await req.text()
  const stripe = new Stripe(stripeKey, { apiVersion: '2024-12-18.acacia' })

  let event: Stripe.Event
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('Webhook signature verification failed:', message)
    return new Response(
      JSON.stringify({ error: 'Invalid signature' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    )
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey)

  const logCtx = { event_id: event.id, event_type: event.type }

  // Log event for idempotency and audit
  const { error: logErr } = await supabaseAdmin
    .from('stripe_events')
    .insert({
      stripe_event_id: event.id,
      type: event.type,
      payload: event.data.object as unknown,
    })

  if (logErr) {
    // Duplicate event — already processed
    if (logErr.message?.includes('duplicate') || logErr.code === '23505') {
      console.log('[webhook] Duplicate event, skipping', logCtx)
      return new Response(JSON.stringify({ received: true, duplicate: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    // Non-duplicate insert error — log but continue processing
    console.error('[webhook] Failed to log event:', logCtx, logErr)
  }

  // ─── Handle events ─────────────────────────────────────────

  try {
    switch (event.type) {
      case 'payment_intent.succeeded':
        await handlePaymentIntentSucceeded(supabaseAdmin, event, logCtx)
        break

      case 'payment_intent.amount_capturable_updated':
        await handlePaymentIntentAmountCapturableUpdated(supabaseAdmin, event, logCtx)
        break

      case 'payment_intent.payment_failed':
        await handlePaymentIntentFailed(supabaseAdmin, event, logCtx)
        break

      case 'payment_intent.canceled':
        await handlePaymentIntentCanceled(supabaseAdmin, event, logCtx)
        break

      case 'account.updated':
        await handleAccountUpdated(supabaseAdmin, event, logCtx)
        break

      case 'transfer.created':
        await handleTransferCreated(supabaseAdmin, event, logCtx)
        break

      case 'transfer.reversed':
        await handleTransferReversed(supabaseAdmin, event, logCtx)
        break

      case 'payout.created':
        await handlePayoutCreated(supabaseAdmin, event, logCtx)
        break

      case 'payout.paid':
        await handlePayoutPaid(supabaseAdmin, event, logCtx)
        break

      case 'payout.failed':
        await handlePayoutFailed(supabaseAdmin, event, logCtx)
        break

      case 'charge.refunded':
        await handleChargeRefunded(supabaseAdmin, stripe, event, logCtx)
        break

      default:
        console.log('[webhook] Unhandled event type', logCtx)
    }
  } catch (err) {
    console.error('[webhook] Error processing event:', logCtx, err)
    // Still return 200 to prevent Stripe retries for processing errors
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})

// ─── Payment Intent handlers ────────────────────────────────────

async function handlePaymentIntentAmountCapturableUpdated(supabaseAdmin: SupabaseAdmin, event: Stripe.Event, logCtx: LogCtx) {
  const pi = event.data.object as Stripe.PaymentIntent

  const { data: job, error: findErr } = await supabaseAdmin
    .from('walk_requests')
    .select('id, payment_status')
    .eq('stripe_payment_intent_id', pi.id)
    .single()

  if (findErr || !job) {
    console.warn('[webhook] payment_intent.amount_capturable_updated: no job found', { ...logCtx, pi_id: pi.id })
    return
  }

  const ctx = { ...logCtx, job_id: job.id, pi_id: pi.id }

  if (job.payment_status === 'paid' || job.payment_status === 'refunded') {
    console.log('[webhook] Job terminal, skipping authorization update', { ...ctx, current_status: job.payment_status })
    return
  }

  if (pi.status !== 'requires_capture' || pi.amount_capturable <= 0) {
    console.log('[webhook] PaymentIntent is not capturable, skipping authorization update', {
      ...ctx,
      pi_status: pi.status,
      amount_capturable: pi.amount_capturable,
    })
    return
  }

  const { error: updateErr } = await supabaseAdmin
    .from('walk_requests')
    .update({
      payment_status: 'authorized',
      payment_authorized_at: new Date().toISOString(),
    })
    .eq('id', job.id)

  if (updateErr) {
    console.error('[webhook] Failed to mark job authorized:', ctx, updateErr)
    return
  }

  console.log('[webhook] payment_intent.amount_capturable_updated: job marked authorized', ctx)
}

async function handlePaymentIntentSucceeded(supabaseAdmin: SupabaseAdmin, event: Stripe.Event, logCtx: LogCtx) {
  const pi = event.data.object as Stripe.PaymentIntent

  const { data: job, error: findErr } = await supabaseAdmin
    .from('walk_requests')
    .select('id, payment_status, walker_id, walker_amount, walker_earnings, price, dog_name, currency')
    .eq('stripe_payment_intent_id', pi.id)
    .single()

  if (findErr || !job) {
    console.warn('[webhook] payment_intent.succeeded: no job found', { ...logCtx, pi_id: pi.id })
    return
  }

  const ctx = { ...logCtx, job_id: job.id, pi_id: pi.id }

  // Don't downgrade: if already "paid", just ensure wallet credit
  if (job.payment_status === 'paid') {
    console.log('[webhook] Job already paid, ensuring wallet credit', ctx)
  } else {
    const { error: updateErr } = await supabaseAdmin
      .from('walk_requests')
      .update({
        payment_status: 'paid',
        paid_at: new Date().toISOString(),
      })
      .eq('id', job.id)

    if (updateErr) {
      console.error('[webhook] Failed to update job:', ctx, updateErr)
      return
    }

    console.log('[webhook] payment_intent.succeeded: job marked paid', ctx)
  }

  // Credit walker wallet (idempotent)
  if (job.walker_id) {
    const earnings = job.walker_amount ?? job.walker_earnings ?? (job.price != null ? Math.round(job.price * 0.8 * 100) / 100 : 0)
    if (earnings > 0) {
      const { error: walletErr } = await supabaseAdmin.rpc('credit_walker_wallet', {
        p_walker_id: job.walker_id,
        p_job_id: job.id,
        p_amount: earnings,
        p_currency: pi.currency || job.currency || 'ils',
        p_description: `Walk completed: ${job.dog_name || 'walk'}`,
      })
      if (walletErr) {
        console.error('[webhook] Wallet credit failed:', { ...ctx, walker_id: job.walker_id }, walletErr)
      } else {
        console.log('[webhook] Wallet credited:', { ...ctx, walker_id: job.walker_id, earnings })
      }
    }
  }
}

async function handlePaymentIntentFailed(supabaseAdmin: SupabaseAdmin, event: Stripe.Event, logCtx: LogCtx) {
  const pi = event.data.object as Stripe.PaymentIntent

  const { data: job, error: findErr } = await supabaseAdmin
    .from('walk_requests')
    .select('id, payment_status')
    .eq('stripe_payment_intent_id', pi.id)
    .single()

  if (findErr || !job) {
    console.warn('[webhook] payment_intent.payment_failed: no job found', { ...logCtx, pi_id: pi.id })
    return
  }

  const ctx = { ...logCtx, job_id: job.id, pi_id: pi.id }

  if (job.payment_status === 'paid' || job.payment_status === 'refunded') {
    console.log('[webhook] Job terminal, skipping failure update', { ...ctx, current_status: job.payment_status })
    return
  }

  const { error: updateErr } = await supabaseAdmin
    .from('walk_requests')
    .update({ payment_status: 'failed' })
    .eq('id', job.id)

  if (updateErr) {
    console.error('[webhook] Failed to update job:', ctx, updateErr)
    return
  }

  console.log('[webhook] payment_intent.payment_failed: job marked failed', ctx)
}

async function handlePaymentIntentCanceled(supabaseAdmin: SupabaseAdmin, event: Stripe.Event, logCtx: LogCtx) {
  const pi = event.data.object as Stripe.PaymentIntent

  const { data: job, error: findErr } = await supabaseAdmin
    .from('walk_requests')
    .select('id, payment_status, status, booking_timing, dispatch_state')
    .eq('stripe_payment_intent_id', pi.id)
    .single()

  if (findErr || !job) {
    console.warn('[webhook] payment_intent.canceled: no job found', { ...logCtx, pi_id: pi.id })
    return
  }

  const ctx = { ...logCtx, job_id: job.id, pi_id: pi.id }

  if (job.payment_status === 'paid' || job.payment_status === 'refunded') {
    console.log('[webhook] Job terminal, skipping cancel update', { ...ctx, current_status: job.payment_status })
    return
  }

  if (job.status === 'completed') {
    console.log('[webhook] Job completed, skipping cancel update', ctx)
    return
  }

  if (job.booking_timing === 'scheduled' && job.dispatch_state !== 'dispatched') {
    const { error: updateErr } = await supabaseAdmin
      .from('walk_requests')
      .update({
        payment_status: 'failed',
      })
      .eq('id', job.id)

    if (updateErr) {
      console.error('[webhook] Failed to mark scheduled job payment failed:', ctx, updateErr)
      return
    }

    console.log('[webhook] payment_intent.canceled: scheduled job kept open before dispatch', ctx)
    return
  }

  const { error: updateErr } = await supabaseAdmin
    .from('walk_requests')
    .update({
      payment_status: 'failed',
      status: 'cancelled',
    })
    .eq('id', job.id)

  if (updateErr) {
    console.error('[webhook] Failed to update job:', ctx, updateErr)
    return
  }

  console.log('[webhook] payment_intent.canceled: job marked failed/cancelled', ctx)
}

// ─── Connect: account.updated ───────────────────────────────────

async function handleAccountUpdated(supabaseAdmin: SupabaseAdmin, event: Stripe.Event, logCtx: LogCtx) {
  const account = event.data.object as Stripe.Account

  if (!account.id) return

  const onboardingComplete = account.details_submitted ?? false
  const payoutsEnabled = account.payouts_enabled ?? false
  const chargesEnabled = account.charges_enabled ?? false
  const ctx = { ...logCtx, account_id: account.id, onboardingComplete, payoutsEnabled, chargesEnabled }

  const { error: updateErr } = await supabaseAdmin
    .from('profiles')
    .update({
      stripe_connect_onboarding_complete: onboardingComplete,
      stripe_details_submitted: onboardingComplete,
      payouts_enabled: payoutsEnabled,
      charges_enabled: chargesEnabled,
    })
    .eq('stripe_connect_account_id', account.id)

  if (updateErr) {
    console.error('[webhook] account.updated: failed to sync profile:', ctx, updateErr)
  } else {
    console.log('[webhook] account.updated: profile synced', ctx)
  }
}

// ─── Connect: transfer events ───────────────────────────────────

async function handleTransferCreated(supabaseAdmin: SupabaseAdmin, event: Stripe.Event, logCtx: LogCtx) {
  const transfer = event.data.object as Stripe.Transfer

  const jobId = transfer.transfer_group || transfer.metadata?.job_id
  if (!jobId) {
    console.log('[webhook] transfer.created: no job_id in transfer_group/metadata', logCtx)
    return
  }

  const ctx = { ...logCtx, job_id: jobId, transfer_id: transfer.id }

  const { error: updateErr } = await supabaseAdmin
    .from('walker_payouts')
    .update({
      stripe_transfer_id: transfer.id,
      status: 'transferred',
      updated_at: new Date().toISOString(),
    })
    .eq('job_id', jobId)

  if (updateErr) {
    console.error('[webhook] transfer.created: failed to update payout:', ctx, updateErr)
  } else {
    console.log('[webhook] transfer.created: payout updated', ctx)
  }
}

async function handleTransferReversed(supabaseAdmin: SupabaseAdmin, event: Stripe.Event, logCtx: LogCtx) {
  const transfer = event.data.object as Stripe.Transfer

  const jobId = transfer.transfer_group || transfer.metadata?.job_id
  if (!jobId) {
    console.log('[webhook] transfer.reversed: no job_id', logCtx)
    return
  }

  const ctx = { ...logCtx, job_id: jobId, transfer_id: transfer.id }

  const { error: updateErr } = await supabaseAdmin
    .from('walker_payouts')
    .update({
      status: 'reversed',
      reversed_amount: toMajor(Math.max(0, transfer.amount_reversed ?? transfer.amount ?? 0)),
      reversed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('job_id', jobId)

  if (updateErr) {
    console.error('[webhook] transfer.reversed: failed to update payout:', ctx, updateErr)
  } else {
    console.log('[webhook] transfer.reversed: payout updated', ctx)
  }

  // Notify walker
  const { data: payout } = await supabaseAdmin
    .from('walker_payouts')
    .select('walker_id, net_amount')
    .eq('job_id', jobId)
    .maybeSingle()

  if (payout?.walker_id) {
    await supabaseAdmin
      .from('notifications')
      .insert({
        user_id: payout.walker_id,
        type: 'transfer_reversed',
        title: 'Transfer Reversed',
        message: `A transfer of ${payout.net_amount} ILS has been reversed. Please contact support.`,
        related_job_id: jobId,
      })
      .then(({ error }) => {
        if (error) console.error('[webhook] Failed to notify walker about reversal:', { ...ctx, walker_id: payout.walker_id }, error)
      })
  }
}

// ─── Connect: payout events (Stripe → walker bank) ─────────────

async function handlePayoutCreated(supabaseAdmin: SupabaseAdmin, event: Stripe.Event, logCtx: LogCtx) {
  const payout = event.data.object as Stripe.Payout
  const connectedAccountId = event.account

  if (!connectedAccountId) {
    console.log('[webhook] payout.created: no connected account ID', logCtx)
    return
  }

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('id')
    .eq('stripe_connect_account_id', connectedAccountId)
    .maybeSingle()

  if (!profile) {
    console.warn('[webhook] payout.created: no profile for connected account', { ...logCtx, account_id: connectedAccountId })
    return
  }

  const ctx = { ...logCtx, walker_id: profile.id, payout_id: payout.id }

  const { error: updateErr } = await supabaseAdmin
    .from('walker_payouts')
    .update({
      stripe_payout_id: payout.id,
      stripe_balance_transaction_id: payout.balance_transaction as string || null,
      available_at: payout.arrival_date ? new Date(payout.arrival_date * 1000).toISOString() : null,
      status: 'in_transit',
      updated_at: new Date().toISOString(),
    })
    .eq('walker_id', profile.id)
    .eq('status', 'transferred')
    .is('stripe_payout_id', null)
    .order('created_at', { ascending: false })
    .limit(1)

  if (updateErr) {
    console.error('[webhook] payout.created: failed to update payout record:', ctx, updateErr)
  } else {
    console.log('[webhook] payout.created: payout record updated', ctx)
  }
}

async function handlePayoutPaid(supabaseAdmin: SupabaseAdmin, event: Stripe.Event, logCtx: LogCtx) {
  const payout = event.data.object as Stripe.Payout
  const connectedAccountId = event.account

  if (!connectedAccountId) return

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('id')
    .eq('stripe_connect_account_id', connectedAccountId)
    .maybeSingle()

  if (!profile) return

  const ctx = { ...logCtx, walker_id: profile.id, payout_id: payout.id }

  const { error: updateErr } = await supabaseAdmin
    .from('walker_payouts')
    .update({
      status: 'paid_out',
      updated_at: new Date().toISOString(),
    })
    .eq('stripe_payout_id', payout.id)

  if (updateErr) {
    console.error('[webhook] payout.paid: failed to update:', ctx, updateErr)
  } else {
    console.log('[webhook] payout.paid: marked paid_out', ctx)
  }
}

async function handlePayoutFailed(supabaseAdmin: SupabaseAdmin, event: Stripe.Event, logCtx: LogCtx) {
  const payout = event.data.object as Stripe.Payout
  const connectedAccountId = event.account

  if (!connectedAccountId) return

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('id')
    .eq('stripe_connect_account_id', connectedAccountId)
    .maybeSingle()

  if (!profile) return

  const failureMessage = payout.failure_message || 'Unknown reason'
  const ctx = { ...logCtx, walker_id: profile.id, payout_id: payout.id, failure: failureMessage }

  const { error: updateErr } = await supabaseAdmin
    .from('walker_payouts')
    .update({
      status: 'failed',
      failure_reason: failureMessage,
      updated_at: new Date().toISOString(),
    })
    .eq('stripe_payout_id', payout.id)

  if (updateErr) {
    console.error('[webhook] payout.failed: failed to update:', ctx, updateErr)
  } else {
    console.log('[webhook] payout.failed: marked failed', ctx)
  }

  // Notify walker about failed payout
  await supabaseAdmin
    .from('notifications')
    .insert({
      user_id: profile.id,
      type: 'payout_failed',
      title: 'Payout Failed',
      message: `Your bank payout failed: ${failureMessage}. Please update your bank details in Settings.`,
    })
    .then(({ error }) => {
      if (error) console.error('[webhook] Failed to notify walker about payout failure:', ctx, error)
    })
}

// ─── Refund handler ────────────────────────────────────────────

async function handleChargeRefunded(
  supabaseAdmin: SupabaseAdmin,
  stripe: Stripe,
  event: Stripe.Event,
  logCtx: LogCtx,
) {
  const charge = event.data.object as Stripe.Charge

  const paymentIntentId = charge.payment_intent as string | null
  if (!paymentIntentId) {
    console.log('[webhook] charge.refunded: no payment_intent on charge', logCtx)
    return
  }

  const { data: job, error: findErr } = await supabaseAdmin
    .from('walk_requests')
    .select('id, client_id, walker_id, payment_status, dog_name, price, walker_earnings, walker_amount, refunded_amount, refund_currency')
    .eq('stripe_payment_intent_id', paymentIntentId)
    .single()

  if (findErr || !job) {
    console.warn('[webhook] charge.refunded: no job found', { ...logCtx, pi_id: paymentIntentId })
    return
  }

  const ctx = { ...logCtx, job_id: job.id, pi_id: paymentIntentId, walker_id: job.walker_id }
  const capturedAmountMinor = Math.max(
    typeof charge.amount_captured === 'number' ? charge.amount_captured : 0,
    typeof charge.amount === 'number' ? charge.amount : 0,
  )
  const totalRefundedMinor = Math.max(0, charge.amount_refunded ?? 0)
  const refundCurrency = normalizeCurrency(charge.currency || job.refund_currency)
  const isFullyRefunded = capturedAmountMinor > 0 ? totalRefundedMinor >= capturedAmountMinor : charge.refunded === true
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

  const { error: jobUpdateErr } = await supabaseAdmin
    .from('walk_requests')
    .update({
      payment_status: isFullyRefunded ? 'refunded' : job.payment_status,
      refunded_amount: toMajor(totalRefundedMinor),
      refund_currency: refundCurrency,
      refunded_at: new Date().toISOString(),
    })
    .eq('id', job.id)

  if (jobUpdateErr) {
    console.error('[webhook] charge.refunded: failed to update job:', ctx, jobUpdateErr)
  } else {
    console.log('[webhook] charge.refunded: job refund state synced', {
      ...ctx,
      capturedAmountMinor,
      totalRefundedMinor,
      isFullyRefunded,
      refundCurrency,
    })
  }

  const { data: payout } = await supabaseAdmin
    .from('walker_payouts')
    .select('id, status, walker_id, net_amount, stripe_transfer_id, reversed_amount, stripe_transfer_reversal_id')
    .eq('job_id', job.id)
    .maybeSingle()

  if (payout) {
    let reversalStatus: 'failed' | 'partial' | 'reversed' | 'not_needed' = 'not_needed'
    let reversalAmountMajor = roundMajor(payout.reversed_amount ?? 0)

    if (payout.stripe_transfer_id) {
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
                request_id: job.id,
                payment_intent_id: paymentIntentId,
                refund_event_id: event.id,
              },
            },
            {
              idempotencyKey: `regli_refund_webhook_reversal_${job.id}_${currentReversedMinor}_${reversalDeltaMinor}`,
            },
          )

          reversalAmountMajor = toMajor(currentReversedMinor + reversalDeltaMinor)
          reversalStatus = currentReversedMinor + reversalDeltaMinor >= transferAmountMinor ? 'reversed' : 'partial'
          console.log('[TransferReversal]', {
            requestId: job.id,
            action: 'webhook_reversal',
            result: reversalStatus,
            transferId: payout.stripe_transfer_id,
            reversalId: reversal.id,
            reversalDeltaMinor,
          })

          const { error: payoutErr } = await supabaseAdmin
            .from('walker_payouts')
            .update({
              status: reversalStatus === 'reversed' ? 'reversed' : payout.status,
              reversed_amount: reversalAmountMajor,
              reversed_at: new Date().toISOString(),
              stripe_transfer_reversal_id: reversal.id,
              failure_reason: null,
              updated_at: new Date().toISOString(),
            })
            .eq('id', payout.id)

          if (payoutErr) {
            console.error('[webhook] charge.refunded: failed to update payout after reversal:', ctx, payoutErr)
          }
        } else if (isFullyRefunded && payout.status !== 'reversed' && !payout.stripe_transfer_reversal_id) {
          const { error: payoutErr } = await supabaseAdmin
            .from('walker_payouts')
            .update({
              status: 'refunded',
              failure_reason: 'Charge was refunded',
              updated_at: new Date().toISOString(),
            })
            .eq('id', payout.id)

          if (payoutErr) {
            console.error('[webhook] charge.refunded: failed to sync payout refund state:', ctx, payoutErr)
          }
        } else {
          reversalAmountMajor = toMajor(currentReversedMinor)
          reversalStatus = currentReversedMinor >= transferAmountMinor ? 'reversed' : 'partial'
        }

        if (payout.walker_id && reversalAmountMajor > 0) {
          await upsertWalletTransaction(supabaseAdmin, {
            walkerId: payout.walker_id,
            jobId: job.id,
            type: 'transfer_reversal',
            amount: -reversalAmountMajor,
            currency: refundCurrency,
            status: reversalStatus === 'reversed' ? 'succeeded' : 'partial',
            description: `Transfer reversal for ${job.dog_name || 'service refund'}`,
          })
        }
      } catch (reversalError) {
        reversalStatus = 'failed'
        console.error('[TransferReversal]', {
          requestId: job.id,
          action: 'webhook_reversal',
          result: 'failed',
          transferId: payout.stripe_transfer_id,
          error: reversalError instanceof Error ? reversalError.message : 'Unknown',
        })
      }
    }

    if (payout.walker_id && providerTargetRefundMajor > 0) {
      await upsertBalanceAdjustment(supabaseAdmin, {
        walkerId: payout.walker_id,
        jobId: job.id,
        amount: -providerTargetRefundMajor,
        description: `Refund debit: ${job.dog_name || 'service'} (${isFullyRefunded ? 'refunded' : 'partially refunded'})`,
      })

      await upsertWalletTransaction(supabaseAdmin, {
        walkerId: payout.walker_id,
        jobId: job.id,
        type: 'refund',
        amount: -providerTargetRefundMajor,
        currency: refundCurrency,
        status: isFullyRefunded ? 'succeeded' : 'partial',
        description: `Customer refund for ${job.dog_name || 'service'}`,
      })
    }
  } else {
    if (job.walker_id) {
      await upsertBalanceAdjustment(supabaseAdmin, {
        walkerId: job.walker_id,
        jobId: job.id,
        amount: -providerTargetRefundMajor,
        description: `Refund debit: ${job.dog_name || 'service'} (${isFullyRefunded ? 'refunded' : 'partially refunded'})`,
      })

      await upsertWalletTransaction(supabaseAdmin, {
        walkerId: job.walker_id,
        jobId: job.id,
        type: 'refund',
        amount: -providerTargetRefundMajor,
        currency: refundCurrency,
        status: isFullyRefunded ? 'succeeded' : 'partial',
        description: `Customer refund for ${job.dog_name || 'service'}`,
      })
    }
  }

  if (job.client_id) {
    await supabaseAdmin
      .from('notifications')
      .insert({
        user_id: job.client_id,
        type: 'refund_issued',
        title: 'Refund issued',
        message: isFullyRefunded ? 'Your payment was refunded.' : 'A partial refund was issued for your request.',
        related_job_id: job.id,
      })
      .then(({ error }) => {
        if (error) console.error('[webhook] Failed to notify client about refund:', ctx, error)
      })
  }
}
