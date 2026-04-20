import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../services/supabaseClient'

export interface NearbyWalker {
  id: string
  lat: number
  lng: number
  bearing: number | null
}

const POLL_INTERVAL_MS = 15_000
const MAX_DISTANCE_KM = 100
const MIN_MOVE_DEG = 0.00004
const BEARING_STALE_MS = 90_000

function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function computeBearing(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const lat1R = (lat1 * Math.PI) / 180
  const lat2R = (lat2 * Math.PI) / 180
  const y = Math.sin(dLng) * Math.cos(lat2R)
  const x =
    Math.cos(lat1R) * Math.sin(lat2R) -
    Math.sin(lat1R) * Math.cos(lat2R) * Math.cos(dLng)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

interface BearingEntry {
  value: number
  timestamp: number
}

export function useNearbyWalkers(
  userLocation: [number, number] | null,
  enabled: boolean,
): NearbyWalker[] {
  const [walkers, setWalkers] = useState<NearbyWalker[]>([])
  const userLocRef = useRef(userLocation)
  userLocRef.current = userLocation

  const prevPosRef = useRef<Map<string, [number, number]>>(new Map())
  const lastSeenPosRef = useRef<Map<string, [number, number]>>(new Map())
  const bearingRef = useRef<Map<string, BearingEntry>>(new Map())

  const removeWalker = useCallback((id: string) => {
    prevPosRef.current.delete(id)
    lastSeenPosRef.current.delete(id)
    bearingRef.current.delete(id)
    setWalkers((prev) => prev.filter((w) => w.id !== id))
  }, [])

  const resolveBearing = useCallback(
    (id: string, lat: number, lng: number): number | null => {
      const lastSeen = lastSeenPosRef.current.get(id)

      if (lastSeen && lastSeen[0] === lat && lastSeen[1] === lng) {
        const existing = bearingRef.current.get(id)
        if (existing && Date.now() - existing.timestamp < BEARING_STALE_MS) {
          return existing.value
        }
        bearingRef.current.delete(id)
        return null
      }

      lastSeenPosRef.current.set(id, [lat, lng])

      const prev = prevPosRef.current.get(id)
      if (prev) {
        const dLat = Math.abs(lat - prev[0])
        const dLng = Math.abs(lng - prev[1])

        if (dLat > MIN_MOVE_DEG || dLng > MIN_MOVE_DEG) {
          const b = computeBearing(prev[0], prev[1], lat, lng)
          bearingRef.current.set(id, { value: b, timestamp: Date.now() })
          prevPosRef.current.set(id, [lat, lng])
          return b
        }
      } else {
        prevPosRef.current.set(id, [lat, lng])
      }

      const existing = bearingRef.current.get(id)
      if (existing && Date.now() - existing.timestamp < BEARING_STALE_MS) {
        return existing.value
      }
      bearingRef.current.delete(id)
      return null
    },
    [],
  )

  const fetchNearby = useCallback(async () => {
    const loc = userLocRef.current
    if (!loc) {
      setWalkers([])
      return
    }

    const { data, error } = await supabase
      .from('profiles')
      .select('id, last_lat, last_lng, is_online')
      .eq('role', 'walker')
      .eq('is_online', true)
      .not('last_lat', 'is', null)
      .not('last_lng', 'is', null)
      .limit(30)

    if (error || !data) {
      setWalkers([])
      return
    }

    const activeIds = new Set<string>()
    const nearby: NearbyWalker[] = []

    for (const w of data) {
      if (w.is_online !== true) continue
      if (w.last_lat == null || w.last_lng == null) continue

      if (haversineKm(loc[0], loc[1], w.last_lat, w.last_lng) <= MAX_DISTANCE_KM) {
        activeIds.add(w.id)
        nearby.push({
          id: w.id,
          lat: w.last_lat,
          lng: w.last_lng,
          bearing: resolveBearing(w.id, w.last_lat, w.last_lng),
        })
      }
    }

    for (const id of prevPosRef.current.keys()) {
      if (!activeIds.has(id)) {
        prevPosRef.current.delete(id)
        lastSeenPosRef.current.delete(id)
        bearingRef.current.delete(id)
      }
    }

    setWalkers(nearby)
  }, [resolveBearing])

  const applyRealtimeUpdate = useCallback(
    (row: {
      id: string
      is_online?: boolean
      last_lat?: number | null
      last_lng?: number | null
      role?: string
    }) => {
      const loc = userLocRef.current
      if (!loc) return

      if (row.role && row.role !== 'walker') return

      if (row.is_online === false) {
        removeWalker(row.id)
        return
      }

      const hasCoords = row.last_lat != null && row.last_lng != null
      const inRange =
        hasCoords &&
        haversineKm(loc[0], loc[1], row.last_lat!, row.last_lng!) <= MAX_DISTANCE_KM

      if (inRange) {
        const bearing = resolveBearing(row.id, row.last_lat!, row.last_lng!)
        setWalkers((prev) => {
          const idx = prev.findIndex((w) => w.id === row.id)
          const entry: NearbyWalker = {
            id: row.id,
            lat: row.last_lat!,
            lng: row.last_lng!,
            bearing,
          }

          if (idx >= 0) {
            const next = [...prev]
            next[idx] = entry
            return next
          }

          return [...prev, entry]
        })
      } else {
        removeWalker(row.id)
      }
    },
    [removeWalker, resolveBearing],
  )

  useEffect(() => {
    if (!enabled) {
      setWalkers([])
      return
    }

    void fetchNearby()

    const pollId = setInterval(() => {
      void fetchNearby()
    }, POLL_INTERVAL_MS)

    const channel = supabase
      .channel('nearby-walkers-rt')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'profiles',
        },
        (payload) => {
          const row = payload.new as {
            id: string
            role?: string
            is_online?: boolean
            last_lat?: number | null
            last_lng?: number | null
          }
          applyRealtimeUpdate(row)
        },
      )
      .subscribe()

    return () => {
      clearInterval(pollId)
      supabase.removeChannel(channel)
    }
  }, [enabled, fetchNearby, applyRealtimeUpdate])

  return walkers
}
