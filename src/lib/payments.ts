import { invokeEdgeFunction } from '../services/supabaseClient'

// ─── Legacy service types (kept for backwards compatibility) ─────
export type ServiceType = 'quick' | 'standard' | 'energy'

export const SERVICE_LABELS: Record<ServiceType, string> = {
  quick: 'Quick Walk',
  standard: 'Standard Walk',
  energy: 'Energy Walk',
}

/** Prices in agorot (smallest ILS unit) */
export const SERVICE_PRICES: Record<ServiceType, number> = {
  quick: 3000,
  standard: 5000,
  energy: 7000,
}

/** Prices in ILS for display */
export const SERVICE_PRICES_ILS: Record<ServiceType, number> = {
  quick: 30,
  standard: 50,
  energy: 70,
}

// ─── Duration-based pricing (new UI model) ───────────────────────
export type DurationType = '20min' | '40min' | '60min'

export interface DurationOption {
  value: DurationType
  label: string
  minutes: number
  priceILS: number
  priceAgorot: number
}

export const DURATION_OPTIONS: DurationOption[] = [
  { value: '20min', label: '20 min', minutes: 20, priceILS: 30, priceAgorot: 3000 },
  { value: '40min', label: '40 min', minutes: 40, priceILS: 50, priceAgorot: 5000 },
  { value: '60min', label: '60 min', minutes: 60, priceILS: 70, priceAgorot: 7000 },
]

/** Map duration to legacy service type for backend compatibility */
export const DURATION_TO_SERVICE: Record<DurationType, ServiceType> = {
  '20min': 'quick',
  '40min': 'standard',
  '60min': 'energy',
}

export const PLATFORM_FEE_PERCENT = 20

export type BookingTimingRequest = 'asap' | 'scheduled'

// ─── Payment intent ──────────────────────────────────────────────
export interface CreatePaymentIntentRequest {
  dogName: string
  location: string
  notes?: string | null
  serviceType: ServiceType
  walkerId?: string
  customerId?: string
  paymentMethodId?: string
  surgeMultiplier?: number
  bookingTiming?: BookingTimingRequest
  scheduledFor?: string | null
}

export interface CreatePaymentIntentResponse {
  jobId: string
  paymentIntentId: string
  clientSecret: string
  amount: number
  platformFee: number
  walkerAmount: number
  paymentStatus: string
  duplicate?: boolean
  _v?: string
}

export async function createPaymentIntent(
  params: CreatePaymentIntentRequest,
): Promise<CreatePaymentIntentResponse> {
  const { data, error } = await invokeEdgeFunction<CreatePaymentIntentResponse>(
    'create-payment-intent',
    { body: params },
  )

  if (error) {
    throw new Error(error)
  }

  if (!data) {
    throw new Error('Failed to create payment intent')
  }

  return data
}
