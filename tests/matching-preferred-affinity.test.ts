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
  // Fairness, cooldowns, or randomized top-pool selection are not implemented today.
  // This test intentionally locks down current ranking-only affinity behavior for a future phase.
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
