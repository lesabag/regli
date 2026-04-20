import { useEffect, useMemo, useState } from 'react'

interface IOSDateTimeSheetProps {
  open: boolean
  value: string
  minValue?: string
  title?: string
  subtitle?: string
  onChange: (value: string) => void
  onClose: () => void
  onConfirm: (value: string) => void
  onBackToNow?: () => void
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function toLocalDatetimeInputValue(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`
}

function getNowPlus15LocalInput(): string {
  return toLocalDatetimeInputValue(new Date(Date.now() + 15 * 60 * 1000))
}

function parseLocalDateTime(value: string | null | undefined): Date | null {
  if (!value || typeof value !== 'string') return null

  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/,
  )
  if (!match) return null

  const [, year, month, day, hour, minute, second] = match
  const dt = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second || '0'),
    0,
  )

  return Number.isNaN(dt.getTime()) ? null : dt
}

function clampToMin(value: string, minValue?: string): string {
  if (!minValue) return value
  const current = parseLocalDateTime(value)
  const min = parseLocalDateTime(minValue)
  if (!current || !min) return value
  return current.getTime() < min.getTime() ? minValue : value
}

function splitDateTime(value: string): { date: string; time: string } {
  const dt = parseLocalDateTime(value) ?? new Date()
  return {
    date: `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`,
    time: `${pad(dt.getHours())}:${pad(dt.getMinutes())}`,
  }
}

function mergeDateAndTime(datePart: string, timePart: string): string {
  if (!datePart || !timePart) return ''
  return `${datePart}T${timePart}`
}

function formatPreview(value: string): string {
  const dt = parseLocalDateTime(value)
  if (!dt) return ''
  return dt.toLocaleString([], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function useBodyScrollLock(open: boolean) {
  useEffect(() => {
    if (!open) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [open])
}

export default function IOSDateTimeSheet({
  open,
  value,
  minValue,
  title = 'Choose date & time',
  subtitle = '',
  onChange,
  onClose,
  onConfirm,
  onBackToNow,
}: IOSDateTimeSheetProps) {
  const effectiveMin = minValue || getNowPlus15LocalInput()

  const initialValue = clampToMin(value || getNowPlus15LocalInput(), effectiveMin)
  const initialParts = splitDateTime(initialValue)

  const [datePart, setDatePart] = useState(initialParts.date)
  const [timePart, setTimePart] = useState(initialParts.time)

  useBodyScrollLock(open)

  useEffect(() => {
    if (!open) return
    const nextValue = value ? clampToMin(value, effectiveMin) : clampToMin(getNowPlus15LocalInput(), effectiveMin)
    const parts = splitDateTime(nextValue)
    setDatePart(parts.date)
    setTimePart(parts.time)
  }, [open, value, effectiveMin])

  const combinedValue = useMemo(
    () => clampToMin(mergeDateAndTime(datePart, timePart), effectiveMin),
    [datePart, timePart, effectiveMin],
  )

  useEffect(() => {
    if (!open) return
    if (!combinedValue) return
    onChange(combinedValue)
  }, [combinedValue, onChange, open])

  const minDate = effectiveMin ? effectiveMin.slice(0, 10) : undefined
  const minTimeForSameDay =
    minDate && datePart === minDate && effectiveMin.includes('T')
      ? effectiveMin.slice(11, 16)
      : undefined

  if (!open) return null

  return (
    <>
      <div style={overlayStyle} onClick={onClose} />

      <div style={sheetStyle}>
        <div style={handleStyle} />

        <div style={headerStyle}>
          <div style={titleStyle}>{title}</div>
          {subtitle ? <div style={subtitleStyle}>{subtitle}</div> : null}
          <div style={previewStyle}>{formatPreview(combinedValue)}</div>
        </div>

        <div style={formWrapStyle}>
          <div style={fieldStyle}>
            <label style={labelStyle}>Date</label>
            <input
              type="date"
              value={datePart}
              min={minDate}
              onChange={(e) => setDatePart(e.target.value)}
              style={inputStyle}
            />
          </div>

          <div style={fieldStyle}>
            <label style={labelStyle}>Time</label>
            <input
              type="time"
              value={timePart}
              min={minTimeForSameDay}
              step={60}
              onChange={(e) => setTimePart(e.target.value)}
              style={inputStyle}
            />
          </div>
        </div>

        <div style={footerStyle}>
          {onBackToNow ? (
            <button type="button" onClick={onBackToNow} style={secondaryButtonStyle}>
              Back to now
            </button>
          ) : (
            <div />
          )}

          <button
            type="button"
            onClick={() => onConfirm(combinedValue)}
            style={primaryButtonStyle}
          >
            Set time
          </button>
        </div>
      </div>
    </>
  )
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(15, 23, 42, 0.22)',
  zIndex: 2400,
}

const sheetStyle: React.CSSProperties = {
  position: 'fixed',
  left: 0,
  right: 0,
  bottom: 0,
  zIndex: 2401,
  background: '#FFFFFF',
  borderTopLeftRadius: 24,
  borderTopRightRadius: 24,
  boxShadow: '0 -14px 34px rgba(15, 23, 42, 0.10)',
  padding: '10px 14px calc(12px + env(safe-area-inset-bottom))',
}

const handleStyle: React.CSSProperties = {
  width: 38,
  height: 5,
  borderRadius: 999,
  background: '#D7DBE3',
  margin: '0 auto 10px',
}

const headerStyle: React.CSSProperties = {
  textAlign: 'center',
  padding: '2px 8px 10px',
}

const titleStyle: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.2,
  fontWeight: 700,
  color: '#0F172A',
}

const subtitleStyle: React.CSSProperties = {
  marginTop: 2,
  fontSize: 11,
  lineHeight: 1.3,
  color: '#8B95A7',
}

const previewStyle: React.CSSProperties = {
  marginTop: 8,
  fontSize: 13,
  lineHeight: 1.25,
  fontWeight: 600,
  color: '#6B7280',
}

const formWrapStyle: React.CSSProperties = {
  display: 'grid',
  gap: 12,
  marginTop: 8,
}

const fieldStyle: React.CSSProperties = {
  display: 'grid',
  gap: 6,
}

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: '#64748B',
  textTransform: 'uppercase',
  letterSpacing: 0.35,
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 48,
  borderRadius: 14,
  border: '1px solid #E2E8F0',
  background: '#F8FAFC',
  color: '#0F172A',
  fontSize: 16,
  padding: '0 14px',
  outline: 'none',
  boxSizing: 'border-box',
}

const footerStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 10,
  marginTop: 14,
}

const secondaryButtonStyle: React.CSSProperties = {
  minHeight: 46,
  borderRadius: 14,
  border: '1px solid #E2E8F0',
  background: '#FFFFFF',
  color: '#334155',
  fontSize: 14,
  fontWeight: 800,
  cursor: 'pointer',
}

const primaryButtonStyle: React.CSSProperties = {
  minHeight: 46,
  borderRadius: 14,
  border: 'none',
  background: '#08153B',
  color: '#FFFFFF',
  fontSize: 14,
  fontWeight: 800,
  cursor: 'pointer',
}
