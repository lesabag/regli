import { useMemo } from 'react'

interface SearchingSheetProps {
  elapsedSeconds: number
  durationLabel: string
  priceLabel: string
  onCancel: () => void
}

type SearchStage = {
  title: string
  subtitle: string
  state: 'searching' | 'offering' | 'retrying'
}

function formatElapsed(seconds: number): string {
  const safe = Math.max(0, seconds)
  const mins = Math.floor(safe / 60)
  const secs = safe % 60
  return `${mins}:${String(secs).padStart(2, '0')}`
}

function getStage(elapsedSeconds: number): SearchStage {
  if (elapsedSeconds < 4) {
    return {
      title: 'Searching nearby walkers',
      subtitle: 'Checking who is online and closest to you right now.',
      state: 'searching',
    }
  }

  if (elapsedSeconds < 9) {
    return {
      title: 'Offering to a top match',
      subtitle: 'Your request is being offered to one of the best nearby walkers.',
      state: 'offering',
    }
  }

  if (elapsedSeconds < 16) {
    return {
      title: 'Trying the next best walker',
      subtitle: 'No worries, we are moving through top nearby matches automatically.',
      state: 'retrying',
    }
  }

  return {
    title: 'Still looking for the best match',
    subtitle: 'Dispatch is continuing in the background until a walker accepts.',
    state: 'retrying',
  }
}

export default function SearchingSheet({
  elapsedSeconds,
  durationLabel,
  priceLabel,
  onCancel,
}: SearchingSheetProps) {
  const stage = useMemo(() => getStage(elapsedSeconds), [elapsedSeconds])

  const progressWidth = useMemo(() => {
    const capped = Math.min(elapsedSeconds, 18)
    return `${Math.max(12, (capped / 18) * 100)}%`
  }, [elapsedSeconds])

  const dots = useMemo(() => {
    if (stage.state === 'searching') return [true, false, false]
    if (stage.state === 'offering') return [true, true, false]
    return [true, true, true]
  }, [stage.state])

  return (
    <div style={cardStyle}>
      <div style={topRowStyle}>
        <div style={pulseWrapStyle}>
          <div style={pulseRingStyle} />
          <div style={pulseRingDelayedStyle} />
          <div style={centerIconStyle}>
            <svg
              width="22"
              height="22"
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

        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={eyebrowStyle}>Live dispatch</div>
          <h2 style={titleStyle}>{stage.title}</h2>
          <p style={subtitleStyle}>{stage.subtitle}</p>
        </div>
      </div>

      <div style={progressTrackStyle}>
        <div style={{ ...progressFillStyle, width: progressWidth }} />
      </div>

      <div style={stepsRowStyle}>
        <StepDot active={dots[0]} label="Search" />
        <StepConnector active={dots[1]} />
        <StepDot active={dots[1]} label="Offer" />
        <StepConnector active={dots[2]} />
        <StepDot active={dots[2]} label="Retry" />
      </div>

      <div style={infoGridStyle}>
        <InfoCard label="Search time" value={formatElapsed(elapsedSeconds)} highlight />
        <InfoCard label="Duration" value={durationLabel} />
        <InfoCard label="Price" value={priceLabel} />
      </div>

      <div style={messageBoxStyle}>
        <div style={messageTitleStyle}>What is happening now?</div>
        <div style={messageTextStyle}>
          We rank nearby walkers by distance, rating, and acceptance history, then offer the
          walk one at a time until someone accepts.
        </div>
      </div>

      <button type="button" onClick={onCancel} style={cancelBtnStyle}>
        Cancel request
      </button>
    </div>
  )
}

function StepDot({ active, label }: { active: boolean; label: string }) {
  return (
    <div style={stepItemStyle}>
      <div
        style={{
          ...stepDotStyle,
          ...(active ? stepDotActiveStyle : {}),
        }}
      />
      <span
        style={{
          ...stepLabelStyle,
          ...(active ? stepLabelActiveStyle : {}),
        }}
      >
        {label}
      </span>
    </div>
  )
}

function StepConnector({ active }: { active: boolean }) {
  return (
    <div
      style={{
        ...stepConnectorStyle,
        ...(active ? stepConnectorActiveStyle : {}),
      }}
    />
  )
}

function InfoCard({
  label,
  value,
  highlight = false,
}: {
  label: string
  value: string
  highlight?: boolean
}) {
  return (
    <div
      style={{
        ...infoCardStyle,
        ...(highlight ? infoCardHighlightStyle : {}),
      }}
    >
      <div style={infoLabelStyle}>{label}</div>
      <div
        style={{
          ...infoValueStyle,
          ...(highlight ? infoValueHighlightStyle : {}),
        }}
      >
        {value}
      </div>
    </div>
  )
}

const cardStyle: React.CSSProperties = {
  background: '#FFFFFF',
  border: '1px solid #E2E8F0',
  borderRadius: 24,
  padding: 20,
  boxShadow: '0 10px 32px rgba(15, 23, 42, 0.06)',
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
}

const topRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 16,
}

const pulseWrapStyle: React.CSSProperties = {
  position: 'relative',
  width: 72,
  height: 72,
  flexShrink: 0,
}

const pulseRingStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  borderRadius: '50%',
  background: 'rgba(37, 99, 235, 0.10)',
  animation: 'searchPulse 1.8s ease-out infinite',
}

const pulseRingDelayedStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 8,
  borderRadius: '50%',
  background: 'rgba(37, 99, 235, 0.14)',
  animation: 'searchPulse 1.8s ease-out infinite 0.4s',
}

const centerIconStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 16,
  borderRadius: '50%',
  background: '#FFFFFF',
  border: '1px solid #DBEAFE',
  display: 'grid',
  placeItems: 'center',
  boxShadow: '0 6px 18px rgba(37, 99, 235, 0.12)',
}

const eyebrowStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  textTransform: 'uppercase',
  letterSpacing: 0.6,
  color: '#2563EB',
  marginBottom: 6,
}

const titleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 22,
  lineHeight: 1.15,
  fontWeight: 800,
  color: '#0F172A',
  letterSpacing: -0.4,
}

const subtitleStyle: React.CSSProperties = {
  margin: '8px 0 0',
  fontSize: 14,
  lineHeight: 1.5,
  color: '#64748B',
}

const progressTrackStyle: React.CSSProperties = {
  width: '100%',
  height: 8,
  borderRadius: 999,
  background: '#E2E8F0',
  overflow: 'hidden',
}

const progressFillStyle: React.CSSProperties = {
  height: '100%',
  borderRadius: 999,
  background: 'linear-gradient(90deg, #2563EB, #60A5FA)',
  transition: 'width 0.8s ease',
}

const stepsRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
}

const stepItemStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexShrink: 0,
}

const stepDotStyle: React.CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: '50%',
  background: '#CBD5E1',
  transition: 'all 0.25s ease',
}

const stepDotActiveStyle: React.CSSProperties = {
  background: '#2563EB',
  boxShadow: '0 0 0 4px rgba(37, 99, 235, 0.12)',
}

const stepLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: '#94A3B8',
}

const stepLabelActiveStyle: React.CSSProperties = {
  color: '#2563EB',
}

const stepConnectorStyle: React.CSSProperties = {
  height: 2,
  flex: 1,
  minWidth: 12,
  background: '#E2E8F0',
  borderRadius: 999,
}

const stepConnectorActiveStyle: React.CSSProperties = {
  background: '#93C5FD',
}

const infoGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  gap: 10,
}

const infoCardStyle: React.CSSProperties = {
  borderRadius: 16,
  padding: '12px 12px',
  background: '#F8FAFC',
  border: '1px solid #E2E8F0',
}

const infoCardHighlightStyle: React.CSSProperties = {
  background: '#EFF6FF',
  border: '1px solid #BFDBFE',
}

const infoLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  color: '#94A3B8',
}

const infoValueStyle: React.CSSProperties = {
  marginTop: 6,
  fontSize: 16,
  fontWeight: 800,
  color: '#0F172A',
}

const infoValueHighlightStyle: React.CSSProperties = {
  color: '#1D4ED8',
}

const messageBoxStyle: React.CSSProperties = {
  borderRadius: 16,
  padding: 14,
  background: '#F8FAFC',
  border: '1px solid #E2E8F0',
}

const messageTitleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 800,
  color: '#0F172A',
  marginBottom: 6,
}

const messageTextStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.5,
  color: '#64748B',
}

const cancelBtnStyle: React.CSSProperties = {
  width: '100%',
  height: 52,
  borderRadius: 16,
  border: '1px solid #E2E8F0',
  background: '#FFFFFF',
  color: '#334155',
  fontSize: 15,
  fontWeight: 800,
  cursor: 'pointer',
}
