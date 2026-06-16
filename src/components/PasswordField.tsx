import { useMemo, useState, type CSSProperties } from 'react'

interface PasswordFieldProps {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder: string
  autoComplete?: string
  language: 'he' | 'en'
  compact?: boolean
}

const MIN_PASSWORD_LENGTH = 8

export default function PasswordField({
  label,
  value,
  onChange,
  placeholder,
  autoComplete,
  language,
  compact = false,
}: PasswordFieldProps) {
  const [revealed, setRevealed] = useState(false)
  const isHebrew = language === 'he'
  const textAlign: CSSProperties['textAlign'] = isHebrew ? 'right' : 'left'
  const meetsMinLength = value.length >= MIN_PASSWORD_LENGTH

  const hintText = useMemo(() => {
    if (isHebrew) {
      return meetsMinLength ? '✓ לפחות 8 תווים' : 'לפחות 8 תווים'
    }
    return meetsMinLength ? '✓ At least 8 characters' : 'At least 8 characters'
  }, [isHebrew, meetsMinLength])

  return (
    <div style={fieldBlockStyle}>
      <label style={{ ...labelStyle, ...(compact ? compactLabelStyle : null), textAlign }}>{label}</label>
      <div style={inputWrapStyle}>
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          type={revealed ? 'text' : 'password'}
          autoComplete={autoComplete}
          dir={isHebrew ? 'rtl' : 'ltr'}
          style={{
            ...inputStyle,
            ...(compact ? compactInputStyle : null),
            textAlign,
            ...(isHebrew ? inputRtlStyle : inputLtrStyle),
          }}
        />
        <button
          type="button"
          onClick={() => setRevealed((current) => !current)}
          aria-label={isHebrew ? (revealed ? 'הסתר סיסמה' : 'הצג סיסמה') : (revealed ? 'Hide password' : 'Show password')}
          style={{
            ...toggleButtonStyle,
            ...(isHebrew ? toggleButtonRtlStyle : toggleButtonLtrStyle),
          }}
        >
          {revealed ? '🙈' : '👁'}
        </button>
      </div>
      <div
        style={{
          ...hintStyle,
          ...(compact ? compactHintStyle : null),
          color: meetsMinLength ? '#15803D' : '#64748B',
          textAlign,
        }}
      >
        {hintText}
      </div>
    </div>
  )
}

const fieldBlockStyle: CSSProperties = {
  display: 'grid',
  gap: 4,
}

const labelStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 800,
  color: '#23314F',
}

const compactLabelStyle: CSSProperties = {
  fontSize: 11.5,
}

const inputWrapStyle: CSSProperties = {
  position: 'relative',
}

const inputStyle: CSSProperties = {
  width: '100%',
  minHeight: 46,
  borderRadius: 16,
  border: '1px solid rgba(145, 164, 196, 0.24)',
  background: '#FFFFFF',
  fontSize: 14,
  color: '#0F172A',
  boxSizing: 'border-box',
  outline: 'none',
}

const compactInputStyle: CSSProperties = {
  minHeight: 42,
  fontSize: 13.5,
}

const inputLtrStyle: CSSProperties = {
  padding: '0 44px 0 14px',
}

const inputRtlStyle: CSSProperties = {
  padding: '0 14px 0 44px',
}

const toggleButtonStyle: CSSProperties = {
  appearance: 'none',
  border: 'none',
  background: 'transparent',
  position: 'absolute',
  top: '50%',
  transform: 'translateY(-50%)',
  width: 32,
  height: 32,
  display: 'grid',
  placeItems: 'center',
  cursor: 'pointer',
  fontSize: 16,
  lineHeight: 1,
  padding: 0,
}

const toggleButtonLtrStyle: CSSProperties = {
  right: 8,
}

const toggleButtonRtlStyle: CSSProperties = {
  left: 8,
}

const hintStyle: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.4,
  fontWeight: 600,
}

const compactHintStyle: CSSProperties = {
  fontSize: 11.5,
  lineHeight: 1.3,
}
