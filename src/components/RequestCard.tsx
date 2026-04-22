import { formatShortAddress } from '../utils/addressFormat'

interface RequestCardProps {
  clientName: string
  dogName: string
  duration: string
  price: string
  location?: string
  onAccept: () => void
  onDecline: () => void
  loading?: boolean
}

function shortenAddress(addr: string, maxLen = 30): string {
  if (addr.length <= maxLen) return addr
  return addr.slice(0, maxLen - 1).trimEnd() + '…'
}

export default function RequestCard({
  clientName,
  dogName,
  duration,
  price,
  location,
  onAccept,
  onDecline,
  loading,
}: RequestCardProps) {
  return (
    <div style={cardStyle}>
      {/* Header: avatar + name */}
      <div style={headerStyle}>
        <div style={avatarStyle}>{clientName.charAt(0).toUpperCase()}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: '#0F172A' }}>
            {clientName}
          </h3>
          <p style={{ margin: '2px 0 0', fontSize: 14, color: '#64748B' }}>
            {dogName} · {duration} · <span style={{ color: '#15803D', fontWeight: 700 }}>{price}</span>
          </p>
        </div>
      </div>

      {/* Location */}
      {location && (
        <div style={locationRow}>
          <span style={{ flexShrink: 0 }}>📍</span>
          <span
            style={{
              color: '#64748B',
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {shortenAddress(formatShortAddress(location))}
          </span>
        </div>
      )}

      {/* Actions */}
      <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
        <button
          onClick={onDecline}
          disabled={loading}
          style={declineButtonStyle}
        >
          Decline
        </button>
        <button
          onClick={onAccept}
          disabled={loading}
          style={acceptButtonStyle}
        >
          {loading ? 'Accepting...' : 'Accept'}
        </button>
      </div>
    </div>
  )
}

const cardStyle: React.CSSProperties = {
  background: '#FFFFFF',
  borderRadius: 20,
  padding: '20px 22px',
  boxShadow: '0 4px 20px rgba(15, 23, 42, 0.08)',
}

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 14,
}

const avatarStyle: React.CSSProperties = {
  width: 44,
  height: 44,
  borderRadius: 14,
  background: '#0F172A',
  color: '#FFFFFF',
  display: 'grid',
  placeItems: 'center',
  fontSize: 18,
  fontWeight: 700,
  flexShrink: 0,
}

const locationRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  marginTop: 12,
  fontSize: 13,
  color: '#94A3B8',
  minWidth: 0,
}

const acceptButtonStyle: React.CSSProperties = {
  flex: 2,
  border: 'none',
  borderRadius: 14,
  padding: '14px 20px',
  background: '#15803D',
  color: '#FFFFFF',
  fontWeight: 700,
  fontSize: 15,
  cursor: 'pointer',
  boxShadow: '0 4px 12px rgba(21, 128, 61, 0.25)',
}

const declineButtonStyle: React.CSSProperties = {
  flex: 1,
  border: '1px solid #E2E8F0',
  borderRadius: 14,
  padding: '14px 16px',
  background: '#FFFFFF',
  color: '#94A3B8',
  fontWeight: 600,
  fontSize: 14,
  cursor: 'pointer',
}
