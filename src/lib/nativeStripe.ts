import { Capacitor } from '@capacitor/core'

const STRIPE_PUBLISHABLE_KEY = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY ?? ''

export const APPLE_PAY_MERCHANT_ID = 'merchant.com.regli.app'
export const NATIVE_STRIPE_RETURN_URL = 'regli://stripe-payment-callback'

const isNativeIos = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios'

type StripePluginModule = typeof import('@capacitor-community/stripe')

type NativeStripeCapabilityStatus =
  | 'unsupported_platform'
  | 'missing_publishable_key'
  | 'ready_for_capability_checks'
  | 'payment_sheet_client_flow_missing'

export interface NativePaymentSheetCapability {
  supported: boolean
  initialized: boolean
  applePayEligible: boolean
  paymentSheetBackendReady: boolean
  canPresentPaymentSheet: boolean
  merchantIdentifier: string
  returnURL: string
  status: NativeStripeCapabilityStatus
  blockerReason: string | null
}

export interface NativePaymentSheetSession {
  paymentIntentClientSecret: string
  customerId: string
  customerEphemeralKeySecret: string
  merchantIdentifier: string
  merchantDisplayName: string
  returnURL: string
}

export interface NativePaymentSheetOptions {
  enableApplePay?: boolean
  countryCode?: string
  currencyCode?: string
}

export interface NativeApplePayOptions {
  amount: number
  label?: string
  countryCode?: string
  currency?: string
}

export interface NativePaymentSheetResult {
  status: 'completed' | 'canceled' | 'failed'
  error: string | null
}

export interface NativeApplePayResult {
  status: 'completed' | 'canceled' | 'failed' | 'unsupported'
  error: string | null
}

let stripeModulePromise: Promise<StripePluginModule | null> | null = null
let nativeStripeInitialized = false
let nativeStripeInitError: string | null = null

async function loadNativeStripeModule(): Promise<StripePluginModule | null> {
  if (!isNativeIos) return null
  if (!stripeModulePromise) {
    stripeModulePromise = import('@capacitor-community/stripe')
      .then((mod) => mod)
      .catch((error) => {
        nativeStripeInitError = error instanceof Error ? error.message : String(error)
        return null
      })
  }
  return stripeModulePromise
}

export async function initializeNativeStripe(): Promise<boolean> {
  if (!isNativeIos) return false
  if (nativeStripeInitialized) return true
  if (!STRIPE_PUBLISHABLE_KEY) {
    nativeStripeInitError = 'Missing VITE_STRIPE_PUBLISHABLE_KEY'
    return false
  }

  const mod = await loadNativeStripeModule()
  if (!mod) return false

  try {
    await mod.Stripe.initialize({
      publishableKey: STRIPE_PUBLISHABLE_KEY,
    })
    nativeStripeInitialized = true
    nativeStripeInitError = null
    return true
  } catch (error) {
    nativeStripeInitError = error instanceof Error ? error.message : String(error)
    return false
  }
}

export async function getNativePaymentSheetCapability(): Promise<NativePaymentSheetCapability> {
  if (!isNativeIos) {
    return {
      supported: false,
      initialized: false,
      applePayEligible: false,
      paymentSheetBackendReady: false,
      canPresentPaymentSheet: false,
      merchantIdentifier: APPLE_PAY_MERCHANT_ID,
      returnURL: NATIVE_STRIPE_RETURN_URL,
      status: 'unsupported_platform',
      blockerReason: null,
    }
  }

  if (!STRIPE_PUBLISHABLE_KEY) {
    return {
      supported: false,
      initialized: false,
      applePayEligible: false,
      paymentSheetBackendReady: false,
      canPresentPaymentSheet: false,
      merchantIdentifier: APPLE_PAY_MERCHANT_ID,
      returnURL: NATIVE_STRIPE_RETURN_URL,
      status: 'missing_publishable_key',
      blockerReason: 'Missing Stripe publishable key for native initialization',
    }
  }

  const initialized = await initializeNativeStripe()
  if (!initialized) {
    return {
      supported: false,
      initialized: false,
      applePayEligible: false,
      paymentSheetBackendReady: false,
      canPresentPaymentSheet: false,
      merchantIdentifier: APPLE_PAY_MERCHANT_ID,
      returnURL: NATIVE_STRIPE_RETURN_URL,
      status: 'missing_publishable_key',
      blockerReason: nativeStripeInitError ?? 'Failed to initialize native Stripe',
    }
  }

  const mod = await loadNativeStripeModule()
  if (!mod) {
    return {
      supported: false,
      initialized: false,
      applePayEligible: false,
      paymentSheetBackendReady: false,
      canPresentPaymentSheet: false,
      merchantIdentifier: APPLE_PAY_MERCHANT_ID,
      returnURL: NATIVE_STRIPE_RETURN_URL,
      status: 'missing_publishable_key',
      blockerReason: nativeStripeInitError ?? 'Failed to load native Stripe module',
    }
  }

  let applePayEligible = false
  try {
    await mod.Stripe.isApplePayAvailable()
    applePayEligible = true
    console.log('[ApplePay] available')
  } catch {
    applePayEligible = false
  }

  return {
    supported: true,
    initialized: true,
    applePayEligible,
    paymentSheetBackendReady: true,
    canPresentPaymentSheet: true,
    merchantIdentifier: APPLE_PAY_MERCHANT_ID,
    returnURL: NATIVE_STRIPE_RETURN_URL,
    status: 'ready_for_capability_checks',
    blockerReason: null,
  }
}

export async function presentNativePaymentSheet(
  session: NativePaymentSheetSession,
  options: NativePaymentSheetOptions = {},
): Promise<NativePaymentSheetResult> {
  if (!isNativeIos) {
    console.log('[native_payment_sheet] present blocked unsupported platform')
    return {
      status: 'failed',
      error: 'Native PaymentSheet is only supported on iOS devices.',
    }
  }

  console.log('[native_payment_sheet] initPaymentSheet start', {
    merchantIdentifier: session.merchantIdentifier,
    customerId: session.customerId,
    hasClientSecret: !!session.paymentIntentClientSecret,
    hasEphemeralKey: !!session.customerEphemeralKeySecret,
  })

  const initialized = await initializeNativeStripe()
  if (!initialized) {
    console.log('[native_payment_sheet] initPaymentSheet error', {
      error: nativeStripeInitError ?? 'Failed to initialize native Stripe.',
    })
    return {
      status: 'failed',
      error: nativeStripeInitError ?? 'Failed to initialize native Stripe.',
    }
  }

  const mod = await loadNativeStripeModule()
  if (!mod) {
    console.log('[native_payment_sheet] initPaymentSheet error', {
      error: nativeStripeInitError ?? 'Failed to load native Stripe module.',
    })
    return {
      status: 'failed',
      error: nativeStripeInitError ?? 'Failed to load native Stripe module.',
    }
  }

  try {
    const enableApplePay = options.enableApplePay === true
    const countryCode = options.countryCode ?? 'IL'
    const currencyCode = options.currencyCode ?? 'ILS'

    if (enableApplePay) {
      console.log('[native_payment_sheet] applePay config enabled', {
        merchantIdentifier: session.merchantIdentifier,
        countryCode,
        currencyCode,
      })
    } else {
      console.log('[native_payment_sheet] applePay config skipped', {
        merchantIdentifier: session.merchantIdentifier,
      })
    }

    await mod.Stripe.createPaymentSheet({
      paymentIntentClientSecret: session.paymentIntentClientSecret,
      customerId: session.customerId,
      customerEphemeralKeySecret: session.customerEphemeralKeySecret,
      merchantDisplayName: session.merchantDisplayName,
      returnURL: session.returnURL,
      enableApplePay,
      applePayMerchantId: session.merchantIdentifier,
      countryCode,
      currencyCode,
      paymentMethodLayout: 'automatic',
      style: 'alwaysLight',
    })
    console.log('[native_payment_sheet] initPaymentSheet success')
  } catch (error) {
    console.log('[native_payment_sheet] initPaymentSheet error', {
      error: error instanceof Error ? error.message : String(error),
    })
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : 'Failed to prepare payment sheet.',
    }
  }

  try {
    console.log('[native_payment_sheet] presentPaymentSheet start')
    const { paymentResult } = await mod.Stripe.presentPaymentSheet()

    if (paymentResult === mod.PaymentSheetEventsEnum.Completed) {
      console.log('[native_payment_sheet] presentPaymentSheet success')
      return { status: 'completed', error: null }
    }
    if (paymentResult === mod.PaymentSheetEventsEnum.Canceled) {
      console.log('[native_payment_sheet] presentPaymentSheet cancel')
      return { status: 'canceled', error: null }
    }

    console.log('[native_payment_sheet] presentPaymentSheet error', {
      paymentResult,
    })
    return {
      status: 'failed',
      error: 'Payment sheet did not complete successfully.',
    }
  } catch (error) {
    console.log('[native_payment_sheet] presentPaymentSheet error', {
      error: error instanceof Error ? error.message : String(error),
    })
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : 'Payment sheet failed.',
    }
  }
}

export async function presentNativeApplePay(
  session: NativePaymentSheetSession,
  options: NativeApplePayOptions,
): Promise<NativeApplePayResult> {
  if (!isNativeIos) {
    console.log('[ApplePayDirect] unsupported', {
      reason: 'unsupported_platform',
    })
    return {
      status: 'unsupported',
      error: 'Direct Apple Pay is only supported on iOS devices.',
    }
  }

  const initialized = await initializeNativeStripe()
  if (!initialized) {
    console.log('[ApplePayDirect] error', {
      error: nativeStripeInitError ?? 'Failed to initialize native Stripe.',
    })
    return {
      status: 'failed',
      error: nativeStripeInitError ?? 'Failed to initialize native Stripe.',
    }
  }

  const mod = await loadNativeStripeModule()
  if (!mod) {
    console.log('[ApplePayDirect] error', {
      error: nativeStripeInitError ?? 'Failed to load native Stripe module.',
    })
    return {
      status: 'failed',
      error: nativeStripeInitError ?? 'Failed to load native Stripe module.',
    }
  }

  if (typeof mod.Stripe.createApplePay !== 'function' || typeof mod.Stripe.presentApplePay !== 'function') {
    console.log('[ApplePayDirect] unsupported', {
      reason: 'plugin_api_missing',
    })
    return {
      status: 'unsupported',
      error: 'Direct Apple Pay is not supported by the installed Stripe plugin.',
    }
  }

  console.log('[ApplePayDirect] supported', {
    merchantIdentifier: session.merchantIdentifier,
    countryCode: options.countryCode ?? 'IL',
    currency: options.currency ?? 'ILS',
  })

  try {
    await mod.Stripe.createApplePay({
      paymentIntentClientSecret: session.paymentIntentClientSecret,
      paymentSummaryItems: [
        {
          label: options.label ?? session.merchantDisplayName,
          amount: options.amount,
        },
      ],
      merchantIdentifier: session.merchantIdentifier,
      countryCode: options.countryCode ?? 'IL',
      currency: options.currency ?? 'ILS',
    })
  } catch (error) {
    console.log('[ApplePayDirect] error', {
      stage: 'create',
      error: error instanceof Error ? error.message : String(error),
    })
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : 'Failed to prepare Apple Pay.',
    }
  }

  try {
    console.log('[ApplePayDirect] present start')
    const { paymentResult } = await mod.Stripe.presentApplePay()

    if (paymentResult === mod.ApplePayEventsEnum.Completed) {
      console.log('[ApplePayDirect] success')
      return {
        status: 'completed',
        error: null,
      }
    }

    if (paymentResult === mod.ApplePayEventsEnum.Canceled) {
      console.log('[ApplePayDirect] cancel')
      return {
        status: 'canceled',
        error: null,
      }
    }

    console.log('[ApplePayDirect] error', {
      stage: 'present',
      paymentResult,
    })
    return {
      status: 'failed',
      error: 'Apple Pay did not complete successfully.',
    }
  } catch (error) {
    console.log('[ApplePayDirect] error', {
      stage: 'present',
      error: error instanceof Error ? error.message : String(error),
    })
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : 'Apple Pay failed.',
    }
  }
}

export async function handleNativeStripeURLCallback(url: string): Promise<boolean> {
  if (!isNativeIos || !url) return false
  const initialized = await initializeNativeStripe()
  if (!initialized) return false

  const mod = await loadNativeStripeModule()
  if (!mod?.Stripe.handleURLCallback) return false

  try {
    await mod.Stripe.handleURLCallback({ url })
    return true
  } catch {
    return false
  }
}
