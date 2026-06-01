import { useEffect, useState } from 'react'
import {
  getNativePaymentSheetCapability,
  type NativePaymentSheetCapability,
} from '../lib/nativeStripe'

const FALLBACK_CAPABILITY: NativePaymentSheetCapability = {
  supported: false,
  initialized: false,
  applePayEligible: false,
  supportsDirectApplePay: false,
  paymentSheetBackendReady: false,
  canPresentPaymentSheet: false,
  merchantIdentifier: 'merchant.com.regli.app',
  returnURL: 'regli://stripe-payment-callback',
  status: 'unsupported_platform',
  blockerReason: null,
}

export default function useNativePaymentSheet(): NativePaymentSheetCapability {
  const [capability, setCapability] = useState<NativePaymentSheetCapability>(FALLBACK_CAPABILITY)

  useEffect(() => {
    let cancelled = false
    let retryTimeoutId: ReturnType<typeof setTimeout> | null = null

    const refreshCapability = () => {
      void getNativePaymentSheetCapability()
        .then((next) => {
          if (!cancelled) {
            setCapability(next)
          }
        })
        .catch(() => {
          if (!cancelled) {
            setCapability(FALLBACK_CAPABILITY)
          }
        })
    }

    refreshCapability()
    retryTimeoutId = setTimeout(() => {
      refreshCapability()
    }, 1500)

    const handleVisibilityOrFocus = () => {
      refreshCapability()
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('focus', handleVisibilityOrFocus)
      window.addEventListener('pageshow', handleVisibilityOrFocus)
      document.addEventListener('visibilitychange', handleVisibilityOrFocus)
    }

    return () => {
      cancelled = true
      if (retryTimeoutId) clearTimeout(retryTimeoutId)
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', handleVisibilityOrFocus)
        window.removeEventListener('pageshow', handleVisibilityOrFocus)
        document.removeEventListener('visibilitychange', handleVisibilityOrFocus)
      }
    }
  }, [])

  return capability
}
