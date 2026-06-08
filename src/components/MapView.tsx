import {
  MapContainer,
  TileLayer,
  Circle,
  Tooltip,
  Polyline,
  Marker,
  useMap,
  useMapEvents,
} from 'react-leaflet'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { GpsQuality, ProximityLevel } from '../hooks/useJobTracking'
import { getAvatarInitials, resolveAvatarImageUrl } from '../utils/avatarImage'

interface NearbyWalkerMarker {
  id: string
  lat: number
  lng: number
  bearing: number | null
  avatarUrl?: string | null
  fullName?: string | null
  rating?: number | null
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
  bottomViewportPadding?: number
  onRecenter?: () => void
}

function RecenterControl({
  userLocation,
  bottomViewportPadding,
  onRecenter,
}: {
  userLocation: [number, number]
  bottomViewportPadding: number
  onRecenter?: () => void
}) {
  const map = useMap()

  const handleClick = useCallback(() => {
    if (onRecenter) onRecenter()

    const projectedPoint = map.project(userLocation, 15)
    const adjustedCenter = map.unproject(
      L.point(projectedPoint.x, projectedPoint.y + Math.max(0, bottomViewportPadding) / 2),
      15,
    )
    map.flyTo([adjustedCenter.lat, adjustedCenter.lng], 15, {
      animate: true,
      duration: 0.6,
    })
  }, [map, userLocation, bottomViewportPadding, onRecenter])

  return (
    <div style={recenterBtnStyle} onClick={handleClick} role="button" tabIndex={0}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#334155" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <line x1="12" y1="2" x2="12" y2="5" />
        <line x1="12" y1="19" x2="12" y2="22" />
        <line x1="2" y1="12" x2="5" y2="12" />
        <line x1="19" y1="12" x2="22" y2="12" />
      </svg>
    </div>
  )
}

function FitAndFollow({
  userLocation,
  walkerLocation,
  nearbyWalkers,
  isArrived,
  proximityLevel = 'far',
  bottomViewportPadding = 0,
  routePolyline = [],
}: {
  userLocation: [number, number]
  walkerLocation?: [number, number]
  nearbyWalkers: NearbyWalkerMarker[]
  isArrived: boolean
  proximityLevel?: ProximityLevel
  bottomViewportPadding?: number
  routePolyline?: [number, number][]
}) {
  const map = useMap()
  const hasInitializedRef = useRef(false)
  const hasFittedTrackingRef = useRef(false)
  const hasFittedNearbyRef = useRef(false)
  const flyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const userInteractedRef = useRef(false)
  const interactTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const getViewportAdjustedCenter = (
    target: [number, number],
    verticalPadding: number,
    zoom = map.getZoom(),
  ): [number, number] => {
    const projectedPoint = map.project(target, zoom)
    const adjustedCenter = map.unproject(
      L.point(projectedPoint.x, projectedPoint.y + Math.max(0, verticalPadding) / 2),
      zoom,
    )
    return [adjustedCenter.lat, adjustedCenter.lng]
  }

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
    map.flyTo(getViewportAdjustedCenter(userLocation, bottomViewportPadding, 15), 15, {
      animate: true,
      duration: 0.8,
    })
  }, [bottomViewportPadding, map, userLocation])

  useEffect(() => {
    if (!hasInitializedRef.current) return
    if (walkerLocation || nearbyWalkers.length > 0) return
    if (userInteractedRef.current) return
    const adjustedCenter = getViewportAdjustedCenter(userLocation, bottomViewportPadding)
    map.flyTo(adjustedCenter, map.getZoom(), {
      animate: true,
      duration: 0.45,
    })
  }, [bottomViewportPadding, map, nearbyWalkers.length, userLocation, walkerLocation])

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
      paddingTopLeft: [40, 40],
      paddingBottomRight: [40, Math.max(40, bottomViewportPadding)],
      maxZoom: 14,
      animate: true,
    })
  }, [bottomViewportPadding, nearbyWalkers, userLocation, walkerLocation, map])

  useEffect(() => {
    if (!walkerLocation || isArrived) return
    if (userInteractedRef.current) return

    const boundsPoints: [number, number][] = [userLocation, walkerLocation]
    if (routePolyline.length > 0) {
      boundsPoints.push(...routePolyline)
    }

    if (!hasFittedTrackingRef.current) {
      hasFittedTrackingRef.current = true
      const bounds = L.latLngBounds(boundsPoints)
      map.fitBounds(bounds, {
        paddingTopLeft: [50, 50],
        paddingBottomRight: [50, Math.max(50, bottomViewportPadding)],
        maxZoom: 16,
        animate: true,
      })
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

      map.flyTo(getViewportAdjustedCenter([centerLat, centerLng], bottomViewportPadding, zoom), zoom, {
        animate: true,
        duration: 1.2,
      })
    }, 400)

    return () => {
      if (flyTimeoutRef.current) clearTimeout(flyTimeoutRef.current)
    }
  }, [bottomViewportPadding, walkerLocation, userLocation, isArrived, proximityLevel, map, routePolyline])

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

    .searching-map-mode {
      background: #0b1220;
    }

    .searching-map-mode .leaflet-tile {
      filter: brightness(0.64) saturate(0.82) contrast(0.94);
      transition: filter 180ms ease;
    }

    .search-radar-wrap {
      position: relative;
      width: 132px;
      height: 132px;
      pointer-events: none;
    }

    .search-radar-core-glow {
      position: absolute;
      inset: 38px;
      border-radius: 999px;
      background: radial-gradient(circle, rgba(59,130,246,0.22) 0%, rgba(59,130,246,0.10) 52%, rgba(59,130,246,0) 78%);
      filter: blur(1px);
    }

    .search-radar-orbit,
    .search-radar-ring {
      position: absolute;
      inset: 0;
      border-radius: 999px;
      border: 1px solid rgba(96,165,250,0.20);
      box-sizing: border-box;
      transform-origin: center;
    }

    .search-radar-orbit.orbit-2 {
      inset: 16px;
      border-color: rgba(96,165,250,0.18);
    }

    .search-radar-orbit.orbit-3 {
      inset: 32px;
      border-color: rgba(16,185,129,0.16);
    }

    .search-radar-ring.ring-1 {
      animation: searchRadarPulse 2.9s ease-out infinite;
    }

    .search-radar-ring.ring-2 {
      animation: searchRadarPulse 2.9s ease-out infinite 0.95s;
    }

    .search-radar-ring.ring-3 {
      animation: searchRadarPulse 2.9s ease-out infinite 1.9s;
    }

    .search-radar-sweep {
      position: absolute;
      inset: 0;
      border-radius: 999px;
      background: conic-gradient(
        from 0deg,
        rgba(59,130,246,0) 0deg,
        rgba(59,130,246,0.00) 280deg,
        rgba(96,165,250,0.08) 314deg,
        rgba(96,165,250,0.26) 336deg,
        rgba(16,185,129,0.14) 350deg,
        rgba(59,130,246,0) 360deg
      );
      mask: radial-gradient(circle, transparent 0 33px, #000 34px);
      -webkit-mask: radial-gradient(circle, transparent 0 33px, #000 34px);
      animation: searchRadarSweepRotate 5.4s linear infinite;
      opacity: 0.9;
    }

    .nearby-walker-halo {
      animation: nearbyWalkerPulse 1.8s ease-out infinite;
      transform-origin: center;
    }

    @keyframes searchRadarPulse {
      0% {
        transform: scale(0.72);
        opacity: 0.32;
      }
      55% {
        opacity: 0.18;
      }
      100% {
        transform: scale(1.14);
        opacity: 0;
      }
    }

    @keyframes searchRadarSweepRotate {
      0% {
        transform: rotate(0deg);
      }
      100% {
        transform: rotate(360deg);
      }
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

    .client-marker-pin {
      animation: clientMarkerAppear 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) both;
    }

    @keyframes clientMarkerAppear {
      0% {
        transform: scale(0) translateY(8px);
        opacity: 0;
      }
      100% {
        transform: scale(1) translateY(0);
        opacity: 1;
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

const USER_HEAD = 18
const USER_STEM = 14
const USER_DOT = 5
const USER_GAP_STEM = 2
const USER_GAP_DOT = 1
const USER_TOTAL_H = USER_HEAD + USER_GAP_STEM + USER_STEM + USER_GAP_DOT + USER_DOT

const userLocationIcon = L.divIcon({
  html: `<div class="client-marker-pin" style="
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
      background:#3B82F6;
      border:3px solid #FFFFFF;
      box-shadow:0 2px 8px rgba(0,0,0,0.18);
    "></div>
    <div style="
      width:2px;
      height:${USER_STEM}px;
      background:#3B82F6;
      margin-top:${USER_GAP_STEM}px;
      border-radius:999px;
    "></div>
    <div style="
      width:${USER_DOT}px;
      height:${USER_DOT}px;
      border-radius:50%;
      background:#3B82F6;
      margin-top:${USER_GAP_DOT}px;
      box-shadow:0 1px 3px rgba(0,0,0,0.15);
    "></div>
  </div>`,
  className: '',
  iconSize: [USER_HEAD, USER_TOTAL_H],
  iconAnchor: [USER_HEAD / 2, USER_TOTAL_H],
})

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

const NB_SIZE = 28
const NB_OUTER = 38
const NB_DOT = 10

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function getMarkerAvatarUrl(url: string | null | undefined): string | null {
  return resolveAvatarImageUrl(url, { size: 96 })
}

function createNearbyWalkerAvatarIcon(params: {
  avatarUrl: string | null | undefined
  fallbackName?: string | null
  previewName?: string | null
  previewMeta?: string | null
  selected?: boolean
}): L.DivIcon {
  const { avatarUrl, fallbackName = null, previewName = null, previewMeta = null, selected = false } = params
  const resolvedAvatarUrl = getMarkerAvatarUrl(avatarUrl)
  const safePreviewName = previewName ? escapeHtmlAttribute(previewName.trim() || 'Provider') : 'Provider'
  const safePreviewMeta = previewMeta ? escapeHtmlAttribute(previewMeta) : ''
  const safeInitials = escapeHtmlAttribute(getAvatarInitials(fallbackName || previewName))
  const hasPreview = selected && (!!safePreviewName || !!safePreviewMeta)
  const previewBubbleHeight = hasPreview ? (safePreviewMeta ? 50 : 36) : 0
  const previewGap = hasPreview ? 6 : 0
  const totalHeight = previewBubbleHeight + previewGap + NB_OUTER

  if (!resolvedAvatarUrl) {
    if (!hasPreview) return nearbyWalkerIcon
    return L.divIcon({
      html: `<div style="
        position:relative;
        width:220px;
        height:${totalHeight}px;
        display:flex;
        align-items:flex-end;
        justify-content:center;
      ">
        <div style="
          position:absolute;
          left:50%;
          top:0;
          transform:translateX(-50%);
          min-width:98px;
          max-width:200px;
          padding:8px 11px;
          border-radius:16px;
          background:rgba(15,23,42,0.72);
          border:1px solid rgba(255,255,255,0.14);
          box-shadow:0 14px 30px rgba(15,23,42,0.22);
          backdrop-filter:blur(16px) saturate(1.05);
          -webkit-backdrop-filter:blur(16px) saturate(1.05);
          color:#fff;
          text-align:center;
          box-sizing:border-box;
          white-space:nowrap;
        ">
          <div style="font-size:12px;line-height:1.15;font-weight:900;overflow:hidden;text-overflow:ellipsis;">${safePreviewName}</div>
          ${safePreviewMeta ? `<div style="margin-top:3px;font-size:10.5px;line-height:1.15;font-weight:800;color:rgba(255,255,255,0.9);overflow:hidden;text-overflow:ellipsis;">${safePreviewMeta}</div>` : ''}
          <div style="
            position:absolute;
            left:50%;
            bottom:-6px;
            width:12px;
            height:12px;
            border-radius:3px;
            transform:translateX(-50%) rotate(45deg);
            background:rgba(15,23,42,0.72);
            border-right:1px solid rgba(255,255,255,0.10);
            border-bottom:1px solid rgba(255,255,255,0.10);
          "></div>
        </div>
        ${nearbyWalkerIcon.options.html}
      </div>`,
      className: '',
      iconSize: [220, totalHeight],
      iconAnchor: [110, totalHeight - (NB_OUTER / 2)],
    })
  }

  const safeUrl = escapeHtmlAttribute(resolvedAvatarUrl)
  const safeFallbackScriptUrl = safeUrl
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'")

  return L.divIcon({
    html: `<div style="
      position:relative;
      width:220px;
      height:${totalHeight}px;
      display:flex;
      align-items:flex-end;
      justify-content:center;
    ">
      ${hasPreview ? `
        <div style="
          position:absolute;
          left:50%;
          top:0;
          transform:translateX(-50%);
          min-width:98px;
          max-width:200px;
          padding:8px 11px;
          border-radius:16px;
          background:rgba(15,23,42,0.72);
          border:1px solid rgba(255,255,255,0.14);
          box-shadow:0 14px 30px rgba(15,23,42,0.22);
          backdrop-filter:blur(16px) saturate(1.05);
          -webkit-backdrop-filter:blur(16px) saturate(1.05);
          color:#fff;
          text-align:center;
          box-sizing:border-box;
          white-space:nowrap;
        ">
          <div style="font-size:12px;line-height:1.15;font-weight:900;overflow:hidden;text-overflow:ellipsis;">${safePreviewName}</div>
          ${safePreviewMeta ? `<div style="margin-top:3px;font-size:10.5px;line-height:1.15;font-weight:800;color:rgba(255,255,255,0.9);overflow:hidden;text-overflow:ellipsis;">${safePreviewMeta}</div>` : ''}
          <div style="
            position:absolute;
            left:50%;
            bottom:-6px;
            width:12px;
            height:12px;
            border-radius:3px;
            transform:translateX(-50%) rotate(45deg);
            background:rgba(15,23,42,0.72);
            border-right:1px solid rgba(255,255,255,0.10);
            border-bottom:1px solid rgba(255,255,255,0.10);
          "></div>
        </div>
      ` : ''}
      <div class="nearby-walker-halo" style="
        position:absolute;
        left:50%;
        bottom:0;
        transform:translateX(-50%);
        width:${NB_OUTER}px;
        height:${NB_OUTER}px;
        border-radius:50%;
        background:rgba(59,130,246,0.12);
      "></div>
      <div style="
        position:relative;
        width:${NB_OUTER}px;
        height:${NB_OUTER}px;
        display:flex;
        align-items:center;
        justify-content:center;
      ">
        <div style="
          position:relative;
          width:${NB_SIZE}px;
          height:${NB_SIZE}px;
          border-radius:50%;
          overflow:hidden;
          background:#E2E8F0;
          border:2px solid #FFFFFF;
          box-shadow:0 6px 14px rgba(15,23,42,0.22);
        ">
          <div
            data-fallback="true"
            style="
              position:absolute;
              inset:0;
              display:none;
              align-items:center;
              justify-content:center;
              background:linear-gradient(180deg, #E2E8F0 0%, #CBD5E1 100%);
              color:#334155;
              font-size:10px;
              font-weight:900;
              letter-spacing:0.04em;
            "
          >${safeInitials}</div>
          <img
            src="${safeUrl}"
            alt=""
            draggable="false"
            onerror="this.onerror=null; this.style.display='none'; var fallback=this.parentNode && this.parentNode.querySelector('[data-fallback=true]'); if (fallback) { fallback.style.display='flex'; } window.__regliBrokenAvatarUrls = window.__regliBrokenAvatarUrls || {}; window.__regliBrokenAvatarUrls['${safeFallbackScriptUrl}']=true;"
            style="
              width:100%;
              height:100%;
              object-fit:cover;
              display:block;
            "
          />
        </div>
        <div style="
          position:absolute;
          right:2px;
          bottom:2px;
          width:${NB_DOT}px;
          height:${NB_DOT}px;
          border-radius:50%;
          background:#22C55E;
          border:2px solid #FFFFFF;
          box-shadow:0 2px 5px rgba(15,23,42,0.18);
        "></div>
      </div>
    </div>`,
    className: '',
    iconSize: [220, totalHeight],
    iconAnchor: [110, totalHeight - (NB_OUTER / 2)],
  })
}

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
      border-radius:50%;
      background:#1E293B;
      border:2px solid #FFFFFF;
      box-shadow:0 6px 14px rgba(15,23,42,0.22);
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

const searchRadarIcon = L.divIcon({
  html: `
    <div class="search-radar-wrap" aria-hidden="true">
      <div class="search-radar-core-glow"></div>
      <div class="search-radar-sweep"></div>
      <div class="search-radar-orbit orbit-1"></div>
      <div class="search-radar-orbit orbit-2"></div>
      <div class="search-radar-orbit orbit-3"></div>
      <div class="search-radar-ring ring-1"></div>
      <div class="search-radar-ring ring-2"></div>
      <div class="search-radar-ring ring-3"></div>
    </div>
  `,
  className: '',
  iconSize: [132, 132],
  iconAnchor: [66, 66],
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

function DismissNearbyPreview({ onDismiss }: { onDismiss: () => void }) {
  useMapEvents({
    click() {
      onDismiss()
    },
  })

  return null
}

function isSamePoint(a: [number, number], b: [number, number], epsilon = 0.00002) {
  return Math.abs(a[0] - b[0]) < epsilon && Math.abs(a[1] - b[1]) < epsilon
}

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

function distanceBetweenKm(a: [number, number], b: [number, number]): number {
  return haversineKm(a[0], a[1], b[0], b[1])
}

function formatNearbyDistance(distanceKm: number): string {
  const isHebrew = typeof document !== 'undefined' && document?.documentElement?.dir === 'rtl'
  if (!Number.isFinite(distanceKm)) return ''
  if (distanceKm < 1) return `${Math.max(100, Math.round(distanceKm * 1000))} m`
  return `${distanceKm.toFixed(1)} ${isHebrew ? 'ק״מ' : 'km'}`
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
  bottomViewportPadding = 0,
  onRecenter,
}: MapViewProps) {
  useEffect(() => {
    injectMarkerStyles()
    if (import.meta.env.DEV) {
      console.log(`[perf] MapView mounted at ${Math.round(performance.now())}ms`)
    }
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
  const isSearchingMapMode = isSearching && !walkerLocation
  const [selectedNearbyWalkerId, setSelectedNearbyWalkerId] = useState<string | null>(null)
  const tileUrl = isSearchingMapMode
    ? 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png'
    : 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'

  const selectedNearbyWalker = useMemo(
    () => filteredNearbyWalkers.find((item) => item.id === selectedNearbyWalkerId) ?? null,
    [filteredNearbyWalkers, selectedNearbyWalkerId],
  )

  useEffect(() => {
    if (selectedNearbyWalkerId == null) return
    if (!filteredNearbyWalkers.some((item) => item.id === selectedNearbyWalkerId)) {
      setSelectedNearbyWalkerId(null)
    }
  }, [filteredNearbyWalkers, selectedNearbyWalkerId])

  return (
    <div style={mapShellStyle}>
      <MapContainer
        center={userLocation}
        zoom={15}
        zoomControl={false}
        style={mapContainerStyle}
        className={isSearchingMapMode ? 'searching-map-mode' : undefined}
      >
        <TileLayer
          url={tileUrl}
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
          bottomViewportPadding={bottomViewportPadding}
          routePolyline={routePolyline}
        />

        <RecenterControl
          userLocation={userLocation}
          bottomViewportPadding={bottomViewportPadding}
          onRecenter={onRecenter}
        />
        <DismissNearbyPreview onDismiss={() => setSelectedNearbyWalkerId(null)} />

        <RouteLine routePolyline={routePolyline} />

        {isSearchingMapMode && (
          <Marker
            position={userLocation}
            icon={searchRadarIcon}
            interactive={false}
            zIndexOffset={620}
          />
        )}

        {filteredNearbyWalkers.map((w) => (
          <Fragment key={w.id}>
            {w.bearing != null && (
              <NearbyWalkerArrow center={[w.lat, w.lng]} bearing={w.bearing} />
            )}
            {(() => {
              const metaItems: string[] = []
              if (typeof w.rating === 'number') {
                metaItems.push(`⭐ ${w.rating.toFixed(1)}`)
              }
              const distanceKm = distanceBetweenKm(userLocation, [w.lat, w.lng])
              if (Number.isFinite(distanceKm)) {
                metaItems.push(`📍 ${formatNearbyDistance(distanceKm)}`)
              }
              const previewMeta = metaItems.length > 0 ? metaItems.join(' • ') : null
              return (
            <Marker
              position={[w.lat, w.lng]}
              icon={createNearbyWalkerAvatarIcon({
                avatarUrl: w.avatarUrl ?? null,
                fallbackName: w.fullName?.trim() || 'Provider',
                previewName: selectedNearbyWalker?.id === w.id ? (w.fullName?.trim() || 'Provider') : null,
                previewMeta,
                selected: selectedNearbyWalker?.id === w.id,
              })}
              interactive={true}
              zIndexOffset={700}
              eventHandlers={{
                click: () => {
                  setSelectedNearbyWalkerId((current) => (current === w.id ? null : w.id))
                },
              }}
            />
              )
            })()}
          </Fragment>
        ))}

        {showUserMarker && (
          <Marker
            position={userLocation}
            icon={userLocationIcon}
            interactive={false}
            zIndexOffset={650}
          />
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

const mapShellStyle: CSSProperties = {
  position: 'relative',
  height: '100%',
  width: '100%',
  minWidth: 0,
  maxWidth: '100%',
  overflow: 'hidden',
  boxSizing: 'border-box',
  contain: 'layout paint size',
}

const mapContainerStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  height: '100%',
  width: '100%',
  minWidth: 0,
  maxWidth: '100%',
  boxSizing: 'border-box',
  overflow: 'hidden',
}

const recenterBtnStyle: CSSProperties = {
  position: 'absolute',
  top: 12,
  right: 12,
  zIndex: 1000,
  width: 36,
  height: 36,
  borderRadius: 8,
  background: 'rgba(255,255,255,0.92)',
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
  boxShadow: '0 1px 4px rgba(0,0,0,0.12)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  border: 'none',
  touchAction: 'manipulation',
}
