import { isDogServiceType, normalizeDogCount } from '../utils/dogCount.ts'

/**
 * Dynamic Pricing Engine V1
 *
 * Computes a surge multiplier based on real-time supply/demand signals.
 * All logic is pure — no side effects, no external calls.
 *
 * Rules (V1):
 *  - Never reduce below 1.0 (no discounts)
 *  - Never exceed MAX_MULTIPLIER
 *  - Each condition adds an independent boost
 *  - Final multiplier = clamp(sum of boosts, 1.0, MAX_MULTIPLIER)
 */

/* ── Configurable constants ────────────────────────────────────── */

/** Absolute cap on surge multiplier. */
export const MAX_MULTIPLIER = 1.5

/** Conditions and their boosts / thresholds. */
export const SURGE_CONFIG = {
  /** Provider availability: fewer online → higher surge */
  lowProviders: {
    threshold: 2,        // providers online below this
    boost: 0.15,         // per-step boost
    criticalThreshold: 0, // zero providers = max boost
    criticalBoost: 0.3,
  },
  /** No-match rate: high unmatched % → surge */
  highNoMatch: {
    threshold: 25,       // % above which surge starts
    mildBoost: 0.1,      // 25–50%
    highBoost: 0.2,      // 50%+
  },
  /** Open requests exceeding provider count */
  demandExceedsSupply: {
    ratio: 2,            // open_requests / providers_online
    boost: 0.1,
    highRatio: 4,
    highBoost: 0.2,
  },
  /** Low match rate */
  lowMatchRate: {
    threshold: 50,       // % below which surge starts
    boost: 0.1,
  },
} as const

/* ── Types ──────────────────────────────────────────────────────── */

/** Supply/demand snapshot used to compute pricing. */
export interface PricingSignals {
  providers_online: number
  open_requests: number
  /** Recent submitted requests (last 30 min) */
  submitted_recent: number
  /** Recent matched requests (last 30 min) */
  matched_recent: number
}

export type SurgeLevel = 'normal' | 'mild' | 'high'

export interface SurgeReason {
  condition: string
  detail: string
  boost: number
}

export interface PricingResult {
  multiplier: number
  level: SurgeLevel
  reasons: SurgeReason[]
  adjustedPriceILS: number
  basePriceILS: number
}

export type BudgetAcceptanceLikelihood = 'low' | 'medium' | 'high'

export interface BudgetGuidance {
  likelihood: BudgetAcceptanceLikelihood
  recommendedMin: number
  recommendedGood: number
  suggestedLow: number
  suggestedHigh: number
  fallback: boolean
  providerRowsCount: number
  aggregatedMinHourly: number | null
  aggregatedPreferredHourly: number | null
  coveredProviderCount: number
  eligibleProviderCount: number
  coverageRatio: number | null
}

export interface ProviderPricingPreferenceInput {
  provider_id?: string | null | undefined
  service_type: string | null | undefined
  pricing_model: 'time_based' | 'visit_based' | 'hybrid' | string | null | undefined
  booking_type: 'asap' | 'scheduled' | string | null | undefined
  is_enabled: boolean | null | undefined
  hourly_rate_min: number | string | null | undefined
  hourly_rate_preferred: number | string | null | undefined
  accepts_multi_item?: boolean | null | undefined
  max_item_count?: number | string | null | undefined
}

type PricingBand = {
  minutes: number
  min: number
  good: number
}

type CoverageThresholds = {
  mediumCount: number
  highCount: number
}

const SERVICE_GUIDANCE_TABLE: Record<string, PricingBand[]> = {
  dog_walker: [
    { minutes: 30, min: 30, good: 40 },
    { minutes: 60, min: 55, good: 75 },
  ],
  baby_sitter: [
    { minutes: 30, min: 40, good: 55 },
    { minutes: 60, min: 70, good: 95 },
  ],
  technician: [
    { minutes: 30, min: 80, good: 120 },
    { minutes: 60, min: 140, good: 220 },
  ],
  cleaning: [
    { minutes: 60, min: 70, good: 100 },
    { minutes: 120, min: 130, good: 180 },
  ],
  cleaner: [
    { minutes: 60, min: 70, good: 100 },
    { minutes: 120, min: 130, good: 180 },
  ],
}

function normalizeGuidanceServiceType(value: string | null | undefined): string | null {
  const normalized = (value ?? '').trim().toLowerCase()
  if (!normalized) return null
  if (normalized === 'dog_walking' || normalized === 'dog-walker' || normalized === 'dog_walker') return 'dog_walker'
  if (normalized === 'babysitter' || normalized === 'baby-sitter' || normalized === 'baby_sitter') return 'baby_sitter'
  if (normalized === 'cleaner' || normalized === 'cleaning') return 'cleaning'
  return normalized
}

export function getGuidanceServiceTypeAliases(value: string | null | undefined): string[] {
  const normalized = normalizeGuidanceServiceType(value)
  if (!normalized) return []

  if (normalized === 'dog_walker') {
    return ['dog_walker', 'dog-walker', 'dog_walking']
  }

  if (normalized === 'baby_sitter') {
    return ['baby_sitter', 'baby-sitter', 'babysitter']
  }

  if (normalized === 'cleaning') {
    return ['cleaning', 'cleaner']
  }

  return [normalized]
}

function pickClosestBand(bands: PricingBand[], durationMinutes: number): PricingBand {
  return bands.reduce((closest, band) => {
    const closestDelta = Math.abs(closest.minutes - durationMinutes)
    const nextDelta = Math.abs(band.minutes - durationMinutes)
    return nextDelta < closestDelta ? band : closest
  })
}

function getAdditionalDogGuidanceIncrement(durationMinutes: number): { min: number; good: number } {
  if (durationMinutes <= 30) return { min: 10, good: 15 }
  if (durationMinutes <= 60) return { min: 15, good: 20 }
  return { min: 20, good: 30 }
}

function normalizeRequestedItemCount(value: unknown): number {
  return Number.isInteger(value) && Number(value) >= 1 ? Number(value) : 1
}

function getDogWalkerMultiItemMultiplier(serviceType: string | null | undefined, dogCount: unknown): number {
  const normalizedServiceType = normalizeGuidanceServiceType(serviceType)
  const requestedCount = normalizeRequestedItemCount(dogCount)
  if (normalizedServiceType !== 'dog_walker' || requestedCount <= 1) return 1
  return 1 + (requestedCount - 1) * 0.5
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

function getCoverageThresholds(providerCount: number): CoverageThresholds {
  const safeCount = Math.max(1, Math.floor(providerCount))
  return {
    mediumCount: Math.max(1, Math.ceil(safeCount * 0.25)),
    highCount: Math.max(1, Math.ceil(safeCount * 0.75)),
  }
}

function getBudgetAtCoverageTarget(sortedBudgets: number[], coveredProvidersTarget: number): number {
  if (sortedBudgets.length === 0) return 1
  const normalizedIndex = Math.min(
    sortedBudgets.length - 1,
    Math.max(0, coveredProvidersTarget - 1),
  )
  return Math.max(1, Math.round(sortedBudgets[normalizedIndex] ?? sortedBudgets[0] ?? 1))
}

function getRecommendedBand(params: {
  serviceType: string | null | undefined
  durationMinutes: number | null | undefined
  dogCount?: unknown
}): {
  recommendedMin: number
  recommendedGood: number
  fallback: boolean
} {
  const durationMinutes = Number(params.durationMinutes)
  const normalizedServiceType = normalizeGuidanceServiceType(params.serviceType)
  const normalizedDogCount = normalizeDogCount(params.dogCount)

  if (!normalizedServiceType || !Number.isFinite(durationMinutes) || durationMinutes <= 0) {
    return {
      recommendedMin: 50,
      recommendedGood: 50,
      fallback: true,
    }
  }

  const bands = SERVICE_GUIDANCE_TABLE[normalizedServiceType]
  if (!bands || bands.length === 0) {
    return {
      recommendedMin: 50,
      recommendedGood: 50,
      fallback: true,
    }
  }

  const band = pickClosestBand(bands, durationMinutes)
  let recommendedMin = band.min
  let recommendedGood = band.good

  if (normalizedServiceType === 'dog_walker' && normalizedDogCount === 2) {
    const increment = getAdditionalDogGuidanceIncrement(durationMinutes)
    recommendedMin += increment.min
    recommendedGood += increment.good
  }

  return {
    recommendedMin,
    recommendedGood,
    fallback: false,
  }
}

export function getDogCountPriceAdjustmentILS(params: {
  serviceType: string | null | undefined
  basePriceILS: number
  dogCount: unknown
}): number {
  if (!isDogServiceType(params.serviceType) || normalizeDogCount(params.dogCount) !== 2) {
    return 0
  }

  if (!Number.isFinite(params.basePriceILS) || params.basePriceILS <= 0) {
    return 0
  }

  return Math.round(params.basePriceILS * 0.5)
}

export function applyDogCountPricing(basePriceILS: number, params: {
  serviceType: string | null | undefined
  dogCount: unknown
}): number {
  if (!Number.isFinite(basePriceILS) || basePriceILS <= 0) return 0
  return basePriceILS + getDogCountPriceAdjustmentILS({
    ...params,
    basePriceILS,
  })
}

export function getBudgetGuidance(params: {
  serviceType: string | null | undefined
  durationMinutes: number | null | undefined
  selectedPriceILS: number | null | undefined
  dogCount?: unknown
}): BudgetGuidance {
  const selectedPriceILS = Number(params.selectedPriceILS)
  const { recommendedMin, recommendedGood, fallback } = getRecommendedBand(params)

  const roundedSelectedPrice =
    Number.isFinite(selectedPriceILS) && selectedPriceILS > 0
      ? Math.round(selectedPriceILS)
      : 0

  const likelihood: BudgetAcceptanceLikelihood = fallback
    ? 'medium'
    : roundedSelectedPrice < recommendedMin
      ? 'low'
      : roundedSelectedPrice < recommendedGood
        ? 'medium'
        : 'high'

  return {
    likelihood,
    recommendedMin,
    recommendedGood,
    suggestedLow: recommendedMin,
    suggestedHigh: recommendedGood,
    fallback,
    providerRowsCount: 0,
    aggregatedMinHourly: null,
    aggregatedPreferredHourly: null,
    coveredProviderCount: 0,
    eligibleProviderCount: 0,
    coverageRatio: null,
  }
}

export function getBudgetGuidanceFromProviderPreferences(params: {
  serviceType: string | null | undefined
  bookingType: 'asap' | 'scheduled'
  durationMinutes: number | null | undefined
  selectedPriceILS: number | null | undefined
  dogCount?: unknown
  preferences: ProviderPricingPreferenceInput[]
}): BudgetGuidance | null {
  const durationMinutes = Number(params.durationMinutes)
  const selectedPriceILS = Number(params.selectedPriceILS)
  const normalizedServiceType = normalizeGuidanceServiceType(params.serviceType)
  const requestedItemCount = normalizeRequestedItemCount(params.dogCount)
  const multiItemMultiplier = getDogWalkerMultiItemMultiplier(params.serviceType, params.dogCount)

  if (!normalizedServiceType || !Number.isFinite(durationMinutes) || durationMinutes <= 0) {
    return null
  }

  const relevant = params.preferences.filter((row) => {
    if (!row || row.is_enabled !== true) return false
    if (normalizeGuidanceServiceType(row.service_type) !== normalizedServiceType) return false
    if ((row.booking_type ?? '').toString().toLowerCase() !== params.bookingType) return false
    if ((row.pricing_model ?? '').toString().toLowerCase() !== 'time_based') return false

    if (requestedItemCount > 1) {
      if (row.accepts_multi_item !== true) return false
      const maxItemCount = toFiniteNumber(row.max_item_count)
      if (maxItemCount != null && maxItemCount < requestedItemCount) return false
    }

    return true
  })

  if (relevant.length === 0) return null

  const hours = durationMinutes / 60
  const preferenceRows = Array.from(
    relevant.reduce((map, row) => {
      const providerId = typeof row.provider_id === 'string' && row.provider_id.length > 0
        ? row.provider_id
        : null

      if (providerId) {
        if (!map.has(providerId)) map.set(providerId, row)
        return map
      }

      map.set(`row-${map.size}`, row)
      return map
    }, new Map<string, ProviderPricingPreferenceInput>()).values(),
  )

  const budgetBands = preferenceRows
    .map((row) => {
      const minimumHourly = toFiniteNumber(row.hourly_rate_min)
      const preferredHourly = toFiniteNumber(row.hourly_rate_preferred)
      const adjustedMinimumHourly =
        minimumHourly != null && minimumHourly >= 0 ? minimumHourly * multiItemMultiplier : null
      const adjustedPreferredHourly =
        preferredHourly != null && preferredHourly >= 0 ? preferredHourly * multiItemMultiplier : null

      const minimumBudget =
        adjustedMinimumHourly != null
          ? Math.max(1, Math.round(adjustedMinimumHourly * hours))
          : adjustedPreferredHourly != null
            ? Math.max(1, Math.round(adjustedPreferredHourly * hours))
            : null
      const preferredBudget =
        adjustedPreferredHourly != null
          ? Math.max(1, Math.round(adjustedPreferredHourly * hours))
          : minimumBudget

      if (minimumBudget == null) return null

      return {
        minimumHourly: adjustedMinimumHourly,
        preferredHourly: adjustedPreferredHourly,
        minimumBudget,
        preferredBudget: preferredBudget ?? minimumBudget,
      }
    })
    .filter((value): value is NonNullable<typeof value> => value != null)

  if (budgetBands.length === 0) return null

  const minimumRates = budgetBands
    .map((band) => band.minimumHourly)
    .filter((value): value is number => value != null && value >= 0)
  const preferredRates = budgetBands
    .map((band) => band.preferredHourly)
    .filter((value): value is number => value != null && value >= 0)

  if (minimumRates.length === 0 && preferredRates.length === 0) return null

  const averageMinRate =
    minimumRates.length > 0
      ? minimumRates.reduce((sum, value) => sum + value, 0) / minimumRates.length
      : preferredRates.reduce((sum, value) => sum + value, 0) / preferredRates.length

  const averagePreferredRate =
    preferredRates.length > 0
      ? preferredRates.reduce((sum, value) => sum + value, 0) / preferredRates.length
      : averageMinRate

  const sortedMinimumBudgets = budgetBands
    .map((band) => band.minimumBudget)
    .sort((a, b) => a - b)
  const { mediumCount, highCount } = getCoverageThresholds(sortedMinimumBudgets.length)
  const recommendedMin = getBudgetAtCoverageTarget(sortedMinimumBudgets, mediumCount)
  const recommendedGood = Math.max(
    recommendedMin,
    getBudgetAtCoverageTarget(sortedMinimumBudgets, highCount),
  )
  const roundedSelectedPrice =
    Number.isFinite(selectedPriceILS) && selectedPriceILS > 0
      ? Math.round(selectedPriceILS)
      : 0
  const coveredProviderCount = budgetBands.reduce((count, band) => (
    roundedSelectedPrice >= band.minimumBudget ? count + 1 : count
  ), 0)
  const eligibleProviderCount = budgetBands.length
  const coverageRatio =
    eligibleProviderCount > 0
      ? coveredProviderCount / eligibleProviderCount
      : null

  const likelihood: BudgetAcceptanceLikelihood =
    coverageRatio == null || coverageRatio < 0.25
      ? 'low'
      : coverageRatio < 0.75
        ? 'medium'
        : 'high'

  return {
    likelihood,
    recommendedMin,
    recommendedGood,
    suggestedLow: recommendedMin,
    suggestedHigh: recommendedGood,
    fallback: false,
    providerRowsCount: budgetBands.length,
    aggregatedMinHourly: Math.round(averageMinRate * 100) / 100,
    aggregatedPreferredHourly: Math.round(averagePreferredRate * 100) / 100,
    coveredProviderCount,
    eligibleProviderCount,
    coverageRatio: coverageRatio != null ? Math.round(coverageRatio * 100) / 100 : null,
  }
}

export function getInitialSuggestedBudgetILS(params: {
  serviceType: string | null | undefined
  durationMinutes: number | null | undefined
  dogCount?: unknown
}): number {
  const { recommendedMin } = getRecommendedBand(params)
  return recommendedMin
}

/* ── Core engine ───────────────────────────────────────────────── */

export function computeSurge(signals: PricingSignals): {
  multiplier: number
  level: SurgeLevel
  reasons: SurgeReason[]
} {
  const reasons: SurgeReason[] = []
  let totalBoost = 0

  const { providers_online, open_requests, submitted_recent, matched_recent } = signals
  const cfg = SURGE_CONFIG

  // 1. Low provider availability
  if (providers_online <= cfg.lowProviders.criticalThreshold && open_requests > 0) {
    const boost = cfg.lowProviders.criticalBoost
    totalBoost += boost
    reasons.push({
      condition: 'no_providers',
      detail: `No providers online with ${open_requests} open request(s)`,
      boost,
    })
  } else if (providers_online > 0 && providers_online < cfg.lowProviders.threshold) {
    const boost = cfg.lowProviders.boost
    totalBoost += boost
    reasons.push({
      condition: 'low_providers',
      detail: `Only ${providers_online} provider(s) online`,
      boost,
    })
  }

  // 2. High no-match rate
  if (submitted_recent >= 5) {
    const unmatched = Math.max(0, submitted_recent - matched_recent)
    const noMatchRate = Math.round((unmatched / submitted_recent) * 100)
    if (noMatchRate >= cfg.highNoMatch.threshold) {
      const boost = noMatchRate >= 50 ? cfg.highNoMatch.highBoost : cfg.highNoMatch.mildBoost
      totalBoost += boost
      reasons.push({
        condition: 'high_nomatch',
        detail: `No-match rate ${noMatchRate}% (${unmatched} of ${submitted_recent})`,
        boost,
      })
    }
  }

  // 3. Demand exceeds supply
  if (providers_online > 0 && open_requests > providers_online * cfg.demandExceedsSupply.ratio) {
    const ratio = open_requests / providers_online
    const boost = ratio > cfg.demandExceedsSupply.highRatio
      ? cfg.demandExceedsSupply.highBoost
      : cfg.demandExceedsSupply.boost
    totalBoost += boost
    reasons.push({
      condition: 'demand_exceeds_supply',
      detail: `${open_requests} open requests vs ${providers_online} providers (${ratio.toFixed(1)}x)`,
      boost,
    })
  }

  // 4. Low match rate (different from no-match — looks at overall matching efficiency)
  if (submitted_recent >= 5) {
    const matchRate = Math.round((matched_recent / submitted_recent) * 100)
    if (matchRate < cfg.lowMatchRate.threshold && matchRate > 0) {
      const boost = cfg.lowMatchRate.boost
      totalBoost += boost
      reasons.push({
        condition: 'low_match_rate',
        detail: `Match rate ${matchRate}% (below ${cfg.lowMatchRate.threshold}%)`,
        boost,
      })
    }
  }

  // Clamp: never below 1.0, never above MAX_MULTIPLIER
  const multiplier = Math.min(MAX_MULTIPLIER, Math.round((1 + totalBoost) * 100) / 100)

  const level: SurgeLevel =
    multiplier >= 1.3 ? 'high' :
    multiplier >= 1.1 ? 'mild' :
    'normal'

  return { multiplier, level, reasons }
}

/** Apply multiplier to a base price, rounding to nearest ILS. */
export function applyMultiplier(basePriceILS: number, multiplier: number): number {
  const clamped = Math.min(MAX_MULTIPLIER, Math.max(1, multiplier))
  return Math.round(basePriceILS * clamped)
}

/** Compute full pricing result for a given base price. */
export function computePricing(basePriceILS: number, signals: PricingSignals): PricingResult {
  const { multiplier, level, reasons } = computeSurge(signals)
  return {
    multiplier,
    level,
    reasons,
    basePriceILS,
    adjustedPriceILS: applyMultiplier(basePriceILS, multiplier),
  }
}

/** Human-readable surge label for UI. */
export function surgeLabel(level: SurgeLevel): string {
  if (level === 'high') return 'High demand pricing'
  if (level === 'mild') return 'Busy pricing'
  return ''
}
