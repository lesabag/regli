interface WalletSummaryProps {
  availableBalance: number
  pendingEarnings: number
  currency?: string
}

export default function WalletSummary({
  availableBalance,
  pendingEarnings,
  currency = '₪',
}: WalletSummaryProps) {
  return (
    <div style={rowStyle}>
      <div style={cellStyle}>
        <span style={labelStyle}>Balance</span>
        <span style={valueStyle}>{currency}{availableBalance.toFixed(0)}</span>
      </div>
      {pendingEarnings > 0 && (
        <>
          <div style={dividerStyle} />
          <div style={cellStyle}>
            <span style={labelStyle}>Pending</span>
            <span style={{ ...valueStyle, color: '#F59E0B' }}>+{currency}{pendingEarnings.toFixed(0)}</span>
          </div>
        </>
      )}
    </div>
  )
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  background: '#FFFFFF',
  borderRadius: 14,
  padding: '12px 18px',
  border: '1px solid #F1F5F9',
}

const cellStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  flex: 1,
}

const dividerStyle: React.CSSProperties = {
  width: 1,
  height: 28,
  background: '#E2E8F0',
  margin: '0 16px',
  flexShrink: 0,
}

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: '#94A3B8',
  textTransform: 'uppercase',
  letterSpacing: 0.3,
}

const valueStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 800,
  color: '#0F172A',
}
