import type { SupabaseClient } from '@supabase/supabase-js'

export type RankedDispatchCandidate = {
  walkerId: string
  score: number
}

type Input = {
  supabase: SupabaseClient
  clientLat: number
  clientLng: number
  limit?: number
}

function distanceKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
) {
  const R = 6371
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2)

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
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

  const ranked = data
    .filter((w) => w.last_lat && w.last_lng)
    .map((w) => {
      const dist = distanceKm(
        clientLat,
        clientLng,
        w.last_lat!,
        w.last_lng!,
      )

      return {
        walkerId: w.id,
        score: 1 / (dist + 0.1), // קרוב = גבוה
      }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

  console.log('[choosePreferredWalkers] ranked:', ranked)

  return ranked
}
