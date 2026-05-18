import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getBudgetGuidance,
  getBudgetGuidanceFromProviderPreferences,
  type ProviderPricingPreferenceInput,
} from '../src/lib/pricing.ts'

function resolveGuidance(params: {
  serviceType: string
  bookingType: 'asap' | 'scheduled'
  durationMinutes: number
  selectedPriceILS: number
  dogCount?: number
  preferences: ProviderPricingPreferenceInput[]
}) {
  return (
    getBudgetGuidanceFromProviderPreferences(params) ??
    getBudgetGuidance({
      serviceType: params.serviceType,
      durationMinutes: params.durationMinutes,
      selectedPriceILS: params.selectedPriceILS,
      dogCount: params.dogCount,
    })
  )
}

function buildPreferenceRow(params: {
  bookingType: 'asap' | 'scheduled'
  minimum: number
  preferred: number
  serviceType?: string
  acceptsMultiItem?: boolean
  maxItemCount?: number | null
}): ProviderPricingPreferenceInput {
  return {
    service_type: params.serviceType ?? 'dog_walker',
    pricing_model: 'time_based',
    booking_type: params.bookingType,
    is_enabled: true,
    hourly_rate_min: params.minimum,
    hourly_rate_preferred: params.preferred,
    accepts_multi_item: params.acceptsMultiItem ?? true,
    max_item_count: params.maxItemCount ?? 3,
  }
}

test('provider-driven guidance uses ASAP preferences independently from scheduled preferences', () => {
  const preferences: ProviderPricingPreferenceInput[] = [
    buildPreferenceRow({ bookingType: 'asap', minimum: 50, preferred: 60 }),
    buildPreferenceRow({ bookingType: 'scheduled', minimum: 40, preferred: 50 }),
  ]

  const asap = getBudgetGuidanceFromProviderPreferences({
    serviceType: 'dog_walker',
    bookingType: 'asap',
    durationMinutes: 60,
    selectedPriceILS: 55,
    dogCount: 1,
    preferences,
  })

  const scheduled = getBudgetGuidanceFromProviderPreferences({
    serviceType: 'dog_walker',
    bookingType: 'scheduled',
    durationMinutes: 60,
    selectedPriceILS: 55,
    dogCount: 1,
    preferences,
  })

  assert.ok(asap)
  assert.ok(scheduled)
  assert.equal(asap.recommendedMin, 50)
  assert.equal(asap.recommendedGood, 60)
  assert.equal(asap.likelihood, 'medium')
  assert.equal(scheduled.recommendedMin, 40)
  assert.equal(scheduled.recommendedGood, 50)
  assert.equal(scheduled.likelihood, 'high')
})

test('provider-driven guidance applies dog multipliers before recommendation aggregation', () => {
  const preferences: ProviderPricingPreferenceInput[] = [
    buildPreferenceRow({ bookingType: 'asap', minimum: 50, preferred: 60 }),
  ]

  const oneDog = getBudgetGuidanceFromProviderPreferences({
    serviceType: 'dog_walker',
    bookingType: 'asap',
    durationMinutes: 60,
    selectedPriceILS: 50,
    dogCount: 1,
    preferences,
  })

  const twoDogs = getBudgetGuidanceFromProviderPreferences({
    serviceType: 'dog_walker',
    bookingType: 'asap',
    durationMinutes: 60,
    selectedPriceILS: 75,
    dogCount: 2,
    preferences,
  })

  const threeDogs = getBudgetGuidanceFromProviderPreferences({
    serviceType: 'dog_walker',
    bookingType: 'asap',
    durationMinutes: 60,
    selectedPriceILS: 100,
    dogCount: 3,
    preferences,
  })

  assert.ok(oneDog)
  assert.ok(twoDogs)
  assert.ok(threeDogs)
  assert.equal(oneDog.recommendedMin, 50)
  assert.equal(oneDog.recommendedGood, 60)
  assert.equal(twoDogs.recommendedMin, 75)
  assert.equal(twoDogs.recommendedGood, 90)
  assert.equal(threeDogs.recommendedMin, 100)
  assert.equal(threeDogs.recommendedGood, 120)
})

test('provider-driven guidance normalizes hourly economics into 30-minute budgets', () => {
  const preferences: ProviderPricingPreferenceInput[] = [
    buildPreferenceRow({ bookingType: 'asap', minimum: 50, preferred: 60 }),
  ]

  const oneDog = getBudgetGuidanceFromProviderPreferences({
    serviceType: 'dog_walker',
    bookingType: 'asap',
    durationMinutes: 30,
    selectedPriceILS: 25,
    dogCount: 1,
    preferences,
  })

  const twoDogs = getBudgetGuidanceFromProviderPreferences({
    serviceType: 'dog_walker',
    bookingType: 'asap',
    durationMinutes: 30,
    selectedPriceILS: 38,
    dogCount: 2,
    preferences,
  })

  const threeDogs = getBudgetGuidanceFromProviderPreferences({
    serviceType: 'dog_walker',
    bookingType: 'asap',
    durationMinutes: 30,
    selectedPriceILS: 50,
    dogCount: 3,
    preferences,
  })

  assert.ok(oneDog)
  assert.ok(twoDogs)
  assert.ok(threeDogs)
  assert.equal(oneDog.recommendedMin, 25)
  assert.equal(oneDog.recommendedGood, 30)
  assert.equal(twoDogs.recommendedMin, 38)
  assert.equal(twoDogs.recommendedGood, 45)
  assert.equal(threeDogs.recommendedMin, 50)
  assert.equal(threeDogs.recommendedGood, 60)
})

test('likelihood thresholds use dog-adjusted provider hourly rates', () => {
  const preferences: ProviderPricingPreferenceInput[] = [
    buildPreferenceRow({ bookingType: 'asap', minimum: 50, preferred: 60 }),
  ]

  const oneDogLow = getBudgetGuidanceFromProviderPreferences({
    serviceType: 'dog_walker',
    bookingType: 'asap',
    durationMinutes: 60,
    selectedPriceILS: 40,
    dogCount: 1,
    preferences,
  })
  const oneDogMedium = getBudgetGuidanceFromProviderPreferences({
    serviceType: 'dog_walker',
    bookingType: 'asap',
    durationMinutes: 60,
    selectedPriceILS: 50,
    dogCount: 1,
    preferences,
  })
  const oneDogHigh = getBudgetGuidanceFromProviderPreferences({
    serviceType: 'dog_walker',
    bookingType: 'asap',
    durationMinutes: 60,
    selectedPriceILS: 60,
    dogCount: 1,
    preferences,
  })

  const twoDogsLow = getBudgetGuidanceFromProviderPreferences({
    serviceType: 'dog_walker',
    bookingType: 'asap',
    durationMinutes: 60,
    selectedPriceILS: 50,
    dogCount: 2,
    preferences,
  })
  const twoDogsMedium = getBudgetGuidanceFromProviderPreferences({
    serviceType: 'dog_walker',
    bookingType: 'asap',
    durationMinutes: 60,
    selectedPriceILS: 75,
    dogCount: 2,
    preferences,
  })
  const twoDogsHigh = getBudgetGuidanceFromProviderPreferences({
    serviceType: 'dog_walker',
    bookingType: 'asap',
    durationMinutes: 60,
    selectedPriceILS: 90,
    dogCount: 2,
    preferences,
  })

  assert.ok(oneDogLow && oneDogMedium && oneDogHigh && twoDogsLow && twoDogsMedium && twoDogsHigh)
  assert.equal(oneDogLow.likelihood, 'low')
  assert.equal(oneDogMedium.likelihood, 'medium')
  assert.equal(oneDogHigh.likelihood, 'high')
  assert.equal(twoDogsLow.likelihood, 'low')
  assert.equal(twoDogsMedium.likelihood, 'medium')
  assert.equal(twoDogsHigh.likelihood, 'high')
})

test('provider-driven guidance ignores ASAP rows when scheduled guidance is requested', () => {
  const preferences: ProviderPricingPreferenceInput[] = [
    buildPreferenceRow({ bookingType: 'asap', minimum: 50, preferred: 60 }),
    buildPreferenceRow({ bookingType: 'scheduled', minimum: 40, preferred: 50 }),
  ]

  const guidance = getBudgetGuidanceFromProviderPreferences({
    serviceType: 'dog_walker',
    bookingType: 'scheduled',
    durationMinutes: 30,
    selectedPriceILS: 25,
    dogCount: 1,
    preferences,
  })

  assert.ok(guidance)
  assert.equal(guidance.recommendedMin, 20)
  assert.equal(guidance.recommendedGood, 25)
  assert.equal(guidance.likelihood, 'high')
  assert.equal(guidance.providerRowsCount, 1)
})

test('guidance falls back safely to legacy pricing when provider preferences are unavailable', () => {
  const guidance = resolveGuidance({
    serviceType: 'dog_walker',
    bookingType: 'asap',
    durationMinutes: 30,
    selectedPriceILS: 35,
    dogCount: 1,
    preferences: [],
  })

  assert.equal(guidance.fallback, false)
  assert.equal(guidance.providerRowsCount, 0)
  assert.equal(guidance.recommendedMin, 30)
  assert.equal(guidance.recommendedGood, 40)
  assert.equal(guidance.likelihood, 'medium')
})

test('fallback returns medium without crashing when service guidance is truly missing', () => {
  const guidance = resolveGuidance({
    serviceType: 'unknown_service',
    bookingType: 'asap',
    durationMinutes: 45,
    selectedPriceILS: 0,
    dogCount: 1,
    preferences: [],
  })

  assert.equal(guidance.fallback, true)
  assert.equal(guidance.recommendedMin, 50)
  assert.equal(guidance.recommendedGood, 50)
  assert.equal(guidance.likelihood, 'medium')
})
