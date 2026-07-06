import type {
  CreatePaymentIntentRequest,
  CreatePaymentIntentResponse,
  CreateRefundRequest,
  CreateRefundResponse,
  CreateSellerAccountResponse,
  CreateSellerOnboardingLinkRequest,
  CreateSellerOnboardingLinkResponse,
  DetachPaymentMethodResponse,
  PaymentMethodCustomerResponse,
  PaymentProviderId,
  PaymentSetupIntentResponse,
  PaymentWebhookPayload,
  PaymentWebhookResult,
  SellerStatus,
} from './types'

export interface PaymentProvider {
  readonly id: PaymentProviderId
  getProviderName(): string
  createSellerAccount(): Promise<CreateSellerAccountResponse>
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
