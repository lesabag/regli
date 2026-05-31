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
  | 'payment_sheet_backend_missing'

export interface NativePaymentSheetCapability {
  supported: boolean
  initialized: boolean
  applePayEligible: boolean
  canPresentPaymentSheet: boolean
  merchantIdentifier: string
  returnURL: string
  status: NativeStripeCapabilityStatus
  blockerReason: string | null
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
  } catch {
    applePayEligible = false
  }

  return {
    supported: true,
    initialized: true,
    applePayEligible,
    canPresentPaymentSheet: false,
    merchantIdentifier: APPLE_PAY_MERCHANT_ID,
    returnURL: NATIVE_STRIPE_RETURN_URL,
    status: 'payment_sheet_backend_missing',
    blockerReason:
      'Booking payments still use create-payment-intent with a saved paymentMethodId, so a native PaymentSheet client-secret flow is not wired yet.',
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
