import type {
  CreateSellerAccountResponse,
  CreateSellerOnboardingLinkResponse,
  PaymentWebhookPayload,
  PaymentWebhookResult,
  SellerStatus,
} from '../types'

export type PayMeEnvironment = 'sandbox' | 'production'

export interface PayMeConfig {
  baseUrl: string | null
  partnerId: string | null
  clientKey: string | null
  environment: PayMeEnvironment
}

export interface PayMeRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  body?: unknown
  headers?: Record<string, string>
  timeoutMs?: number
}

export interface PayMeApiSuccess<T> {
  ok: true
  data: T
  status: number
}

export interface PayMeApiFailure {
  ok: false
  error: string
  status: number | null
  code: 'not_configured' | 'network_error' | 'http_error' | 'not_implemented'
  details?: string | null
}

export type PayMeApiResult<T> = PayMeApiSuccess<T> | PayMeApiFailure

export interface PayMeSellerDraftInput {
  profileId?: string | null
  email?: string | null
  fullName?: string | null
  phone?: string | null
}

export interface PayMeSellerDraftResponse extends CreateSellerAccountResponse {
  sandboxReady: boolean
}

export interface PayMeSellerStatusPayload {
  sellerId?: string | null
  status?: string | null
  verificationStatus?: string | null
  payoutsEnabled?: boolean | null
  chargesEnabled?: boolean | null
  onboardingUrl?: string | null
  [key: string]: unknown
}

export interface PayMeSellerStatusResponse extends SellerStatus {
  sandboxReady: boolean
}

export interface PayMeSellerOnboardingLinkResponse extends CreateSellerOnboardingLinkResponse {
  sandboxReady: boolean
}

export interface PayMeWebhookEvent extends PaymentWebhookPayload {
  id?: string | null
  type?: string | null
}

export interface PayMeWebhookParseResult extends PaymentWebhookResult {
  externalEventId: string | null
  eventType: string | null
}
