import type { SupabaseClient } from '@supabase/supabase-js'
import { distanceKm, rankWalkerCandidates } from './dispatchRanking'

export type RankedDispatchCandidate = {
  walkerId: string
  score: number
}

type WalkerRow = {
  id: string
  last_lat: number | null
  last_lng: number | null
}

type RatingRow = {
  to_user_id: string
  rating: number
}

type Input = {
  supabase: SupabaseClient
  clientLat: number
  clientLng: number
  limit?: number
}

export async function choosePreferredWalkers({
  supabase,
  clientLat,
  clientLng,
  limit = 5,
}: Input): Promise<RankedDispatchCandidate[]> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, last_lat, last_lng')
    .eq('role', 'walker')
    .eq('is_online', true)

  if (error) {
    console.error('[choosePreferredWalkers] error:', error)
    return []
  }

  if (!data || data.length === 0) {
    console.warn('[choosePreferredWalkers] no online walkers')
    return []
  }

  const walkers = (data as WalkerRow[]).filter((walker) => walker.last_lat != null && walker.last_lng != null)
  const walkerIds = walkers.map((walker) => walker.id)
  const { data: ratingsRows, error: ratingsError } = walkerIds.length
    ? await supabase.from('ratings').select('to_user_id, rating').in('to_user_id', walkerIds)
    : { data: [], error: null }

  if (ratingsError) {
    console.error('[choosePreferredWalkers] ratings error:', ratingsError)
    return []
  }

  const ratingsByWalker = ((ratingsRows || []) as RatingRow[]).reduce((map, row) => {
    const current = map.get(row.to_user_id) ?? { total: 0, count: 0 }
    current.total += row.rating
    current.count += 1
    map.set(row.to_user_id, current)
    return map
  }, new Map<string, { total: number; count: number }>())

  const ranked = rankWalkerCandidates(
    walkers.map((walker) => {
      const ratingStats = ratingsByWalker.get(walker.id)
      return {
        walkerId: walker.id,
        distanceKm: distanceKm(clientLat, clientLng, walker.last_lat!, walker.last_lng!),
        avgRating:
          ratingStats && ratingStats.count > 0
            ? ratingStats.total / ratingStats.count
            : null,
        reviewCount: ratingStats?.count ?? 0,
      }
    }),
  )
    .map((candidate) => ({
      walkerId: candidate.walkerId,
      score: candidate.score,
    }))
    .slice(0, limit)

  console.log('[choosePreferredWalkers] ranked:', ranked)

  return ranked
}
