import type { ServiceType } from './serviceTypes'

export const PROFILE_SERVICE_TYPES = ['dog_walker', 'baby_sitter'] as const

export type ProfileServiceType = (typeof PROFILE_SERVICE_TYPES)[number]

type ProfileServiceTypeOption = {
  value: ProfileServiceType
  label: string
  description: string
  icon: string
}

const PROFILE_SERVICE_TYPE_COPY: Record<
  ProfileServiceType,
  {
    en: Omit<ProfileServiceTypeOption, 'value'>
    he: Omit<ProfileServiceTypeOption, 'value'>
  }
> = {
  dog_walker: {
    en: {
      label: 'Dog walker',
      description: 'Walks, check-ins, and pet care.',
      icon: '🐾',
    },
    he: {
      label: 'דוג ווקר',
      description: 'טיולים, ביקורים וטיפול בחיות מחמד.',
      icon: '🐾',
    },
  },
  baby_sitter: {
    en: {
      label: 'Baby sitter',
      description: 'Trusted child care and supervision.',
      icon: '👶',
    },
    he: {
      label: 'בייביסיטר',
      description: 'שמירה וטיפול בילדים באמון.',
      icon: '👶',
    },
  },
}

export function normalizeProfileServiceType(value: string | null | undefined): ProfileServiceType | null {
  const normalized = (value ?? '').trim().toLowerCase()
  if (!normalized) return null
  if (normalized === 'dog_walker' || normalized === 'dog-walker' || normalized === 'dog_walking') {
    return 'dog_walker'
  }
  if (normalized === 'baby_sitter' || normalized === 'baby-sitter' || normalized === 'babysitter') {
    return 'baby_sitter'
  }
  return null
}

export function normalizeProfileServiceTypes(values: unknown): ProfileServiceType[] {
  if (Array.isArray(values)) {
    return Array.from(
      new Set(
        values
          .map((value) => normalizeProfileServiceType(typeof value === 'string' ? value : null))
          .filter((value): value is ProfileServiceType => value != null),
      ),
    )
  }

  const single = normalizeProfileServiceType(typeof values === 'string' ? values : null)
  return single ? [single] : []
}

export function getProfileServiceOptions(isHebrew: boolean): ProfileServiceTypeOption[] {
  return PROFILE_SERVICE_TYPES.map((value) => ({
    value,
    ...(isHebrew ? PROFILE_SERVICE_TYPE_COPY[value].he : PROFILE_SERVICE_TYPE_COPY[value].en),
  }))
}

export function getProfileServiceTypeLabel(
  value: string | null | undefined,
  isHebrew: boolean,
): string {
  const normalized = normalizeProfileServiceType(value)
  if (!normalized) {
    return isHebrew ? 'לא נבחר שירות' : 'No service selected'
  }
  return isHebrew
    ? PROFILE_SERVICE_TYPE_COPY[normalized].he.label
    : PROFILE_SERVICE_TYPE_COPY[normalized].en.label
}

export function getProfileServiceTypesLabel(
  values: unknown,
  isHebrew: boolean,
): string {
  const normalized = normalizeProfileServiceTypes(values)
  if (normalized.length === 0) {
    return isHebrew ? 'לא נבחר שירות' : 'No service selected'
  }
  return normalized
    .map((value) => (isHebrew ? PROFILE_SERVICE_TYPE_COPY[value].he.label : PROFILE_SERVICE_TYPE_COPY[value].en.label))
    .join(isHebrew ? ' • ' : ' • ')
}

export function mapProfileServiceTypeToBookingServiceType(serviceType: ProfileServiceType): ServiceType {
  return serviceType === 'baby_sitter' ? 'babysitter' : 'dog_walking'
}

export function mapBookingServiceTypeToProfileServiceType(serviceType: ServiceType): ProfileServiceType | null {
  if (serviceType === 'babysitter') return 'baby_sitter'
  if (serviceType === 'dog_walking') return 'dog_walker'
  return null
}
