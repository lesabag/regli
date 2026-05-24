import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluatePricingEligibility, getDogPricingMultiplier, type ProviderPricingPreferenceRow } from '../supabase/functions/_shared/pricingEligibility.ts'
import { getBudgetGuidanceFromProviderPreferences } from '../src/lib/pricing.ts'

function pref(params: {
  providerId: string
  bookingType: 'asap' | 'scheduled'
  minimum?: number | null
  preferred?: number | null
  acceptsMultiItem?: boolean
  maxItemCount?: number | null
  serviceType?: string
}): ProviderPricingPreferenceRow {
  return {
    provider_id: params.providerId,
    service_type: params.serviceType ?? 'dog_walker',
    pricing_model: 'time_based',
    booking_type: params.bookingType,
    is_enabled: true,
    hourly_rate_min: params.minimum ?? null,
    hourly_rate_preferred: params.preferred ?? null,
    accepts_multi_item: params.acceptsMultiItem ?? true,
    max_item_count: params.maxItemCount ?? 3,
  }
}

test('dog pricing multiplier grows by 50 percent per extra dog for dog walker only', () => {
  assert.equal(getDogPricingMultiplier('dog_walker', 1), 1)
  assert.equal(getDogPricingMultiplier('dog_walker', 2), 1.5)
  assert.equal(getDogPricingMultiplier('dog_walker', 3), 2)
  assert.equal(getDogPricingMultiplier('baby_sitter', 3), 1)
})

test('pricing-aware dispatch excludes providers below their minimum hourly rate', () => {
  const result = evaluatePricingEligibility({
    candidateWalkerIds: ['walker-a', 'walker-b'],
    preferences: [
      pref({ providerId: 'walker-a', bookingType: 'asap', minimum: 50, preferred: 60 }),
      pref({ providerId: 'walker-b', bookingType: 'asap', minimum: 20, preferred: 30 }),
    ],
    serviceType: 'dog_walker',
    bookingType: 'asap',
    budgetILS: 10,
    durationMinutes: 60,
    dogCount: 1,
  })

  assert.equal(result.effectiveHourlyRate, 10)
  assert.deepEqual(result.eligibleWalkerIds, [])
  assert.deepEqual(result.filteredByPriceWalkerIds, ['walker-a', 'walker-b'])
  assert.deepEqual(result.filteredByMultiItemWalkerIds, [])
})

test('pricing-aware dispatch applies dog multiplier before minimum threshold checks', () => {
  const result = evaluatePricingEligibility({
    candidateWalkerIds: ['walker-a'],
    preferences: [pref({ providerId: 'walker-a', bookingType: 'asap', minimum: 50, preferred: 60 })],
    serviceType: 'dog_walker',
    bookingType: 'asap',
    budgetILS: 50,
    durationMinutes: 60,
    dogCount: 2,
  })

  assert.equal(result.aggregatedMinHourly, 75)
  assert.equal(result.aggregatedPreferredHourly, 90)
  assert.deepEqual(result.eligibleWalkerIds, [])
  assert.deepEqual(result.filteredByPriceWalkerIds, ['walker-a'])
})

test('pricing-aware dispatch leaves providers eligible when no preference row exists', () => {
  const result = evaluatePricingEligibility({
    candidateWalkerIds: ['walker-a', 'walker-b'],
    preferences: [pref({ providerId: 'walker-a', bookingType: 'asap', minimum: 50, preferred: 60 })],
    serviceType: 'dog_walker',
    bookingType: 'asap',
    budgetILS: 10,
    durationMinutes: 60,
    dogCount: 1,
  })

  assert.deepEqual(result.eligibleWalkerIds, ['walker-b'])
  assert.deepEqual(result.filteredByPriceWalkerIds, ['walker-a'])
})

test('pricing-aware dispatch uses scheduled preferences when booking type is scheduled', () => {
  const result = evaluatePricingEligibility({
    candidateWalkerIds: ['walker-a'],
    preferences: [
      pref({ providerId: 'walker-a', bookingType: 'asap', minimum: 50, preferred: 60 }),
      pref({ providerId: 'walker-a', bookingType: 'scheduled', minimum: 40, preferred: 50 }),
    ],
    serviceType: 'dog_walker',
    bookingType: 'scheduled',
    budgetILS: 45,
    durationMinutes: 60,
    dogCount: 1,
  })

  assert.deepEqual(result.eligibleWalkerIds, ['walker-a'])
  assert.equal(result.aggregatedMinHourly, 40)
  assert.equal(result.aggregatedPreferredHourly, 50)
})

test('pricing-aware dispatch excludes multi-item requests when provider does not support them', () => {
  const result = evaluatePricingEligibility({
    candidateWalkerIds: ['walker-a', 'walker-b'],
    preferences: [
      pref({ providerId: 'walker-a', bookingType: 'asap', minimum: 50, preferred: 60, acceptsMultiItem: false, maxItemCount: 1 }),
      pref({ providerId: 'walker-b', bookingType: 'asap', minimum: 50, preferred: 60, acceptsMultiItem: true, maxItemCount: 3 }),
    ],
    serviceType: 'dog_walker',
    bookingType: 'asap',
    budgetILS: 90,
    durationMinutes: 60,
    dogCount: 2,
  })

  assert.deepEqual(result.eligibleWalkerIds, ['walker-b'])
  assert.deepEqual(result.filteredByMultiItemWalkerIds, ['walker-a'])
  assert.deepEqual(result.filteredByPriceWalkerIds, [])
})

test('pricing-aware dispatch recommends aggregated budgets from provider preferences', () => {
  const result = evaluatePricingEligibility({
    candidateWalkerIds: ['walker-a', 'walker-b'],
    preferences: [
      pref({ providerId: 'walker-a', bookingType: 'asap', minimum: 50, preferred: 60 }),
      pref({ providerId: 'walker-b', bookingType: 'asap', minimum: 70, preferred: 90 }),
    ],
    serviceType: 'dog_walker',
    bookingType: 'asap',
    budgetILS: 20,
    durationMinutes: 30,
    dogCount: 1,
  })

  assert.equal(result.aggregatedMinHourly, 60)
  assert.equal(result.aggregatedPreferredHourly, 75)
  assert.equal(result.recommendedMinBudget, 30)
  assert.equal(result.recommendedPreferredBudget, 38)
})

test('budget guidance uses provider coverage instead of flattening the full market range', () => {
  const preferences = [
    pref({ providerId: 'walker-a', bookingType: 'asap', minimum: 40, preferred: 50 }),
    pref({ providerId: 'walker-b', bookingType: 'asap', minimum: 30, preferred: 40 }),
  ]

  const low = getBudgetGuidanceFromProviderPreferences({
    serviceType: 'dog_walker',
    bookingType: 'asap',
    durationMinutes: 60,
    selectedPriceILS: 25,
    dogCount: 1,
    preferences,
  })
  const some = getBudgetGuidanceFromProviderPreferences({
    serviceType: 'dog_walker',
    bookingType: 'asap',
    durationMinutes: 60,
    selectedPriceILS: 35,
    dogCount: 1,
    preferences,
  })
  const most = getBudgetGuidanceFromProviderPreferences({
    serviceType: 'dog_walker',
    bookingType: 'asap',
    durationMinutes: 60,
    selectedPriceILS: 45,
    dogCount: 1,
    preferences,
  })

  assert.ok(low)
  assert.ok(some)
  assert.ok(most)
  assert.equal(low.likelihood, 'low')
  assert.equal(some.likelihood, 'medium')
  assert.equal(most.likelihood, 'high')
  assert.equal(some.coveredProviderCount, 1)
  assert.equal(some.eligibleProviderCount, 2)
  assert.equal(some.recommendedMin, 30)
  assert.equal(some.recommendedGood, 40)
})

test('budget guidance excludes providers that cannot support requested multi-item dog walks', () => {
  const guidance = getBudgetGuidanceFromProviderPreferences({
    serviceType: 'dog_walker',
    bookingType: 'asap',
    durationMinutes: 60,
    selectedPriceILS: 80,
    dogCount: 2,
    preferences: [
      pref({ providerId: 'walker-a', bookingType: 'asap', minimum: 40, preferred: 50, acceptsMultiItem: false, maxItemCount: 1 }),
      pref({ providerId: 'walker-b', bookingType: 'asap', minimum: 40, preferred: 50, acceptsMultiItem: true, maxItemCount: 3 }),
    ],
  })

  assert.ok(guidance)
  assert.equal(guidance.eligibleProviderCount, 1)
  assert.equal(guidance.coveredProviderCount, 1)
  assert.equal(guidance.likelihood, 'high')
})
