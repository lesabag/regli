import { useEffect, useMemo, useRef } from 'react'
import { hapticMedium, hapticSuccess } from '../utils/haptics'

export type ProviderCelebrationVariant = 'fullscreen-payment' | 'centered-rating' | 'centered-tip'

export type ProviderCelebrationPayload = {
  id: string
  variant: ProviderCelebrationVariant
  title?: string
  message?: string
  rating?: number | null
  tipAmount?: number | null
}

type ProviderCelebrationOverlayProps = {
  celebrations: ProviderCelebrationPayload[]
  onDismiss: (id: string) => void
}

const CELEBRATION_DURATION_MS = 5000

export default function ProviderCelebrationOverlay({
  celebrations,
  onDismiss,
}: ProviderCelebrationOverlayProps) {
  const activeTimersRef = useRef<Map<string, number>>(new Map())
  const activeIds = useMemo(() => new Set(celebrations.map((celebration) => celebration.id)), [celebrations])

  useEffect(() => {
    for (const celebration of celebrations) {
      if (activeTimersRef.current.has(celebration.id)) continue

      void (celebration.variant === 'fullscreen-payment' ? hapticSuccess() : hapticMedium())

      const timeoutId = window.setTimeout(() => {
        activeTimersRef.current.delete(celebration.id)
        onDismiss(celebration.id)
      }, CELEBRATION_DURATION_MS)

      activeTimersRef.current.set(celebration.id, timeoutId)
    }

    for (const [id, timeoutId] of activeTimersRef.current.entries()) {
      if (activeIds.has(id)) continue
      window.clearTimeout(timeoutId)
      activeTimersRef.current.delete(id)
    }
  }, [activeIds, celebrations, onDismiss])

  useEffect(() => {
    return () => {
      for (const timeoutId of activeTimersRef.current.values()) {
        window.clearTimeout(timeoutId)
      }
      activeTimersRef.current.clear()
    }
  }, [])

  const pieceMap = useMemo(
    () =>
      new Map(
        celebrations.map((celebration) => [
          celebration.id,
          celebration.variant === 'fullscreen-payment'
            ? buildFullscreenPieces(celebration.id)
            : buildCenteredPieces(celebration.id, celebration.variant),
        ]),
      ),
    [celebrations],
  )

  if (celebrations.length === 0) return null

  return (
    <>
      <style>{`
        @keyframes providerCelebrationOverlayFade {
          0% {
            opacity: 0;
          }
          8% {
            opacity: 1;
          }
          82% {
            opacity: 1;
          }
          100% {
            opacity: 0;
          }
        }

        @keyframes providerCelebrationFall {
          0% {
            opacity: 0;
            transform: translate3d(0, -10vh, 0) rotate(0deg);
          }
          10% {
            opacity: 1;
          }
          100% {
            opacity: 0;
            transform: translate3d(var(--provider-confetti-drift-x, 0px), 108vh, 0) rotate(var(--provider-confetti-spin, 360deg));
          }
        }

        @keyframes providerCelebrationBurst {
          0% {
            opacity: 0;
            transform: translate3d(0, 0, 0) scale(0.2) rotate(0deg);
          }
          12% {
            opacity: 1;
          }
          100% {
            opacity: 0;
            transform: translate3d(var(--provider-confetti-x, 0px), var(--provider-confetti-y, 0px), 0) scale(1) rotate(var(--provider-confetti-spin, 270deg));
          }
        }

        @keyframes providerCelebrationPulse {
          0% {
            opacity: 0;
            transform: scale(0.72);
          }
          12% {
            opacity: 1;
            transform: scale(1);
          }
          100% {
            opacity: 0;
            transform: scale(1.14);
          }
        }

        @keyframes providerCelebrationCardIn {
          0% {
            opacity: 0;
            transform: translateY(18px) scale(0.9);
          }
          12% {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
          100% {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }

        @keyframes providerCelebrationStarPop {
          0% {
            opacity: 0;
            transform: scale(0.3) translateY(12px);
          }
          65% {
            opacity: 1;
            transform: scale(1.18) translateY(0);
          }
          100% {
            opacity: 1;
            transform: scale(1) translateY(0);
          }
        }

        @keyframes providerCelebrationScoreIn {
          0% {
            opacity: 0;
            transform: scale(0.7);
          }
          100% {
            opacity: 1;
            transform: scale(1);
          }
        }
      `}</style>
      <div style={rootStyle} aria-live="polite" aria-atomic="true">
        {celebrations.map((celebration) => {
          const pieces = pieceMap.get(celebration.id) ?? []
          return celebration.variant === 'fullscreen-payment'
            ? renderFullscreenCelebration(celebration, pieces)
            : celebration.variant === 'centered-rating'
              ? renderRatingCelebration(celebration, pieces)
              : renderCenteredCelebration(celebration, pieces)
        })}
      </div>
    </>
  )
}

function renderFullscreenCelebration(
  celebration: ProviderCelebrationPayload,
  pieces: ConfettiPiece[],
) {
  return (
    <div
      key={celebration.id}
      style={fullscreenLayerStyle}
      aria-label={celebration.title ?? 'Payment received celebration'}
    >
      <div style={fullscreenGlowStyle} />
      <div style={fullscreenFieldStyle} aria-hidden="true">
        {pieces.map((piece) => (
          <span
            key={piece.id}
            style={{
              ...fullscreenPieceStyle,
              left: `${piece.left}%`,
              width: piece.width,
              height: piece.height,
              background: piece.color,
              animationDelay: `${piece.delay}ms`,
              animationDuration: `${piece.duration}ms`,
              ['--provider-confetti-drift-x' as string]: `${piece.x}px`,
              ['--provider-confetti-spin' as string]: `${piece.spin}deg`,
            }}
          />
        ))}
      </div>
    </div>
  )
}

function renderCenteredCelebration(
  celebration: ProviderCelebrationPayload,
  pieces: ConfettiPiece[],
) {
  const accent = '#34D399'
  const documentLang = typeof document !== 'undefined' ? document.documentElement.lang : 'en'
  const isHebrew = documentLang === 'he'
  const tipLabel =
    typeof celebration.tipAmount === 'number' && Number.isFinite(celebration.tipAmount) && celebration.tipAmount > 0
      ? `${formatTipAmount(celebration.tipAmount)} ${isHebrew ? 'טיפ' : 'tip'}`
      : celebration.message ?? ''

  return (
    <div
      key={celebration.id}
      style={centeredLayerStyle}
      aria-label={celebration.title ?? 'Celebration'}
    >
      <div
        style={{
          ...centeredGlowStyle,
          background: `radial-gradient(circle, ${hexToRgba(accent, 0.2)} 0%, ${hexToRgba(accent, 0)} 72%)`,
        }}
      />
      <div
        style={{
          ...centeredPulseStyle,
          borderColor: hexToRgba(accent, 0.26),
          background: `radial-gradient(circle, ${hexToRgba(accent, 0.22)} 0%, ${hexToRgba(accent, 0.04)} 56%, rgba(15, 23, 42, 0) 100%)`,
          boxShadow: `0 0 0 1px ${hexToRgba(accent, 0.08)}, 0 24px 50px ${hexToRgba(accent, 0.18)}`,
        }}
        aria-hidden="true"
      />
      <div
        style={{
          ...tipLabelStyle,
          borderColor: hexToRgba(accent, 0.26),
          boxShadow: `0 20px 44px ${hexToRgba(accent, 0.18)}`,
        }}
      >
        <span style={tipEmojiStyle} aria-hidden="true">✨</span>
        <span>{tipLabel}</span>
      </div>
      <div style={centeredBurstWrapStyle} aria-hidden="true">
        {pieces.map((piece) => (
          <span
            key={piece.id}
            style={{
              ...centeredPieceStyle,
              width: piece.width,
              height: piece.height,
              background: piece.color,
              animationDelay: `${piece.delay}ms`,
              animationDuration: `${piece.duration}ms`,
              ['--provider-confetti-x' as string]: `${piece.x}px`,
              ['--provider-confetti-y' as string]: `${piece.y}px`,
              ['--provider-confetti-spin' as string]: `${piece.spin}deg`,
            }}
          />
        ))}
      </div>
    </div>
  )
}

function renderRatingCelebration(
  celebration: ProviderCelebrationPayload,
  pieces: ConfettiPiece[],
) {
  const normalizedRating =
    typeof celebration.rating === 'number' && Number.isFinite(celebration.rating)
      ? Math.max(0, Math.min(5, celebration.rating))
      : 0
  const fullStars = Math.floor(normalizedRating)
  const hasHalfStar = normalizedRating - fullStars >= 0.5
  const documentLang = typeof document !== 'undefined' ? document.documentElement.lang : 'en'
  const isHebrew = documentLang === 'he'
  const title = isHebrew ? 'דירוג חדש!' : 'New rating!'
  const subtitle = isHebrew ? 'הלקוח דירג אותך' : 'The client rated you'

  return (
    <div
      key={celebration.id}
      style={centeredLayerStyle}
      aria-label={title}
    >
      <div
        style={{
          ...ratingBackdropGlowStyle,
          background: `radial-gradient(circle, ${hexToRgba('#FBBF24', 0.22)} 0%, ${hexToRgba('#F59E0B', 0.08)} 42%, rgba(15, 23, 42, 0) 76%)`,
        }}
        aria-hidden="true"
      />
      <div style={ratingConfettiWrapStyle} aria-hidden="true">
        {pieces.map((piece) => (
          <span
            key={piece.id}
            style={{
              ...ratingConfettiPieceStyle,
              width: piece.width,
              height: piece.height,
              background: piece.color,
              animationDelay: `${piece.delay}ms`,
              animationDuration: `${piece.duration}ms`,
              ['--provider-confetti-x' as string]: `${piece.x}px`,
              ['--provider-confetti-y' as string]: `${piece.y}px`,
              ['--provider-confetti-spin' as string]: `${piece.spin}deg`,
            }}
          />
        ))}
      </div>
      <div style={ratingCardStyle}>
        <div style={ratingTitleStyle}>{title}</div>
        <div style={ratingSubtitleStyle}>{subtitle}</div>
        <div style={ratingStarsRowStyle} aria-hidden="true">
          {Array.from({ length: 5 }, (_, index) => {
            const isFilled = index < fullStars
            const isHalf = !isFilled && hasHalfStar && index === fullStars
            return (
              <span
                key={`${celebration.id}-star-${index}`}
                style={{
                  ...ratingStarStyle,
                  color: isFilled || isHalf ? '#FBBF24' : 'rgba(255,255,255,0.16)',
                  background: isHalf
                    ? 'linear-gradient(90deg, #FBBF24 0%, #FBBF24 50%, rgba(255,255,255,0.16) 50%, rgba(255,255,255,0.16) 100%)'
                    : undefined,
                  WebkitBackgroundClip: isHalf ? 'text' : undefined,
                  backgroundClip: isHalf ? 'text' : undefined,
                  WebkitTextFillColor: isHalf ? 'transparent' : undefined,
                  animationDelay: `${220 + index * 120}ms`,
                }}
              >
                ★
              </span>
            )
          })}
          <span style={ratingScoreStyle}>{normalizedRating.toFixed(1)}</span>
        </div>
      </div>
    </div>
  )
}

type ConfettiPiece = {
  id: string
  color: string
  delay: number
  duration: number
  width: number
  height: number
  left: number
  x: number
  y: number
  spin: number
}

function buildFullscreenPieces(seed: string): ConfettiPiece[] {
  return Array.from({ length: 56 }, (_, index) => ({
    id: `${seed}-fullscreen-${index}`,
    color: PAYMENT_COLORS[index % PAYMENT_COLORS.length],
    delay: (index % 14) * 70,
    duration: 2600 + (index % 7) * 240,
    width: 7 + (index % 3) * 3,
    height: 14 + (index % 4) * 4,
    left: 2 + ((index * 17) % 96),
    x: -54 + ((index * 23) % 108),
    y: 0,
    spin: 260 + (index % 8) * 42,
  }))
}

function buildCenteredPieces(
  seed: string,
  variant: Extract<ProviderCelebrationVariant, 'centered-rating' | 'centered-tip'>,
): ConfettiPiece[] {
  if (variant === 'centered-rating') {
    return Array.from({ length: 36 }, (_, index) => {
      const angle = (Math.PI * 2 * index) / 36
      const radius = 108 + (index % 6) * 18
      return {
        id: `${seed}-rating-${index}`,
        color: RATING_COLORS[index % RATING_COLORS.length],
        delay: (index % 6) * 70,
        duration: 1900 + (index % 5) * 160,
        width: 8 + (index % 3) * 3,
        height: 10 + ((index + 1) % 4) * 4,
        left: 50,
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        spin: 220 + (index % 7) * 42,
      }
    })
  }

  return Array.from({ length: 22 }, (_, index) => {
    const angle = (Math.PI * 2 * index) / 22
    const radius = 54 + (index % 5) * 14
    return {
      id: `${seed}-center-${index}`,
      color: TIP_COLORS[index % TIP_COLORS.length],
      delay: (index % 5) * 60,
      duration: 1700 + (index % 4) * 120,
      width: 8 + (index % 3) * 2,
      height: 8 + ((index + 1) % 4) * 3,
      left: 50,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      spin: 180 + (index % 6) * 36,
    }
  })
}

function hexToRgba(hex: string, alpha: number): string {
  const normalized = hex.replace('#', '')
  const full = normalized.length === 3
    ? normalized.split('').map((char) => `${char}${char}`).join('')
    : normalized
  const int = Number.parseInt(full, 16)
  if (Number.isNaN(int)) return `rgba(255,255,255,${alpha})`
  const r = (int >> 16) & 255
  const g = (int >> 8) & 255
  const b = int & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function formatTipAmount(value: number): string {
  try {
    return new Intl.NumberFormat('en-IL', {
      style: 'currency',
      currency: 'ILS',
      maximumFractionDigits: 0,
    }).format(value)
  } catch {
    return `₪${Math.round(value)}`
  }
}

const PAYMENT_COLORS = ['#F8FAFC', '#F59E0B', '#FBBF24', '#34D399', '#60A5FA']
const RATING_COLORS = ['#FBBF24', '#F59E0B', '#FDE68A', '#F8FAFC']
const TIP_COLORS = ['#34D399', '#6EE7B7', '#10B981', '#F8FAFC']

const rootStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 4300,
  pointerEvents: 'none',
  overflow: 'hidden',
}

const fullscreenLayerStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  animation: `providerCelebrationOverlayFade ${CELEBRATION_DURATION_MS}ms ease-out forwards`,
}

const fullscreenGlowStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: 'radial-gradient(circle at 50% -10%, rgba(251, 191, 36, 0.14) 0%, rgba(251, 191, 36, 0.06) 28%, rgba(15, 23, 42, 0) 62%)',
}

const fullscreenFieldStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  overflow: 'hidden',
}

const fullscreenPieceStyle: React.CSSProperties = {
  position: 'absolute',
  top: '-12vh',
  borderRadius: 999,
  opacity: 0,
  animationName: 'providerCelebrationFall',
  animationTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
  animationFillMode: 'both',
  willChange: 'transform, opacity',
}

const centeredLayerStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'grid',
  placeItems: 'center',
  animation: `providerCelebrationOverlayFade ${CELEBRATION_DURATION_MS}ms ease-out forwards`,
}

const centeredGlowStyle: React.CSSProperties = {
  position: 'absolute',
  width: 220,
  height: 220,
  borderRadius: '50%',
  filter: 'blur(2px)',
}

const centeredPulseStyle: React.CSSProperties = {
  position: 'absolute',
  width: 96,
  height: 96,
  borderRadius: '50%',
  border: '1px solid rgba(255,255,255,0.16)',
  animation: `providerCelebrationPulse ${CELEBRATION_DURATION_MS}ms ease-out forwards`,
}

const centeredBurstWrapStyle: React.CSSProperties = {
  position: 'relative',
  width: 260,
  height: 260,
  overflow: 'visible',
}

const tipLabelStyle: React.CSSProperties = {
  position: 'absolute',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  minHeight: 48,
  padding: '0 18px',
  borderRadius: 999,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 10,
  background: 'rgba(15, 23, 42, 0.92)',
  border: '1px solid rgba(52, 211, 153, 0.2)',
  color: '#ECFDF5',
  fontSize: 20,
  lineHeight: 1,
  fontWeight: 900,
  letterSpacing: '-0.02em',
  whiteSpace: 'nowrap',
  animation: `providerCelebrationCardIn ${CELEBRATION_DURATION_MS}ms cubic-bezier(0.22, 1, 0.36, 1) forwards`,
}

const tipEmojiStyle: React.CSSProperties = {
  fontSize: 18,
  lineHeight: 1,
  filter: 'drop-shadow(0 6px 16px rgba(110, 231, 183, 0.28))',
}

const ratingBackdropGlowStyle: React.CSSProperties = {
  position: 'absolute',
  width: 520,
  height: 520,
  borderRadius: '50%',
  filter: 'blur(6px)',
}

const ratingConfettiWrapStyle: React.CSSProperties = {
  position: 'absolute',
  width: 520,
  height: 520,
  overflow: 'visible',
}

const ratingConfettiPieceStyle: React.CSSProperties = {
  position: 'absolute',
  top: '50%',
  left: '50%',
  marginLeft: -5,
  marginTop: -5,
  borderRadius: 999,
  opacity: 0,
  animationName: 'providerCelebrationBurst',
  animationTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
  animationFillMode: 'both',
  willChange: 'transform, opacity',
}

const ratingCardStyle: React.CSSProperties = {
  position: 'relative',
  width: 'min(88vw, 360px)',
  minHeight: 228,
  padding: '26px 24px 28px',
  borderRadius: 28,
  display: 'grid',
  justifyItems: 'center',
  gap: 12,
  background: 'linear-gradient(180deg, rgba(15,23,42,0.96) 0%, rgba(17,24,39,0.92) 100%)',
  border: '1px solid rgba(251, 191, 36, 0.22)',
  boxShadow: '0 28px 80px rgba(2, 6, 23, 0.48), 0 0 0 1px rgba(255,255,255,0.04) inset',
  backdropFilter: 'blur(18px)',
  WebkitBackdropFilter: 'blur(18px)',
  animation: `providerCelebrationCardIn ${CELEBRATION_DURATION_MS}ms cubic-bezier(0.22, 1, 0.36, 1) forwards`,
}

const ratingTitleStyle: React.CSSProperties = {
  fontSize: 28,
  lineHeight: 1.05,
  fontWeight: 900,
  color: '#F8FAFC',
  textAlign: 'center',
  letterSpacing: '-0.03em',
}

const ratingSubtitleStyle: React.CSSProperties = {
  fontSize: 15,
  lineHeight: 1.45,
  fontWeight: 600,
  color: 'rgba(226, 232, 240, 0.84)',
  textAlign: 'center',
}

const ratingStarsRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 10,
  flexWrap: 'wrap',
  marginTop: 8,
}

const ratingStarStyle: React.CSSProperties = {
  fontSize: 34,
  lineHeight: 1,
  textShadow: '0 8px 24px rgba(251, 191, 36, 0.32)',
  opacity: 0,
  animation: 'providerCelebrationStarPop 420ms cubic-bezier(0.22, 1, 0.36, 1) forwards',
}

const ratingScoreStyle: React.CSSProperties = {
  marginInlineStart: 6,
  fontSize: 34,
  lineHeight: 1,
  fontWeight: 900,
  color: '#FBBF24',
  textShadow: '0 10px 24px rgba(251, 191, 36, 0.28)',
  opacity: 0,
  animation: 'providerCelebrationScoreIn 360ms cubic-bezier(0.22, 1, 0.36, 1) 900ms forwards',
}

const centeredPieceStyle: React.CSSProperties = {
  position: 'absolute',
  top: '50%',
  left: '50%',
  marginLeft: -5,
  marginTop: -5,
  borderRadius: 999,
  opacity: 0,
  animationName: 'providerCelebrationBurst',
  animationTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
  animationFillMode: 'both',
  willChange: 'transform, opacity',
}
