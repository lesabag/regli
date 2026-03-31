import { invokeEdgeFunction } from '../services/supabaseClient'

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

export interface CreatePaymentIntentRequest {
  dogName: string
  location: string
  notes?: string
  serviceType: ServiceType
  walkerId: string
}

export interface CreatePaymentIntentResponse {
  jobId: string
  paymentIntentId: string
  clientSecret: string
  amount: number
  platformFee: number
  walkerAmount: number
  paymentStatus: string
}

export async function createPaymentIntent(
  params: CreatePaymentIntentRequest
): Promise<{ data: CreatePaymentIntentResponse | null; error: string | null }> {
  const { data, error } = await invokeEdgeFunction<CreatePaymentIntentResponse>(
    'create-payment-intent',
    { body: params }
  )

  return { data, error }
}
