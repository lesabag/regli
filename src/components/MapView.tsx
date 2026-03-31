import {
  MapContainer,
  TileLayer,
  CircleMarker,
  Circle,
  Tooltip,
  Polyline,
  Marker,
  useMap,
} from 'react-leaflet'
import { useEffect, useMemo, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { GpsQuality, ProximityLevel } from '../hooks/useJobTracking'

interface MapViewProps {
  userLocation: [number, number]
  walkerLocation?: [number, number]
  walkerBearing?: number | null
  isArrived?: boolean
  gpsQuality?: GpsQuality
  proximityLevel?: ProximityLevel
  routePolyline?: [number, number][]
}

// ─── FitAndFollow ──────────────────────────────────────────
// First walker appearance: fitBounds. Subsequent: smooth flyTo.
// Respects manual zoom by tracking user interaction.

function FitAndFollow({
  userLocation,
  walkerLocation,
  isArrived,
  proximityLevel = 'far',
}: {
  userLocation: [number, number]
  walkerLocation?: [number, number]
  isArrived: boolean
  proximityLevel?: ProximityLevel
}) {
  const map = useMap()
  const hasInitializedRef = useRef(false)
  const hasFittedRef = useRef(false)
  const flyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const userInteractedRef = useRef(false)
  const interactTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Center on user location once on mount, before walker data arrives
  useEffect(() => {
    if (hasInitializedRef.current) return
    // Skip if still on the default location (Tel Aviv fallback)
    if (userLocation[0] === 32.0853 && userLocation[1] === 34.7818) return

    hasInitializedRef.current = true
    map.setView(userLocation, 15, { animate: false })
  }, [userLocation, map])

  // Detect manual interaction — pause auto-follow for 15s
  useEffect(() => {
    function onInteract() {
      userInteractedRef.current = true
      if (interactTimerRef.current) clearTimeout(interactTimerRef.current)
      interactTimerRef.current = setTimeout(() => {
        userInteractedRef.current = false
      }, 15_000)
    }

    map.on('dragstart', onInteract)
    map.on('zoomstart', onInteract)

    return () => {
      map.off('dragstart', onInteract)
      map.off('zoomstart', onInteract)
      if (interactTimerRef.current) clearTimeout(interactTimerRef.current)
    }
  }, [map])

  useEffect(() => {
    if (!walkerLocation || isArrived) return
    if (userInteractedRef.current) return

    // First time: fitBounds
    if (!hasFittedRef.current) {
      hasFittedRef.current = true
      const bounds = L.latLngBounds([userLocation, walkerLocation])
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 16, animate: true })
      return
    }

    // Subsequent: debounced flyTo weighted center
    if (flyTimeoutRef.current) clearTimeout(flyTimeoutRef.current)

    flyTimeoutRef.current = setTimeout(() => {
      if (userInteractedRef.current) return

      const [wLat, wLng] = walkerLocation
      const [uLat, uLng] = userLocation

      const centerLat = wLat * 0.6 + uLat * 0.4
      const centerLng = wLng * 0.6 + uLng * 0.4

      // Tighten zoom when walker is close
      const zoom = proximityLevel === 'arriving' || proximityLevel === 'arrived'
        ? Math.max(map.getZoom(), 18)
        : proximityLevel === 'very_near'
        ? Math.max(map.getZoom(), 17)
        : map.getZoom()

      map.flyTo([centerLat, centerLng], zoom, {
        animate: true,
        duration: 1.0,
      })
    }, 400)

    return () => {
      if (flyTimeoutRef.current) clearTimeout(flyTimeoutRef.current)
    }
  }, [walkerLocation, userLocation, isArrived, proximityLevel, map])

  // Reset fit flag when walker disappears
  useEffect(() => {
    if (!walkerLocation) {
      hasFittedRef.current = false
    }
  }, [walkerLocation])

  return null
}

// ─── RouteLine ─────────────────────────────────────────────
// Renders the route polyline passed down from the hook (Mapbox Directions).
// No longer fetches its own route — the hook handles all routing logic.

function RouteLine({ routePolyline }: { routePolyline: [number, number][] }) {
  if (!routePolyline.length) return null

  return (
    <Polyline
      positions={routePolyline}
      pathOptions={{
        color: '#001A33',
        weight: 5,
        opacity: 0.7,
        dashArray: '12 6',
        lineCap: 'round',
        lineJoin: 'round',
      }}
    />
  )
}

// ─── AccuracyCircle ────────────────────────────────────────

function AccuracyCircle({
  center,
  gpsQuality,
}: {
  center: [number, number]
  gpsQuality: GpsQuality
}) {
  if (gpsQuality === 'live' || gpsQuality === 'none') return null

  const radius = gpsQuality === 'offline' ? 100 : gpsQuality === 'delayed' ? 50 : 30
  const color = gpsQuality === 'offline' ? '#EF4444' : '#F59E0B'

  return (
    <Circle
      center={center}
      radius={radius}
      pathOptions={{
        color,
        fillColor: color,
        fillOpacity: 0.08,
        weight: 1.5,
        dashArray: '6 4',
        opacity: 0.5,
      }}
    />
  )
}

// ─── WalkerHeading ────────────────────────────────────────
// Shows a subtle directional chevron ahead of the walker dot.

function WalkerHeading({
  center,
  bearing,
  color,
}: {
  center: [number, number]
  bearing: number
  color: string
}) {
  const icon = useMemo(() => {
    // Small chevron SVG rotated to bearing. CSS rotation is clockwise from north (top).
    const svg = `
      <svg width="22" height="22" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg"
           style="transform:rotate(${bearing}deg)">
        <path d="M11 3 L16 12 L11 9.5 L6 12 Z"
              fill="${color}" fill-opacity="0.55" stroke="${color}" stroke-width="0.5" stroke-opacity="0.3"/>
      </svg>`
    return L.divIcon({
      html: svg,
      className: '',
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    })
  }, [bearing, color])

  return <Marker position={center} icon={icon} interactive={false} />
}

// ─── Tooltip styles ────────────────────────────────────────

const tooltipLabelStyle: React.CSSProperties = {
  background: 'rgba(255, 255, 255, 0.82)',
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
  padding: '2px 7px',
  borderRadius: 6,
  fontSize: 10,
  fontWeight: 600,
  boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
  color: '#1E293B',
  whiteSpace: 'nowrap',
  display: 'inline-flex',
  alignItems: 'center',
  letterSpacing: 0.2,
}

function walkerTooltipBg(gpsQuality: GpsQuality): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: '2px 8px',
    borderRadius: 6,
    fontSize: 10,
    fontWeight: 600,
    boxShadow: '0 1px 4px rgba(0,0,0,0.12)',
    color: '#FFFFFF',
    whiteSpace: 'nowrap',
    letterSpacing: 0.3,
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
  }

  if (gpsQuality === 'offline') {
    return { ...base, background: 'rgba(127, 29, 29, 0.82)', opacity: 0.88 }
  }
  if (gpsQuality === 'delayed') {
    return { ...base, background: 'rgba(120, 53, 15, 0.82)', opacity: 0.92 }
  }
  return { ...base, background: 'rgba(15, 23, 42, 0.78)' }
}

// ─── MapView ───────────────────────────────────────────────

export default function MapView({
  userLocation,
  walkerLocation,
  walkerBearing = null,
  isArrived = false,
  gpsQuality = 'none',
  proximityLevel = 'far',
  routePolyline = [],
}: MapViewProps) {
  const walkerColor = isArrived
    ? '#16A34A'
    : gpsQuality === 'offline'
    ? '#EF4444'
    : gpsQuality === 'delayed'
    ? '#F59E0B'
    : '#FFCD00'

  const walkerLabel = isArrived
    ? 'Arrived'
    : gpsQuality === 'offline'
    ? 'Offline'
    : gpsQuality === 'delayed'
    ? 'Delayed'
    : 'Walker'

  return (
    <div style={{ height: '100%', minHeight: 300, borderRadius: 16, overflow: 'hidden' }}>
      <MapContainer
        center={userLocation}
        zoom={15}
        style={{ height: '100%', width: '100%' }}
      >
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />

        <FitAndFollow
          userLocation={userLocation}
          walkerLocation={walkerLocation}
          isArrived={isArrived}
          proximityLevel={proximityLevel}
        />

        <RouteLine routePolyline={routePolyline} />

        {/* User marker */}
        <CircleMarker
          center={userLocation}
          radius={7}
          pathOptions={{
            color: '#FFFFFF',
            weight: 3,
            fillColor: '#3B82F6',
            fillOpacity: 1,
          }}
        >
          <Tooltip permanent direction="bottom" offset={[0, 12]}>
            <div style={tooltipLabelStyle}>
              <svg
                width="9"
                height="9"
                viewBox="0 0 512 512"
                fill="#475569"
                style={{ marginRight: 3, flexShrink: 0 }}
              >
                <path d="M226.5 92.9c14.3 42.9-.3 86.2-32.6 96.8s-70.1-15.6-84.4-58.5s.3-86.2 32.6-96.8s70.1 15.6 84.4 58.5zM100.4 198.6c18.9 32.4 14.3 70.1-10.2 84.1s-59.7-.9-78.5-33.3S-2.7 179.3 21.8 165.3s59.7.9 78.5 33.3zM69.2 401.2C121.6 259.9 214.7 224 256 224s134.4 35.9 186.8 177.2c3.6 9.7 5.2 20.1 5.2 30.5v1.6c0 25.8-20.9 46.7-46.7 46.7c-11.5 0-22.9-1.4-34-4.2l-88-22c-15.3-3.8-31.3-3.8-46.6 0l-88 22c-11.1 2.8-22.5 4.2-34 4.2C84.9 480 64 459.1 64 433.3v-1.6c0-10.4 1.6-20.8 5.2-30.5zM421.8 282.7c-24.5-14-29.1-51.7-10.2-84.1s54-47.3 78.5-33.3s29.1 51.7 10.2 84.1s-54 47.3-78.5 33.3zM310.1 189.7c-32.3-10.6-46.9-53.9-32.6-96.8s52.1-69.1 84.4-58.5s46.9 53.9 32.6 96.8s-52.1 69.1-84.4 58.5z" />
              </svg>
              Dogi
            </div>
          </Tooltip>
        </CircleMarker>

        {/* Walker marker */}
        {walkerLocation && (
          <>
            {/* Accuracy circle for degraded states */}
            <AccuracyCircle center={walkerLocation} gpsQuality={gpsQuality} />

            {/* Directional heading indicator */}
            {walkerBearing != null && !isArrived && gpsQuality === 'live' && (
              <WalkerHeading center={walkerLocation} bearing={walkerBearing} color={walkerColor} />
            )}

            {/* Outer pulse ring — grows for close proximity */}
            <CircleMarker
              center={walkerLocation}
              radius={
                isArrived ? 22
                : proximityLevel === 'arriving' ? 22
                : proximityLevel === 'very_near' ? 20
                : 18
              }
              pathOptions={{
                color: walkerColor,
                fillColor: walkerColor,
                fillOpacity: proximityLevel === 'arriving' || proximityLevel === 'very_near' ? 0.22 : 0.15,
                weight: proximityLevel === 'arriving' || proximityLevel === 'very_near' ? 2 : 1,
              }}
              className={
                proximityLevel === 'arriving' ? 'walker-pulse-strong'
                : proximityLevel === 'very_near' ? 'walker-pulse'
                : undefined
              }
            />

            {/* Inner solid dot — slightly larger when close */}
            <CircleMarker
              center={walkerLocation}
              radius={proximityLevel === 'arriving' || proximityLevel === 'arrived' ? 10 : proximityLevel === 'very_near' ? 9 : 8}
              pathOptions={{
                color: '#FFFFFF',
                weight: 3,
                fillColor: walkerColor,
                fillOpacity: 1,
              }}
            >
              <Tooltip permanent direction="top" offset={[0, -14]}>
                <div style={walkerTooltipBg(gpsQuality)}>
                  {walkerLabel}
                </div>
              </Tooltip>
            </CircleMarker>
          </>
        )}
      </MapContainer>
    </div>
  )
}
