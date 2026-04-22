import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import Stripe from 'https://esm.sh/stripe@17.5.0?target=denonext'

const FUNCTION_VERSION = 'v4_require_authorized_pi_2026_04_22'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const SERVICE_PRICES: Record<string, number> = {
  quick: 3000,
  standard: 5000,
  energy: 7000,
}

const PLATFORM_FEE_PERCENT = 20
const CURRENCY = 'ils'
const SCHEDULE_TIMEZONE = 'Asia/Jerusalem'

function parseTimeZoneOffsetMinutes(offsetLabel: string): number | null {
  const normalized = offsetLabel.replace('UTC', 'GMT')
  if (normalized === 'GMT' || normalized === 'GMT+0' || normalized === 'GMT+00:00') return 0

  const match = normalized.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/)
  if (!match) return null

  const [, sign, hoursRaw, minutesRaw] = match
  const hours = Number(hoursRaw)
  const minutes = Number(minutesRaw ?? '0')
  const total = hours * 60 + minutes

  return sign === '-' ? -total : total
}

function getOffsetMinutesForTimeZone(date: Date, timeZone: string): number | null {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'shortOffset',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })

  const tzPart = formatter.formatToParts(date).find((part) => part.type === 'timeZoneName')?.value
  if (!tzPart) return null

  return parseTimeZoneOffsetMinutes(tzPart)
}

function parseLocalDateTimeInTimeZoneToUTC(value: string, timeZone: string): string | null {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/,
  )

  if (!match) return null

  const [, year, month, day, hour, minute, second] = match

  const y = Number(year)
  const m = Number(month)
  const d = Number(day)
  const hh = Number(hour)
  const mm = Number(minute)
  const ss = Number(second || '0')

  const utcGuess = Date.UTC(y, m - 1, d, hh, mm, ss, 0)
  const guessDate = new Date(utcGuess)

  if (Number.isNaN(guessDate.getTime())) return null

  const firstOffsetMinutes = getOffsetMinutesForTimeZone(guessDate, timeZone)
  if (firstOffsetMinutes == null) return null

  const adjustedUtc = utcGuess - firstOffsetMinutes * 60 * 1000
  const adjustedDate = new Date(adjustedUtc)

  const secondOffsetMinutes = getOffsetMinutesForTimeZone(adjustedDate, timeZone)
  if (secondOffsetMinutes == null) return null

  const finalUtc =
    secondOffsetMinutes === firstOffsetMinutes
      ? adjustedUtc
      : utcGuess - secondOffsetMinutes * 60 * 1000

  const finalDate = new Date(finalUtc)
  if (Number.isNaN(finalDate.getTime())) return null

  return finalDate.toISOString()
}

function paymentStatusFromIntent(status: Stripe.PaymentIntent.Status): 'unpaid' | 'authorized' | 'paid' | 'failed' {
  if (status === 'requires_capture') return 'authorized'
  if (status === 'succeeded') return 'paid'
  if (status === 'canceled') return 'failed'
  return 'unpaid'
}

console.log(`[create-payment-intent] ====== FUNCTION LOADED — VERSION: ${FUNCTION_VERSION} ======`)

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  console.log(`[create-payment-intent][${FUNCTION_VERSION}] ── Request received ──`)

  try {
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

    if (!stripeKey || !supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
      return new Response(
        JSON.stringify({ error: 'Server misconfigured', _v: FUNCTION_VERSION }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Missing authorization', _v: FUNCTION_VERSION }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: {
          Authorization: authHeader,
        },
      },
    })

    const {
      data: { user },
      error: authError,
    } = await supabaseUser.auth.getUser()

    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Invalid token', _v: FUNCTION_VERSION }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey)

    let body: {
      dogName?: string
      location?: string
      notes?: string
      serviceType?: string
      walkerId?: string
      customerId?: string
      paymentMethodId?: string
      surgeMultiplier?: number
      bookingTiming?: 'asap' | 'scheduled'
      scheduledFor?: string
    }

    try {
      body = await req.json()
    } catch {
      return new Response(
        JSON.stringify({ error: 'Invalid request body', _v: FUNCTION_VERSION }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const {
      dogName,
      location,
      notes,
      serviceType,
      walkerId,
      customerId,
      paymentMethodId,
      surgeMultiplier: rawSurge,
      bookingTiming = 'asap',
      scheduledFor,
    } = body

    if (!serviceType || !SERVICE_PRICES[serviceType]) {
      return new Response(
        JSON.stringify({
          error: 'Invalid service type. Must be: quick, standard, or energy',
          _v: FUNCTION_VERSION,
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    if (!dogName?.trim()) {
      return new Response(
        JSON.stringify({ error: 'Missing dog name', _v: FUNCTION_VERSION }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    if (!location?.trim()) {
      return new Response(
        JSON.stringify({ error: 'Missing location', _v: FUNCTION_VERSION }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    let normalizedScheduledFor: string | null = null

    if (bookingTiming !== 'asap' && bookingTiming !== 'scheduled') {
      return new Response(
        JSON.stringify({ error: 'Invalid booking timing', _v: FUNCTION_VERSION }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    if (bookingTiming === 'scheduled') {
      if (!scheduledFor) {
        return new Response(
          JSON.stringify({ error: 'Missing scheduled time', _v: FUNCTION_VERSION }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        )
      }

      const utcValue = parseLocalDateTimeInTimeZoneToUTC(scheduledFor, SCHEDULE_TIMEZONE)
      if (!utcValue) {
        return new Response(
          JSON.stringify({ error: 'Invalid scheduled time', _v: FUNCTION_VERSION }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        )
      }

      const scheduledDate = new Date(utcValue)
      if (Number.isNaN(scheduledDate.getTime())) {
        return new Response(
          JSON.stringify({ error: 'Invalid scheduled time', _v: FUNCTION_VERSION }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        )
      }

      if (scheduledDate.getTime() < Date.now() + 10 * 60 * 1000) {
        return new Response(
          JSON.stringify({
            error: 'Scheduled time must be at least 10 minutes from now',
            _v: FUNCTION_VERSION,
          }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        )
      }

      normalizedScheduledFor = utcValue
    }

    const { data: clientProfile, error: clientError } = await supabaseAdmin
      .from('profiles')
      .select('id, role')
      .eq('id', user.id)
      .single()

    if (clientError || !clientProfile) {
      return new Response(
        JSON.stringify({ error: 'Client profile not found', _v: FUNCTION_VERSION }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    if (clientProfile.role !== 'client') {
      return new Response(
        JSON.stringify({ error: 'Only clients can create payment intents', _v: FUNCTION_VERSION }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    if (walkerId) {
      const { data: walkerProfile, error: walkerError } = await supabaseAdmin
        .from('profiles')
        .select('id, role, stripe_connect_account_id, charges_enabled, payouts_enabled')
        .eq('id', walkerId)
        .single()

      if (walkerError || !walkerProfile) {
        return new Response(
          JSON.stringify({ error: 'Walker not found', _v: FUNCTION_VERSION }),
          { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        )
      }

      if (walkerProfile.role !== 'walker') {
        return new Response(
          JSON.stringify({ error: 'Selected user is not a walker', _v: FUNCTION_VERSION }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        )
      }

      if (!walkerProfile.stripe_connect_account_id) {
        return new Response(
          JSON.stringify({
            error: 'Walker has not connected a payout account',
            _v: FUNCTION_VERSION,
          }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        )
      }

      if (!walkerProfile.charges_enabled) {
        return new Response(
          JSON.stringify({
            error: 'Walker account is not ready to accept charges',
            _v: FUNCTION_VERSION,
          }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        )
      }

      if (!walkerProfile.payouts_enabled) {
        return new Response(
          JSON.stringify({
            error: 'Walker account is not ready to receive payouts',
            _v: FUNCTION_VERSION,
          }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        )
      }
    }

    const MAX_SURGE = 1.5
    const surgeMultiplier =
      typeof rawSurge === 'number' && rawSurge > 1 && rawSurge <= MAX_SURGE
        ? Math.round(rawSurge * 100) / 100
        : 1

    const baseAmount = SERVICE_PRICES[serviceType]
    const amount = Math.round(baseAmount * surgeMultiplier)
    const platformFee = Math.round((amount * PLATFORM_FEE_PERCENT) / 100)
    const walkerAmount = amount - platformFee

    if (!customerId || !paymentMethodId) {
      console.warn(`[create-payment-intent][${FUNCTION_VERSION}] Missing saved payment method`, {
        hasCustomerId: !!customerId,
        hasPaymentMethodId: !!paymentMethodId,
        clientId: user.id,
      })
      return new Response(
        JSON.stringify({
          error: 'Payment method required',
          details: 'Add or select a saved card before booking.',
          _v: FUNCTION_VERSION,
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const stripe = new Stripe(stripeKey, { apiVersion: '2024-12-18.acacia' })

    try {
      const paymentMethod = await stripe.paymentMethods.retrieve(paymentMethodId)
      const attachedCustomer =
        typeof paymentMethod.customer === 'string'
          ? paymentMethod.customer
          : paymentMethod.customer?.id ?? null

      console.log(`[create-payment-intent][${FUNCTION_VERSION}] Payment method check:`, {
        paymentMethodId,
        customerId,
        attachedCustomer,
        hasCard: !!paymentMethod.card,
      })

      if (attachedCustomer !== customerId) {
        return new Response(
          JSON.stringify({
            error: 'Payment method does not belong to customer',
            _v: FUNCTION_VERSION,
          }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        )
      }
    } catch (err) {
      console.error(`[create-payment-intent][${FUNCTION_VERSION}] Payment method retrieve failed:`, err)
      return new Response(
        JSON.stringify({
          error: 'Payment method unavailable',
          details: err instanceof Error ? err.message : 'Could not verify payment method',
          _v: FUNCTION_VERSION,
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const sixtySecondsAgo = new Date(Date.now() - 60_000).toISOString()
    let dupQuery = supabaseAdmin
      .from('walk_requests')
      .select('id, stripe_payment_intent_id, stripe_client_secret')
      .eq('client_id', user.id)
      .eq('dog_name', dogName.trim())
      .eq('status', 'awaiting_payment')
      .gte('created_at', sixtySecondsAgo)
      .limit(1)

    if (walkerId) {
      dupQuery = dupQuery.eq('selected_walker_id', walkerId)
    } else {
      dupQuery = dupQuery.is('selected_walker_id', null)
    }

    const { data: existingJob } = await dupQuery.maybeSingle()

    if (existingJob) {
      let actualPaymentStatus = 'requires_payment_method'

      if (existingJob.stripe_payment_intent_id) {
        try {
          const stripe = new Stripe(stripeKey, { apiVersion: '2024-12-18.acacia' })
          const pi = await stripe.paymentIntents.retrieve(existingJob.stripe_payment_intent_id)
          actualPaymentStatus = pi.status
          console.log(`[create-payment-intent][${FUNCTION_VERSION}] Idempotent duplicate found:`, {
            jobId: existingJob.id,
            piId: pi.id,
            actualStatus: pi.status,
            paymentMethodAttached: !!pi.payment_method,
          })
        } catch (err) {
          console.error(
            `[create-payment-intent][${FUNCTION_VERSION}] Failed to retrieve PI for duplicate:`,
            err,
          )
        }
      }

      if (actualPaymentStatus !== 'requires_capture' && actualPaymentStatus !== 'succeeded') {
        console.warn(`[create-payment-intent][${FUNCTION_VERSION}] Existing duplicate is not authorized; cancelling stale job`, {
          jobId: existingJob.id,
          paymentIntentId: existingJob.stripe_payment_intent_id,
          actualPaymentStatus,
        })

        await supabaseAdmin
          .from('walk_requests')
          .update({ status: 'cancelled', payment_status: 'failed' })
          .eq('id', existingJob.id)

        if (existingJob.stripe_payment_intent_id) {
          try {
            await stripe.paymentIntents.cancel(existingJob.stripe_payment_intent_id)
          } catch (cancelErr) {
            console.error(`[create-payment-intent][${FUNCTION_VERSION}] Failed to cancel stale PI:`, cancelErr)
          }
        }
      } else {
        return new Response(
          JSON.stringify({
            jobId: existingJob.id,
            paymentIntentId: existingJob.stripe_payment_intent_id,
            clientSecret: existingJob.stripe_client_secret,
            amount,
            platformFee,
            walkerAmount,
            paymentStatus: actualPaymentStatus,
            duplicate: true,
            _v: FUNCTION_VERSION,
          }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        )
      }
    }

    const metadata: Record<string, string> = {
      client_id: user.id,
      service_type: serviceType,
      dog_name: dogName.trim(),
      booking_timing: bookingTiming,
    }

    if (normalizedScheduledFor) {
      metadata.scheduled_for = normalizedScheduledFor
      metadata.schedule_timezone = SCHEDULE_TIMEZONE
    }

    if (walkerId) {
      metadata.walker_id = walkerId
    }

    const piParams: Record<string, unknown> = {
      amount,
      currency: CURRENCY,
      capture_method: 'manual',
      transfer_group: `job_${Date.now()}`,
      metadata,
    }

    piParams.customer = customerId
    piParams.payment_method = paymentMethodId
    piParams.confirm = true
    piParams.off_session = true

    let paymentIntent: Stripe.PaymentIntent

    try {
      paymentIntent = await stripe.paymentIntents.create(
        piParams as Stripe.PaymentIntentCreateParams,
      )
    } catch (stripeErr: unknown) {
      console.error(`[create-payment-intent][${FUNCTION_VERSION}] Stripe PI creation failed:`, stripeErr)
      const msg = stripeErr instanceof Error ? stripeErr.message : 'Unknown error'
      return new Response(
        JSON.stringify({ error: 'Failed to create payment', details: msg, _v: FUNCTION_VERSION }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    console.log(`[create-payment-intent][${FUNCTION_VERSION}] PI created:`, {
      id: paymentIntent.id,
      status: paymentIntent.status,
      amount: paymentIntent.amount,
      confirmRequested: true,
      paymentMethodAttached: !!paymentIntent.payment_method,
      paymentMethodId,
      customerId,
      scheduledForInput: scheduledFor ?? null,
      normalizedScheduledFor,
      scheduleTimezone: SCHEDULE_TIMEZONE,
    })

    if (paymentIntent.status !== 'requires_capture' && paymentIntent.status !== 'succeeded') {
      console.error(`[create-payment-intent][${FUNCTION_VERSION}] PI authorization failed after confirmation`, {
        id: paymentIntent.id,
        status: paymentIntent.status,
        paymentMethodAttached: !!paymentIntent.payment_method,
        customerId,
        paymentMethodId,
      })

      try {
        await stripe.paymentIntents.cancel(paymentIntent.id)
      } catch (cancelErr) {
        console.error(`[create-payment-intent][${FUNCTION_VERSION}] Failed to cancel unauthorized PI:`, cancelErr)
      }

      return new Response(
        JSON.stringify({
          error: 'Payment authorization failed',
          details: `PaymentIntent status is '${paymentIntent.status}'. Expected 'requires_capture'.`,
          paymentIntentStatus: paymentIntent.status,
          _v: FUNCTION_VERSION,
        }),
        { status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const initialPaymentStatus = paymentStatusFromIntent(paymentIntent.status)
    const paymentAuthorizedAt =
      initialPaymentStatus === 'authorized' || initialPaymentStatus === 'paid'
        ? new Date().toISOString()
        : null
    const paidAt = initialPaymentStatus === 'paid' ? new Date().toISOString() : null

    const { data: job, error: jobError } = await supabaseAdmin
      .from('walk_requests')
      .insert({
        client_id: user.id,
        selected_walker_id: walkerId || null,
        dog_name: dogName.trim(),
        location: location.trim(),
        notes: notes?.trim() || null,
        status: 'awaiting_payment',
        payment_status: initialPaymentStatus,
        payment_authorized_at: paymentAuthorizedAt,
        paid_at: paidAt,
        booking_timing: bookingTiming,
        scheduled_for: normalizedScheduledFor,
        scheduled_fee_snapshot: amount / 100,
        scheduled_pricing_multiplier: surgeMultiplier,
        schedule_timezone: SCHEDULE_TIMEZONE,
        requested_window_minutes:
          serviceType === 'quick' ? 20 : serviceType === 'standard' ? 40 : serviceType === 'energy' ? 60 : null,
        amount,
        currency: CURRENCY,
        platform_fee_percent: PLATFORM_FEE_PERCENT,
        platform_fee: platformFee / 100,
        walker_amount: walkerAmount / 100,
        walker_earnings: walkerAmount / 100,
        price: amount / 100,
        stripe_payment_intent_id: paymentIntent.id,
        stripe_client_secret: paymentIntent.client_secret,
      })
      .select('id')
      .single()

    if (jobError || !job) {
      console.error('Failed to create job:', jobError)
      try {
        await stripe.paymentIntents.cancel(paymentIntent.id)
      } catch (cancelErr) {
        console.error('Failed to cancel orphaned PaymentIntent:', cancelErr)
      }
      return new Response(
        JSON.stringify({ error: 'Failed to create job', _v: FUNCTION_VERSION }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    console.log(`[create-payment-intent][${FUNCTION_VERSION}] Walk request saved with authorized PI:`, {
      jobId: job.id,
      paymentIntentId: paymentIntent.id,
      paymentIntentStatus: paymentIntent.status,
      paymentStatus: initialPaymentStatus,
      paymentMethodAttached: !!paymentIntent.payment_method,
    })

    try {
      await stripe.paymentIntents.update(paymentIntent.id, {
        transfer_group: job.id,
        metadata: {
          ...paymentIntent.metadata,
          job_id: job.id,
        },
      })
    } catch (updateErr) {
      console.error('Failed to update PI with job ID (non-blocking):', updateErr)
    }

    return new Response(
      JSON.stringify({
        jobId: job.id,
        paymentIntentId: paymentIntent.id,
        clientSecret: paymentIntent.client_secret,
        amount,
        platformFee,
        walkerAmount,
        paymentStatus: paymentIntent.status,
        _v: FUNCTION_VERSION,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  } catch (err) {
    console.error(`[create-payment-intent][${FUNCTION_VERSION}] Unhandled error:`, err)
    return new Response(
      JSON.stringify({ error: 'Internal server error', _v: FUNCTION_VERSION }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }
})
