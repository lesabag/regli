import { useEffect, useState } from 'react'
import type { DurationOption } from '../lib/payments'
import type { SurgeLevel } from '../lib/pricing'

interface DurationPickerProps {
  options: DurationOption[]
  selected: string
  onSelect: (value: string) => void
  /** Surge multiplier (1.0 = normal). Adjusts displayed prices. */
  surgeMultiplier?: number
  /** Surge level for visual indicator. */
  surgeLevel?: SurgeLevel
}

export default function DurationPicker({
  options,
  selected,
  onSelect,
  surgeMultiplier = 1,
  surgeLevel = 'normal',
}: DurationPickerProps) {
  const hasSurge = surgeMultiplier > 1
  const [pressedValue, setPressedValue] = useState<string | null>(null)

  useEffect(() => {
    if (pressedValue === selected) {
      setPressedValue(null)
    }
  }, [pressedValue, selected])

  return (
    <div>
      {/* Surge banner */}
      {hasSurge && (
        <div style={{
          ...surgeBannerStyle,
          background: surgeLevel === 'high' ? '#FEF2F2' : '#FFFBEB',
          borderColor: surgeLevel === 'high' ? '#FECACA' : '#FDE68A',
          color: surgeLevel === 'high' ? '#991B1B' : '#92400E',
        }}>
          <span style={{ fontWeight: 700 }}>
            {surgeLevel === 'high' ? 'High demand' : 'Busy'} pricing
          </span>
          <span style={{ opacity: 0.8 }}>
            &nbsp;&middot; {surgeMultiplier}x
          </span>
        </div>
      )}

      <div style={containerStyle}>
        {options.map((opt) => {
          const isActive = opt.value === selected
          const isPressed = pressedValue === opt.value
          const adjustedPrice = hasSurge
            ? Math.round(opt.priceILS * surgeMultiplier)
            : opt.priceILS
          return (
            <button
              key={opt.value}
              type="button"
              onPointerDown={() => setPressedValue(opt.value)}
              onPointerUp={(event) => {
                event.preventDefault()
                event.stopPropagation()
                setPressedValue(opt.value)
                onSelect(opt.value)
                window.setTimeout(() => {
                  setPressedValue((current) => (current === opt.value ? null : current))
                }, 120)
              }}
              onPointerCancel={() => setPressedValue((current) => (current === opt.value ? null : current))}
              onPointerLeave={() => setPressedValue((current) => (current === opt.value ? null : current))}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onSelect(opt.value)
                }
              }}
              style={{
                ...pillStyle,
                background: isActive ? '#0F172A' : '#F4F6F8',
                color: isActive ? '#FFFFFF' : '#475569',
                border: isActive ? '1.5px solid #0F172A' : '1.5px solid transparent',
                transform: isPressed ? 'scale(0.98)' : 'scale(1)',
                filter: isPressed && !isActive ? 'brightness(0.97)' : 'none',
                boxShadow:
                  isActive
                    ? '0 2px 10px rgba(15, 23, 42, 0.2)'
                    : isPressed
                      ? '0 3px 10px rgba(15, 23, 42, 0.08)'
                      : 'none',
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.3 }}>{opt.label}</span>
              <span style={{ fontSize: 11, fontWeight: 600, opacity: isActive ? 0.75 : 0.5 }}>
                {hasSurge ? (
                  <>
                    <span style={{ textDecoration: 'line-through', opacity: 0.5, marginRight: 4 }}>
                      ₪{opt.priceILS}
                    </span>
                    ₪{adjustedPrice}
                  </>
                ) : (
                  <>₪{opt.priceILS}</>
                )}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

const surgeBannerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '6px 12px',
  borderRadius: 10,
  border: '1px solid',
  fontSize: 12,
  marginBottom: 8,
}

const containerStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  width: '100%',
}

const pillStyle: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 2,
  padding: '10px 6px',
  borderRadius: 14,
  cursor: 'pointer',
  transition: 'transform 0.1s ease, box-shadow 0.1s ease, filter 0.1s ease, background 0.1s ease',
  touchAction: 'manipulation',
  WebkitTapHighlightColor: 'transparent',
}
