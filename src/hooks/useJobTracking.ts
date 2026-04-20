import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../services/supabaseClient'

export type GpsQuality = 'live' | 'delayed' | 'offline' | 'none'
export type ProximityLevel = 'far' | 'near' | 'very_near' | 'arriving' | 'arrived'

interface WalkTrackingRow {
  walker_lat: number | null
  walker_lng: number | null
  last_location_update: string | null
  status: string | null
  booking_timing: 'asap' | 'scheduled' | null
  dispatch_state: 'queued' | 'dispatched' | 'expired' | 'cancelled' | null
}

const DEFAULT_LOCATION: [number, number] = [32.0853, 34.7818]
const WALKING_SPEED_MPS = 1.3
const ARRIVED_METERS = 18
const ARRIVING_METERS = 45
const VERY_NEAR_METERS = 120
const NEAR_METERS = 350

function haversineMeters(a: [number, number], b: [number, number]): number {
  const R = 6371000
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(b[0] - a[0])
  const dLng = toRad(b[1] - a[1])
  const lat1 = toRad(a[0])
  const lat2 = toRad(b[0])

  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2)

  return 2 * R * Math.asin(Math.sqrt(h))
}

function computeBearing(from: [number, number], to: [number, number]): number {
  const lat1 = (from[0] * Math.PI) / 180
  const lat2 = (to[0] * Math.PI) / 180
  const dLng = ((to[1] - from[1]) * Math.PI) / 180

  const y = Math.sin(dLng) * Math.cos(lat2)
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng)

  const brng = (Math.atan2(y, x) * 180) / Math.PI
  return (brng + 360) % 360
}

function classifyGpsQuality(lastLocationUpdate: string | null): GpsQuality {
  if (!lastLocationUpdate) return 'none'
  const ts = new Date(lastLocationUpdate).getTime()
  if (Number.isNaN(ts)) return 'none'
  const age = Date.now() - ts
  if (age <= 20_000) return 'live'
  if (age <= 90_000) return 'delayed'
  return 'offline'
}

function classifyProximity(distanceMeters: number | null): ProximityLevel {
  if (distanceMeters == null) return 'far'
  if (distanceMeters <= ARRIVED_METERS) return 'arrived'
  if (distanceMeters <= ARRIVING_METERS) return 'arriving'
  if (distanceMeters <= VERY_NEAR_METERS) return 'very_near'
  if (distanceMeters <= NEAR_METERS) return 'near'
  return 'far'
}

function straightLine(from: [number, number], to: [number, number]): [number, number][] {
  return [from, to]
}

export function useJobTracking(jobId: string | null) {
  const [rawWalkerLocation, setRawWalkerLocation] = useState<[number, number] | null>(null)
  const [displayWalkerLocation, setDisplayWalkerLocation] = useState<[number, number] | null>(null)
  const [walkerBearing, setWalkerBearing] = useState<number | null>(null)
  const [userLocation, setUserLocation] = useState<[number, number]>(DEFAULT_LOCATION)
  const [hasUserLocation, setHasUserLocation] = useState(false)
  const [gpsQuality, setGpsQuality] = useState<GpsQuality>('none')
  const [routePolyline, setRoutePolyline] = useState<[number, number][]>([])

  const lastLocationRef = useRef<[number, number] | null>(null)
  const animationRef = useRef<number | null>(null)
  const routeAbortRef = useRef<AbortController | null>(null)
  const countdownBaseRef = useRef<{ startedAt: number; totalSeconds: number } | null>(null)
  const [countdownTick, setCountdownTick] = useState(0)

  const resetAll = () => {
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current)
      animationRef.current = null
    }
    if (routeAbortRef.current) {
      routeAbortRef.current.abort()
      routeAbortRef.current = null
    }
    lastLocationRef.current = null
    countdownBaseRef.current = null
    setRawWalkerLocation(null)
    setDisplayWalkerLocation(null)
    setWalkerBearing(null)
    setGpsQuality('none')
    setRoutePolyline([])
  }

  function smoothMove(from: [number, number], to: [number, number]) {
    if (animationRef.current) cancelAnimationFrame(animationRef.current)

    const duration = 1200
    const start = performance.now()

    const frame = (now: number) => {
      const t = Math.min((now - start) / duration, 1)
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2

      const lat = from[0] + (to[0] - from[0]) * eased
      const lng = from[1] + (to[1] - from[1]) * eased
      setDisplayWalkerLocation([lat, lng])

      if (t < 1) animationRef.current = requestAnimationFrame(frame)
    }

    animationRef.current = requestAnimationFrame(frame)
  }

  useEffect(() => {
    if (!navigator.geolocation) return

    let watchId: number | null = null
    let cancelled = false

    const onSuccess = (pos: GeolocationPosition) => {
      if (cancelled) return
      setUserLocation([pos.coords.latitude, pos.coords.longitude])
      setHasUserLocation(true)
    }

    const onError = () => {
      if (cancelled) return
      setHasUserLocation(false)
    }

    navigator.geolocation.getCurrentPosition(onSuccess, onError, {
      enableHighAccuracy: false,
      maximumAge: 60_000,
      timeout: 8_000,
    })

    watchId = navigator.geolocation.watchPosition(onSuccess, onError, {
      enableHighAccuracy: true,
      maximumAge: 10_000,
      timeout: 15_000,
    })

    return () => {
      cancelled = true
      if (watchId != null) navigator.geolocation.clearWatch(watchId)
    }
  }, [])

  useEffect(() => {
    if (!jobId) {
      resetAll()
      return
    }

    let cancelled = false

    const applyRow = (row: WalkTrackingRow | null | undefined) => {
      if (cancelled || !row) return

      setGpsQuality(classifyGpsQuality(row.last_location_update))

      if (row.status && row.status !== 'accepted') {
        resetAll()
        return
      }

      if (row.booking_timing === 'scheduled' && row.dispatch_state !== 'dispatched') {
        resetAll()
        return
      }

      if (row.walker_lat == null || row.walker_lng == null) {
        setRawWalkerLocation(null)
        setDisplayWalkerLocation(null)
        setRoutePolyline([])
        return
      }

      const nextLoc: [number, number] = [row.walker_lat, row.walker_lng]

      if (lastLocationRef.current) {
        setWalkerBearing(computeBearing(lastLocationRef.current, nextLoc))
        smoothMove(lastLocationRef.current, nextLoc)
      } else {
        setDisplayWalkerLocation(nextLoc)
      }

      lastLocationRef.current = nextLoc
      setRawWalkerLocation(nextLoc)
    }

    const fetchLatest = async () => {
      const { data } = await supabase
        .from('walk_requests')
        .select('walker_lat, walker_lng, last_location_update, status, booking_timing, dispatch_state')
        .eq('id', jobId)
        .maybeSingle()

      applyRow((data as WalkTrackingRow | null) ?? null)
    }

    void fetchLatest()

    const channel = supabase
      .channel(`tracking-${jobId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'walk_requests',
          filter: `id=eq.${jobId}`,
        },
        (payload) => {
          const row = (payload.new ?? null) as WalkTrackingRow | null
          applyRow(row)
        },
      )
      .subscribe()

    const pollId = window.setInterval(() => {
      void fetchLatest()
    }, 5000)

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void fetchLatest()
      }
    }

    const onFocus = () => {
      void fetchLatest()
    }

    window.addEventListener('focus', onFocus)
    window.addEventListener('pageshow', onFocus)
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelled = true
      window.clearInterval(pollId)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('pageshow', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
      supabase.removeChannel(channel)
      resetAll()
    }
  }, [jobId])

  const distanceMeters = useMemo(() => {
    if (!hasUserLocation || !displayWalkerLocation) return null
    return haversineMeters(userLocation, displayWalkerLocation)
  }, [displayWalkerLocation, hasUserLocation, userLocation])

  const proximityLevel = useMemo(
    () => classifyProximity(distanceMeters),
    [distanceMeters],
  )

  const isArrived = proximityLevel === 'arrived'

  const etaTotalSeconds = useMemo(() => {
    if (distanceMeters == null) return null
    if (distanceMeters <= ARRIVED_METERS) return 0
    return Math.max(60, Math.ceil(distanceMeters / WALKING_SPEED_MPS))
  }, [distanceMeters])

  useEffect(() => {
    if (etaTotalSeconds == null) {
      countdownBaseRef.current = null
      setCountdownTick(0)
      return
    }

    countdownBaseRef.current = {
      startedAt: Date.now(),
      totalSeconds: etaTotalSeconds,
    }
    setCountdownTick(0)
  }, [etaTotalSeconds, rawWalkerLocation?.[0], rawWalkerLocation?.[1], userLocation[0], userLocation[1]])

  useEffect(() => {
    const id = window.setInterval(() => setCountdownTick((v) => v + 1), 1000)
    return () => window.clearInterval(id)
  }, [])

  const displayEtaSeconds = useMemo(() => {
    const base = countdownBaseRef.current
    if (!base) return null
    const elapsed = Math.floor((Date.now() - base.startedAt) / 1000)
    return Math.max(0, base.totalSeconds - elapsed)
  }, [countdownTick])

  const etaMinutes = useMemo(() => {
    if (displayEtaSeconds == null) return null
    return Math.max(0, Math.ceil(displayEtaSeconds / 60))
  }, [displayEtaSeconds])

  useEffect(() => {
    if (!hasUserLocation || !rawWalkerLocation || !jobId) {
      setRoutePolyline([])
      return
    }

    if (isArrived) {
      setRoutePolyline(straightLine(rawWalkerLocation, userLocation))
      return
    }

    routeAbortRef.current?.abort()
    const controller = new AbortController()
    routeAbortRef.current = controller

    const [fromLat, fromLng] = rawWalkerLocation
    const [toLat, toLng] = userLocation

    const fallback = straightLine(rawWalkerLocation, userLocation)

    fetch(
      `https://router.project-osrm.org/route/v1/foot/${fromLng},${fromLat};${toLng},${toLat}?overview=full&geometries=geojson`,
      { signal: controller.signal },
    )
      .then(async (res) => {
        if (!res.ok) throw new Error(`route ${res.status}`)
        const data = (await res.json()) as {
          routes?: Array<{ geometry?: { coordinates?: number[][] } }>
        }
        const coords = data.routes?.[0]?.geometry?.coordinates ?? []
        if (!coords.length) {
          setRoutePolyline(fallback)
          return
        }
        const poly = coords
          .filter((pair): pair is number[] => Array.isArray(pair) && pair.length >= 2)
          .map((pair) => [pair[1], pair[0]] as [number, number])
        setRoutePolyline(poly.length ? poly : fallback)
      })
      .catch(() => {
        if (!controller.signal.aborted) setRoutePolyline(fallback)
      })

    return () => controller.abort()
  }, [hasUserLocation, rawWalkerLocation, userLocation, jobId, isArrived])

  return {
    walkerLocation: displayWalkerLocation ?? rawWalkerLocation,
    walkerBearing,
    userLocation,
    hasUserLocation,
    etaMinutes,
    displayEtaSeconds,
    isArrived,
    gpsQuality,
    distanceMeters,
    proximityLevel,
    routePolyline,
  }
}
