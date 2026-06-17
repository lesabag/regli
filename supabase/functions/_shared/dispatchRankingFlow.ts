import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import type { RankedCandidate } from './dispatch.ts'
import {
  distanceKm,
  evaluateDogSizeCompatibility,
  rankWalkerCandidates,
} from './dispatchRanking.ts'
import {
  groupProviderAvailabilityRows,
  isProviderAvailableAt,
  type ProviderAvailabilityRow,
} from './providerAvailability.ts'
import {
  normalizeProviderServiceType,
  providerSupportsRequestedService,
} from './providerServiceTypes.ts'
import {
  loadSelectedDogSizesForRequest,
  mergeSelectedDogSizesIntoClientAttributes,
} from './requestDogSizes.ts'

type WalkerRow = {
  id: string
  last_lat: number | null
  last_lng: number | null
  service_type: string | null
  service_types: string[] | null
  service_attributes: Record<string, unknown> | null
}

type RatingRow = { to_user_id: string; rating: number }

export type DispatchRankingRequest = {
  id: string
  client_id: string | null
  service_type: string | null
  booking_timing: string | null
  scheduled_for: string | null
  client_lat?: number | null
  client_lng?: number | null
  dog_name?: string | null
}

export type BuildRankedCandidatesArgs = {
  supabase: SupabaseClient
  request: DispatchRankingRequest
  source: string
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Server-side dispatch candidate ranking.
 * Mirrors the pipeline currently inlined in run-scheduled-dispatch so that
 * start-dispatch can rank for itself when the client doesn't (or can't)
 * supply rankedCandidates — e.g., when create-payment-intent triggers
 * dispatch server-to-server and the client never reaches its own ranking step.
 */
export async function buildRankedDispatchCandidates(
  args: BuildRankedCandidatesArgs,
): Promise<RankedCandidate[]> {
  const { supabase, request, source } = args
  const requestedProviderServiceType = normalizeProviderServiceType(request.service_type)
  const bookingType = request.booking_timing === 'scheduled' ? 'scheduled' : 'asap'

  const { data: walkers, error: walkersError } = await supabase
    .from('profiles')
    .select('id, last_lat, last_lng, service_type, service_types, service_attributes')
    .eq('role', 'walker')
    .eq('is_online', true)

  if (walkersError) {
    console.warn('[dispatchRankingFlow] walker lookup failed', {
      requestId: request.id,
      source,
      error: walkersError.message,
    })
    return []
  }

  const onlineWalkers = ((walkers as WalkerRow[] | null) ?? [])
  if (onlineWalkers.length === 0) return []

  const matchingServiceWalkers = onlineWalkers.filter((walker) =>
    providerSupportsRequestedService(walker, requestedProviderServiceType),
  )
  if (matchingServiceWalkers.length === 0) return []

  const walkerIdsForAvailability = matchingServiceWalkers.map((walker) => walker.id)
  let availabilityRows: ProviderAvailabilityRow[] = []
  try {
    const { data: availabilityData, error: availabilityError } = await supabase
      .from('provider_availability')
      .select('provider_id, service_type, day_of_week, start_time, end_time, is_active')
      .in('provider_id', walkerIdsForAvailability)
      .eq('is_active', true)
    if (availabilityError) throw availabilityError
    availabilityRows = (availabilityData as ProviderAvailabilityRow[] | null) ?? []
  } catch (availabilityError) {
    const message = availabilityError instanceof Error ? availabilityError.message : 'availability lookup failed'
    console.warn('[dispatchRankingFlow] availability lookup failed', {
      requestId: request.id,
      source,
      error: message,
    })
    return []
  }

  const availabilityByProvider = groupProviderAvailabilityRows(availabilityRows)
  const availabilityReferenceAt =
    bookingType === 'scheduled' && request.scheduled_for
      ? request.scheduled_for
      : new Date().toISOString()
  const availableWalkers = matchingServiceWalkers.filter((walker) =>
    isProviderAvailableAt(
      availabilityByProvider.get(walker.id) ?? [],
      requestedProviderServiceType,
      availabilityReferenceAt,
    ),
  )
  if (availableWalkers.length === 0) return []

  const requestClientLat = toFiniteNumber(request.client_lat)
  const requestClientLng = toFiniteNumber(request.client_lng)
  const hasRequestCoordinates = requestClientLat != null && requestClientLng != null

  let radiusCompatibleWalkers = availableWalkers
  if (availableWalkers.length > 0) {
    const { data: providerPreferenceRows, error: providerPreferencesError } = await supabase
      .from('provider_service_preferences')
      .select('provider_id, service_type, booking_type, is_enabled, service_radius_km')
      .in('provider_id', availableWalkers.map((walker) => walker.id))
      .eq('service_type', requestedProviderServiceType ?? '')
      .eq('booking_type', bookingType)

    if (providerPreferencesError) {
      console.warn('[dispatchRankingFlow] provider radius lookup failed', {
        requestId: request.id,
        source,
        error: providerPreferencesError.message,
      })
      return []
    }

    const radiusByProviderId = new Map<string, number | null>()
    ;((providerPreferenceRows as Array<{ provider_id?: string | null; service_radius_km?: number | null }> | null) ?? []).forEach((row) => {
      if (!row.provider_id) return
      radiusByProviderId.set(row.provider_id, toFiniteNumber(row.service_radius_km))
    })

    radiusCompatibleWalkers = availableWalkers.filter((walker) => {
      const serviceRadiusKm = radiusByProviderId.get(walker.id) ?? null
      if (serviceRadiusKm == null || serviceRadiusKm <= 0) return true
      if (!hasRequestCoordinates) return true
      if (walker.last_lat == null || walker.last_lng == null) return true
      const candidateDistanceKm = distanceKm(
        requestClientLat!,
        requestClientLng!,
        walker.last_lat,
        walker.last_lng,
      )
      return candidateDistanceKm <= serviceRadiusKm
    })
  }

  if (radiusCompatibleWalkers.length === 0) return []

  const walkerIds = radiusCompatibleWalkers.map((walker) => walker.id)

  let ratingsByWalker = new Map<string, { total: number; count: number }>()
  if (walkerIds.length > 0) {
    const { data: ratingsRows, error: ratingsError } = await supabase
      .from('ratings')
      .select('to_user_id, rating')
      .in('to_user_id', walkerIds)
    if (ratingsError) {
      console.warn('[dispatchRankingFlow] ratings lookup failed', {
        requestId: request.id,
        source,
        error: ratingsError.message,
      })
    } else {
      ratingsByWalker = ((ratingsRows as RatingRow[] | null) ?? []).reduce((map, row) => {
        const current = map.get(row.to_user_id) ?? { total: 0, count: 0 }
        current.total += row.rating
        current.count += 1
        map.set(row.to_user_id, current)
        return map
      }, new Map<string, { total: number; count: number }>())
    }
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

  if (walkerIds.length > 0 && request.client_id) {
    const [
      { data: favoriteCustomersRows, error: favoriteCustomersError },
      { data: favoriteWalkersRows, error: favoriteWalkersError },
      { data: clientProfileRow },
    ] = await Promise.all([
      supabase
        .from('favorite_customers')
        .select('walker_id')
        .eq('client_id', request.client_id)
        .in('walker_id', walkerIds),
      supabase
        .from('favorite_walkers')
        .select('walker_id')
        .eq('client_id', request.client_id)
        .in('walker_id', walkerIds),
      supabase
        .from('profiles')
        .select('service_attributes')
        .eq('id', request.client_id)
        .maybeSingle(),
    ])

    const selectedDogSizes = await loadSelectedDogSizesForRequest({
      supabase,
      clientId: request.client_id,
      dogNameValue: request.dog_name ?? null,
    })
    clientServiceAttributes = mergeSelectedDogSizesIntoClientAttributes(
      (clientProfileRow as { service_attributes?: unknown } | null)?.service_attributes as Record<string, unknown> | null ?? null,
      selectedDogSizes,
    )

    if (favoriteCustomersError) {
      console.warn('[dispatchRankingFlow] favorite customers lookup failed', {
        requestId: request.id,
        source,
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
      console.warn('[dispatchRankingFlow] favorite walkers lookup failed', {
        requestId: request.id,
        source,
        error: favoriteWalkersError.message,
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
        clientServiceAttributes,
        providerServiceAttributes: walkerServiceAttrsById.get(walker.id) ?? null,
      }
    }),
  ).map((candidate) => ({
    walkerId: candidate.walkerId,
    score: candidate.score,
    meta: {
      source,
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
  } satisfies RankedCandidate))

  return ranked
}
