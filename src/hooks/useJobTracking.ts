import { useEffect, useRef, useState, useCallback } from 'react'
import { supabase } from '../services/supabaseClient'

const DEFAULT_LOCATION: [number, number] = [32.0853, 34.7818]
const POLL_INTERVAL_MS = 7_000
const STALENESS_CHECK_MS = 4_000
const LIVE_THRESHOLD_MS = 45_000
const DELAYED_THRESHOLD_MS = 180_000
const MIN_MOVE_METERS = 8
const ETA_SMOOTH_FACTOR = 0.3
const ROUTE_MIN_MOVE_METERS = 25
const ROUTE_MIN_INTERVAL_MS = 10_000
const LERP_DURATION_MS = 800


const DEBUG = typeof window !== 'undefined' && window.location?.search?.includes('debug_tracking')

function dbg(...args: unknown[]) {
  if (DEBUG) console.log('[tracking]', ...args)
}

function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const toRad = (v: number) => (v * Math.PI) / 180
  const R = 6_371_000
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)))
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  return haversineMeters(lat1, lng1, lat2, lng2) / 1000
}

function ageMs(timestamp: string | null | undefined): number {
  if (!timestamp) return Infinity
  return Date.now() - new Date(timestamp).getTime()
}

function qualityFromAge(age: number): GpsQuality {
  if (age < LIVE_THRESHOLD_MS) return 'live'
  if (age < DELAYED_THRESHOLD_MS) return 'delayed'
  return 'offline'
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

// Compute bearing in degrees (0 = north, 90 = east) between two [lat, lng] points
function computeBearing(from: [number, number], to: [number, number]): number {
  const toRad = (v: number) => (v * Math.PI) / 180
  const toDeg = (v: number) => (v * 180) / Math.PI
  const dLng = toRad(to[1] - from[1])
  const lat1 = toRad(from[0])
  const lat2 = toRad(to[0])
  const y = Math.sin(dLng) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng)
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}

// ─── OSRM route fetch (no API key required) ────────────────

async function fetchRouteOSRM(
  wLoc: [number, number],
  uLoc: [number, number],
  signal?: AbortSignal
): Promise<[number, number][] | null> {
  try {
    const url =
      `https://router.project-osrm.org/route/v1/driving/` +
      `${wLoc[1]},${wLoc[0]};${uLoc[1]},${uLoc[0]}` +
      `?overview=full&geometries=geojson`

    const res = await fetch(url, signal ? { signal } : undefined)
    const data = await res.json()

    if (!data.routes || !data.routes.length) {
      dbg('[route] OSRM: no routes returned')
      return null
    }

    const route = data.routes[0]
    const coords = route.geometry.coordinates

    // Convert [lng, lat] → [lat, lng] for Leaflet
    const points: [number, number][] = coords.map(
      ([lng, lat]: [number, number]) => [lat, lng] as [number, number]
    )

    dbg('[route] OSRM points:', points.length, '| dist', route.distance, 'm | duration', route.duration, 's')
    return points
  } catch (err) {
    if ((err as Error).name === 'AbortError') return null
    dbg('[route] OSRM fetch failed:', err)
    return null
  }
}

// Full OSRM response including distance/duration for ETA calculation
async function fetchOSRMWithMeta(
  wLoc: [number, number],
  uLoc: [number, number],
  signal?: AbortSignal
): Promise<{ points: [number, number][]; distanceM: number; durationSec: number } | null> {
  try {
    const url =
      `https://router.project-osrm.org/route/v1/driving/` +
      `${wLoc[1]},${wLoc[0]};${uLoc[1]},${uLoc[0]}` +
      `?overview=full&geometries=geojson`

    const res = await fetch(url, signal ? { signal } : undefined)
    const data = await res.json()

    if (!data.routes || !data.routes.length) {
      dbg('[route] OSRM+meta: no routes returned')
      return null
    }

    const route = data.routes[0]
    const coords = route.geometry.coordinates
    const points: [number, number][] = coords.map(
      ([lng, lat]: [number, number]) => [lat, lng] as [number, number]
    )

    dbg('[route] OSRM+meta points:', points.length, '| dist', route.distance, 'm | duration', route.duration, 's')
    return { points, distanceM: route.distance, durationSec: route.duration }
  } catch (err) {
    if ((err as Error).name === 'AbortError') return null
    dbg('[route] OSRM+meta fetch failed:', err)
    return null
  }
}

export type GpsQuality = 'live' | 'last_known' | 'delayed' | 'offline' | 'none'

export type ProximityHint = 'nearby' | 'almost' | null

export type ProximityLevel = 'far' | 'near' | 'very_near' | 'arriving' | 'arrived'

function computeProximityLevel(distanceMeters: number, isArrived: boolean): ProximityLevel {
  if (isArrived) return 'arrived'
  if (distanceMeters < 30) return 'arriving'
  if (distanceMeters < 100) return 'very_near'
  if (distanceMeters < 200) return 'near'
  return 'far'
}

export interface JobTrackingState {
  walkerLocation: [number, number] | null
  walkerBearing: number | null
  userLocation: [number, number]
  hasUserLocation: boolean
  etaMinutes: number | null
  isArrived: boolean
  gpsQuality: GpsQuality
  distanceMeters: number | null
  proximityHint: ProximityHint
  proximityLevel: ProximityLevel
  routePolyline: [number, number][]
}

export function useJobTracking(jobId: string | null): JobTrackingState {
  const [walkerLocation, setWalkerLocation] = useState<[number, number] | null>(null)
  const [walkerBearing, setWalkerBearing] = useState<number | null>(null)
  const [userLocation, setUserLocation] = useState<[number, number]>(DEFAULT_LOCATION)
  const [hasUserLocation, setHasUserLocation] = useState(false)
  const [etaMinutes, setEtaMinutes] = useState<number | null>(null)
  const [isArrived, setIsArrived] = useState(false)
  const [gpsQuality, setGpsQuality] = useState<GpsQuality>('none')
  const [distanceMeters, setDistanceMeters] = useState<number | null>(null)
  const [proximityHint, setProximityHint] = useState<ProximityHint>(null)
  const [proximityLevel, setProximityLevel] = useState<ProximityLevel>('far')
  const [routePolyline, setRoutePolyline] = useState<[number, number][]>([])

  const userLocationRef = useRef(userLocation)
  userLocationRef.current = userLocation

  const hasRealUserLocation = useRef(false)
  const lastLocationUpdateRef = useRef<string | null>(null)
  const walkerLocationRef = useRef<[number, number] | null>(null)
  const prevGpsQualityRef = useRef<GpsQuality>('none')
  const prevRawEtaRef = useRef<number | null>(null)
  const lerpFrameRef = useRef<number>(0)
  const lerpFromRef = useRef<[number, number] | null>(null)
  const lerpToRef = useRef<[number, number] | null>(null)
  const lerpStartTimeRef = useRef<number>(0)

  // Route fetch throttle refs
  const lastRouteFetchWalkerRef = useRef<[number, number] | null>(null)
  const lastRouteFetchTimeRef = useRef(0)
  const routeAbortRef = useRef<AbortController | null>(null)

  // ─── Helpers ──────────────────────────────────────────────

  const setQuality = useCallback((q: GpsQuality) => {
    if (prevGpsQualityRef.current !== q) {
      dbg('gpsQuality:', prevGpsQualityRef.current, '→', q)
      prevGpsQualityRef.current = q
      setGpsQuality(q)
    }
  }, [])

  const updateProximity = useCallback((distM: number, arrived = false) => {
    setDistanceMeters(Math.round(distM))
    if (distM < 100) {
      setProximityHint('almost')
    } else if (distM < 200) {
      setProximityHint('nearby')
    } else {
      setProximityHint(null)
    }
    setProximityLevel(computeProximityLevel(distM, arrived))
  }, [])

  // ─── Haversine-only ETA (last resort when OSRM fails) ─────

  const computeHaversineEta = useCallback((wLoc: [number, number]) => {
    if (!hasRealUserLocation.current) {
      dbg('haversineEta: no real user location yet')
      return
    }

    const uLoc = userLocationRef.current
    const distKm = haversineKm(wLoc[0], wLoc[1], uLoc[0], uLoc[1])
    const distM = distKm * 1000

    if (distKm < 0.05) {
      updateProximity(distM, true)
      setIsArrived(true)
      setEtaMinutes(0)
      prevRawEtaRef.current = 0
    } else {
      updateProximity(distM)
      setIsArrived(false)
      const rawEta = Math.max(1, Math.ceil((distKm / 12) * 60))
      const prev = prevRawEtaRef.current
      const smoothed = prev != null && prev > 0
        ? Math.max(1, Math.round((1 - ETA_SMOOTH_FACTOR) * prev + ETA_SMOOTH_FACTOR * rawEta))
        : rawEta
      prevRawEtaRef.current = smoothed
      setEtaMinutes(smoothed)
      dbg('ETA source: HAVERSINE fallback | dist', distM.toFixed(0), 'm | raw', rawEta, 'min | smoothed', smoothed, 'min')
    }
  }, [updateProximity])

  // ─── OSRM route + straight-line fallback for polyline ─────

  const fetchRouteAndSetPolyline = useCallback(async (wLoc: [number, number]) => {
    if (!hasRealUserLocation.current) {
      dbg('fetchRouteAndSetPolyline: no real user location yet')
      return
    }

    const uLoc = userLocationRef.current
    const route = await fetchRouteOSRM(wLoc, uLoc)

    if (route && route.length > 0) {
      dbg('fetchRouteAndSetPolyline: OSRM road route set |', route.length, 'points')
      setRoutePolyline(route)
    } else {
      dbg('fetchRouteAndSetPolyline: OSRM failed, falling back to straight-line')
      setRoutePolyline([wLoc, uLoc])
    }
  }, [])

  // ─── OSRM route fetch (with ETA + polyline) ────────────────

  const fetchRoute = useCallback(async (wLoc: [number, number]) => {
    if (!hasRealUserLocation.current) {
      dbg('fetchRoute: no real user location yet')
      return
    }

    const uLoc = userLocationRef.current
    const now = Date.now()

    // Throttle: skip if walker hasn't moved enough or too soon
    const prev = lastRouteFetchWalkerRef.current
    if (prev) {
      const moved = haversineMeters(prev[0], prev[1], wLoc[0], wLoc[1])
      const elapsed = now - lastRouteFetchTimeRef.current
      if (moved < ROUTE_MIN_MOVE_METERS && elapsed < ROUTE_MIN_INTERVAL_MS) {
        dbg('fetchRoute: throttled | moved', moved.toFixed(0), 'm | elapsed', elapsed, 'ms')
        return
      }
    }

    // Abort previous in-flight request
    if (routeAbortRef.current) routeAbortRef.current.abort()
    const controller = new AbortController()
    routeAbortRef.current = controller

    try {
      dbg('fetchRoute: requesting OSRM', { walker: wLoc, user: uLoc })
      const result = await fetchOSRMWithMeta(wLoc, uLoc, controller.signal)

      if (!result) {
        dbg('fetchRoute: OSRM failed → fallback haversine ETA + straight-line polyline')
        setRoutePolyline([wLoc, uLoc])
        computeHaversineEta(wLoc)
        dbg('ETA source: FALLBACK (haversine)')
        return
      }

      lastRouteFetchWalkerRef.current = wLoc
      lastRouteFetchTimeRef.current = Date.now()

      const { points, distanceM: routeDistM, durationSec } = result

      // Set road-based polyline
      setRoutePolyline(points)

      // ETA directly from OSRM route duration (no smoothing — road-based duration is accurate)
      if (routeDistM < 50) {
        updateProximity(routeDistM, true)
        setIsArrived(true)
        setEtaMinutes(0)
        prevRawEtaRef.current = 0
        dbg('fetchRoute: arrived | dist', routeDistM, 'm')
      } else {
        updateProximity(routeDistM)
        setIsArrived(false)
        const etaMin = Math.max(1, Math.round(durationSec / 60))
        prevRawEtaRef.current = etaMin
        setEtaMinutes(etaMin)
        dbg('ETA source: OSRM route |', durationSec, 's →', etaMin, 'min | dist', routeDistM, 'm | polyline', points.length, 'pts')
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      console.warn('[tracking] Route fetch failed, using haversine fallback:', err)
      setRoutePolyline([wLoc, uLoc])
      computeHaversineEta(wLoc)
      dbg('ETA source: FALLBACK (haversine) after error')
    }
  }, [computeHaversineEta, updateProximity])

  // ─── Smooth interpolation ─────────────────────────────────
  // Animates walker marker from current visual position to new GPS target.
  // If interrupted mid-animation, computes where the marker is right now
  // and starts the new animation from there (no snap/jump).

  const startLerp = useCallback((from: [number, number], to: [number, number]) => {
    // If an animation is in-flight, compute the current visual position and start from there
    if (lerpFrameRef.current && lerpFromRef.current && lerpToRef.current) {
      const elapsed = performance.now() - lerpStartTimeRef.current
      const t = Math.min(elapsed / LERP_DURATION_MS, 1)
      const eased = 1 - (1 - t) ** 3
      from = [
        lerp(lerpFromRef.current[0], lerpToRef.current[0], eased),
        lerp(lerpFromRef.current[1], lerpToRef.current[1], eased),
      ]
      dbg('lerp interrupted at t=', t.toFixed(2), '→ continuing from visual position')
    }

    lerpFromRef.current = from
    lerpToRef.current = to

    if (lerpFrameRef.current) cancelAnimationFrame(lerpFrameRef.current)

    // Compute bearing from animation start to target
    const dist = haversineMeters(from[0], from[1], to[0], to[1])
    if (dist > 3) {
      setWalkerBearing(computeBearing(from, to))
    }

    const startTime = performance.now()
    lerpStartTimeRef.current = startTime

    function tick(now: number) {
      const elapsed = now - startTime
      const t = Math.min(elapsed / LERP_DURATION_MS, 1)
      const eased = 1 - (1 - t) ** 3

      const f = lerpFromRef.current!
      const target = lerpToRef.current!
      const lat = lerp(f[0], target[0], eased)
      const lng = lerp(f[1], target[1], eased)
      setWalkerLocation([lat, lng])

      if (t < 1) {
        lerpFrameRef.current = requestAnimationFrame(tick)
      } else {
        lerpFrameRef.current = 0
      }
    }

    lerpFrameRef.current = requestAnimationFrame(tick)
  }, [])

  // ─── Core walker state update ─────────────────────────────

  const updateWalkerState = useCallback(
    (lat: number, lng: number, lastUpdate: string | null, source: string) => {
      if (!isFinite(lat) || !isFinite(lng)) return

      const prev = walkerLocationRef.current
      if (prev) {
        const moved = haversineMeters(prev[0], prev[1], lat, lng)
        if (moved < MIN_MOVE_METERS) {
          if (lastUpdate) {
            lastLocationUpdateRef.current = lastUpdate
            setQuality(qualityFromAge(ageMs(lastUpdate)))
          }
          dbg('skip micro-move', moved.toFixed(1), 'm via', source)
          return
        }
      }

      const target: [number, number] = [lat, lng]
      walkerLocationRef.current = target

      if (prev) {
        startLerp(prev, target)
      } else {
        setWalkerLocation(target)
      }

      if (lastUpdate) {
        lastLocationUpdateRef.current = lastUpdate
        const age = ageMs(lastUpdate)
        setQuality(qualityFromAge(age))
        dbg('update via', source, '| age', Math.round(age / 1000), 's | quality', qualityFromAge(age))
      } else {
        setQuality('last_known')
        dbg('update via', source, '| no timestamp → last_known')
      }

      const q = lastUpdate ? qualityFromAge(ageMs(lastUpdate)) : 'last_known'
      if (q === 'live') {
        // Live GPS: fetch OSRM road route + ETA
        fetchRoute(target)
      } else {
        // Not live: clear ETA but still show road-based route for visual feedback
        setEtaMinutes(null)
        prevRawEtaRef.current = null
        if (hasRealUserLocation.current) {
          const uLoc = userLocationRef.current
          const distM = haversineMeters(target[0], target[1], uLoc[0], uLoc[1])
          updateProximity(distM)
          // Fetch OSRM road route (falls back to straight-line)
          fetchRouteAndSetPolyline(target)
        }
      }
    },
    [setQuality, fetchRoute, fetchRouteAndSetPolyline, startLerp, updateProximity]
  )

  // ─── Client geolocation watch ─────────────────────────────
  useEffect(() => {
    if (!jobId || !navigator.geolocation) return

    hasRealUserLocation.current = false

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        hasRealUserLocation.current = true
        setHasUserLocation(true)
        setUserLocation([pos.coords.latitude, pos.coords.longitude])
      },
      (err) => console.warn('[useJobTracking] geo error:', err.message),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
    )

    return () => navigator.geolocation.clearWatch(watchId)
  }, [jobId])

  // ─── Staleness tick ───────────────────────────────────────
  useEffect(() => {
    if (!jobId) return

    const interval = setInterval(() => {
      const lastUpdate = lastLocationUpdateRef.current
      if (!lastUpdate) return

      const age = ageMs(lastUpdate)
      const q = qualityFromAge(age)
      setQuality(q)

      if (q !== 'live') {
        setEtaMinutes(null)
        prevRawEtaRef.current = null
      }

      dbg('staleness tick | age', Math.round(age / 1000), 's | quality', q)
    }, STALENESS_CHECK_MS)

    return () => clearInterval(interval)
  }, [jobId, setQuality])

  // ─── Initial fetch + realtime + polling ────────────────────
  useEffect(() => {
    if (!jobId) {
      setEtaMinutes(null)
      setIsArrived(false)
      setQuality('none')
      setDistanceMeters(null)
      setProximityHint(null)
      setProximityLevel('far')
      setRoutePolyline([])
      prevRawEtaRef.current = null
      walkerLocationRef.current = null
      lastLocationUpdateRef.current = null
      lastRouteFetchWalkerRef.current = null
      lastRouteFetchTimeRef.current = 0
      setWalkerLocation(null)
      if (lerpFrameRef.current) {
        cancelAnimationFrame(lerpFrameRef.current)
        lerpFrameRef.current = 0
      }
      if (routeAbortRef.current) {
        routeAbortRef.current.abort()
        routeAbortRef.current = null
      }
      return
    }

    let cancelled = false

    async function fetchLocation() {
      try {
        const { data, error } = await supabase
          .from('walk_requests')
          .select('walker_lat, walker_lng, last_location_update, status')
          .eq('id', jobId!)
          .single()

        if (cancelled) return

        if (error) {
          dbg('poll error:', error.message)
          return
        }

        if (data?.status === 'completed' || data?.status === 'cancelled') {
          return
        }

        if (data?.walker_lat != null && data?.walker_lng != null) {
          updateWalkerState(data.walker_lat, data.walker_lng, data.last_location_update, 'poll')
        } else if (!walkerLocationRef.current) {
          setQuality('none')
        }
      } catch (err) {
        dbg('poll fetch error:', err)
      }
    }

    fetchLocation()

    const channel = supabase
      .channel(`job-tracking-${jobId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'walk_requests',
          filter: `id=eq.${jobId}`,
        },
        (payload) => {
          if (cancelled) return

          const row = payload.new as {
            walker_lat?: number | null
            walker_lng?: number | null
            last_location_update?: string | null
            status?: string
          }

          if (row.status === 'completed' || row.status === 'cancelled') {
            // Freeze final walker position — stop animation loops
            if (lerpFrameRef.current) {
              cancelAnimationFrame(lerpFrameRef.current)
              lerpFrameRef.current = 0
            }
            if (routeAbortRef.current) {
              routeAbortRef.current.abort()
              routeAbortRef.current = null
            }
            setIsArrived(false)
            setEtaMinutes(null)
            prevRawEtaRef.current = null
            setQuality('none')
            setRoutePolyline([])
            return
          }

          if (row.walker_lat != null && row.walker_lng != null) {
            updateWalkerState(row.walker_lat, row.walker_lng, row.last_location_update ?? null, 'realtime')
          }
        }
      )
      .subscribe((status) => {
        dbg('realtime status:', status)
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          dbg('realtime degraded — polling is still active')
        }
      })

    const pollInterval = setInterval(() => {
      if (!cancelled) fetchLocation()
    }, POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      supabase.removeChannel(channel)
      clearInterval(pollInterval)
      if (lerpFrameRef.current) {
        cancelAnimationFrame(lerpFrameRef.current)
        lerpFrameRef.current = 0
      }
      if (routeAbortRef.current) {
        routeAbortRef.current.abort()
        routeAbortRef.current = null
      }
    }
  }, [jobId, updateWalkerState, setQuality])

  // Recompute route when user moves (if walker data exists)
  useEffect(() => {
    if (!walkerLocationRef.current || !hasRealUserLocation.current) return

    if (prevGpsQualityRef.current === 'live') {
      dbg('user moved → re-fetching OSRM route (live)')
      fetchRoute(walkerLocationRef.current)
    } else {
      // Non-live: fetch OSRM road route (falls back to straight-line)
      dbg('user moved → fetching OSRM route (non-live)')
      fetchRouteAndSetPolyline(walkerLocationRef.current)
    }
  }, [userLocation, fetchRoute, fetchRouteAndSetPolyline])

  return {
    walkerLocation,
    walkerBearing,
    userLocation,
    hasUserLocation,
    etaMinutes,
    isArrived,
    gpsQuality,
    distanceMeters,
    proximityHint,
    proximityLevel,
    routePolyline,
  }
}
