import assert from 'node:assert/strict'
import test from 'node:test'
import { getSearchAttemptAutoAdvanceDecision } from '../src/lib/dispatchAttemptAutoAdvance.ts'
import { advanceExpiredDispatchAttempts } from '../supabase/functions/_shared/dispatchTimeout.ts'

test('expired pending attempt is advanced to the next candidate', () => {
  const nowMs = Date.UTC(2026, 5, 8, 15, 0, 0)
  const result = advanceExpiredDispatchAttempts({
    requestId: 'request-1',
    nowMs,
    timeoutSeconds: 12,
    attempts: [
      {
        id: 'attempt-1',
        requestId: 'request-1',
        walkerId: 'walker-a',
        attemptNo: 1,
        status: 'pending',
        expiresAtMs: nowMs - 1_000,
      },
    ],
    candidates: [
      { requestId: 'request-1', walkerId: 'walker-a', rank: 1 },
      { requestId: 'request-1', walkerId: 'walker-b', rank: 2 },
    ],
  })

  assert.deepEqual(result.expiredAttemptIds, ['attempt-1'])
  assert.equal(result.createdAttempt?.walkerId, 'walker-b')
  assert.equal(result.createdAttempt?.attemptNo, 2)
  assert.equal(result.exhausted, false)
})

test('expired pending attempt does not leave stale pending rows behind', () => {
  const nowMs = Date.UTC(2026, 5, 8, 15, 0, 0)
  const result = advanceExpiredDispatchAttempts({
    requestId: 'request-2',
    nowMs,
    timeoutSeconds: 12,
    attempts: [
      {
        id: 'attempt-1',
        requestId: 'request-2',
        walkerId: 'walker-a',
        attemptNo: 1,
        status: 'pending',
        expiresAtMs: nowMs - 10_000,
      },
      {
        id: 'attempt-2',
        requestId: 'request-2',
        walkerId: 'walker-b',
        attemptNo: 2,
        status: 'pending',
        expiresAtMs: nowMs - 5_000,
      },
    ],
    candidates: [
      { requestId: 'request-2', walkerId: 'walker-a', rank: 1 },
      { requestId: 'request-2', walkerId: 'walker-b', rank: 2 },
      { requestId: 'request-2', walkerId: 'walker-c', rank: 3 },
    ],
  })

  const stalePending = result.attempts.filter(
    (attempt) => attempt.requestId === 'request-2' && attempt.status === 'pending' && attempt.expiresAtMs < nowMs,
  )

  assert.equal(stalePending.length, 0)
  assert.equal(result.createdAttempt?.walkerId, 'walker-c')
  assert.equal(result.createdAttempt?.attemptNo, 3)
})

test('advance marks request exhausted when no later candidate exists', () => {
  const nowMs = Date.UTC(2026, 5, 8, 15, 0, 0)
  const result = advanceExpiredDispatchAttempts({
    requestId: 'request-3',
    nowMs,
    timeoutSeconds: 12,
    attempts: [
      {
        id: 'attempt-1',
        requestId: 'request-3',
        walkerId: 'walker-a',
        attemptNo: 1,
        status: 'pending',
        expiresAtMs: nowMs - 1,
      },
    ],
    candidates: [{ requestId: 'request-3', walkerId: 'walker-a', rank: 1 }],
  })

  assert.deepEqual(result.expiredAttemptIds, ['attempt-1'])
  assert.equal(result.createdAttempt, null)
  assert.equal(result.exhausted, true)
})

test('client-side auto-advance becomes ready right after attempt timeout buffer', () => {
  const expiresAt = '2026-06-08T15:00:12.000Z'
  const decision = getSearchAttemptAutoAdvanceDecision({
    requestId: 'request-4',
    attemptId: 'attempt-4',
    expiresAt,
    nowMs: Date.parse(expiresAt) + 1_600,
    bufferMs: 1_500,
    dedupeMs: 5_000,
    currentInFlightKey: null,
    lastTriggeredAtMs: 0,
  })

  assert.equal(decision.shouldAdvance, true)
  assert.equal(decision.reason, 'ready')
})

test('client-side auto-advance does not rely on one-minute cron cadence', () => {
  const expiresAt = '2026-06-08T15:00:12.000Z'
  const beforeBuffer = getSearchAttemptAutoAdvanceDecision({
    requestId: 'request-5',
    attemptId: 'attempt-5',
    expiresAt,
    nowMs: Date.parse(expiresAt) + 500,
    bufferMs: 1_500,
    dedupeMs: 5_000,
    currentInFlightKey: null,
    lastTriggeredAtMs: 0,
  })
  const afterBuffer = getSearchAttemptAutoAdvanceDecision({
    requestId: 'request-5',
    attemptId: 'attempt-5',
    expiresAt,
    nowMs: Date.parse(expiresAt) + 1_600,
    bufferMs: 1_500,
    dedupeMs: 5_000,
    currentInFlightKey: null,
    lastTriggeredAtMs: 0,
  })

  assert.equal(beforeBuffer.shouldAdvance, false)
  assert.equal(beforeBuffer.reason, 'before_buffer')
  assert.equal(afterBuffer.shouldAdvance, true)
  assert.notEqual(afterBuffer.advanceAtMs, null)
  assert.ok((afterBuffer.advanceAtMs ?? 0) - Date.parse(expiresAt) < 60_000)
})
