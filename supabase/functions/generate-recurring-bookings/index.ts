import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import Stripe from 'https://esm.sh/stripe@17.5.0?target=denonext'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const FUNCTION_VERSION = 'v_recurring_engine_2026_06_18'
const PLATFORM_FEE_PERCENT = 20
const SCHEDULE_TIMEZONE = 'Asia/Jerusalem'
const DEFAULT_MARKET_CURRENCY = 'ils'
const GENERATION_WINDOW_DAYS = 7
const MIN_FUTURE_BUFFER_MS = 10 * 60 * 1000

type RecurringBookingRow = {
  id: string
  client_id: string
  provider_id: string | null
  service_type: string
  dog_name: string | null
  dog_count: number | null
  location: string
  address: string | null
  notes: string | null
  duration_minutes: number
  price_per_visit: number | string
  repeat_type: 'one_time' | 'weekly'
  repeat_days: number[] | null
  repeat_starts_on: string
  repeat_ends_on: string | null
  start_time: string
  recurring_status: 'active' | 'paused' | 'cancelled'
}

type ExistingOccurrenceRow = {
  recurring_booking_id: string | null
  scheduled_for: string | null
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function normalizeTime24(value: string | null | undefined): string {
  const match = String(value ?? '').match(/^(\d{2}):(\d{2})/)
  if (!match) return '18:00'
  return `${match[1]}:${match[2]}`
}

function normalizeCurrency(value: string | null | undefined): string {
  if (typeof value !== 'string') return DEFAULT_MARKET_CURRENCY
  const normalized = value.trim().toLowerCase()
  return /^[a-z]{3}$/.test(normalized) ? normalized : DEFAULT_MARKET_CURRENCY
}

function normalizeRepeatDays(days: number[] | null | undefined): number[] {
  return Array.from(
    new Set((days ?? []).filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6)),
  ).sort((a, b) => a - b)
}

function normalizeDogCount(value: number | null | undefined): 1 | 2 {
  return value === 2 ? 2 : 1
}

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
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/)
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

function toLocalDateParts(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const parts = formatter.formatToParts(date)
  const year = Number(parts.find((part) => part.type === 'year')?.value ?? '0')
  const month = Number(parts.find((part) => part.type === 'month')?.value ?? '0')
  const day = Number(parts.find((part) => part.type === 'day')?.value ?? '0')
  return { year, month, day }
}

function addDaysToLocalDate(date: Date, timeZone: string, offset: number): string {
  const { year, month, day } = toLocalDateParts(date, timeZone)
  const utcMidday = new Date(Date.UTC(year, month - 1, day + offset, 12, 0, 0, 0))
  const next = toLocalDateParts(utcMidday, 'UTC')
  return `${next.year}-${pad(next.month)}-${pad(next.day)}`
}

function getWeekdayForLocalDate(dateValue: string): number | null {
  const match = dateValue.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null
  const [, year, month, day] = match
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12, 0, 0, 0)).getUTCDay()
}

function amountToAgorot(pricePerVisit: number | string): number | null {
  const value =
    typeof pricePerVisit === 'number'
      ? pricePerVisit
      : typeof pricePerVisit === 'string'
        ? Number(pricePerVisit)
        : NaN
  if (!Number.isFinite(value) || value <= 0) return null
  return Math.round(value * 100)
}

function paymentStatusFromIntent(status: Stripe.PaymentIntent.Status): 'unpaid' | 'authorized' | 'paid' | 'failed' {
  if (status === 'requires_capture') return 'authorized'
  if (status === 'succeeded') return 'paid'
  if (status === 'canceled') return 'failed'
  return 'unpaid'
}

function buildOccurrenceCandidates(row: RecurringBookingRow, now: Date): string[] {
  if (row.repeat_type !== 'weekly') return []

  const normalizedDays = normalizeRepeatDays(row.repeat_days)
  if (normalizedDays.length === 0) return []

  const normalizedTime = normalizeTime24(row.start_time)
  const occurrences: string[] = []
  const seen = new Set<string>()

  for (let offset = 0; offset < GENERATION_WINDOW_DAYS; offset += 1) {
    const dateValue = addDaysToLocalDate(now, SCHEDULE_TIMEZONE, offset)
    const weekday = getWeekdayForLocalDate(dateValue)
    if (weekday == null || !normalizedDays.includes(weekday)) continue
    if (dateValue < row.repeat_starts_on) continue
    if (row.repeat_ends_on && dateValue > row.repeat_ends_on) continue

    const iso = parseLocalDateTimeInTimeZoneToUTC(`${dateValue}T${normalizedTime}`, SCHEDULE_TIMEZONE)
    if (!iso) continue
    if (new Date(iso).getTime() < now.getTime() + MIN_FUTURE_BUFFER_MS) continue
    if (seen.has(iso)) continue
    seen.add(iso)
    occurrences.push(iso)
  }

  return occurrences
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

    if (!stripeKey || !supabaseUrl || !serviceRoleKey) {
      return jsonResponse(500, { ok: false, error: 'Server misconfigured', _v: FUNCTION_VERSION })
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey)
    const stripe = new Stripe(stripeKey, { apiVersion: '2024-12-18.acacia' })
    const now = new Date()
    const windowEnd = new Date(now.getTime() + GENERATION_WINDOW_DAYS * 24 * 60 * 60 * 1000)

    let targetRecurringBookingId: string | null = null
    if (req.method === 'POST') {
      try {
        const rawBody = await req.text()
        if (rawBody.trim().length > 0) {
          const parsed = JSON.parse(rawBody) as { recurring_booking_id?: unknown }
          if (typeof parsed?.recurring_booking_id === 'string' && parsed.recurring_booking_id.trim().length > 0) {
            targetRecurringBookingId = parsed.recurring_booking_id.trim()
          }
        }
      } catch (error) {
        return jsonResponse(400, {
          ok: false,
          error: error instanceof Error ? error.message : 'Invalid JSON body',
          _v: FUNCTION_VERSION,
        })
      }
    }

    let recurringQuery = supabase
      .from('recurring_bookings')
      .select(`
        id,
        client_id,
        provider_id,
        service_type,
        dog_name,
        dog_count,
        location,
        address,
        notes,
        duration_minutes,
        price_per_visit,
        repeat_type,
        repeat_days,
        repeat_starts_on,
        repeat_ends_on,
        start_time,
        recurring_status
      `)
      .eq('recurring_status', 'active')

    if (targetRecurringBookingId) {
      recurringQuery = recurringQuery.eq('id', targetRecurringBookingId)
    }

    const { data: recurringRows, error: recurringError } = await recurringQuery

    if (recurringError) {
      console.error('[generate-recurring-bookings] failed to load recurring bookings', recurringError)
      return jsonResponse(500, { ok: false, error: recurringError.message, _v: FUNCTION_VERSION })
    }

    const recurringBookings = (recurringRows ?? []) as RecurringBookingRow[]
    if (recurringBookings.length === 0) {
      return jsonResponse(200, {
        ok: true,
        scanned: 0,
        created: 0,
        skippedDuplicates: 0,
        skippedPayment: 0,
        _v: FUNCTION_VERSION,
      })
    }

    const recurringIds = recurringBookings.map((row) => row.id)
    const { data: existingRows, error: existingError } = await supabase
      .from('walk_requests')
      .select('recurring_booking_id, scheduled_for')
      .in('recurring_booking_id', recurringIds)
      .gte('scheduled_for', now.toISOString())
      .lte('scheduled_for', windowEnd.toISOString())

    if (existingError) {
      console.error('[generate-recurring-bookings] failed to load existing generated requests', existingError)
      return jsonResponse(500, { ok: false, error: existingError.message, _v: FUNCTION_VERSION })
    }

    const existingKeys = new Set(
      ((existingRows ?? []) as ExistingOccurrenceRow[])
        .filter((row) => row.recurring_booking_id && row.scheduled_for)
        .map((row) => `${row.recurring_booking_id}::${row.scheduled_for}`),
    )

    const clientIds = Array.from(new Set(recurringBookings.map((row) => row.client_id)))
    const { data: clientProfiles, error: profilesError } = await supabase
      .from('profiles')
      .select('id, stripe_customer_id')
      .in('id', clientIds)

    if (profilesError) {
      console.error('[generate-recurring-bookings] failed to load client profiles', profilesError)
      return jsonResponse(500, { ok: false, error: profilesError.message, _v: FUNCTION_VERSION })
    }

    const profileById = new Map(
      (clientProfiles ?? []).map((row) => [row.id as string, { stripe_customer_id: (row as { stripe_customer_id?: string | null }).stripe_customer_id ?? null }]),
    )

    let created = 0
    let skippedDuplicates = 0
    let skippedPayment = 0
    const errors: Array<{ recurringBookingId: string; occurrence?: string; error: string }> = []

    for (const row of recurringBookings) {
      const occurrences = buildOccurrenceCandidates(row, now)
      if (occurrences.length === 0) continue

      const amount = amountToAgorot(row.price_per_visit)
      if (!amount) {
        skippedPayment += occurrences.length
        errors.push({ recurringBookingId: row.id, error: 'Invalid price_per_visit' })
        continue
      }

      const profile = profileById.get(row.client_id)
      const customerId = profile?.stripe_customer_id ?? null
      if (!customerId) {
        skippedPayment += occurrences.length
        errors.push({ recurringBookingId: row.id, error: 'Missing stripe_customer_id' })
        continue
      }

      let paymentMethodId: string | null = null
      try {
        const paymentMethods = await stripe.paymentMethods.list({
          customer: customerId,
          type: 'card',
          limit: 1,
        })
        paymentMethodId = paymentMethods.data[0]?.id ?? null
      } catch (error) {
        skippedPayment += occurrences.length
        errors.push({
          recurringBookingId: row.id,
          error: error instanceof Error ? error.message : 'Failed to list payment methods',
        })
        continue
      }

      if (!paymentMethodId) {
        skippedPayment += occurrences.length
        errors.push({ recurringBookingId: row.id, error: 'No saved card found' })
        continue
      }

      for (const occurrenceIso of occurrences) {
        const duplicateKey = `${row.id}::${occurrenceIso}`
        if (existingKeys.has(duplicateKey)) {
          skippedDuplicates += 1
          continue
        }

        const platformFee = Math.round((amount * PLATFORM_FEE_PERCENT) / 100)
        const walkerAmount = amount - platformFee

        let paymentIntent: Stripe.PaymentIntent
        try {
          paymentIntent = await stripe.paymentIntents.create({
            amount,
            currency: DEFAULT_MARKET_CURRENCY,
            customer: customerId,
            payment_method: paymentMethodId,
            confirm: true,
            off_session: true,
            capture_method: 'manual',
            transfer_group: `recurring_${row.id}_${occurrenceIso}`,
            metadata: {
              recurring_booking_id: row.id,
              client_id: row.client_id,
              booking_timing: 'scheduled',
              scheduled_for: occurrenceIso,
              service_type: row.service_type,
              dog_name: row.dog_name ?? '',
              generated_by: 'generate-recurring-bookings',
            },
          })
        } catch (error) {
          skippedPayment += 1
          errors.push({
            recurringBookingId: row.id,
            occurrence: occurrenceIso,
            error: error instanceof Error ? error.message : 'Failed to create payment intent',
          })
          continue
        }

        const paymentStatus = paymentStatusFromIntent(paymentIntent.status)
        if (paymentStatus !== 'authorized' && paymentStatus !== 'paid') {
          skippedPayment += 1
          errors.push({
            recurringBookingId: row.id,
            occurrence: occurrenceIso,
            error: `Payment intent not authorized (${paymentIntent.status})`,
          })
          try {
            await stripe.paymentIntents.cancel(paymentIntent.id)
          } catch {
            // noop
          }
          continue
        }

        const paymentAuthorizedAt =
          paymentStatus === 'authorized' || paymentStatus === 'paid'
            ? new Date().toISOString()
            : null
        const paidAt = paymentStatus === 'paid' ? new Date().toISOString() : null

        const { error: insertError } = await supabase.from('walk_requests').insert({
          client_id: row.client_id,
          selected_walker_id: row.provider_id ?? null,
          recurring_booking_id: row.id,
          service_type: row.service_type,
          dog_name: row.dog_name?.trim() ?? '',
          dog_count: normalizeDogCount(row.dog_count),
          location: row.location.trim(),
          address: (row.address ?? row.location).trim(),
          notes: row.notes?.trim() || null,
          status: 'open',
          dispatch_state: 'queued',
          smart_dispatch_state: 'idle',
          smart_dispatch_last_error: null,
          payment_status: paymentStatus,
          payment_authorized_at: paymentAuthorizedAt,
          paid_at: paidAt,
          booking_timing: 'scheduled',
          scheduled_for: occurrenceIso,
          scheduled_fee_snapshot: amount / 100,
          scheduled_pricing_multiplier: 1,
          schedule_timezone: SCHEDULE_TIMEZONE,
          duration_minutes: row.duration_minutes,
          requested_window_minutes: row.duration_minutes,
          amount,
          currency: normalizeCurrency(paymentIntent.currency),
          platform_fee_percent: PLATFORM_FEE_PERCENT,
          platform_fee: platformFee / 100,
          walker_amount: walkerAmount / 100,
          walker_earnings: walkerAmount / 100,
          price: amount / 100,
          stripe_payment_intent_id: paymentIntent.id,
          stripe_client_secret: paymentIntent.client_secret,
        })

        if (insertError) {
          const isDuplicate =
            insertError.code === '23505' ||
            insertError.message.toLowerCase().includes('walk_requests_recurring_booking_occurrence_uidx')
          if (isDuplicate) {
            skippedDuplicates += 1
            existingKeys.add(duplicateKey)
            continue
          }

          errors.push({
            recurringBookingId: row.id,
            occurrence: occurrenceIso,
            error: insertError.message,
          })

          try {
            await stripe.paymentIntents.cancel(paymentIntent.id)
          } catch {
            // noop
          }
          continue
        }

        created += 1
        existingKeys.add(duplicateKey)
      }
    }

    return jsonResponse(200, {
      ok: true,
      scanned: recurringBookings.length,
      created,
      skippedDuplicates,
      skippedPayment,
      errors,
      _v: FUNCTION_VERSION,
    })
  } catch (error) {
    console.error('[generate-recurring-bookings] unhandled error', error)
    return jsonResponse(500, {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      _v: FUNCTION_VERSION,
    })
  }
})
