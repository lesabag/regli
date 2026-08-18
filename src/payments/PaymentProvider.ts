import type {
  AuthorizeProviderActivationFeeResponse,
  CaptureProviderActivationFeeResponse,
  CreatePaymentIntentRequest,
  CreatePaymentIntentResponse,
  CreateRefundRequest,
  CreateRefundResponse,
  CreateSellerAccountResponse,
  CreateSellerOnboardingLinkRequest,
  CreateSellerOnboardingLinkResponse,
  DetachPaymentMethodResponse,
  GetProviderActivationFeeQuoteResponse,
  PaymentMethodCustomerResponse,
  PaymentProviderId,
  PaymentSetupIntentResponse,
  PaymentWebhookPayload,
  PaymentWebhookResult,
  SellerStatus,
  VoidProviderActivationFeeResponse,
} from './types'

export interface PaymentProvider {
  readonly id: PaymentProviderId
  getProviderName(): string
  createSellerAccount(): Promise<CreateSellerAccountResponse>
  // Provider Account Activation Fee — one-time J5 authorize / capture / void.
  // Authoritative, server-provided fee quote (client displays, never computes it).
  getProviderActivationFeeQuote(): Promise<GetProviderActivationFeeQuoteResponse>
  authorizeProviderActivationFee(): Promise<AuthorizeProviderActivationFeeResponse>
  captureProviderActivationFee(): Promise<CaptureProviderActivationFeeResponse>
  voidProviderActivationFee(): Promise<VoidProviderActivationFeeResponse>
  createSellerOnboardingLink(
    request?: CreateSellerOnboardingLinkRequest,
  ): Promise<CreateSellerOnboardingLinkResponse>
  getSellerStatus(): Promise<SellerStatus>
  createPayment(request: CreatePaymentIntentRequest): Promise<CreatePaymentIntentResponse>
  createRefund(request: CreateRefundRequest): Promise<CreateRefundResponse>
  createSetup(): Promise<PaymentSetupIntentResponse>
  listSavedPaymentMethods(): Promise<PaymentMethodCustomerResponse>
  detachSavedPaymentMethod(paymentMethodId: string): Promise<DetachPaymentMethodResponse>
  handleWebhook(payload: PaymentWebhookPayload): Promise<PaymentWebhookResult>
}
