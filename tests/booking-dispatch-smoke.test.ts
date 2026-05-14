import assert from 'node:assert/strict'
import test from 'node:test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

type Json = Record<string, unknown>

type SmokeContext = {
  admin: SupabaseClient
  serviceRoleKey: string
  supabaseUrl: string
  runId: string
  createdUserIds: string[]
  createdRequestIds: string[]
  providerId: string
  asapClientId: string
  scheduledClientId: string
}

type WalkRequestRow = {
  id: string
  client_id: string
  booking_timing: 'asap' | 'scheduled' | null
  scheduled_for: string | null
  status: string | null
  dispatch_state: string | null
  smart_dispatch_state: string | null
  smart_dispatch_cursor?: number | null
  smart_dispatch_started_at?: string | null
  smart_dispatch_completed_at?: string | null
  smart_dispatch_expires_at?: string | null
  smart_assigned_attempt_id?: string | null
  payment_status: string | null
  stripe_payment_intent_id: string | null
  service_type: string | null
}

type DispatchAttemptRow = {
  id: string
  request_id: string
  walker_id: string | null
  status: string | null
  attempt_no: number | null
  expires_at: string | null
}

type DispatchCandidateRow = {
  id: string
  request_id: string
  walker_id: string | null
  score: number | null
  rank: number | null
  meta: Record<string, unknown> | null
}

type DispatchDebugSnapshot = {
  request: Record<string, unknown> | null
  providerProfile: Record<string, unknown> | null
  providerAvailability: Record<string, unknown>[]
  dispatchCandidates: Record<string, unknown>[]
  dispatchAttempts: Record<string, unknown>[]
  dispatchEvents: Record<string, unknown>[]
  matchingLogs: Record<string, unknown>[] | null
  matchingLogsError: string | null
}

const REQUIRED_ENV_VARS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_ANON_KEY',
] as const

const TEST_PASSWORD = 'RegliSmoke123!'
const TEST_SERVICE_TYPE = 'baby_sitter'
const TEST_LAT = 32.0853
const TEST_LNG = 34.7818
const BOOKING_PRICE_ILS = 35
const BOOKING_AMOUNT_AGOROT = BOOKING_PRICE_ILS * 100
const PLATFORM_FEE_ILS = 7
const WALKER_AMOUNT_ILS = 28
const REQUEST_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 1_000

function getMissingRequiredEnvVars(): string[] {
  return REQUIRED_ENV_VARS.filter((name) => !process.env[name])
}

function requireEnv(name: (typeof REQUIRED_ENV_VARS)[number]): string {
  const value = process.env[name]
  assert.ok(
    value,
    `Missing required env var ${name}. Required for booking smoke tests: ${REQUIRED_ENV_VARS.join(', ')}`,
  )
  return value
}

function buildAdminClient(): { admin: SupabaseClient; supabaseUrl: string; serviceRoleKey: string } {
  const supabaseUrl = requireEnv('SUPABASE_URL')
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY')
  requireEnv('SUPABASE_ANON_KEY')

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  return { admin, supabaseUrl, serviceRoleKey }
}

function headersWithServiceRole(serviceRoleKey: string): HeadersInit {
  return {
    Authorization: `Bearer ${serviceRoleKey}`,
    apikey: serviceRoleKey,
    'Content-Type': 'application/json',
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function createTestUser(
  admin: SupabaseClient,
  runId: string,
  role: 'client' | 'walker',
  suffix: string,
): Promise<{ id: string; email: string }> {
  const email = `smoke+${runId}-${suffix}@regli.test`
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: TEST_PASSWORD,
    email_confirm: true,
    user_metadata: { smoke_test: true, role, run_id: runId },
  })

  if (error || !data.user) {
    throw new Error(`Failed to create ${role} auth user ${email}: ${error?.message ?? 'unknown error'}`)
  }

  return { id: data.user.id, email }
}

async function upsertProfile(
  admin: SupabaseClient,
  input: {
    id: string
    email: string
    fullName: string
    role: 'client' | 'walker'
    isOnline?: boolean
  },
): Promise<void> {
  const row: Record<string, unknown> = {
    id: input.id,
    email: input.email,
    full_name: input.fullName,
    role: input.role,
    service_type: TEST_SERVICE_TYPE,
    service_types: [TEST_SERVICE_TYPE],
    service_attributes: { [TEST_SERVICE_TYPE]: { smoke_test: true } },
    last_lat: TEST_LAT,
    last_lng: TEST_LNG,
  }

  if (input.role === 'walker') {
    row.is_online = input.isOnline === true
  }

  const { error } = await admin.from('profiles').upsert(row)
  if (error) {
    throw new Error(`Failed to upsert ${input.role} profile ${input.id}: ${error.message}`)
  }
}

async function seedProviderAvailability(admin: SupabaseClient, providerId: string): Promise<void> {
  const rows = Array.from({ length: 7 }, (_, dayOfWeek) => ({
    provider_id: providerId,
    service_type: TEST_SERVICE_TYPE,
    day_of_week: dayOfWeek,
    start_time: '00:00:00',
    end_time: '23:59:00',
    is_active: true,
  }))

  const { error } = await admin.from('provider_availability').upsert(rows, {
    onConflict: 'provider_id,service_type,day_of_week',
  })

  if (error) {
    throw new Error(`Failed to seed provider availability: ${error.message}`)
  }
}

async function createAuthorizedRequest(
  admin: SupabaseClient,
  input: {
    clientId: string
    dogName: string
    bookingTiming: 'asap' | 'scheduled'
    scheduledFor?: string | null
  },
): Promise<WalkRequestRow> {
  const nowIso = new Date().toISOString()
  const stripeStub = `pi_smoke_${input.bookingTiming}_${Date.now()}`

  const insertRow: Record<string, unknown> = {
    client_id: input.clientId,
    service_type: TEST_SERVICE_TYPE,
    dog_name: input.dogName,
    location: `Smoke address ${input.bookingTiming}`,
    address: `Smoke address ${input.bookingTiming}`,
    user_lat: TEST_LAT,
    user_lng: TEST_LNG,
    notes: `[SMOKE_TEST:${input.bookingTiming}] booking-dispatch smoke`,
    status: 'open',
    walker_id: null,
    selected_walker_id: null,
    dispatch_state: 'queued',
    smart_dispatch_state: 'idle',
    smart_dispatch_cursor: 0,
    smart_dispatch_started_at: null,
    smart_dispatch_completed_at: null,
    smart_dispatch_expires_at: null,
    smart_assigned_attempt_id: null,
    smart_dispatch_last_error: null,
    payment_status: 'authorized',
    payment_authorized_at: nowIso,
    booking_timing: input.bookingTiming,
    scheduled_for: input.scheduledFor ?? null,
    scheduled_fee_snapshot: BOOKING_PRICE_ILS,
    scheduled_pricing_multiplier: 1,
    schedule_timezone: input.bookingTiming === 'scheduled' ? 'Asia/Jerusalem' : null,
    duration_minutes: 60,
    requested_window_minutes: 60,
    amount: BOOKING_AMOUNT_AGOROT,
    currency: 'ILS',
    platform_fee_percent: 20,
    platform_fee: PLATFORM_FEE_ILS,
    walker_amount: WALKER_AMOUNT_ILS,
    walker_earnings: WALKER_AMOUNT_ILS,
    price: BOOKING_PRICE_ILS,
    stripe_payment_intent_id: stripeStub,
    stripe_client_secret: `${stripeStub}_secret_smoke`,
  }

  const { data, error } = await admin
    .from('walk_requests')
    .insert(insertRow)
    .select(
      'id, client_id, booking_timing, scheduled_for, status, dispatch_state, smart_dispatch_state, smart_dispatch_cursor, smart_dispatch_started_at, smart_dispatch_completed_at, smart_dispatch_expires_at, smart_assigned_attempt_id, payment_status, stripe_payment_intent_id, service_type',
    )
    .single()

  if (error || !data) {
    throw new Error(`Failed to create smoke walk_request (${input.bookingTiming}): ${error?.message ?? 'unknown error'}`)
  }

  const insertedRow = data as WalkRequestRow

  console.log('[booking-dispatch-smoke] inserted smoke request', {
    bookingTiming: input.bookingTiming,
    requestId: insertedRow.id,
    insertPayload: insertRow,
    insertedState: {
      status: insertedRow.status ?? null,
      dispatch_state: insertedRow.dispatch_state ?? null,
      smart_dispatch_state: insertedRow.smart_dispatch_state ?? null,
      smart_dispatch_cursor: insertedRow.smart_dispatch_cursor ?? null,
      smart_dispatch_started_at: insertedRow.smart_dispatch_started_at ?? null,
      smart_dispatch_completed_at: insertedRow.smart_dispatch_completed_at ?? null,
      smart_dispatch_expires_at: insertedRow.smart_dispatch_expires_at ?? null,
      smart_assigned_attempt_id: insertedRow.smart_assigned_attempt_id ?? null,
      payment_status: insertedRow.payment_status ?? null,
      scheduled_for: insertedRow.scheduled_for ?? null,
    },
  })

  const invalidPreDispatchState =
    insertedRow.dispatch_state !== 'queued' ||
    insertedRow.smart_dispatch_state !== 'idle' ||
    (insertedRow.smart_dispatch_cursor ?? 0) !== 0 ||
    insertedRow.smart_dispatch_started_at != null ||
    insertedRow.smart_dispatch_completed_at != null ||
    insertedRow.smart_dispatch_expires_at != null ||
    insertedRow.smart_assigned_attempt_id != null

  if (invalidPreDispatchState) {
    throw new Error(
      `Smoke request fixture/default/trigger is wrong for ${input.bookingTiming}: expected queued/idle pre-dispatch state, got ${JSON.stringify({
        insertPayload: insertRow,
        requestId: insertedRow.id,
        dispatch_state: insertedRow.dispatch_state ?? null,
        smart_dispatch_state: insertedRow.smart_dispatch_state ?? null,
        smart_dispatch_cursor: insertedRow.smart_dispatch_cursor ?? null,
        smart_dispatch_started_at: insertedRow.smart_dispatch_started_at ?? null,
        smart_dispatch_completed_at: insertedRow.smart_dispatch_completed_at ?? null,
        smart_dispatch_expires_at: insertedRow.smart_dispatch_expires_at ?? null,
        smart_assigned_attempt_id: insertedRow.smart_assigned_attempt_id ?? null,
      })}`,
    )
  }

  return insertedRow
}

async function invokeFunction<T>(
  supabaseUrl: string,
  serviceRoleKey: string,
  functionName: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${supabaseUrl}/functions/v1/${functionName}`, {
    method: 'POST',
    headers: headersWithServiceRole(serviceRoleKey),
    body: body ? JSON.stringify(body) : '{}',
  })

  const json = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(`Function ${functionName} failed (${response.status}): ${JSON.stringify(json)}`)
  }
  return json as T
}

async function fetchDispatchDebugSnapshot(
  admin: SupabaseClient,
  requestId: string,
  providerId: string,
): Promise<DispatchDebugSnapshot> {
  const [
    requestResult,
    providerResult,
    availabilityResult,
    candidatesResult,
    attemptsResult,
    eventsResult,
    matchingLogsResult,
  ] = await Promise.all([
    admin.from('walk_requests').select('*').eq('id', requestId).maybeSingle(),
    admin
      .from('profiles')
      .select('id, role, is_online, service_type, service_types, last_lat, last_lng, service_attributes')
      .eq('id', providerId)
      .maybeSingle(),
    admin
      .from('provider_availability')
      .select('provider_id, service_type, day_of_week, start_time, end_time, is_active')
      .eq('provider_id', providerId)
      .order('day_of_week', { ascending: true }),
    admin
      .from('dispatch_candidates')
      .select('id, request_id, walker_id, score, rank, meta')
      .eq('request_id', requestId)
      .order('rank', { ascending: true }),
    admin
      .from('dispatch_attempts')
      .select('id, request_id, walker_id, status, attempt_no, expires_at')
      .eq('request_id', requestId)
      .order('attempt_no', { ascending: true }),
    admin
      .from('dispatch_events')
      .select('id, request_id, attempt_id, event_type, payload, created_at')
      .eq('request_id', requestId)
      .order('created_at', { ascending: true }),
    admin
      .from('matching_logs')
      .select('*')
      .eq('request_id', requestId)
      .order('created_at', { ascending: true }),
  ])

  return {
    request: (requestResult.data as Record<string, unknown> | null) ?? null,
    providerProfile: (providerResult.data as Record<string, unknown> | null) ?? null,
    providerAvailability: ((availabilityResult.data as Record<string, unknown>[] | null) ?? []),
    dispatchCandidates: ((candidatesResult.data as Record<string, unknown>[] | null) ?? []),
    dispatchAttempts: ((attemptsResult.data as Record<string, unknown>[] | null) ?? []),
    dispatchEvents: ((eventsResult.data as Record<string, unknown>[] | null) ?? []),
    matchingLogs: matchingLogsResult.error
      ? null
      : ((matchingLogsResult.data as Record<string, unknown>[] | null) ?? []),
    matchingLogsError: matchingLogsResult.error?.message ?? null,
  }
}

async function waitForDispatchState(
  admin: SupabaseClient,
  requestId: string,
  providerId: string,
): Promise<{
  request: WalkRequestRow
  attempts: DispatchAttemptRow[]
  candidates: DispatchCandidateRow[]
}> {
  const deadline = Date.now() + REQUEST_TIMEOUT_MS

  while (Date.now() < deadline) {
    const [{ data: request, error: requestError }, { data: attempts, error: attemptsError }, { data: candidates, error: candidatesError }] =
      await Promise.all([
        admin
          .from('walk_requests')
          .select('id, client_id, booking_timing, scheduled_for, status, dispatch_state, smart_dispatch_state, payment_status, stripe_payment_intent_id, service_type')
          .eq('id', requestId)
          .single(),
        admin
          .from('dispatch_attempts')
          .select('id, request_id, walker_id, status, attempt_no, expires_at')
          .eq('request_id', requestId)
          .order('attempt_no', { ascending: true }),
        admin
          .from('dispatch_candidates')
          .select('id, request_id, walker_id, score, rank, meta')
          .eq('request_id', requestId)
          .order('rank', { ascending: true }),
      ])

    if (requestError) {
      throw new Error(`Failed to fetch smoke request ${requestId}: ${requestError.message}`)
    }
    if (attemptsError) {
      throw new Error(`Failed to fetch smoke dispatch_attempts ${requestId}: ${attemptsError.message}`)
    }
    if (candidatesError) {
      throw new Error(`Failed to fetch smoke dispatch_candidates ${requestId}: ${candidatesError.message}`)
    }

    const requestRow = request as WalkRequestRow
    const attemptRows = (attempts as DispatchAttemptRow[] | null) ?? []
    const candidateRows = (candidates as DispatchCandidateRow[] | null) ?? []

    if (attemptRows.length > 0 && candidateRows.length > 0) {
      return {
        request: requestRow,
        attempts: attemptRows,
        candidates: candidateRows,
      }
    }

    await delay(POLL_INTERVAL_MS)
  }

  const debugSnapshot = await fetchDispatchDebugSnapshot(admin, requestId, providerId)
  console.error('[booking-dispatch-smoke] dispatch rows missing after timeout', {
    requestId,
    providerId,
    debugSnapshot,
  })
  throw new Error(
    `Timed out waiting for dispatch rows for request ${requestId}. Debug snapshot: ${JSON.stringify(debugSnapshot)}`,
  )
}

async function assertCronHealth(admin: SupabaseClient): Promise<void> {
  const { data, error } = await admin.rpc('get_run_scheduled_dispatch_cron_health')
  if (error) {
    throw new Error(`Failed to query get_run_scheduled_dispatch_cron_health(): ${error.message}`)
  }

  const healthRows = (data as Array<{
    cron_schema_available: boolean | null
    job_exists: boolean | null
    job_active: boolean | null
    job_schedule: string | null
    recent_run_status: string | null
    recent_return_message: string | null
    recent_started_at: string | null
  }> | null) ?? []

  assert.ok(healthRows.length > 0, 'Expected get_run_scheduled_dispatch_cron_health() to return one row')

  const health = healthRows[0]
  assert.equal(
    health.cron_schema_available,
    true,
    'Expected cron schema/extension to be available for run-scheduled-dispatch health checks',
  )
  assert.equal(
    health.job_exists,
    true,
    'Expected a configured cron job for run-scheduled-dispatch',
  )
  assert.equal(
    health.job_active,
    true,
    'Expected the run-scheduled-dispatch cron job to be active',
  )

  const returnMessage = health.recent_return_message ?? ''
  const looksMisconfigured =
    /current_setting|app\.settings|null\/functions\/v1\/run-scheduled-dispatch|your-project\.supabase\.co/i.test(returnMessage)

  assert.equal(
    health.recent_run_status,
    'succeeded',
    `run-scheduled-dispatch cron latest run is not succeeded: ${health.recent_run_status ?? 'unknown'} / ${returnMessage}`,
  )
  assert.ok(
    !looksMisconfigured,
    `run-scheduled-dispatch cron looks misconfigured: ${returnMessage || '[empty return_message]'}`,
  )
}

async function cleanup(context: SmokeContext): Promise<void> {
  const { admin, createdRequestIds, providerId, createdUserIds } = context

  if (createdRequestIds.length > 0) {
    const ids = Array.from(new Set(createdRequestIds))
    await admin.from('notifications').delete().in('related_job_id', ids)
    await admin.from('dispatch_events').delete().in('request_id', ids)
    await admin.from('dispatch_attempts').delete().in('request_id', ids)
    await admin.from('dispatch_candidates').delete().in('request_id', ids)
    await admin.from('walk_requests').delete().in('id', ids)
  }

  if (providerId) {
    await admin.from('provider_availability').delete().eq('provider_id', providerId)
  }

  if (createdUserIds.length > 0) {
    const ids = Array.from(new Set(createdUserIds))
    await admin.from('profiles').delete().in('id', ids)
    for (const userId of ids) {
      await admin.auth.admin.deleteUser(userId)
    }
  }
}

test('booking dispatch smoke covers cron health, ASAP dispatch, and scheduled dispatch', { timeout: 180_000 }, async (t) => {
  const missingEnvVars = getMissingRequiredEnvVars()
  if (missingEnvVars.length > 0) {
    t.skip(`Booking smoke env not configured: ${missingEnvVars.join(', ')}`)
    return
  }

  const { admin, supabaseUrl, serviceRoleKey } = buildAdminClient()
  const runId = `smoke-${Date.now()}`

  const context: SmokeContext = {
    admin,
    supabaseUrl,
    serviceRoleKey,
    runId,
    createdUserIds: [],
    createdRequestIds: [],
    providerId: '',
    asapClientId: '',
    scheduledClientId: '',
  }

  t.after(async () => {
    await cleanup(context)
  })

  await assertCronHealth(admin)

  const provider = await createTestUser(admin, runId, 'walker', 'provider')
  const asapClient = await createTestUser(admin, runId, 'client', 'client-asap')
  const scheduledClient = await createTestUser(admin, runId, 'client', 'client-scheduled')
  context.createdUserIds.push(provider.id, asapClient.id, scheduledClient.id)
  context.providerId = provider.id
  context.asapClientId = asapClient.id
  context.scheduledClientId = scheduledClient.id

  await upsertProfile(admin, {
    id: provider.id,
    email: provider.email,
    fullName: 'Smoke Provider',
    role: 'walker',
    isOnline: true,
  })
  await upsertProfile(admin, {
    id: asapClient.id,
    email: asapClient.email,
    fullName: 'Smoke Client ASAP',
    role: 'client',
  })
  await upsertProfile(admin, {
    id: scheduledClient.id,
    email: scheduledClient.email,
    fullName: 'Smoke Client Scheduled',
    role: 'client',
  })

  await seedProviderAvailability(admin, provider.id)

  const providerFixture = await fetchDispatchDebugSnapshot(admin, '00000000-0000-0000-0000-000000000000', provider.id)
  assert.equal(providerFixture.providerProfile?.role, 'walker')
  assert.equal(providerFixture.providerProfile?.is_online, true)
  assert.equal(providerFixture.providerProfile?.service_type, TEST_SERVICE_TYPE)
  assert.ok(
    Array.isArray(providerFixture.providerAvailability) && providerFixture.providerAvailability.length >= 7,
    'Expected smoke provider availability rows for all weekdays',
  )

  const asapRequest = await createAuthorizedRequest(admin, {
    clientId: asapClient.id,
    dogName: `Smoke ASAP ${runId}`,
    bookingTiming: 'asap',
  })
  context.createdRequestIds.push(asapRequest.id)

  assert.equal(asapRequest.booking_timing, 'asap')
  assert.ok(
    asapRequest.dispatch_state === 'queued' || asapRequest.dispatch_state === 'dispatched',
    `ASAP smoke request should start queued or already dispatched, got ${asapRequest.dispatch_state ?? 'null'}`,
  )
  if (asapRequest.dispatch_state === 'queued') {
    assert.equal(asapRequest.smart_dispatch_state, 'idle')
  }
  assert.ok(asapRequest.stripe_payment_intent_id, 'ASAP smoke request should have a fake authorized payment intent id')

  if (asapRequest.dispatch_state !== 'dispatched') {
    const asapStart = await invokeFunction<{
      ok?: boolean
      attemptId?: string
      insertedCandidatesCount?: number
      error?: string
      details?: string
    }>(supabaseUrl, serviceRoleKey, 'start-dispatch', {
      requestId: asapRequest.id,
      resetExisting: true,
      rankedCandidates: [
        {
          walkerId: provider.id,
          score: 0.99,
          meta: {
            source: 'booking-smoke',
            base_score: 0.99,
            attribute_score: 0,
            attribute_reason: 'smoke_test',
            attribute_matches: [],
          },
        },
      ],
    })

    assert.equal(
      asapStart.ok,
      true,
      `start-dispatch ASAP should succeed: ${JSON.stringify(asapStart)}`,
    )
    assert.ok(asapStart.attemptId, 'ASAP start-dispatch should return a pending attempt id')
  }

  const asapDispatch = await waitForDispatchState(admin, asapRequest.id, provider.id)
  assert.equal(asapDispatch.request.booking_timing, 'asap')
  assert.equal(asapDispatch.request.status, 'open')
  assert.equal(
    asapDispatch.request.dispatch_state,
    'dispatched',
    'ASAP request should only become dispatched once live dispatch rows exist',
  )
  assert.equal(asapDispatch.request.smart_dispatch_state, 'dispatching')
  assert.ok(asapDispatch.candidates.length > 0, 'ASAP dispatch should create dispatch_candidates rows')
  assert.ok(asapDispatch.attempts.length > 0, 'ASAP dispatch should create dispatch_attempts rows')
  assert.equal(asapDispatch.candidates[0]?.walker_id, provider.id)
  assert.equal(asapDispatch.attempts[0]?.walker_id, provider.id)
  assert.equal(asapDispatch.attempts[0]?.status, 'pending')

  const scheduledForDate = new Date(Date.now() + 5 * 60 * 1000)
  const scheduledRequest = await createAuthorizedRequest(admin, {
    clientId: scheduledClient.id,
    dogName: `Smoke Scheduled ${runId}`,
    bookingTiming: 'scheduled',
    scheduledFor: scheduledForDate.toISOString(),
  })
  context.createdRequestIds.push(scheduledRequest.id)

  assert.equal(scheduledRequest.booking_timing, 'scheduled')
  assert.ok(scheduledRequest.scheduled_for, 'Scheduled smoke request should persist scheduled_for')
  assert.ok(
    scheduledRequest.dispatch_state === 'queued' || scheduledRequest.dispatch_state === 'dispatched',
    `Scheduled smoke request should start queued or already dispatched, got ${scheduledRequest.dispatch_state ?? 'null'}`,
  )
  if (scheduledRequest.dispatch_state === 'queued') {
    assert.equal(scheduledRequest.smart_dispatch_state, 'idle')
  }

  if (scheduledRequest.dispatch_state !== 'dispatched') {
    const scheduledRun = await invokeFunction<{
      ok?: boolean
      scanned?: number
      eligible?: number
      started?: number
      noCandidates?: number
      error?: string
      details?: string
    }>(supabaseUrl, serviceRoleKey, 'run-scheduled-dispatch')

    assert.equal(
      scheduledRun.ok,
      true,
      `run-scheduled-dispatch should succeed: ${JSON.stringify(scheduledRun)}`,
    )
  }

  const scheduledDispatch = await waitForDispatchState(admin, scheduledRequest.id, provider.id)
  assert.equal(scheduledDispatch.request.booking_timing, 'scheduled')
  assert.ok(scheduledDispatch.request.scheduled_for, 'Scheduled request should still have scheduled_for after dispatch')
  assert.ok(scheduledDispatch.candidates.length > 0, 'Scheduled dispatch should create dispatch_candidates rows')
  assert.ok(scheduledDispatch.attempts.length > 0, 'Scheduled dispatch should create dispatch_attempts rows')
  assert.equal(scheduledDispatch.candidates[0]?.walker_id, provider.id)
  assert.equal(scheduledDispatch.attempts[0]?.walker_id, provider.id)
  assert.equal(
    scheduledDispatch.request.dispatch_state,
    'dispatched',
    'Scheduled request should only become dispatched once a live attempt exists',
  )
  assert.equal(scheduledDispatch.request.smart_dispatch_state, 'dispatching')
})
