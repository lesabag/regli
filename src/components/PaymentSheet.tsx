import { useState } from 'react'
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js'
import { stripePromise } from '../lib/stripe'

interface PaymentSheetProps {
  clientSecret: string
  priceLabel?: string
  onSuccess: (paymentIntentId: string) => void
  onCancel: () => void
}

export default function PaymentSheet({ clientSecret, priceLabel, onSuccess, onCancel }: PaymentSheetProps) {
  return (
    <div style={overlayStyle} onClick={onCancel}>
      <div style={sheetStyle} onClick={(e) => e.stopPropagation()}>
        <div style={contentWrapStyle}>
          <div style={handleStyle} />
          <h2 style={titleStyle}>Confirm order</h2>
          <Elements stripe={stripePromise} options={{ clientSecret }}>
            <CheckoutForm priceLabel={priceLabel} onSuccess={onSuccess} onCancel={onCancel} />
          </Elements>
        </div>
      </div>
    </div>
  )
}

function CheckoutForm({
  priceLabel,
  onSuccess,
  onCancel,
}: {
  priceLabel?: string
  onSuccess: (paymentIntentId: string) => void
  onCancel: () => void
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

    const { error: submitError, paymentIntent } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: window.location.href,
      },
      redirect: 'if_required',
    })

    if (submitError) {
      setError(submitError.message || 'Something went wrong — please try again')
      setProcessing(false)
      return
    }

    if (paymentIntent && (paymentIntent.status === 'requires_capture' || paymentIntent.status === 'succeeded')) {
      onSuccess(paymentIntent.id)
    } else {
      setError('Payment failed')
    }

    setProcessing(false)
  }

  const ctaLabel = processing
    ? 'Processing...'
    : priceLabel
    ? `Order Now · ${priceLabel}`
    : 'Order Now'

  return (
    <form onSubmit={handleSubmit}>
      <PaymentElement />
      {error && (
        <div
          style={{
            marginTop: 12,
            padding: 10,
            borderRadius: 10,
            background: '#FEF2F2',
            color: '#B91C1C',
            fontSize: 14,
          }}
        >
          {error}
        </div>
      )}
      <div style={{
        display: 'flex',
        gap: 12,
        marginTop: 18,
        position: 'sticky',
        bottom: 0,
        background: 'linear-gradient(180deg, rgba(14,17,22,0.96) 0%, rgba(20,24,31,0.98) 100%)',
        paddingTop: 16,
        paddingBottom: 8,
        borderTop: '1px solid rgba(148, 163, 184, 0.12)',
        zIndex: 1,
      }}>
        <button
          type="submit"
          disabled={!stripe || processing}
          style={{
            ...primaryButtonStyle,
            flex: 1,
            cursor: processing ? 'not-allowed' : 'pointer',
            opacity: processing ? 0.7 : 1,
          }}
        >
          {ctaLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={processing}
          style={{
            ...cancelButtonStyle,
            cursor: processing ? 'not-allowed' : 'pointer',
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(2, 6, 23, 0.58)',
  zIndex: 1000,
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'flex-end',
}

const sheetStyle: React.CSSProperties = {
  background: 'linear-gradient(180deg, rgba(14,17,22,0.94) 0%, rgba(20,24,31,0.96) 100%)',
  border: '1px solid rgba(148, 163, 184, 0.12)',
  borderRadius: 30,
  width: 'min(520px, calc(100% - 16px))',
  maxHeight: '85vh',
  margin: '0 auto max(6px, env(safe-area-inset-bottom, 0px))',
  boxShadow: '0 20px 40px rgba(2, 6, 23, 0.30), inset 0 1px 0 rgba(255,255,255,0.04)',
  backdropFilter: 'blur(24px)',
  WebkitBackdropFilter: 'blur(24px)',
  overflowY: 'auto',
  WebkitOverflowScrolling: 'touch',
}

const contentWrapStyle: React.CSSProperties = {
  padding: '12px 16px calc(16px + env(safe-area-inset-bottom, 0px))',
}

const handleStyle: React.CSSProperties = {
  width: 38,
  height: 5,
  borderRadius: 999,
  background: 'rgba(148, 163, 184, 0.52)',
  margin: '0 auto 12px',
}

const titleStyle: React.CSSProperties = {
  margin: '0 0 18px',
  fontSize: 20,
  fontWeight: 800,
  color: '#F8FAFC',
}

const primaryButtonStyle: React.CSSProperties = {
  border: 'none',
  borderRadius: 16,
  padding: '12px 20px',
  background: 'linear-gradient(180deg, #38BDF8 0%, #2563EB 100%)',
  color: '#FFFFFF',
  fontWeight: 800,
  fontSize: 14,
  boxShadow: '0 12px 28px rgba(37,99,235,0.18)',
}

const cancelButtonStyle: React.CSSProperties = {
  border: '1px solid rgba(96, 165, 250, 0.16)',
  borderRadius: 16,
  padding: '12px 20px',
  background: 'rgba(17, 24, 39, 0.78)',
  color: '#60A5FA',
  fontWeight: 700,
  fontSize: 14,
}
