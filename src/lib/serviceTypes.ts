export const SERVICE_TYPES = [
  'dog_walking',
  'babysitter',
  'electrician',
  'locksmith',
  'handyman',
  'air_conditioner_technician',
  'plumber',
  'technician',
  'cleaning',
  'tutor',
  'shutters',
] as const

export type ServiceType = (typeof SERVICE_TYPES)[number]

export const PRIMARY_SERVICES: ServiceType[] = [
  'dog_walking',
  'babysitter',
]

export const MORE_SERVICES: ServiceType[] = [
  'electrician',
  'locksmith',
  'handyman',
  'air_conditioner_technician',
  'plumber',
]

export const FIXED_VISIT_BOOKING_SERVICES: ServiceType[] = [
  'electrician',
  'locksmith',
  'handyman',
  'air_conditioner_technician',
  'plumber',
]

export const SERVICE_ICONS: Record<ServiceType, string> = {
  dog_walking: '🐾',
  babysitter: '👶',
  electrician: '⚡',
  locksmith: '🔐',
  handyman: '🛠️',
  air_conditioner_technician: '❄️',
  plumber: '🔩',
  technician: '🔧',
  cleaning: '🧹',
  tutor: '📚',
  shutters: '🪟',
}

export const SERVICE_I18N_KEYS: Record<
  ServiceType,
  {
    label: string
    inputLabel: string
    inputPlaceholder: string
    sheetTitle: string
    sheetSubtitle: string
  }
> = {
  dog_walking: {
    label: 'services.dogWalk',
    inputLabel: 'serviceInput.dogWalking.label',
    inputPlaceholder: 'serviceInput.dogWalking.placeholder',
    sheetTitle: 'serviceInput.dogWalking.sheetTitle',
    sheetSubtitle: 'serviceInput.dogWalking.sheetSubtitle',
  },
  babysitter: {
    label: 'services.babysitter',
    inputLabel: 'serviceInput.babysitter.label',
    inputPlaceholder: 'serviceInput.babysitter.placeholder',
    sheetTitle: 'serviceInput.babysitter.sheetTitle',
    sheetSubtitle: 'serviceInput.babysitter.sheetSubtitle',
  },
  electrician: {
    label: 'services.electrician',
    inputLabel: 'serviceInput.electrician.label',
    inputPlaceholder: 'serviceInput.electrician.placeholder',
    sheetTitle: 'serviceInput.electrician.sheetTitle',
    sheetSubtitle: 'serviceInput.electrician.sheetSubtitle',
  },
  locksmith: {
    label: 'services.locksmith',
    inputLabel: 'serviceInput.locksmith.label',
    inputPlaceholder: 'serviceInput.locksmith.placeholder',
    sheetTitle: 'serviceInput.locksmith.sheetTitle',
    sheetSubtitle: 'serviceInput.locksmith.sheetSubtitle',
  },
  handyman: {
    label: 'services.handyman',
    inputLabel: 'serviceInput.handyman.label',
    inputPlaceholder: 'serviceInput.handyman.placeholder',
    sheetTitle: 'serviceInput.handyman.sheetTitle',
    sheetSubtitle: 'serviceInput.handyman.sheetSubtitle',
  },
  air_conditioner_technician: {
    label: 'services.airConditionerTechnician',
    inputLabel: 'serviceInput.airConditionerTechnician.label',
    inputPlaceholder: 'serviceInput.airConditionerTechnician.placeholder',
    sheetTitle: 'serviceInput.airConditionerTechnician.sheetTitle',
    sheetSubtitle: 'serviceInput.airConditionerTechnician.sheetSubtitle',
  },
  plumber: {
    label: 'services.plumber',
    inputLabel: 'serviceInput.plumber.label',
    inputPlaceholder: 'serviceInput.plumber.placeholder',
    sheetTitle: 'serviceInput.plumber.sheetTitle',
    sheetSubtitle: 'serviceInput.plumber.sheetSubtitle',
  },
  technician: {
    label: 'services.technician',
    inputLabel: 'serviceInput.technician.label',
    inputPlaceholder: 'serviceInput.technician.placeholder',
    sheetTitle: 'serviceInput.technician.sheetTitle',
    sheetSubtitle: 'serviceInput.technician.sheetSubtitle',
  },
  cleaning: {
    label: 'services.cleaning',
    inputLabel: 'serviceInput.cleaning.label',
    inputPlaceholder: 'serviceInput.cleaning.placeholder',
    sheetTitle: 'serviceInput.cleaning.sheetTitle',
    sheetSubtitle: 'serviceInput.cleaning.sheetSubtitle',
  },
  tutor: {
    label: 'services.tutor',
    inputLabel: 'serviceInput.tutor.label',
    inputPlaceholder: 'serviceInput.tutor.placeholder',
    sheetTitle: 'serviceInput.tutor.sheetTitle',
    sheetSubtitle: 'serviceInput.tutor.sheetSubtitle',
  },
  shutters: {
    label: 'services.shutters',
    inputLabel: 'serviceInput.shutters.label',
    inputPlaceholder: 'serviceInput.shutters.placeholder',
    sheetTitle: 'serviceInput.shutters.sheetTitle',
    sheetSubtitle: 'serviceInput.shutters.sheetSubtitle',
  },
}

export function isServiceAvailable(serviceType: ServiceType): boolean {
  return (
    serviceType === 'dog_walking' ||
    serviceType === 'babysitter' ||
    FIXED_VISIT_BOOKING_SERVICES.includes(serviceType)
  )
}

export function getBookingPricingModelForService(serviceType: ServiceType | string | null | undefined): 'time_based' | 'fixed_visit' {
  const normalized = (serviceType ?? '').trim().toLowerCase()
  if (
    normalized === 'electrician' ||
    normalized === 'locksmith' ||
    normalized === 'handyman' ||
    normalized === 'air_conditioner_technician' ||
    normalized === 'air-conditioner-technician' ||
    normalized === 'plumber' ||
    normalized === 'technician' ||
    normalized === 'shutters'
  ) {
    return 'fixed_visit'
  }
  return 'time_based'
}

export function isFixedVisitBookingService(serviceType: ServiceType | string | null | undefined): boolean {
  return getBookingPricingModelForService(serviceType) === 'fixed_visit'
}

export function mapBookingServiceTypeToRequestServiceType(serviceType: ServiceType): string {
  if (serviceType === 'babysitter') return 'baby_sitter'
  if (serviceType === 'dog_walking') return 'dog_walker'
  return serviceType
}
