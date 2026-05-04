import { useMemo, useRef, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import type { DurationOption } from '../lib/payments'
import type { SurgeLevel } from '../lib/pricing'

interface DurationPickerProps {
  options: DurationOption[]
  selected: string
  onSelect: (value: string) => void
  onEagerSelect?: (value: string) => void
  surgeMultiplier?: number
  surgeLevel?: SurgeLevel
  hidePrice?: boolean
}

export default function DurationPicker({
  options,
  selected,
  onSelect,
  onEagerSelect,
  surgeMultiplier = 1,
  surgeLevel = 'normal',
  hidePrice = false,
}: DurationPickerProps) {
  const { t } = useTranslation()
  const hasSurge = surgeMultiplier > 1
  const lastPointerSelectRef = useRef<{ value: string; at: number } | null>(null)

  const selectedOption = useMemo(
    () => options.find((o) => o.value === selected),
    [options, selected],
  )

  const displayPrice = useMemo(() => {
    if (!selectedOption) return null
    const price = hasSurge
      ? Math.round(selectedOption.priceILS * surgeMultiplier)
      : selectedOption.priceILS
    return price
  }, [selectedOption, hasSurge, surgeMultiplier])

  return (
    <div style={wrapStyle}>
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

      <div style={segmentedTrackStyle}>
        {options.map((opt) => {
          const isActive = opt.value === selected
          return (
            <button
              key={opt.value}
              type="button"
              onPointerDown={(e) => {
                if (e.pointerType === 'mouse' && e.button !== 0) return
                e.preventDefault()

                const btn = e.currentTarget
                const parent = btn.parentElement
                if (parent) {
                  for (const child of parent.children) {
                    if (child instanceof HTMLElement) {
                      child.style.backgroundColor = ''
                      child.style.color = ''
                      child.style.boxShadow = ''
                    }
                  }
                }
                btn.style.backgroundColor = '#0F172A'
                btn.style.color = '#FFFFFF'
                btn.style.boxShadow = '0 1px 4px rgba(15,23,42,0.18)'

                if (!onEagerSelect) return
                lastPointerSelectRef.current = { value: opt.value, at: Date.now() }
                onEagerSelect(opt.value)
              }}
              onClick={() => {
                const last = lastPointerSelectRef.current
                if (last && last.value === opt.value && Date.now() - last.at < 700) return
                onSelect(opt.value)
              }}
              style={{
                ...segmentStyle,
                ...(isActive ? segmentActiveStyle : null),
              }}
            >
              <span style={segmentLabelStyle}>{opt.label}</span>
            </button>
          )
        })}
      </div>

      {!hidePrice && displayPrice != null && (
        <div key={displayPrice} style={priceRowStyle}>
          <span style={priceLabelStyle}>{t('booking.priceLabel')}</span>
          <span style={priceValueStyle}>₪{displayPrice}</span>
          {hasSurge && selectedOption && (
            <span style={priceOriginalStyle}>₪{selectedOption.priceILS}</span>
          )}
        </div>
      )}
    </div>
  )
}

const wrapStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
}

const surgeBannerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '5px 10px',
  borderRadius: 10,
  border: '1px solid',
  fontSize: 12,
}

const segmentedTrackStyle: CSSProperties = {
  display: 'flex',
  gap: 4,
  padding: 3,
  borderRadius: 14,
  background: '#F1F5F9',
  width: '100%',
  boxSizing: 'border-box',
}

const segmentStyle: CSSProperties = {
  flex: 1,
  appearance: 'none',
  border: 'none',
  outline: 'none',
  minHeight: 44,
  borderRadius: 11,
  backgroundColor: 'transparent',
  color: '#64748B',
  cursor: 'pointer',
  padding: '0 4px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  WebkitTapHighlightColor: 'transparent',
  WebkitUserSelect: 'none',
  userSelect: 'none',
  touchAction: 'manipulation',
  WebkitAppearance: 'none',
}

const segmentActiveStyle: CSSProperties = {
  backgroundColor: '#0F172A',
  color: '#FFFFFF',
  boxShadow: '0 1px 4px rgba(15,23,42,0.18)',
}

const segmentLabelStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 800,
  lineHeight: 1,
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
}

const priceRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  paddingInlineStart: 2,
  animation: 'durationPriceChange 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
}

const priceLabelStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: '#94A3B8',
}

const priceValueStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 900,
  color: '#0F172A',
}

const priceOriginalStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: '#94A3B8',
  textDecoration: 'line-through',
}
