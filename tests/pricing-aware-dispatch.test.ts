import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluatePricingEligibility, getDogPricingMultiplier, type ProviderPricingPreferenceRow } from '../supabase/functions/_shared/pricingEligibility.ts'
import { providerSupportsRequestedService } from '../supabase/functions/_shared/providerServiceTypes.ts'
import { providerSupportsRequestedService as clientProviderSupportsRequestedService } from '../src/lib/providerServiceTypes.ts'
import { getBudgetGuidanceFromProviderPreferences } from '../src/lib/pricing.ts'
import { getBookingPricingModelForService, isFixedVisitBookingService } from '../src/lib/serviceTypes.ts'

function pref(params: {
  providerId: string
  bookingType: 'asap' | 'scheduled'
  pricingModel?: 'time_based' | 'fixed_visit'
  minimum?: number | null
  preferred?: number | null
  visitFeeMin?: number | null
  visitFeePreferred?: number | null
  acceptsMultiItem?: boolean
  maxItemCount?: number | null
  serviceType?: string
}): ProviderPricingPreferenceRow {
  return {
    provider_id: params.providerId,
    service_type: params.serviceType ?? 'dog_walker',
    pricing_model: params.pricingModel ?? 'time_based',
    booking_type: params.bookingType,
    is_enabled: true,
    hourly_rate_min: params.minimum ?? null,
    hourly_rate_preferred: params.preferred ?? null,
    visit_fee_min: params.visitFeeMin ?? null,
    visit_fee_preferred: params.visitFeePreferred ?? null,
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

test('fixed visit booking services resolve to fixed visit pricing mode', () => {
  assert.equal(getBookingPricingModelForService('electrician'), 'fixed_visit')
  assert.equal(getBookingPricingModelForService('plumber'), 'fixed_visit')
  assert.equal(isFixedVisitBookingService('technician'), true)
  assert.equal(getBookingPricingModelForService('dog_walking'), 'time_based')
})

test('fixed visit requests only match providers supporting the exact fixed visit service', () => {
  assert.equal(
    providerSupportsRequestedService(
      { service_type: 'dog_walker', service_types: ['dog_walker'] },
      'technician',
    ),
    false,
  )
  assert.equal(
    providerSupportsRequestedService(
      { service_type: 'baby_sitter', service_types: ['baby_sitter'] },
      'technician',
    ),
    false,
  )
  assert.equal(
    providerSupportsRequestedService(
      { service_type: 'technician', service_types: ['technician'] },
      'technician',
    ),
    true,
  )
  assert.equal(
    providerSupportsRequestedService(
      { service_type: 'electrician', service_types: ['electrician'] },
      'technician',
    ),
    false,
  )
})

test('time-based service matching remains unchanged for dog walker and babysitter', () => {
  assert.equal(
    providerSupportsRequestedService(
      { service_type: 'dog_walker', service_types: ['dog_walker'] },
      'dog_walker',
    ),
    true,
  )
  assert.equal(
    providerSupportsRequestedService(
      { service_type: 'baby_sitter', service_types: ['baby_sitter'] },
      'baby_sitter',
    ),
    true,
  )
  assert.equal(
    providerSupportsRequestedService(
      { service_type: 'baby_sitter', service_types: ['baby_sitter'] },
      'dog_walker',
    ),
    false,
  )
})

test('client-side provider filtering uses exact fixed visit service types', () => {
  assert.equal(
    clientProviderSupportsRequestedService(
      { service_type: 'dog_walker', service_types: ['dog_walker'] },
      'technician',
    ),
    false,
  )
  assert.equal(
    clientProviderSupportsRequestedService(
      { service_type: 'baby_sitter', service_types: ['baby_sitter'] },
      'technician',
    ),
    false,
  )
  assert.equal(
    clientProviderSupportsRequestedService(
      { service_type: 'technician', service_types: ['technician'] },
      'technician',
    ),
    true,
  )
  assert.equal(
    clientProviderSupportsRequestedService(
      { service_type: null, service_types: null },
      'technician',
    ),
    false,
  )
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

test('fixed visit guidance uses visit fee fields without duration math', () => {
  const guidance = getBudgetGuidanceFromProviderPreferences({
    serviceType: 'electrician',
    bookingType: 'asap',
    durationMinutes: null,
    selectedPriceILS: 180,
    preferences: [
      pref({ providerId: 'pro-a', bookingType: 'asap', pricingModel: 'fixed_visit', visitFeeMin: 150, visitFeePreferred: 220, serviceType: 'electrician' }),
      pref({ providerId: 'pro-b', bookingType: 'asap', pricingModel: 'fixed_visit', visitFeeMin: 250, visitFeePreferred: 320, serviceType: 'electrician' }),
    ],
  })

  assert.ok(guidance)
  assert.equal(guidance.pricingModel, 'fixed_visit')
  assert.equal(guidance.recommendedMin, 150)
  assert.equal(guidance.recommendedGood, 250)
  assert.equal(guidance.coveredProviderCount, 1)
  assert.equal(guidance.eligibleProviderCount, 2)
  assert.equal(guidance.likelihood, 'medium')
})

test('mixed pricing-model pools prefer time-based guidance when duration is provided', () => {
  const guidance = getBudgetGuidanceFromProviderPreferences({
    serviceType: 'dog_walker',
    bookingType: 'asap',
    durationMinutes: 60,
    selectedPriceILS: 50,
    dogCount: 1,
    preferences: [
      pref({ providerId: 'walker-a', bookingType: 'asap', pricingModel: 'time_based', minimum: 45, preferred: 55 }),
      pref({ providerId: 'walker-b', bookingType: 'asap', pricingModel: 'fixed_visit', visitFeeMin: 150, visitFeePreferred: 200 }),
    ],
  })

  assert.ok(guidance)
  assert.equal(guidance.pricingModel, 'time_based')
  assert.equal(guidance.recommendedMin, 45)
  assert.equal(guidance.coveredProviderCount, 1)
  assert.equal(guidance.eligibleProviderCount, 1)
})
