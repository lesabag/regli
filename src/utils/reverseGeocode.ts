import { formatShortAddress } from './addressFormat'

type ReverseGeocodeResponse = {
  provider?: 'google'
  displayName?: string | null
  address?: Record<string, string | null | undefined> | null
  formattedAddress?: string | null
}

type ReverseGeocodeOptions = {
  language?: string
  fallbackLabel?: string
}

type ReverseGeocodeCacheEntry = {
  lat: number
  lng: number
  language: string
  address: string
  timestamp: number
}

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const REVERSE_GEOCODE_CACHE_TTL_MS = 10 * 60 * 1000
const REVERSE_GEOCODE_CACHE_DISTANCE_METERS = 75
const REVERSE_GEOCODE_CACHE_MAX_ENTRIES = 24
const CACHE_LOG_THROTTLE_MS = 60 * 1000
const reverseGeocodeCache: ReverseGeocodeCacheEntry[] = []
const reverseGeocodeInflight = new Map<string, Promise<string>>()
let lastCacheHitLogAt = 0
let lastCacheRejectLogAt = 0
let lastFreshRequestLogAt = 0

function roundCoord(value: number): number {
  return Number(value.toFixed(5))
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180
}

function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const earthRadius = 6371000
  const dLat = toRadians(lat2 - lat1)
  const dLng = toRadians(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2)
  return 2 * earthRadius * Math.asin(Math.sqrt(a))
}

function getInflightKey(lat: number, lng: number, language: string): string {
  return `${language}:${lat.toFixed(4)}:${lng.toFixed(4)}`
}

function readCachedAddress(lat: number, lng: number, language: string): string | null {
  const now = Date.now()
  const nearbyEntry = reverseGeocodeCache.find((entry) =>
    entry.language === language &&
    distanceMeters(entry.lat, entry.lng, lat, lng) <= REVERSE_GEOCODE_CACHE_DISTANCE_METERS,
  )

  if (nearbyEntry && now - nearbyEntry.timestamp > REVERSE_GEOCODE_CACHE_TTL_MS) {
    if (now - lastCacheRejectLogAt > CACHE_LOG_THROTTLE_MS) {
      lastCacheRejectLogAt = now
      console.log('[ReverseGeocodeProvider]', {
        provider: 'cache',
        result: 'cache_rejected_stale_age',
        ageMinutes: Math.round((now - nearbyEntry.timestamp) / 60000),
        lat: roundCoord(lat),
        lng: roundCoord(lng),
      })
    }
    return null
  }

  const match = reverseGeocodeCache.find((entry) =>
    entry.language === language &&
    now - entry.timestamp <= REVERSE_GEOCODE_CACHE_TTL_MS &&
    distanceMeters(entry.lat, entry.lng, lat, lng) <= REVERSE_GEOCODE_CACHE_DISTANCE_METERS,
  )

  if (!match) return null

  if (now - lastCacheHitLogAt > CACHE_LOG_THROTTLE_MS) {
    lastCacheHitLogAt = now
    console.log('[ReverseGeocodeProvider]', {
      provider: 'cache',
      lat: roundCoord(lat),
      lng: roundCoord(lng),
      finalAddress: match.address,
    })
  }

  return match.address
}

function writeCachedAddress(lat: number, lng: number, language: string, address: string) {
  const nextEntry: ReverseGeocodeCacheEntry = {
    lat,
    lng,
    language,
    address,
    timestamp: Date.now(),
  }

  for (let index = reverseGeocodeCache.length - 1; index >= 0; index -= 1) {
    const entry = reverseGeocodeCache[index]
    if (
      entry.language === language &&
      distanceMeters(entry.lat, entry.lng, lat, lng) <= REVERSE_GEOCODE_CACHE_DISTANCE_METERS
    ) {
      reverseGeocodeCache.splice(index, 1)
    }
  }

  reverseGeocodeCache.unshift(nextEntry)
  if (reverseGeocodeCache.length > REVERSE_GEOCODE_CACHE_MAX_ENTRIES) {
    reverseGeocodeCache.length = REVERSE_GEOCODE_CACHE_MAX_ENTRIES
  }
}

async function requestGoogleReverseGeocode(
  lat: number,
  lng: number,
  language?: string,
): Promise<string | null> {
  if (!supabaseUrl || !supabaseAnonKey) {
    return null
  }

  const response = await fetch(`${supabaseUrl}/functions/v1/reverse-geocode`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${supabaseAnonKey}`,
    },
    body: JSON.stringify({
      lat,
      lng,
      language: language || null,
    }),
  })

  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string; details?: string } | null
    const message = payload?.error || payload?.details || `google reverse geocode failed (${response.status})`
    throw new Error(message)
  }

  const data = await response.json() as ReverseGeocodeResponse
  const formattedAddress =
    formatShortAddress(data.displayName, data.address ?? undefined) ||
    (typeof data.formattedAddress === 'string' ? data.formattedAddress.trim() : '')

  if (!formattedAddress) return null

  console.log('[ReverseGeocodeProvider]', {
    provider: data.provider ?? 'google',
    lat: roundCoord(lat),
    lng: roundCoord(lng),
    finalAddress: formattedAddress,
  })

  return formattedAddress
}

async function requestNominatimReverseGeocode(
  lat: number,
  lng: number,
  language?: string,
): Promise<string | null> {
  const query = new URLSearchParams({
    format: 'json',
    addressdetails: '1',
    lat: String(lat),
    lon: String(lng),
  })

  if (language) {
    query.set('accept-language', language)
  }

  const res = await fetch(`https://nominatim.openstreetmap.org/reverse?${query.toString()}`)
  if (!res.ok) {
    throw new Error(`nominatim reverse geocode failed (${res.status})`)
  }

  const data = await res.json()
  const formattedAddress = formatShortAddress(data?.display_name, data?.address)
  const displayAddress =
    typeof data?.display_name === 'string' &&
    !/^-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?$/.test(data.display_name.trim())
      ? data.display_name.trim()
      : ''
  const finalAddress = formattedAddress || displayAddress

  console.log('[ReverseGeocode]', {
    lat: roundCoord(lat),
    lng: roundCoord(lng),
    house_number: data?.address?.house_number ?? null,
    street_number: data?.address?.street_number ?? null,
    addr_housenumber: data?.address?.['addr:housenumber'] ?? null,
    addr_streetnumber: data?.address?.['addr:streetnumber'] ?? null,
    building_number: data?.address?.building_number ?? data?.address?.buildingNumber ?? null,
    road:
      data?.address?.road ??
      data?.address?.route ??
      data?.address?.street ??
      data?.address?.pedestrian ??
      null,
    city:
      data?.address?.city ??
      data?.address?.locality ??
      data?.address?.town ??
      data?.address?.village ??
      null,
    displayAddress: displayAddress || null,
    formattedAddress: formattedAddress || null,
    finalAddress: finalAddress || null,
  })

  if (!finalAddress) return null

  console.log('[ReverseGeocodeProvider]', {
    provider: 'nominatim',
    lat: roundCoord(lat),
    lng: roundCoord(lng),
    finalAddress,
  })

  return finalAddress
}

export async function reverseGeocodeAddress(
  lat: number,
  lng: number,
  options?: ReverseGeocodeOptions,
): Promise<string> {
  const fallbackLabel = options?.fallbackLabel || 'Current location detected'
  const language = options?.language || 'he'

  const cachedAddress = readCachedAddress(lat, lng, language)
  if (cachedAddress) {
    return cachedAddress
  }

  const inflightKey = getInflightKey(lat, lng, language)
  const existingInflight = reverseGeocodeInflight.get(inflightKey)
  if (existingInflight) {
    return existingInflight
  }

  const now = Date.now()
  if (now - lastFreshRequestLogAt > CACHE_LOG_THROTTLE_MS) {
    lastFreshRequestLogAt = now
    console.log('[ReverseGeocodeProvider]', {
      provider: 'network',
      result: 'fresh_geocode_requested',
      lat: roundCoord(lat),
      lng: roundCoord(lng),
    })
  }

  const request = (async () => {
    try {
      const googleAddress = await requestGoogleReverseGeocode(lat, lng, language)
      if (googleAddress) {
        writeCachedAddress(lat, lng, language, googleAddress)
        return googleAddress
      }
    } catch (error) {
      console.warn('[GoogleReverseGeocode]', {
        lat: roundCoord(lat),
        lng: roundCoord(lng),
        result: 'error',
        message: error instanceof Error ? error.message : 'unknown_error',
      })
    }

    try {
      const nominatimAddress = await requestNominatimReverseGeocode(lat, lng, language)
      if (nominatimAddress) {
        writeCachedAddress(lat, lng, language, nominatimAddress)
        return nominatimAddress
      }
    } catch (error) {
      console.warn('[ReverseGeocodeProvider]', {
        provider: 'nominatim',
        lat: roundCoord(lat),
        lng: roundCoord(lng),
        result: 'error',
        message: error instanceof Error ? error.message : 'unknown_error',
      })
    }

    console.warn('[ReverseGeocodeProvider]', {
      provider: 'fallback_label',
      lat: roundCoord(lat),
      lng: roundCoord(lng),
      finalAddress: fallbackLabel,
    })

    return fallbackLabel
  })().finally(() => {
    reverseGeocodeInflight.delete(inflightKey)
  })

  reverseGeocodeInflight.set(inflightKey, request)
  return request
}
