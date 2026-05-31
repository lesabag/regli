import { invokeEdgeFunction } from '../services/supabaseClient'

// ─── Internal backend-compat types ──────────────────────────────
// These map to Stripe pricing tiers. Never use in UI labels, wallet, or provider cards.
// Truth sources: duration_minutes, walk_requests.price, payoutTruth.ts
/** @internal Stripe pricing tier key — not for UI display */
export type ServiceType = 'quick' | 'standard' | 'energy'

/** @internal Backend labels — not for user-facing UI */
export const SERVICE_LABELS: Record<ServiceType, string> = {
  quick: 'Quick Walk',
  standard: 'Standard Walk',
  energy: 'Energy Walk',
}

/** @internal Base prices in agorot for create-payment-intent */
export const SERVICE_PRICES: Record<ServiceType, number> = {
  quick: 3000,
  standard: 5500,
  energy: 8000,
}

/** @internal Base prices in ILS — admin pricing only */
export const SERVICE_PRICES_ILS: Record<ServiceType, number> = {
  quick: 30,
  standard: 55,
  energy: 80,
}

// ─── Duration picker model ──────────────────────────────────────
export type DurationType = '20min' | '40min' | '60min'

export interface DurationOption {
  value: DurationType
  label: string
  minutes: number
  /** @internal Base price for admin display / pre-booking estimate */
  priceILS: number
  /** @internal Base price in agorot for create-payment-intent */
  priceAgorot: number
}

export const DURATION_OPTIONS: DurationOption[] = [
  { value: '20min', label: '20 min', minutes: 20, priceILS: 30, priceAgorot: 3000 },
  { value: '40min', label: '40 min', minutes: 40, priceILS: 55, priceAgorot: 5500 },
  { value: '60min', label: '60 min', minutes: 60, priceILS: 80, priceAgorot: 8000 },
]

/** @internal Map duration to Stripe pricing tier for create-payment-intent */
export const DURATION_TO_SERVICE: Record<DurationType, ServiceType> = {
  '20min': 'quick',
  '40min': 'standard',
  '60min': 'energy',
}

export const PLATFORM_FEE_PERCENT = 20

export type BookingTimingRequest = 'asap' | 'scheduled'
export type BookingPaymentFlow = 'saved_card' | 'native_payment_sheet' | 'native_payment_sheet_finalize'

// ─── Payment intent ──────────────────────────────────────────────
export interface CreatePaymentIntentRequest {
  dogName: string
  location: string
  notes?: string | null
  serviceType: ServiceType
  requestServiceType?: string
  walkerId?: string
  customerId?: string
  paymentMethodId?: string
  paymentIntentId?: string
  surgeMultiplier?: number
  bookingTiming?: BookingTimingRequest
  scheduledFor?: string | null
  priceAgorot?: number
  durationMinutes?: number
  dogCount?: number
  issueType?: string | null
  issueDescription?: string | null
  paymentFlow?: BookingPaymentFlow
}

export interface CreatePaymentIntentResponse {
  jobId?: string
  paymentIntentId: string
  clientSecret?: string
  paymentIntentClientSecret?: string
  customerId?: string
  customerEphemeralKeySecret?: string
  merchantIdentifier?: string
  merchantDisplayName?: string
  returnURL?: string
  paymentFlow?: BookingPaymentFlow
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

export interface PrepareNativePaymentSheetResponse extends CreatePaymentIntentResponse {
  paymentFlow: 'native_payment_sheet'
  paymentIntentClientSecret: string
  customerId: string
  customerEphemeralKeySecret: string
  merchantIdentifier: string
  merchantDisplayName: string
  returnURL: string
}

export async function prepareNativePaymentSheet(
  params: Omit<CreatePaymentIntentRequest, 'paymentMethodId' | 'paymentIntentId'> & {
    paymentFlow: 'native_payment_sheet'
    customerId: string
  },
): Promise<PrepareNativePaymentSheetResponse> {
  const data = await createPaymentIntent(params)
  if (
    data.paymentFlow !== 'native_payment_sheet' ||
    !data.paymentIntentClientSecret ||
    !data.customerId ||
    !data.customerEphemeralKeySecret ||
    !data.merchantIdentifier ||
    !data.merchantDisplayName ||
    !data.returnURL
  ) {
    throw new Error('Failed to prepare native payment sheet')
  }
  return data as PrepareNativePaymentSheetResponse
}

export async function finalizeNativePaymentSheet(
  params: Omit<CreatePaymentIntentRequest, 'paymentMethodId'> & {
    paymentFlow: 'native_payment_sheet_finalize'
    paymentIntentId: string
    customerId: string
  },
): Promise<CreatePaymentIntentResponse> {
  return createPaymentIntent(params)
}
