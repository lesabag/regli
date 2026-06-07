import type { ProfileServiceType } from './profileServiceTypes'
import type { ServiceType } from './serviceTypes'

export const launchEnabledServices = ['dog_walker', 'baby_sitter'] as const

export const launchEnabledProfileServices: ProfileServiceType[] = [...launchEnabledServices]

export const launchEnabledBookingServices: ServiceType[] = [
  'dog_walking',
  'babysitter',
]

export function isLaunchEnabledProfileService(value: string | null | undefined): value is ProfileServiceType {
  return launchEnabledProfileServices.includes(value as ProfileServiceType)
}

export function isLaunchEnabledBookingService(value: string | null | undefined): value is ServiceType {
  return launchEnabledBookingServices.includes(value as ServiceType)
}
