export function normalizeProviderServiceType(value: string | null | undefined): string | null {
  const normalized = (value ?? '').trim().toLowerCase()
  if (!normalized) return null
  if (normalized === 'dog_walking' || normalized === 'dog-walker' || normalized === 'dog_walker') {
    return 'dog_walker'
  }
  if (normalized === 'babysitter' || normalized === 'baby-sitter' || normalized === 'baby_sitter') {
    return 'baby_sitter'
  }
  return normalized
}

export function parseProviderServiceTypes(
  rawServiceTypes: string[] | string | null | undefined,
): string[] {
  if (Array.isArray(rawServiceTypes)) {
    return rawServiceTypes
      .map((value) => String(value ?? '').trim())
      .filter(Boolean)
  }

  if (typeof rawServiceTypes === 'string') {
    return rawServiceTypes
      .replace(/^\{|\}$/g, '')
      .split(',')
      .map((value) => value.trim().replace(/^"|"$/g, ''))
      .filter(Boolean)
  }

  return []
}

export function getNormalizedProviderServiceTypes(
  rawServiceTypes: string[] | string | null | undefined,
): string[] {
  return parseProviderServiceTypes(rawServiceTypes)
    .map((value) => normalizeProviderServiceType(value))
    .filter((value): value is string => value !== null)
}

export function providerSupportsRequestedService(
  profile: {
    service_types?: string[] | string | null
    service_type?: string | null
  },
  requestServiceType: string | null,
): boolean {
  if (!requestServiceType) return true

  const normalizedServiceTypes = getNormalizedProviderServiceTypes(profile.service_types)
  if (normalizedServiceTypes.length > 0) {
    return normalizedServiceTypes.includes(requestServiceType)
  }

  const normalizedLegacyServiceType = normalizeProviderServiceType(profile.service_type)
  if (normalizedLegacyServiceType) {
    return normalizedLegacyServiceType === requestServiceType
  }

  return false
}
