import type { ProfileServiceType } from './profileServiceTypes'

export type ProviderCapabilitiesMap = Record<string, Record<string, unknown>>
export type ProviderLanguage = 'hebrew' | 'english' | 'russian' | 'arabic' | 'french'
export type ProviderExperienceRange = '0_1' | '1_3' | '3_5' | '5_10' | '10_plus'

export type ProviderCapabilityRow = {
  provider_id: string
  capability_scope: string
  capabilities: Record<string, unknown>
  updated_at?: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value)
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}

export function normalizeProviderCapabilitiesMap(value: unknown): ProviderCapabilitiesMap {
  if (!isRecord(value)) return {}

  const next: ProviderCapabilitiesMap = {}
  for (const [scope, attrs] of Object.entries(value)) {
    if (!isRecord(attrs)) continue
    next[scope] = cloneRecord(attrs)
  }
  return next
}

export function mergeProviderCapabilitiesSources(params: {
  rows?: ProviderCapabilityRow[] | null
  fallbackServiceAttributes?: unknown
  shortBio?: string | null
}): ProviderCapabilitiesMap {
  const merged = normalizeProviderCapabilitiesMap(params.fallbackServiceAttributes)

  for (const row of params.rows ?? []) {
    if (!row?.capability_scope || !isRecord(row.capabilities)) continue
    merged[row.capability_scope] = cloneRecord(row.capabilities)
  }

  const providerProfile = isRecord(merged.provider_profile)
    ? cloneRecord(merged.provider_profile)
    : {}

  if (typeof params.shortBio === 'string' && params.shortBio.trim()) {
    providerProfile.shortBio = params.shortBio.trim()
  } else if (typeof providerProfile.shortBio === 'string' && !providerProfile.shortBio.trim()) {
    delete providerProfile.shortBio
  }

  if (Object.keys(providerProfile).length > 0) {
    merged.provider_profile = providerProfile
  }

  return merged
}

export function buildProviderCapabilityRows(
  providerId: string,
  capabilities: ProviderCapabilitiesMap,
): ProviderCapabilityRow[] {
  return Object.entries(normalizeProviderCapabilitiesMap(capabilities)).map(([capabilityScope, attrs]) => ({
    provider_id: providerId,
    capability_scope: capabilityScope,
    capabilities: cloneRecord(attrs),
  }))
}

export function buildLegacyServiceAttributesFromCapabilities(
  capabilities: ProviderCapabilitiesMap,
): ProviderCapabilitiesMap {
  return normalizeProviderCapabilitiesMap(capabilities)
}

export function upsertCapabilityScope(
  current: ProviderCapabilitiesMap,
  capabilityScope: string,
  patch: Record<string, unknown>,
): ProviderCapabilitiesMap {
  const next = normalizeProviderCapabilitiesMap(current)
  next[capabilityScope] = {
    ...(isRecord(next[capabilityScope]) ? next[capabilityScope] : {}),
    ...patch,
  }
  return next
}

export function getCapabilityScope<T extends Record<string, unknown>>(
  capabilities: ProviderCapabilitiesMap,
  capabilityScope: string,
): T | null {
  const value = capabilities[capabilityScope]
  return isRecord(value) ? (value as T) : null
}

export function buildProviderSignupCapabilities(params: {
  serviceAttributes: ProviderCapabilitiesMap | null | undefined
  shortBio?: string | null
}): ProviderCapabilitiesMap {
  const merged = mergeProviderCapabilitiesSources({
    rows: null,
    fallbackServiceAttributes: params.serviceAttributes,
    shortBio: params.shortBio ?? null,
  })

  const providerProfile = getCapabilityScope<Record<string, unknown>>(merged, 'provider_profile') ?? {}
  if (typeof params.shortBio === 'string' && params.shortBio.trim()) {
    providerProfile.shortBio = params.shortBio.trim()
  }
  if (Object.keys(providerProfile).length > 0) {
    merged.provider_profile = providerProfile
  }

  return merged
}

export function getCapabilityShortBio(
  capabilities: ProviderCapabilitiesMap,
  fallbackShortBio?: string | null,
): string {
  const providerProfile = getCapabilityScope<Record<string, unknown>>(capabilities, 'provider_profile')
  const capabilityShortBio =
    providerProfile && typeof providerProfile.shortBio === 'string' ? providerProfile.shortBio.trim() : ''

  if (capabilityShortBio) return capabilityShortBio
  return typeof fallbackShortBio === 'string' ? fallbackShortBio : ''
}

export function getServiceCapabilityScope(serviceType: ProfileServiceType): string {
  return serviceType
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0) : []
}

function parseProviderLanguages(value: unknown): ProviderLanguage[] {
  return parseStringArray(value).filter((entry): entry is ProviderLanguage =>
    entry === 'hebrew' || entry === 'english' || entry === 'russian' || entry === 'arabic' || entry === 'french',
  )
}

function toTitleCaseLabel(value: string): string {
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function getProviderExperienceRangeFromYears(years: number | null | undefined): ProviderExperienceRange | null {
  if (typeof years !== 'number' || !Number.isFinite(years) || years <= 0) return null
  if (years >= 10) return '10_plus'
  if (years >= 7) return '5_10'
  if (years >= 4) return '3_5'
  if (years >= 2) return '1_3'
  return '0_1'
}

export type ProviderCapabilitySummary = {
  experienceRange: ProviderExperienceRange | null
  experienceYears: number | null
  languages: ProviderLanguage[]
  shortBio: string | null
  specialties: string[]
  servicePreferences: string[]
}

export function getProviderCapabilitySummary(params: {
  capabilities: ProviderCapabilitiesMap
  serviceType?: string | null
  fallbackShortBio?: string | null
}): ProviderCapabilitySummary {
  const providerProfile = getCapabilityScope<Record<string, unknown>>(params.capabilities, 'provider_profile') ?? {}
  const scopeKey =
    typeof params.serviceType === 'string' && params.serviceType.trim()
      ? params.serviceType.trim()
      : null
  const serviceScope = scopeKey ? getCapabilityScope<Record<string, unknown>>(params.capabilities, scopeKey) ?? {} : {}

  const experienceYearsRaw =
    typeof providerProfile.experienceYears === 'number'
      ? providerProfile.experienceYears
      : typeof serviceScope.experienceYears === 'number'
        ? serviceScope.experienceYears
        : null
  const experienceYears = typeof experienceYearsRaw === 'number' && Number.isFinite(experienceYearsRaw) ? experienceYearsRaw : null
  const experienceRange =
    typeof providerProfile.experienceRange === 'string'
      ? providerProfile.experienceRange as ProviderExperienceRange
      : getProviderExperienceRangeFromYears(experienceYears)
  const languages = parseProviderLanguages(providerProfile.languagesSpoken ?? providerProfile.languages)
  const shortBio = getCapabilityShortBio(params.capabilities, params.fallbackShortBio ?? null).trim() || null

  const specialties = new Set<string>()
  const servicePreferences = new Set<string>()

  if (scopeKey === 'dog_walker') {
    const dogSizes = parseStringArray(serviceScope.supportedDogSizes).map((size) => size.toUpperCase())
    if (dogSizes.length > 0) {
      specialties.add('dogSizes')
      servicePreferences.add(`dog_sizes:${dogSizes.join(', ')}`)
    }
    const energyLevels = parseStringArray(serviceScope.supportedEnergyLevels)
    if (energyLevels.includes('high')) specialties.add('highEnergyDogs')
    if (energyLevels.length > 0) {
      servicePreferences.add(`energy_levels:${energyLevels.map((level) => toTitleCaseLabel(level)).join(', ')}`)
    }
  }

  if (scopeKey === 'baby_sitter') {
    const ageRanges = parseStringArray(serviceScope.supportedAgeRanges)
    if (ageRanges.length > 0) {
      specialties.add('ageRangeCare')
      servicePreferences.add(`age_ranges:${ageRanges.join(', ')}`)
    }
  }

  if (typeof serviceScope.specialties === 'object' && Array.isArray(serviceScope.specialties)) {
    parseStringArray(serviceScope.specialties).forEach((specialty) => specialties.add(specialty))
  }

  return {
    experienceRange,
    experienceYears,
    languages,
    shortBio,
    specialties: Array.from(specialties),
    servicePreferences: Array.from(servicePreferences),
  }
}

export type ProviderMatchingSignals = {
  experienceYears: number
  languageCodes: ProviderLanguage[]
  serviceSpecialties: string[]
  servicePreferences: string[]
}

export function getProviderMatchingSignals(params: {
  capabilities: ProviderCapabilitiesMap
  serviceType?: string | null
}): ProviderMatchingSignals {
  const summary = getProviderCapabilitySummary({
    capabilities: params.capabilities,
    serviceType: params.serviceType ?? null,
  })

  return {
    experienceYears: summary.experienceYears ?? 0,
    languageCodes: summary.languages,
    serviceSpecialties: summary.specialties,
    servicePreferences: summary.servicePreferences,
  }
}
