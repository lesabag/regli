import { useEffect, useState } from 'react'
import {
  getNativePaymentSheetCapability,
  type NativePaymentSheetCapability,
} from '../lib/nativeStripe'

const APPLE_PAY_CAPABILITY_CACHE_MS = 5 * 60 * 1000

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

let cachedCapability: NativePaymentSheetCapability | null = null
let cachedCapabilityAt = 0
let capabilityRequestInFlight: Promise<NativePaymentSheetCapability> | null = null

export default function useNativePaymentSheet(): NativePaymentSheetCapability {
  const [capability, setCapability] = useState<NativePaymentSheetCapability>(FALLBACK_CAPABILITY)

  useEffect(() => {
    let cancelled = false
    let retryTimeoutId: ReturnType<typeof setTimeout> | null = null

    const refreshCapability = (reason: string, force = false) => {
      const now = Date.now()
      if (!force && cachedCapability && now - cachedCapabilityAt < APPLE_PAY_CAPABILITY_CACHE_MS) {
        console.log('[ApplePay] availability reused from cache', { reason })
        if (!cancelled) {
          setCapability(cachedCapability)
        }
        return
      }

      if (!capabilityRequestInFlight) {
        capabilityRequestInFlight = getNativePaymentSheetCapability()
          .then((next) => {
            cachedCapability = next
            cachedCapabilityAt = Date.now()
            return next
          })
          .finally(() => {
            capabilityRequestInFlight = null
          })
      }

      void capabilityRequestInFlight
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

    refreshCapability('initial')
    retryTimeoutId = setTimeout(() => {
      refreshCapability('initial_retry', true)
    }, 1500)

    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') return
      refreshCapability('document_visible')
    }

    if (typeof window !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibility)
    }

    return () => {
      cancelled = true
      if (retryTimeoutId) clearTimeout(retryTimeoutId)
      if (typeof window !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibility)
      }
    }
  }, [])

  return capability
}
