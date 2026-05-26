import type { ProfileServiceType } from './profileServiceTypes'

export type ProviderCapabilitiesMap = Record<string, Record<string, unknown>>

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
