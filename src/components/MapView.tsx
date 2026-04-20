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
import { Fragment, useEffect, useMemo, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { GpsQuality, ProximityLevel } from '../hooks/useJobTracking'

interface NearbyWalkerMarker {
  id: string
  lat: number
  lng: number
  bearing: number | null
}

interface MapViewProps {
  userLocation: [number, number]
  walkerLocation?: [number, number]
  walkerBearing?: number | null
  isArrived?: boolean
  gpsQuality?: GpsQuality
  proximityLevel?: ProximityLevel
  routePolyline?: [number, number][]
  showUserMarker?: boolean
  isSearching?: boolean
  nearbyWalkers?: NearbyWalkerMarker[]
}

function FitAndFollow({
  userLocation,
  walkerLocation,
  nearbyWalkers,
  isArrived,
  proximityLevel = 'far',
}: {
  userLocation: [number, number]
  walkerLocation?: [number, number]
  nearbyWalkers: NearbyWalkerMarker[]
  isArrived: boolean
  proximityLevel?: ProximityLevel
}) {
  const map = useMap()
  const hasInitializedRef = useRef(false)
  const hasFittedTrackingRef = useRef(false)
  const hasFittedNearbyRef = useRef(false)
  const flyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const userInteractedRef = useRef(false)
  const interactTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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
    if (hasInitializedRef.current) return
    if (userLocation[0] === 32.0853 && userLocation[1] === 34.7818) return
    hasInitializedRef.current = true
    map.flyTo(userLocation, 15, { animate: true, duration: 0.8 })
  }, [userLocation, map])

  useEffect(() => {
    if (walkerLocation) {
      hasFittedNearbyRef.current = false
      return
    }

    if (nearbyWalkers.length === 0) {
      hasFittedNearbyRef.current = false
      return
    }

    if (userInteractedRef.current) return
    if (hasFittedNearbyRef.current) return

    const points: [number, number][] = [
      userLocation,
      ...nearbyWalkers.map((w) => [w.lat, w.lng] as [number, number]),
    ]

    const bounds = L.latLngBounds(points)
    hasFittedNearbyRef.current = true
    map.fitBounds(bounds, {
      padding: [40, 40],
      maxZoom: 14,
      animate: true,
    })
  }, [nearbyWalkers, userLocation, walkerLocation, map])

  useEffect(() => {
    if (!walkerLocation || isArrived) return
    if (userInteractedRef.current) return

    if (!hasFittedTrackingRef.current) {
      hasFittedTrackingRef.current = true
      const bounds = L.latLngBounds([userLocation, walkerLocation])
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 16, animate: true })
      return
    }

    if (flyTimeoutRef.current) clearTimeout(flyTimeoutRef.current)

    flyTimeoutRef.current = setTimeout(() => {
      if (userInteractedRef.current) return

      const [wLat, wLng] = walkerLocation
      const [uLat, uLng] = userLocation

      const centerLat = wLat * 0.6 + uLat * 0.4
      const centerLng = wLng * 0.6 + uLng * 0.4

      const zoom =
        proximityLevel === 'arriving' || proximityLevel === 'arrived'
          ? Math.max(map.getZoom(), 18)
          : proximityLevel === 'very_near'
            ? Math.max(map.getZoom(), 17)
            : map.getZoom()

      map.flyTo([centerLat, centerLng], zoom, {
        animate: true,
        duration: 1.2,
      })
    }, 400)

    return () => {
      if (flyTimeoutRef.current) clearTimeout(flyTimeoutRef.current)
    }
  }, [walkerLocation, userLocation, isArrived, proximityLevel, map])

  useEffect(() => {
    if (!walkerLocation) {
      hasFittedTrackingRef.current = false
    }
  }, [walkerLocation])

  return null
}

function RouteLine({ routePolyline }: { routePolyline: [number, number][] }) {
  if (!routePolyline.length) return null

  const isRealRoute = routePolyline.length > 2

  if (isRealRoute) {
    return (
      <>
        <Polyline
          positions={routePolyline}
          pathOptions={{
            color: '#0F172A',
            weight: 7,
            opacity: 0.2,
            lineCap: 'round',
            lineJoin: 'round',
          }}
        />
        <Polyline
          positions={routePolyline}
          pathOptions={{
            color: '#3B82F6',
            weight: 5,
            opacity: 0.9,
            lineCap: 'round',
            lineJoin: 'round',
          }}
        />
      </>
    )
  }

  return (
    <Polyline
      positions={routePolyline}
      pathOptions={{
        color: '#94A3B8',
        weight: 3,
        opacity: 0.6,
        dashArray: '8 6',
        lineCap: 'round',
        lineJoin: 'round',
      }}
    />
  )
}

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

let markerStyleInjected = false
function injectMarkerStyles() {
  if (markerStyleInjected) return
  markerStyleInjected = true

  const style = document.createElement('style')
  style.textContent = `
    .leaflet-marker-icon {
      overflow: visible !important;
    }

    .nearby-walker-halo {
      animation: nearbyWalkerPulse 1.8s ease-out infinite;
      transform-origin: center;
    }

    @keyframes nearbyWalkerPulse {
      0% {
        transform: scale(0.92);
        opacity: 0.55;
      }
      70% {
        transform: scale(1.18);
        opacity: 0.12;
      }
      100% {
        transform: scale(1.18);
        opacity: 0;
      }
    }
  `
  document.head.appendChild(style)
}

function createWalkerIcon(
  arrived: boolean,
  gpsQuality: GpsQuality,
  bearing: number | null,
): L.DivIcon {
  injectMarkerStyles()

  const HEAD = 22
  const STEM = 20
  const DOT = 6
  const GAP_STEM = 2
  const GAP_DOT = 1
  const TOTAL_H = HEAD + GAP_STEM + STEM + GAP_DOT + DOT

  const bg = arrived
    ? '#16A34A'
    : gpsQuality === 'offline'
      ? '#7F1D1D'
      : gpsQuality === 'delayed'
        ? '#78350F'
        : '#1F2937'

  const accent = arrived
    ? '#22C55E'
    : gpsQuality === 'offline'
      ? '#EF4444'
      : gpsQuality === 'delayed'
        ? '#F59E0B'
        : '#F97316'

  const walkingIcon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="12" cy="4.5" r="2.5" fill="#FFF"/>
    <path d="M14.5 8.5L12 9L9.5 8.5" stroke="#FFF" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    <line x1="12" y1="9" x2="12" y2="15.5" stroke="#FFF" stroke-width="1.8" stroke-linecap="round"/>
    <path d="M12 15.5L9 20.5" stroke="#FFF" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M12 15.5L15 20.5" stroke="#FFF" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M12 11.5L9 14" stroke="#FFF" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M12 11.5L15.5 13" stroke="#FFF" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`

  const arrivedIcon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#FFF" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`

  const innerIcon = arrived ? arrivedIcon : walkingIcon
  const headRotation = bearing != null && !arrived ? bearing : 0
  const headTransform =
    headRotation !== 0
      ? `transform:rotate(${headRotation}deg);transition:transform 0.6s cubic-bezier(0.4,0,0.2,1);`
      : 'transition:transform 0.6s cubic-bezier(0.4,0,0.2,1);'

  return L.divIcon({
    html: `
      <div style="
        width:${HEAD}px;
        height:${TOTAL_H}px;
        display:flex;
        flex-direction:column;
        align-items:center;
      ">
        <div style="
          width:${HEAD}px;
          height:${HEAD}px;
          border-radius:6px;
          background:${bg};
          border:2px solid ${accent};
          box-shadow:0 2px 6px rgba(0,0,0,0.14);
          display:flex;
          align-items:center;
          justify-content:center;
          ${headTransform}
        ">
          ${innerIcon}
        </div>
        <div style="
          width:2px;
          height:${STEM}px;
          background:${accent};
          margin-top:${GAP_STEM}px;
          border-radius:999px;
        "></div>
        <div style="
          width:${DOT}px;
          height:${DOT}px;
          border-radius:50%;
          background:${accent};
          margin-top:${GAP_DOT}px;
          box-shadow:0 1px 3px rgba(0,0,0,0.18);
        "></div>
      </div>
    `,
    className: '',
    iconSize: [HEAD, TOTAL_H],
    iconAnchor: [HEAD / 2, TOTAL_H],
  })
}

const USER_HEAD = 26
const USER_STEM = 28
const USER_DOT = 7
const USER_GAP_STEM = 2
const USER_GAP_DOT = 1
const USER_TOTAL_H = USER_HEAD + USER_GAP_STEM + USER_STEM + USER_GAP_DOT + USER_DOT

const userLocationIcon = L.divIcon({
  html: `<div style="
    width:${USER_HEAD}px;
    height:${USER_TOTAL_H}px;
    display:flex;
    flex-direction:column;
    align-items:center;
  ">
    <div style="
      width:${USER_HEAD}px;
      height:${USER_HEAD}px;
      border-radius:50%;
      background:#FFCD00;
      border:2px solid #FFFFFF;
      box-shadow:0 2px 6px rgba(0,0,0,0.12), 0 0 0 3px rgba(255,205,0,0.08);
      display:flex;
      align-items:center;
      justify-content:center;
    ">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="#FFFFFF" xmlns="http://www.w3.org/2000/svg">
        <circle cx="6.5" cy="4" r="2.2"/>
        <circle cx="17.5" cy="4" r="2.2"/>
        <circle cx="3.5" cy="10" r="2.2"/>
        <circle cx="20.5" cy="10" r="2.2"/>
        <path d="M12 9.5c-3.5 0-6 2-6 4.8 0 1.8 1 3.5 2.8 4.6.8.5 1.8.8 3.2.8s2.4-.3 3.2-.8c1.8-1.1 2.8-2.8 2.8-4.6 0-2.8-2.5-4.8-6-4.8z"/>
      </svg>
    </div>
    <div style="
      width:2px;
      height:${USER_STEM}px;
      background:rgba(100,116,139,0.85);
      margin-top:${USER_GAP_STEM}px;
      border-radius:999px;
    "></div>
    <div style="
      width:${USER_DOT}px;
      height:${USER_DOT}px;
      border-radius:50%;
      background:rgba(100,116,139,0.95);
      margin-top:${USER_GAP_DOT}px;
      box-shadow:0 1px 3px rgba(0,0,0,0.18);
    "></div>
  </div>`,
  className: '',
  iconSize: [USER_HEAD, USER_TOTAL_H],
  iconAnchor: [USER_HEAD / 2, USER_TOTAL_H],
})

const tooltipLabelStyle: React.CSSProperties = {
  background: 'rgba(255, 255, 255, 0.92)',
  backdropFilter: 'blur(10px)',
  WebkitBackdropFilter: 'blur(10px)',
  padding: '3px 8px',
  borderRadius: 8,
  fontSize: 10,
  fontWeight: 700,
  boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
  color: '#1E293B',
  whiteSpace: 'nowrap',
  display: 'inline-flex',
  alignItems: 'center',
  letterSpacing: 0.3,
}

function walkerTooltipBg(gpsQuality: GpsQuality, arrived: boolean): React.CSSProperties {
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
    transition: 'background 0.3s ease, opacity 0.3s ease',
  }

  if (arrived) return { ...base, background: 'rgba(22, 163, 74, 0.88)' }
  if (gpsQuality === 'offline') return { ...base, background: 'rgba(127, 29, 29, 0.82)', opacity: 0.88 }
  if (gpsQuality === 'delayed') return { ...base, background: 'rgba(120, 53, 15, 0.82)', opacity: 0.92 }
  return { ...base, background: 'rgba(15, 23, 42, 0.85)' }
}

const NB_SIZE = 22
const NB_OUTER = 30

const nearbyWalkerIcon = L.divIcon({
  html: `<div style="
    position:relative;
    width:${NB_OUTER}px;
    height:${NB_OUTER}px;
    display:flex;
    align-items:center;
    justify-content:center;
  ">
    <div class="nearby-walker-halo" style="
      position:absolute;
      width:${NB_OUTER}px;
      height:${NB_OUTER}px;
      border-radius:50%;
      background:rgba(255,205,0,0.10);
    "></div>
    <div style="
      width:${NB_SIZE}px;
      height:${NB_SIZE}px;
      border-radius:7px;
      background:#1E293B;
      border:1.5px solid rgba(255,255,255,0.12);
      box-shadow:0 2px 8px rgba(0,0,0,0.3);
      display:flex;
      align-items:center;
      justify-content:center;
    ">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="7" r="3.5" fill="rgba(255,255,255,0.6)"/>
        <path d="M12 12.5c-4 0-6 2.2-6 4.3 0 .66.54 1.2 1.2 1.2h9.6c.66 0 1.2-.54 1.2-1.2 0-2.1-2-4.3-6-4.3z" fill="rgba(255,255,255,0.6)"/>
      </svg>
    </div>
  </div>`,
  className: '',
  iconSize: [NB_OUTER, NB_OUTER],
  iconAnchor: [NB_OUTER / 2, NB_OUTER / 2],
})

function NearbyWalkerArrow({ center, bearing }: { center: [number, number]; bearing: number }) {
  const icon = useMemo(() => {
    const html = `
      <div style="
        width:18px;
        height:18px;
        transform:rotate(${bearing}deg);
        transition:transform 0.6s ease-out;
        filter:drop-shadow(0 1px 2px rgba(0,0,0,0.15));
      ">
        <svg width="18" height="18" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
          <path
            d="M10 3 L14 10 L10 8 L6 10 Z"
            fill="rgba(255,255,255,0.6)"
            stroke="rgba(255,255,255,0.8)"
            stroke-width="1"
            stroke-linejoin="round"
          />
        </svg>
      </div>
    `
    return L.divIcon({
      html,
      className: '',
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    })
  }, [bearing])

  return <Marker position={center} icon={icon} interactive={false} zIndexOffset={690} />
}

function isSamePoint(a: [number, number], b: [number, number], epsilon = 0.00002) {
  return Math.abs(a[0] - b[0]) < epsilon && Math.abs(a[1] - b[1]) < epsilon
}

export default function MapView({
  userLocation,
  walkerLocation,
  walkerBearing = null,
  isArrived = false,
  gpsQuality = 'none',
  proximityLevel = 'far',
  routePolyline = [],
  showUserMarker = true,
  isSearching = false,
  nearbyWalkers = [],
}: MapViewProps) {
  useEffect(() => {
    injectMarkerStyles()
  }, [])

  const walkerIcon = useMemo(
    () => createWalkerIcon(isArrived, gpsQuality, walkerBearing),
    [isArrived, gpsQuality, walkerBearing],
  )

  const walkerLabel = isArrived
    ? 'Arrived'
    : gpsQuality === 'offline'
      ? 'Offline'
      : gpsQuality === 'delayed'
        ? 'Delayed'
        : 'Walker'

  const WALKER_TOOLTIP_OFFSET: [number, number] = [0, -55]

  const filteredNearbyWalkers = useMemo(() => {
    if (!walkerLocation) return nearbyWalkers
    return nearbyWalkers.filter((w) => !isSamePoint([w.lat, w.lng], walkerLocation))
  }, [nearbyWalkers, walkerLocation])

  const walkerMarkerKey = walkerLocation
    ? `walker-${walkerLocation[0]}-${walkerLocation[1]}-${walkerBearing ?? 'none'}-${gpsQuality}-${isArrived ? 'arrived' : 'moving'}`
    : 'walker-none'

  return (
    <div style={{ height: '100%', overflow: 'hidden' }}>
      <MapContainer
        center={userLocation}
        zoom={15}
        zoomControl={false}
        style={{ height: '100%', width: '100%' }}
      >
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/">CARTO</a>'
          maxZoom={20}
          subdomains="abcd"
        />

        <FitAndFollow
          userLocation={userLocation}
          walkerLocation={walkerLocation}
          nearbyWalkers={filteredNearbyWalkers}
          isArrived={isArrived}
          proximityLevel={proximityLevel}
        />

        <RouteLine routePolyline={routePolyline} />

        {isSearching && !walkerLocation && (
          <>
            <CircleMarker
              center={userLocation}
              radius={25}
              className="search-radar-ring-1"
              pathOptions={{
                color: '#FFCD00',
                fillColor: '#FFCD00',
                fillOpacity: 0,
                weight: 2,
                opacity: 0,
              }}
            />
            <CircleMarker
              center={userLocation}
              radius={45}
              className="search-radar-ring-2"
              pathOptions={{
                color: '#FFCD00',
                fillColor: '#FFCD00',
                fillOpacity: 0,
                weight: 1.5,
                opacity: 0,
              }}
            />
            <CircleMarker
              center={userLocation}
              radius={65}
              className="search-radar-ring-3"
              pathOptions={{
                color: '#FFCD00',
                fillColor: '#FFCD00',
                fillOpacity: 0,
                weight: 1,
                opacity: 0,
              }}
            />
          </>
        )}

        {filteredNearbyWalkers.map((w) => (
          <Fragment key={w.id}>
            {w.bearing != null && (
              <NearbyWalkerArrow center={[w.lat, w.lng]} bearing={w.bearing} />
            )}
            <Marker
              position={[w.lat, w.lng]}
              icon={nearbyWalkerIcon}
              interactive={false}
              zIndexOffset={700}
            />
          </Fragment>
        ))}

        {showUserMarker && (
          <Marker
            position={userLocation}
            icon={userLocationIcon}
            interactive={false}
            zIndexOffset={650}
          >
            <Tooltip permanent direction="bottom" offset={[0, 8]}>
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
                You
              </div>
            </Tooltip>
          </Marker>
        )}

        {walkerLocation && (
          <>
            <AccuracyCircle center={walkerLocation} gpsQuality={gpsQuality} />

            <Marker
              key={walkerMarkerKey}
              position={walkerLocation}
              icon={walkerIcon}
              interactive={false}
              zIndexOffset={1000}
            >
              <Tooltip permanent direction="top" offset={WALKER_TOOLTIP_OFFSET}>
                <div style={walkerTooltipBg(gpsQuality, isArrived)}>
                  {walkerLabel}
                </div>
              </Tooltip>
            </Marker>
          </>
        )}
      </MapContainer>
    </div>
  )
}
