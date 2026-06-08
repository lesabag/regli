import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { corsHeaders } from '../_shared/cors.ts'
import {
  createAdminClient,
  getEnv,
  jsonResponse,
} from '../_shared/dispatch.ts'
import {
  groupProviderAvailabilityRows,
  isProviderAvailableAt,
  type ProviderAvailabilityRow,
} from '../_shared/providerAvailability.ts'
import { distanceKm, evaluateDogSizeCompatibility, rankWalkerCandidates } from '../_shared/dispatchRanking.ts'
import { loadSelectedDogSizesForRequest, mergeSelectedDogSizesIntoClientAttributes } from '../_shared/requestDogSizes.ts'

function getScheduledDispatchLeadMinutes(): number {
  const raw = Deno.env.get('SCHEDULED_DISPATCH_LEAD_MINUTES')
  const parsed = raw ? Number(raw) : NaN
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 15
}

const LEAD_MINUTES = getScheduledDispatchLeadMinutes()
const DISPATCH_TIMEOUT_SECONDS = 60

type ActiveAttemptRow = {
  id: string
}

type WalkerRow = {
  id: string
  last_lat: number | null
  last_lng: number | null
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
  requestId?: string
  candidateCount?: number
  advanceResult?: unknown
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
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

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabase = createAdminClient()

    const now = new Date()
    const leadTime = new Date(now.getTime() + LEAD_MINUTES * 60 * 1000)

    console.log('[run-scheduled-dispatch] tick', {
      nowIso: now.toISOString(),
      leadMinutes: LEAD_MINUTES,
      leadTimeIso: leadTime.toISOString(),
    })

    // Fetch a broader scheduled set so skip reasons are explicit in logs.
    const { data: jobs, error } = await supabase
      .from('walk_requests')
      .select(`
        id,
        client_id,
        client_lat,
        client_lng,
        status,
        service_type,
        scheduled_for,
        dispatch_state,
        smart_dispatch_state,
        smart_dispatch_expires_at,
        walker_id,
        payment_status,
        stripe_payment_intent_id
      `)
      .eq('booking_timing', 'scheduled')
      .not('scheduled_for', 'is', null)
      .lte('scheduled_for', leadTime.toISOString())

    if (error) {
      console.error('[run-scheduled-dispatch] job query failed', {
        nowIso: now.toISOString(),
        leadTimeIso: leadTime.toISOString(),
        leadMinutes: LEAD_MINUTES,
        error: error.message,
      })
      return jsonResponse(500, {
        ok: false,
        error: 'failed to fetch scheduled jobs',
        details: error.message,
      }, corsHeaders)
    }

    console.log('[run-scheduled-dispatch] jobs loaded in lead window', {
      nowIso: now.toISOString(),
      leadTimeIso: leadTime.toISOString(),
      leadMinutes: LEAD_MINUTES,
      count: jobs?.length ?? 0,
      jobs: (jobs ?? []).map((job) => ({
        id: job.id,
        scheduled_for: job.scheduled_for,
        status: job.status,
        payment_status: job.payment_status,
        dispatch_state: job.dispatch_state,
        smart_dispatch_state: job.smart_dispatch_state,
      })),
    })

    if (!jobs || jobs.length === 0) {
      return jsonResponse(200, {
        ok: true,
        scanned: 0,
        started: 0,
        noCandidates: 0,
      }, corsHeaders)
    }

    let started = 0
    let noCandidates = 0
    let eligible = 0

    for (const job of jobs) {
      try {
        const skipReason =
          job.status !== 'open'
            ? `status=${job.status}`
            : !['authorized', 'requires_capture'].includes(job.payment_status ?? '')
              ? `payment_status=${job.payment_status ?? 'null'}`
              : !job.stripe_payment_intent_id
                ? 'missing_stripe_payment_intent_id'
                : job.walker_id
                  ? `already_assigned=${job.walker_id}`
                  : job.smart_dispatch_state === 'cancelled'
                    ? 'smart_dispatch_state=cancelled'
                    : job.smart_dispatch_state === 'exhausted'
                      ? 'smart_dispatch_state=exhausted'
                      : null

        if (skipReason) {
          console.log('[run-scheduled-dispatch] skipped job', {
            requestId: job.id,
            reason: skipReason,
            scheduledFor: job.scheduled_for,
            status: job.status,
            paymentStatus: job.payment_status,
            dispatchState: job.dispatch_state,
            smartDispatchState: job.smart_dispatch_state,
            walkerId: job.walker_id,
          })
          continue
        }

        eligible++
        console.log('[run-scheduled-dispatch] processing job', {
          requestId: job.id,
          scheduledFor: job.scheduled_for,
          status: job.status,
          paymentStatus: job.payment_status,
          dispatchState: job.dispatch_state,
          smartDispatchState: job.smart_dispatch_state,
        })

        const { data: activeAttempts, error: activeAttemptsError } = await supabase
          .from('dispatch_attempts')
          .select('id')
          .eq('request_id', job.id)
          .eq('status', 'pending')
          .gt('expires_at', now.toISOString())
          .limit(1)

        if (activeAttemptsError) {
          await supabase.rpc('log_dispatch_event', {
            p_request_id: job.id,
            p_attempt_id: null,
            p_event_type: 'scheduled_active_attempt_lookup_failed',
            p_payload: { error: activeAttemptsError.message, retry_later: true },
          })
          continue
        }

        const activeAttemptRows = (activeAttempts as ActiveAttemptRow[] | null) ?? []
        const hasActiveAttempt = activeAttemptRows.length > 0

        if (hasActiveAttempt) {
          continue
        }

        if (job.smart_dispatch_state === 'assigned') {
          continue
        }

        const wasMarkedDispatchedWithoutLiveAttempt =
          job.dispatch_state === 'dispatched' || job.smart_dispatch_state === 'dispatching'

        const [{ count: attemptCount, error: attemptCountError }, { count: candidateCount, error: candidateCountError }] =
          await Promise.all([
            supabase
              .from('dispatch_attempts')
              .select('id', { count: 'exact', head: true })
              .eq('request_id', job.id),
            supabase
              .from('dispatch_candidates')
              .select('id', { count: 'exact', head: true })
              .eq('request_id', job.id),
          ])

        if (attemptCountError || candidateCountError) {
          await supabase.rpc('log_dispatch_event', {
            p_request_id: job.id,
            p_attempt_id: null,
            p_event_type: 'scheduled_dispatch_state_lookup_failed',
            p_payload: {
              attempts_error: attemptCountError?.message ?? null,
              candidates_error: candidateCountError?.message ?? null,
              retry_later: true,
            },
          })
          continue
        }

        if (wasMarkedDispatchedWithoutLiveAttempt) {
          await supabase
            .from('walk_requests')
            .update({
              dispatch_state: 'queued',
              smart_dispatch_state: 'idle',
              smart_dispatch_last_error: null,
              smart_dispatch_expires_at: null,
            })
            .eq('id', job.id)
            .eq('status', 'open')
            .is('walker_id', null)

          await supabase.rpc('log_dispatch_event', {
            p_request_id: job.id,
            p_attempt_id: null,
            p_event_type: 'scheduled_dead_dispatch_recovered',
            p_payload: {
              previous_dispatch_state: job.dispatch_state,
              previous_smart_dispatch_state: job.smart_dispatch_state,
              existing_attempt_count: attemptCount ?? 0,
              existing_candidate_count: candidateCount ?? 0,
              retrying_start_dispatch: true,
            },
          })
        }

        // 🔍 fetch online walkers
        const { data: walkers, error: walkersError } = await supabase
          .from('profiles')
          .select('id, last_lat, last_lng, service_type, service_types, service_attributes')
          .eq('role', 'walker')
          .eq('is_online', true)

        if (walkersError) {
          await supabase.rpc('log_dispatch_event', {
            p_request_id: job.id,
            p_attempt_id: null,
            p_event_type: 'scheduled_walker_lookup_failed',
            p_payload: { error: walkersError.message, retry_later: true },
          })
          continue
        }

        if (!walkers || walkers.length === 0) {
          // CRITICAL FIX: Don't cancel scheduled jobs when supply is unavailable
          // Instead, keep job alive and mark smart_dispatch_state as 'idle'
          // This allows cron to retry later when walkers come online
          const { error: updateError } = await supabase
            .from('walk_requests')
            .update({
              dispatch_state: 'queued',
              smart_dispatch_state: 'idle',
            })
            .eq('id', job.id)

          if (!updateError) {
            await supabase.rpc('log_dispatch_event', {
              p_request_id: job.id,
              p_attempt_id: null,
              p_event_type: 'scheduled_no_walkers_waiting',
              p_payload: { retry_later: true },
            })
            noCandidates++
          }
          continue
        }

        const requestedProviderServiceType = normalizeProviderServiceType(job.service_type)
        const matchingServiceWalkers = ((walkers as WalkerRow[] | null) ?? []).filter((walker) => {
          return providerSupportsRequestedService(walker, requestedProviderServiceType)
        })
        if (matchingServiceWalkers.length === 0) {
          const { error: updateError } = await supabase
            .from('walk_requests')
            .update({
              dispatch_state: 'queued',
              smart_dispatch_state: 'idle',
            })
            .eq('id', job.id)

          if (!updateError) {
            await supabase.rpc('log_dispatch_event', {
              p_request_id: job.id,
              p_attempt_id: null,
              p_event_type: 'scheduled_no_matching_service_providers_waiting',
              p_payload: {
                retry_later: true,
                request_service_type: job.service_type ?? null,
                normalized_provider_service_type: requestedProviderServiceType,
              },
            })
            noCandidates++
          }
          continue
        }

        let availabilityRows: ProviderAvailabilityRow[] = []
        try {
          const { data: availabilityData, error: availabilityError } = await supabase
            .from('provider_availability')
            .select('provider_id, service_type, day_of_week, start_time, end_time, is_active')
            .in('provider_id', matchingServiceWalkers.map((walker) => walker.id))
            .eq('is_active', true)

          if (availabilityError) {
            throw availabilityError
          }
          availabilityRows = (availabilityData as ProviderAvailabilityRow[] | null) ?? []
        } catch (availabilityError) {
          const message = availabilityError instanceof Error ? availabilityError.message : 'availability lookup failed'
          await supabase.rpc('log_dispatch_event', {
            p_request_id: job.id,
            p_attempt_id: null,
            p_event_type: 'scheduled_provider_availability_lookup_failed',
            p_payload: { error: message, retry_later: true },
          })
          continue
        }

        const availabilityByProvider = groupProviderAvailabilityRows(availabilityRows)
        const onlineWalkers = matchingServiceWalkers.filter((walker) =>
          isProviderAvailableAt(
            availabilityByProvider.get(walker.id) ?? [],
            requestedProviderServiceType,
            job.scheduled_for!,
          ),
        )
        const requestClientLat = toFiniteNumber((job as { client_lat?: unknown }).client_lat)
        const requestClientLng = toFiniteNumber((job as { client_lng?: unknown }).client_lng)
        const hasRequestCoordinates = requestClientLat != null && requestClientLng != null

        let radiusCompatibleWalkers = onlineWalkers
        if (onlineWalkers.length > 0) {
          const { data: providerPreferenceRows, error: providerPreferencesError } = await supabase
            .from('provider_service_preferences')
            .select('provider_id, service_type, booking_type, is_enabled, service_radius_km')
            .in('provider_id', onlineWalkers.map((walker) => walker.id))
            .eq('service_type', requestedProviderServiceType ?? '')
            .eq('booking_type', 'scheduled')

          if (providerPreferencesError) {
            await supabase.rpc('log_dispatch_event', {
              p_request_id: job.id,
              p_attempt_id: null,
              p_event_type: 'scheduled_provider_radius_lookup_failed',
              p_payload: { error: providerPreferencesError.message, retry_later: true },
            })
            continue
          }

          const radiusByProviderId = new Map<string, number | null>()
          ;((providerPreferenceRows as Array<{ provider_id?: string | null; service_radius_km?: number | null }> | null) ?? []).forEach((row) => {
            if (!row.provider_id) return
            radiusByProviderId.set(row.provider_id, toFiniteNumber(row.service_radius_km))
          })

          radiusCompatibleWalkers = onlineWalkers.filter((walker) => {
            const serviceRadiusKm = radiusByProviderId.get(walker.id) ?? null
            if (serviceRadiusKm == null || serviceRadiusKm <= 0) return true
            if (!hasRequestCoordinates) {
              console.log('[run-scheduled-dispatch] radius filter skipped without request coordinates', {
                requestId: job.id,
                walkerId: walker.id,
                serviceRadiusKm,
                bookingType: 'scheduled',
              })
              return true
            }
            if (walker.last_lat == null || walker.last_lng == null) return true

            const candidateDistanceKm = distanceKm(
              requestClientLat!,
              requestClientLng!,
              walker.last_lat,
              walker.last_lng,
            )
            const withinRadius = candidateDistanceKm <= serviceRadiusKm

            if (!withinRadius) {
              console.log('[run-scheduled-dispatch] provider excluded by service radius', {
                requestId: job.id,
                walkerId: walker.id,
                distanceKm: Number(candidateDistanceKm.toFixed(2)),
                serviceRadiusKm,
                bookingType: 'scheduled',
                serviceType: requestedProviderServiceType,
              })
            }

            return withinRadius
          })
        }

        const walkerIds = radiusCompatibleWalkers.map((walker) => walker.id)

        console.log('[run-scheduled-dispatch] candidates after service_type filtering', {
          requestId: job.id,
          requestServiceType: job.service_type ?? null,
          normalizedProviderServiceType: requestedProviderServiceType,
          onlineWalkerCount: (walkers as WalkerRow[] | null)?.length ?? 0,
          serviceTypeCandidateCount: matchingServiceWalkers.length,
          availabilityCandidateCount: onlineWalkers.length,
          radiusCandidateCount: radiusCompatibleWalkers.length,
          hasRequestCoordinates,
        })

        if (radiusCompatibleWalkers.length === 0) {
          const { error: updateError } = await supabase
            .from('walk_requests')
            .update({
              dispatch_state: 'queued',
              smart_dispatch_state: 'idle',
            })
            .eq('id', job.id)

          if (!updateError) {
            await supabase.rpc('log_dispatch_event', {
              p_request_id: job.id,
              p_attempt_id: null,
              p_event_type: 'scheduled_no_available_providers_waiting',
              p_payload: {
                retry_later: true,
                request_service_type: job.service_type ?? null,
                normalized_provider_service_type: requestedProviderServiceType,
                service_type_candidate_count: matchingServiceWalkers.length,
                availability_candidate_count: onlineWalkers.length,
                radius_candidate_count: radiusCompatibleWalkers.length,
              },
            })
            noCandidates++
          }
          continue
        }

        let ratingsByWalker = new Map<string, { total: number; count: number }>()
        if (walkerIds.length > 0) {
          const { data: ratingsRows, error: ratingsError } = await supabase
            .from('ratings')
            .select('to_user_id, rating')
            .in('to_user_id', walkerIds)

          if (ratingsError) {
            await supabase.rpc('log_dispatch_event', {
              p_request_id: job.id,
              p_attempt_id: null,
              p_event_type: 'scheduled_walker_ratings_lookup_failed',
              p_payload: { error: ratingsError.message, retry_later: true },
            })
            continue
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
        for (const walker of radiusCompatibleWalkers) {
          if (walker.service_attributes && typeof walker.service_attributes === 'object') {
            walkerServiceAttrsById.set(walker.id, walker.service_attributes)
          }
        }

        if (walkerIds.length > 0 && job.client_id) {
          const [{ data: favoriteCustomersRows, error: favoriteCustomersError }, { data: favoriteWalkersRows, error: favoriteWalkersError }, { data: clientProfileRow }] =
            await Promise.all([
              supabase
                .from('favorite_customers')
                .select('walker_id')
                .eq('client_id', job.client_id)
                .in('walker_id', walkerIds),
              supabase
                .from('favorite_walkers')
                .select('walker_id')
                .eq('client_id', job.client_id)
                .in('walker_id', walkerIds),
              supabase
                .from('profiles')
                .select('service_attributes')
                .eq('id', job.client_id)
                .maybeSingle(),
            ])

          const selectedDogSizes = await loadSelectedDogSizesForRequest({
            supabase,
            clientId: job.client_id,
            dogNameValue: job.dog_name ?? null,
          })
          clientServiceAttributes = mergeSelectedDogSizesIntoClientAttributes(
            (clientProfileRow as { service_attributes?: unknown } | null)?.service_attributes as Record<string, unknown> | null ?? null,
            selectedDogSizes,
          )

          if (favoriteCustomersError) {
            await supabase.rpc('log_dispatch_event', {
              p_request_id: job.id,
              p_attempt_id: null,
              p_event_type: 'scheduled_favorite_customers_lookup_failed',
              p_payload: { error: favoriteCustomersError.message },
            })
          } else {
            providerSavedCustomerIds = new Set(
              ((favoriteCustomersRows as Array<{ walker_id: string | null }> | null) ?? [])
                .map((row) => row.walker_id)
                .filter((walkerId): walkerId is string => typeof walkerId === 'string' && walkerId.length > 0),
            )
          }

          if (favoriteWalkersError) {
            await supabase.rpc('log_dispatch_event', {
              p_request_id: job.id,
              p_attempt_id: null,
              p_event_type: 'scheduled_favorite_walkers_lookup_failed',
              p_payload: { error: favoriteWalkersError.message },
            })
          } else {
            customerSavedProviderIds = new Set(
              ((favoriteWalkersRows as Array<{ walker_id: string | null }> | null) ?? [])
                .map((row) => row.walker_id)
                .filter((walkerId): walkerId is string => typeof walkerId === 'string' && walkerId.length > 0),
            )
          }
        }

        const dogSizeCompatibleWalkers = radiusCompatibleWalkers.filter((walker) => {
          const compatibility = evaluateDogSizeCompatibility(
            requestedProviderServiceType,
            clientServiceAttributes,
            walkerServiceAttrsById.get(walker.id) ?? null,
          )

          if (!compatibility.compatible) {
            void supabase.rpc('log_dispatch_event', {
              p_request_id: job.id,
              p_attempt_id: null,
              p_event_type: 'scheduled_dog_size_filtered_provider',
              p_payload: {
                walker_id: walker.id,
                request_service_type: requestedProviderServiceType,
                reason: compatibility.reason,
                known_client_dog_sizes: compatibility.knownClientDogSizes,
                provider_accepted_dog_sizes: compatibility.providerAcceptedDogSizes,
                missing_client_dog_sizes: compatibility.missingClientDogSizes,
              },
            })
          }

          return compatibility.compatible
        })

        const ranked = rankWalkerCandidates(
          dogSizeCompatibleWalkers.map((walker) => {
            const ratingStats = ratingsByWalker.get(walker.id)
            const candidateDistanceKm =
              hasRequestCoordinates &&
              walker.last_lat != null &&
              walker.last_lng != null
                ? distanceKm(requestClientLat!, requestClientLng!, walker.last_lat, walker.last_lng)
                : null
            return {
              walkerId: walker.id,
              distanceKm: candidateDistanceKm,
              avgRating:
                ratingStats && ratingStats.count > 0
                  ? ratingStats.total / ratingStats.count
                  : null,
              reviewCount: ratingStats?.count ?? 0,
              affinityProviderSaved: providerSavedCustomerIds.has(walker.id),
              affinityClientSaved: customerSavedProviderIds.has(walker.id),
              serviceType: requestedProviderServiceType,
              clientServiceAttributes: clientServiceAttributes,
              providerServiceAttributes: walkerServiceAttrsById.get(walker.id) ?? null,
            }
          }),
        ).map((candidate) => ({
          walkerId: candidate.walkerId,
          score: candidate.score,
          meta: {
            source: 'run-scheduled-dispatch',
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

        await supabase.rpc('log_dispatch_event', {
          p_request_id: job.id,
          p_attempt_id: null,
          p_event_type: 'scheduled_dispatch_start_dispatch_invoked',
          p_payload: {
            candidate_count: ranked.length,
            dog_size_compatible_candidate_count: dogSizeCompatibleWalkers.length,
            timeout_seconds: DISPATCH_TIMEOUT_SECONDS,
            top_candidates: ranked.slice(0, 5).map((candidate) => ({
              walker_id: candidate.walkerId,
              score: candidate.score,
              base_score: candidate.meta.base_score,
              affinity_score: candidate.meta.affinity_score,
              affinity_provider_saved: candidate.meta.affinity_provider_saved,
              affinity_client_saved: candidate.meta.affinity_client_saved,
              distance_score: candidate.meta.distance_score,
              rating_score: candidate.meta.rating_score,
              review_count_score: candidate.meta.review_count_score,
            })),
          },
        })

        const startDispatchUrl = `${getEnv('SUPABASE_URL')}/functions/v1/start-dispatch`
        console.log('[run-scheduled-dispatch] invoking start-dispatch', {
          requestId: job.id,
          startDispatchUrl,
          candidateCount: ranked.length,
          timeoutSeconds: DISPATCH_TIMEOUT_SECONDS,
        })
        const startDispatchResponse = await fetch(startDispatchUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${getEnv('SUPABASE_SERVICE_ROLE_KEY')}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            requestId: job.id,
            rankedCandidates: ranked,
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

        console.log('[run-scheduled-dispatch] start-dispatch response', {
          requestId: job.id,
          httpStatus: startDispatchResponse.status,
          ok: startDispatchResponse.ok,
          result: startDispatchResult,
        })

        if (!startDispatchResponse.ok || !startDispatchResult?.ok) {
          const message =
            startDispatchResult?.error ??
            startDispatchResult?.details ??
            `start-dispatch returned ${startDispatchResponse.status}`

          await supabase
            .from('walk_requests')
            .update({
              dispatch_state: 'queued',
              smart_dispatch_state: 'idle',
              smart_dispatch_last_error: message,
              smart_dispatch_expires_at: null,
            })
            .eq('id', job.id)

          await supabase.rpc('log_dispatch_event', {
            p_request_id: job.id,
            p_attempt_id: null,
            p_event_type: 'scheduled_dispatch_failed',
            p_payload: {
              error: message,
              start_dispatch_status: startDispatchResponse.status,
              start_dispatch_result: startDispatchResult,
              retry_later: true,
            },
          })
          continue
        }

        await supabase.rpc('log_dispatch_event', {
          p_request_id: job.id,
          p_attempt_id: null,
          p_event_type: 'scheduled_dispatch_started',
          p_payload: {
            candidate_count: ranked.length,
            timeout_seconds: DISPATCH_TIMEOUT_SECONDS,
            start_dispatch_result: startDispatchResult,
          },
        })

        started++
      } catch (err) {
        console.error('scheduled dispatch error', err)
      }
    }

    return jsonResponse(200, {
      ok: true,
      scanned: jobs.length,
      eligible,
      started,
      noCandidates,
    }, corsHeaders)
  } catch (error) {
    return jsonResponse(500, {
      ok: false,
      error: 'Unexpected scheduled dispatch error',
      details: error instanceof Error ? error.message : String(error),
    }, corsHeaders)
  }
})
