export type WalkerRankingInput = {
  walkerId: string
  distanceKm?: number | null
  avgRating?: number | null
  reviewCount?: number | null
}

export type RankedWalkerCandidate = {
  walkerId: string
  score: number
  distanceScore: number
  ratingScore: number
  reviewCountScore: number
  distanceKm: number | null
  avgRating: number | null
  reviewCount: number
}

const DISTANCE_WEIGHT = 0.55
const RATING_WEIGHT = 0.3
const EXPERIENCE_WEIGHT = 0.15
const DISTANCE_CAP_KM = 5
const NO_RATING_BASELINE = 0.75
const EXPERIENCE_CAP_REVIEWS = 20
const NEUTRAL_DISTANCE_SCORE = 0.5

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

      const distanceScore = normalizeDistanceScore(distanceValue)
      const ratingScore = normalizeRatingScore(avgRating, reviewCount)
      const reviewCountScore = normalizeReviewCountScore(reviewCount)
      const score =
        distanceScore * DISTANCE_WEIGHT +
        ratingScore * RATING_WEIGHT +
        reviewCountScore * EXPERIENCE_WEIGHT

      return {
        walkerId: input.walkerId,
        score: Number(score.toFixed(6)),
        distanceScore: Number(distanceScore.toFixed(6)),
        ratingScore: Number(ratingScore.toFixed(6)),
        reviewCountScore: Number(reviewCountScore.toFixed(6)),
        distanceKm: distanceValue == null ? null : Number(distanceValue.toFixed(3)),
        avgRating: avgRating == null ? null : Number(avgRating.toFixed(3)),
        reviewCount,
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
