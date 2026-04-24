import { useState } from 'react'
import { loadStripe } from '@stripe/stripe-js'
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js'

const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY)

interface SavedCard {
  id: string
  brand: string
  last4: string
  expMonth?: number
  expYear?: number
}

interface CardSetupFormProps {
  savedCard: SavedCard | null
  setupClientSecret: string | null
  loadingCard: boolean
  /** True when the fetch failed — shows retry UI instead of spinner */
  loadError?: boolean
  /** Open Stripe Elements to add a card (no existing card) */
  onRequestSetup: () => void
  /** Open Stripe Elements to replace existing card */
  onChangeCard: () => void
  /** Called after Stripe SetupIntent succeeds */
  onSetupComplete: () => void
  /** Dismiss setup form without saving (keeps existing card) */
  onCancelSetup: () => void
  onRetry?: () => void
}

export default function CardSetupForm({
  savedCard,
  setupClientSecret,
  loadingCard,
  loadError = false,
  onRequestSetup,
  onChangeCard,
  onSetupComplete,
  onCancelSetup,
  onRetry,
}: CardSetupFormProps) {
  // ── Loading state ──────────────────────────────────────────
  if (loadingCard) {
    return (
      <div style={wrapperStyle}>
        <div style={cardRowStyle}>
          <div style={iconBoxStyle}>
            <CreditCardIcon />
          </div>
          <div style={{ flex: 1 }}>
            <div style={labelStyle}>Payment method</div>
            <div style={sublabelStyle}>Loading...</div>
          </div>
        </div>
      </div>
    )
  }

  // ── Error / failed to load ─────────────────────────────────
  if (loadError && !savedCard) {
    return (
      <div style={wrapperStyle}>
        <div style={cardRowStyle}>
          <div style={{ ...iconBoxStyle, background: '#FFF7ED' }}>
            <CreditCardIcon color="#F59E0B" />
          </div>
          <div style={{ flex: 1 }}>
            <div style={labelStyle}>Payment method</div>
            <div style={sublabelStyle}>Could not load — tap to retry</div>
          </div>
          {onRetry && (
            <button type="button" onClick={onRetry} style={retryBtnStyle}>
              Retry
            </button>
          )}
        </div>
      </div>
    )
  }

  // ── Setup in progress — show Stripe Elements ───────────────
  if (setupClientSecret) {
    return (
      <div style={wrapperStyle}>
        <div style={{ ...labelStyle, marginBottom: 12 }}>
          {savedCard ? 'Change payment method' : 'Add payment method'}
        </div>
        <Elements stripe={stripePromise} options={{ clientSecret: setupClientSecret }}>
          <SetupForm
            onComplete={onSetupComplete}
            onCancel={onCancelSetup}
            hasExistingCard={!!savedCard}
          />
        </Elements>
        <div style={{ ...reassuranceStyle, marginTop: 12 }}>
          <LockIcon />
          <span>Your card is saved securely. You won't be charged now.</span>
        </div>
      </div>
    )
  }

  // ── Card saved — show summary ──────────────────────────────
  if (savedCard) {
    return (
      <div style={wrapperStyle}>
        <div style={cardRowStyle}>
          <div style={iconBoxStyle}>
            <CreditCardIcon />
          </div>
          <div style={{ flex: 1 }}>
            <div style={labelStyle}>
              {capitalize(savedCard.brand)} •••• {savedCard.last4}
            </div>
            {savedCard.expMonth && savedCard.expYear && (
              <div style={sublabelStyle}>
                Expires {String(savedCard.expMonth).padStart(2, '0')}/{String(savedCard.expYear).slice(-2)}
              </div>
            )}
          </div>
          <button type="button" onClick={onChangeCard} style={changeBtnStyle}>
            Change
          </button>
        </div>
        <div style={reassuranceStyle}>
          <LockIcon />
          <span>Charged only after the walk</span>
        </div>
      </div>
    )
  }

  // ── No card — prompt to add ────────────────────────────────
  return (
    <div style={wrapperStyle}>
      <div style={cardRowStyle}>
        <div style={{ ...iconBoxStyle, background: '#FEF2F2' }}>
          <CreditCardIcon color="#EF4444" />
        </div>
        <div style={{ flex: 1 }}>
          <div style={labelStyle}>No payment method</div>
          <div style={sublabelStyle}>Add a card to book walks</div>
        </div>
        <button type="button" onClick={onRequestSetup} style={addBtnStyle}>
          Add card
        </button>
      </div>
    </div>
  )
}

function SetupForm({
  onComplete,
  onCancel,
  hasExistingCard,
}: {
  onComplete: () => void
  onCancel: () => void
  hasExistingCard: boolean
}) {
  const stripe = useStripe()
  const elements = useElements()
  const [processing, setProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!stripe || !elements) return

    setProcessing(true)
    setError(null)

    const { error: submitError } = await stripe.confirmSetup({
      elements,
      confirmParams: {
        return_url: window.location.href,
      },
      redirect: 'if_required',
    })

    if (submitError) {
      setError(submitError.message || 'Failed to save card')
      setProcessing(false)
      return
    }

    setProcessing(false)
    onComplete()
  }

  return (
    <form onSubmit={handleSubmit}>
      <PaymentElement options={{ layout: 'tabs' }} />
      {error && (
        <div style={{
          marginTop: 10,
          padding: '10px 12px',
          borderRadius: 10,
          background: '#FEF2F2',
          color: '#B91C1C',
          fontSize: 12,
          lineHeight: 1.4,
        }}>
          {error}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button
          type="submit"
          disabled={!stripe || processing}
          style={{
            ...saveBtnStyle,
            flex: 1,
            opacity: processing ? 0.7 : 1,
            cursor: processing ? 'not-allowed' : 'pointer',
          }}
        >
          {processing ? 'Saving...' : 'Save card'}
        </button>
        {hasExistingCard && (
          <button
            type="button"
            onClick={onCancel}
            disabled={processing}
            style={cancelBtnStyle}
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  )
}

// ─── Icons ──────────────────────────────────────────────────────

function CreditCardIcon({ color = '#3B82F6' }: { color?: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="4" width="22" height="16" rx="2" ry="2" />
      <line x1="1" y1="10" x2="23" y2="10" />
    </svg>
  )
}

function LockIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  )
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// ─── Styles ─────────────────────────────────────────────────────

const wrapperStyle: React.CSSProperties = {
  background: '#F8FAFC',
  borderRadius: 14,
  padding: '11px 12px',
  border: '1px solid #F1F5F9',
}

const cardRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
}

const iconBoxStyle: React.CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: 10,
  background: '#EFF6FF',
  display: 'grid',
  placeItems: 'center',
  flexShrink: 0,
}

const labelStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: '#0F172A',
  lineHeight: 1.2,
}

const sublabelStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#94A3B8',
  marginTop: 1,
  lineHeight: 1.25,
}

const changeBtnStyle: React.CSSProperties = {
  border: '1.5px solid #E2E8F0',
  borderRadius: 9,
  padding: '5px 10px',
  background: '#FFFFFF',
  color: '#64748B',
  fontWeight: 600,
  fontSize: 11.5,
  cursor: 'pointer',
  flexShrink: 0,
  transition: 'background 0.12s ease',
  WebkitTapHighlightColor: 'transparent',
}

const addBtnStyle: React.CSSProperties = {
  border: 'none',
  borderRadius: 9,
  padding: '6px 11px',
  background: '#0F172A',
  color: '#FFFFFF',
  fontWeight: 600,
  fontSize: 11.5,
  cursor: 'pointer',
  flexShrink: 0,
  transition: 'opacity 0.12s ease',
  WebkitTapHighlightColor: 'transparent',
}

const retryBtnStyle: React.CSSProperties = {
  border: '1.5px solid #F59E0B',
  borderRadius: 9,
  padding: '5px 10px',
  background: '#FFFBEB',
  color: '#92400E',
  fontWeight: 600,
  fontSize: 11.5,
  cursor: 'pointer',
  flexShrink: 0,
  WebkitTapHighlightColor: 'transparent',
}

const saveBtnStyle: React.CSSProperties = {
  padding: '12px 16px',
  borderRadius: 12,
  border: 'none',
  background: '#0F172A',
  color: '#FFFFFF',
  fontWeight: 700,
  fontSize: 14,
  WebkitTapHighlightColor: 'transparent',
}

const cancelBtnStyle: React.CSSProperties = {
  padding: '12px 16px',
  borderRadius: 12,
  border: '1.5px solid #E2E8F0',
  background: '#FFFFFF',
  color: '#64748B',
  fontWeight: 600,
  fontSize: 14,
  cursor: 'pointer',
  WebkitTapHighlightColor: 'transparent',
}

const reassuranceStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  marginTop: 8,
  fontSize: 10.5,
  color: '#94A3B8',
  letterSpacing: 0.1,
}
