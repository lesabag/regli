import { invokeEdgeFunction } from '../services/supabaseClient'

export type RankedDispatchCandidate = {
  walkerId: string
  score: number
  meta?: Record<string, unknown>
}

type StartDispatchInput = {
  requestId: string
  rankedCandidates: RankedDispatchCandidate[]
  timeoutSeconds?: number
  resetExisting?: boolean
}

export type StartDispatchResponse = {
  ok?: boolean
  error?: string
  details?: string
  requestId?: string
  candidateCount?: number
  advanceResult?: unknown
}

function normalizeCandidates(rankedCandidates: RankedDispatchCandidate[]) {
  return rankedCandidates
    .filter((candidate) => typeof candidate.walkerId === 'string' && candidate.walkerId.trim().length > 0)
    .map((candidate) => ({
      walkerId: candidate.walkerId.trim(),
      score: typeof candidate.score === 'number' && Number.isFinite(candidate.score) ? candidate.score : 0,
      meta: candidate.meta ?? {},
    }))
}

export async function startDispatch({
  requestId,
  rankedCandidates,
  timeoutSeconds = 12,
  resetExisting = false,
}: StartDispatchInput): Promise<StartDispatchResponse> {
  const normalizedRequestId = requestId.trim()
  const normalizedCandidates = normalizeCandidates(rankedCandidates)

  if (!normalizedRequestId) {
    throw new Error('requestId is required')
  }

  if (normalizedCandidates.length === 0) {
    throw new Error('No ranked candidates provided')
  }

  console.log('[startDispatch] request:', {
    requestId: normalizedRequestId,
    timeoutSeconds,
    resetExisting,
    rankedCandidates: normalizedCandidates,
  })

  const response = await invokeEdgeFunction<StartDispatchResponse>('start-dispatch', {
    body: {
      requestId: normalizedRequestId,
      rankedCandidates: normalizedCandidates,
      timeoutSeconds,
      resetExisting,
    },
  })

  console.log('[startDispatch] response:', response)

  if (response.error) {
    throw new Error(response.error)
  }

  if (!response.data?.ok) {
    throw new Error(
      response.data?.error ||
        response.data?.details ||
        'start-dispatch returned unknown error',
    )
  }

  return response.data
}
