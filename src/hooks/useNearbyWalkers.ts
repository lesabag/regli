import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../services/supabaseClient'
import { type ProfileServiceType } from '../lib/profileServiceTypes'
import { providerSupportsRequestedService } from '../lib/providerServiceTypes'
import {
  fetchProviderAvailabilityRows,
  groupProviderAvailabilityRows,
  isProviderAvailableAt,
  type ProviderAvailabilityRow,
} from '../utils/providerAvailability'

export interface NearbyWalker {
  id: string
  lat: number
  lng: number
  bearing: number | null
  avatarUrl: string | null
  fullName: string | null
  rating: number | null
}

type ProviderRadiusPreferenceRow = {
  provider_id: string | null
  service_radius_km: number | null
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
  serviceTypeFilter?: string | ProfileServiceType | null,
  availabilityAt?: string | null,
  bookingType: 'asap' | 'scheduled' = 'asap',
): NearbyWalker[] {
  const [walkers, setWalkers] = useState<NearbyWalker[]>([])
  const userLocRef = useRef(userLocation)
  userLocRef.current = userLocation
  const serviceTypeFilterRef = useRef(serviceTypeFilter ?? null)
  serviceTypeFilterRef.current = serviceTypeFilter ?? null
  const availabilityAtRef = useRef(availabilityAt ?? null)
  availabilityAtRef.current = availabilityAt ?? null
  const bookingTypeRef = useRef<'asap' | 'scheduled'>(bookingType)
  bookingTypeRef.current = bookingType

  const prevPosRef = useRef<Map<string, [number, number]>>(new Map())
  const lastSeenPosRef = useRef<Map<string, [number, number]>>(new Map())
  const bearingRef = useRef<Map<string, BearingEntry>>(new Map())
  const availabilityByProviderRef = useRef<Map<string, ProviderAvailabilityRow[]>>(new Map())
  const radiusByProviderRef = useRef<Map<string, number | null>>(new Map())

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

  const walkerSupportsService = useCallback(
    (
      row: {
        service_types?: string[] | null
        service_type?: string | null
      },
      expectedServiceType: string | ProfileServiceType | null,
    ) => {
      return providerSupportsRequestedService(row, expectedServiceType ?? null)
    },
    [],
  )

  const fetchNearby = useCallback(async () => {
    const loc = userLocRef.current
    if (!loc) {
      availabilityByProviderRef.current = new Map()
      radiusByProviderRef.current = new Map()
      setWalkers([])
      return
    }

    const { data, error } = await supabase
      .from('profiles')
      .select('id, full_name, last_lat, last_lng, is_online, service_type, service_types, avatar_url')
      .eq('role', 'walker')
      .eq('is_online', true)
      .not('last_lat', 'is', null)
      .not('last_lng', 'is', null)
      .limit(30)

    if (error || !data) {
      availabilityByProviderRef.current = new Map()
      radiusByProviderRef.current = new Map()
      setWalkers([])
      return
    }

    const expectedServiceType = serviceTypeFilterRef.current
    const availabilityReferenceAt = availabilityAtRef.current ?? new Date().toISOString()
    const expectedBookingType = bookingTypeRef.current
    const providerIds = data.map((row) => row.id).filter((value): value is string => typeof value === 'string' && value.length > 0)
    let ratingsByProvider = new Map<string, number | null>()
    try {
      const [availabilityRows, ratingsResult, providerPreferencesResult] = await Promise.all([
        fetchProviderAvailabilityRows(providerIds, expectedServiceType),
        supabase
          .from('ratings')
          .select('to_user_id, rating')
          .in('to_user_id', providerIds),
        expectedServiceType
          ? supabase
              .from('provider_service_preferences')
              .select('provider_id, service_radius_km')
              .in('provider_id', providerIds)
              .eq('service_type', expectedServiceType)
              .eq('booking_type', expectedBookingType)
              .eq('is_enabled', true)
          : Promise.resolve({ data: null, error: null }),
      ])
      availabilityByProviderRef.current = groupProviderAvailabilityRows(availabilityRows)
      radiusByProviderRef.current = new Map(
        (
          (providerPreferencesResult.data as ProviderRadiusPreferenceRow[] | null) ??
          []
        ).map<[string, number | null]>((row) => [
          row.provider_id ?? '',
          typeof row.service_radius_km === 'number' && Number.isFinite(row.service_radius_km) && row.service_radius_km > 0
            ? row.service_radius_km
            : null,
        ]).filter((entry): entry is [string, number | null] => entry[0].length > 0),
      )

      const ratingBuckets = new Map<string, number[]>()
      ;((ratingsResult.data as Array<{ to_user_id: string | null; rating: number | null }> | null) ?? []).forEach((row) => {
        if (!row.to_user_id || typeof row.rating !== 'number' || !Number.isFinite(row.rating)) return
        const existing = ratingBuckets.get(row.to_user_id) ?? []
        existing.push(row.rating)
        ratingBuckets.set(row.to_user_id, existing)
      })

      ratingsByProvider = new Map(
        providerIds.map((providerId) => {
          const values = ratingBuckets.get(providerId) ?? []
          const average = values.length > 0
            ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10
            : null
          return [providerId, average]
        }),
      )
    } catch (availabilityError) {
      console.warn('[useNearbyWalkers] availability lookup failed:', availabilityError)
      availabilityByProviderRef.current = new Map()
      radiusByProviderRef.current = new Map()
      setWalkers([])
      return
    }

    const activeIds = new Set<string>()
    const nearby: NearbyWalker[] = []

    for (const w of data) {
      if (w.is_online !== true) continue
      if (w.last_lat == null || w.last_lng == null) continue
      if (!walkerSupportsService(w, expectedServiceType)) continue
      if (!isProviderAvailableAt(availabilityByProviderRef.current.get(w.id) ?? [], expectedServiceType, availabilityReferenceAt)) {
        continue
      }

      const candidateDistanceKm = haversineKm(loc[0], loc[1], w.last_lat, w.last_lng)
      const serviceRadiusKm = radiusByProviderRef.current.get(w.id) ?? null
      if (serviceRadiusKm != null && candidateDistanceKm > serviceRadiusKm) {
        console.log('[useNearbyWalkers] provider excluded by service radius', {
          providerId: w.id,
          bookingType: expectedBookingType,
          serviceType: expectedServiceType,
          distanceKm: Number(candidateDistanceKm.toFixed(2)),
          serviceRadiusKm,
        })
        continue
      }

      if (candidateDistanceKm <= MAX_DISTANCE_KM) {
        activeIds.add(w.id)
        nearby.push({
          id: w.id,
          lat: w.last_lat,
          lng: w.last_lng,
          bearing: resolveBearing(w.id, w.last_lat, w.last_lng),
          avatarUrl: ('avatar_url' in w ? (w.avatar_url as string | null) : null) ?? null,
          fullName: ('full_name' in w ? (w.full_name as string | null) : null) ?? null,
          rating: ratingsByProvider.get(w.id) ?? null,
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
  }, [resolveBearing, walkerSupportsService])

  const applyRealtimeUpdate = useCallback(
    (row: {
      id: string
      is_online?: boolean
      last_lat?: number | null
      last_lng?: number | null
      role?: string
      full_name?: string | null
      service_type?: string | null
      service_types?: string[] | null
      avatar_url?: string | null
    }) => {
      const loc = userLocRef.current
      if (!loc) return
      const expectedServiceType = serviceTypeFilterRef.current
      const availabilityReferenceAt = availabilityAtRef.current ?? new Date().toISOString()

      if (row.role && row.role !== 'walker') return

      if (row.is_online === false) {
        removeWalker(row.id)
        return
      }

      if (!walkerSupportsService(row, expectedServiceType)) {
        removeWalker(row.id)
        return
      }
      if (!isProviderAvailableAt(availabilityByProviderRef.current.get(row.id) ?? [], expectedServiceType, availabilityReferenceAt)) {
        removeWalker(row.id)
        return
      }

      const hasCoords = row.last_lat != null && row.last_lng != null
      const serviceRadiusKm = radiusByProviderRef.current.get(row.id) ?? null
      const candidateDistanceKm =
        hasCoords
          ? haversineKm(loc[0], loc[1], row.last_lat!, row.last_lng!)
          : null
      const inRange =
        hasCoords &&
        candidateDistanceKm! <= MAX_DISTANCE_KM &&
        (serviceRadiusKm == null || candidateDistanceKm! <= serviceRadiusKm)

      if (inRange) {
        const bearing = resolveBearing(row.id, row.last_lat!, row.last_lng!)
        setWalkers((prev) => {
          const idx = prev.findIndex((w) => w.id === row.id)
          const entry: NearbyWalker = {
            id: row.id,
            lat: row.last_lat!,
            lng: row.last_lng!,
            bearing,
            avatarUrl: row.avatar_url ?? (idx >= 0 ? prev[idx]?.avatarUrl ?? null : null),
            fullName: row.full_name ?? (idx >= 0 ? prev[idx]?.fullName ?? null : null),
            rating: idx >= 0 ? prev[idx]?.rating ?? null : null,
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
    [removeWalker, resolveBearing, walkerSupportsService],
  )

  useEffect(() => {
    if (!enabled) {
      availabilityByProviderRef.current = new Map()
      radiusByProviderRef.current = new Map()
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
            full_name?: string | null
            is_online?: boolean
            last_lat?: number | null
            last_lng?: number | null
            service_type?: string | null
            service_types?: string[] | null
            avatar_url?: string | null
          }
          applyRealtimeUpdate(row)
        },
      )
      .subscribe()

    return () => {
      clearInterval(pollId)
      supabase.removeChannel(channel)
    }
  }, [enabled, fetchNearby, applyRealtimeUpdate, serviceTypeFilter])

  useEffect(() => {
    if (!enabled) return
    void fetchNearby()
  }, [availabilityAt, bookingType, enabled, fetchNearby, serviceTypeFilter])

  return walkers
}
