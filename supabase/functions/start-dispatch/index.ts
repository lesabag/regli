import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { corsHeaders } from '../_shared/cors.ts'
import {
  createAdminClient,
  jsonResponse,
  normalizeTimeoutSeconds,
  sanitizeCandidates,
  type RankedCandidate,
} from '../_shared/dispatch.ts'
import { rankDispatchCandidatesByFinalScore, computeAttributeScore } from '../_shared/dispatchRanking.ts'

type StartDispatchBody = {
  requestId?: string
  timeoutSeconds?: number
  rankedCandidates?: RankedCandidate[]
  resetExisting?: boolean
}

function getScheduledDispatchLeadMinutes(): number {
  const raw = Deno.env.get('SCHEDULED_DISPATCH_LEAD_MINUTES')
  const parsed = raw ? Number(raw) : NaN
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 15
}

const SCHEDULED_DISPATCH_LEAD_MINUTES = getScheduledDispatchLeadMinutes()
const START_DISPATCH_VERSION = '2026-04-22-payment-gate-01'

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
  const finalScore = baseScore == null ? null : Number((baseScore + affinityScore + attributeScore).toFixed(6))

  persistedMeta.base_score = baseScore
  persistedMeta.affinity_score = affinityScore
  persistedMeta.affinity_provider_saved = safeMeta.affinity_provider_saved === true
  persistedMeta.affinity_client_saved = safeMeta.affinity_client_saved === true
  persistedMeta.attribute_score = attributeScore
  persistedMeta.attribute_reason = typeof safeMeta.attribute_reason === 'string' ? safeMeta.attribute_reason : 'neutral_missing_attributes'
  persistedMeta.attribute_matches = Array.isArray(safeMeta.attribute_matches) ? safeMeta.attribute_matches : []
  persistedMeta.final_score = finalScore

  return persistedMeta
}

function getPersistedCandidateScore(candidate: RankedCandidate): number {
  const meta = candidate.meta ?? {}
  const baseScore = getBaseScore(candidate)
  const affinityScore = normalizeAffinityScore(meta)
  const attributeScore = typeof meta.attribute_score === 'number' && Number.isFinite(meta.attribute_score)
    ? meta.attribute_score
    : 0
  return Number((baseScore + affinityScore + attributeScore).toFixed(6))
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

function parseServiceTypes(
  rawServiceTypes: string[] | string | null | undefined,
): string[] {
  if (Array.isArray(rawServiceTypes)) {
    return rawServiceTypes
      .map((value) => String(value ?? '').trim())
      .filter(Boolean)
  }

  if (typeof rawServiceTypes === 'string') {
    return rawServiceTypes
      .replace(/^\{|\}$/g, '')
      .split(',')
      .map((value) => value.trim().replace(/^"|"$/g, ''))
      .filter(Boolean)
  }

  return []
}

function getNormalizedServiceTypes(
  rawServiceTypes: string[] | string | null | undefined,
): Array<'dog_walker' | 'baby_sitter'> {
  return parseServiceTypes(rawServiceTypes)
    .map((value) => normalizeProviderServiceType(value))
    .filter((value): value is 'dog_walker' | 'baby_sitter' => value !== null)
}

function providerSupportsRequestedService(
  profile: {
    service_types?: string[] | string | null
    service_type?: string | null
  },
  requestServiceType: 'dog_walker' | 'baby_sitter' | null,
): boolean {
  if (!requestServiceType) return true

  const normalizedServiceTypes = getNormalizedServiceTypes(profile.service_types)
  if (normalizedServiceTypes.length > 0) {
    return normalizedServiceTypes.includes(requestServiceType)
  }

  return normalizeProviderServiceType(profile.service_type) === requestServiceType
}

function buildCandidateScoreLog(candidate: RankedCandidate, rank: number) {
  const meta = candidate.meta ?? {}
  const baseScore = getBaseScore(candidate)
  const affinityScore = normalizeAffinityScore(meta)
  const attributeScore =
    typeof meta.attribute_score === 'number' && Number.isFinite(meta.attribute_score)
      ? meta.attribute_score
      : 0
  const finalScore = Number((baseScore + affinityScore + attributeScore).toFixed(6))
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

    if (rankedCandidates.length === 0) {
      console.error('[start-dispatch] no ranked candidates', {
        version: START_DISPATCH_VERSION,
        requestId,
      })
      return jsonResponse(
        400,
        {
          ok: false,
          error: 'rankedCandidates is required and must contain at least one valid candidate',
        },
        corsHeaders,
      )
    }

    const supabase = createAdminClient()

    const { data: requestRow, error: requestError } = await supabase
      .from('walk_requests')
      .select('id, client_id, status, walker_id, booking_timing, scheduled_for, dispatch_state, smart_dispatch_state, payment_status, stripe_payment_intent_id, service_type')
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

    if (!resetExisting && requestRow.smart_dispatch_state === 'dispatching') {
      console.warn('[start-dispatch] dispatch already active', {
        version: START_DISPATCH_VERSION,
        requestId,
        smartDispatchState: requestRow.smart_dispatch_state,
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

    if (candidateWalkerIds.length > 0) {
      const [
        { data: walkerProfileRows, error: walkerProfilesError },
        { data: favoriteCustomersRows, error: favoriteCustomersError },
        { data: favoriteWalkersRows, error: favoriteWalkersError },
        { data: clientProfileRow },
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
      ])

      clientServiceAttributes = (clientProfileRow as { service_attributes?: unknown } | null)?.service_attributes as Record<string, unknown> | null ?? null

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
          const normalizedServiceTypes = getNormalizedServiceTypes(row.service_types)
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

    const affinityRankedCandidates = rankedCandidates
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
      requestServiceType: requestRow.service_type ?? null,
      normalizedProviderServiceType: requestProviderServiceType,
      candidateCountBeforeServiceTypeFilter: rankedCandidates.length,
      candidateCountAfterServiceTypeFilter: affinityRankedCandidates.length,
    })

    if (affinityRankedCandidates.length === 0) {
      const exhaustedMessage = 'No matching providers for service_type'
      console.warn('[start-dispatch] no candidates match request service type', {
        version: START_DISPATCH_VERSION,
        requestId,
        requestServiceType: requestRow.service_type,
        normalizedProviderServiceType: requestProviderServiceType,
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
          requestServiceType: requestRow.service_type,
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

    const affinityRankedCandidateOrder = rankDispatchCandidatesByFinalScore(
      affinityRankedCandidates.map((candidate) => ({
        walkerId: candidate.walkerId,
        baseScore: getBaseScore(candidate),
        affinityProviderSaved: candidate.meta?.affinity_provider_saved === true,
        affinityClientSaved: candidate.meta?.affinity_client_saved === true,
        distanceKm: toFiniteNumber(candidate.meta?.distance_km),
        avgRating: toFiniteNumber(candidate.meta?.avg_rating),
        reviewCount: toFiniteNumber(candidate.meta?.review_count),
        attributeScore: typeof candidate.meta?.attribute_score === 'number' ? candidate.meta.attribute_score : 0,
      })),
    )

    const affinityRankedCandidatesByWalkerId = new Map(
      affinityRankedCandidates.map((candidate) => [candidate.walkerId, candidate]),
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

    console.log('[start-dispatch] initializing request dispatch state', {
      version: START_DISPATCH_VERSION,
      requestId,
    })

    const { error: initRequestError } = await supabase
      .from('walk_requests')
      .update({
        smart_dispatch_state: 'dispatching',
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
        candidateCount: rankedCandidates.length,
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
    ] = await Promise.all([
      supabase
        .from('dispatch_candidates')
        .select('id', { count: 'exact', head: true })
        .eq('request_id', requestId),
      supabase
        .from('dispatch_attempts')
        .select('id, status, expires_at')
        .eq('id', attemptId)
        .eq('request_id', requestId)
        .eq('status', 'pending')
        .gt('expires_at', new Date().toISOString())
        .maybeSingle(),
    ])

    console.log('[start-dispatch] live row verification result', {
      version: START_DISPATCH_VERSION,
      requestId,
      attemptId,
      candidateCountAfterAdvance,
      candidateCheckError: candidateCheckError?.message ?? null,
      attemptAfterAdvance,
      attemptCheckError: attemptCheckError?.message ?? null,
    })

    if (candidateCheckError || attemptCheckError || !candidateCountAfterAdvance || !attemptAfterAdvance) {
      const message =
        candidateCheckError?.message ??
        attemptCheckError?.message ??
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

    console.warn('[start-dispatch] MARKING REQUEST DISPATCHED', {
      version: START_DISPATCH_VERSION,
      requestId,
      attemptId,
      candidateCountAfterAdvance,
      bookingTiming: requestRow.booking_timing ?? null,
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
