type AddressParts = {
  house_number?: string | null
  houseNumber?: string | null
  road?: string | null
  street?: string | null
  pedestrian?: string | null
  footway?: string | null
  neighbourhood?: string | null
  suburb?: string | null
  city?: string | null
  town?: string | null
  village?: string | null
  municipality?: string | null
  state?: string | null
  county?: string | null
  country?: string | null
}

const COUNTRY_HINTS = new Set([
  'israel',
  'ישראל',
  'state of israel',
])

function cleanPart(value: string | null | undefined): string {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
}

function isCountryPart(value: string): boolean {
  return COUNTRY_HINTS.has(value.trim().toLowerCase())
}

function uniqueParts(parts: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const part of parts) {
    const cleaned = cleanPart(part)
    const key = cleaned.toLowerCase()
    if (!cleaned || isCountryPart(cleaned) || seen.has(key)) continue
    seen.add(key)
    result.push(cleaned)
  }

  return result
}

function fromObject(address: AddressParts): string {
  const street = cleanPart(
    address.road ??
      address.street ??
      address.pedestrian ??
      address.footway ??
      address.neighbourhood ??
      address.suburb,
  )
  const houseNumber = cleanPart(address.house_number ?? address.houseNumber)
  const city = cleanPart(address.city ?? address.town ?? address.village ?? address.municipality)

  if (street && houseNumber && city) return `${street} ${houseNumber}, ${city}`
  if (street && city) return `${street}, ${city}`
  if (city) return city
  if (street && houseNumber) return `${street} ${houseNumber}`
  if (street) return street

  const fallback = uniqueParts([
    cleanPart(address.suburb),
    cleanPart(address.county),
    cleanPart(address.state),
  ])

  return fallback[0] ?? ''
}

function looksLikeHouseNumber(value: string): boolean {
  return /^\d+[A-Za-zא-ת]?(?:[/-]\d+[A-Za-zא-ת]?)?$/.test(value.trim())
}

function fromString(value: string): string {
  const parts = uniqueParts(
    value
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  )

  if (parts.length === 0) return ''
  if (parts.length === 1) return parts[0]

  const [first, second, third] = parts
  const firstTokens = first.split(' ').filter(Boolean)
  const lastToken = firstTokens[firstTokens.length - 1] ?? ''

  if (looksLikeHouseNumber(second)) {
    return third ? `${first} ${second}, ${third}` : `${first} ${second}`
  }

  if (looksLikeHouseNumber(lastToken) && second) {
    return `${first}, ${second}`
  }

  return second ? `${first}, ${second}` : first
}

export function formatShortAddress(
  value: string | null | undefined,
  addressParts?: AddressParts | null,
): string {
  const objectValue = addressParts ? fromObject(addressParts) : ''
  if (objectValue) return objectValue

  const raw = cleanPart(value)
  if (!raw) return ''

  return fromString(raw)
}
