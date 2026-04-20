export type BookingStatus =
  | 'IDLE'
  | 'MATCHING'
  | 'TRACKING'
  | 'NO_MATCH'
  | 'COMPLETED'
  | 'CANCELLED'

export type BookingTiming = 'asap' | 'scheduled'

export interface ScheduledInfo {
  scheduledFor: string // ISO string
  isScheduled: boolean
}

export type ServiceType = 'quick' | 'standard' | 'energy'

export type Walker = {
  id: string
  name: string
  rating: number
  etaMinutes: number
}

export interface BookingRequest {
  dogName: string
  location: string
  notes?: string
  serviceType: ServiceType

  bookingTiming: BookingTiming
  scheduledFor?: string

  surgeMultiplier?: number
}
