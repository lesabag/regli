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
import {
  createSellerDraft,
  createSellerOnboardingLink,
  getPayMeConfig,
  getSellerStatus as getPayMeSellerStatus,
  isPayMeConfigured,
  parsePayMeWebhookEvent,
  PayMeError,
} from './payme'

function notImplemented(operation: string, detail: string): never {
  throw new Error(`PayMe ${operation} is not implemented yet. ${detail}`)
}

function assertProviderConfigured(): void {
  if (!isPayMeConfigured()) {
    const config = getPayMeConfig()
    throw new PayMeError(
      `PayMe ${config.environment} is not configured. Set VITE_PAYME_BASE_URL, VITE_PAYME_PARTNER_ID, and VITE_PAYME_CLIENT_KEY.`,
      { code: 'not_configured' },
    )
  }
}

export class PayMeProvider implements PaymentProvider {
  readonly id = 'payme' as const

  getProviderName(): string {
    return 'PayMe'
  }

  async createSellerAccount(): Promise<CreateSellerAccountResponse> {
    assertProviderConfigured()
    return createSellerDraft({})
  }

  async createSellerOnboardingLink(
    request: CreateSellerOnboardingLinkRequest = {},
  ): Promise<CreateSellerOnboardingLinkResponse> {
    assertProviderConfigured()
    return createSellerOnboardingLink(request)
  }

  async getSellerStatus(): Promise<SellerStatus> {
    assertProviderConfigured()
    return getPayMeSellerStatus()
  }

  async createPayment(
    _request: CreatePaymentIntentRequest,
  ): Promise<CreatePaymentIntentResponse> {
    // TODO(payme): implement charge creation
    // TODO(payme): implement platform fee support
    // TODO(payme): implement split payments / seller allocation
    return notImplemented(
      'payment creation',
      'Create sandbox charge flow after seller onboarding and webhook verification are confirmed.',
    )
  }

  async createRefund(_request: CreateRefundRequest): Promise<CreateRefundResponse> {
    // TODO(payme): implement refunds
    return notImplemented(
      'refunds',
      'Wire refunds after sandbox payment capture and event reconciliation are available.',
    )
  }

  async createSetup(): Promise<PaymentSetupIntentResponse> {
    // TODO(payme): implement tokenization / saved cards setup
    return notImplemented(
      'payment method setup',
      'Route card tokenization through a server-side Edge Function if PayMe requires secret signing.',
    )
  }

  async listSavedPaymentMethods(): Promise<PaymentMethodCustomerResponse> {
    // TODO(payme): implement tokenized card listing
    return notImplemented(
      'saved payment methods',
      'Expose saved-card listing after tokenization and customer vault behavior are defined.',
    )
  }

  async detachSavedPaymentMethod(
    _paymentMethodId: string,
  ): Promise<DetachPaymentMethodResponse> {
    // TODO(payme): implement token removal / saved card detach
    return notImplemented(
      'saved payment method detach',
      'Implement token deletion after PayMe vault APIs are confirmed.',
    )
  }

  async handleWebhook(payload: PaymentWebhookPayload): Promise<PaymentWebhookResult> {
    // TODO(payme): implement webhooks
    // TODO(payme): implement payout lifecycle events
    assertProviderConfigured()
    return parsePayMeWebhookEvent(payload)
  }
}
