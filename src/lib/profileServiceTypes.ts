import type { ServiceType } from './serviceTypes'

export const PROFILE_SERVICE_TYPES = [
  'dog_walker',
  'baby_sitter',
  'electrician',
  'locksmith',
  'handyman',
  'air_conditioner_technician',
  'plumber',
] as const

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
  electrician: {
    en: {
      label: 'Electrician',
      description: 'Electrical repairs and troubleshooting.',
      icon: '⚡',
    },
    he: {
      label: 'חשמלאי',
      description: 'תיקוני חשמל ואיתור תקלות.',
      icon: '⚡',
    },
  },
  locksmith: {
    en: {
      label: 'Locksmith',
      description: 'Locks, keys, and access issues.',
      icon: '🔐',
    },
    he: {
      label: 'מנעולן',
      description: 'מנעולים, מפתחות ובעיות גישה.',
      icon: '🔐',
    },
  },
  handyman: {
    en: {
      label: 'Handyman',
      description: 'General home fixes and small repairs.',
      icon: '🛠️',
    },
    he: {
      label: 'הנדימן',
      description: 'תיקוני בית כלליים ועבודות קטנות.',
      icon: '🛠️',
    },
  },
  air_conditioner_technician: {
    en: {
      label: 'Air Conditioner Technician',
      description: 'AC diagnostics, repair, and service.',
      icon: '❄️',
    },
    he: {
      label: 'טכנאי מזגנים',
      description: 'אבחון, תיקון ושירות למזגנים.',
      icon: '❄️',
    },
  },
  plumber: {
    en: {
      label: 'Plumber',
      description: 'Leaks, pipes, and water system repairs.',
      icon: '🔩',
    },
    he: {
      label: 'אינסטלטור',
      description: 'נזילות, צנרת ותיקוני מים.',
      icon: '🔩',
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
  if (normalized === 'electrician') return 'electrician'
  if (normalized === 'locksmith') return 'locksmith'
  if (normalized === 'handyman') return 'handyman'
  if (normalized === 'air_conditioner_technician' || normalized === 'air-conditioner-technician') {
    return 'air_conditioner_technician'
  }
  if (normalized === 'plumber') return 'plumber'
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
  if (serviceType === 'baby_sitter') return 'babysitter'
  if (serviceType === 'dog_walker') return 'dog_walking'
  return serviceType
}

export function mapBookingServiceTypeToProfileServiceType(serviceType: ServiceType): ProfileServiceType | null {
  if (serviceType === 'babysitter') return 'baby_sitter'
  if (serviceType === 'dog_walking') return 'dog_walker'
  return normalizeProfileServiceType(serviceType)
}
