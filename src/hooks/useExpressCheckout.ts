import { useEffect, useRef, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { stripePromise } from '../lib/stripe'
import type { PaymentRequest, Stripe } from '@stripe/stripe-js'

export type PaymentMethodType = 'card' | 'apple_pay' | 'google_pay'

export interface ExpressCheckoutCapabilities {
  loading: boolean
  applePayAvailable: boolean
  googlePayAvailable: boolean
  expressCheckoutSupported: boolean
  availableMethods: PaymentMethodType[]
  preferredMethod: PaymentMethodType
  nativeApplePayReady: boolean
  applePayMerchantId: string | null
  applePayBlockedReason: string | null
}

const STRIPE_COUNTRY = 'IL'
const APPLE_PAY_MERCHANT_ID = 'merchant.com.regli.app'

const UNSUPPORTED_PAYMENT_REQUEST_COUNTRIES = new Set(['IL'])
const isNativeIos = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios'

const CARD_ONLY: ExpressCheckoutCapabilities = {
  loading: false,
  applePayAvailable: false,
  googlePayAvailable: false,
  expressCheckoutSupported: false,
  availableMethods: ['card'],
  preferredMethod: 'card',
  nativeApplePayReady: false,
  applePayMerchantId: APPLE_PAY_MERCHANT_ID,
  applePayBlockedReason: null,
}

export default function useExpressCheckout(): ExpressCheckoutCapabilities {
  const nativeApplePayBlockedState: ExpressCheckoutCapabilities = {
    ...CARD_ONLY,
    applePayBlockedReason: isNativeIos ? 'payment_sheet_flow_not_integrated' : null,
  }
  const [capabilities, setCapabilities] = useState<ExpressCheckoutCapabilities>(
    isNativeIos
      ? nativeApplePayBlockedState
      : UNSUPPORTED_PAYMENT_REQUEST_COUNTRIES.has(STRIPE_COUNTRY)
        ? CARD_ONLY
        : { ...CARD_ONLY, loading: true },
  )
  const detectedRef = useRef(false)

  useEffect(() => {
    if (detectedRef.current) return
    detectedRef.current = true

    // TODO: Apple Pay support
    // Real iOS Apple Pay for bookings needs a native Stripe SDK / PaymentSheet
    // bridge. This repo currently uses stripe-js Elements only, so keep Apple
    // Pay hidden until that native confirmation path exists.
    if (isNativeIos) {
      setCapabilities(nativeApplePayBlockedState)
      return
    }

    if (UNSUPPORTED_PAYMENT_REQUEST_COUNTRIES.has(STRIPE_COUNTRY)) {
      console.log('[ExpressCheckout] skipped — PaymentRequest not supported for country', STRIPE_COUNTRY)
      return
    }

    let cancelled = false

    async function detect() {
      console.log('[ExpressCheckout] starting capability detection')

      let stripe: Stripe | null = null
      try {
        stripe = await stripePromise
      } catch (err) {
        console.warn('[ExpressCheckout] Stripe failed to load', err)
      }

      if (!stripe || cancelled) {
        console.log('[ExpressCheckout] Stripe unavailable, falling back to card-only')
        if (!cancelled) setCapabilities(CARD_ONLY)
        return
      }

      let paymentRequest: PaymentRequest | null = null
      try {
        paymentRequest = stripe.paymentRequest({
          country: STRIPE_COUNTRY,
          currency: 'ils',
          total: { label: 'Regli', amount: 0 },
          requestPayerName: false,
          requestPayerEmail: false,
        })
      } catch (err) {
        console.warn('[ExpressCheckout] paymentRequest creation failed', err)
      }

      if (!paymentRequest || cancelled) {
        console.log('[ExpressCheckout] PaymentRequest API unavailable')
        if (!cancelled) setCapabilities(CARD_ONLY)
        return
      }

      let result: { applePay?: boolean; googlePay?: boolean } | null = null
      try {
        result = await paymentRequest.canMakePayment()
      } catch (err) {
        console.warn('[ExpressCheckout] canMakePayment failed', err)
      }

      if (cancelled) return

      const applePayAvailable = !!result?.applePay
      const googlePayAvailable = !!result?.googlePay
      const expressCheckoutSupported = applePayAvailable || googlePayAvailable

      const availableMethods: PaymentMethodType[] = []
      if (applePayAvailable) availableMethods.push('apple_pay')
      if (googlePayAvailable) availableMethods.push('google_pay')
      availableMethods.push('card')

      const preferredMethod: PaymentMethodType = applePayAvailable
        ? 'apple_pay'
        : googlePayAvailable
          ? 'google_pay'
          : 'card'

      console.log('[ApplePayAvailability]', applePayAvailable ? 'supported' : 'not available')
      console.log('[GooglePayAvailability]', googlePayAvailable ? 'supported' : 'not available')
      console.log('[ExpressCheckout] detection complete', {
        applePayAvailable,
        googlePayAvailable,
        expressCheckoutSupported,
        preferredMethod,
      })

      setCapabilities({
        loading: false,
        applePayAvailable,
        googlePayAvailable,
        expressCheckoutSupported,
        availableMethods,
        preferredMethod,
        nativeApplePayReady: false,
        applePayMerchantId: APPLE_PAY_MERCHANT_ID,
        applePayBlockedReason: null,
      })
    }

    void detect()

    return () => {
      cancelled = true
    }
  }, [nativeApplePayBlockedState])

  return capabilities
}
