export type SearchAttemptAutoAdvanceDecisionReason =
  | 'missing_context'
  | 'invalid_expiry'
  | 'before_buffer'
  | 'already_in_flight'
  | 'recently_triggered'
  | 'ready'

export type SearchAttemptAutoAdvanceDecision = {
  shouldAdvance: boolean
  key: string | null
  advanceAtMs: number | null
  reason: SearchAttemptAutoAdvanceDecisionReason
}

export function getSearchAttemptAutoAdvanceDecision(params: {
  requestId: string | null
  attemptId: string | null
  expiresAt: string | null
  nowMs: number
  bufferMs: number
  dedupeMs: number
  currentInFlightKey?: string | null
  lastTriggeredAtMs?: number | null
}): SearchAttemptAutoAdvanceDecision {
  const requestId = params.requestId?.trim() ?? ''
  const attemptId = params.attemptId?.trim() ?? ''
  const expiresAt = params.expiresAt?.trim() ?? ''

  if (!requestId || !attemptId || !expiresAt) {
    return {
      shouldAdvance: false,
      key: null,
      advanceAtMs: null,
      reason: 'missing_context',
    }
  }

  const expiresAtMs = new Date(expiresAt).getTime()
  if (!Number.isFinite(expiresAtMs)) {
    return {
      shouldAdvance: false,
      key: null,
      advanceAtMs: null,
      reason: 'invalid_expiry',
    }
  }

  const key = `${requestId}:${attemptId}:${expiresAt}`
  const advanceAtMs = expiresAtMs + Math.max(0, params.bufferMs)

  if (params.currentInFlightKey === key) {
    return {
      shouldAdvance: false,
      key,
      advanceAtMs,
      reason: 'already_in_flight',
    }
  }

  if (params.nowMs < advanceAtMs) {
    return {
      shouldAdvance: false,
      key,
      advanceAtMs,
      reason: 'before_buffer',
    }
  }

  const lastTriggeredAtMs = params.lastTriggeredAtMs ?? 0
  if (lastTriggeredAtMs > 0 && params.nowMs - lastTriggeredAtMs < Math.max(0, params.dedupeMs)) {
    return {
      shouldAdvance: false,
      key,
      advanceAtMs,
      reason: 'recently_triggered',
    }
  }

  return {
    shouldAdvance: true,
    key,
    advanceAtMs,
    reason: 'ready',
  }
}
