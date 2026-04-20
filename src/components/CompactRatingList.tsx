import { useState } from 'react'

interface Rating {
  id: string
  rating: number
  review: string | null
  authorName: string
  date: string
}

interface CompactRatingListProps {
  ratings: Rating[]
  limit?: number
  onViewAll?: () => void
  emptyText?: string
}

export default function CompactRatingList({
  ratings,
  limit = 2,
  onViewAll,
  emptyText = 'No ratings yet',
}: CompactRatingListProps) {
  const visible = ratings.slice(0, limit)

  if (visible.length === 0) {
    return (
      <div style={emptyStyle}>
        <p style={{ margin: 0, fontSize: 14, color: '#94A3B8' }}>{emptyText}</p>
      </div>
    )
  }

  return (
    <div>
      <div style={{ display: 'grid', gap: 8 }}>
        {visible.map((r) => (
          <RatingItem key={r.id} rating={r} />
        ))}
      </div>
      {ratings.length > limit && onViewAll && (
        <button onClick={onViewAll} style={viewAllStyle}>
          View all ({ratings.length})
        </button>
      )}
    </div>
  )
}

function RatingItem({ rating: r }: { rating: Rating }) {
  const [expanded, setExpanded] = useState(false)
  const hasLongReview = r.review != null && r.review.length > 100

  return (
    <div className="rating-item-enter" style={itemStyle}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={starsRowStyle}>
          <span style={starsStyle}>
            {'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)}
          </span>
          <span style={authorStyle}>by {r.authorName}</span>
          <span style={dateStyle}>{r.date}</span>
        </div>
        {r.review && (
          <div style={reviewWrapStyle}>
            <p style={reviewTextStyle}>
              {expanded || !hasLongReview
                ? r.review
                : r.review.slice(0, 100) + '...'}
            </p>
            {hasLongReview && (
              <button
                type="button"
                onClick={() => setExpanded(!expanded)}
                style={expandBtnStyle}
              >
                {expanded ? 'Show less' : 'Read more'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

const itemStyle: React.CSSProperties = {
  padding: '12px 14px',
  background: '#F8FAFC',
  borderRadius: 14,
}

const starsRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
}

const starsStyle: React.CSSProperties = {
  fontSize: 14,
  color: '#F59E0B',
  letterSpacing: 1,
}

const authorStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#94A3B8',
  fontWeight: 500,
}

const dateStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#CBD5E1',
  marginLeft: 'auto',
  whiteSpace: 'nowrap',
  flexShrink: 0,
}

const reviewWrapStyle: React.CSSProperties = {
  marginTop: 6,
  paddingTop: 6,
  borderTop: '1px solid #EEF2F6',
}

const reviewTextStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  color: '#475569',
  lineHeight: 1.5,
  overflow: 'hidden',
  display: '-webkit-box',
  WebkitBoxOrient: 'vertical' as React.CSSProperties['WebkitBoxOrient'],
}

const expandBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: '#3B82F6',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  padding: '4px 0 0',
  WebkitTapHighlightColor: 'transparent',
}

const emptyStyle: React.CSSProperties = {
  padding: 20,
  textAlign: 'center',
  background: '#FAFBFC',
  borderRadius: 14,
  border: '1px dashed #E2E8F0',
}

const viewAllStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  marginTop: 8,
  padding: '10px 0',
  background: 'none',
  border: 'none',
  color: '#3B82F6',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  textAlign: 'center',
}
