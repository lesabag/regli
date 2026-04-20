import { useState } from 'react'

interface RatingModalProps {
  title: string
  onSubmit: (rating: number, review: string) => void
  onCancel: () => void
  submitting: boolean
}

export default function RatingModal({ title, onSubmit, onCancel, submitting }: RatingModalProps) {
  const [value, setValue] = useState(0)
  const [hover, setHover] = useState(0)
  const [review, setReview] = useState('')

  return (
    <div style={overlayStyle}>
      <div style={modalStyle}>
        <h2 style={{ margin: '0 0 18px', fontSize: 20, fontWeight: 700 }}>{title}</h2>
        <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
          {[1, 2, 3, 4, 5].map((star) => (
            <button
              key={star}
              type="button"
              onMouseEnter={() => setHover(star)}
              onMouseLeave={() => setHover(0)}
              onClick={() => setValue(star)}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                fontSize: 32,
                color: star <= (hover || value) ? '#F59E0B' : '#D1D5DB',
                padding: 2,
                transition: 'color 0.15s',
              }}
            >
              ★
            </button>
          ))}
        </div>
        <textarea
          value={review}
          onChange={(e) => setReview(e.target.value)}
          placeholder="Write an optional review..."
          rows={3}
          style={{
            width: '100%',
            border: '1px solid #E2E8F0',
            borderRadius: 12,
            padding: '12px 14px',
            fontSize: 14,
            outline: 'none',
            boxSizing: 'border-box',
            resize: 'vertical',
            minHeight: 80,
          }}
        />
        <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
          <button
            type="button"
            onClick={() => onSubmit(value, review.trim())}
            disabled={value < 1 || submitting}
            style={{
              flex: 1,
              border: 'none',
              borderRadius: 12,
              padding: '12px 16px',
              background: '#0F172A',
              color: '#FFFFFF',
              fontWeight: 700,
              fontSize: 14,
              cursor: value < 1 || submitting ? 'not-allowed' : 'pointer',
              opacity: value < 1 || submitting ? 0.6 : 1,
            }}
          >
            {submitting ? 'Submitting...' : 'Submit Rating'}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            style={{
              border: '1px solid #E2E8F0',
              borderRadius: 12,
              padding: '12px 16px',
              background: '#FFFFFF',
              color: '#64748B',
              fontWeight: 600,
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(15, 23, 42, 0.5)',
  display: 'grid',
  placeItems: 'center',
  zIndex: 1000,
}

const modalStyle: React.CSSProperties = {
  background: '#FFFFFF',
  borderRadius: 20,
  padding: 28,
  width: '100%',
  maxWidth: 480,
  boxShadow: '0 18px 40px rgba(15, 23, 42, 0.2)',
}
