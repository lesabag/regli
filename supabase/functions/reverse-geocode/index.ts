import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { corsHeaders } from '../_shared/cors.ts'

type ReverseGeocodeBody = {
  lat?: number
  lng?: number
  language?: string | null
}

type GoogleAddressParts = Record<string, string | null>

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function roundCoord(value: number): number {
  return Number(value.toFixed(5))
}

function extractComponent(
  components: Array<{ long_name?: string; short_name?: string; types?: string[] }> | undefined,
  ...types: string[]
): string | null {
  if (!Array.isArray(components)) return null
  const match = components.find((component) =>
    Array.isArray(component.types) && types.some((type) => component.types?.includes(type)),
  )
  return match?.long_name?.trim() || match?.short_name?.trim() || null
}

function toAddressParts(
  components: Array<{ long_name?: string; short_name?: string; types?: string[] }> | undefined,
): GoogleAddressParts {
  return {
    road:
      extractComponent(components, 'route') ??
      extractComponent(components, 'premise') ??
      extractComponent(components, 'establishment'),
    house_number:
      extractComponent(components, 'street_number') ??
      extractComponent(components, 'subpremise') ??
      extractComponent(components, 'premise'),
    street_number: extractComponent(components, 'street_number'),
    'addr:housenumber':
      extractComponent(components, 'street_number') ??
      extractComponent(components, 'subpremise'),
    city:
      extractComponent(components, 'locality') ??
      extractComponent(components, 'postal_town') ??
      extractComponent(components, 'administrative_area_level_2') ??
      extractComponent(components, 'administrative_area_level_1'),
    locality: extractComponent(components, 'locality'),
    town: extractComponent(components, 'postal_town'),
    neighbourhood: extractComponent(components, 'neighborhood', 'sublocality', 'sublocality_level_1'),
    country: extractComponent(components, 'country'),
  }
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { lat, lng, language } = await req.json() as ReverseGeocodeBody
    const latitude = typeof lat === 'number' ? lat : Number(lat)
    const longitude = typeof lng === 'number' ? lng : Number(lng)

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return json(400, { error: 'Missing or invalid lat/lng' })
    }

    const googleApiKey = Deno.env.get('GOOGLE_GEOCODING_API_KEY') ?? Deno.env.get('GOOGLE_MAPS_API_KEY')
    if (!googleApiKey) {
      console.warn('[GoogleReverseGeocode]', {
        lat: roundCoord(latitude),
        lng: roundCoord(longitude),
        result: 'missing_key',
      })
      return json(500, { error: 'Google geocoding not configured' })
    }

    const params = new URLSearchParams({
      latlng: `${latitude},${longitude}`,
      key: googleApiKey,
    })

    if (typeof language === 'string' && language.trim()) {
      params.set('language', language.trim())
    }

    const response = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${params.toString()}`)
    if (!response.ok) {
      console.warn('[GoogleReverseGeocode]', {
        lat: roundCoord(latitude),
        lng: roundCoord(longitude),
        result: 'http_error',
        status: response.status,
      })
      return json(502, { error: 'Google geocoding request failed', details: `status ${response.status}` })
    }

    const payload = await response.json() as {
      status?: string
      error_message?: string
      results?: Array<{
        formatted_address?: string
        types?: string[]
        address_components?: Array<{ long_name?: string; short_name?: string; types?: string[] }>
      }>
    }

    if (payload.status !== 'OK' || !Array.isArray(payload.results) || payload.results.length === 0) {
      console.warn('[GoogleReverseGeocode]', {
        lat: roundCoord(latitude),
        lng: roundCoord(longitude),
        result: 'no_result',
        status: payload.status ?? 'UNKNOWN',
        message: payload.error_message ?? null,
      })
      return json(404, {
        error: 'Google geocoding returned no result',
        details: payload.error_message ?? payload.status ?? 'NO_RESULT',
      })
    }

    const bestResult =
      payload.results.find((result) =>
        Array.isArray(result.types) &&
        (result.types.includes('street_address') || result.types.includes('premise') || result.types.includes('route')),
      ) ?? payload.results[0]

    const address = toAddressParts(bestResult.address_components)

    console.log('[GoogleReverseGeocode]', {
      lat: roundCoord(latitude),
      lng: roundCoord(longitude),
      result: 'success',
      formattedAddress: bestResult.formatted_address ?? null,
      road: address.road ?? null,
      house_number: address.house_number ?? null,
      city: address.city ?? null,
    })

    return json(200, {
      provider: 'google',
      displayName: bestResult.formatted_address ?? null,
      address,
      formattedAddress: bestResult.formatted_address ?? null,
    })
  } catch (error) {
    console.error('[GoogleReverseGeocode]', {
      result: 'exception',
      message: error instanceof Error ? error.message : 'unknown_error',
    })
    return json(500, { error: 'Internal server error' })
  }
})
