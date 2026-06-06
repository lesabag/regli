import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import Stripe from 'https://esm.sh/stripe@17.5.0?target=denonext'
import {
  groupProviderAvailabilityRows,
  isProviderAvailableAt,
  type ProviderAvailabilityRow,
} from '../_shared/providerAvailability.ts'
import { evaluateDogSizeCompatibility, rankWalkerCandidates } from '../_shared/dispatchRanking.ts'
import { loadSelectedDogSizesForRequest, mergeSelectedDogSizesIntoClientAttributes } from '../_shared/requestDogSizes.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const PROVIDER_ISSUE_MARKER = '[SYSTEM:PROVIDER_REPORTED_ISSUE]'
const PROVIDER_REASSIGN_LOG = '[ProviderReassign]'
const DISPATCH_TIMEOUT_SECONDS = 60

type ReviewProviderIssueBody = {
  jobId?: string
  action?: 'resume' | 'reassign' | 'cancel'
}

type WalkerRow = {
  id: string
  service_type: string | null
  service_types?: string[] | string | null
  service_attributes?: Record<string, unknown> | null
}

type RatingRow = {
  to_user_id: string
  rating: number
}

type StartDispatchResponse = {
  ok?: boolean
  error?: string
  details?: string
  candidateCount?: number
  advanceResult?: {
    ok?: boolean
    message?: string
    attempt_id?: string
    attempt_no?: number
  } | null
}

function hasProviderIssue(notes: string | null | undefined): boolean {
  return typeof notes === 'string'
    ? notes.split('\n').some((line) => line.trim().startsWith(PROVIDER_ISSUE_MARKER))
    : false
}

function removeProviderIssueMarker(notes: string | null | undefined): string | null {
  if (typeof notes !== 'string') return null
  const nextNotes = notes
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => !line.trim().startsWith(PROVIDER_ISSUE_MARKER))
    .join('\n')
    .trim()

  return nextNotes || null
}

function normalizeProviderServiceType(value: string | null | undefined): 'dog_walker' | 'baby_sitter' | null {
  const normalized = (value ?? '').trim().toLowerCase()
  if (!normalized) return null
  if (normalized === 'dog_walking' || normalized === 'dog-walker' || normalized === 'dog_walker') {
    return 'dog_walker'
  }
  if (normalized === 'babysitter' || normalized === 'baby-sitter' || normalized === 'baby_sitter') {
    return 'baby_sitter'
  }
  return null
}

function providerSupportsRequestedService(
  profile: {
    service_types?: string[] | string | null
    service_type?: string | null
  },
  requestServiceType: 'dog_walker' | 'baby_sitter' | null,
): boolean {
  if (!requestServiceType) return true

  const rawServiceTypes = profile.service_types
  const serviceTypes =
    Array.isArray(rawServiceTypes)
      ? rawServiceTypes
      : typeof rawServiceTypes === 'string'
        ? rawServiceTypes
            .replace(/^\{|\}$/g, '')
            .split(',')
            .map((value) => value.trim().replace(/^"|"$/g, ''))
            .filter(Boolean)
        : null

  if (serviceTypes) {
    const normalizedServiceTypes = serviceTypes
      .map((value) => normalizeProviderServiceType(value))
      .filter((value): value is 'dog_walker' | 'baby_sitter' => value !== null)

    if (normalizedServiceTypes.length > 0) {
      return normalizedServiceTypes.includes(requestServiceType)
    }
  }

  return normalizeProviderServiceType(profile.service_type) === requestServiceType
}

async function createNotification(
  supabaseAdmin: ReturnType<typeof createClient>,
  params: { userId: string | null | undefined; type: string; title: string; message: string; relatedJobId: string },
) {
  if (!params.userId) return
  const { error } = await supabaseAdmin.from('notifications').insert({
    user_id: params.userId,
    type: params.type,
    title: params.title,
    message: params.message,
    related_job_id: params.relatedJobId,
  })

  if (error && error.code !== '23505') {
    console.error('[review-provider-issue] notification insert failed', {
      request_id: params.relatedJobId,
      user_id: params.userId,
      type: params.type,
      error: error.message,
    })
  }
}

async function buildRankedCandidatesForReassignment(params: {
  supabaseAdmin: ReturnType<typeof createClient>
  requestId: string
  clientId: string | null
  requestServiceType: string | null | undefined
  dogNameValue?: string | null
  bookingTiming: string | null | undefined
  scheduledFor: string | null | undefined
  excludedWalkerId: string | null
}) {
  const { supabaseAdmin, clientId, requestServiceType, dogNameValue, bookingTiming, scheduledFor, excludedWalkerId } = params
  const { data: walkers, error: walkersError } = await supabaseAdmin
    .from('profiles')
    .select('id, service_type, service_types, service_attributes')
    .eq('role', 'walker')
    .eq('is_online', true)

  if (walkersError) {
    throw new Error(`walker lookup failed: ${walkersError.message}`)
  }

  const requestedProviderServiceType = normalizeProviderServiceType(requestServiceType)
  const serviceMatchedWalkers = ((walkers as WalkerRow[] | null) ?? []).filter((walker) => {
    if (excludedWalkerId && walker.id === excludedWalkerId) return false
    return providerSupportsRequestedService(walker, requestedProviderServiceType)
  })
  let availabilityRows: ProviderAvailabilityRow[] = []
  if (serviceMatchedWalkers.length > 0) {
    const { data: availabilityData, error: availabilityError } = await supabaseAdmin
      .from('provider_availability')
      .select('provider_id, service_type, day_of_week, start_time, end_time, is_active')
      .in('provider_id', serviceMatchedWalkers.map((walker) => walker.id))
      .eq('is_active', true)

    if (availabilityError) {
      throw new Error(`provider availability lookup failed: ${availabilityError.message}`)
    }

    availabilityRows = (availabilityData as ProviderAvailabilityRow[] | null) ?? []
  }

  const availabilityByProvider = groupProviderAvailabilityRows(availabilityRows)
  const availabilityReferenceAt =
    bookingTiming === 'scheduled'
      ? scheduledFor
      : new Date().toISOString()
  const eligibleWalkers = serviceMatchedWalkers.filter((walker) =>
    availabilityReferenceAt
      ? isProviderAvailableAt(
          availabilityByProvider.get(walker.id) ?? [],
          requestedProviderServiceType,
          availabilityReferenceAt,
        )
      : false,
  )

  const walkerIds = eligibleWalkers.map((walker) => walker.id)
  let ratingsByWalker = new Map<string, { total: number; count: number }>()
  if (walkerIds.length > 0) {
    const { data: ratingsRows, error: ratingsError } = await supabaseAdmin
      .from('ratings')
      .select('to_user_id, rating')
      .in('to_user_id', walkerIds)

    if (ratingsError) {
      throw new Error(`ratings lookup failed: ${ratingsError.message}`)
    }

    ratingsByWalker = ((ratingsRows as RatingRow[] | null) ?? []).reduce((map, row) => {
      const current = map.get(row.to_user_id) ?? { total: 0, count: 0 }
      current.total += row.rating
      current.count += 1
      map.set(row.to_user_id, current)
      return map
    }, new Map<string, { total: number; count: number }>())
  }

  let providerSavedCustomerIds = new Set<string>()
  let customerSavedProviderIds = new Set<string>()
  let clientServiceAttributes: Record<string, unknown> | null = null

  const walkerServiceAttrsById = new Map<string, Record<string, unknown>>()
  for (const walker of eligibleWalkers) {
    if (walker.service_attributes && typeof walker.service_attributes === 'object') {
      walkerServiceAttrsById.set(walker.id, walker.service_attributes)
    }
  }

  if (walkerIds.length > 0 && clientId) {
    const [
      { data: favoriteCustomersRows, error: favoriteCustomersError },
      { data: favoriteWalkersRows, error: favoriteWalkersError },
      { data: clientProfileRow, error: clientProfileError },
    ] = await Promise.all([
      supabaseAdmin
        .from('favorite_customers')
        .select('walker_id')
        .eq('client_id', clientId)
        .in('walker_id', walkerIds),
      supabaseAdmin
        .from('favorite_walkers')
        .select('walker_id')
        .eq('client_id', clientId)
        .in('walker_id', walkerIds),
      supabaseAdmin
        .from('profiles')
        .select('service_attributes')
        .eq('id', clientId)
        .maybeSingle(),
    ])

    if (favoriteCustomersError) {
      console.warn(PROVIDER_REASSIGN_LOG, {
        requestId: params.requestId,
        action: 'favorite_customers_lookup',
        result: 'warning',
        error: favoriteCustomersError.message,
      })
    } else {
      providerSavedCustomerIds = new Set(
        ((favoriteCustomersRows as Array<{ walker_id: string | null }> | null) ?? [])
          .map((row) => row.walker_id)
          .filter((walkerId): walkerId is string => typeof walkerId === 'string' && walkerId.length > 0),
      )
    }

    if (favoriteWalkersError) {
      console.warn(PROVIDER_REASSIGN_LOG, {
        requestId: params.requestId,
        action: 'favorite_walkers_lookup',
        result: 'warning',
        error: favoriteWalkersError.message,
      })
    } else {
      customerSavedProviderIds = new Set(
        ((favoriteWalkersRows as Array<{ walker_id: string | null }> | null) ?? [])
          .map((row) => row.walker_id)
          .filter((walkerId): walkerId is string => typeof walkerId === 'string' && walkerId.length > 0),
      )
    }

    if (!clientProfileError) {
      const selectedDogSizes = await loadSelectedDogSizesForRequest({
        supabase: supabaseAdmin,
        clientId,
        dogNameValue: dogNameValue ?? null,
      })
      clientServiceAttributes = mergeSelectedDogSizesIntoClientAttributes(
        (clientProfileRow as { service_attributes?: unknown } | null)?.service_attributes as Record<string, unknown> | null ?? null,
        selectedDogSizes,
      )
    }
  }

  const dogSizeCompatibleWalkers = eligibleWalkers.filter((walker) => {
    const compatibility = evaluateDogSizeCompatibility(
      requestedProviderServiceType,
      clientServiceAttributes,
      walkerServiceAttrsById.get(walker.id) ?? null,
    )

    if (!compatibility.compatible) {
      console.warn(PROVIDER_REASSIGN_LOG, {
        requestId: params.requestId,
        action: 'dog_size_filter',
        result: 'excluded',
        walkerId: walker.id,
        reason: compatibility.reason,
        knownClientDogSizes: compatibility.knownClientDogSizes,
        providerAcceptedDogSizes: compatibility.providerAcceptedDogSizes,
        missingClientDogSizes: compatibility.missingClientDogSizes,
      })
    }

    return compatibility.compatible
  })

  const rankedCandidates = rankWalkerCandidates(
    dogSizeCompatibleWalkers.map((walker) => {
      const ratingStats = ratingsByWalker.get(walker.id)
      return {
        walkerId: walker.id,
        distanceKm: null,
        avgRating:
          ratingStats && ratingStats.count > 0
            ? ratingStats.total / ratingStats.count
            : null,
        reviewCount: ratingStats?.count ?? 0,
        affinityProviderSaved: providerSavedCustomerIds.has(walker.id),
        affinityClientSaved: customerSavedProviderIds.has(walker.id),
        serviceType: requestedProviderServiceType,
        clientServiceAttributes,
        providerServiceAttributes: walkerServiceAttrsById.get(walker.id) ?? null,
      }
    }),
  ).map((candidate) => ({
    walkerId: candidate.walkerId,
    score: candidate.score,
    meta: {
      source: 'provider-reassign',
      base_score: candidate.baseScore,
      affinity_score: candidate.affinityScore,
      affinity_provider_saved: candidate.affinityProviderSaved,
      affinity_client_saved: candidate.affinityClientSaved,
      distance_score: candidate.distanceScore,
      rating_score: candidate.ratingScore,
      review_count_score: candidate.reviewCountScore,
      distance_km: candidate.distanceKm,
      avg_rating: candidate.avgRating,
      review_count: candidate.reviewCount,
      attribute_score: candidate.attributeScore,
      attribute_reason: candidate.attributeReason,
      attribute_matches: candidate.attributeMatches,
    },
  }))

  return {
    rankedCandidates,
    eligibleWalkerIds: dogSizeCompatibleWalkers.map((walker) => walker.id),
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
      console.error('[review-provider-issue] misconfigured env', { action: 'bootstrap', result: 'error' })
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

    let jobId = ''
    let action: ReviewProviderIssueBody['action'] | null = null
    try {
      const body = (await req.json()) as ReviewProviderIssueBody
      jobId = typeof body.jobId === 'string' ? body.jobId.trim() : ''
      action =
        body.action === 'resume' || body.action === 'reassign' || body.action === 'cancel'
          ? body.action
          : null
    } catch {
      return new Response(
        JSON.stringify({ error: 'Invalid request body' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    if (!jobId || !action) {
      return new Response(
        JSON.stringify({ error: 'Missing jobId or action' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const { data: job, error: jobError } = await supabaseAdmin
      .from('walk_requests')
      .select('id, client_id, walker_id, selected_walker_id, status, booking_timing, scheduled_for, service_type, dog_name, payment_status, stripe_payment_intent_id, notes, service_started_at, service_completed_at, dispatch_state, smart_dispatch_state')
      .eq('id', jobId)
      .maybeSingle()

    if (jobError) {
      console.error('[review-provider-issue] job lookup failed', {
        request_id: jobId,
        action,
        result: 'error',
        error: jobError.message,
      })
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

    if (!hasProviderIssue(job.notes)) {
      return new Response(
        JSON.stringify({ error: 'Job does not have an open provider issue' }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    if (job.service_started_at || job.service_completed_at) {
      return new Response(
        JSON.stringify({ error: 'Provider issue can only be reviewed before service starts' }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const oldProviderId =
      typeof job.walker_id === 'string' && job.walker_id.length > 0
        ? job.walker_id
        : typeof job.selected_walker_id === 'string' && job.selected_walker_id.length > 0
          ? job.selected_walker_id
          : null

    if (action === 'resume') {
      const nextNotes = removeProviderIssueMarker(job.notes)
      const { error: resumeError } = await supabaseAdmin
        .from('walk_requests')
        .update({ notes: nextNotes })
        .eq('id', jobId)

      if (resumeError) {
        console.error('[review-provider-issue] resume failed', {
          request_id: jobId,
          action,
          result: 'error',
          error: resumeError.message,
        })
        return new Response(
          JSON.stringify({ error: 'Failed to resume service', details: resumeError.message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        )
      }

      await Promise.all([
        createNotification(supabaseAdmin, {
          userId: oldProviderId,
          type: 'provider_issue_resolved',
          title: 'Support resumed service',
          message: 'Support reviewed the issue. You can start the service again.',
          relatedJobId: jobId,
        }),
        createNotification(supabaseAdmin, {
          userId: job.client_id,
          type: 'provider_issue_resolved',
          title: 'Service resumed',
          message: 'Support reviewed the provider issue. The service can continue.',
          relatedJobId: jobId,
        }),
      ])

      console.log('[review-provider-issue] success', {
        request_id: jobId,
        action,
        result: 'resumed',
      })

      return new Response(
        JSON.stringify({ success: true, jobId, action, status: job.status, paymentStatus: job.payment_status }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    if (action === 'reassign') {
      if (!job.client_id) {
        return new Response(
          JSON.stringify({ error: 'Request is missing client_id and cannot be reassigned' }),
          { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        )
      }

      console.log(PROVIDER_REASSIGN_LOG, {
        requestId: jobId,
        oldProviderId,
        action,
        result: 'started',
        requestStateBefore: {
          status: job.status,
          booking_timing: job.booking_timing,
          dispatch_state: job.dispatch_state,
          smart_dispatch_state: job.smart_dispatch_state,
          walker_id: job.walker_id,
          selected_walker_id: job.selected_walker_id,
        },
      })

      const nowIso = new Date().toISOString()
      const nextNotes = removeProviderIssueMarker(job.notes)

      const { error: closeAttemptsError } = await supabaseAdmin
        .from('dispatch_attempts')
        .update({
          status: 'cancelled',
          responded_at: nowIso,
        })
        .eq('request_id', jobId)
        .in('status', ['pending', 'accepted'])

      if (closeAttemptsError) {
        console.error(PROVIDER_REASSIGN_LOG, {
          requestId: jobId,
          oldProviderId,
          action,
          result: 'error',
          error: closeAttemptsError.message,
        })
        return new Response(
          JSON.stringify({ error: 'Failed to close prior dispatch attempts', details: closeAttemptsError.message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        )
      }

      const { error: reopenError } = await supabaseAdmin
        .from('walk_requests')
        .update({
          status: 'open',
          walker_id: null,
          selected_walker_id: null,
          walker_lat: null,
          walker_lng: null,
          last_location_update: null,
          provider_arrived_at: null,
          client_arrival_confirmed_at: null,
          dispatch_state: 'queued',
          smart_dispatch_state: 'idle',
          smart_dispatch_cursor: 0,
          smart_dispatch_last_error: null,
          smart_dispatch_started_at: null,
          smart_dispatch_completed_at: null,
          smart_dispatch_expires_at: null,
          notes: nextNotes,
        })
        .eq('id', jobId)

      if (reopenError) {
        console.error(PROVIDER_REASSIGN_LOG, {
          requestId: jobId,
          oldProviderId,
          action,
          result: 'error',
          error: reopenError.message,
        })
        return new Response(
          JSON.stringify({ error: 'Failed to reopen request for reassignment', details: reopenError.message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        )
      }

      await Promise.all([
        createNotification(supabaseAdmin, {
          userId: job.client_id,
          type: 'provider_reassignment_started',
          title: 'Finding another provider',
          message: 'We’re finding another provider for your request.',
          relatedJobId: jobId,
        }),
        createNotification(supabaseAdmin, {
          userId: oldProviderId,
          type: 'provider_reassignment_started',
          title: 'Request reassigned',
          message: 'This request was reassigned.',
          relatedJobId: jobId,
        }),
      ])

      const { rankedCandidates, eligibleWalkerIds } = await buildRankedCandidatesForReassignment({
        supabaseAdmin,
        requestId: jobId,
        clientId: job.client_id,
        requestServiceType: job.service_type,
        dogNameValue: (job as { dog_name?: string | null }).dog_name ?? null,
        bookingTiming: job.booking_timing,
        scheduledFor: job.scheduled_for,
        excludedWalkerId: oldProviderId,
      })

      console.log(PROVIDER_REASSIGN_LOG, {
        requestId: jobId,
        oldProviderId,
        action,
        eligibleCandidatesCount: rankedCandidates.length,
        excludedProviders: oldProviderId ? [oldProviderId] : [],
        eligibleWalkerIds,
      })

      if (rankedCandidates.length === 0) {
        console.warn(PROVIDER_REASSIGN_LOG, {
          requestId: jobId,
          oldProviderId,
          action,
          result: 'no_candidates',
        })
        return new Response(
          JSON.stringify({
            success: true,
            jobId,
            action,
            status: 'open',
            paymentStatus: job.payment_status,
            details: 'No alternate providers are currently available. The request was reopened for reassignment.',
          }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        )
      }

      const startDispatchUrl = `${supabaseUrl}/functions/v1/start-dispatch`
      const startDispatchResponse = await fetch(startDispatchUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${serviceRoleKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          requestId: jobId,
          rankedCandidates,
          timeoutSeconds: DISPATCH_TIMEOUT_SECONDS,
          resetExisting: true,
        }),
      })

      let startDispatchResult: StartDispatchResponse | null = null
      try {
        startDispatchResult = (await startDispatchResponse.json()) as StartDispatchResponse
      } catch {
        startDispatchResult = null
      }

      console.log(PROVIDER_REASSIGN_LOG, {
        requestId: jobId,
        oldProviderId,
        action,
        startDispatchResponse: {
          httpStatus: startDispatchResponse.status,
          ok: startDispatchResponse.ok,
          result: startDispatchResult,
        },
      })

      if (!startDispatchResponse.ok || !startDispatchResult?.ok) {
        const message =
          startDispatchResult?.error ??
          startDispatchResult?.details ??
          `start-dispatch returned ${startDispatchResponse.status}`

        console.error(PROVIDER_REASSIGN_LOG, {
          requestId: jobId,
          oldProviderId,
          action,
          result: 'error',
          error: message,
        })

        await supabaseAdmin
          .from('walk_requests')
          .update({
            dispatch_state: 'queued',
            smart_dispatch_state: 'idle',
            smart_dispatch_last_error: message,
            smart_dispatch_expires_at: null,
          })
          .eq('id', jobId)

        return new Response(
          JSON.stringify({ error: 'Failed to restart dispatch', details: message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        )
      }

      const newAttemptId =
        typeof startDispatchResult.advanceResult?.attempt_id === 'string'
          ? startDispatchResult.advanceResult.attempt_id
          : null

      if (!newAttemptId) {
        console.error(PROVIDER_REASSIGN_LOG, {
          requestId: jobId,
          oldProviderId,
          action,
          result: 'error',
          error: 'start-dispatch did not return a new attempt id',
        })
        return new Response(
          JSON.stringify({ error: 'Reassign did not create a new dispatch attempt' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        )
      }

      const { data: newAttemptRow, error: newAttemptError } = await supabaseAdmin
        .from('dispatch_attempts')
        .select('id, walker_id, status')
        .eq('id', newAttemptId)
        .eq('request_id', jobId)
        .maybeSingle()

      if (newAttemptError || !newAttemptRow || newAttemptRow.status !== 'pending') {
        console.error(PROVIDER_REASSIGN_LOG, {
          requestId: jobId,
          oldProviderId,
          action,
          result: 'error',
          error: newAttemptError?.message ?? 'pending attempt not found after reassign',
          newAttemptId,
          newAttemptRow,
        })
        return new Response(
          JSON.stringify({
            error: 'Reassign did not create a live pending dispatch attempt',
            details: newAttemptError?.message ?? 'pending attempt not found after reassign',
          }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        )
      }

      console.log(PROVIDER_REASSIGN_LOG, {
        requestId: jobId,
        oldProviderId,
        action,
        result: 'redispatch_started',
        candidateCount: rankedCandidates.length,
        newAttemptId: newAttemptRow.id,
        newProviderId: newAttemptRow.walker_id,
      })

      return new Response(
        JSON.stringify({
          success: true,
          jobId,
          action,
          status: 'open',
          paymentStatus: job.payment_status,
          candidateCount: rankedCandidates.length,
          newAttemptId: newAttemptRow.id,
          newProviderId: newAttemptRow.walker_id,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const stripe = new Stripe(stripeKey, { apiVersion: '2024-12-18.acacia' })
    if (job.stripe_payment_intent_id) {
      const pi = await stripe.paymentIntents.retrieve(job.stripe_payment_intent_id)
      if (
        pi.status === 'requires_capture' ||
        pi.status === 'requires_confirmation' ||
        pi.status === 'requires_payment_method'
      ) {
        await stripe.paymentIntents.cancel(job.stripe_payment_intent_id)
      } else if (pi.status !== 'canceled') {
        return new Response(
          JSON.stringify({
            error: 'PaymentIntent cannot be safely canceled',
            details: `PaymentIntent status is '${pi.status}'.`,
          }),
          { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        )
      }
    }

    const { error: cancelError } = await supabaseAdmin
      .from('walk_requests')
      .update({
        status: 'cancelled',
        payment_status: 'failed',
        dispatch_state: 'cancelled',
        smart_dispatch_state: 'cancelled',
        notes: removeProviderIssueMarker(job.notes),
      })
      .eq('id', jobId)

    if (cancelError) {
      console.error('[review-provider-issue] cancel failed', {
        request_id: jobId,
        action,
        result: 'error',
        error: cancelError.message,
      })
      return new Response(
        JSON.stringify({ error: 'Failed to cancel request', details: cancelError.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    await Promise.all([
      createNotification(supabaseAdmin, {
        userId: oldProviderId,
        type: 'provider_issue_cancelled',
        title: 'Request cancelled',
        message: 'Support cancelled this request after reviewing the reported issue.',
        relatedJobId: jobId,
      }),
      createNotification(supabaseAdmin, {
        userId: job.client_id,
        type: 'provider_issue_cancelled',
        title: 'Request cancelled',
        message: 'Support cancelled the request after reviewing the provider issue.',
        relatedJobId: jobId,
      }),
    ])

    console.log('[review-provider-issue] success', {
      request_id: jobId,
      action,
      result: 'cancelled',
    })

    return new Response(
      JSON.stringify({ success: true, jobId, action, status: 'cancelled', paymentStatus: 'failed' }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  } catch (err) {
    console.error('[review-provider-issue] unhandled', {
      action: 'unknown',
      result: 'error',
      error: err instanceof Error ? err.message : 'Unknown',
    })
    return new Response(
      JSON.stringify({
        error: 'Internal server error',
        details: err instanceof Error ? err.message : 'Unknown',
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }
})
