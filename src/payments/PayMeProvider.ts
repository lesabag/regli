import type { PaymentProvider } from './PaymentProvider'
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
  PaymentSetupIntentResponse,
  PaymentWebhookPayload,
  PaymentWebhookResult,
  SellerStatus,
} from './types'

function notImplemented(operation: string): never {
  throw new Error(`PayMe ${operation} is not implemented yet.`)
}

export class PayMeProvider implements PaymentProvider {
  readonly id = 'payme' as const

  getProviderName(): string {
    return 'PayMe'
  }

  async createSellerAccount(): Promise<CreateSellerAccountResponse> {
    // TODO(payme): implement seller onboarding / account creation
    return notImplemented('seller onboarding')
  }

  async createSellerOnboardingLink(
    _request: CreateSellerOnboardingLinkRequest = {},
  ): Promise<CreateSellerOnboardingLinkResponse> {
    // TODO(payme): implement seller verification continuation / onboarding resume
    return notImplemented('seller onboarding link')
  }

  async getSellerStatus(): Promise<SellerStatus> {
    // TODO(payme): implement seller verification + payout readiness status
    return notImplemented('seller status')
  }

  async createPayment(
    _request: CreatePaymentIntentRequest,
  ): Promise<CreatePaymentIntentResponse> {
    // TODO(payme): implement charge creation
    // TODO(payme): implement platform fee support
    // TODO(payme): implement split payments / seller allocation
    return notImplemented('payment creation')
  }

  async createRefund(_request: CreateRefundRequest): Promise<CreateRefundResponse> {
    // TODO(payme): implement refunds
    return notImplemented('refunds')
  }

  async createSetup(): Promise<PaymentSetupIntentResponse> {
    // TODO(payme): implement tokenization / saved cards setup
    return notImplemented('payment method setup')
  }

  async listSavedPaymentMethods(): Promise<PaymentMethodCustomerResponse> {
    // TODO(payme): implement tokenized card listing
    return notImplemented('saved payment methods')
  }

  async detachSavedPaymentMethod(
    _paymentMethodId: string,
  ): Promise<DetachPaymentMethodResponse> {
    // TODO(payme): implement token removal / saved card detach
    return notImplemented('saved payment method detach')
  }

  async handleWebhook(_payload: PaymentWebhookPayload): Promise<PaymentWebhookResult> {
    // TODO(payme): implement webhooks
    // TODO(payme): implement payout lifecycle events
    return notImplemented('webhook handling')
  }
}
