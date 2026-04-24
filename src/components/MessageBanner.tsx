import { useEffect, useMemo, useState } from 'react'

interface MessageBannerProps {
  text: string
  kind: 'error' | 'success' | 'info'
  onDismiss?: () => void
  durationMs?: number
  title?: string
  subtitle?: string
  icon?: React.ReactNode
}

export default function MessageBanner({
  text,
  kind,
  onDismiss,
  durationMs = 3600,
  title,
  subtitle,
  icon,
}: MessageBannerProps) {
  const isError = kind === 'error'
  const isInfo = kind === 'info'
  const [progress, setProgress] = useState(100)

  const accent = useMemo(() => {
    if (isError) return '#DC2626'
    if (isInfo) return '#5B7CFA'
    return '#16A34A'
  }, [isError, isInfo])

  useEffect(() => {
    setProgress(100)
    const started = Date.now()
    const interval = window.setInterval(() => {
      const elapsed = Date.now() - started
      const pct = Math.max(0, 100 - (elapsed / durationMs) * 100)
      setProgress(pct)
    }, 50)

    const timeout = window.setTimeout(() => {
      onDismiss?.()
    }, durationMs)

    return () => {
      window.clearInterval(interval)
      window.clearTimeout(timeout)
    }
  }, [durationMs, onDismiss, text])

  return (
    <div
      className="message-banner-enter"
      style={{
        position: 'relative',
        overflow: 'hidden',
        padding: subtitle ? '12px 14px 12px' : '10px 14px 12px',
        borderRadius: 14,
        marginBottom: 8,
        background: isError ? '#FEE2E2' : isInfo ? '#EEF4FF' : '#F0FDF4',
        color: isError ? '#B91C1C' : isInfo ? '#3152C8' : '#15803D',
        fontSize: 13,
        fontWeight: 600,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        pointerEvents: 'auto',
        boxShadow: '0 2px 8px rgba(15, 23, 42, 0.08)',
        maxWidth: '100%',
        boxSizing: 'border-box' as const,
        lineHeight: 1.4,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
        <span style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
          {icon ?? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              {isError ? (
                <>
                  <circle cx="12" cy="12" r="10" />
                  <line x1="15" y1="9" x2="9" y2="15" />
                  <line x1="9" y1="9" x2="15" y2="15" />
                </>
              ) : isInfo ? (
                <>
                  <circle cx="11" cy="11" r="7" />
                  <line x1="16.65" y1="16.65" x2="21" y2="21" />
                </>
              ) : (
                <>
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="16 10 11 15 8 12" />
                </>
              )}
            </svg>
          )}
        </span>
        <span style={{ flex: 1, minWidth: 0, display: 'grid', gap: subtitle ? 2 : 0 }}>
          {(title || subtitle) ? (
            <>
              <span style={{ fontSize: 14, fontWeight: 800, color: 'inherit' }}>{title || text}</span>
              <span style={{ fontSize: 12.5, fontWeight: 500, lineHeight: 1.4, color: isError ? '#B91C1C' : isInfo ? '#4C67C7' : '#15803D' }}>
                {subtitle || text}
              </span>
            </>
          ) : (
            <span style={{ flex: 1, minWidth: 0 }}>{text}</span>
          )}
        </span>
      </div>
      {onDismiss && (
        <button
          onClick={onDismiss}
          style={{
            background: 'none',
            border: 'none',
            color: 'inherit',
            cursor: 'pointer',
            fontSize: 18,
            lineHeight: 1,
            padding: '0 2px',
            opacity: 0.5,
            flexShrink: 0,
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          ×
        </button>
      )}
      <div
        style={{
          position: 'absolute',
          left: 0,
          bottom: 0,
          height: 3,
          width: `${progress}%`,
          background: accent,
          transition: 'width 50ms linear',
        }}
      />
    </div>
  )
}
