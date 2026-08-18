import type { PaymentProvider } from './PaymentProvider'
import { PayMeProvider } from './PayMeProvider'
import { StripeProvider } from './StripeProvider'
import { resolvePaymentProvider } from './providerResolver'
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
  PaymentProviderResolverInput,
  PaymentSetupIntentResponse,
  PaymentWebhookPayload,
  PaymentWebhookResult,
  PrepareNativePaymentSheetResponse,
  SellerStatus,
  VoidProviderActivationFeeResponse,
} from './types'

const paymentProviders: Record<PaymentProviderId, PaymentProvider> = {
  stripe: new StripeProvider(),
  payme: new PayMeProvider(),
}

export class PaymentService {
  private readonly defaultContext: PaymentProviderResolverInput

  constructor(defaultContext: PaymentProviderResolverInput = {}) {
    this.defaultContext = defaultContext
  }

  private resolveContext(
    context: PaymentProviderResolverInput = {},
  ): PaymentProviderResolverInput {
    return {
      ...this.defaultContext,
      ...context,
    }
  }

  private getProvider(
    context: PaymentProviderResolverInput = {},
  ): PaymentProvider {
    const providerId = resolvePaymentProvider(this.resolveContext(context))
    return paymentProviders[providerId]
  }

  getProviderId(context: PaymentProviderResolverInput = {}): PaymentProviderId {
    return this.getProvider(context).id
  }

  getProviderName(context: PaymentProviderResolverInput = {}): string {
    return this.getProvider(context).getProviderName()
  }

  createSellerAccount(
    context: PaymentProviderResolverInput = {},
  ): Promise<CreateSellerAccountResponse> {
    return this.getProvider(context).createSellerAccount()
  }

  getProviderActivationFeeQuote(
    context: PaymentProviderResolverInput = {},
  ): Promise<GetProviderActivationFeeQuoteResponse> {
    return this.getProvider(context).getProviderActivationFeeQuote()
  }

  authorizeProviderActivationFee(
    context: PaymentProviderResolverInput = {},
  ): Promise<AuthorizeProviderActivationFeeResponse> {
    return this.getProvider(context).authorizeProviderActivationFee()
  }

  captureProviderActivationFee(
    context: PaymentProviderResolverInput = {},
  ): Promise<CaptureProviderActivationFeeResponse> {
    return this.getProvider(context).captureProviderActivationFee()
  }

  voidProviderActivationFee(
    context: PaymentProviderResolverInput = {},
  ): Promise<VoidProviderActivationFeeResponse> {
    return this.getProvider(context).voidProviderActivationFee()
  }

  createSellerOnboardingLink(
    request: CreateSellerOnboardingLinkRequest = {},
    context: PaymentProviderResolverInput = {},
  ): Promise<CreateSellerOnboardingLinkResponse> {
    return this.getProvider(context).createSellerOnboardingLink(request)
  }

  getSellerStatus(
    context: PaymentProviderResolverInput = {},
  ): Promise<SellerStatus> {
    return this.getProvider(context).getSellerStatus()
  }

  createPayment(
    request: CreatePaymentIntentRequest,
    context: PaymentProviderResolverInput = {},
  ): Promise<CreatePaymentIntentResponse> {
    return this.getProvider(context).createPayment(request)
  }

  async prepareNativePaymentSheet(
    request: Omit<CreatePaymentIntentRequest, 'paymentMethodId' | 'paymentIntentId'> & {
      paymentFlow: 'native_payment_sheet'
      customerId: string
    },
    context: PaymentProviderResolverInput = {},
  ): Promise<PrepareNativePaymentSheetResponse> {
    const data = await this.createPayment(request, context)
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

  finalizeNativePaymentSheet(
    request: Omit<CreatePaymentIntentRequest, 'paymentMethodId'> & {
      paymentFlow: 'native_payment_sheet_finalize'
      paymentIntentId: string
      customerId: string
    },
    context: PaymentProviderResolverInput = {},
  ): Promise<CreatePaymentIntentResponse> {
    return this.createPayment(request, context)
  }

  createRefund(
    request: CreateRefundRequest,
    context: PaymentProviderResolverInput = {},
  ): Promise<CreateRefundResponse> {
    return this.getProvider(context).createRefund(request)
  }

  createSetup(
    context: PaymentProviderResolverInput = {},
  ): Promise<PaymentSetupIntentResponse> {
    return this.getProvider(context).createSetup()
  }

  listSavedPaymentMethods(
    context: PaymentProviderResolverInput = {},
  ): Promise<PaymentMethodCustomerResponse> {
    return this.getProvider(context).listSavedPaymentMethods()
  }

  detachSavedPaymentMethod(
    paymentMethodId: string,
    context: PaymentProviderResolverInput = {},
  ): Promise<DetachPaymentMethodResponse> {
    return this.getProvider(context).detachSavedPaymentMethod(paymentMethodId)
  }

  handleWebhook(
    payload: PaymentWebhookPayload,
    context: PaymentProviderResolverInput = {},
  ): Promise<PaymentWebhookResult> {
    return this.getProvider(context).handleWebhook(payload)
  }
}
