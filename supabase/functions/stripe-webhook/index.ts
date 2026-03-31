import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import Stripe from 'https://esm.sh/stripe@17.5.0?target=denonext'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, stripe-signature',
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
        await handleChargeRefunded(supabaseAdmin, event, logCtx)
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

type SupabaseAdmin = ReturnType<typeof createClient>
type LogCtx = { event_id: string; event_type: string }

async function handlePaymentIntentSucceeded(supabaseAdmin: SupabaseAdmin, event: Stripe.Event, logCtx: LogCtx) {
  const pi = event.data.object as Stripe.PaymentIntent

  const { data: job, error: findErr } = await supabaseAdmin
    .from('walk_requests')
    .select('id, payment_status, walker_id, walker_amount, walker_earnings, price, dog_name')
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
    .select('id, payment_status, status')
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

async function handleChargeRefunded(supabaseAdmin: SupabaseAdmin, event: Stripe.Event, logCtx: LogCtx) {
  const charge = event.data.object as Stripe.Charge

  // Find the job by payment intent
  const paymentIntentId = charge.payment_intent as string | null
  if (!paymentIntentId) {
    console.log('[webhook] charge.refunded: no payment_intent on charge', logCtx)
    return
  }

  const { data: job, error: findErr } = await supabaseAdmin
    .from('walk_requests')
    .select('id, walker_id, payment_status, dog_name')
    .eq('stripe_payment_intent_id', paymentIntentId)
    .single()

  if (findErr || !job) {
    console.warn('[webhook] charge.refunded: no job found', { ...logCtx, pi_id: paymentIntentId })
    return
  }

  const ctx = { ...logCtx, job_id: job.id, pi_id: paymentIntentId, walker_id: job.walker_id }

  // Update job payment status to refunded
  const { error: jobUpdateErr } = await supabaseAdmin
    .from('walk_requests')
    .update({ payment_status: 'refunded' })
    .eq('id', job.id)

  if (jobUpdateErr) {
    console.error('[webhook] charge.refunded: failed to update job:', ctx, jobUpdateErr)
  } else {
    console.log('[webhook] charge.refunded: job marked refunded', ctx)
  }

  // Mark the corresponding payout as refunded (block future payouts)
  const { data: payout } = await supabaseAdmin
    .from('walker_payouts')
    .select('id, status, walker_id, net_amount')
    .eq('job_id', job.id)
    .maybeSingle()

  if (payout) {
    const { error: payoutErr } = await supabaseAdmin
      .from('walker_payouts')
      .update({
        status: 'refunded',
        failure_reason: 'Charge was refunded',
        updated_at: new Date().toISOString(),
      })
      .eq('id', payout.id)

    if (payoutErr) {
      console.error('[webhook] charge.refunded: failed to update payout:', ctx, payoutErr)
    } else {
      console.log('[webhook] charge.refunded: payout marked refunded', { ...ctx, payout_id: payout.id })
    }

    // Create balance adjustment (debit) to offset the walker's credited earnings
    if (payout.walker_id && payout.net_amount > 0) {
      const { error: adjErr } = await supabaseAdmin
        .from('walker_balance_adjustments')
        .insert({
          walker_id: payout.walker_id,
          job_id: job.id,
          type: 'refund_debit',
          amount: -payout.net_amount, // negative = debit
          description: `Refund debit: ${job.dog_name || 'walk'} (charge refunded)`,
        })

      if (adjErr) {
        // Unique constraint means we already recorded this — safe to ignore
        if (adjErr.message?.includes('duplicate') || adjErr.code === '23505') {
          console.log('[webhook] charge.refunded: balance adjustment already exists', { ...ctx, payout_id: payout.id })
        } else {
          console.error('[webhook] charge.refunded: failed to create balance adjustment:', ctx, adjErr)
        }
      } else {
        console.log('[webhook] charge.refunded: balance adjustment created', { ...ctx, debit_amount: -payout.net_amount })
      }
    }

    // Notify walker
    if (payout.walker_id) {
      await supabaseAdmin
        .from('notifications')
        .insert({
          user_id: payout.walker_id,
          type: 'charge_refunded',
          title: 'Payment Refunded',
          message: `A payment of ${payout.net_amount} ILS for ${job.dog_name || 'a walk'} has been refunded. This amount has been deducted from your balance.`,
          related_job_id: job.id,
        })
        .then(({ error }) => {
          if (error) console.error('[webhook] Failed to notify walker about refund:', ctx, error)
        })
    }
  } else {
    // No payout record exists — still create a balance adjustment if walker was credited via wallet
    if (job.walker_id) {
      // Look up what was credited to wallet for this job
      const { data: walletTx } = await supabaseAdmin
        .from('wallet_transactions')
        .select('amount')
        .eq('job_id', job.id)
        .eq('walker_id', job.walker_id)
        .eq('type', 'credit')
        .maybeSingle()

      const debitAmount = walletTx?.amount ?? 0
      if (debitAmount > 0) {
        const { error: adjErr } = await supabaseAdmin
          .from('walker_balance_adjustments')
          .insert({
            walker_id: job.walker_id,
            job_id: job.id,
            type: 'refund_debit',
            amount: -debitAmount,
            description: `Refund debit: ${job.dog_name || 'walk'} (charge refunded, no transfer)`,
          })

        if (adjErr && !adjErr.message?.includes('duplicate') && adjErr.code !== '23505') {
          console.error('[webhook] charge.refunded: failed to create balance adjustment (no payout):', ctx, adjErr)
        } else {
          console.log('[webhook] charge.refunded: balance adjustment created (no payout)', { ...ctx, debit_amount: -debitAmount })
        }
      }

      // Notify walker
      await supabaseAdmin
        .from('notifications')
        .insert({
          user_id: job.walker_id,
          type: 'charge_refunded',
          title: 'Payment Refunded',
          message: `A payment for ${job.dog_name || 'a walk'} has been refunded. This may affect your balance.`,
          related_job_id: job.id,
        })
        .then(({ error }) => {
          if (error) console.error('[webhook] Failed to notify walker about refund (no payout):', ctx, error)
        })
    }
  }
}
