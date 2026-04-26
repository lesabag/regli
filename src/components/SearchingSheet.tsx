import { useEffect, useMemo, useState, type CSSProperties } from 'react'

interface SearchingSheetProps {
  elapsedSeconds: number
  durationLabel: string
  priceLabel: string
  mode: 'matching' | 'empty'
  emptyTitle?: string
  emptySubtitle?: string
  onCancel: () => void
  onTryAgain?: () => void
}

const MATCHING_MESSAGES = [
  'Looking for nearby providers...',
  'Checking availability...',
  'Almost there...',
] as const

function formatElapsed(seconds: number): string {
  const safe = Math.max(0, seconds)
  const mins = Math.floor(safe / 60)
  const secs = safe % 60
  return `${mins}:${String(secs).padStart(2, '0')}`
}

export default function SearchingSheet({
  elapsedSeconds,
  durationLabel,
  priceLabel,
  mode,
  emptyTitle = 'No providers available right now',
  emptySubtitle = 'Try again in a few minutes',
  onCancel,
  onTryAgain,
}: SearchingSheetProps) {
  const [messageIndex, setMessageIndex] = useState(0)

  useEffect(() => {
    if (mode !== 'matching') {
      setMessageIndex(0)
      return
    }

    const intervalId = window.setInterval(() => {
      setMessageIndex((current) => (current + 1) % MATCHING_MESSAGES.length)
    }, 1500)

    return () => window.clearInterval(intervalId)
  }, [mode])

  const progressWidth = useMemo(() => {
    const capped = Math.min(elapsedSeconds, 18)
    return `${Math.max(18, (capped / 18) * 100)}%`
  }, [elapsedSeconds])

  const detailChips = useMemo(
    () => [
      { label: 'Search time', value: formatElapsed(elapsedSeconds) },
      { label: 'Duration', value: durationLabel || 'Walk' },
      { label: 'Price', value: priceLabel || '—' },
    ],
    [durationLabel, elapsedSeconds, priceLabel],
  )

  if (mode === 'empty') {
    return (
      <div style={sheetStyle}>
        <style>{matchingAnimations}</style>
        <div style={emptyWrapStyle}>
          <div style={emptyIconWrapStyle}>
            <div style={emptyHaloStyle} />
            <div style={emptyIconStyle}>
              <svg
                width="28"
                height="28"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="11" cy="11" r="7" />
                <line x1="16.65" y1="16.65" x2="21" y2="21" />
              </svg>
            </div>
          </div>

          <div style={emptyTitleStyle}>{emptyTitle}</div>
          <div style={emptySubtitleStyle}>{emptySubtitle}</div>

          <div style={infoRowStyle}>
            {detailChips.slice(1).map((chip) => (
              <div key={chip.label} style={compactInfoCardStyle}>
                <div style={compactInfoLabelStyle}>{chip.label}</div>
                <div style={compactInfoValueStyle}>{chip.value}</div>
              </div>
            ))}
          </div>

          <button type="button" onClick={onTryAgain} style={primaryButtonStyle}>
            Try again
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={sheetStyle}>
      <style>{matchingAnimations}</style>

      <div style={matchingWrapStyle}>
        <div style={visualStageStyle}>
          <div style={mapGlowStyle} />
          <div style={mapGlowDelayedStyle} />
          <div style={shimmerOrbStyle} />
          <div style={routeLineStyle} />
          <div style={routeDotStartStyle} />
          <div style={routeDotEndStyle} />
          <div style={loaderCoreStyle}>
            <div style={loaderPulseStyle} />
            <div style={loaderCenterStyle}>
              <svg
                width="26"
                height="26"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#0F172A"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="11" cy="11" r="7" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </div>
          </div>
        </div>

        <div style={contentStyle}>
          <div style={eyebrowStyle}>Live matching</div>
          <h2 style={titleStyle}>Finding a provider near you...</h2>
          <p key={messageIndex} style={matchingMessageStyle}>
            {MATCHING_MESSAGES[messageIndex]}
          </p>

          <div style={progressTrackStyle}>
            <div style={{ ...progressFillStyle, width: progressWidth }} />
          </div>

          <div style={infoGridStyle}>
            {detailChips.map((chip, index) => (
              <div
                key={chip.label}
                style={{
                  ...infoCardStyle,
                  ...(index === 0 ? infoCardHighlightStyle : null),
                }}
              >
                <div style={infoLabelStyle}>{chip.label}</div>
                <div
                  style={{
                    ...infoValueStyle,
                    ...(index === 0 ? infoValueHighlightStyle : null),
                  }}
                >
                  {chip.value}
                </div>
              </div>
            ))}
          </div>

          <div style={supportCopyStyle}>
            We’re checking nearby providers in real time and will move you forward as soon as one is available.
          </div>
        </div>
      </div>

      <button type="button" onClick={onCancel} style={cancelButtonStyle}>
        Cancel request
      </button>
    </div>
  )
}

const matchingAnimations = `
  @keyframes matchingSheetEnter {
    0% { opacity: 0; transform: translateY(24px); }
    100% { opacity: 1; transform: translateY(0); }
  }

  @keyframes matchingGlow {
    0% { opacity: 0.7; transform: scale(0.96); }
    50% { opacity: 1; transform: scale(1.02); }
    100% { opacity: 0.7; transform: scale(0.96); }
  }

  @keyframes matchingShimmer {
    0% { transform: translateX(-120%) rotate(8deg); opacity: 0; }
    30% { opacity: 0.42; }
    100% { transform: translateX(120%) rotate(8deg); opacity: 0; }
  }

  @keyframes matchingPulse {
    0% { transform: scale(0.92); opacity: 0.26; }
    70% { transform: scale(1.14); opacity: 0; }
    100% { transform: scale(1.14); opacity: 0; }
  }

  @keyframes matchingMessageEnter {
    0% { opacity: 0; transform: translateY(8px); }
    100% { opacity: 1; transform: translateY(0); }
  }
`

const sheetStyle: CSSProperties = {
  height: '100%',
  minHeight: 0,
  maxHeight: 'calc(100dvh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 148px)',
  background: 'linear-gradient(180deg, rgba(255,255,255,0.98) 0%, #FFFFFF 100%)',
  border: '1px solid rgba(226, 232, 240, 0.95)',
  borderRadius: 28,
  padding: '16px 16px calc(14px + env(safe-area-inset-bottom, 0px))',
  boxShadow: '0 20px 48px rgba(15, 23, 42, 0.10)',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'space-between',
  gap: 12,
  animation: 'matchingSheetEnter 260ms cubic-bezier(0.22, 1, 0.36, 1)',
  overflow: 'hidden',
  boxSizing: 'border-box',
}

const matchingWrapStyle: CSSProperties = {
  display: 'grid',
  gap: 12,
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  overscrollBehavior: 'contain',
  WebkitOverflowScrolling: 'touch',
  paddingRight: 2,
}

const visualStageStyle: CSSProperties = {
  position: 'relative',
  minHeight: 164,
  borderRadius: 22,
  overflow: 'hidden',
  background: 'linear-gradient(180deg, #EEF4FF 0%, #F8FBFF 100%)',
  border: '1px solid rgba(191, 219, 254, 0.9)',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.72)',
}

const mapGlowStyle: CSSProperties = {
  position: 'absolute',
  inset: '8% 16%',
  borderRadius: '50%',
  background: 'radial-gradient(circle, rgba(59,130,246,0.22) 0%, rgba(59,130,246,0.05) 48%, rgba(59,130,246,0) 72%)',
  animation: 'matchingGlow 2.8s ease-in-out infinite',
}

const mapGlowDelayedStyle: CSSProperties = {
  position: 'absolute',
  inset: '16% 24%',
  borderRadius: '50%',
  background: 'radial-gradient(circle, rgba(14,165,233,0.16) 0%, rgba(14,165,233,0.04) 52%, rgba(14,165,233,0) 72%)',
  animation: 'matchingGlow 2.8s ease-in-out infinite 0.5s',
}

const shimmerOrbStyle: CSSProperties = {
  position: 'absolute',
  top: '-10%',
  left: '-20%',
  width: '50%',
  height: '120%',
  background: 'linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.44) 50%, rgba(255,255,255,0) 100%)',
  animation: 'matchingShimmer 2.4s ease-in-out infinite',
}

const routeLineStyle: CSSProperties = {
  position: 'absolute',
  left: '27%',
  right: '27%',
  top: '50%',
  height: 0,
  borderTop: '2px dashed rgba(37, 99, 235, 0.34)',
}

const routeDotStartStyle: CSSProperties = {
  position: 'absolute',
  top: 'calc(50% - 6px)',
  left: '24%',
  width: 12,
  height: 12,
  borderRadius: '50%',
  background: '#2563EB',
  boxShadow: '0 0 0 8px rgba(37,99,235,0.10)',
}

const routeDotEndStyle: CSSProperties = {
  position: 'absolute',
  top: 'calc(50% - 7px)',
  right: '24%',
  width: 14,
  height: 14,
  borderRadius: '50%',
  background: '#0F172A',
  boxShadow: '0 0 0 8px rgba(15,23,42,0.08)',
}

const loaderCoreStyle: CSSProperties = {
  position: 'absolute',
  inset: '50% auto auto 50%',
  width: 74,
  height: 74,
  transform: 'translate(-50%, -50%)',
  display: 'grid',
  placeItems: 'center',
}

const loaderPulseStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  borderRadius: '50%',
  border: '8px solid rgba(37, 99, 235, 0.10)',
  animation: 'matchingPulse 1.8s ease-out infinite',
}

const loaderCenterStyle: CSSProperties = {
  position: 'relative',
  width: 48,
  height: 48,
  borderRadius: '50%',
  background: 'linear-gradient(180deg, #FFFFFF 0%, #F8FAFC 100%)',
  border: '1px solid rgba(191, 219, 254, 0.9)',
  display: 'grid',
  placeItems: 'center',
  boxShadow: '0 14px 34px rgba(37, 99, 235, 0.14)',
}

const contentStyle: CSSProperties = {
  display: 'grid',
  gap: 10,
}

const eyebrowStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 800,
  letterSpacing: 0.5,
  textTransform: 'uppercase',
  color: '#2563EB',
}

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 24,
  lineHeight: 1.08,
  fontWeight: 900,
  color: '#0F172A',
}

const matchingMessageStyle: CSSProperties = {
  margin: 0,
  minHeight: 20,
  fontSize: 14,
  lineHeight: 1.4,
  color: '#64748B',
  animation: 'matchingMessageEnter 220ms ease',
}

const progressTrackStyle: CSSProperties = {
  position: 'relative',
  overflow: 'hidden',
  height: 8,
  borderRadius: 999,
  background: 'rgba(226, 232, 240, 0.95)',
}

const progressFillStyle: CSSProperties = {
  height: '100%',
  borderRadius: 999,
  background: 'linear-gradient(90deg, #2563EB 0%, #60A5FA 58%, #93C5FD 100%)',
  transition: 'width 420ms ease',
}

const infoGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  gap: 8,
}

const infoCardStyle: CSSProperties = {
  minWidth: 0,
  borderRadius: 16,
  border: '1px solid rgba(226, 232, 240, 0.95)',
  background: '#FFFFFF',
  padding: '10px 8px',
  display: 'grid',
  gap: 4,
}

const infoCardHighlightStyle: CSSProperties = {
  background: 'linear-gradient(180deg, #EFF6FF 0%, #F8FBFF 100%)',
  border: '1px solid rgba(96, 165, 250, 0.4)',
}

const infoLabelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: '#94A3B8',
}

const infoValueStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 800,
  color: '#0F172A',
}

const infoValueHighlightStyle: CSSProperties = {
  color: '#1D4ED8',
}

const supportCopyStyle: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.45,
  color: '#475569',
}

const cancelButtonStyle: CSSProperties = {
  appearance: 'none',
  border: '1px solid rgba(226, 232, 240, 0.98)',
  background: '#FFFFFF',
  color: '#0F172A',
  minHeight: 46,
  borderRadius: 18,
  fontSize: 14,
  fontWeight: 800,
  cursor: 'pointer',
  flexShrink: 0,
}

const emptyWrapStyle: CSSProperties = {
  flex: 1,
  display: 'grid',
  alignContent: 'center',
  justifyItems: 'center',
  gap: 16,
  textAlign: 'center',
  padding: '12px 6px',
}

const emptyIconWrapStyle: CSSProperties = {
  position: 'relative',
  width: 92,
  height: 92,
  display: 'grid',
  placeItems: 'center',
}

const emptyHaloStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  borderRadius: '50%',
  background: 'radial-gradient(circle, rgba(148,163,184,0.18) 0%, rgba(148,163,184,0.06) 52%, rgba(148,163,184,0) 74%)',
}

const emptyIconStyle: CSSProperties = {
  position: 'relative',
  width: 58,
  height: 58,
  borderRadius: '50%',
  background: 'linear-gradient(180deg, #FFFFFF 0%, #F8FAFC 100%)',
  color: '#0F172A',
  border: '1px solid rgba(226, 232, 240, 0.95)',
  display: 'grid',
  placeItems: 'center',
  boxShadow: '0 14px 30px rgba(15, 23, 42, 0.08)',
}

const emptyTitleStyle: CSSProperties = {
  fontSize: 28,
  lineHeight: 1.06,
  fontWeight: 900,
  color: '#0F172A',
}

const emptySubtitleStyle: CSSProperties = {
  maxWidth: 280,
  fontSize: 15,
  lineHeight: 1.5,
  color: '#64748B',
}

const infoRowStyle: CSSProperties = {
  width: '100%',
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 10,
}

const compactInfoCardStyle: CSSProperties = {
  borderRadius: 18,
  border: '1px solid rgba(226, 232, 240, 0.95)',
  background: '#FFFFFF',
  padding: '12px 10px',
  display: 'grid',
  gap: 5,
}

const compactInfoLabelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: '#94A3B8',
}

const compactInfoValueStyle: CSSProperties = {
  fontSize: 15,
  fontWeight: 800,
  color: '#0F172A',
}

const primaryButtonStyle: CSSProperties = {
  appearance: 'none',
  border: 'none',
  minHeight: 52,
  borderRadius: 18,
  background: 'linear-gradient(180deg, #0F172A 0%, #233B74 100%)',
  color: '#FFFFFF',
  fontSize: 15,
  fontWeight: 800,
  padding: '0 22px',
  cursor: 'pointer',
  boxShadow: '0 18px 34px rgba(15, 23, 42, 0.14)',
}
