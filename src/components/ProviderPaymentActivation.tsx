import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { Browser } from '@capacitor/browser'
import { Capacitor } from '@capacitor/core'
import { useTranslation } from 'react-i18next'
import {
  activateProviderPayments,
  authorizeProviderActivationFee,
  getProviderActivationFeeQuote,
  type ProviderPaymentActivationResult,
} from '../payments/providerActivation'
import {
  shouldResumePaymeSetup,
  type PaymeSellerSnapshot,
} from '../payments/providerPaymentSetupState'
import {
  canCreateSellerForActivation,
  type ProviderActivationState,
} from '../payments/providerActivationState'
import type { ProviderActivationFeeQuote } from '../payments/types'
import { formatAgorotAmount } from '../config/activationFee'

// Explicit, provider-initiated Provider Account Activation gate (Stage B).
//
// FLOW (PayMe's confirmed flow): show the ONE-TIME activation fee -> authorize it
// (J5, amount reserved, not captured) on PayMe's hosted page -> only after a
// confirmed authorization does the SELLER get created -> Hosted Onboarding/KYC ->
// (Phase 2C) capture -> payment ready. This component drives that sequence from
// the SERVER-authoritative activation state; it never advances the state itself.
//
// COST / SEQUENCING INVARIANTS:
//   * Seller creation (activateProviderPayments) is called ONLY when the server
//     state is 'fee_authorized' (canCreateSellerForActivation) — never before the
//     J5 authorization is confirmed, and never on mount/effect. An existing seller
//     is RESUMED, never recreated.
//   * The provider enters card data only on PayMe's hosted page. Regli collects no
//     PAN/CVV and no KYC/bank data.
//
// SEPARATION FROM READINESS (Stage A): marking "ready to receive orders" NEVER
// opens this gate and never triggers any PayMe call.

export interface ProviderPaymentActivationProps {
  open: boolean
  // Current persisted PayMe seller state (profile + provider_payment_onboarding).
  snapshot: PaymeSellerSnapshot | null | undefined
  // Server-authoritative activation state (provider_activation.activation_state).
  activationState?: ProviderActivationState | null
  onClose: () => void
  // Notified after a successful seller-creation / resume step.
  onActivated?: (result: ProviderPaymentActivationResult) => void
  // Notified after ANY successful step so the parent can refresh persisted state.
  onStateChanged?: () => void
}

/**
 * Open a PayMe hosted URL (J5 payment page or Hosted Onboarding) using the app's
 * existing safe external-navigation pattern: in-app Browser on native, full-page
 * redirect on web. Owner-scoped; never persisted or logged here.
 */
async function openHostedUrl(url: string): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    await Browser.open({ url })
    return
  }
  if (typeof window !== 'undefined') {
    window.location.href = url
  }
}

type UiPhase = 'idle' | 'authorized_pending' | 'unavailable' | 'error'

export default function ProviderPaymentActivation({
  open,
  snapshot,
  activationState,
  onClose,
  onActivated,
  onStateChanged,
}: ProviderPaymentActivationProps) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<UiPhase>('idle')
  // Server-authoritative fee quote. The client NEVER computes the amount; it fetches
  // the same value the J5 authorization charges and only formats it for display.
  const [feeQuote, setFeeQuote] = useState<ProviderActivationFeeQuote | null>(null)

  const isResume = useMemo(() => shouldResumePaymeSetup(snapshot), [snapshot])
  const existingSignupUrl = useMemo(() => {
    const url = snapshot?.signupUrl
    return typeof url === 'string' && url.trim().length > 0 ? url.trim() : null
  }, [snapshot])

  useEffect(() => {
    if (!open) return
    let active = true
    void getProviderActivationFeeQuote({ provider: 'payme' }).then((quote) => {
      if (active) setFeeQuote(quote)
    })
    return () => {
      active = false
    }
  }, [open])

  const feeText = useMemo(
    () =>
      feeQuote
        ? t('providerActivation.feeAmount', { amount: formatAgorotAmount(feeQuote.grossAgorot) })
        : null,
    [feeQuote, t],
  )

  // States the server has already advanced into. These render informational copy
  // and (mostly) suppress the confirm button — the next step is server/PayMe-side.
  const isExpired = activationState === 'authorization_expired'
  const isKycPending = activationState === 'kyc_pending'
  const canCreateSeller = canCreateSellerForActivation(activationState ?? null)

  const handleConfirm = useCallback(async () => {
    if (busy) return
    setBusy(true)
    setPhase('idle')

    try {
      // 1) Fee already authorized -> create the seller (idempotent) and continue to
      //    Hosted Onboarding. This is the ONLY place seller creation is triggered.
      if (canCreateSeller) {
        const activation = await activateProviderPayments({ provider: 'payme' })
        if (!activation.ok) {
          setPhase('error')
          return
        }
        if (activation.outcome === 'setup_unavailable') {
          setPhase('unavailable')
          onActivated?.(activation)
          onStateChanged?.()
          return
        }
        onActivated?.(activation)
        onStateChanged?.()
        if (activation.outcome === 'onboarding_ready' && activation.signupUrl) {
          await openHostedUrl(activation.signupUrl)
        }
        return
      }

      // 2) Seller already exists -> resume Hosted Onboarding, never recreate it.
      if (isResume && existingSignupUrl) {
        await openHostedUrl(existingSignupUrl)
        onStateChanged?.()
        return
      }

      // 3) Otherwise begin (or re-begin, after expiry) the J5 authorization.
      const auth = await authorizeProviderActivationFee({ provider: 'payme' })
      if (auth.skipped) {
        setPhase('unavailable')
        onStateChanged?.()
        return
      }
      if (!auth.success) {
        setPhase('error')
        return
      }
      onStateChanged?.()
      if (auth.saleUrl) {
        // Provider enters card on PayMe's hosted J5 page. Completion is confirmed
        // asynchronously (server reconciliation) before seller creation proceeds.
        await openHostedUrl(auth.saleUrl)
      }
      setPhase('authorized_pending')
    } catch {
      setPhase('error')
    } finally {
      setBusy(false)
    }
  }, [busy, canCreateSeller, existingSignupUrl, isResume, onActivated, onStateChanged])

  if (!open) return null

  // Resolve copy from the current UI phase and server state (priority order).
  let titleKey = 'providerActivation.title'
  let bodyKey = 'providerActivation.body'
  let hideConfirm = false
  let confirmKey = isResume ? 'providerPayment.resumeCta' : 'providerActivation.activateCta'

  if (phase === 'error') {
    titleKey = 'providerActivation.errorTitle'
    bodyKey = 'providerActivation.errorBody'
    confirmKey = 'providerActivation.retryCta'
  } else if (phase === 'unavailable') {
    titleKey = 'providerActivation.unavailableTitle'
    bodyKey = 'providerActivation.unavailableBody'
    hideConfirm = true
  } else if (phase === 'authorized_pending') {
    titleKey = 'providerActivation.authorizedTitle'
    bodyKey = 'providerActivation.authorizedBody'
    hideConfirm = true
  } else if (isKycPending) {
    titleKey = 'providerActivation.kycPendingTitle'
    bodyKey = 'providerActivation.kycPendingBody'
    hideConfirm = true
  } else if (isExpired) {
    titleKey = 'providerActivation.expiredTitle'
    bodyKey = 'providerActivation.expiredBody'
    confirmKey = 'providerActivation.activateCta'
  } else if (canCreateSeller) {
    titleKey = 'providerActivation.authorizedTitle'
    bodyKey = 'providerActivation.authorizedBody'
    confirmKey = 'providerActivation.continueCta'
  }

  // Show the one-time fee only on the initial call-to-action (not on
  // pending/complete states, where no charge decision is being made), and only once
  // the authoritative server quote has loaded.
  const displayFee = phase === 'idle' && !hideConfirm && !canCreateSeller && feeText !== null

  return (
    <>
      <div style={overlayStyle} onClick={busy ? undefined : onClose} />
      <div style={cardStyle} role="dialog" aria-modal="true">
        <div style={titleStyle}>{t(titleKey)}</div>
        <div style={bodyStyle}>{t(bodyKey)}</div>
        {displayFee ? (
          <div style={feeRowStyle}>
            <span style={feeLabelStyle}>{t('providerActivation.feeLabel')}</span>
            <span style={feeValueStyle}>{feeText}</span>
          </div>
        ) : null}
        <div style={actionsStyle}>
          {!hideConfirm ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleConfirm()}
              style={{ ...primaryStyle, ...(busy ? primaryDisabledStyle : null) }}
            >
              {t(confirmKey)}
            </button>
          ) : null}
          <button type="button" onClick={onClose} disabled={busy} style={secondaryStyle}>
            {t('providerActivation.cancel')}
          </button>
        </div>
      </div>
    </>
  )
}

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(15, 23, 42, 0.45)',
  zIndex: 60,
}

const cardStyle: CSSProperties = {
  position: 'fixed',
  left: '50%',
  bottom: 24,
  transform: 'translateX(-50%)',
  width: 'min(420px, calc(100vw - 32px))',
  background: '#ffffff',
  borderRadius: 20,
  padding: '20px 20px 18px',
  boxShadow: '0 18px 48px rgba(15, 23, 42, 0.22)',
  zIndex: 61,
}

const titleStyle: CSSProperties = {
  fontSize: 17,
  fontWeight: 700,
  color: '#0f172a',
  marginBottom: 8,
}

const bodyStyle: CSSProperties = {
  fontSize: 14,
  lineHeight: 1.5,
  color: '#475569',
  marginBottom: 16,
}

const feeRowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '12px 14px',
  marginBottom: 16,
  borderRadius: 12,
  background: '#f1f5f9',
}

const feeLabelStyle: CSSProperties = {
  fontSize: 14,
  color: '#475569',
}

const feeValueStyle: CSSProperties = {
  fontSize: 16,
  fontWeight: 700,
  color: '#0f172a',
}

const actionsStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}

const primaryStyle: CSSProperties = {
  width: '100%',
  padding: '12px 16px',
  borderRadius: 12,
  border: 'none',
  background: 'linear-gradient(135deg, #22c55e, #16a34a)',
  color: '#ffffff',
  fontSize: 15,
  fontWeight: 600,
  cursor: 'pointer',
}

const primaryDisabledStyle: CSSProperties = {
  opacity: 0.6,
  cursor: 'default',
}

const secondaryStyle: CSSProperties = {
  width: '100%',
  padding: '10px 16px',
  borderRadius: 12,
  border: 'none',
  background: 'transparent',
  color: '#64748b',
  fontSize: 14,
  fontWeight: 500,
  cursor: 'pointer',
}
