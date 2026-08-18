export type PaymentProviderId = 'stripe' | 'payme'
export type PaymentCountryCode = string

export interface PaymentProviderResolverInput {
  provider?: PaymentProviderId | null
  countryCode?: PaymentCountryCode | null
  market?: string | null
}

// These backend pricing keys are preserved for compatibility with the current
// create-payment-intent contract. They are not user-facing labels.
export type ServiceType = 'quick' | 'standard' | 'energy'

export type DurationType = '20min' | '40min' | '60min'

export type BookingTimingRequest = 'asap' | 'scheduled'
export type BookingPaymentFlow =
  | 'saved_card'
  | 'native_payment_sheet'
  | 'native_payment_sheet_finalize'

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

export interface PrepareNativePaymentSheetResponse extends CreatePaymentIntentResponse {
  paymentFlow: 'native_payment_sheet'
  paymentIntentClientSecret: string
  customerId: string
  customerEphemeralKeySecret: string
  merchantIdentifier: string
  merchantDisplayName: string
  returnURL: string
}

export interface SavedCard {
  id: string
  brand: string
  last4: string
  expMonth?: number
  expYear?: number
}

export interface PaymentMethodCustomerResponse {
  customerId: string | null
  cards: SavedCard[]
}

export interface PaymentSetupIntentResponse {
  clientSecret: string
}

export interface DetachPaymentMethodResponse {
  error: string | null
}

export interface SellerStatus {
  connected: boolean
  sellerAccountId: string | null
  onboardingComplete: boolean
  payoutsEnabled: boolean
  chargesEnabled: boolean
  provider: PaymentProviderId
  raw?: unknown
}

export interface CreateSellerAccountResponse {
  accountId: string | null
  provider: PaymentProviderId
  raw?: unknown
}

// ---------------------------------------------------------------------------
// Provider Account Activation Fee (one-time J5 authorize -> capture / void).
// These carry ONLY safe, client-visible orchestration data — never card, bank,
// KYC, secret, or PayMe credential values.
// ---------------------------------------------------------------------------

// Authoritative, server-provided activation-fee quote. The client displays these
// values but never computes them (see src/config/activationFee.ts). All amounts are
// in agorot; the server charges exactly `grossAgorot` for the J5 authorization.
export interface ProviderActivationFeeQuote {
  currency: string
  netAgorot: number
  vatAgorot: number
  grossAgorot: number
}

export interface GetProviderActivationFeeQuoteResponse {
  success: boolean
  provider: PaymentProviderId
  quote: ProviderActivationFeeQuote | null
  raw?: unknown
}

export interface AuthorizeProviderActivationFeeResponse {
  success: boolean
  provider: PaymentProviderId
  // Regli-internal activation state after the call (see ProviderActivationState).
  state?: string
  // Hosted PayMe J5 page where the provider enters their card. Never null-safe to
  // navigate elsewhere — the provider only ever sees PayMe's own page.
  saleUrl?: string | null
  authorizationExpiresAt?: string | null
  // True when the server flag left the operation a no-op (nothing authorized).
  skipped?: boolean
  raw?: unknown
}

export interface CaptureProviderActivationFeeResponse {
  success: boolean
  provider: PaymentProviderId
  state?: string
  skipped?: boolean
  raw?: unknown
}

export interface VoidProviderActivationFeeResponse {
  success: boolean
  provider: PaymentProviderId
  state?: string
  skipped?: boolean
  raw?: unknown
}

export interface CreateSellerOnboardingLinkRequest {
  useNativeDeepLink?: boolean
}

export interface CreateSellerOnboardingLinkResponse {
  url: string | null
  provider: PaymentProviderId
  raw?: unknown
}

export interface CreateRefundRequest {
  paymentIntentId?: string | null
  paymentId?: string | null
  refundId?: string | null
  reason?: string | null
  amountAgorot?: number | null
  jobId?: string | null
  [key: string]: unknown
}

export interface CreateRefundResponse {
  success?: boolean
  error?: string
  code?: string
  details?: string
  provider: PaymentProviderId
  raw?: unknown
}

export interface PaymentWebhookPayload {
  [key: string]: unknown
}

export interface PaymentWebhookResult {
  handled: boolean
  provider: PaymentProviderId
  message?: string
}
