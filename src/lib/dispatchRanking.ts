export type ServiceAttributes = Record<string, unknown> | null | undefined

export type WalkerRankingInput = {
  walkerId: string
  distanceKm?: number | null
  avgRating?: number | null
  reviewCount?: number | null
  affinityProviderSaved?: boolean
  affinityClientSaved?: boolean
  serviceType?: string | null
  clientServiceAttributes?: ServiceAttributes
  providerServiceAttributes?: ServiceAttributes
}

export type AttributeMatchResult = {
  attributeScore: number
  attributeReason: string
  attributeMatches: string[]
}

export type DogSizeCompatibilityResult = {
  compatible: boolean
  reason:
    | 'not_dog_walker'
    | 'missing_attributes'
    | 'unknown_client_dog_sizes'
    | 'provider_accepts_all_sizes'
    | 'dog_size_match'
    | 'dog_size_mismatch'
  knownClientDogSizes: string[]
  providerAcceptedDogSizes: string[]
  missingClientDogSizes: string[]
}

export type RankedWalkerCandidate = {
  walkerId: string
  score: number
  baseScore: number
  affinityScore: number
  affinityProviderSaved: boolean
  affinityClientSaved: boolean
  distanceScore: number
  ratingScore: number
  reviewCountScore: number
  distanceKm: number | null
  avgRating: number | null
  reviewCount: number
  attributeScore: number
  attributeReason: string
  attributeMatches: string[]
}

export type BabysitterAgeRange = '0-2' | '3-5' | '6-8' | '9+'

const LEGACY_TO_NORMALIZED_AGE_RANGE: Record<string, BabysitterAgeRange> = {
  '1-2': '0-2',
  '2-4': '3-5',
  '5-7': '6-8',
  '7+': '9+',
  '0-2': '0-2',
  '3-5': '3-5',
  '6-8': '6-8',
  '9+': '9+',
  '6-10': '6-8',
  '11+': '9+',
}

const DISTANCE_WEIGHT = 0.55
const RATING_WEIGHT = 0.3
const EXPERIENCE_WEIGHT = 0.15
const DISTANCE_CAP_KM = 5
const NO_RATING_BASELINE = 0.75
const EXPERIENCE_CAP_REVIEWS = 20
const NEUTRAL_DISTANCE_SCORE = 0.5
const PROVIDER_SAVED_CUSTOMER_AFFINITY_BOOST = 10
const CUSTOMER_SAVED_PROVIDER_AFFINITY_BOOST = 20
const AFFINITY_SCORE_CAP = 30

const ATTR_DOG_SIZE_BONUS = 0.025
const ATTR_DOG_SIZE_PENALTY = -0.01
const ATTR_ENERGY_BONUS = 0.025
const ATTR_ENERGY_PENALTY = -0.01
const ATTR_SITTER_FULL_BONUS = 0.05
const ATTR_SITTER_MISMATCH_PENALTY = -0.02

const AGE_RANGE_MAP: Record<string, [number, number]> = {
  '0-2': [0, 2],
  '3-5': [3, 5],
  '6-8': [6, 8],
  '9+': [9, 120],
  '1-2': [1, 2],
  '2-4': [2, 4],
  '5-7': [5, 7],
  '7+': [7, 120],
  '6-10': [6, 10],
  '11+': [11, 120],
}

function normalizeClientDogSize(value: unknown): 'S' | 'M' | 'L' | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toUpperCase()
  if (normalized === 'S' || normalized === 'M' || normalized === 'L') return normalized
  return null
}

function normalizeProviderDogSize(value: unknown): 'S' | 'M' | 'L' | 'XL' | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toUpperCase()
  if (normalized === 'S' || normalized === 'M' || normalized === 'L' || normalized === 'XL') return normalized
  return null
}

function unique<T>(values: T[]): T[] {
  return values.filter((value, index) => values.indexOf(value) === index)
}

function getKnownClientDogSizes(clientAttrs: Record<string, unknown>): ('S' | 'M' | 'L')[] {
  const clientDog = (clientAttrs.dog_walker ?? clientAttrs) as Record<string, unknown>
  const sizesFromArray = Array.isArray(clientDog.selectedDogSizes)
    ? clientDog.selectedDogSizes
    : Array.isArray(clientDog.dogSizes)
      ? clientDog.dogSizes
      : null

  if (sizesFromArray && sizesFromArray.length > 0) {
    return unique(
      sizesFromArray
        .map((size) => normalizeClientDogSize(size))
        .filter((size): size is 'S' | 'M' | 'L' => size !== null),
    )
  }

  const singleDogSize = normalizeClientDogSize(clientDog.dogSize)
  return singleDogSize ? [singleDogSize] : []
}

function getProviderAcceptedDogSizes(providerAttrs: Record<string, unknown>): ('S' | 'M' | 'L' | 'XL')[] {
  const providerDog = (providerAttrs.dog_walker ?? providerAttrs) as Record<string, unknown>
  return Array.isArray(providerDog.supportedDogSizes)
    ? unique(
        providerDog.supportedDogSizes
          .map((size) => normalizeProviderDogSize(size))
          .filter((size): size is 'S' | 'M' | 'L' | 'XL' => size !== null),
      )
    : []
}

export function evaluateDogSizeCompatibility(
  serviceType: string | null | undefined,
  clientAttrs: ServiceAttributes,
  providerAttrs: ServiceAttributes,
): DogSizeCompatibilityResult {
  const normalizedType = serviceType?.trim().toLowerCase() ?? null
  if (normalizedType !== 'dog_walker' && normalizedType !== 'dog_walking' && normalizedType !== 'dog-walker') {
    return {
      compatible: true,
      reason: 'not_dog_walker',
      knownClientDogSizes: [],
      providerAcceptedDogSizes: [],
      missingClientDogSizes: [],
    }
  }

  if (!clientAttrs || !providerAttrs) {
    return {
      compatible: true,
      reason: 'missing_attributes',
      knownClientDogSizes: [],
      providerAcceptedDogSizes: [],
      missingClientDogSizes: [],
    }
  }

  const normalizedClientAttrs = clientAttrs as Record<string, unknown>
  const normalizedProviderAttrs = providerAttrs as Record<string, unknown>
  const knownClientDogSizes = getKnownClientDogSizes(normalizedClientAttrs)
  const providerAcceptedDogSizes = getProviderAcceptedDogSizes(normalizedProviderAttrs)

  if (knownClientDogSizes.length === 0) {
    return {
      compatible: true,
      reason: 'unknown_client_dog_sizes',
      knownClientDogSizes,
      providerAcceptedDogSizes,
      missingClientDogSizes: [],
    }
  }

  if (providerAcceptedDogSizes.length === 0) {
    return {
      compatible: true,
      reason: 'provider_accepts_all_sizes',
      knownClientDogSizes,
      providerAcceptedDogSizes,
      missingClientDogSizes: [],
    }
  }

  const missingClientDogSizes = knownClientDogSizes.filter(
    (size) => !providerAcceptedDogSizes.includes(size),
  )

  return {
    compatible: missingClientDogSizes.length === 0,
    reason: missingClientDogSizes.length === 0 ? 'dog_size_match' : 'dog_size_mismatch',
    knownClientDogSizes,
    providerAcceptedDogSizes,
    missingClientDogSizes,
  }
}

export function normalizeAgeRangeValue(value: unknown): BabysitterAgeRange | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (normalized === '0-2' || normalized === '3-5' || normalized === '6-8' || normalized === '9+') {
    return normalized
  }
  return LEGACY_TO_NORMALIZED_AGE_RANGE[normalized] ?? null
}

export function formatBabysitterAgeRangeLabel(value: unknown): string | null {
  const normalized = normalizeAgeRangeValue(value)
  if (!normalized) return null
  if (normalized === '0-2') return '0–2'
  if (normalized === '3-5') return '3–5'
  if (normalized === '6-8') return '6–8'
  return '9+'
}

function ageInRange(age: number, range: string): boolean {
  const bounds = AGE_RANGE_MAP[range]
  if (!bounds) return false
  return age >= bounds[0] && age <= bounds[1]
}

export function computeAttributeScore(
  serviceType: string | null | undefined,
  clientAttrs: ServiceAttributes,
  providerAttrs: ServiceAttributes,
): AttributeMatchResult {
  if (!serviceType || !clientAttrs || !providerAttrs) {
    return { attributeScore: 0, attributeReason: 'neutral_missing_attributes', attributeMatches: [] }
  }

  const normalizedType = serviceType.trim().toLowerCase()

  if (normalizedType === 'dog_walker' || normalizedType === 'dog_walking' || normalizedType === 'dog-walker') {
    return computeDogWalkerAttributeScore(clientAttrs, providerAttrs)
  }

  if (normalizedType === 'baby_sitter' || normalizedType === 'babysitter' || normalizedType === 'baby-sitter') {
    return computeBabySitterAttributeScore(clientAttrs, providerAttrs)
  }

  return { attributeScore: 0, attributeReason: 'neutral_missing_attributes', attributeMatches: [] }
}

function computeDogWalkerAttributeScore(
  clientAttrs: Record<string, unknown>,
  providerAttrs: Record<string, unknown>,
): AttributeMatchResult {
  const clientDog = (clientAttrs.dog_walker ?? clientAttrs) as Record<string, unknown>
  const providerDog = (providerAttrs.dog_walker ?? providerAttrs) as Record<string, unknown>

  const clientEnergy = typeof clientDog.energyLevel === 'string' ? clientDog.energyLevel : null
  const dogSizeCompatibility = evaluateDogSizeCompatibility('dog_walker', clientAttrs, providerAttrs)
  const providerSizes = Array.isArray(providerDog.supportedDogSizes) ? providerDog.supportedDogSizes as string[] : null
  const providerEnergy = Array.isArray(providerDog.supportedEnergyLevels) ? providerDog.supportedEnergyLevels as string[] : null

  let score = 0
  const matches: string[] = []
  const reasons: string[] = []

  if (dogSizeCompatibility.knownClientDogSizes.length > 0 && providerSizes && providerSizes.length > 0) {
    if (dogSizeCompatibility.compatible) {
      score += ATTR_DOG_SIZE_BONUS
      dogSizeCompatibility.knownClientDogSizes.forEach((size) => matches.push(`dogSize:${size}`))
      reasons.push('size_match')
    } else {
      score += ATTR_DOG_SIZE_PENALTY
      reasons.push('size_mismatch')
    }
  }

  if (clientEnergy && providerEnergy && providerEnergy.length > 0) {
    if (providerEnergy.includes(clientEnergy)) {
      score += ATTR_ENERGY_BONUS
      matches.push(`energy:${clientEnergy}`)
      reasons.push('energy_match')
    } else {
      score += ATTR_ENERGY_PENALTY
      reasons.push('energy_mismatch')
    }
  }

  if (reasons.length === 0) {
    return { attributeScore: 0, attributeReason: 'neutral_missing_attributes', attributeMatches: [] }
  }

  console.log('[AttributeMatching] dog_walker', { score, reasons, matches })
  const attributeReason =
    reasons.includes('size_match') && reasons.includes('energy_match')
      ? 'dog_size_and_energy_match'
      : reasons.join('_and_')
  return {
    attributeScore: Number(score.toFixed(6)),
    attributeReason,
    attributeMatches: matches,
  }
}

function computeBabySitterAttributeScore(
  clientAttrs: Record<string, unknown>,
  providerAttrs: Record<string, unknown>,
): AttributeMatchResult {
  const clientSitter = (clientAttrs.baby_sitter ?? clientAttrs) as Record<string, unknown>
  const providerSitter = (providerAttrs.baby_sitter ?? providerAttrs) as Record<string, unknown>

  const childrenAges = Array.isArray(clientSitter.childrenAges) ? clientSitter.childrenAges : null
  const providerRanges = Array.isArray(providerSitter.supportedAgeRanges)
    ? (providerSitter.supportedAgeRanges as unknown[])
        .map((range) => normalizeAgeRangeValue(range))
        .filter((range): range is BabysitterAgeRange => range !== null)
    : null

  if (!childrenAges || childrenAges.length === 0 || !providerRanges || providerRanges.length === 0) {
    return { attributeScore: 0, attributeReason: 'neutral_missing_attributes', attributeMatches: [] }
  }

  const numericAges = childrenAges
    .map((a) => typeof a === 'number' ? a : typeof a === 'string' ? parseInt(a, 10) : NaN)
    .filter((a): a is number => Number.isFinite(a))

  if (numericAges.length === 0) {
    return { attributeScore: 0, attributeReason: 'neutral_missing_attributes', attributeMatches: [] }
  }

  let fitCount = 0
  const matches: string[] = []

  for (const age of numericAges) {
    const fits = providerRanges.some((range) => ageInRange(age, range))
    if (fits) {
      fitCount++
      matches.push(`age:${age}`)
    }
  }

  const ratio = fitCount / numericAges.length

  let score: number
  let reason: string
  if (ratio === 1) {
    score = ATTR_SITTER_FULL_BONUS
    reason = 'babysitter_age_range_match'
  } else if (ratio > 0) {
    score = Number((ratio * ATTR_SITTER_FULL_BONUS).toFixed(6))
    reason = `babysitter_partial_age_range_match_${fitCount}_${numericAges.length}`
  } else {
    score = ATTR_SITTER_MISMATCH_PENALTY
    reason = 'babysitter_age_range_mismatch'
  }

  console.log('[AttributeMatching] baby_sitter', { score, reason, matches, numericAges, providerRanges })
  return {
    attributeScore: Number(score.toFixed(6)),
    attributeReason: reason,
    attributeMatches: matches,
  }
}

export function distanceKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const earthRadiusKm = 6371
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2)

  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function toFiniteNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeDistanceScore(distanceValue: number | null): number {
  if (distanceValue == null) return NEUTRAL_DISTANCE_SCORE
  const cappedDistance = Math.min(Math.max(distanceValue, 0), DISTANCE_CAP_KM)
  return Math.max(0, 1 - cappedDistance / DISTANCE_CAP_KM)
}

function normalizeRatingScore(avgRating: number | null, reviewCount: number): number {
  if (reviewCount <= 0 || avgRating == null) return NO_RATING_BASELINE
  return Math.max(0, Math.min(avgRating / 5, 1))
}

function normalizeReviewCountScore(reviewCount: number): number {
  return Math.max(0, Math.min(reviewCount / EXPERIENCE_CAP_REVIEWS, 1))
}

export function rankWalkerCandidates(inputs: WalkerRankingInput[]): RankedWalkerCandidate[] {
  return inputs
    .map((input) => {
      const distanceValue = toFiniteNumber(input.distanceKm)
      const avgRating = toFiniteNumber(input.avgRating)
      const reviewCount = Math.max(0, Math.floor(toFiniteNumber(input.reviewCount) ?? 0))
      const affinityProviderSaved = input.affinityProviderSaved === true
      const affinityClientSaved = input.affinityClientSaved === true

      const distanceScore = normalizeDistanceScore(distanceValue)
      const ratingScore = normalizeRatingScore(avgRating, reviewCount)
      const reviewCountScore = normalizeReviewCountScore(reviewCount)
      const baseScore =
        distanceScore * DISTANCE_WEIGHT +
        ratingScore * RATING_WEIGHT +
        reviewCountScore * EXPERIENCE_WEIGHT

      const { attributeScore, attributeReason, attributeMatches } = computeAttributeScore(
        input.serviceType,
        input.clientServiceAttributes,
        input.providerServiceAttributes,
      )

      const affinityScore = Math.min(
        (affinityProviderSaved ? PROVIDER_SAVED_CUSTOMER_AFFINITY_BOOST : 0) +
          (affinityClientSaved ? CUSTOMER_SAVED_PROVIDER_AFFINITY_BOOST : 0),
        AFFINITY_SCORE_CAP,
      )
      const score = baseScore + affinityScore + attributeScore

      return {
        walkerId: input.walkerId,
        baseScore: Number(baseScore.toFixed(6)),
        affinityScore,
        affinityProviderSaved,
        affinityClientSaved,
        score: Number(score.toFixed(6)),
        distanceScore: Number(distanceScore.toFixed(6)),
        ratingScore: Number(ratingScore.toFixed(6)),
        reviewCountScore: Number(reviewCountScore.toFixed(6)),
        distanceKm: distanceValue == null ? null : Number(distanceValue.toFixed(3)),
        avgRating: avgRating == null ? null : Number(avgRating.toFixed(3)),
        reviewCount,
        attributeScore: Number(attributeScore.toFixed(6)),
        attributeReason,
        attributeMatches,
      }
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      if ((a.distanceKm ?? Number.POSITIVE_INFINITY) !== (b.distanceKm ?? Number.POSITIVE_INFINITY)) {
        return (a.distanceKm ?? Number.POSITIVE_INFINITY) - (b.distanceKm ?? Number.POSITIVE_INFINITY)
      }
      if ((b.avgRating ?? NO_RATING_BASELINE * 5) !== (a.avgRating ?? NO_RATING_BASELINE * 5)) {
        return (b.avgRating ?? NO_RATING_BASELINE * 5) - (a.avgRating ?? NO_RATING_BASELINE * 5)
      }
      if (b.reviewCount !== a.reviewCount) return b.reviewCount - a.reviewCount
      return a.walkerId.localeCompare(b.walkerId)
    })
}
