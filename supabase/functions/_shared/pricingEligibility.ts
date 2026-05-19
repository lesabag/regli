export type ProviderPricingPreferenceRow = {
  provider_id: string | null | undefined
  service_type: string | null | undefined
  pricing_model: string | null | undefined
  booking_type: string | null | undefined
  is_enabled: boolean | null | undefined
  hourly_rate_min: number | string | null | undefined
  hourly_rate_preferred: number | string | null | undefined
  accepts_multi_item?: boolean | null | undefined
  max_item_count?: number | string | null | undefined
}

export type PricingEligibilityInput = {
  candidateWalkerIds: string[]
  preferences: ProviderPricingPreferenceRow[]
  serviceType: string | null | undefined
  bookingType: 'asap' | 'scheduled'
  budgetILS: number | null | undefined
  durationMinutes: number | null | undefined
  dogCount?: number | null | undefined
}

export type PricingEligibilityResult = {
  eligibleWalkerIds: string[]
  filteredByPriceWalkerIds: string[]
  filteredByMultiItemWalkerIds: string[]
  relevantPreferenceRowsCount: number
  effectiveHourlyRate: number | null
  aggregatedMinHourly: number | null
  aggregatedPreferredHourly: number | null
  recommendedMinBudget: number | null
  recommendedPreferredBudget: number | null
}

function normalizeServiceType(value: string | null | undefined): string | null {
  const normalized = (value ?? '').trim().toLowerCase()
  if (!normalized) return null
  if (normalized === 'dog_walking' || normalized === 'dog-walker' || normalized === 'dog_walker') return 'dog_walker'
  if (normalized === 'dog_sitter' || normalized === 'dog-sitting' || normalized === 'dog_sitting' || normalized === 'dog-sitter') return 'dog_sitter'
  if (normalized === 'babysitter' || normalized === 'baby-sitter' || normalized === 'baby_sitter') return 'baby_sitter'
  return normalized
}

function toFiniteNumber(value: number | string | null | undefined): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : NaN
  return Number.isFinite(parsed) ? parsed : null
}

function normalizeRequestedItemCount(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1
}

export function getDogPricingMultiplier(serviceType: string | null | undefined, dogCount: number | null | undefined): number {
  const normalizedServiceType = normalizeServiceType(serviceType)
  const requestedCount = normalizeRequestedItemCount(dogCount)
  if (normalizedServiceType !== 'dog_walker' || requestedCount <= 1) return 1
  return 1 + (requestedCount - 1) * 0.5
}

export function evaluatePricingEligibility(input: PricingEligibilityInput): PricingEligibilityResult {
  const normalizedServiceType = normalizeServiceType(input.serviceType)
  const durationMinutes = Number(input.durationMinutes)
  const budgetILS = Number(input.budgetILS)
  const requestedItemCount = normalizeRequestedItemCount(input.dogCount)
  const dogMultiplier = getDogPricingMultiplier(input.serviceType, input.dogCount)

  if (!normalizedServiceType || !Number.isFinite(durationMinutes) || durationMinutes <= 0) {
    return {
      eligibleWalkerIds: [...input.candidateWalkerIds],
      filteredByPriceWalkerIds: [],
      filteredByMultiItemWalkerIds: [],
      relevantPreferenceRowsCount: 0,
      effectiveHourlyRate: null,
      aggregatedMinHourly: null,
      aggregatedPreferredHourly: null,
      recommendedMinBudget: null,
      recommendedPreferredBudget: null,
    }
  }

  const hours = durationMinutes / 60
  const effectiveHourlyRate =
    Number.isFinite(budgetILS) && budgetILS > 0
      ? budgetILS / hours
      : 0

  const relevantRows = input.preferences.filter((row) => {
    if (!row?.provider_id || row.is_enabled !== true) return false
    if ((row.pricing_model ?? '').toString().toLowerCase() !== 'time_based') return false
    if ((row.booking_type ?? '').toString().toLowerCase() !== input.bookingType) return false
    return normalizeServiceType(row.service_type) === normalizedServiceType
  })

  const preferencesByProviderId = new Map<string, ProviderPricingPreferenceRow>()
  for (const row of relevantRows) {
    if (!row.provider_id) continue
    if (!preferencesByProviderId.has(row.provider_id)) {
      preferencesByProviderId.set(row.provider_id, row)
    }
  }

  const aggregatedMinRates = relevantRows
    .map((row) => {
      const baseRate = toFiniteNumber(row.hourly_rate_min)
      return baseRate != null && baseRate >= 0 ? baseRate * dogMultiplier : null
    })
    .filter((value): value is number => value != null && value >= 0)

  const aggregatedPreferredRates = relevantRows
    .map((row) => {
      const baseRate = toFiniteNumber(row.hourly_rate_preferred)
      return baseRate != null && baseRate >= 0 ? baseRate * dogMultiplier : null
    })
    .filter((value): value is number => value != null && value >= 0)

  const averageMinRate =
    aggregatedMinRates.length > 0
      ? aggregatedMinRates.reduce((sum, value) => sum + value, 0) / aggregatedMinRates.length
      : aggregatedPreferredRates.length > 0
        ? aggregatedPreferredRates.reduce((sum, value) => sum + value, 0) / aggregatedPreferredRates.length
        : null

  const averagePreferredRate =
    aggregatedPreferredRates.length > 0
      ? aggregatedPreferredRates.reduce((sum, value) => sum + value, 0) / aggregatedPreferredRates.length
      : averageMinRate

  const eligibleWalkerIds: string[] = []
  const filteredByPriceWalkerIds: string[] = []
  const filteredByMultiItemWalkerIds: string[] = []

  for (const walkerId of input.candidateWalkerIds) {
    const preference = preferencesByProviderId.get(walkerId)
    if (!preference) {
      eligibleWalkerIds.push(walkerId)
      continue
    }

    if (requestedItemCount > 1) {
      if (preference.accepts_multi_item !== true) {
        filteredByMultiItemWalkerIds.push(walkerId)
        continue
      }
      const maxItemCount = toFiniteNumber(preference.max_item_count)
      if (maxItemCount != null && maxItemCount < requestedItemCount) {
        filteredByMultiItemWalkerIds.push(walkerId)
        continue
      }
    }

    const minimumHourlyRate = toFiniteNumber(preference.hourly_rate_min)
    const adjustedMinimumHourlyRate =
      minimumHourlyRate != null && minimumHourlyRate >= 0
        ? minimumHourlyRate * dogMultiplier
        : null

    if (adjustedMinimumHourlyRate != null && effectiveHourlyRate < adjustedMinimumHourlyRate) {
      filteredByPriceWalkerIds.push(walkerId)
      continue
    }

    eligibleWalkerIds.push(walkerId)
  }

  return {
    eligibleWalkerIds,
    filteredByPriceWalkerIds,
    filteredByMultiItemWalkerIds,
    relevantPreferenceRowsCount: relevantRows.length,
    effectiveHourlyRate: Number.isFinite(effectiveHourlyRate) ? Math.round(effectiveHourlyRate * 100) / 100 : null,
    aggregatedMinHourly: averageMinRate != null ? Math.round(averageMinRate * 100) / 100 : null,
    aggregatedPreferredHourly: averagePreferredRate != null ? Math.round(averagePreferredRate * 100) / 100 : null,
    recommendedMinBudget: averageMinRate != null ? Math.max(1, Math.round(averageMinRate * hours)) : null,
    recommendedPreferredBudget: averagePreferredRate != null ? Math.max(1, Math.round(averagePreferredRate * hours)) : null,
  }
}
