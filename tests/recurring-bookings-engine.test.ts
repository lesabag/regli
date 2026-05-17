import assert from 'node:assert/strict'
import test from 'node:test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

type RecurringEngineContext = {
  admin: SupabaseClient
  supabaseUrl: string
  serviceRoleKey: string
  stripeSecretKey: string
  runId: string
  createdUserIds: string[]
  createdRecurringIds: string[]
  createdRequestIds: string[]
}

type GeneratedWalkRequestRow = {
  id: string
  recurring_booking_id: string | null
  booking_timing: string | null
  scheduled_for: string | null
  service_type: string | null
  dog_count: number | null
  duration_minutes: number | null
  price: number | null
  payment_status: string | null
}

const REQUIRED_ENV_VARS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_ANON_KEY',
  'STRIPE_SECRET_KEY',
] as const

const TEST_PASSWORD = 'RegliRecurring123!'
const TEST_LOCATION = 'Recurring test address'
const TEST_SERVICE_TYPE = 'dog_walker'
const TEST_PRICE_PER_VISIT = 75
const TEST_DURATION_MINUTES = 60

function getMissingRequiredEnvVars(): string[] {
  return REQUIRED_ENV_VARS.filter((name) => !process.env[name])
}

function requireEnv(name: (typeof REQUIRED_ENV_VARS)[number]): string {
  const value = process.env[name]
  assert.ok(value, `Missing required env var ${name}`)
  return value
}

function buildAdminClient(): { admin: SupabaseClient; supabaseUrl: string; serviceRoleKey: string; stripeSecretKey: string } {
  const supabaseUrl = requireEnv('SUPABASE_URL')
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY')
  const stripeSecretKey = requireEnv('STRIPE_SECRET_KEY')
  requireEnv('SUPABASE_ANON_KEY')

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  return { admin, supabaseUrl, serviceRoleKey, stripeSecretKey }
}

function headersWithServiceRole(serviceRoleKey: string): HeadersInit {
  return {
    Authorization: `Bearer ${serviceRoleKey}`,
    apikey: serviceRoleKey,
    'Content-Type': 'application/json',
  }
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
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

function localDateString(date: Date, timeZone: string): string {
  const { year, month, day } = toLocalDateParts(date, timeZone)
  return `${year}-${pad(month)}-${pad(day)}`
}

function addLocalDays(base: Date, timeZone: string, offset: number): string {
  const { year, month, day } = toLocalDateParts(base, timeZone)
  const shifted = new Date(Date.UTC(year, month - 1, day + offset, 12, 0, 0, 0))
  return localDateString(shifted, 'UTC')
}

function getWeekday(dateValue: string): number {
  const match = dateValue.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  assert.ok(match, `Invalid date value ${dateValue}`)
  const [, year, month, day] = match
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12, 0, 0, 0)).getUTCDay()
}

async function createTestUser(admin: SupabaseClient, runId: string): Promise<{ id: string; email: string }> {
  const email = `recurring+${runId}@regli.test`
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: TEST_PASSWORD,
    email_confirm: true,
    user_metadata: { recurring_engine_test: true, run_id: runId, role: 'client' },
  })

  if (error || !data.user) {
    throw new Error(`Failed to create recurring test user: ${error?.message ?? 'unknown error'}`)
  }

  return { id: data.user.id, email }
}

async function createStripeCustomerAndCard(stripeSecretKey: string): Promise<{ customerId: string; paymentMethodId: string }> {
  const customerResponse = await fetch('https://api.stripe.com/v1/customers', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${stripeSecretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      description: 'Regli recurring engine integration test',
      email: `recurring-engine-${Date.now()}@regli.test`,
    }),
  })
  assert.equal(customerResponse.ok, true, `Stripe customer create failed: ${await customerResponse.text()}`)
  const customerJson = await customerResponse.json() as { id: string }

  const paymentMethodResponse = await fetch('https://api.stripe.com/v1/payment_methods', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${stripeSecretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      type: 'card',
      'card[number]': '4242424242424242',
      'card[exp_month]': '12',
      'card[exp_year]': '2034',
      'card[cvc]': '123',
    }),
  })
  assert.equal(paymentMethodResponse.ok, true, `Stripe payment method create failed: ${await paymentMethodResponse.text()}`)
  const paymentMethodJson = await paymentMethodResponse.json() as { id: string }

  const attachResponse = await fetch(`https://api.stripe.com/v1/payment_methods/${paymentMethodJson.id}/attach`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${stripeSecretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      customer: customerJson.id,
    }),
  })
  assert.equal(attachResponse.ok, true, `Stripe payment method attach failed: ${await attachResponse.text()}`)

  return { customerId: customerJson.id, paymentMethodId: paymentMethodJson.id }
}

async function upsertClientProfile(
  admin: SupabaseClient,
  input: { id: string; email: string; customerId: string },
): Promise<void> {
  const { error } = await admin.from('profiles').upsert({
    id: input.id,
    email: input.email,
    full_name: 'Recurring Engine Test Client',
    role: 'client',
    service_type: TEST_SERVICE_TYPE,
    service_types: [TEST_SERVICE_TYPE],
    stripe_customer_id: input.customerId,
  })

  if (error) {
    throw new Error(`Failed to upsert recurring test profile: ${error.message}`)
  }
}

async function invokeRecurringGenerator(supabaseUrl: string, serviceRoleKey: string): Promise<{
  ok?: boolean
  scanned?: number
  created?: number
  skippedDuplicates?: number
  skippedPayment?: number
  errors?: Array<Record<string, unknown>>
}> {
  const response = await fetch(`${supabaseUrl}/functions/v1/generate-recurring-bookings`, {
    method: 'POST',
    headers: headersWithServiceRole(serviceRoleKey),
    body: JSON.stringify({}),
  })

  const text = await response.text()
  let body: Record<string, unknown> = {}
  try {
    body = text ? JSON.parse(text) as Record<string, unknown> : {}
  } catch {
    throw new Error(`Recurring engine returned non-JSON body: ${text}`)
  }

  assert.equal(response.ok, true, `Recurring engine invoke failed (${response.status}): ${text}`)
  return body as {
    ok?: boolean
    scanned?: number
    created?: number
    skippedDuplicates?: number
    skippedPayment?: number
    errors?: Array<Record<string, unknown>>
  }
}

async function cleanupContext(ctx: RecurringEngineContext): Promise<void> {
  if (ctx.createdRequestIds.length > 0) {
    await ctx.admin.from('walk_requests').delete().in('id', ctx.createdRequestIds)
  }

  if (ctx.createdRecurringIds.length > 0) {
    await ctx.admin.from('recurring_bookings').delete().in('id', ctx.createdRecurringIds)
  }

  for (const userId of ctx.createdUserIds) {
    await ctx.admin.auth.admin.deleteUser(userId)
  }
}

test('recurring engine generates scheduled requests and remains idempotent', { timeout: 120_000 }, async (t) => {
  const missingEnv = getMissingRequiredEnvVars()
  if (missingEnv.length > 0) {
    t.skip(`Recurring engine env not configured: ${missingEnv.join(', ')}`)
    return
  }

  const { admin, supabaseUrl, serviceRoleKey, stripeSecretKey } = buildAdminClient()
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const ctx: RecurringEngineContext = {
    admin,
    supabaseUrl,
    serviceRoleKey,
    stripeSecretKey,
    runId,
    createdUserIds: [],
    createdRecurringIds: [],
    createdRequestIds: [],
  }

  t.after(async () => {
    await cleanupContext(ctx)
  })

  const authUser = await createTestUser(admin, runId)
  ctx.createdUserIds.push(authUser.id)

  const stripeFixture = await createStripeCustomerAndCard(stripeSecretKey)
  assert.ok(stripeFixture.paymentMethodId, 'Expected attached Stripe test card')

  await upsertClientProfile(admin, {
    id: authUser.id,
    email: authUser.email,
    customerId: stripeFixture.customerId,
  })

  const now = new Date()
  const repeatStartsOn = addLocalDays(now, 'Asia/Jerusalem', 1)
  const repeatEndsOn = addLocalDays(now, 'Asia/Jerusalem', 3)
  const occurrenceDates = [
    repeatStartsOn,
    addLocalDays(now, 'Asia/Jerusalem', 2),
    repeatEndsOn,
  ]
  const repeatDays = occurrenceDates.map((dateValue) => getWeekday(dateValue))
  const expectedScheduledFor = occurrenceDates
    .map((dateValue) => parseLocalDateTimeInTimeZoneToUTC(`${dateValue}T18:30`, 'Asia/Jerusalem'))
    .filter((value): value is string => value !== null)
    .sort()

  assert.equal(expectedScheduledFor.length, 3, 'Expected exactly three future recurring occurrences in window')

  const { data: recurringInsert, error: recurringError } = await admin
    .from('recurring_bookings')
    .insert({
      client_id: authUser.id,
      provider_id: null,
      service_type: TEST_SERVICE_TYPE,
      dog_name: `Recurring Test ${runId}`,
      dog_count: 2,
      location: TEST_LOCATION,
      address: TEST_LOCATION,
      notes: `[RECURRING_TEST:${runId}]`,
      duration_minutes: TEST_DURATION_MINUTES,
      price_per_visit: TEST_PRICE_PER_VISIT,
      repeat_type: 'weekly',
      repeat_days: repeatDays,
      repeat_starts_on: repeatStartsOn,
      repeat_ends_on: repeatEndsOn,
      start_time: '18:30:00',
      recurring_status: 'active',
    })
    .select('id')
    .single()

  if (recurringError || !recurringInsert) {
    throw new Error(`Failed to insert recurring booking fixture: ${recurringError?.message ?? 'unknown error'}`)
  }

  const recurringBookingId = recurringInsert.id as string
  ctx.createdRecurringIds.push(recurringBookingId)

  const firstRun = await invokeRecurringGenerator(supabaseUrl, serviceRoleKey)
  assert.equal(firstRun.ok, true)
  assert.ok((firstRun.created ?? 0) >= 3, `Expected generator to create at least 3 rows, got ${firstRun.created ?? 0}`)

  const { data: generatedRowsFirst, error: generatedRowsErrorFirst } = await admin
    .from('walk_requests')
    .select('id, recurring_booking_id, booking_timing, scheduled_for, service_type, dog_count, duration_minutes, price, payment_status')
    .eq('recurring_booking_id', recurringBookingId)
    .order('scheduled_for', { ascending: true })

  if (generatedRowsErrorFirst || !generatedRowsFirst) {
    throw new Error(`Failed to load generated recurring requests: ${generatedRowsErrorFirst?.message ?? 'unknown error'}`)
  }

  const generatedFirst = generatedRowsFirst as GeneratedWalkRequestRow[]
  ctx.createdRequestIds.push(...generatedFirst.map((row) => row.id))

  assert.equal(generatedFirst.length, expectedScheduledFor.length, 'Generated row count should match expected occurrences')
  assert.deepEqual(
    generatedFirst.map((row) => row.scheduled_for),
    expectedScheduledFor,
    'Generated scheduled_for values should match expected recurring occurrences',
  )

  for (const row of generatedFirst) {
    assert.equal(row.booking_timing, 'scheduled')
    assert.equal(row.recurring_booking_id, recurringBookingId)
    assert.equal(row.service_type, TEST_SERVICE_TYPE)
    assert.equal(row.dog_count, 2)
    assert.equal(row.duration_minutes, TEST_DURATION_MINUTES)
    assert.equal(row.price, TEST_PRICE_PER_VISIT)
    assert.equal(row.payment_status, 'authorized')
  }

  const uniqueScheduledFor = new Set(generatedFirst.map((row) => row.scheduled_for))
  assert.equal(uniqueScheduledFor.size, generatedFirst.length, 'Generated rows should not include duplicate scheduled_for values')

  const secondRun = await invokeRecurringGenerator(supabaseUrl, serviceRoleKey)
  assert.equal(secondRun.ok, true)
  assert.ok((secondRun.created ?? 0) === 0, `Expected second run to create 0 rows, got ${secondRun.created ?? 0}`)
  assert.ok((secondRun.skippedDuplicates ?? 0) >= expectedScheduledFor.length, 'Expected second run to report duplicate skips')

  const { data: generatedRowsSecond, error: generatedRowsErrorSecond } = await admin
    .from('walk_requests')
    .select('id, recurring_booking_id, booking_timing, scheduled_for, service_type, dog_count, duration_minutes, price, payment_status')
    .eq('recurring_booking_id', recurringBookingId)
    .order('scheduled_for', { ascending: true })

  if (generatedRowsErrorSecond || !generatedRowsSecond) {
    throw new Error(`Failed to reload generated recurring requests after rerun: ${generatedRowsErrorSecond?.message ?? 'unknown error'}`)
  }

  const generatedSecond = generatedRowsSecond as GeneratedWalkRequestRow[]
  assert.equal(generatedSecond.length, expectedScheduledFor.length, 'Second run should not create additional rows')

  const duplicateCountByKey = generatedSecond.reduce<Record<string, number>>((acc, row) => {
    const key = `${row.recurring_booking_id}::${row.scheduled_for}`
    acc[key] = (acc[key] ?? 0) + 1
    return acc
  }, {})

  for (const [key, count] of Object.entries(duplicateCountByKey)) {
    assert.equal(count, 1, `Expected uniqueness for generated recurring occurrence ${key}`)
  }
})
