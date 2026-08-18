import { invokeEdgeFunction } from '../services/supabaseClient'
import type { PaymentProvider } from './PaymentProvider'
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
  PaymentSetupIntentResponse,
  PaymentWebhookPayload,
  PaymentWebhookResult,
  SellerStatus,
  VoidProviderActivationFeeResponse,
} from './types'

type StripeConnectStatusResponse = {
  connected: boolean
  stripe_connect_account_id: string | null
  stripe_connect_onboarding_complete: boolean
  payouts_enabled: boolean
  charges_enabled: boolean
}

type StripeConnectAccountResponse = {
  accountId?: string
  error?: string
}

type StripeOnboardingLinkResponse = {
  url?: string
  error?: string
}

type ManagePaymentMethodsResponse = {
  customerId: string
  cards: PaymentMethodCustomerResponse['cards']
}

export class StripeProvider implements PaymentProvider {
  readonly id = 'stripe' as const

  getProviderName(): string {
    return 'Stripe'
  }

  async createSellerAccount(): Promise<CreateSellerAccountResponse> {
    const { data, error } = await invokeEdgeFunction<StripeConnectAccountResponse>(
      'create-connect-account',
    )

    if (error) {
      throw new Error(error)
    }

    return {
      accountId: data?.accountId ?? null,
      provider: this.id,
      raw: data ?? null,
    }
  }

  // The Provider Account Activation Fee is a PayMe-track concept. Stripe (Connect)
  // has no equivalent, so these are unsupported and never invoked for Stripe. This
  // preserves Stripe behavior entirely — no Stripe path calls these methods.
  async getProviderActivationFeeQuote(): Promise<GetProviderActivationFeeQuoteResponse> {
    throw new Error('Stripe provider activation fee is not applicable.')
  }

  async authorizeProviderActivationFee(): Promise<AuthorizeProviderActivationFeeResponse> {
    throw new Error('Stripe provider activation fee is not applicable.')
  }

  async captureProviderActivationFee(): Promise<CaptureProviderActivationFeeResponse> {
    throw new Error('Stripe provider activation fee is not applicable.')
  }

  async voidProviderActivationFee(): Promise<VoidProviderActivationFeeResponse> {
    throw new Error('Stripe provider activation fee is not applicable.')
  }

  async createSellerOnboardingLink(
    request: CreateSellerOnboardingLinkRequest = {},
  ): Promise<CreateSellerOnboardingLinkResponse> {
    const { data, error } = await invokeEdgeFunction<StripeOnboardingLinkResponse>(
      'create-connect-onboarding-link',
      {
        body: {
          useNativeDeepLink: request.useNativeDeepLink === true,
        },
      },
    )

    if (error) {
      throw new Error(error)
    }

    return {
      url: data?.url ?? null,
      provider: this.id,
      raw: data ?? null,
    }
  }

  async getSellerStatus(): Promise<SellerStatus> {
    const { data, error } = await invokeEdgeFunction<StripeConnectStatusResponse>(
      'get-connect-status',
    )

    if (error) {
      throw new Error(error)
    }

    if (!data) {
      throw new Error('Failed to load payout account status.')
    }

    return {
      connected: data.connected,
      sellerAccountId: data.stripe_connect_account_id ?? null,
      onboardingComplete: data.stripe_connect_onboarding_complete,
      payoutsEnabled: data.payouts_enabled,
      chargesEnabled: data.charges_enabled,
      provider: this.id,
      raw: data,
    }
  }

  async createPayment(
    request: CreatePaymentIntentRequest,
  ): Promise<CreatePaymentIntentResponse> {
    const { data, error } = await invokeEdgeFunction<CreatePaymentIntentResponse>(
      'create-payment-intent',
      { body: request },
    )

    if (error) {
      throw new Error(error)
    }

    if (!data) {
      throw new Error('Failed to create payment intent')
    }

    return data
  }

  async createRefund(request: CreateRefundRequest): Promise<CreateRefundResponse> {
    const { data, error } = await invokeEdgeFunction<Record<string, unknown>>(
      'refund-payment',
      { body: request },
    )

    if (error) {
      throw new Error(error)
    }

    return {
      ...(data ?? {}),
      provider: this.id,
      raw: data ?? null,
    }
  }

  async createSetup(): Promise<PaymentSetupIntentResponse> {
    const { data, error } = await invokeEdgeFunction<PaymentSetupIntentResponse>(
      'manage-payment-method',
      { body: { action: 'create-setup-intent' } },
    )

    if (error) {
      throw new Error(error)
    }

    if (!data?.clientSecret) {
      throw new Error('Failed to create setup intent')
    }

    return data
  }

  async listSavedPaymentMethods(): Promise<PaymentMethodCustomerResponse> {
    const { data, error } = await invokeEdgeFunction<ManagePaymentMethodsResponse>(
      'manage-payment-method',
      { body: { action: 'get-or-create-customer' } },
    )

    if (error) {
      throw new Error(error)
    }

    return {
      customerId: data?.customerId ?? null,
      cards: data?.cards ?? [],
    }
  }

  async detachSavedPaymentMethod(
    paymentMethodId: string,
  ): Promise<DetachPaymentMethodResponse> {
    const { error } = await invokeEdgeFunction(
      'manage-payment-method',
      { body: { action: 'detach-payment-method', paymentMethodId } },
    )

    return { error }
  }

  async handleWebhook(_payload: PaymentWebhookPayload): Promise<PaymentWebhookResult> {
    return {
      handled: false,
      provider: this.id,
      message: 'Stripe webhooks are handled by supabase/functions/stripe-webhook.',
    }
  }
}
