import { useEffect, useMemo, useState } from 'react'

interface MessageBannerProps {
  text: string
  kind: 'error' | 'success'
  onDismiss?: () => void
  durationMs?: number
}

export default function MessageBanner({
  text,
  kind,
  onDismiss,
  durationMs = 3600,
}: MessageBannerProps) {
  const isError = kind === 'error'
  const [progress, setProgress] = useState(100)

  const accent = useMemo(() => (isError ? '#DC2626' : '#16A34A'), [isError])

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
        padding: '10px 14px 12px',
        borderRadius: 12,
        marginBottom: 8,
        background: isError ? '#FEE2E2' : '#F0FDF4',
        color: isError ? '#B91C1C' : '#15803D',
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
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          {isError ? (
            <>
              <circle cx="12" cy="12" r="10" />
              <line x1="15" y1="9" x2="9" y2="15" />
              <line x1="9" y1="9" x2="15" y2="15" />
            </>
          ) : (
            <>
              <circle cx="12" cy="12" r="10" />
              <polyline points="16 10 11 15 8 12" />
            </>
          )}
        </svg>
        <span style={{ flex: 1, minWidth: 0 }}>{text}</span>
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
