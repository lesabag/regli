type AddressParts = {
  house_number?: string | null
  street_number?: string | null
  streetnumber?: string | null
  houseNumber?: string | null
  housenumber?: string | null
  number?: string | null
  'addr:housenumber'?: string | null
  'addr:streetnumber'?: string | null
  building_number?: string | null
  buildingNumber?: string | null
  building_no?: string | null
  house?: string | null
  road?: string | null
  route?: string | null
  street?: string | null
  pedestrian?: string | null
  footway?: string | null
  neighbourhood?: string | null
  suburb?: string | null
  city?: string | null
  locality?: string | null
  town?: string | null
  village?: string | null
  municipality?: string | null
  state?: string | null
  county?: string | null
  country?: string | null
}

let lastAddressFormatLogSignature = ''

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
      address.route ??
      address.street ??
      address.pedestrian ??
      address.footway ??
      address.neighbourhood ??
      address.suburb,
  )
  const houseNumber = cleanPart(
    address.house_number ??
      address.street_number ??
      address.streetnumber ??
      address.houseNumber ??
      address.housenumber ??
      address.number ??
      address['addr:housenumber'] ??
      address['addr:streetnumber'] ??
      address.building_number ??
      address.buildingNumber ??
      address.building_no ??
      address.house,
  )
  const city = cleanPart(
    address.city ?? address.locality ?? address.town ?? address.village ?? address.municipality,
  )

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
  const firstToken = firstTokens[0] ?? ''
  const lastToken = firstTokens[firstTokens.length - 1] ?? ''

  if (looksLikeHouseNumber(first) && second) {
    return third ? `${second} ${first}, ${third}` : `${second} ${first}`
  }

  if (firstTokens.length >= 2 && looksLikeHouseNumber(firstToken) && !looksLikeHouseNumber(lastToken)) {
    const street = firstTokens.slice(1).join(' ')
    const reordered = `${street} ${firstToken}`
    return second ? `${reordered}, ${second}` : reordered
  }

  const secondTokens = second?.split(' ').filter(Boolean) ?? []
  const secondLastToken = secondTokens[secondTokens.length - 1] ?? ''

  if (!looksLikeHouseNumber(lastToken) && looksLikeHouseNumber(secondLastToken)) {
    return third ? `${second}, ${first}` : second
  }

  if (third && looksLikeHouseNumber(third)) {
    return `${first} ${third}, ${second}`
  }

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

  const raw = cleanPart(value)
  const stringValue = raw ? fromString(raw) : ''

  if (objectValue && stringValue) {
    const objectHasNumber = /\d/.test(objectValue)
    const stringHasNumber = /\d/.test(stringValue)
    const finalValue = !objectHasNumber && stringHasNumber ? stringValue : objectValue
    if (addressParts) {
      const logPayload = {
        raw: raw || null,
        street:
          cleanPart(
            addressParts.road ??
              addressParts.route ??
              addressParts.street ??
              addressParts.pedestrian ??
              addressParts.footway,
          ) || null,
        houseNumber:
          cleanPart(
            addressParts.house_number ??
              addressParts.street_number ??
              addressParts.streetnumber ??
              addressParts.houseNumber ??
              addressParts.housenumber ??
              addressParts.number ??
              addressParts['addr:housenumber'] ??
              addressParts['addr:streetnumber'] ??
              addressParts.building_number ??
              addressParts.buildingNumber ??
              addressParts.building_no ??
              addressParts.house,
          ) || null,
        city:
          cleanPart(
            addressParts.city ??
              addressParts.locality ??
              addressParts.town ??
              addressParts.village ??
              addressParts.municipality,
          ) || null,
        objectValue: objectValue || null,
        stringValue: stringValue || null,
        finalValue: finalValue || null,
      }
      const signature = JSON.stringify(logPayload)
      if (signature !== lastAddressFormatLogSignature) {
        lastAddressFormatLogSignature = signature
        console.log('[AddressFormat]', logPayload)
      }
    }
    return finalValue
  }

  const finalValue = objectValue || stringValue
  if (addressParts) {
    const logPayload = {
      raw: raw || null,
      street:
        cleanPart(
          addressParts.road ??
            addressParts.route ??
            addressParts.street ??
            addressParts.pedestrian ??
            addressParts.footway,
        ) || null,
      houseNumber:
        cleanPart(
          addressParts.house_number ??
            addressParts.street_number ??
            addressParts.streetnumber ??
            addressParts.houseNumber ??
            addressParts.housenumber ??
            addressParts.number ??
            addressParts['addr:housenumber'] ??
            addressParts['addr:streetnumber'] ??
            addressParts.building_number ??
            addressParts.buildingNumber ??
            addressParts.building_no ??
            addressParts.house,
        ) || null,
      city:
        cleanPart(
          addressParts.city ??
            addressParts.locality ??
            addressParts.town ??
            addressParts.village ??
            addressParts.municipality,
        ) || null,
      objectValue: objectValue || null,
      stringValue: stringValue || null,
      finalValue: finalValue || null,
    }
    const signature = JSON.stringify(logPayload)
    if (signature !== lastAddressFormatLogSignature) {
      lastAddressFormatLogSignature = signature
      console.log('[AddressFormat]', logPayload)
    }
  }

  return finalValue
}
