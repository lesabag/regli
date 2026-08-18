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

// Client-safe responses from the activation-fee edge functions. The client never
// calls PayMe directly and never sends/receives card, bank, KYC, or secret data.
type ActivationEdgeResponse = {
  success?: boolean
  skipped?: boolean
  state?: string
  saleUrl?: string | null
  authorizationExpiresAt?: string | null
}

// Server-authoritative fee quote (see payme-provider-activation-quote). Carries
// only safe numeric config — no secrets.
type ActivationQuoteEdgeResponse = {
  success?: boolean
  currency?: string
  netAgorot?: number
  vatAgorot?: number
  grossAgorot?: number
}

function notImplemented(operation: string): never {
  throw new Error(`PayMe ${operation} is not implemented yet.`)
}

// Client-safe response from the create-payme-seller edge function. Never carries
// PayMe secrets (see supabase/functions/create-payme-seller).
type PaymeCreateSellerEdgeResponse = {
  success?: boolean
  skipped?: boolean
  sellerPaymeId?: string
  onboardingStatus?: string
  signupUrl?: string | null
}

export class PayMeProvider implements PaymentProvider {
  readonly id = 'payme' as const

  getProviderName(): string {
    return 'PayMe'
  }

  async createSellerAccount(): Promise<CreateSellerAccountResponse> {
    // Phase 1: create the PayMe Marketplace seller via the secure edge function.
    // `source: 'onboarding'` marks this as the automatic provider-onboarding path,
    // which the server gates behind PAYME_SELLER_ONBOARDING_ENABLED.
    const { data, error } = await invokeEdgeFunction<PaymeCreateSellerEdgeResponse>(
      'create-payme-seller',
      { body: { source: 'onboarding' } },
    )

    if (error) {
      throw new Error(error)
    }

    return {
      accountId: data?.sellerPaymeId ?? null,
      provider: this.id,
      raw: data ?? null,
    }
  }

  async getProviderActivationFeeQuote(): Promise<GetProviderActivationFeeQuoteResponse> {
    // Authoritative activation-fee quote. The amount is decided server-side and is
    // the SAME value the J5 authorization charges; the client only displays it.
    const { data, error } = await invokeEdgeFunction<ActivationQuoteEdgeResponse>(
      'payme-provider-activation-quote',
    )
    if (error) throw new Error(error)
    const valid =
      data?.success === true &&
      typeof data.currency === 'string' &&
      typeof data.netAgorot === 'number' &&
      typeof data.vatAgorot === 'number' &&
      typeof data.grossAgorot === 'number'
    return {
      success: valid,
      provider: this.id,
      quote: valid
        ? {
            currency: data!.currency as string,
            netAgorot: data!.netAgorot as number,
            vatAgorot: data!.vatAgorot as number,
            grossAgorot: data!.grossAgorot as number,
          }
        : null,
      raw: data ?? null,
    }
  }

  async authorizeProviderActivationFee(): Promise<AuthorizeProviderActivationFeeResponse> {
    // J5 authorization for the one-time Provider Account Activation Fee. All PayMe
    // interaction happens server-side; the provider_id is derived from the JWT.
    // Gated OFF server-side by PAYME_SELLER_ONBOARDING_ENABLED (returns skipped).
    const { data, error } = await invokeEdgeFunction<ActivationEdgeResponse>(
      'payme-authorize-provider-activation',
    )
    if (error) throw new Error(error)
    return {
      success: data?.success === true,
      provider: this.id,
      state: data?.state,
      saleUrl: data?.saleUrl ?? null,
      authorizationExpiresAt: data?.authorizationExpiresAt ?? null,
      skipped: data?.skipped === true,
      raw: data ?? null,
    }
  }

  async captureProviderActivationFee(): Promise<CaptureProviderActivationFeeResponse> {
    // Server-side capture. Only succeeds after a VERIFIED kyc_approved state and
    // within the 168h window; the server enforces single-capture + amount limits.
    const { data, error } = await invokeEdgeFunction<ActivationEdgeResponse>(
      'payme-capture-provider-activation',
    )
    if (error) throw new Error(error)
    return {
      success: data?.success === true,
      provider: this.id,
      state: data?.state,
      skipped: data?.skipped === true,
      raw: data ?? null,
    }
  }

  async voidProviderActivationFee(): Promise<VoidProviderActivationFeeResponse> {
    // Explicit server-side void of an uncaptured authorization (cancel/reject).
    const { data, error } = await invokeEdgeFunction<ActivationEdgeResponse>(
      'payme-void-provider-activation',
    )
    if (error) throw new Error(error)
    return {
      success: data?.success === true,
      provider: this.id,
      state: data?.state,
      skipped: data?.skipped === true,
      raw: data ?? null,
    }
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
