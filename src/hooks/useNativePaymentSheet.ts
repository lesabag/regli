import { useEffect, useState } from 'react'
import {
  getNativePaymentSheetCapability,
  type NativePaymentSheetCapability,
} from '../lib/nativeStripe'

const FALLBACK_CAPABILITY: NativePaymentSheetCapability = {
  supported: false,
  initialized: false,
  applePayEligible: false,
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

    return () => {
      cancelled = true
    }
  }, [])

  return capability
}
