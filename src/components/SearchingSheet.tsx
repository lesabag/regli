import { useMemo, type CSSProperties } from 'react'

import babyImg from '../assets/matching/baby.svg'
import cleaningImg from '../assets/matching/cleaning.svg'
import defaultImg from '../assets/matching/default.svg'
import dogCharacterImg from '../assets/matching/dog.svg'
import technicianImg from '../assets/matching/technician.svg'

interface SearchingSheetProps {
  searchStartedAt: number | null
  elapsedSeconds: number
  durationLabel: string
  priceLabel: string
  mode: 'matching' | 'empty'
  serviceType?: string | null
  emptyTitle?: string
  emptySubtitle?: string
  onCancel: () => void
  onTryAgain?: () => void
}

type MatchingVisual = {
  asset: string
  title: string
  emptyTitle: string
  emptySubtitle: string
  tone: 'pet' | 'sitter' | 'cleaning' | 'default'
}

function getMatchingVisual(serviceType?: string | null): MatchingVisual {
  const normalized = (serviceType || '').trim().toLowerCase()

  if (
    normalized.includes('dog') ||
    normalized.includes('pet') ||
    normalized.includes('walk') ||
    normalized === 'quick' ||
    normalized === 'standard' ||
    normalized === 'energy'
  ) {
    return {
      asset: dogCharacterImg,
      title: 'Finding your provider...',
      emptyTitle: 'No providers available right now',
      emptySubtitle: 'Nearby providers are busy. Try again or schedule for later.',
      tone: 'pet',
    }
  }

  if (
    normalized.includes('baby') ||
    normalized.includes('child') ||
    normalized.includes('sitter') ||
    normalized.includes('nanny')
  ) {
    return {
      asset: babyImg,
      title: 'Finding a sitter near you…',
      emptyTitle: 'No providers available right now',
      emptySubtitle: 'Nearby providers are busy. Try again or schedule for later.',
      tone: 'sitter',
    }
  }

  if (
    normalized.includes('tech') ||
    normalized.includes('repair') ||
    normalized.includes('fix') ||
    normalized.includes('handyman')
  ) {
    return {
      asset: technicianImg,
      title: 'Finding a technician near you…',
      emptyTitle: 'No providers available right now',
      emptySubtitle: 'Nearby providers are busy. Try again or schedule for later.',
      tone: 'default',
    }
  }

  if (normalized.includes('clean')) {
    return {
      asset: cleaningImg,
      title: 'Finding a cleaner near you…',
      emptyTitle: 'No providers available right now',
      emptySubtitle: 'Nearby providers are busy. Try again or schedule for later.',
      tone: 'cleaning',
    }
  }

  return {
    asset: defaultImg,
    title: 'Finding a provider near you…',
    emptyTitle: 'No providers available right now',
    emptySubtitle: 'Nearby providers are busy. Try again or schedule for later.',
    tone: 'default',
  }
}

function formatElapsed(seconds: number): string {
  const safe = Math.max(0, seconds)
  const mins = Math.floor(safe / 60)
  const secs = safe % 60
  return `${mins}:${String(secs).padStart(2, '0')}`
}

export default function SearchingSheet({
  searchStartedAt,
  elapsedSeconds,
  durationLabel,
  priceLabel,
  mode,
  serviceType,
  emptyTitle,
  emptySubtitle,
  onCancel,
  onTryAgain,
}: SearchingSheetProps) {
  const visual = useMemo(() => getMatchingVisual(serviceType), [serviceType])
  const safeElapsedSeconds = searchStartedAt ? elapsedSeconds : 0

  const progressWidth = useMemo(() => {
    const capped = Math.min(safeElapsedSeconds, 18)
    return `${Math.max(18, (capped / 18) * 100)}%`
  }, [safeElapsedSeconds])

  if (mode === 'empty') {
    return (
      <div style={sheetStyle}>
        <style>{matchingAnimations}</style>
        <div style={emptyWrapStyle}>
          <CompactRadar asset={visual.asset} tone={visual.tone} muted />

          <div style={emptyCopyStyle}>
            <div style={emptyTitleStyle}>{emptyTitle || visual.emptyTitle}</div>
            <div style={emptySubtitleStyle}>{emptySubtitle || visual.emptySubtitle}</div>
          </div>

          <div style={detailRowStyle}>
            <div style={detailChipStyle}>
              <span style={detailChipLabelStyle}>Duration</span>
              <span style={detailChipValueStyle}>{durationLabel || 'Service'}</span>
            </div>
            <div style={detailDividerStyle} />
            <div style={detailChipStyle}>
              <span style={detailChipLabelStyle}>Price</span>
              <span style={detailChipValueStyle}>{priceLabel || '—'}</span>
            </div>
          </div>

          <button type="button" onClick={onTryAgain} style={primaryButtonStyle}>
            <span style={buttonIconStyle}>↻</span>
            Try again
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={sheetStyle}>
      <style>{matchingAnimations}</style>

      <div style={matchingRowStyle}>
        <CompactRadar asset={visual.asset} tone={visual.tone} />

        <div style={matchingContentStyle}>
          <h2 style={titleStyle}>{visual.title}</h2>
          <div style={timerRowStyle}>
            <span style={liveDotStyle} />
            <span style={timerValueStyle}>{formatElapsed(safeElapsedSeconds)}</span>
          </div>
        </div>
      </div>

      <div style={progressTrackStyle}>
        <div style={{ ...progressFillStyle, width: progressWidth }} />
      </div>

      <div style={detailRowStyle}>
        <div style={detailChipStyle}>
          <span style={detailChipLabelStyle}>Duration</span>
          <span style={detailChipValueStyle}>{durationLabel || 'Service'}</span>
        </div>
        <div style={detailDividerStyle} />
        <div style={detailChipStyle}>
          <span style={detailChipLabelStyle}>Price</span>
          <span style={detailChipValueStyle}>{priceLabel || '—'}</span>
        </div>
      </div>

      <button type="button" onClick={onCancel} style={cancelButtonStyle}>
        Cancel request
      </button>
    </div>
  )
}

function CompactRadar({
  asset,
  tone,
  muted = false,
}: {
  asset: string
  tone: MatchingVisual['tone']
  muted?: boolean
}) {
  const toneColors = getToneColors(tone)
  const size = muted ? 64 : 80

  return (
    <div style={{ ...radarWrapStyle, width: size, height: size }}>
      <div
        style={{
          ...radarGlowStyle,
          background: muted ? mutedGlow : toneColors.glow,
        }}
      />
      <div style={{ ...radarOrbitStyle, borderColor: muted ? mutedBorder : toneColors.borderSoft }} />
      {!muted && (
        <div
          style={{
            ...radarRingStyle,
            borderColor: toneColors.border,
            width: size - 6,
            height: size - 6,
          }}
        />
      )}
      {!muted && (
        <div
          style={{
            ...radarRingStyle,
            borderColor: toneColors.border,
            width: size - 6,
            height: size - 6,
            animationDelay: '650ms',
          }}
        />
      )}
      <img
        src={asset}
        alt=""
        style={{
          ...radarAssetStyle,
          width: size * 0.7,
          height: size * 0.7,
          animation: muted ? 'none' : 'radarAssetBounce 2.2s ease-in-out infinite',
        }}
      />
    </div>
  )
}

function getToneColors(tone: MatchingVisual['tone']) {
  if (tone === 'sitter') {
    return {
      glow: 'radial-gradient(circle, rgba(168,85,247,0.18) 0%, rgba(168,85,247,0) 70%)',
      border: 'rgba(168,85,247,0.30)',
      borderSoft: 'rgba(168,85,247,0.14)',
    }
  }
  if (tone === 'cleaning') {
    return {
      glow: 'radial-gradient(circle, rgba(20,184,166,0.18) 0%, rgba(20,184,166,0) 70%)',
      border: 'rgba(20,184,166,0.30)',
      borderSoft: 'rgba(20,184,166,0.14)',
    }
  }
  return {
    glow: 'radial-gradient(circle, rgba(37,99,235,0.20) 0%, rgba(37,99,235,0) 70%)',
    border: 'rgba(37,99,235,0.28)',
    borderSoft: 'rgba(37,99,235,0.12)',
  }
}

const matchingAnimations = `
  @keyframes matchingSheetEnter {
    0% { opacity: 0; transform: translateY(16px); }
    100% { opacity: 1; transform: translateY(0); }
  }

  @keyframes radarRing {
    0% { transform: translate(-50%, -50%) scale(0.4); opacity: 0.4; }
    70% { opacity: 0.06; }
    100% { transform: translate(-50%, -50%) scale(1.1); opacity: 0; }
  }

  @keyframes radarAssetBounce {
    0%, 100% { transform: scale(0.97) rotate(-1deg); }
    50% { transform: scale(1.04) rotate(1deg); }
  }

  @keyframes matchingMessageEnter {
    0% { opacity: 0; transform: translateY(6px); }
    100% { opacity: 1; transform: translateY(0); }
  }
`

const mutedGlow = 'radial-gradient(circle, rgba(148,163,184,0.16) 0%, rgba(148,163,184,0) 70%)'
const mutedBorder = 'rgba(148,163,184,0.16)'

const sheetStyle: CSSProperties = {
  background: '#FFFFFF',
  borderRadius: 22,
  padding: '12px 14px 14px',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  animation: 'matchingSheetEnter 240ms cubic-bezier(0.22, 1, 0.36, 1)',
  boxSizing: 'border-box',
}

const matchingRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 14,
}

const matchingContentStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
}

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 17,
  lineHeight: 1.18,
  fontWeight: 900,
  color: '#0F172A',
}

const timerRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 7,
}

const liveDotStyle: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: '50%',
  background: '#2563EB',
  boxShadow: '0 0 0 4px rgba(37,99,235,0.10)',
  flexShrink: 0,
}

const timerValueStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 800,
  color: '#64748B',
  fontVariantNumeric: 'tabular-nums',
}

const progressTrackStyle: CSSProperties = {
  position: 'relative',
  overflow: 'hidden',
  height: 5,
  borderRadius: 999,
  background: 'rgba(226,232,240,0.95)',
}

const progressFillStyle: CSSProperties = {
  height: '100%',
  borderRadius: 999,
  background: 'linear-gradient(90deg, #2563EB 0%, #60A5FA 58%, #93C5FD 100%)',
  transition: 'width 420ms ease',
}

const detailRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 0,
  borderRadius: 14,
  border: '1px solid rgba(226,232,240,0.95)',
  background: '#FAFBFC',
  overflow: 'hidden',
}

const detailChipStyle: CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 2,
  padding: '8px 6px',
}

const detailDividerStyle: CSSProperties = {
  width: 1,
  alignSelf: 'stretch',
  background: 'rgba(226,232,240,0.95)',
}

const detailChipLabelStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 800,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  color: '#94A3B8',
}

const detailChipValueStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 800,
  color: '#0F172A',
}

const cancelButtonStyle: CSSProperties = {
  appearance: 'none',
  border: '1px solid rgba(226,232,240,0.98)',
  background: '#FFFFFF',
  color: '#0F172A',
  minHeight: 38,
  borderRadius: 14,
  fontSize: 13,
  fontWeight: 800,
  cursor: 'pointer',
  flexShrink: 0,
}

const emptyWrapStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 12,
  textAlign: 'center',
  padding: '4px 4px',
}

const emptyCopyStyle: CSSProperties = {
  display: 'grid',
  gap: 4,
}

const emptyTitleStyle: CSSProperties = {
  fontSize: 18,
  lineHeight: 1.15,
  fontWeight: 900,
  color: '#0F172A',
}

const emptySubtitleStyle: CSSProperties = {
  maxWidth: 280,
  fontSize: 13,
  lineHeight: 1.4,
  color: '#64748B',
}

const primaryButtonStyle: CSSProperties = {
  appearance: 'none',
  border: 'none',
  minHeight: 44,
  borderRadius: 14,
  background: 'linear-gradient(180deg, #2563EB 0%, #1D4ED8 100%)',
  color: '#FFFFFF',
  fontSize: 14,
  fontWeight: 900,
  padding: '0 20px',
  cursor: 'pointer',
  boxShadow: '0 12px 28px rgba(37,99,235,0.18)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 7,
  width: '100%',
}

const buttonIconStyle: CSSProperties = {
  fontSize: 16,
  lineHeight: 1,
}

const radarWrapStyle: CSSProperties = {
  position: 'relative',
  display: 'grid',
  placeItems: 'center',
  flexShrink: 0,
}

const radarGlowStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  borderRadius: '50%',
  filter: 'blur(4px)',
  opacity: 0.6,
}

const radarOrbitStyle: CSSProperties = {
  position: 'absolute',
  inset: 4,
  borderRadius: '50%',
  border: '1px solid',
}

const radarRingStyle: CSSProperties = {
  position: 'absolute',
  top: '50%',
  left: '50%',
  borderRadius: '50%',
  border: '1.5px solid',
  animation: 'radarRing 1.9s ease-out infinite',
}

const radarAssetStyle: CSSProperties = {
  position: 'relative',
  objectFit: 'contain',
  display: 'block',
}
