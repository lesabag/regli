export type DispatchTimeoutAttemptStatus =
  | 'pending'
  | 'accepted'
  | 'expired'
  | 'cancelled'
  | 'rejected'

export type DispatchTimeoutAttempt = {
  id: string
  requestId: string
  walkerId: string
  attemptNo: number
  status: DispatchTimeoutAttemptStatus
  expiresAtMs: number
}

export type DispatchTimeoutCandidate = {
  requestId: string
  walkerId: string
  rank: number
}

export type DispatchTimeoutAdvanceResult = {
  attempts: DispatchTimeoutAttempt[]
  expiredAttemptIds: string[]
  activeAttempt: DispatchTimeoutAttempt | null
  createdAttempt: DispatchTimeoutAttempt | null
  exhausted: boolean
}

export function advanceExpiredDispatchAttempts(params: {
  requestId: string
  attempts: DispatchTimeoutAttempt[]
  candidates: DispatchTimeoutCandidate[]
  nowMs: number
  timeoutSeconds: number
}): DispatchTimeoutAdvanceResult {
  const timeoutSeconds = Math.max(3, Math.min(60, Math.floor(params.timeoutSeconds)))
  const nextAttempts = params.attempts.map((attempt) => ({ ...attempt }))
  const expiredAttemptIds: string[] = []

  for (const attempt of nextAttempts) {
    if (
      attempt.requestId === params.requestId &&
      attempt.status === 'pending' &&
      attempt.expiresAtMs <= params.nowMs
    ) {
      attempt.status = 'expired'
      expiredAttemptIds.push(attempt.id)
    }
  }

  const activeAttempt =
    nextAttempts
      .filter(
        (attempt) =>
          attempt.requestId === params.requestId &&
          attempt.status === 'pending' &&
          attempt.expiresAtMs > params.nowMs,
      )
      .sort((left, right) => right.attemptNo - left.attemptNo)[0] ?? null

  if (activeAttempt) {
    return {
      attempts: nextAttempts,
      expiredAttemptIds,
      activeAttempt,
      createdAttempt: null,
      exhausted: false,
    }
  }

  const attemptedRanks = new Set(
    nextAttempts
      .filter((attempt) => attempt.requestId === params.requestId)
      .map((attempt) => attempt.attemptNo),
  )

  const nextCandidate =
    [...params.candidates]
      .filter((candidate) => candidate.requestId === params.requestId && !attemptedRanks.has(candidate.rank))
      .sort((left, right) => left.rank - right.rank)[0] ?? null

  if (!nextCandidate) {
    return {
      attempts: nextAttempts,
      expiredAttemptIds,
      activeAttempt: null,
      createdAttempt: null,
      exhausted: true,
    }
  }

  const createdAttempt: DispatchTimeoutAttempt = {
    id: `generated-${params.requestId}-${nextCandidate.rank}`,
    requestId: params.requestId,
    walkerId: nextCandidate.walkerId,
    attemptNo: nextCandidate.rank,
    status: 'pending',
    expiresAtMs: params.nowMs + timeoutSeconds * 1000,
  }

  nextAttempts.push(createdAttempt)

  return {
    attempts: nextAttempts,
    expiredAttemptIds,
    activeAttempt: null,
    createdAttempt,
    exhausted: false,
  }
}
