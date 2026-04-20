interface ActionButtonProps {
  label: string
  onClick?: () => void
  disabled?: boolean
  loading?: boolean
  variant?: 'primary' | 'secondary' | 'success' | 'danger'
  sticky?: boolean
}

export default function ActionButton({
  label,
  onClick,
  disabled,
  loading,
  variant = 'primary',
  sticky,
}: ActionButtonProps) {
  const isDisabled = disabled || loading

  const bg = isDisabled
    ? '#E2E8F0'
    : variant === 'success'
    ? '#15803D'
    : variant === 'danger'
    ? '#DC2626'
    : variant === 'secondary'
    ? '#FFFFFF'
    : '#0F172A'

  const color = isDisabled
    ? '#94A3B8'
    : variant === 'secondary'
    ? '#0F172A'
    : '#FFFFFF'

  const border = variant === 'secondary' ? '1.5px solid #E2E8F0' : 'none'

  const shadow = isDisabled
    ? 'none'
    : variant === 'secondary'
    ? '0 1px 4px rgba(15, 23, 42, 0.06)'
    : '0 4px 14px rgba(15, 23, 42, 0.15)'

  return (
    <div
      style={{
        ...(sticky ? stickyWrapperStyle : { padding: '2px 0' }),
      }}
    >
      <button
        onClick={onClick}
        disabled={isDisabled}
        style={{
          width: '100%',
          padding: '15px 24px',
          borderRadius: 16,
          border,
          background: bg,
          color,
          fontWeight: 700,
          fontSize: 16,
          letterSpacing: -0.2,
          cursor: isDisabled ? 'not-allowed' : 'pointer',
          transition: 'opacity 0.15s ease, transform 0.1s ease, background 0.15s ease',
          boxShadow: shadow,
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        {loading ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span style={spinnerStyle} />
            {label}
          </span>
        ) : (
          label
        )}
      </button>
    </div>
  )
}

const stickyWrapperStyle: React.CSSProperties = {
  position: 'sticky',
  bottom: 0,
  padding: '12px 0',
  paddingBottom: 'calc(12px + env(safe-area-inset-bottom))',
  background: 'linear-gradient(transparent, #FFFFFF 20%)',
}

const spinnerStyle: React.CSSProperties = {
  display: 'inline-block',
  width: 16,
  height: 16,
  border: '2px solid rgba(255,255,255,0.3)',
  borderTopColor: '#FFFFFF',
  borderRadius: '50%',
  animation: 'completionSpin 0.6s linear infinite',
}
