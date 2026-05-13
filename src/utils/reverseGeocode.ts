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

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

function roundCoord(value: number): number {
  return Number(value.toFixed(5))
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

  try {
    const googleAddress = await requestGoogleReverseGeocode(lat, lng, options?.language)
    if (googleAddress) return googleAddress
  } catch (error) {
    console.warn('[GoogleReverseGeocode]', {
      lat: roundCoord(lat),
      lng: roundCoord(lng),
      result: 'error',
      message: error instanceof Error ? error.message : 'unknown_error',
    })
  }

  try {
    const nominatimAddress = await requestNominatimReverseGeocode(lat, lng, options?.language)
    if (nominatimAddress) return nominatimAddress
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
}
