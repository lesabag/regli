import { useRef } from 'react'
import { markFirstInteractionHandler, markFirstInteractionVisual } from '../utils/firstInteractionPerf'

interface ActionButtonProps {
  label: string
  onClick?: () => void
  disabled?: boolean
  loading?: boolean
  variant?: 'primary' | 'secondary' | 'success' | 'danger' | 'accent'
  sticky?: boolean
  touchSafe?: boolean
}

export default function ActionButton({
  label,
  onClick,
  disabled,
  loading,
  variant = 'primary',
  sticky,
  touchSafe = false,
}: ActionButtonProps) {
  const isDisabled = disabled || loading
  const lastTriggeredAtRef = useRef(0)
  const lastPointerUpHandledAtRef = useRef(0)
  const activePointerIdRef = useRef<number | null>(null)

  const invokeOnce = () => {
    if (!onClick || isDisabled) return
    const now = Date.now()
    if (now - lastTriggeredAtRef.current < 700) return
    lastTriggeredAtRef.current = now
    onClick()
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!touchSafe || isDisabled || !onClick) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    activePointerIdRef.current = event.pointerId
    markFirstInteractionHandler('action-button:pointerdown', { label })
  }

  const handlePointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!touchSafe || isDisabled || !onClick) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    if (activePointerIdRef.current !== null && activePointerIdRef.current !== event.pointerId) return
    event.preventDefault()
    activePointerIdRef.current = null
    lastPointerUpHandledAtRef.current = Date.now()
    markFirstInteractionVisual('action-button:pointerup', { label })
    invokeOnce()
  }

  const handlePointerCancel = () => {
    activePointerIdRef.current = null
  }

  const handleClick = () => {
    if (!onClick || isDisabled) return
    if (touchSafe && Date.now() - lastPointerUpHandledAtRef.current < 700) return
    markFirstInteractionHandler('action-button:click', { label })
    invokeOnce()
  }

  const showLoadingVisual = loading && !disabled

  const bg = disabled
    ? '#E2E8F0'
    : showLoadingVisual
    ? variant === 'success'
      ? '#1a9d4a'
      : variant === 'accent'
      ? '#2563EB'
      : variant === 'danger'
      ? '#e03e3e'
      : variant === 'secondary'
      ? '#F8FAFC'
      : '#1E293B'
    : variant === 'success'
    ? '#15803D'
    : variant === 'accent'
    ? 'linear-gradient(180deg, #38BDF8 0%, #2563EB 100%)'
    : variant === 'danger'
    ? '#DC2626'
    : variant === 'secondary'
    ? '#FFFFFF'
    : '#0F172A'

  const color = disabled
    ? '#94A3B8'
    : variant === 'secondary'
    ? '#60A5FA'
    : '#FFFFFF'

  const border = variant === 'secondary' ? '1.5px solid rgba(96, 165, 250, 0.16)' : 'none'

  const shadow = isDisabled
    ? 'none'
    : variant === 'secondary'
    ? 'inset 0 1px 0 rgba(255,255,255,0.03)'
    : variant === 'accent'
    ? '0 12px 28px rgba(37,99,235,0.18)'
    : '0 4px 14px rgba(15, 23, 42, 0.15)'

  return (
    <div
      style={{
        ...(sticky ? stickyWrapperStyle : { padding: '2px 0' }),
      }}
    >
      <button
        type="button"
        data-control={`action-button:${label}`}
        onClick={handleClick}
        onPointerDown={touchSafe ? handlePointerDown : undefined}
        onPointerUp={touchSafe ? handlePointerUp : undefined}
        onPointerCancel={touchSafe ? handlePointerCancel : undefined}
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
          transition: 'background 0.15s ease',
          boxShadow: shadow,
          touchAction: 'manipulation',
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
  background: 'linear-gradient(transparent, rgba(14,17,22,0.96) 20%)',
}

const spinnerStyle: React.CSSProperties = {
  display: 'inline-block',
  width: 18,
  height: 18,
  border: '2.5px solid rgba(255,255,255,0.3)',
  borderTopColor: '#FFFFFF',
  borderRadius: '50%',
  animation: 'completionSpin 0.6s linear infinite',
  flexShrink: 0,
}
