import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'

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
  isFixedVisit?: boolean
  mode: 'matching' | 'empty'
  serviceType?: string | null
  emptyTitle?: string
  emptySubtitle?: string
  emptyPrimaryLabel?: string
  emptySecondaryLabel?: string
  onCancel: () => void
  onTryAgain?: () => void
  onSecondaryAction?: () => void
}

type MatchingVisual = {
  asset: string
  tone: 'pet' | 'sitter' | 'cleaning' | 'default'
}

type StatusStep = {
  key: string
  title: string
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
    return { asset: dogCharacterImg, tone: 'pet' }
  }

  if (
    normalized.includes('baby') ||
    normalized.includes('child') ||
    normalized.includes('sitter') ||
    normalized.includes('nanny')
  ) {
    return { asset: babyImg, tone: 'sitter' }
  }

  if (
    normalized.includes('tech') ||
    normalized.includes('repair') ||
    normalized.includes('fix') ||
    normalized.includes('handyman')
  ) {
    return { asset: technicianImg, tone: 'default' }
  }

  if (normalized.includes('clean')) {
    return { asset: cleaningImg, tone: 'cleaning' }
  }

  return { asset: defaultImg, tone: 'default' }
}

function formatElapsed(seconds: number): string {
  const safe = Math.max(0, seconds)
  const mins = Math.floor(safe / 60)
  const secs = safe % 60
  return `${mins}:${String(secs).padStart(2, '0')}`
}

function buildStatusSteps(isRtl: boolean): StatusStep[] {
  return [
    { key: 'contacting', title: isRtl ? 'פונים לספקים קרובים…' : 'Contacting nearby providers…' },
    { key: 'retrying', title: isRtl ? 'מנסים ספק נוסף…' : 'Trying another provider…' },
    { key: 'expanding', title: isRtl ? 'מרחיבים את אזור החיפוש…' : 'Expanding search area…' },
  ]
}

function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setPrefersReducedMotion(mediaQuery.matches)

    update()

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', update)
      return () => mediaQuery.removeEventListener('change', update)
    }

    mediaQuery.addListener(update)
    return () => mediaQuery.removeListener(update)
  }, [])

  return prefersReducedMotion
}

export default function SearchingSheet({
  searchStartedAt,
  elapsedSeconds,
  durationLabel,
  priceLabel,
  isFixedVisit = false,
  mode,
  serviceType,
  emptyTitle,
  emptySubtitle,
  emptyPrimaryLabel,
  emptySecondaryLabel,
  onCancel,
  onTryAgain,
  onSecondaryAction,
}: SearchingSheetProps) {
  const { i18n } = useTranslation()
  const isRtl = i18n.resolvedLanguage === 'he'
  const prefersReducedMotion = usePrefersReducedMotion()
  const visual = useMemo(() => getMatchingVisual(serviceType), [serviceType])
  const statusSteps = useMemo(() => buildStatusSteps(isRtl), [isRtl])
  const hasSearchStarted = typeof searchStartedAt === 'number'
  const safeElapsedSeconds = hasSearchStarted ? Math.max(0, elapsedSeconds) : 0
  const activeStepIndex = Math.min(statusSteps.length - 1, Math.floor(safeElapsedSeconds / 6))
  const activeStep = statusSteps[activeStepIndex] ?? statusSteps[0]
  const title = isRtl ? 'מאתרים ספקים קרובים…' : 'Finding nearby providers…'
  const etaLabel = 'ETA'
  const durationText = isFixedVisit ? i18n.t('tracking.fixedVisit') : (isRtl ? 'Duration' : 'Duration')
  const durationValue = isFixedVisit ? i18n.t('tracking.visitFee') : (durationLabel || '—')
  const priceText = isRtl ? 'Price' : 'Price'
  const tryAgainLabel = isRtl ? 'נסה שוב' : 'Try again'
  const emptyResolvedPrimaryLabel = emptyPrimaryLabel || tryAgainLabel
  const emptyResolvedSecondaryLabel = emptySecondaryLabel || null
  const emptyResolvedTitle =
    emptyTitle || (isRtl ? 'הספקים הקרובים תפוסים כרגע' : 'Nearby providers are currently busy')
  const emptyResolvedSubtitle =
    emptySubtitle || (isRtl ? 'אפשר לנסות שוב או לקבוע לזמן מאוחר יותר.' : 'Try again or schedule for later.')
  const progressWidth = useMemo(() => {
    if (!hasSearchStarted || safeElapsedSeconds <= 0) return '10%'
    const capped = Math.min(safeElapsedSeconds, 24)
    return `${Math.max(10, (capped / 24) * 100)}%`
  }, [hasSearchStarted, safeElapsedSeconds])
  const [isExpanded, setIsExpanded] = useState(false)

  useEffect(() => {
    if (mode === 'empty') {
      setIsExpanded(true)
      return
    }
    setIsExpanded(true)
  }, [mode, searchStartedAt, serviceType])

  const direction = isRtl ? 'rtl' : 'ltr'
  const timerText = formatElapsed(safeElapsedSeconds)

  if (mode === 'empty') {
    return (
      <div style={{ ...wrapStyle, direction }}>
        <style>{searchingAnimations}</style>
        <div style={{ ...cardStyle, ...emptyCardStyle }}>
          <div style={glowStyle} aria-hidden="true" />
          <div style={emptyHeaderStyle}>
            <RadarVisual asset={visual.asset} tone={visual.tone} muted size={72} />
            <div style={emptyCopyStyle}>
              <div style={emptyTitleStyle}>{emptyResolvedTitle}</div>
              <div style={emptySubtitleStyle}>{emptyResolvedSubtitle}</div>
            </div>
          </div>
          <div style={dividerStyle} aria-hidden="true" />
          <div style={{ ...infoGridStyle, gridTemplateColumns: '1fr auto 1fr' }}>
            <InfoItem icon={<ClockIcon />} label={durationText} value={durationValue} />
            <InfoDivider />
            <InfoItem icon={<CurrencyIcon />} label={priceText} value={priceLabel || '—'} />
          </div>
          <button type="button" onClick={onTryAgain ?? onCancel} style={primaryButtonStyle}>
            <span style={primaryButtonIconStyle}>↻</span>
            {emptyResolvedPrimaryLabel}
          </button>
          {emptyResolvedSecondaryLabel && onSecondaryAction ? (
            <button type="button" onClick={onSecondaryAction} style={secondaryButtonStyle}>
              {emptyResolvedSecondaryLabel}
            </button>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <div style={{ ...wrapStyle, direction }}>
      <style>{searchingAnimations}</style>
      <div
        style={{
          ...cardStyle,
          ...(isExpanded ? expandedCardStyle : collapsedCardStyle),
          transition: prefersReducedMotion
            ? 'none'
            : 'padding 260ms cubic-bezier(0.22, 1, 0.36, 1), max-height 260ms cubic-bezier(0.22, 1, 0.36, 1), border-radius 260ms ease',
        }}
      >
        <div style={glowStyle} aria-hidden="true" />

        <div style={topRowStyle}>
          <div style={leadStyle}>
            <RadarVisual asset={visual.asset} tone={visual.tone} size={isExpanded ? 58 : 52} mini />
            <div style={copyStyle}>
              <div style={titleStyle}>{title}</div>
              <div style={updateStyle}>{activeStep.title}</div>
            </div>
          </div>

          <div style={rightClusterStyle}>
            <div style={timerStyle}>{timerText}</div>
            <button
              type="button"
              onClick={() => setIsExpanded((current) => !current)}
              aria-label={isExpanded ? (isRtl ? 'צמצם' : 'Collapse') : (isRtl ? 'הרחב' : 'Expand')}
              style={chevronButtonStyle}
            >
              <span
                style={{
                  ...chevronStyle,
                  transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                  transition: prefersReducedMotion ? 'none' : 'transform 220ms ease',
                }}
              >
                ⌄
              </span>
            </button>
          </div>
        </div>

        <div
          style={{
            ...expandedSectionStyle,
            ...(isExpanded ? expandedSectionOpenStyle : expandedSectionClosedStyle),
            transition: prefersReducedMotion
              ? 'none'
              : 'max-height 260ms cubic-bezier(0.22, 1, 0.36, 1), opacity 220ms ease, margin-top 220ms ease',
          }}
        >
          <div style={progressStackStyle}>
            <div style={dotsRowStyle} aria-hidden="true">
              {statusSteps.map((step, index) => {
                const isActive = index === activeStepIndex
                const isComplete = index < activeStepIndex
                return (
                  <span
                    key={step.key}
                    style={{
                      ...dotStyle,
                      ...(isComplete ? dotCompleteStyle : null),
                      ...(isActive ? dotActiveStyle : null),
                    }}
                  />
                )
              })}
            </div>
            <div style={progressTrackStyle}>
              <div
                style={{
                  ...progressFillStyle,
                  width: progressWidth,
                  animation: prefersReducedMotion ? 'none' : 'progressSheen 3.2s linear infinite',
                }}
              />
            </div>
          </div>

          <div style={dividerStyle} aria-hidden="true" />

          <div style={infoGridStyle}>
            <InfoItem icon={<ClockIcon />} label={etaLabel} value="—" />
            <InfoDivider />
            <InfoItem icon={<ClockIcon />} label={durationText.toUpperCase()} value={durationValue} />
            <InfoDivider />
            <InfoItem icon={<CurrencyIcon />} label={priceText.toUpperCase()} value={priceLabel || '—'} />
          </div>

          <div style={dividerStyle} aria-hidden="true" />

          <button type="button" onClick={onCancel} style={cancelButtonStyle}>
            {isRtl ? 'בטל חיפוש' : 'Cancel search'}
          </button>
        </div>
      </div>
    </div>
  )
}

function InfoItem({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode
  label: string
  value: string
}) {
  return (
    <div style={infoItemStyle}>
      <div style={infoIconWrapStyle}>{icon}</div>
      <div style={infoLabelStyle}>{label}</div>
      <div style={infoValueStyle}>{value}</div>
    </div>
  )
}

function InfoDivider() {
  return <div style={infoDividerStyle} aria-hidden="true" />
}

function ClockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7.8v4.6l3 1.8" />
    </svg>
  )
}

function CurrencyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8" />
      <path d="M9.2 9.6h4a2.1 2.1 0 1 1 0 4.2h-2.4a2.1 2.1 0 1 0 0 4.2h4" />
    </svg>
  )
}

function RadarVisual({
  asset,
  tone,
  muted = false,
  mini = false,
  size,
}: {
  asset: string
  tone: MatchingVisual['tone']
  muted?: boolean
  mini?: boolean
  size?: number
}) {
  const toneColors = getToneColors(tone)
  const visualSize = size ?? (muted ? 82 : mini ? 58 : 100)

  return (
    <div style={{ ...radarWrapStyle, width: visualSize, height: visualSize }}>
      <div
        style={{
          ...radarGlowStyle,
          inset: mini ? -6 : -10,
          opacity: mini ? 0.56 : 0.68,
          background: muted ? mutedGlow : toneColors.glow,
        }}
      />
      <div
        style={{
          ...radarCoreStyle,
          inset: mini ? 9 : 10,
          background: muted ? 'rgba(15, 23, 42, 0.74)' : toneColors.core,
          borderColor: muted ? 'rgba(148, 163, 184, 0.18)' : toneColors.coreBorder,
        }}
      />
      <div
        style={{
          ...radarOrbitStyle,
          inset: mini ? 4 : 5,
          borderColor: muted ? 'rgba(148, 163, 184, 0.12)' : toneColors.borderSoft,
        }}
      />
      <div
        style={{
          ...radarSweepStyle,
          inset: mini ? 4 : 6,
          background: muted ? mutedSweep : toneColors.sweep,
          animation: muted ? 'none' : 'radarSweepRotate 5.8s linear infinite',
        }}
      />
      <div
        style={{
          ...radarRingStyle,
          borderColor: muted ? 'rgba(148, 163, 184, 0.12)' : toneColors.border,
          animationDuration: mini ? '4.6s' : '3.8s',
        }}
      />
      <div
        style={{
          ...radarRingStyle,
          borderColor: muted ? 'rgba(148, 163, 184, 0.12)' : toneColors.border,
          animationDelay: '900ms',
          animationDuration: mini ? '4.6s' : '3.8s',
        }}
      />
      <img
        src={asset}
        alt=""
        style={{
          ...radarAssetStyle,
          width: visualSize * (mini ? 0.56 : 0.62),
          height: visualSize * (mini ? 0.56 : 0.62),
          animation: muted ? 'none' : 'radarAssetFloat 3.2s ease-in-out infinite',
        }}
      />
    </div>
  )
}

function getToneColors(tone: MatchingVisual['tone']) {
  if (tone === 'sitter') {
    return {
      glow: 'radial-gradient(circle, rgba(99,102,241,0.30) 0%, rgba(99,102,241,0.04) 56%, rgba(99,102,241,0) 76%)',
      core: 'linear-gradient(180deg, rgba(15,23,42,0.92) 0%, rgba(30,41,59,0.88) 100%)',
      coreBorder: 'rgba(129,140,248,0.34)',
      border: 'rgba(129,140,248,0.36)',
      borderSoft: 'rgba(129,140,248,0.16)',
      sweep:
        'conic-gradient(from 0deg, rgba(129,140,248,0) 0deg, rgba(129,140,248,0.02) 286deg, rgba(165,180,252,0.22) 323deg, rgba(255,255,255,0.18) 340deg, rgba(129,140,248,0) 360deg)',
    }
  }

  if (tone === 'cleaning') {
    return {
      glow: 'radial-gradient(circle, rgba(20,184,166,0.28) 0%, rgba(20,184,166,0.05) 56%, rgba(20,184,166,0) 76%)',
      core: 'linear-gradient(180deg, rgba(15,23,42,0.92) 0%, rgba(22,78,99,0.84) 100%)',
      coreBorder: 'rgba(45,212,191,0.30)',
      border: 'rgba(45,212,191,0.34)',
      borderSoft: 'rgba(45,212,191,0.16)',
      sweep:
        'conic-gradient(from 0deg, rgba(45,212,191,0) 0deg, rgba(45,212,191,0.02) 286deg, rgba(94,234,212,0.20) 323deg, rgba(255,255,255,0.16) 340deg, rgba(45,212,191,0) 360deg)',
    }
  }

  if (tone === 'pet') {
    return {
      glow: 'radial-gradient(circle, rgba(34,197,94,0.26) 0%, rgba(34,197,94,0.05) 56%, rgba(34,197,94,0) 76%)',
      core: 'linear-gradient(180deg, rgba(15,23,42,0.92) 0%, rgba(20,83,45,0.86) 100%)',
      coreBorder: 'rgba(74,222,128,0.30)',
      border: 'rgba(74,222,128,0.32)',
      borderSoft: 'rgba(74,222,128,0.16)',
      sweep:
        'conic-gradient(from 0deg, rgba(74,222,128,0) 0deg, rgba(74,222,128,0.02) 286deg, rgba(134,239,172,0.18) 323deg, rgba(255,255,255,0.15) 340deg, rgba(74,222,128,0) 360deg)',
    }
  }

  return {
    glow: 'radial-gradient(circle, rgba(56,189,248,0.28) 0%, rgba(56,189,248,0.05) 56%, rgba(56,189,248,0) 76%)',
    core: 'linear-gradient(180deg, rgba(15,23,42,0.94) 0%, rgba(30,41,59,0.88) 100%)',
    coreBorder: 'rgba(96,165,250,0.30)',
    border: 'rgba(96,165,250,0.34)',
    borderSoft: 'rgba(96,165,250,0.16)',
    sweep:
      'conic-gradient(from 0deg, rgba(96,165,250,0) 0deg, rgba(96,165,250,0.02) 286deg, rgba(125,211,252,0.20) 323deg, rgba(255,255,255,0.17) 340deg, rgba(96,165,250,0) 360deg)',
  }
}

const searchingAnimations = `
  @keyframes radarSweep {
    0% { transform: translate(-50%, -50%) scale(0.52); opacity: 0.20; }
    70% { opacity: 0.05; }
    100% { transform: translate(-50%, -50%) scale(1.08); opacity: 0; }
  }

  @keyframes radarSweepRotate {
    0% { transform: rotate(0deg); opacity: 0.34; }
    50% { opacity: 0.18; }
    100% { transform: rotate(360deg); opacity: 0.34; }
  }

  @keyframes radarAssetFloat {
    0%, 100% { transform: translateY(0) scale(0.99); }
    50% { transform: translateY(-2px) scale(1.012); }
  }

  @keyframes progressSheen {
    0% { background-position: 0% 50%; }
    100% { background-position: 100% 50%; }
  }

  @media (prefers-reduced-motion: reduce) {
    * {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
      scroll-behavior: auto !important;
    }
  }
`

const mutedGlow =
  'radial-gradient(circle, rgba(148,163,184,0.22) 0%, rgba(148,163,184,0.03) 58%, rgba(148,163,184,0) 76%)'
const mutedSweep =
  'conic-gradient(from 0deg, rgba(148,163,184,0) 0deg, rgba(148,163,184,0.01) 288deg, rgba(226,232,240,0.10) 328deg, rgba(255,255,255,0.08) 344deg, rgba(148,163,184,0) 360deg)'

const wrapStyle: CSSProperties = {
  width: '100%',
  display: 'flex',
  justifyContent: 'center',
  paddingBottom: 0,
  paddingInline: 0,
  boxSizing: 'border-box',
}

const cardStyle: CSSProperties = {
  position: 'relative',
  width: '100%',
  minHeight: 336,
  overflow: 'hidden',
  background: 'linear-gradient(180deg, rgba(14,17,22,0.94) 0%, rgba(20,24,31,0.96) 100%)',
  border: '1px solid rgba(148, 163, 184, 0.12)',
  boxShadow: '0 20px 40px rgba(2, 6, 23, 0.30), inset 0 1px 0 rgba(255,255,255,0.04)',
  backdropFilter: 'blur(24px)',
  WebkitBackdropFilter: 'blur(24px)',
  color: '#F8FAFC',
  boxSizing: 'border-box',
}

const collapsedCardStyle: CSSProperties = {
  borderRadius: 30,
  padding: '14px 14px',
  minHeight: 84,
  maxHeight: 84,
}

const expandedCardStyle: CSSProperties = {
  borderRadius: 30,
  padding: '14px 14px calc(env(safe-area-inset-bottom, 0px) + 14px)',
  minHeight: 336,
  maxHeight: 390,
}

const emptyCardStyle: CSSProperties = {
  borderRadius: 30,
  padding: '14px 14px calc(env(safe-area-inset-bottom, 0px) + 14px)',
  minHeight: 336,
  display: 'grid',
  gap: 14,
}

const glowStyle: CSSProperties = {
  position: 'absolute',
  inset: 'auto -28px -34px auto',
  width: 170,
  height: 170,
  borderRadius: '50%',
  background:
    'radial-gradient(circle, rgba(59,130,246,0.18) 0%, rgba(59,130,246,0.08) 42%, rgba(59,130,246,0) 72%)',
  filter: 'blur(12px)',
  pointerEvents: 'none',
}

const topRowStyle: CSSProperties = {
  position: 'relative',
  zIndex: 1,
  display: 'grid',
  gridTemplateColumns: 'auto minmax(0, 1fr) auto',
  alignItems: 'center',
  gap: 10,
}

const leadStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  minWidth: 0,
}

const copyStyle: CSSProperties = {
  minWidth: 0,
  display: 'grid',
  gap: 2,
  paddingInlineEnd: 6,
}

const titleStyle: CSSProperties = {
  fontSize: 15.5,
  lineHeight: 1.14,
  fontWeight: 900,
  letterSpacing: -0.28,
  color: '#F8FAFC',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const updateStyle: CSSProperties = {
  fontSize: 11.5,
  lineHeight: 1.2,
  fontWeight: 500,
  color: 'rgba(148, 163, 184, 0.92)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const rightClusterStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexShrink: 0,
  minWidth: 76,
  justifyContent: 'flex-end',
  paddingInlineStart: 2,
}

const timerStyle: CSSProperties = {
  fontSize: 11.5,
  fontWeight: 800,
  color: 'rgba(226, 232, 240, 0.88)',
  fontVariantNumeric: 'tabular-nums',
}

const chevronButtonStyle: CSSProperties = {
  appearance: 'none',
  border: '1px solid rgba(148, 163, 184, 0.12)',
  background: 'rgba(255,255,255,0.03)',
  color: 'rgba(191, 219, 254, 0.9)',
  width: 28,
  height: 28,
  borderRadius: 10,
  display: 'grid',
  placeItems: 'center',
  cursor: 'pointer',
  padding: 0,
}

const chevronStyle: CSSProperties = {
  display: 'inline-block',
  fontSize: 12,
  lineHeight: 1,
}

const expandedSectionStyle: CSSProperties = {
  overflow: 'hidden',
  display: 'grid',
  gap: 0,
}

const expandedSectionOpenStyle: CSSProperties = {
  minHeight: 236,
  maxHeight: 290,
  opacity: 1,
  marginTop: 10,
}

const expandedSectionClosedStyle: CSSProperties = {
  maxHeight: 0,
  opacity: 0,
  marginTop: 0,
}

const progressStackStyle: CSSProperties = {
  display: 'grid',
  gap: 8,
}

const dotsRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 7,
}

const dotStyle: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: '50%',
  background: 'rgba(100, 116, 139, 0.62)',
}

const dotActiveStyle: CSSProperties = {
  background: '#2563EB',
  boxShadow: '0 0 0 3px rgba(37, 99, 235, 0.12)',
}

const dotCompleteStyle: CSSProperties = {
  background: 'rgba(56, 189, 248, 0.72)',
}

const progressTrackStyle: CSSProperties = {
  position: 'relative',
  overflow: 'hidden',
  height: 3,
  borderRadius: 999,
  background: 'rgba(51, 65, 85, 0.58)',
  boxShadow: 'inset 0 1px 1px rgba(255,255,255,0.04)',
}

const progressFillStyle: CSSProperties = {
  height: '100%',
  borderRadius: 999,
  background: 'linear-gradient(90deg, rgba(59,130,246,0.92) 0%, rgba(96,165,250,0.96) 100%)',
  backgroundSize: '160% 100%',
  transition: 'width 420ms ease',
  boxShadow: '0 0 8px rgba(96, 165, 250, 0.16)',
}

const dividerStyle: CSSProperties = {
  width: '100%',
  height: 1,
  marginTop: 10,
  marginBottom: 10,
  background: 'rgba(148, 163, 184, 0.14)',
}

const infoGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr auto 1fr auto 1fr',
  alignItems: 'stretch',
  gap: 8,
  width: '100%',
}

const infoItemStyle: CSSProperties = {
  minWidth: 0,
  display: 'grid',
  gap: 3,
  justifyItems: 'center',
  textAlign: 'center',
}

const infoIconWrapStyle: CSSProperties = {
  color: 'rgba(148, 163, 184, 0.86)',
  display: 'grid',
  placeItems: 'center',
  transform: 'scale(0.92)',
}

const infoLabelStyle: CSSProperties = {
  fontSize: 9,
  fontWeight: 800,
  letterSpacing: 0.28,
  textTransform: 'uppercase',
  color: 'rgba(148, 163, 184, 0.82)',
}

const infoValueStyle: CSSProperties = {
  fontSize: 13.5,
  lineHeight: 1.1,
  fontWeight: 900,
  color: '#F8FAFC',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const infoDividerStyle: CSSProperties = {
  width: 1,
  height: '100%',
  minHeight: 28,
  background: 'rgba(148, 163, 184, 0.16)',
}

const cancelButtonStyle: CSSProperties = {
  appearance: 'none',
  border: '1px solid rgba(96, 165, 250, 0.16)',
  background: 'rgba(17, 24, 39, 0.78)',
  color: '#60A5FA',
  minHeight: 48,
  width: '100%',
  padding: '0 16px',
  borderRadius: 18,
  fontSize: 13,
  fontWeight: 800,
  lineHeight: '48px',
  letterSpacing: 0.12,
  cursor: 'pointer',
  marginTop: 10,
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.03)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  boxSizing: 'border-box',
  textAlign: 'center',
  marginBottom: 2,
}

const emptyHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 14,
}

const emptyCopyStyle: CSSProperties = {
  display: 'grid',
  gap: 4,
  minWidth: 0,
}

const emptyTitleStyle: CSSProperties = {
  fontSize: 20,
  lineHeight: 1.08,
  fontWeight: 900,
  letterSpacing: -0.32,
  color: '#F8FAFC',
}

const emptySubtitleStyle: CSSProperties = {
  fontSize: 13,
  lineHeight: 1.45,
  color: 'rgba(203, 213, 225, 0.78)',
}

const primaryButtonStyle: CSSProperties = {
  appearance: 'none',
  border: 'none',
  minHeight: 46,
  borderRadius: 16,
  background: 'linear-gradient(180deg, #38BDF8 0%, #2563EB 100%)',
  color: '#FFFFFF',
  fontSize: 14,
  fontWeight: 900,
  padding: '0 18px',
  cursor: 'pointer',
  boxShadow: '0 16px 34px rgba(37, 99, 235, 0.24)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  width: '100%',
}

const secondaryButtonStyle: CSSProperties = {
  appearance: 'none',
  border: '1px solid rgba(148, 163, 184, 0.16)',
  minHeight: 44,
  borderRadius: 15,
  background: 'rgba(255,255,255,0.03)',
  color: '#E2E8F0',
  fontSize: 13.5,
  fontWeight: 800,
  padding: '0 16px',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '100%',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.03)',
}

const primaryButtonIconStyle: CSSProperties = {
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
  borderRadius: '50%',
  filter: 'blur(11px)',
  opacity: 0.68,
}

const radarCoreStyle: CSSProperties = {
  position: 'absolute',
  borderRadius: '50%',
  border: '1px solid',
  boxShadow: 'inset 0 1px 8px rgba(255,255,255,0.05)',
}

const radarOrbitStyle: CSSProperties = {
  position: 'absolute',
  borderRadius: '50%',
  border: '1px solid',
}

const radarSweepStyle: CSSProperties = {
  position: 'absolute',
  borderRadius: '50%',
  opacity: 0.34,
  mixBlendMode: 'screen',
  pointerEvents: 'none',
}

const radarRingStyle: CSSProperties = {
  position: 'absolute',
  top: '50%',
  left: '50%',
  width: '100%',
  height: '100%',
  borderRadius: '50%',
  border: '1px solid',
  animation: 'radarSweep 3.8s ease-out infinite',
}

const radarAssetStyle: CSSProperties = {
  position: 'relative',
  objectFit: 'contain',
  display: 'block',
  zIndex: 2,
}
