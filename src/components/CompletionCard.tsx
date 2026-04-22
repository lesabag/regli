import { hapticLight } from '../utils/haptics'
import { useEffect, useState } from 'react'

interface CompletionCardProps {
  promptKey?: string
  title: string
  subtitle: string
  earnings?: string
  onRate?: (rating: number, review: string) => void
  ratingSubmitting?: boolean
  alreadyRated?: boolean
  favoriteLabel?: string
  favoriteActive?: boolean
  onToggleFavorite?: () => void
  onDismiss: () => void
}

export default function CompletionCard({
  promptKey,
  title,
  subtitle,
  earnings,
  onRate,
  ratingSubmitting,
  alreadyRated,
  favoriteLabel,
  favoriteActive,
  onToggleFavorite,
  onDismiss,
}: CompletionCardProps) {
  const [rating, setRating] = useState(0)
  const [hoverRating, setHoverRating] = useState(0)
  const [pressedStar, setPressedStar] = useState(0)
  const [review, setReview] = useState('')
  const [ratingDone, setRatingDone] = useState(alreadyRated ?? false)

  useEffect(() => {
    setRating(0)
    setHoverRating(0)
    setPressedStar(0)
    setReview('')
    setRatingDone(alreadyRated ?? false)
  }, [alreadyRated, promptKey, subtitle, title])

  const handleSubmitRating = () => {
    if (rating < 1 || !onRate) return
    onRate(rating, review.trim())
    setRatingDone(true)
  }

  const showRatingInput = !!onRate && !ratingDone

  return (
    <div style={cardStyle}>
      <div style={checkStyle}>
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#16A34A"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </div>

      <h3 style={titleStyle}>{title}</h3>
      <p style={subtitleStyle}>{subtitle}</p>

      {onToggleFavorite && favoriteLabel && (
        <button
          type="button"
          onClick={onToggleFavorite}
          style={{
            ...favoriteButtonStyle,
            ...(favoriteActive ? favoriteButtonActiveStyle : null),
          }}
        >
          <span style={favoriteIconStyle}>{favoriteActive ? '♥' : '♡'}</span>
          <span>{favoriteActive ? 'Preferred walker' : `Save ${favoriteLabel}`}</span>
        </button>
      )}

      {earnings && (
        <div style={earningsStyle}>
          <span style={{ fontSize: 13, color: '#15803D', fontWeight: 600 }}>Earned</span>
          <span style={{ fontSize: 20, fontWeight: 800, color: '#15803D' }}>{earnings}</span>
        </div>
      )}

      {showRatingInput && (
        <div style={ratingContainerStyle}>
          <p style={ratingLabelStyle}>How was your experience?</p>

          <div style={starsRowStyle}>
            {[1, 2, 3, 4, 5].map((star) => {
              const isActive = star <= (hoverRating || rating)
              const isPressed = star === pressedStar

              return (
                <button
                  key={star}
                  type="button"
                  onMouseEnter={() => setHoverRating(star)}
                  onMouseLeave={() => setHoverRating(0)}
                  onMouseDown={() => setPressedStar(star)}
                  onMouseUp={() => setPressedStar(0)}
                  onTouchStart={() => {
                    setPressedStar(star)
                    setHoverRating(star)
                  }}
                  onTouchEnd={() => {
                    setPressedStar(0)
                    setHoverRating(0)
                  }}
                  onClick={async () => {
                    setRating(star)
                    await hapticLight()
                  }}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: 34,
                    lineHeight: 1,
                    color: isActive ? '#F59E0B' : '#D1D5DB',
                    padding: 4,
                    transition: 'color 0.15s ease, transform 0.15s ease',
                    transform: isPressed
                      ? 'scale(1.3)'
                      : hoverRating === star
                        ? 'scale(1.15)'
                        : 'scale(1)',
                    WebkitTapHighlightColor: 'transparent',
                  }}
                >
                  ★
                </button>
              )
            })}
          </div>

          <div
            style={{
              overflow: 'hidden',
              transition: 'max-height 0.3s ease, opacity 0.3s ease',
              maxHeight: rating > 0 ? 200 : 0,
              opacity: rating > 0 ? 1 : 0,
            }}
          >
            <textarea
              value={review}
              onChange={(e) => setReview(e.target.value)}
              placeholder="Share your feedback (optional)"
              rows={2}
              style={textareaStyle}
            />
          </div>
        </div>
      )}

      {ratingDone && (
        <div className="rating-submit-success" style={thanksContainerStyle}>
          <div style={thanksCheckStyle}>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#15803D"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <span style={thanksTextStyle}>Thanks for your feedback!</span>
        </div>
      )}

      <div style={buttonsContainerStyle}>
        {showRatingInput && rating > 0 && (
          <button
            onClick={handleSubmitRating}
            disabled={ratingSubmitting}
            style={{
              ...primaryButtonStyle,
              cursor: ratingSubmitting ? 'not-allowed' : 'pointer',
              opacity: ratingSubmitting ? 0.7 : 1,
            }}
          >
            {ratingSubmitting ? 'Sending...' : 'Submit rating'}
          </button>
        )}
        <button onClick={onDismiss} style={secondaryButtonStyle}>
          {ratingDone || alreadyRated ? 'Done' : 'Skip'}
        </button>
      </div>
    </div>
  )
}

const cardStyle: React.CSSProperties = {
  background: '#FFFFFF',
  borderRadius: 22,
  padding: '28px 24px',
  width: '100%',
  boxSizing: 'border-box',
  textAlign: 'center',
  boxShadow: '0 4px 24px rgba(15, 23, 42, 0.06)',
  animation: 'completionSlideUp 0.4s ease-out',
}

const checkStyle: React.CSSProperties = {
  width: 56,
  height: 56,
  borderRadius: 999,
  background: '#DCFCE7',
  display: 'grid',
  placeItems: 'center',
  margin: '0 auto 16px',
  animation: 'checkmarkPop 0.5s ease-out 0.15s both',
}

const titleStyle: React.CSSProperties = {
  margin: '0 0 4px',
  fontSize: 20,
  fontWeight: 800,
  color: '#0F172A',
  letterSpacing: -0.3,
}

const subtitleStyle: React.CSSProperties = {
  margin: '0 0 20px',
  fontSize: 14,
  color: '#64748B',
  lineHeight: 1.4,
}

const earningsStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '14px 18px',
  background: '#F0FDF4',
  borderRadius: 14,
  border: '1px solid #DCFCE7',
  marginBottom: 8,
}

const favoriteButtonStyle: React.CSSProperties = {
  margin: '10px auto 0',
  border: '1px solid #FDE68A',
  borderRadius: 999,
  background: '#FFFBEB',
  color: '#92400E',
  padding: '10px 14px',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  fontSize: 13,
  fontWeight: 800,
  cursor: 'pointer',
  fontFamily: 'inherit',
  WebkitTapHighlightColor: 'transparent',
}

const favoriteButtonActiveStyle: React.CSSProperties = {
  background: '#FEF3C7',
  border: '1px solid #F59E0B',
  color: '#78350F',
}

const favoriteIconStyle: React.CSSProperties = {
  fontSize: 17,
  lineHeight: 1,
}

const ratingContainerStyle: React.CSSProperties = {
  marginTop: 4,
  padding: '18px 16px 16px',
  background: '#F8FAFC',
  borderRadius: 16,
  border: '1px solid #F1F5F9',
}

const ratingLabelStyle: React.CSSProperties = {
  margin: '0 0 12px',
  fontSize: 15,
  fontWeight: 700,
  color: '#334155',
}

const starsRowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'center',
  gap: 8,
  marginBottom: 4,
}

const textareaStyle: React.CSSProperties = {
  width: '100%',
  marginTop: 14,
  border: '1.5px solid #E8ECF0',
  borderRadius: 14,
  padding: '12px 14px',
  fontSize: 14,
  color: '#0F172A',
  outline: 'none',
  boxSizing: 'border-box',
  resize: 'none',
  background: '#FFFFFF',
  fontFamily: 'inherit',
  lineHeight: 1.5,
  transition: 'border-color 0.15s ease',
}

const buttonsContainerStyle: React.CSSProperties = {
  marginTop: 18,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}

const primaryButtonStyle: React.CSSProperties = {
  width: '100%',
  padding: '15px 16px',
  borderRadius: 16,
  border: 'none',
  background: '#0F172A',
  color: '#FFFFFF',
  fontWeight: 700,
  fontSize: 15,
  letterSpacing: -0.2,
  transition: 'opacity 0.15s ease',
  WebkitTapHighlightColor: 'transparent',
  boxShadow: '0 4px 14px rgba(15, 23, 42, 0.15)',
}

const secondaryButtonStyle: React.CSSProperties = {
  width: '100%',
  padding: '13px 16px',
  borderRadius: 16,
  border: '1.5px solid #E8ECF0',
  background: '#FFFFFF',
  color: '#64748B',
  fontWeight: 600,
  fontSize: 15,
  cursor: 'pointer',
  transition: 'background 0.12s ease',
  WebkitTapHighlightColor: 'transparent',
}

const thanksContainerStyle: React.CSSProperties = {
  marginTop: 8,
  padding: '14px 16px',
  background: '#F0FDF4',
  borderRadius: 14,
  border: '1px solid #DCFCE7',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 10,
}

const thanksCheckStyle: React.CSSProperties = {
  width: 26,
  height: 26,
  borderRadius: 999,
  background: '#DCFCE7',
  display: 'grid',
  placeItems: 'center',
  flexShrink: 0,
}

const thanksTextStyle: React.CSSProperties = {
  fontSize: 14,
  color: '#15803D',
  fontWeight: 700,
}
