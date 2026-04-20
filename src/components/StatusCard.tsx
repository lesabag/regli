interface StatusCardProps {
  title: string
  subtitle?: string
  badge?: { text: string; color: string }
  icon?: React.ReactNode
  children?: React.ReactNode
}

export default function StatusCard({ title, subtitle, badge, icon, children }: StatusCardProps) {
  return (
    <div className="status-card-enter" style={cardStyle}>
      <div style={headerRowStyle}>
        {icon && <div style={iconWrapStyle}>{icon}</div>}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={titleRowStyle}>
            <h3 style={titleStyle}>{title}</h3>
            {badge && (
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  padding: '3px 10px',
                  borderRadius: 8,
                  background: badge.color + '14',
                  color: badge.color,
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                  animation: badge.text === 'Arrived' ? 'completionFadeIn 0.3s ease-out' : undefined,
                }}
              >
                {badge.text}
              </span>
            )}
          </div>
          {subtitle && (
            <p style={subtitleStyle}>{subtitle}</p>
          )}
        </div>
      </div>
      {children && <div style={childrenStyle}>{children}</div>}
    </div>
  )
}

const cardStyle: React.CSSProperties = {
  background: '#FFFFFF',
  borderRadius: 20,
  padding: '20px 20px',
  boxShadow: '0 4px 20px rgba(15, 23, 42, 0.06)',
}

const headerRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 14,
}

const iconWrapStyle: React.CSSProperties = {
  width: 44,
  height: 44,
  borderRadius: 14,
  background: '#F1F5F9',
  display: 'grid',
  placeItems: 'center',
  flexShrink: 0,
}

const titleRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
}

const titleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 17,
  fontWeight: 700,
  color: '#0F172A',
}

const subtitleStyle: React.CSSProperties = {
  margin: '4px 0 0',
  fontSize: 14,
  color: '#64748B',
  lineHeight: 1.4,
}

const childrenStyle: React.CSSProperties = {
  marginTop: 14,
  paddingTop: 14,
  borderTop: '1px solid #F1F5F9',
}
