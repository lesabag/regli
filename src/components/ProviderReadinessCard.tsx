import { type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'

// Provider activation READINESS card (Stage A).
//
// COST INVARIANT: this card's primary action expresses readiness ("I'm ready to
// receive orders") and persists a Regli-only intent flag ONLY. It NEVER creates a
// PayMe Seller, never calls an Edge Function, and never opens Hosted Onboarding, so
// it has ZERO PayMe setup cost. It deliberately says nothing about PayMe, seller
// setup, or setup cost.
//
// Payment activation (Stage B — the ONLY seller-creating boundary) is separate: its
// CTA is shown ONLY when a later, admin/demand-driven signal requests it
// (paymentActivationRequested). Marking ready must NEVER auto-promote to Stage B and
// NEVER makes the provider dispatch-eligible.

export interface ProviderReadinessCardProps {
  ready: boolean
  busy: boolean
  error?: string | null
  // Stage B seam: a future admin/demand-driven signal. While false (the default in
  // this phase) the payment-setup CTA is not offered at all.
  paymentActivationRequested: boolean
  onMarkReady: () => void
  onWithdraw: () => void
  // Opens the separate Stage B payment-activation gate. Only reachable when
  // paymentActivationRequested is true.
  onStartPaymentActivation: () => void
}

export default function ProviderReadinessCard({
  ready,
  busy,
  error,
  paymentActivationRequested,
  onMarkReady,
  onWithdraw,
  onStartPaymentActivation,
}: ProviderReadinessCardProps) {
  const { t } = useTranslation()

  // Not ready yet — invite the provider to express readiness. Readiness copy is
  // intentionally payment-agnostic.
  if (!ready) {
    return (
      <div style={cardStyle}>
        <div style={titleStyle}>{t('providerReadiness.readyTitle')}</div>
        <div style={bodyStyle}>{t('providerReadiness.readyBody')}</div>
        {error ? <div style={errorStyle}>{t('providerReadiness.errorBody')}</div> : null}
        <button
          type="button"
          disabled={busy}
          onClick={onMarkReady}
          style={{ ...primaryStyle, ...(busy ? disabledStyle : null) }}
        >
          {t('providerReadiness.readyCta')}
        </button>
      </div>
    )
  }

  // Ready. If (and only if) payment activation has been requested by a later
  // admin/demand signal, surface the separate Stage B payment-setup CTA.
  return (
    <div style={cardStyle}>
      <div style={titleStyle}>{t('providerReadiness.readyConfirmedTitle')}</div>
      <div style={bodyStyle}>
        {paymentActivationRequested
          ? t('providerPayment.gateBody')
          : t('providerReadiness.readyConfirmedBody')}
      </div>
      {error ? <div style={errorStyle}>{t('providerReadiness.errorBody')}</div> : null}
      {paymentActivationRequested ? (
        <button
          type="button"
          disabled={busy}
          onClick={onStartPaymentActivation}
          style={{ ...primaryStyle, ...(busy ? disabledStyle : null) }}
        >
          {t('providerPayment.continueCta')}
        </button>
      ) : null}
      <button
        type="button"
        disabled={busy}
        onClick={onWithdraw}
        style={{ ...secondaryStyle, ...(busy ? disabledStyle : null) }}
      >
        {t('providerReadiness.withdrawCta')}
      </button>
    </div>
  )
}

const cardStyle: CSSProperties = {
  background: '#ffffff',
  borderRadius: 16,
  padding: '16px 16px 14px',
  border: '1px solid #e2e8f0',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}

const titleStyle: CSSProperties = {
  fontSize: 16,
  fontWeight: 700,
  color: '#0f172a',
}

const bodyStyle: CSSProperties = {
  fontSize: 14,
  lineHeight: 1.5,
  color: '#475569',
}

const errorStyle: CSSProperties = {
  fontSize: 13,
  color: '#dc2626',
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
  marginTop: 4,
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

const disabledStyle: CSSProperties = {
  opacity: 0.6,
  cursor: 'default',
}
