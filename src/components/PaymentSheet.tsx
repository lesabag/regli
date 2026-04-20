import { useState } from 'react'
import { loadStripe } from '@stripe/stripe-js'
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js'

const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY)

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
        <div style={{ padding: '24px 28px', paddingBottom: 'calc(24px + env(safe-area-inset-bottom))' }}>
          <h2 style={{ margin: '0 0 18px', fontSize: 20, fontWeight: 700 }}>Confirm order</h2>
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
        background: '#FFFFFF',
        paddingTop: 16,
        paddingBottom: 8,
        borderTop: '1px solid #F1F5F9',
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
  background: 'rgba(15, 23, 42, 0.5)',
  zIndex: 1000,
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'flex-end',
}

const sheetStyle: React.CSSProperties = {
  background: '#FFFFFF',
  borderRadius: '20px 20px 0 0',
  width: '100%',
  maxWidth: 480,
  maxHeight: '85vh',
  margin: '0 auto',
  boxShadow: '0 -8px 40px rgba(15, 23, 42, 0.2)',
  overflowY: 'auto',
  WebkitOverflowScrolling: 'touch',
}

const primaryButtonStyle: React.CSSProperties = {
  border: 'none',
  borderRadius: 12,
  padding: '12px 20px',
  background: '#0F172A',
  color: '#FFFFFF',
  fontWeight: 700,
  fontSize: 14,
}

const cancelButtonStyle: React.CSSProperties = {
  border: '1px solid #E2E8F0',
  borderRadius: 12,
  padding: '12px 20px',
  background: '#FFFFFF',
  color: '#64748B',
  fontWeight: 600,
  fontSize: 14,
}
