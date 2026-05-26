import assert from 'node:assert/strict'
import test from 'node:test'
import { rankDispatchCandidatesByFinalScore } from '../supabase/functions/_shared/dispatchRanking.ts'

test('matching v2 selects the top final-score walker when affinity changes the winner', () => {
  const rankedCandidates = rankDispatchCandidatesByFinalScore([
    {
      walkerId: 'walker-a',
      baseScore: 0.99,
      affinityProviderSaved: false,
      affinityClientSaved: false,
    },
    {
      walkerId: 'walker-b',
      baseScore: 0.94,
      affinityProviderSaved: true,
      affinityClientSaved: false,
    },
  ])

  const expectedWalkerId = 'walker-b'
  const actualSelectedWalkerId = rankedCandidates[0]?.walkerId ?? null

  assert.equal(rankedCandidates[0]?.baseScore, 0.94)
  assert.equal(rankedCandidates[0]?.affinityScore, 0.1)
  assert.equal(rankedCandidates[0]?.finalScore, 1.04)
  assert.equal(rankedCandidates[0]?.rank, 1)
  assert.equal(expectedWalkerId, actualSelectedWalkerId)
})

test('matching v2 fallback keeps the next ranked walker ready if the top walker declines or times out', () => {
  const rankedCandidates = rankDispatchCandidatesByFinalScore([
    {
      walkerId: 'walker-a',
      baseScore: 0.99,
      affinityProviderSaved: false,
      affinityClientSaved: false,
    },
    {
      walkerId: 'walker-b',
      baseScore: 0.94,
      affinityProviderSaved: true,
      affinityClientSaved: false,
    },
    {
      walkerId: 'walker-c',
      baseScore: 0.9,
      affinityProviderSaved: false,
      affinityClientSaved: false,
    },
  ])

  const orderedWalkerIds = rankedCandidates.map((candidate) => candidate.walkerId)
  const expectedNextWalkerId = 'walker-a'
  const actualNextWalkerId = orderedWalkerIds[1] ?? null

  assert.deepEqual(orderedWalkerIds, ['walker-b', 'walker-a', 'walker-c'])
  assert.equal(expectedNextWalkerId, actualNextWalkerId)
})

test('final_score controls candidate order and ties resolve deterministically', () => {
  const rankedCandidates = rankDispatchCandidatesByFinalScore([
    {
      walkerId: 'walker-a',
      baseScore: 0.8,
      affinityProviderSaved: false,
      affinityClientSaved: false,
      distanceKm: 1.8,
      avgRating: 4.7,
      reviewCount: 10,
      attributeScore: 0,
    },
    {
      walkerId: 'walker-b',
      baseScore: 0.8,
      affinityProviderSaved: true,
      affinityClientSaved: false,
      distanceKm: 4.5,
      avgRating: 4.1,
      reviewCount: 3,
      attributeScore: 0,
    },
    {
      walkerId: 'walker-c',
      baseScore: 0.8,
      affinityProviderSaved: false,
      affinityClientSaved: false,
      distanceKm: 1.8,
      avgRating: 4.7,
      reviewCount: 10,
      attributeScore: 0,
    },
  ])

  assert.deepEqual(
    rankedCandidates.map((candidate) => candidate.walkerId),
    ['walker-b', 'walker-a', 'walker-c'],
  )
  assert.equal(rankedCandidates[0]?.finalScore, 0.9)
  assert.equal(rankedCandidates[1]?.finalScore, 0.8)
  assert.equal(rankedCandidates[2]?.finalScore, 0.8)
  assert.equal(rankedCandidates[1]?.rank, 2)
  assert.equal(rankedCandidates[2]?.rank, 3)
})

test('affinity improves ranking but does not replace upstream eligibility filters', () => {
  // Eligibility still happens upstream. Ranking boosts and fairness penalties only reorder
  // providers that already passed service, availability, pricing, and capability filters.
  const rankedCandidates = rankDispatchCandidatesByFinalScore([
    {
      walkerId: 'eligible-neutral',
      baseScore: 0.88,
      affinityProviderSaved: false,
      affinityClientSaved: false,
    },
    {
      walkerId: 'eligible-favorite',
      baseScore: 0.8,
      affinityProviderSaved: false,
      affinityClientSaved: true,
    },
  ])

  assert.deepEqual(
    rankedCandidates.map((candidate) => candidate.walkerId),
    ['eligible-favorite', 'eligible-neutral'],
  )
  assert.equal(rankedCandidates[0]?.affinityScore, 0.2)
  assert.equal(rankedCandidates[0]?.finalScore, 1)
})

test('recent dispatch attempts apply a small fairness cooldown penalty', () => {
  const rankedCandidates = rankDispatchCandidatesByFinalScore([
    {
      walkerId: 'fresh-provider',
      baseScore: 0.85,
      recentAttemptCount: 0,
    },
    {
      walkerId: 'recently-offered-provider',
      baseScore: 0.85,
      recentAttemptCount: 2,
    },
  ])

  assert.deepEqual(
    rankedCandidates.map((candidate) => candidate.walkerId),
    ['fresh-provider', 'recently-offered-provider'],
  )
  assert.equal(rankedCandidates[0]?.cooldownPenalty, 0)
  assert.equal(rankedCandidates[1]?.cooldownPenalty, 0.04)
  assert.equal(rankedCandidates[0]?.finalScore, 0.85)
  assert.equal(rankedCandidates[1]?.finalScore, 0.81)
})

test('strong providers can still win despite the fairness cooldown penalty', () => {
  const rankedCandidates = rankDispatchCandidatesByFinalScore([
    {
      walkerId: 'strong-but-recent',
      baseScore: 0.98,
      recentAttemptCount: 4,
    },
    {
      walkerId: 'fresh-but-weaker',
      baseScore: 0.88,
      recentAttemptCount: 0,
    },
  ])

  assert.equal(rankedCandidates[0]?.walkerId, 'strong-but-recent')
  assert.equal(rankedCandidates[0]?.cooldownPenalty, 0.08)
  assert.equal(rankedCandidates[0]?.finalScore, 0.9)
  assert.equal(rankedCandidates[1]?.finalScore, 0.88)
})

test('fairness cooldown is capped and no recent attempts preserve the existing order', () => {
  const withoutRecentAttempts = rankDispatchCandidatesByFinalScore([
    {
      walkerId: 'walker-a',
      baseScore: 0.82,
      distanceKm: 1.4,
      avgRating: 4.6,
      reviewCount: 12,
      recentAttemptCount: 0,
    },
    {
      walkerId: 'walker-b',
      baseScore: 0.82,
      distanceKm: 2.1,
      avgRating: 4.4,
      reviewCount: 8,
      recentAttemptCount: 0,
    },
  ])

  const cappedPenalty = rankDispatchCandidatesByFinalScore([
    {
      walkerId: 'capped-provider',
      baseScore: 0.82,
      recentAttemptCount: 7,
    },
  ])

  assert.deepEqual(
    withoutRecentAttempts.map((candidate) => candidate.walkerId),
    ['walker-a', 'walker-b'],
  )
  assert.equal(withoutRecentAttempts[0]?.cooldownPenalty, 0)
  assert.equal(withoutRecentAttempts[1]?.cooldownPenalty, 0)
  assert.equal(cappedPenalty[0]?.cooldownPenalty, 0.08)
})
