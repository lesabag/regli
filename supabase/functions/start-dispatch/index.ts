import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { corsHeaders } from '../_shared/cors.ts'
import {
  createAdminClient,
  jsonResponse,
  normalizeTimeoutSeconds,
  sanitizeCandidates,
  type RankedCandidate,
} from '../_shared/dispatch.ts'
import { rankDispatchCandidatesByFinalScore, computeAttributeScore, evaluateDogSizeCompatibility } from '../_shared/dispatchRanking.ts'
import { evaluatePricingEligibility, type ProviderPricingPreferenceRow } from '../_shared/pricingEligibility.ts'
import { loadSelectedDogSizesForRequest, mergeSelectedDogSizesIntoClientAttributes } from '../_shared/requestDogSizes.ts'
import {
  getNormalizedProviderServiceTypes,
  normalizeProviderServiceType,
  providerSupportsRequestedService,
} from '../_shared/providerServiceTypes.ts'

type StartDispatchBody = {
  requestId?: string
  timeoutSeconds?: number
  rankedCandidates?: RankedCandidate[]
  resetExisting?: boolean
}

type DispatchAttemptPushParams = {
  requestId: string
  walkerId: string
  attemptId: string
  serviceType?: string | null
}

function getScheduledDispatchLeadMinutes(): number {
  const raw = Deno.env.get('SCHEDULED_DISPATCH_LEAD_MINUTES')
  const parsed = raw ? Number(raw) : NaN
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 15
}

const SCHEDULED_DISPATCH_LEAD_MINUTES = getScheduledDispatchLeadMinutes()
const START_DISPATCH_VERSION = '2026-04-22-payment-gate-01'
const BUDGET_BELOW_MINIMUM_ERROR_PREFIX = 'budget_below_provider_minimum'
const FAIRNESS_RECENT_ATTEMPT_WINDOW_MS = 5 * 60 * 1000

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeAffinityScore(meta: Record<string, unknown>): number {
  const rawAffinityScore = toFiniteNumber(meta.affinity_score)
  if (rawAffinityScore == null) return 0
  if (rawAffinityScore > 1) {
    return Number((Math.min(rawAffinityScore, 30) / 100).toFixed(6))
  }
  return Number(Math.max(0, Math.min(rawAffinityScore, 0.3)).toFixed(6))
}

function getBaseScore(candidate: RankedCandidate): number {
  const meta = candidate.meta ?? {}
  const metaBaseScore = toFiniteNumber(meta.base_score)
  const candidateScore = toFiniteNumber(candidate.score)
  return Number((metaBaseScore ?? candidateScore ?? 0).toFixed(6))
}

function buildPersistedMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> {
  const safeMeta = meta ?? {}
  const source = typeof safeMeta.source === 'string' ? safeMeta.source : null
  const persistedMeta: Record<string, unknown> = {}
  const baseScore =
    typeof safeMeta.base_score === 'number' && Number.isFinite(safeMeta.base_score)
      ? Number(safeMeta.base_score.toFixed(6))
      : null
  const affinityScore = normalizeAffinityScore(safeMeta)

  if (source) {
    persistedMeta.source = source
  }

  const attributeScore = typeof safeMeta.attribute_score === 'number' && Number.isFinite(safeMeta.attribute_score)
    ? Number(safeMeta.attribute_score.toFixed(6))
    : 0
  const cooldownPenalty =
    typeof safeMeta.cooldown_penalty === 'number' && Number.isFinite(safeMeta.cooldown_penalty)
      ? Number(safeMeta.cooldown_penalty.toFixed(6))
      : 0
  const recentAttemptCount =
    typeof safeMeta.recent_attempt_count === 'number' && Number.isFinite(safeMeta.recent_attempt_count)
      ? Math.max(0, Math.floor(safeMeta.recent_attempt_count))
      : 0
  const finalScore =
    typeof safeMeta.final_score === 'number' && Number.isFinite(safeMeta.final_score)
      ? Number(safeMeta.final_score.toFixed(6))
      : baseScore == null
        ? null
        : Number((baseScore + affinityScore + attributeScore - cooldownPenalty).toFixed(6))

  persistedMeta.base_score = baseScore
  persistedMeta.affinity_score = affinityScore
  persistedMeta.affinity_provider_saved = safeMeta.affinity_provider_saved === true
  persistedMeta.affinity_client_saved = safeMeta.affinity_client_saved === true
  persistedMeta.attribute_score = attributeScore
  persistedMeta.attribute_reason = typeof safeMeta.attribute_reason === 'string' ? safeMeta.attribute_reason : 'neutral_missing_attributes'
  persistedMeta.attribute_matches = Array.isArray(safeMeta.attribute_matches) ? safeMeta.attribute_matches : []
  persistedMeta.cooldown_penalty = cooldownPenalty
  persistedMeta.recent_attempt_count = recentAttemptCount
  persistedMeta.final_score = finalScore

  return persistedMeta
}

function getPersistedCandidateScore(candidate: RankedCandidate): number {
  const meta = candidate.meta ?? {}
  const persistedFinalScore = toFiniteNumber(meta.final_score)
  if (persistedFinalScore != null) {
    return Number(persistedFinalScore.toFixed(6))
  }
  const baseScore = getBaseScore(candidate)
  const affinityScore = normalizeAffinityScore(meta)
  const attributeScore = typeof meta.attribute_score === 'number' && Number.isFinite(meta.attribute_score)
    ? meta.attribute_score
    : 0
  const cooldownPenalty = typeof meta.cooldown_penalty === 'number' && Number.isFinite(meta.cooldown_penalty)
    ? meta.cooldown_penalty
    : 0
  return Number((baseScore + affinityScore + attributeScore - cooldownPenalty).toFixed(6))
}

function buildCandidateScoreLog(candidate: RankedCandidate, rank: number) {
  const meta = candidate.meta ?? {}
  const baseScore = getBaseScore(candidate)
  const affinityScore = normalizeAffinityScore(meta)
  const attributeScore =
    typeof meta.attribute_score === 'number' && Number.isFinite(meta.attribute_score)
      ? meta.attribute_score
      : 0
  const cooldownPenalty =
    typeof meta.cooldown_penalty === 'number' && Number.isFinite(meta.cooldown_penalty)
      ? Number(meta.cooldown_penalty.toFixed(6))
      : 0
  const recentAttemptCount =
    typeof meta.recent_attempt_count === 'number' && Number.isFinite(meta.recent_attempt_count)
      ? Math.max(0, Math.floor(meta.recent_attempt_count))
      : 0
  const finalScore =
    typeof meta.final_score === 'number' && Number.isFinite(meta.final_score)
      ? Number(meta.final_score.toFixed(6))
      : Number((baseScore + affinityScore + attributeScore - cooldownPenalty).toFixed(6))
  return {
    rank,
    walkerId: candidate.walkerId,
    score: finalScore,
    base_score: baseScore,
    affinity_score: affinityScore,
    attribute_score: attributeScore,
    final_score: finalScore,
    affinity_provider_saved: meta.affinity_provider_saved === true,
    affinity_client_saved: meta.affinity_client_saved === true,
    distance_score:
      typeof meta.distance_score === 'number' ? meta.distance_score : null,
    rating_score:
      typeof meta.rating_score === 'number' ? meta.rating_score : null,
    review_count_score:
      typeof meta.review_count_score === 'number' ? meta.review_count_score : null,
    distance_km:
      typeof meta.distance_km === 'number' ? meta.distance_km : null,
    avg_rating:
      typeof meta.avg_rating === 'number' ? meta.avg_rating : null,
    review_count:
      typeof meta.review_count === 'number' ? meta.review_count : null,
    source: typeof meta.source === 'string' ? meta.source : null,
    attribute_reason:
      typeof meta.attribute_reason === 'string' ? meta.attribute_reason : 'neutral_missing_attributes',
    attribute_matches:
      Array.isArray(meta.attribute_matches) ? meta.attribute_matches : [],
    cooldown_penalty: cooldownPenalty,
    recent_attempt_count: recentAttemptCount,
  }
}

function buildBudgetBelowMinimumError(params: {
  recommendedMinBudget: number | null
  recommendedPreferredBudget: number | null
}): string {
  return `${BUDGET_BELOW_MINIMUM_ERROR_PREFIX}:${params.recommendedMinBudget ?? ''}:${params.recommendedPreferredBudget ?? ''}`
}

async function sendDispatchOfferPush(params: DispatchAttemptPushParams): Promise<void> {
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

    if (!supabaseUrl || !serviceRoleKey) {
      console.warn('[start-dispatch] dispatch offer push skipped', {
        requestId: params.requestId,
        attemptId: params.attemptId,
        walkerId: params.walkerId,
        reason: 'missing_supabase_env',
      })
      return
    }

    const response = await fetch(`${supabaseUrl}/functions/v1/send-push-notification`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        targetUserId: params.walkerId,
        notificationType: 'new_dispatch_offer',
        relatedJobId: params.requestId,
        deepLink: `regli://dispatch/${params.attemptId}`,
        data: {
          dedupId: params.attemptId,
          dispatchAttemptId: params.attemptId,
          serviceType: params.serviceType ?? null,
        },
      }),
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => '<unreadable>')
      console.warn('[start-dispatch] dispatch offer push failed', {
        requestId: params.requestId,
        attemptId: params.attemptId,
        walkerId: params.walkerId,
        status: response.status,
        body: errorText,
      })
    }
  } catch (error) {
    console.warn('[start-dispatch] dispatch offer push failed', {
      requestId: params.requestId,
      attemptId: params.attemptId,
      walkerId: params.walkerId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    if (req.method !== 'POST') {
      return jsonResponse(405, { ok: false, error: 'Method not allowed' }, corsHeaders)
    }

    const body = (await req.json()) as StartDispatchBody
    const requestId = String(body.requestId ?? '').trim()
    const timeoutSeconds = normalizeTimeoutSeconds(body.timeoutSeconds, 20)
    const rankedCandidates = sanitizeCandidates(body.rankedCandidates)
    const resetExisting = body.resetExisting === true

    console.log('[start-dispatch] enter', {
      version: START_DISPATCH_VERSION,
      requestId,
      timeoutSeconds,
      candidates_before_filters: rankedCandidates.length,
      rankedCandidateCount: rankedCandidates.length,
      rankedCandidateScores: rankedCandidates.slice(0, 10).map((candidate, index) =>
        buildCandidateScoreLog(candidate, index + 1)
      ),
      resetExisting,
    })

    if (!requestId) {
      console.error('[start-dispatch] missing requestId', {
        version: START_DISPATCH_VERSION,
      })
      return jsonResponse(400, { ok: false, error: 'requestId is required' }, corsHeaders)
    }

    const supabase = createAdminClient()

    const { data: requestRow, error: requestError } = await supabase
      .from('walk_requests')
      .select('id, client_id, status, walker_id, booking_timing, scheduled_for, dispatch_state, smart_dispatch_state, smart_dispatch_last_error, payment_status, stripe_payment_intent_id, service_type, dog_count, duration_minutes, price, client_lat, client_lng')
      .eq('id', requestId)
      .single()

    console.log('[start-dispatch] request fetched', {
      version: START_DISPATCH_VERSION,
      requestId,
      requestError: requestError?.message ?? null,
      requestRow,
    })

    if (requestError || !requestRow) {
      return jsonResponse(404, { ok: false, error: 'walk_request not found' }, corsHeaders)
    }

    if (requestRow.status !== 'open') {
      console.warn('[start-dispatch] request is not open', {
        version: START_DISPATCH_VERSION,
        requestId,
        status: requestRow.status,
      })
      return jsonResponse(409, { ok: false, error: 'request is not open' }, corsHeaders)
    }

    if (rankedCandidates.length === 0) {
      const exhaustedMessage = 'No matching providers for service_type'
      console.warn('[start-dispatch] no eligible providers at dispatch start', {
        version: START_DISPATCH_VERSION,
        requestId,
        service_type: requestRow.service_type ?? null,
        booking_type: requestRow.booking_timing === 'scheduled' ? 'scheduled' : 'asap',
        budget: requestRow.price ?? null,
        duration_minutes: requestRow.duration_minutes ?? null,
        dog_count: requestRow.dog_count ?? 1,
        candidates_before_filters: rankedCandidates.length,
        candidates_after_availability_filter: 0,
        candidates_after_pricing_filter: 0,
        eligible_candidates_count: 0,
        no_candidates_at_start: true,
        pricing_filtered_count: 0,
        availability_filtered_count: null,
        exhausted_reason: 'no_candidates_at_start',
      })

      const { error: exhaustedUpdateError } = await supabase
        .from('walk_requests')
        .update({
          dispatch_state: 'queued',
          smart_dispatch_state: 'exhausted',
          smart_dispatch_last_error: exhaustedMessage,
          smart_dispatch_expires_at: null,
        })
        .eq('id', requestId)
        .eq('status', 'open')
        .is('walker_id', null)

      if (exhaustedUpdateError) {
        console.error('[start-dispatch] failed to mark request exhausted with zero ranked candidates', {
          version: START_DISPATCH_VERSION,
          requestId,
          error: exhaustedUpdateError.message,
        })
        return jsonResponse(
          500,
          {
            ok: false,
            error: 'failed to mark request exhausted',
            details: exhaustedUpdateError.message,
            requestId,
          },
          corsHeaders,
        )
      }

      return jsonResponse(
        200,
        {
          ok: true,
          exhausted: true,
          error: exhaustedMessage,
          exhausted_reason: 'no_candidates_at_start',
          noCandidatesAtStart: true,
          candidateCount: 0,
          requestState: {
            dispatch_state: 'queued',
            smart_dispatch_state: 'exhausted',
            smart_dispatch_last_error: exhaustedMessage,
          },
        },
        corsHeaders,
      )
    }

    const hasDispatchReadyPaymentStatus =
      requestRow.payment_status === 'authorized' ||
      requestRow.payment_status === 'requires_capture'

    if (!hasDispatchReadyPaymentStatus || !requestRow.stripe_payment_intent_id) {
      console.warn('[start-dispatch] request payment is not authorized', {
        version: START_DISPATCH_VERSION,
        requestId,
        paymentStatus: requestRow.payment_status,
        hasPaymentIntent: !!requestRow.stripe_payment_intent_id,
      })

      await supabase
        .from('walk_requests')
        .update({
          status: 'cancelled',
          dispatch_state: 'cancelled',
          smart_dispatch_state: 'cancelled',
          smart_dispatch_last_error: 'payment authorization missing',
        })
        .eq('id', requestId)
        .eq('status', 'open')
        .not('payment_status', 'in', '("authorized","requires_capture")')

      return jsonResponse(
        409,
        {
          ok: false,
          error: 'payment authorization required before dispatch',
          paymentStatus: requestRow.payment_status,
        },
        corsHeaders,
      )
    }

    if (requestRow.walker_id) {
      console.warn('[start-dispatch] request already assigned', {
        version: START_DISPATCH_VERSION,
        requestId,
        walkerId: requestRow.walker_id,
      })
      return jsonResponse(409, { ok: false, error: 'request already assigned' }, corsHeaders)
    }

    let effectiveDispatchState = requestRow.dispatch_state
    let effectiveSmartDispatchState = requestRow.smart_dispatch_state

    if (requestRow.dispatch_state === 'dispatched' || requestRow.smart_dispatch_state === 'dispatching') {
      const [
        { count: existingCandidateCount, error: existingCandidateCountError },
        { count: existingPendingAttemptCount, error: existingPendingAttemptCountError },
      ] = await Promise.all([
        supabase
          .from('dispatch_candidates')
          .select('id', { count: 'exact', head: true })
          .eq('request_id', requestId),
        supabase
          .from('dispatch_attempts')
          .select('id', { count: 'exact', head: true })
          .eq('request_id', requestId)
          .eq('status', 'pending')
          .gt('expires_at', new Date().toISOString()),
      ])

      console.log('[start-dispatch] existing dispatch state check', {
        version: START_DISPATCH_VERSION,
        requestId,
        dispatchState: requestRow.dispatch_state ?? null,
        smartDispatchState: requestRow.smart_dispatch_state ?? null,
        existingCandidateCount,
        existingCandidateCountError: existingCandidateCountError?.message ?? null,
        existingPendingAttemptCount,
        existingPendingAttemptCountError: existingPendingAttemptCountError?.message ?? null,
      })

      if (!existingCandidateCountError && !existingPendingAttemptCountError) {
        const hasLiveDispatchRows = (existingCandidateCount ?? 0) > 0 || (existingPendingAttemptCount ?? 0) > 0
        if (!hasLiveDispatchRows) {
          console.warn('[start-dispatch] repairing stale dispatched request state without live rows', {
            version: START_DISPATCH_VERSION,
            requestId,
            dispatchState: requestRow.dispatch_state ?? null,
            smartDispatchState: requestRow.smart_dispatch_state ?? null,
          })

          const { error: staleRepairError } = await supabase
            .from('walk_requests')
            .update({
              dispatch_state: 'queued',
              smart_dispatch_state: 'idle',
              smart_dispatch_last_error: 'stale dispatch state repaired before restart',
              smart_dispatch_expires_at: null,
            })
            .eq('id', requestId)
            .eq('status', 'open')
            .is('walker_id', null)

          if (staleRepairError) {
            console.error('[start-dispatch] failed repairing stale dispatched request state', {
              version: START_DISPATCH_VERSION,
              requestId,
              error: staleRepairError.message,
            })
            return jsonResponse(
              500,
              {
                ok: false,
                error: 'failed to repair stale dispatch state',
                details: staleRepairError.message,
              },
              corsHeaders,
            )
          }

          effectiveDispatchState = 'queued'
          effectiveSmartDispatchState = 'idle'
        }
      }
    }

    if (!resetExisting && effectiveSmartDispatchState === 'dispatching') {
      console.warn('[start-dispatch] dispatch already active', {
        version: START_DISPATCH_VERSION,
        requestId,
        smartDispatchState: effectiveSmartDispatchState,
        dispatchState: effectiveDispatchState,
      })
      return jsonResponse(409, { ok: false, error: 'dispatch already active' }, corsHeaders)
    }

    const clientId = typeof requestRow.client_id === 'string' ? requestRow.client_id : null
    const requestProviderServiceType = normalizeProviderServiceType(requestRow.service_type)
    const candidateWalkerIds = Array.from(
      new Set(
        rankedCandidates
          .map((candidate) => candidate.walkerId)
          .filter((walkerId): walkerId is string => typeof walkerId === 'string' && walkerId.length > 0),
      ),
    )

    let providerSavedCustomerIds = new Set<string>()
    let customerSavedProviderIds = new Set<string>()
    let matchingServiceWalkerIds: Set<string> | null = null
    let providerServiceAttrsById = new Map<string, Record<string, unknown>>()
    let clientServiceAttributes: Record<string, unknown> | null = null
    let providerPricingPreferenceRows: ProviderPricingPreferenceRow[] = []

    if (candidateWalkerIds.length > 0) {
      const [
        { data: walkerProfileRows, error: walkerProfilesError },
        { data: favoriteCustomersRows, error: favoriteCustomersError },
        { data: favoriteWalkersRows, error: favoriteWalkersError },
        { data: clientProfileRow },
        { data: providerPricingRows, error: providerPricingError },
      ] = await Promise.all([
        supabase
          .from('profiles')
          .select('id, role, is_online, service_type, service_types, service_attributes')
          .in('id', candidateWalkerIds),
        supabase
          .from('favorite_customers')
          .select('walker_id')
          .eq('client_id', clientId ?? '')
          .in('walker_id', candidateWalkerIds),
        supabase
          .from('favorite_walkers')
          .select('walker_id')
          .eq('client_id', clientId ?? '')
          .in('walker_id', candidateWalkerIds),
        clientId
          ? supabase
              .from('profiles')
              .select('service_attributes')
              .eq('id', clientId)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null }),
        supabase
          .from('provider_service_preferences')
          .select('provider_id, service_type, pricing_model, booking_type, is_enabled, hourly_rate_min, hourly_rate_preferred, service_radius_km, accepts_multi_item, max_item_count')
          .in('provider_id', candidateWalkerIds)
          .eq('pricing_model', 'time_based'),
      ])

      const selectedDogSizes = await loadSelectedDogSizesForRequest({
        supabase,
        clientId,
        dogNameValue: requestRow.dog_name ?? null,
      })
      clientServiceAttributes = mergeSelectedDogSizesIntoClientAttributes(
        (clientProfileRow as { service_attributes?: unknown } | null)?.service_attributes as Record<string, unknown> | null ?? null,
        selectedDogSizes,
      )
      providerPricingPreferenceRows = (providerPricingRows as ProviderPricingPreferenceRow[] | null) ?? []

      if (providerPricingError) {
        console.error('[start-dispatch] failed loading provider pricing preferences', {
          version: START_DISPATCH_VERSION,
          requestId,
          error: providerPricingError.message,
        })
        providerPricingPreferenceRows = []
      }

      if (walkerProfilesError) {
        console.error('[start-dispatch] failed loading candidate service types', {
          version: START_DISPATCH_VERSION,
          requestId,
          error: walkerProfilesError.message,
        })
      } else if (requestProviderServiceType) {
        const candidateCapabilityRows = ((
          walkerProfileRows as Array<{
            id: string
            role?: string | null
            is_online?: boolean | null
            service_type: string | null
            service_types?: string[] | string | null
            service_attributes?: Record<string, unknown> | null
          }> | null
        ) ?? [])

        for (const row of candidateCapabilityRows) {
          if (row.service_attributes && typeof row.service_attributes === 'object') {
            providerServiceAttrsById.set(row.id, row.service_attributes)
          }
        }

        candidateCapabilityRows.forEach((row) => {
          const normalizedServiceTypes = getNormalizedProviderServiceTypes(row.service_types)
          const matched = providerSupportsRequestedService(row, requestProviderServiceType)
          console.log('[start-dispatch] candidate capability', {
            version: START_DISPATCH_VERSION,
            requestId,
            walkerId: row.id,
            role: row.role ?? null,
            is_online: row.is_online ?? null,
            legacyServiceType: row.service_type ?? null,
            serviceTypesRaw: row.service_types ?? null,
            normalizedServiceTypes,
            requestServiceType: requestRow.service_type ?? null,
            normalizedRequestServiceType: requestProviderServiceType,
            matched,
          })
        })

        matchingServiceWalkerIds = new Set(
          candidateCapabilityRows
            .filter((row) => providerSupportsRequestedService(row, requestProviderServiceType))
            .map((row) => row.id),
        )
      }

      if (clientId && favoriteCustomersError) {
        console.error('[start-dispatch] failed loading provider->customer affinity', {
          version: START_DISPATCH_VERSION,
          requestId,
          clientId,
          error: favoriteCustomersError.message,
        })
      } else if (clientId) {
        providerSavedCustomerIds = new Set(
          (favoriteCustomersRows ?? [])
            .map((row) => row.walker_id)
            .filter((walkerId): walkerId is string => typeof walkerId === 'string' && walkerId.length > 0),
        )
      }

      if (clientId && favoriteWalkersError) {
        console.error('[start-dispatch] failed loading customer->provider affinity', {
          version: START_DISPATCH_VERSION,
          requestId,
          clientId,
          error: favoriteWalkersError.message,
        })
      } else if (clientId) {
        customerSavedProviderIds = new Set(
          (favoriteWalkersRows ?? [])
            .map((row) => row.walker_id)
            .filter((walkerId): walkerId is string => typeof walkerId === 'string' && walkerId.length > 0),
        )
      }
    } else {
      console.log('[start-dispatch] affinity lookup skipped', {
        version: START_DISPATCH_VERSION,
        requestId,
        clientId,
        candidateWalkerCount: candidateWalkerIds.length,
      })
    }

    const dogSizeCompatibleCandidates = rankedCandidates.filter((candidate) => {
      const providerAttrs = providerServiceAttrsById.get(candidate.walkerId) ?? null
      const compatibility = evaluateDogSizeCompatibility(
        requestProviderServiceType,
        clientServiceAttributes,
        providerAttrs,
      )

      if (!compatibility.compatible) {
        console.log('[start-dispatch] candidate excluded by dog size compatibility', {
          version: START_DISPATCH_VERSION,
          requestId,
          clientId,
          walker_id: candidate.walkerId,
          requestServiceType: requestProviderServiceType,
          reason: compatibility.reason,
          knownClientDogSizes: compatibility.knownClientDogSizes,
          providerAcceptedDogSizes: compatibility.providerAcceptedDogSizes,
          missingClientDogSizes: compatibility.missingClientDogSizes,
        })
      }

      return compatibility.compatible
    })

    const affinityRankedCandidates = dogSizeCompatibleCandidates
      .filter((candidate) => {
        if (!matchingServiceWalkerIds) return true
        return matchingServiceWalkerIds.has(candidate.walkerId)
      })
      .map((candidate) => {
        const providerSavedCustomer = providerSavedCustomerIds.has(candidate.walkerId)
        const customerSavedProvider = customerSavedProviderIds.has(candidate.walkerId)
        const baseScore = getBaseScore(candidate)

        const providerAttrs = providerServiceAttrsById.get(candidate.walkerId) ?? null
        const attrResult = computeAttributeScore(
          requestProviderServiceType,
          clientServiceAttributes,
          providerAttrs,
        )
        const candidateAttrScore = typeof candidate.meta?.attribute_score === 'number'
          ? candidate.meta.attribute_score
          : attrResult.attributeScore

        const [rankedSelection] = rankDispatchCandidatesByFinalScore([
          {
            walkerId: candidate.walkerId,
            baseScore,
            affinityProviderSaved: providerSavedCustomer,
            affinityClientSaved: customerSavedProvider,
            distanceKm: toFiniteNumber(candidate.meta?.distance_km),
            avgRating: toFiniteNumber(candidate.meta?.avg_rating),
            reviewCount: toFiniteNumber(candidate.meta?.review_count),
            attributeScore: candidateAttrScore,
          },
        ])
        const affinityScore = rankedSelection?.affinityScore ?? 0
        const attributeScore = rankedSelection?.attributeScore ?? candidateAttrScore
        const finalScore = rankedSelection?.finalScore ?? baseScore
        const meta = {
          ...(candidate.meta ?? {}),
          base_score: baseScore,
          affinity_score: affinityScore,
          affinity_provider_saved: providerSavedCustomer,
          affinity_client_saved: customerSavedProvider,
          attribute_score: attributeScore,
          attribute_reason: attrResult.attributeReason,
          attribute_matches: attrResult.attributeMatches,
          final_score: finalScore,
        }

        console.log('[start-dispatch] candidate affinity recomputed', {
          version: START_DISPATCH_VERSION,
          requestId,
          clientId,
          walker_id: candidate.walkerId,
          base_score: baseScore,
          affinity_score: affinityScore,
          attribute_score: attributeScore,
          attribute_reason: attrResult.attributeReason,
          final_score: finalScore,
          affinity_provider_saved: providerSavedCustomer,
          affinity_client_saved: customerSavedProvider,
        })

        return {
          ...candidate,
          score: finalScore,
          meta,
        }
      })

    console.log('[start-dispatch] candidates after service_type filtering', {
      version: START_DISPATCH_VERSION,
      requestId,
      action: 'matching_started',
      requestServiceType: requestRow.service_type ?? null,
      normalizedProviderServiceType: requestProviderServiceType,
      candidates_before_filters: rankedCandidates.length,
      candidates_after_dog_size_filter: dogSizeCompatibleCandidates.length,
      candidates_after_availability_filter: affinityRankedCandidates.length,
      candidateCountBeforeServiceTypeFilter: rankedCandidates.length,
      providersFoundCount: affinityRankedCandidates.length,
    })

    const pricingEligibility = evaluatePricingEligibility({
      candidateWalkerIds: affinityRankedCandidates.map((candidate) => candidate.walkerId),
      preferences: providerPricingPreferenceRows,
      serviceType: requestRow.service_type,
      bookingType: requestRow.booking_timing === 'scheduled' ? 'scheduled' : 'asap',
      budgetILS: typeof requestRow.price === 'number' ? requestRow.price : null,
      durationMinutes: typeof requestRow.duration_minutes === 'number' ? requestRow.duration_minutes : null,
      dogCount: typeof requestRow.dog_count === 'number' ? requestRow.dog_count : 1,
      distanceByWalkerId: Object.fromEntries(
        affinityRankedCandidates.map((candidate) => [
          candidate.walkerId,
          typeof candidate.meta?.distance_km === 'number' && Number.isFinite(candidate.meta.distance_km)
            ? candidate.meta.distance_km
            : null,
        ]),
      ),
    })

    const eligibleWalkerIdSet = new Set(pricingEligibility.eligibleWalkerIds)
    const pricingFilteredCandidates = affinityRankedCandidates.filter((candidate) =>
      eligibleWalkerIdSet.has(candidate.walkerId)
    )

    console.log('[start-dispatch] pricing eligibility filter', {
      version: START_DISPATCH_VERSION,
      requestId,
      service_type: requestRow.service_type ?? null,
      booking_type: requestRow.booking_timing === 'scheduled' ? 'scheduled' : 'asap',
      budget: requestRow.price ?? null,
      duration_minutes: requestRow.duration_minutes ?? null,
      dog_count: requestRow.dog_count ?? 1,
      candidates_before_filters: rankedCandidates.length,
      candidates_after_availability_filter: affinityRankedCandidates.length,
      candidates_after_pricing_filter: pricingFilteredCandidates.length,
      eligible_candidates_count: pricingFilteredCandidates.length,
      no_candidates_at_start: pricingFilteredCandidates.length === 0,
      candidate_count_before_pricing_filter: affinityRankedCandidates.length,
      candidate_count_after_pricing_filter: pricingFilteredCandidates.length,
      filtered_by_price_count: pricingEligibility.filteredByPriceWalkerIds.length,
      filtered_by_multi_item_count: pricingEligibility.filteredByMultiItemWalkerIds.length,
      filtered_by_radius_count: pricingEligibility.filteredByRadiusWalkerIds.length,
      availability_filtered_count:
        rankedCandidates.length >= affinityRankedCandidates.length
          ? rankedCandidates.length - affinityRankedCandidates.length
          : null,
      effective_hourly_rate: pricingEligibility.effectiveHourlyRate,
      aggregated_min_hourly: pricingEligibility.aggregatedMinHourly,
      aggregated_preferred_hourly: pricingEligibility.aggregatedPreferredHourly,
      recommended_min_budget: pricingEligibility.recommendedMinBudget,
      recommended_preferred_budget: pricingEligibility.recommendedPreferredBudget,
      provider_pricing_rows_count: pricingEligibility.relevantPreferenceRowsCount,
    })

    if (pricingFilteredCandidates.length === 0) {
      const exhaustedMessage =
        affinityRankedCandidates.length > 0 && pricingEligibility.filteredByPriceWalkerIds.length > 0
          ? buildBudgetBelowMinimumError({
              recommendedMinBudget: pricingEligibility.recommendedMinBudget,
              recommendedPreferredBudget: pricingEligibility.recommendedPreferredBudget,
            })
          : 'No matching providers for service_type'
      console.warn('[start-dispatch] no candidates match request service type', {
        version: START_DISPATCH_VERSION,
        requestId,
        requestServiceType: requestRow.service_type,
        normalizedProviderServiceType: requestProviderServiceType,
        candidates_before_filters: rankedCandidates.length,
        candidates_after_availability_filter: affinityRankedCandidates.length,
        candidates_after_pricing_filter: 0,
        eligible_candidates_count: 0,
        no_candidates_at_start: true,
        candidateCountBeforePricingFilter: affinityRankedCandidates.length,
        filteredByPriceCount: pricingEligibility.filteredByPriceWalkerIds.length,
        filteredByMultiItemCount: pricingEligibility.filteredByMultiItemWalkerIds.length,
        filteredByRadiusCount: pricingEligibility.filteredByRadiusWalkerIds.length,
        availabilityFilteredCount:
          rankedCandidates.length >= affinityRankedCandidates.length
            ? rankedCandidates.length - affinityRankedCandidates.length
            : null,
        exhausted_reason: 'no_candidates_at_start',
        finalRequestState: {
          dispatch_state: 'queued',
          smart_dispatch_state: 'exhausted',
          smart_dispatch_last_error: exhaustedMessage,
        },
      })

      const { error: exhaustedUpdateError } = await supabase
        .from('walk_requests')
        .update({
          dispatch_state: 'queued',
          smart_dispatch_state: 'exhausted',
          smart_dispatch_last_error: exhaustedMessage,
          smart_dispatch_expires_at: null,
        })
        .eq('id', requestId)
        .eq('status', 'open')
        .is('walker_id', null)

      if (exhaustedUpdateError) {
        console.error('[start-dispatch] failed to mark request exhausted after zero candidates', {
          version: START_DISPATCH_VERSION,
          requestId,
          error: exhaustedUpdateError.message,
        })
        return jsonResponse(
          500,
          {
            ok: false,
            error: 'failed to mark request exhausted',
            details: exhaustedUpdateError.message,
            requestId,
          },
          corsHeaders,
        )
      }

      return jsonResponse(
        200,
        {
          ok: true,
          exhausted: true,
          error: exhaustedMessage,
          exhausted_reason: 'no_candidates_at_start',
          requestServiceType: requestRow.service_type,
          candidateCount: 0,
          filteredByPriceCount: pricingEligibility.filteredByPriceWalkerIds.length,
          filteredByMultiItemCount: pricingEligibility.filteredByMultiItemWalkerIds.length,
          filteredByRadiusCount: pricingEligibility.filteredByRadiusWalkerIds.length,
          recommendedMinBudget: pricingEligibility.recommendedMinBudget,
          recommendedPreferredBudget: pricingEligibility.recommendedPreferredBudget,
          requestState: {
            dispatch_state: 'queued',
            smart_dispatch_state: 'exhausted',
            smart_dispatch_last_error: exhaustedMessage,
          },
        },
        corsHeaders,
      )
    }

    const recentAttemptCountsByWalkerId = new Map<string, number>()
    const fairnessWindowStartIso = new Date(Date.now() - FAIRNESS_RECENT_ATTEMPT_WINDOW_MS).toISOString()

    if (pricingFilteredCandidates.length > 0) {
      const fairnessWalkerIds = pricingFilteredCandidates.map((candidate) => candidate.walkerId)
      const { data: recentAttemptsRows, error: recentAttemptsError } = await supabase
        .from('dispatch_attempts')
        .select('walker_id, created_at')
        .in('walker_id', fairnessWalkerIds)
        .gte('created_at', fairnessWindowStartIso)

      if (recentAttemptsError) {
        console.error('[start-dispatch] failed loading recent dispatch attempts for fairness scoring', {
          version: START_DISPATCH_VERSION,
          requestId,
          windowStart: fairnessWindowStartIso,
          error: recentAttemptsError.message,
        })
      } else {
        for (const row of (recentAttemptsRows ?? []) as Array<{ walker_id?: string | null }>) {
          if (typeof row.walker_id !== 'string' || row.walker_id.length === 0) continue
          recentAttemptCountsByWalkerId.set(
            row.walker_id,
            (recentAttemptCountsByWalkerId.get(row.walker_id) ?? 0) + 1,
          )
        }
      }
    }

    const affinityRankedCandidateOrder = rankDispatchCandidatesByFinalScore(
      pricingFilteredCandidates.map((candidate) => ({
        walkerId: candidate.walkerId,
        baseScore: getBaseScore(candidate),
        affinityProviderSaved: candidate.meta?.affinity_provider_saved === true,
        affinityClientSaved: candidate.meta?.affinity_client_saved === true,
        distanceKm: toFiniteNumber(candidate.meta?.distance_km),
        avgRating: toFiniteNumber(candidate.meta?.avg_rating),
        reviewCount: toFiniteNumber(candidate.meta?.review_count),
        attributeScore: typeof candidate.meta?.attribute_score === 'number' ? candidate.meta.attribute_score : 0,
        recentAttemptCount: recentAttemptCountsByWalkerId.get(candidate.walkerId) ?? 0,
      })),
    )

    const affinityRankedCandidatesByWalkerId = new Map(
      pricingFilteredCandidates.map((candidate) => [candidate.walkerId, candidate]),
    )

    const rerankedCandidates = affinityRankedCandidateOrder
      .map((selection) => {
        const candidate = affinityRankedCandidatesByWalkerId.get(selection.walkerId)
        if (!candidate) return null
        return {
          ...candidate,
          score: selection.finalScore,
          meta: {
            ...(candidate.meta ?? {}),
            base_score: selection.baseScore,
            affinity_score: selection.affinityScore,
            affinity_provider_saved: selection.affinityProviderSaved,
            affinity_client_saved: selection.affinityClientSaved,
            attribute_score:
              typeof candidate.meta?.attribute_score === 'number' && Number.isFinite(candidate.meta.attribute_score)
                ? Number(candidate.meta.attribute_score.toFixed(6))
                : 0,
            attribute_reason:
              typeof candidate.meta?.attribute_reason === 'string'
                ? candidate.meta.attribute_reason
                : 'neutral_missing_attributes',
            attribute_matches:
              Array.isArray(candidate.meta?.attribute_matches) ? candidate.meta.attribute_matches : [],
            cooldown_penalty: selection.cooldownPenalty,
            recent_attempt_count: selection.recentAttemptCount,
            final_score: selection.finalScore,
          },
        }
      })
      .filter((candidate): candidate is RankedCandidate => candidate != null)

    if (requestRow.booking_timing === 'scheduled') {
      if (!requestRow.scheduled_for) {
        console.error('[start-dispatch] scheduled request missing scheduled_for', {
          version: START_DISPATCH_VERSION,
          requestId,
        })
        return jsonResponse(409, { ok: false, error: 'scheduled request is missing scheduled_for' }, corsHeaders)
      }

      const scheduledAt = new Date(requestRow.scheduled_for).getTime()
      if (Number.isNaN(scheduledAt)) {
        console.error('[start-dispatch] scheduled_for invalid', {
          version: START_DISPATCH_VERSION,
          requestId,
          scheduledFor: requestRow.scheduled_for,
        })
        return jsonResponse(409, { ok: false, error: 'scheduled_for is invalid' }, corsHeaders)
      }

      const dispatchWindowOpensAt = scheduledAt - SCHEDULED_DISPATCH_LEAD_MINUTES * 60 * 1000
      const nowMs = Date.now()

      console.log('[start-dispatch] scheduled timing check', {
        version: START_DISPATCH_VERSION,
        requestId,
        scheduledFor: requestRow.scheduled_for,
        scheduledAtIso: new Date(scheduledAt).toISOString(),
        dispatchWindowOpensAtIso: new Date(dispatchWindowOpensAt).toISOString(),
        nowIso: new Date(nowMs).toISOString(),
        millisecondsUntilWindow: dispatchWindowOpensAt - nowMs,
      })

      if (nowMs < dispatchWindowOpensAt) {
        console.warn('[start-dispatch] scheduled dispatch window not started', {
          version: START_DISPATCH_VERSION,
          requestId,
          scheduledFor: requestRow.scheduled_for,
        })
        return jsonResponse(
          409,
          {
            ok: false,
            error: 'scheduled dispatch window has not started',
            scheduledFor: requestRow.scheduled_for,
          },
          corsHeaders,
        )
      }
    }

    if (resetExisting) {
      console.log('[start-dispatch] clearing existing attempts', {
        version: START_DISPATCH_VERSION,
        requestId,
      })

      const { error: deleteAttemptsError } = await supabase
        .from('dispatch_attempts')
        .delete()
        .eq('request_id', requestId)

      if (deleteAttemptsError) {
        console.error('[start-dispatch] failed clearing existing attempts', {
          version: START_DISPATCH_VERSION,
          requestId,
          error: deleteAttemptsError.message,
        })

        if (requestRow.booking_timing === 'scheduled') {
          const { error: resetError } = await supabase
            .from('walk_requests')
            .update({
              dispatch_state: 'queued',
              smart_dispatch_state: 'idle',
              smart_dispatch_last_error: deleteAttemptsError.message,
              smart_dispatch_expires_at: null,
            })
            .eq('id', requestId)
            .eq('status', 'open')
            .is('walker_id', null)

          if (resetError) {
            console.error('[start-dispatch] failed to reset scheduled request after deleteAttemptsError', {
              version: START_DISPATCH_VERSION,
              requestId,
              error: resetError.message,
            })
          }
        }

        return jsonResponse(
          500,
          {
            ok: false,
            error: 'failed to clear existing attempts',
            details: deleteAttemptsError.message,
          },
          corsHeaders,
        )
      }
    }

    console.log('[start-dispatch] clearing previous candidates', {
      version: START_DISPATCH_VERSION,
      requestId,
    })

    const { error: deleteCandidatesError } = await supabase
      .from('dispatch_candidates')
      .delete()
      .eq('request_id', requestId)

    if (deleteCandidatesError) {
      console.error('[start-dispatch] failed clearing previous candidates', {
        version: START_DISPATCH_VERSION,
        requestId,
        error: deleteCandidatesError.message,
      })

      if (requestRow.booking_timing === 'scheduled') {
        const { error: resetError } = await supabase
          .from('walk_requests')
          .update({
            dispatch_state: 'queued',
            smart_dispatch_state: 'idle',
            smart_dispatch_last_error: deleteCandidatesError.message,
            smart_dispatch_expires_at: null,
          })
          .eq('id', requestId)
          .eq('status', 'open')
          .is('walker_id', null)

        if (resetError) {
          console.error('[start-dispatch] failed to reset scheduled request after deleteCandidatesError', {
            version: START_DISPATCH_VERSION,
            requestId,
            error: resetError.message,
          })
        }
      }

      return jsonResponse(
        500,
        {
          ok: false,
          error: 'failed to clear previous candidates',
          details: deleteCandidatesError.message,
        },
        corsHeaders,
      )
    }

    const candidateRows = rerankedCandidates.map((candidate, index) => ({
      request_id: requestId,
      walker_id: candidate.walkerId,
      rank: index + 1,
      score: getPersistedCandidateScore(candidate),
      meta: buildPersistedMeta(candidate.meta),
    }))

    console.log('[start-dispatch] inserting candidates', {
      version: START_DISPATCH_VERSION,
      requestId,
      insertedCandidatesCount: candidateRows.length,
      candidateWalkerIds: candidateRows.map((row) => row.walker_id),
      candidateScoreBreakdown: rerankedCandidates.slice(0, 10).map((candidate, index) =>
        buildCandidateScoreLog(candidate, index + 1)
      ),
    })

    const { error: insertCandidatesError } = await supabase
      .from('dispatch_candidates')
      .insert(candidateRows)

    if (insertCandidatesError) {
      console.error('[start-dispatch] failed inserting candidates', {
        version: START_DISPATCH_VERSION,
        requestId,
        error: insertCandidatesError.message,
      })

      if (requestRow.booking_timing === 'scheduled') {
        const { error: resetError } = await supabase
          .from('walk_requests')
          .update({
            dispatch_state: 'queued',
            smart_dispatch_state: 'idle',
            smart_dispatch_last_error: insertCandidatesError.message,
            smart_dispatch_expires_at: null,
          })
          .eq('id', requestId)
          .eq('status', 'open')
          .is('walker_id', null)

        if (resetError) {
          console.error('[start-dispatch] failed to reset scheduled request after insertCandidatesError', {
            version: START_DISPATCH_VERSION,
            requestId,
            error: resetError.message,
          })
        }
      }

      return jsonResponse(
        500,
        {
          ok: false,
          error: 'failed to insert dispatch candidates',
          details: insertCandidatesError.message,
        },
        corsHeaders,
      )
    }

    const { count: persistedCandidateCount, error: persistedCandidateCountError } = await supabase
      .from('dispatch_candidates')
      .select('id', { count: 'exact', head: true })
      .eq('request_id', requestId)

    console.log('[start-dispatch] candidate persistence verification', {
      version: START_DISPATCH_VERSION,
      requestId,
      providersFoundCount: rerankedCandidates.length,
      candidatesInsertedCount: candidateRows.length,
      persistedCandidateCount,
      persistedCandidateCountError: persistedCandidateCountError?.message ?? null,
    })

    if (persistedCandidateCountError || !persistedCandidateCount) {
      const message =
        persistedCandidateCountError?.message ??
        'dispatch candidates missing immediately after insert'

      console.error('[start-dispatch] candidate persistence verification failed', {
        version: START_DISPATCH_VERSION,
        requestId,
        message,
      })

      const { error: resetStateError } = await supabase
        .from('walk_requests')
        .update({
          dispatch_state: 'queued',
          smart_dispatch_state: 'idle',
          smart_dispatch_last_error: message,
          smart_dispatch_expires_at: null,
        })
        .eq('id', requestId)
        .eq('status', 'open')
        .is('walker_id', null)

      if (resetStateError) {
        console.error('[start-dispatch] failed to reset request after candidate persistence failure', {
          version: START_DISPATCH_VERSION,
          requestId,
          error: resetStateError.message,
        })
      }

      return jsonResponse(
        409,
        {
          ok: false,
          error: message,
          requestId,
          providersFoundCount: rerankedCandidates.length,
          insertedCandidatesCount: candidateRows.length,
        },
        corsHeaders,
      )
    }

    console.log('[start-dispatch] initializing request dispatch metadata', {
      version: START_DISPATCH_VERSION,
      requestId,
    })

    const { error: initRequestError } = await supabase
      .from('walk_requests')
      .update({
        smart_dispatch_cursor: 0,
        smart_dispatch_started_at: new Date().toISOString(),
        smart_dispatch_expires_at: null,
        smart_dispatch_completed_at: null,
        smart_assigned_attempt_id: null,
        smart_dispatch_last_error: null,
      })
      .eq('id', requestId)

    if (initRequestError) {
      console.error('[start-dispatch] failed initializing dispatch state', {
        version: START_DISPATCH_VERSION,
        requestId,
        error: initRequestError.message,
      })

      if (requestRow.booking_timing === 'scheduled') {
        const { error: resetError } = await supabase
          .from('walk_requests')
          .update({
            dispatch_state: 'queued',
            smart_dispatch_state: 'idle',
            smart_dispatch_last_error: initRequestError.message,
            smart_dispatch_expires_at: null,
          })
          .eq('id', requestId)
          .eq('status', 'open')
          .is('walker_id', null)

        if (resetError) {
          console.error('[start-dispatch] failed to reset scheduled request after initRequestError', {
            version: START_DISPATCH_VERSION,
            requestId,
            error: resetError.message,
          })
        }
      }

      return jsonResponse(
        500,
        {
          ok: false,
          error: 'failed to initialize dispatch state',
          details: initRequestError.message,
        },
        corsHeaders,
      )
    }

    console.log('[start-dispatch] logging dispatch_started event', {
      version: START_DISPATCH_VERSION,
      requestId,
      candidateCount: rerankedCandidates.length,
      timeoutSeconds,
    })

    const { error: logError } = await supabase.rpc('log_dispatch_event', {
      p_request_id: requestId,
      p_attempt_id: null,
      p_event_type: 'dispatch_started',
      p_payload: {
        providersFoundCount: rerankedCandidates.length,
        candidateCount: rerankedCandidates.length,
        candidatesInsertedCount: persistedCandidateCount,
        timeoutSeconds,
        version: START_DISPATCH_VERSION,
      },
    })

    if (logError) {
      console.error('[start-dispatch] failed logging dispatch_started', {
        version: START_DISPATCH_VERSION,
        requestId,
        error: logError.message,
      })

      if (requestRow.booking_timing === 'scheduled') {
        const { error: resetError } = await supabase
          .from('walk_requests')
          .update({
            dispatch_state: 'queued',
            smart_dispatch_state: 'idle',
            smart_dispatch_last_error: logError.message,
            smart_dispatch_expires_at: null,
          })
          .eq('id', requestId)
          .eq('status', 'open')
          .is('walker_id', null)

        if (resetError) {
          console.error('[start-dispatch] failed to reset scheduled request after logError', {
            version: START_DISPATCH_VERSION,
            requestId,
            error: resetError.message,
          })
        }
      }

      return jsonResponse(
        500,
        {
          ok: false,
          error: 'failed to log dispatch start',
          details: logError.message,
        },
        corsHeaders,
      )
    }

    console.log('[start-dispatch] advancing dispatch request', {
      version: START_DISPATCH_VERSION,
      requestId,
      timeoutSeconds,
    })

    const { data: advanceResult, error: advanceError } = await supabase.rpc(
      'advance_dispatch_request',
      {
        p_request_id: requestId,
        p_timeout_seconds: timeoutSeconds,
      },
    )

    console.log('[start-dispatch] advance result', {
      version: START_DISPATCH_VERSION,
      requestId,
      advanceError: advanceError?.message ?? null,
      advanceResult,
    })

    if (advanceError) {
      console.error('[start-dispatch] failed opening first attempt', {
        version: START_DISPATCH_VERSION,
        requestId,
        error: advanceError.message,
      })

      if (requestRow.booking_timing === 'scheduled') {
        const { error: resetError } = await supabase
          .from('walk_requests')
          .update({
            dispatch_state: 'queued',
            smart_dispatch_state: 'idle',
            smart_dispatch_last_error: advanceError.message,
            smart_dispatch_expires_at: null,
          })
          .eq('id', requestId)
          .eq('status', 'open')
          .is('walker_id', null)

        if (resetError) {
          console.error('[start-dispatch] failed to reset scheduled request after advanceError', {
            version: START_DISPATCH_VERSION,
            requestId,
            error: resetError.message,
          })
        }
      }

      return jsonResponse(
        500,
        {
          ok: false,
          error: 'failed to open first attempt',
          details: advanceError.message,
        },
        corsHeaders,
      )
    }

    const firstAdvanceRow = Array.isArray(advanceResult) ? advanceResult[0] : advanceResult
    const createdAttemptId = typeof firstAdvanceRow?.attempt_id === 'string' ? firstAdvanceRow.attempt_id : null
    const createdAttemptStatus = typeof firstAdvanceRow?.status === 'string' ? firstAdvanceRow.status : null
    if (!firstAdvanceRow?.ok || !firstAdvanceRow?.attempt_id) {
      const message =
        typeof firstAdvanceRow?.message === 'string'
          ? firstAdvanceRow.message
          : 'dispatch did not open an attempt'

      console.warn('[start-dispatch] advance returned no live attempt', {
        version: START_DISPATCH_VERSION,
        requestId,
        message,
        firstAdvanceRow,
      })

      const { error: resetStateError } = await supabase
        .from('walk_requests')
        .update({
          dispatch_state: 'queued',
          smart_dispatch_state: 'idle',
          smart_dispatch_last_error: message,
          smart_dispatch_expires_at: null,
        })
        .eq('id', requestId)

      if (resetStateError) {
        console.error('[start-dispatch] failed to reset dispatch state after empty advance', {
          version: START_DISPATCH_VERSION,
          requestId,
          error: resetStateError.message,
        })
      }

      return jsonResponse(
        409,
        {
          ok: false,
          error: message,
          requestId,
          timeoutSeconds,
          candidateCount: rankedCandidates.length,
          advanceResult,
        },
        corsHeaders,
      )
    }

    console.log('[start-dispatch] attempt created', {
      version: START_DISPATCH_VERSION,
      requestId,
      createdAttemptId,
      createdAttemptStatus,
    })

    const attemptId = String(firstAdvanceRow.attempt_id)

    console.log('[start-dispatch] verifying live dispatch rows before markDispatched', {
      version: START_DISPATCH_VERSION,
      requestId,
      attemptId,
      bookingTiming: requestRow.booking_timing ?? null,
    })

    const [
      { count: candidateCountAfterAdvance, error: candidateCheckError },
      { data: attemptAfterAdvance, error: attemptCheckError },
      { count: pendingAttemptCountAfterAdvance, error: pendingAttemptCountError },
    ] = await Promise.all([
      supabase
        .from('dispatch_candidates')
        .select('id', { count: 'exact', head: true })
        .eq('request_id', requestId),
      supabase
        .from('dispatch_attempts')
        .select('id, walker_id, status, expires_at')
        .eq('id', attemptId)
        .eq('request_id', requestId)
        .eq('status', 'pending')
        .gt('expires_at', new Date().toISOString())
        .maybeSingle(),
      supabase
        .from('dispatch_attempts')
        .select('id', { count: 'exact', head: true })
        .eq('request_id', requestId)
        .eq('status', 'pending')
        .gt('expires_at', new Date().toISOString()),
    ])

    console.log('[start-dispatch] live row verification result', {
      version: START_DISPATCH_VERSION,
      requestId,
      attemptId,
      providersFoundCount: rerankedCandidates.length,
      candidatesInsertedCount: persistedCandidateCount,
      candidateCountAfterAdvance,
      candidateCheckError: candidateCheckError?.message ?? null,
      attemptAfterAdvance,
      attemptCheckError: attemptCheckError?.message ?? null,
      pendingAttemptCountAfterAdvance,
      pendingAttemptCountError: pendingAttemptCountError?.message ?? null,
    })

    const verifiedAttemptWalkerId =
      attemptAfterAdvance && typeof attemptAfterAdvance.walker_id === 'string'
        ? attemptAfterAdvance.walker_id
        : null

    if (
      candidateCheckError ||
      attemptCheckError ||
      pendingAttemptCountError ||
      !candidateCountAfterAdvance ||
      !attemptAfterAdvance
    ) {
      const message =
        candidateCheckError?.message ??
        attemptCheckError?.message ??
        pendingAttemptCountError?.message ??
        'dispatch rows missing after opening dispatch attempt'

      console.error('[start-dispatch] live row verification failed before markDispatched', {
        version: START_DISPATCH_VERSION,
        requestId,
        attemptId,
        message,
      })

      const { error: resetStateError } = await supabase
        .from('walk_requests')
        .update({
          dispatch_state: 'queued',
          smart_dispatch_state: 'idle',
          smart_dispatch_last_error: message,
          smart_dispatch_expires_at: null,
        })
        .eq('id', requestId)
        .eq('status', 'open')
        .is('walker_id', null)

      if (resetStateError) {
        console.error('[start-dispatch] failed to reset missing dispatch rows', {
          version: START_DISPATCH_VERSION,
          requestId,
          error: resetStateError.message,
        })
      }

      return jsonResponse(
        409,
        {
          ok: false,
          error: message,
          requestId,
          timeoutSeconds,
          candidateCount: rankedCandidates.length,
          advanceResult,
        },
        corsHeaders,
      )
    }

    if (verifiedAttemptWalkerId) {
      await sendDispatchOfferPush({
        requestId,
        attemptId,
        walkerId: verifiedAttemptWalkerId,
        serviceType: requestRow.service_type ?? null,
      })
    } else {
      console.warn('[start-dispatch] dispatch offer push skipped', {
        version: START_DISPATCH_VERSION,
        requestId,
        attemptId,
        reason: 'missing_attempt_walker_id',
      })
    }

    console.warn('[start-dispatch] final dispatch transition', {
      version: START_DISPATCH_VERSION,
      requestId,
      action: 'dispatch_transition',
      attemptId,
      providersFoundCount: rerankedCandidates.length,
      candidatesInsertedCount: persistedCandidateCount,
      candidateCountAfterAdvance,
      attemptsInsertedCount: pendingAttemptCountAfterAdvance,
      bookingTiming: requestRow.booking_timing ?? null,
      nextRequestState: {
        dispatch_state: 'dispatched',
        smart_dispatch_state: 'dispatching',
      },
    })

    const { error: markDispatchedError } = await supabase
      .from('walk_requests')
      .update({
        dispatch_state: 'dispatched',
        smart_dispatch_state: 'dispatching',
        smart_dispatch_last_error: null,
      })
      .eq('id', requestId)
      .eq('status', 'open')
      .is('walker_id', null)

    if (markDispatchedError) {
      console.error('[start-dispatch] failed to mark request dispatched', {
        version: START_DISPATCH_VERSION,
        requestId,
        attemptId,
        error: markDispatchedError.message,
      })
      return jsonResponse(
        500,
        {
          ok: false,
          error: 'failed to mark request dispatched',
          details: markDispatchedError.message,
        },
        corsHeaders,
      )
    }

    const { error: finalTransitionEventError } = await supabase.rpc('log_dispatch_event', {
      p_request_id: requestId,
      p_attempt_id: attemptId,
      p_event_type: 'dispatch_transitioned',
      p_payload: {
        providersFoundCount: rerankedCandidates.length,
        candidatesInsertedCount: persistedCandidateCount,
        attemptsInsertedCount: pendingAttemptCountAfterAdvance,
        dispatchState: 'dispatched',
        smartDispatchState: 'dispatching',
        version: START_DISPATCH_VERSION,
      },
    })

    if (finalTransitionEventError) {
      console.error('[start-dispatch] failed logging dispatch_transitioned', {
        version: START_DISPATCH_VERSION,
        requestId,
        attemptId,
        error: finalTransitionEventError.message,
      })
    }

    const { data: liveAttemptAfterMark, error: liveAttemptAfterMarkError } = await supabase
      .from('dispatch_attempts')
      .select('id, status, expires_at')
      .eq('id', attemptId)
      .eq('request_id', requestId)
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString())
      .maybeSingle()

    console.log('[start-dispatch] live attempt check after markDispatched', {
      version: START_DISPATCH_VERSION,
      requestId,
      attemptId,
      liveAttemptAfterMark,
      liveAttemptAfterMarkError: liveAttemptAfterMarkError?.message ?? null,
    })

    if (liveAttemptAfterMarkError || !liveAttemptAfterMark) {
      const message =
        liveAttemptAfterMarkError?.message ??
        'dispatch attempt missing after marking request dispatched'

      console.error('[start-dispatch] live attempt missing after markDispatched', {
        version: START_DISPATCH_VERSION,
        requestId,
        attemptId,
        message,
      })

      const { error: resetStateError } = await supabase
        .from('walk_requests')
        .update({
          dispatch_state: 'queued',
          smart_dispatch_state: 'idle',
          smart_dispatch_last_error: message,
          smart_dispatch_expires_at: null,
        })
        .eq('id', requestId)
        .eq('status', 'open')
        .is('walker_id', null)

      if (resetStateError) {
        console.error('[start-dispatch] failed to reset missing live dispatch attempt', {
          version: START_DISPATCH_VERSION,
          requestId,
          error: resetStateError.message,
        })
      }

      return jsonResponse(
        409,
        {
          ok: false,
          error: message,
          requestId,
          timeoutSeconds,
          candidateCount: rankedCandidates.length,
          advanceResult,
        },
        corsHeaders,
      )
    }

    console.log('[start-dispatch] success', {
      version: START_DISPATCH_VERSION,
      requestId,
      timeoutSeconds,
      candidateCount: rerankedCandidates.length,
      insertedCandidatesCount: candidateRows.length,
      createdAttemptId,
      createdAttemptStatus,
      finalRequestState: {
        dispatch_state: 'dispatched',
        smart_dispatch_state: 'dispatching',
      },
    })

    return jsonResponse(
      200,
      {
        ok: true,
        requestId,
        timeoutSeconds,
        candidateCount: rerankedCandidates.length,
        insertedCandidatesCount: candidateRows.length,
        attemptId: createdAttemptId,
        attemptStatus: createdAttemptStatus,
        advanceResult,
        version: START_DISPATCH_VERSION,
      },
      corsHeaders,
    )
  } catch (error) {
    console.error('[start-dispatch] unexpected error', {
      version: START_DISPATCH_VERSION,
      error: error instanceof Error ? error.message : String(error),
    })

    return jsonResponse(
      500,
      {
        ok: false,
        error: 'Unexpected start-dispatch error',
        details: error instanceof Error ? error.message : String(error),
        version: START_DISPATCH_VERSION,
      },
      corsHeaders,
    )
  }
})
