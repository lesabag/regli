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
