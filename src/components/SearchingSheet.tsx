import { useMemo, type CSSProperties } from 'react'

import babyImg from '../assets/matching/baby.svg'
import cleaningImg from '../assets/matching/cleaning.svg'
import defaultImg from '../assets/matching/default.svg'
import dogCharacterImg from '../assets/matching/dog.svg'

interface SearchingSheetProps {
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
  label: string
  title: string
  support: string
  stageLabel: string
  stages: readonly string[]
  emptyAsset: string
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
      label: 'Pet care matching',
      title: 'Finding a pet care provider near you...',
      support: 'We’re checking nearby pet care providers in real time.',
      stageLabel: 'Nearby pet providers',
      stages: [
        'Sniffing around nearby...',
        'Asking nearby pet providers...',
        'Waiting for a reply...',
        'Trying the next best match...',
      ],
      emptyAsset: dogCharacterImg,
      emptyTitle: 'No one could take this request right now',
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
      label: 'Sitter matching',
      title: 'Finding a trusted sitter near you...',
      support: 'We’re checking nearby trusted sitters in real time.',
      stageLabel: 'Trusted sitters nearby',
      stages: [
        'Checking trusted sitters nearby...',
        'Asking an available sitter...',
        'Waiting for a reply...',
        'Trying the next trusted match...',
      ],
      emptyAsset: babyImg,
      emptyTitle: 'No sitter could take this request right now',
      emptySubtitle: 'Trusted sitters nearby are busy. Try again or schedule for later.',
      tone: 'sitter',
    }
  }

  if (normalized.includes('clean')) {
    return {
      asset: cleaningImg,
      label: 'Cleaner matching',
      title: 'Finding a cleaner near you...',
      support: 'We’re checking nearby available cleaners in real time.',
      stageLabel: 'Available cleaners nearby',
      stages: [
        'Checking cleaners nearby...',
        'Asking an available cleaner...',
        'Waiting for a reply...',
        'Trying the next best match...',
      ],
      emptyAsset: cleaningImg,
      emptyTitle: 'No cleaner could take this request right now',
      emptySubtitle: 'Cleaners nearby are busy. Try again or schedule for later.',
      tone: 'cleaning',
    }
  }

  return {
    asset: defaultImg,
    label: 'Live matching',
    title: 'Finding a provider near you...',
    support: 'We’re checking nearby providers in real time.',
    stageLabel: 'Available providers nearby',
    stages: [
      'Looking nearby...',
      'Asking available providers...',
      'Waiting for a reply...',
      'Trying the next best match...',
    ],
    emptyAsset: defaultImg,
    emptyTitle: 'No one could take this request right now',
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

function getStageIndex(elapsedSeconds: number, stageCount: number): number {
  if (stageCount <= 1) return 0
  if (elapsedSeconds < 4) return 0
  if (elapsedSeconds < 9) return Math.min(1, stageCount - 1)
  if (elapsedSeconds < 16) return Math.min(2, stageCount - 1)
  return stageCount - 1
}

export default function SearchingSheet({
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
  const stageIndex = getStageIndex(elapsedSeconds, visual.stages.length)
  const currentMessage = visual.stages[stageIndex]

  const progressWidth = useMemo(() => {
    const capped = Math.min(elapsedSeconds, 18)
    return `${Math.max(18, (capped / 18) * 100)}%`
  }, [elapsedSeconds])

  const detailChips = useMemo(
    () => [
      { label: 'Search time', value: formatElapsed(elapsedSeconds), icon: '⏱' },
      { label: 'Duration', value: durationLabel || 'Service', icon: '⌛' },
      { label: 'Price', value: priceLabel || '—', icon: '₪' },
    ],
    [durationLabel, elapsedSeconds, priceLabel],
  )

  if (mode === 'empty') {
    return (
      <div style={sheetStyle}>
        <style>{matchingAnimations}</style>
        <div style={emptyWrapStyle}>
          <MatchingRadar asset={visual.emptyAsset} tone={visual.tone} muted />

          <div style={emptyCopyStyle}>
            <div style={emptyTitleStyle}>{emptyTitle || visual.emptyTitle}</div>
            <div style={emptySubtitleStyle}>{emptySubtitle || visual.emptySubtitle}</div>
          </div>

          <div style={infoRowStyle}>
            {detailChips.slice(1).map((chip) => (
              <div key={chip.label} style={compactInfoCardStyle}>
                <div style={compactInfoLabelStyle}>{chip.label}</div>
                <div style={compactInfoValueStyle}>{chip.value}</div>
              </div>
            ))}
          </div>

          <div style={emptyTipStyle}>
            <span style={tipIconStyle}>💡</span>
            <span>Tip: try again in a few minutes or choose a different time.</span>
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

      <div style={matchingWrapStyle}>
        <div style={visualStageStyle}>
          <div style={shimmerOrbStyle} />
          <MatchingRadar asset={visual.asset} tone={visual.tone} />
        </div>

        <div style={contentStyle}>
          <div style={eyebrowRowStyle}>
            <span style={liveDotStyle} />
            <span style={eyebrowStyle}>{visual.label}</span>
          </div>

          <h2 style={titleStyle}>{visual.title}</h2>

          <div style={statusCardStyle}>
            <div style={statusIconBubbleStyle}>{stageIndex >= 2 ? '⏳' : stageIndex === 1 ? '📨' : '📡'}</div>
            <div style={statusTextStyle}>
              <p key={currentMessage} style={matchingMessageStyle}>
                {currentMessage}
              </p>
              <p style={statusSubcopyStyle}>{visual.stageLabel}</p>
            </div>
          </div>

          <div style={stageDotsStyle} aria-hidden="true">
            {visual.stages.map((stage, index) => (
              <span
                key={stage}
                style={{
                  ...stageDotStyle,
                  ...(index <= stageIndex ? stageDotActiveStyle : null),
                }}
              />
            ))}
          </div>

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
                <div style={infoCardTopStyle}>
                  <span style={infoIconStyle}>{chip.icon}</span>
                  <span style={infoLabelStyle}>{chip.label}</span>
                </div>
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
            <span style={shieldIconStyle}>✓</span>
            <span>{visual.support}</span>
          </div>
        </div>
      </div>

      <button type="button" onClick={onCancel} style={cancelButtonStyle}>
        Cancel request
      </button>
    </div>
  )
}

function MatchingRadar({
  asset,
  tone,
  muted = false,
}: {
  asset: string
  tone: MatchingVisual['tone']
  muted?: boolean
}) {
  const toneStyles = getToneStyles(tone)

  return (
    <div style={radarWrapStyle}>
      <div
        style={{
          ...radarSoftGlowStyle,
          background: muted ? mutedGlow : toneStyles.glow,
        }}
      />
      <div style={{ ...radarOrbitStyle, borderColor: muted ? mutedBorder : toneStyles.borderSoft }} />
      <div style={{ ...radarOrbitMidStyle, borderColor: muted ? mutedBorder : toneStyles.borderSoft }} />
      <div style={{ ...radarOrbitSmallStyle, borderColor: muted ? mutedBorder : toneStyles.borderSoft }} />
      <div style={{ ...radarRingStyle, borderColor: muted ? mutedBorder : toneStyles.border, animationDelay: '0ms' }} />
      <div style={{ ...radarRingStyle, borderColor: muted ? mutedBorder : toneStyles.border, animationDelay: '520ms' }} />
      <div style={{ ...radarRingStyle, borderColor: muted ? mutedBorder : toneStyles.border, animationDelay: '1040ms' }} />
      {!muted && <div style={{ ...radarSweepStyle, background: toneStyles.sweep }} />}
      {!muted && <div style={{ ...providerPingStyle, ...providerPingOneStyle }} />}
      {!muted && <div style={{ ...providerPingStyle, ...providerPingTwoStyle }} />}
      {!muted && <div style={{ ...providerPingStyle, ...providerPingThreeStyle }} />}
      <div
        style={{
          ...radarCenterStyle,
          ...(muted ? radarCenterMutedStyle : null),
        }}
      >
        <img src={asset} alt="Matching service" style={radarAssetStyle} />
      </div>
    </div>
  )
}

function getToneStyles(tone: MatchingVisual['tone']) {
  if (tone === 'sitter') {
    return {
      glow:
        'radial-gradient(circle, rgba(168, 85, 247, 0.20) 0%, rgba(168, 85, 247, 0.07) 48%, rgba(168, 85, 247, 0) 74%)',
      sweep:
        'conic-gradient(from 0deg, rgba(168,85,247,0.24), rgba(168,85,247,0.05) 18%, rgba(168,85,247,0) 30%, rgba(168,85,247,0) 100%)',
      border: 'rgba(168, 85, 247, 0.34)',
      borderSoft: 'rgba(168, 85, 247, 0.16)',
    }
  }

  if (tone === 'cleaning') {
    return {
      glow:
        'radial-gradient(circle, rgba(20, 184, 166, 0.20) 0%, rgba(20, 184, 166, 0.07) 48%, rgba(20, 184, 166, 0) 74%)',
      sweep:
        'conic-gradient(from 0deg, rgba(20,184,166,0.24), rgba(20,184,166,0.05) 18%, rgba(20,184,166,0) 30%, rgba(20,184,166,0) 100%)',
      border: 'rgba(20, 184, 166, 0.34)',
      borderSoft: 'rgba(20, 184, 166, 0.16)',
    }
  }

  return {
    glow:
      'radial-gradient(circle, rgba(37, 99, 235, 0.22) 0%, rgba(37, 99, 235, 0.08) 48%, rgba(37, 99, 235, 0) 74%)',
    sweep:
      'conic-gradient(from 0deg, rgba(37,99,235,0.24), rgba(37,99,235,0.05) 18%, rgba(37,99,235,0) 30%, rgba(37,99,235,0) 100%)',
    border: 'rgba(37, 99, 235, 0.32)',
    borderSoft: 'rgba(37, 99, 235, 0.14)',
  }
}

const matchingAnimations = `
  @keyframes matchingSheetEnter {
    0% { opacity: 0; transform: translateY(24px); }
    100% { opacity: 1; transform: translateY(0); }
  }

  @keyframes matchingShimmer {
    0% { transform: translateX(-120%) rotate(8deg); opacity: 0; }
    30% { opacity: 0.42; }
    100% { transform: translateX(120%) rotate(8deg); opacity: 0; }
  }

  @keyframes radarRing {
    0% { transform: translate(-50%, -50%) scale(0.38); opacity: 0.42; }
    72% { opacity: 0.08; }
    100% { transform: translate(-50%, -50%) scale(1.08); opacity: 0; }
  }

  @keyframes radarSweep {
    0% { transform: translate(-50%, -50%) rotate(0deg); }
    100% { transform: translate(-50%, -50%) rotate(360deg); }
  }

  @keyframes radarHeroFloat {
    0%, 100% { transform: translateY(0) scale(1); }
    50% { transform: translateY(-4px) scale(1.035); }
  }

  @keyframes radarAssetBounce {
    0%, 100% { transform: scale(0.985) rotate(-1deg); }
    50% { transform: scale(1.045) rotate(1deg); }
  }

  @keyframes providerOrbitOne {
    0% { transform: rotate(0deg) translateX(62px) rotate(0deg) scale(0.86); opacity: 0.48; }
    50% { opacity: 1; }
    100% { transform: rotate(360deg) translateX(62px) rotate(-360deg) scale(0.86); opacity: 0.48; }
  }

  @keyframes providerOrbitTwo {
    0% { transform: rotate(130deg) translateX(50px) rotate(-130deg) scale(0.72); opacity: 0.38; }
    50% { opacity: 0.9; }
    100% { transform: rotate(490deg) translateX(50px) rotate(-490deg) scale(0.72); opacity: 0.38; }
  }

  @keyframes providerOrbitThree {
    0% { transform: rotate(250deg) translateX(68px) rotate(-250deg) scale(0.64); opacity: 0.24; }
    50% { opacity: 0.76; }
    100% { transform: rotate(610deg) translateX(68px) rotate(-610deg) scale(0.64); opacity: 0.24; }
  }

  @keyframes matchingMessageEnter {
    0% { opacity: 0; transform: translateY(8px); }
    100% { opacity: 1; transform: translateY(0); }
  }
`

const mutedGlow =
  'radial-gradient(circle, rgba(148, 163, 184, 0.20) 0%, rgba(148, 163, 184, 0.07) 48%, rgba(148, 163, 184, 0) 74%)'
const mutedBorder = 'rgba(148, 163, 184, 0.18)'

const sheetStyle: CSSProperties = {
  height: '100%',
  minHeight: 0,
  maxHeight:
    'calc(100dvh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 148px)',
  background: 'linear-gradient(180deg, rgba(255,255,255,0.98) 0%, #FFFFFF 100%)',
  border: '1px solid rgba(226, 232, 240, 0.95)',
  borderRadius: 28,
  padding: '14px 16px calc(12px + env(safe-area-inset-bottom, 0px))',
  boxShadow: '0 20px 48px rgba(15, 23, 42, 0.10)',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'space-between',
  gap: 8,
  animation: 'matchingSheetEnter 260ms cubic-bezier(0.22, 1, 0.36, 1)',
  overflow: 'hidden',
  boxSizing: 'border-box',
}

const matchingWrapStyle: CSSProperties = {
  display: 'grid',
  gap: 8,
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  overscrollBehavior: 'contain',
  WebkitOverflowScrolling: 'touch',
  paddingRight: 2,
}

const visualStageStyle: CSSProperties = {
  position: 'relative',
  minHeight: 132,
  borderRadius: 22,
  overflow: 'hidden',
  background:
    'radial-gradient(circle at 50% 48%, #FFFFFF 0%, #EEF4FF 42%, #F8FBFF 100%)',
  border: '1px solid rgba(191, 219, 254, 0.9)',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.72)',
  display: 'grid',
  placeItems: 'center',
}

const shimmerOrbStyle: CSSProperties = {
  position: 'absolute',
  top: '-10%',
  left: '-20%',
  width: '50%',
  height: '120%',
  background:
    'linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.44) 50%, rgba(255,255,255,0) 100%)',
  animation: 'matchingShimmer 2.4s ease-in-out infinite',
}

const radarWrapStyle: CSSProperties = {
  position: 'relative',
  width: 148,
  height: 118,
  display: 'grid',
  placeItems: 'center',
}

const radarSoftGlowStyle: CSSProperties = {
  position: 'absolute',
  inset: 1,
  borderRadius: '50%',
  filter: 'blur(5px)',
  opacity: 0.62,
}

const radarOrbitStyle: CSSProperties = {
  position: 'absolute',
  inset: 7,
  borderRadius: '50%',
  border: '1px solid',
}

const radarOrbitMidStyle: CSSProperties = {
  position: 'absolute',
  inset: 24,
  borderRadius: '50%',
  border: '1px solid',
}

const radarOrbitSmallStyle: CSSProperties = {
  position: 'absolute',
  inset: 42,
  borderRadius: '50%',
  border: '1px solid',
}

const radarRingStyle: CSSProperties = {
  position: 'absolute',
  top: '50%',
  left: '50%',
  width: 142,
  height: 142,
  borderRadius: '50%',
  border: '1.5px solid',
  animation: 'radarRing 1.95s ease-out infinite',
}

const radarSweepStyle: CSSProperties = {
  position: 'absolute',
  top: '50%',
  left: '50%',
  width: 134,
  height: 134,
  borderRadius: '50%',
  transform: 'translate(-50%, -50%)',
  animation: 'radarSweep 2.6s linear infinite',
}

const providerPingStyle: CSSProperties = {
  position: 'absolute',
  top: '50%',
  left: '50%',
  width: 12,
  height: 12,
  marginTop: -6,
  marginLeft: -6,
  borderRadius: '50%',
  background: '#2563EB',
  boxShadow: '0 0 0 7px rgba(37,99,235,0.10)',
}

const providerPingOneStyle: CSSProperties = {
  animation: 'providerOrbitOne 5.4s linear infinite',
}

const providerPingTwoStyle: CSSProperties = {
  width: 10,
  height: 10,
  marginTop: -5,
  marginLeft: -5,
  background: '#38BDF8',
  boxShadow: '0 0 0 6px rgba(56,189,248,0.10)',
  animation: 'providerOrbitTwo 6.8s linear infinite',
}

const providerPingThreeStyle: CSSProperties = {
  width: 8,
  height: 8,
  marginTop: -4,
  marginLeft: -4,
  background: '#93C5FD',
  boxShadow: '0 0 0 5px rgba(147,197,253,0.10)',
  animation: 'providerOrbitThree 7.7s linear infinite',
}

const radarCenterStyle: CSSProperties = {
  position: 'relative',
  width: 118,
  height: 90,
  display: 'grid',
  placeItems: 'center',
  background: 'transparent',
  border: 'none',
  borderRadius: 0,
  boxShadow: 'none',
  animation: 'radarHeroFloat 2.1s ease-in-out infinite',
}

const radarCenterMutedStyle: CSSProperties = {
  border: 'none',
  boxShadow: 'none',
  animation: 'none',
}

const radarAssetStyle: CSSProperties = {
  width: 132,
  height: 94,
  objectFit: 'contain',
  display: 'block',
  background: 'transparent',
  filter: 'none',
  animation: 'radarAssetBounce 1.9s ease-in-out infinite',
}

const contentStyle: CSSProperties = {
  display: 'grid',
  gap: 7,
}

const eyebrowRowStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
}

const liveDotStyle: CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: '50%',
  background: '#2563EB',
  boxShadow: '0 0 0 5px rgba(37,99,235,0.10)',
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
  fontSize: 21,
  lineHeight: 1.06,
  fontWeight: 900,
  color: '#0F172A',
}

const statusCardStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '34px 1fr',
  gap: 8,
  alignItems: 'center',
}

const statusIconBubbleStyle: CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: '50%',
  background: '#EFF6FF',
  display: 'grid',
  placeItems: 'center',
  fontSize: 18,
}

const statusTextStyle: CSSProperties = {
  minWidth: 0,
}

const matchingMessageStyle: CSSProperties = {
  margin: 0,
  minHeight: 18,
  fontSize: 14,
  lineHeight: 1.35,
  fontWeight: 800,
  color: '#475569',
  animation: 'matchingMessageEnter 220ms ease',
}

const statusSubcopyStyle: CSSProperties = {
  margin: '2px 0 0',
  fontSize: 12,
  color: '#94A3B8',
  fontWeight: 700,
}

const stageDotsStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
}

const stageDotStyle: CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: 999,
  background: '#CBD5E1',
  transition: 'background 220ms ease, width 220ms ease',
}

const stageDotActiveStyle: CSSProperties = {
  width: 18,
  background: '#2563EB',
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
  padding: '8px 7px',
  display: 'grid',
  gap: 3,
}

const infoCardHighlightStyle: CSSProperties = {
  background: 'linear-gradient(180deg, #EFF6FF 0%, #F8FBFF 100%)',
  border: '1px solid rgba(96, 165, 250, 0.4)',
}

const infoCardTopStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  minWidth: 0,
}

const infoIconStyle: CSSProperties = {
  fontSize: 12,
  lineHeight: 1,
}

const infoLabelStyle: CSSProperties = {
  minWidth: 0,
  fontSize: 11,
  fontWeight: 800,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: '#94A3B8',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
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
  display: 'grid',
  gridTemplateColumns: '24px 1fr',
  gap: 8,
  alignItems: 'start',
  fontSize: 12,
  lineHeight: 1.45,
  color: '#475569',
}

const shieldIconStyle: CSSProperties = {
  width: 24,
  height: 24,
  borderRadius: '50%',
  display: 'grid',
  placeItems: 'center',
  background: '#EFF6FF',
  color: '#2563EB',
  fontWeight: 900,
}

const cancelButtonStyle: CSSProperties = {
  appearance: 'none',
  border: '1px solid rgba(226, 232, 240, 0.98)',
  background: '#FFFFFF',
  color: '#0F172A',
  minHeight: 40,
  borderRadius: 16,
  fontSize: 13,
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

const emptyCopyStyle: CSSProperties = {
  display: 'grid',
  gap: 8,
}

const emptyTitleStyle: CSSProperties = {
  fontSize: 28,
  lineHeight: 1.06,
  fontWeight: 900,
  color: '#0F172A',
}

const emptySubtitleStyle: CSSProperties = {
  maxWidth: 300,
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

const emptyTipStyle: CSSProperties = {
  width: '100%',
  border: '1px solid rgba(226,232,240,0.95)',
  borderRadius: 18,
  background: 'linear-gradient(180deg, #F8FAFC 0%, #FFFFFF 100%)',
  padding: '12px',
  display: 'grid',
  gridTemplateColumns: '28px 1fr',
  alignItems: 'center',
  gap: 10,
  textAlign: 'left',
  color: '#64748B',
  fontSize: 13,
  lineHeight: 1.35,
}

const tipIconStyle: CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: '50%',
  background: '#EFF6FF',
  display: 'grid',
  placeItems: 'center',
}

const primaryButtonStyle: CSSProperties = {
  appearance: 'none',
  border: 'none',
  minHeight: 52,
  borderRadius: 18,
  background: 'linear-gradient(180deg, #2563EB 0%, #1D4ED8 100%)',
  color: '#FFFFFF',
  fontSize: 15,
  fontWeight: 900,
  padding: '0 22px',
  cursor: 'pointer',
  boxShadow: '0 18px 34px rgba(37, 99, 235, 0.20)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  width: '100%',
}

const buttonIconStyle: CSSProperties = {
  fontSize: 18,
  lineHeight: 1,
}
