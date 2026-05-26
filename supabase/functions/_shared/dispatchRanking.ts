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

export type FinalDispatchSelectionInput = {
  walkerId: string
  baseScore: number
  affinityProviderSaved?: boolean
  affinityClientSaved?: boolean
  distanceKm?: number | null
  avgRating?: number | null
  reviewCount?: number | null
  attributeScore?: number
  recentAttemptCount?: number | null
}

export type FinalDispatchSelectionCandidate = {
  walkerId: string
  rank: number
  baseScore: number
  affinityScore: number
  attributeScore: number
  finalScore: number
  affinityProviderSaved: boolean
  affinityClientSaved: boolean
  distanceKm: number | null
  avgRating: number | null
  reviewCount: number
  cooldownPenalty: number
  recentAttemptCount: number
}

const LEGACY_TO_NORMALIZED_AGE_RANGE: Record<string, '1-2' | '2-4' | '5-7' | '7+'> = {
  '0-2': '1-2',
  '3-5': '2-4',
  '6-10': '5-7',
  '11+': '7+',
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
const NORMALIZED_PROVIDER_SAVED_CUSTOMER_AFFINITY_BOOST = 0.1
const NORMALIZED_CUSTOMER_SAVED_PROVIDER_AFFINITY_BOOST = 0.2
const NORMALIZED_AFFINITY_SCORE_CAP = 0.3
const FAIRNESS_RECENT_ATTEMPT_PENALTY = 0.02
const FAIRNESS_RECENT_ATTEMPT_PENALTY_CAP = 0.08

const ATTR_DOG_SIZE_BONUS = 0.025
const ATTR_DOG_SIZE_PENALTY = -0.01
const ATTR_ENERGY_BONUS = 0.025
const ATTR_ENERGY_PENALTY = -0.01
const ATTR_SITTER_FULL_BONUS = 0.05
const ATTR_SITTER_MISMATCH_PENALTY = -0.02

const AGE_RANGE_MAP: Record<string, [number, number]> = {
  '1-2': [1, 2],
  '2-4': [2, 4],
  '5-7': [5, 7],
  '7+': [7, 120],
  '0-2': [0, 2],
  '3-5': [3, 5],
  '6-10': [6, 10],
  '11+': [11, 120],
}

export function normalizeAgeRangeValue(value: unknown): '1-2' | '2-4' | '5-7' | '7+' | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (normalized === '1-2' || normalized === '2-4' || normalized === '5-7' || normalized === '7+') {
    return normalized
  }
  return LEGACY_TO_NORMALIZED_AGE_RANGE[normalized] ?? null
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

  const clientDogSize = typeof clientDog.dogSize === 'string' ? clientDog.dogSize : null
  const clientEnergy = typeof clientDog.energyLevel === 'string' ? clientDog.energyLevel : null
  const providerSizes = Array.isArray(providerDog.supportedDogSizes) ? providerDog.supportedDogSizes as string[] : null
  const providerEnergy = Array.isArray(providerDog.supportedEnergyLevels) ? providerDog.supportedEnergyLevels as string[] : null

  let score = 0
  const matches: string[] = []
  const reasons: string[] = []

  if (clientDogSize && providerSizes && providerSizes.length > 0) {
    if (providerSizes.includes(clientDogSize)) {
      score += ATTR_DOG_SIZE_BONUS
      matches.push(`dogSize:${clientDogSize}`)
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
        .filter((range): range is '1-2' | '2-4' | '5-7' | '7+' => range !== null)
    : null

  if (!childrenAges || childrenAges.length === 0 || !providerRanges || providerRanges.length === 0) {
    return { attributeScore: 0, attributeReason: 'neutral_missing_attributes', attributeMatches: [] }
  }

  const numericAges = childrenAges
    .map((a) => typeof a === 'number' ? a : typeof a === 'string' ? parseInt(a, 10) : NaN)
    .filter((a) => Number.isFinite(a))

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

function normalizeSelectionReviewCount(reviewCount: number | null | undefined): number {
  return Math.max(0, Math.floor(toFiniteNumber(reviewCount) ?? 0))
}

function normalizeRecentAttemptCount(recentAttemptCount: number | null | undefined): number {
  return Math.max(0, Math.floor(toFiniteNumber(recentAttemptCount) ?? 0))
}

function computeCooldownPenalty(recentAttemptCount: number): number {
  return Number(
    Math.min(recentAttemptCount * FAIRNESS_RECENT_ATTEMPT_PENALTY, FAIRNESS_RECENT_ATTEMPT_PENALTY_CAP).toFixed(6),
  )
}

export function computeNormalizedAffinityScore(
  affinityProviderSaved: boolean,
  affinityClientSaved: boolean,
): number {
  const rawScore =
    (affinityProviderSaved ? NORMALIZED_PROVIDER_SAVED_CUSTOMER_AFFINITY_BOOST : 0) +
    (affinityClientSaved ? NORMALIZED_CUSTOMER_SAVED_PROVIDER_AFFINITY_BOOST : 0)
  return Number(Math.min(rawScore, NORMALIZED_AFFINITY_SCORE_CAP).toFixed(6))
}

export function rankDispatchCandidatesByFinalScore(
  inputs: FinalDispatchSelectionInput[],
): FinalDispatchSelectionCandidate[] {
  return inputs
    .map((input, index) => {
      const baseScore = Number((toFiniteNumber(input.baseScore) ?? 0).toFixed(6))
      const affinityProviderSaved = input.affinityProviderSaved === true
      const affinityClientSaved = input.affinityClientSaved === true
      const affinityScore = computeNormalizedAffinityScore(
        affinityProviderSaved,
        affinityClientSaved,
      )
      const attributeScore = Number((toFiniteNumber(input.attributeScore) ?? 0).toFixed(6))
      const recentAttemptCount = normalizeRecentAttemptCount(input.recentAttemptCount)
      const cooldownPenalty = computeCooldownPenalty(recentAttemptCount)
      const finalScore = Number((baseScore + affinityScore + attributeScore - cooldownPenalty).toFixed(6))
      const distanceKm = toFiniteNumber(input.distanceKm)
      const avgRating = toFiniteNumber(input.avgRating)
      const reviewCount = normalizeSelectionReviewCount(input.reviewCount)

      return {
        walkerId: input.walkerId,
        rank: index + 1,
        baseScore,
        affinityScore,
        attributeScore,
        finalScore,
        affinityProviderSaved,
        affinityClientSaved,
        distanceKm: distanceKm == null ? null : Number(distanceKm.toFixed(3)),
        avgRating: avgRating == null ? null : Number(avgRating.toFixed(3)),
        reviewCount,
        cooldownPenalty,
        recentAttemptCount,
      }
    })
    .sort((left, right) => {
      if (right.finalScore !== left.finalScore) return right.finalScore - left.finalScore
      if ((left.distanceKm ?? Number.POSITIVE_INFINITY) !== (right.distanceKm ?? Number.POSITIVE_INFINITY)) {
        return (left.distanceKm ?? Number.POSITIVE_INFINITY) - (right.distanceKm ?? Number.POSITIVE_INFINITY)
      }
      if ((right.avgRating ?? NO_RATING_BASELINE * 5) !== (left.avgRating ?? NO_RATING_BASELINE * 5)) {
        return (right.avgRating ?? NO_RATING_BASELINE * 5) - (left.avgRating ?? NO_RATING_BASELINE * 5)
      }
      if (right.reviewCount !== left.reviewCount) return right.reviewCount - left.reviewCount
      return left.rank - right.rank
    })
    .map((candidate, index) => ({
      ...candidate,
      rank: index + 1,
    }))
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
