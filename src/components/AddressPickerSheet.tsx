import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'

interface AddressPickerSheetProps {
  currentAddress: string
  onConfirm: (address: string) => void
  onUseCurrentLocation: () => void
  onClose: () => void
  locationLoading?: boolean
}

function parseAddressParts(address: string): { street: string; houseNumber: string; city: string } {
  const trimmed = address.trim()
  if (!trimmed) return { street: '', houseNumber: '', city: '' }

  const commaIdx = trimmed.indexOf(',')
  let streetPart = commaIdx >= 0 ? trimmed.slice(0, commaIdx).trim() : trimmed
  const city = commaIdx >= 0 ? trimmed.slice(commaIdx + 1).trim() : ''

  const tokens = streetPart.split(/\s+/)
  let houseNumber = ''
  if (tokens.length >= 2) {
    const last = tokens[tokens.length - 1]
    if (/^\d+[A-Za-zא-ת]?(?:[/-]\d+)?$/.test(last)) {
      houseNumber = last
      streetPart = tokens.slice(0, -1).join(' ')
    }
  }

  return { street: streetPart, houseNumber, city }
}

function buildAddress(street: string, houseNumber: string, city: string): string {
  const s = street.trim()
  const h = houseNumber.trim()
  const c = city.trim()
  if (!s && !c) return h
  const streetWithNum = h ? `${s} ${h}` : s
  if (streetWithNum && c) return `${streetWithNum}, ${c}`
  return streetWithNum || c
}

function blurActiveInput() {
  const el = document.activeElement
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.blur()
  }
}

export default function AddressPickerSheet({
  currentAddress,
  onConfirm,
  onUseCurrentLocation,
  onClose,
  locationLoading = false,
}: AddressPickerSheetProps) {
  const { t } = useTranslation()
  const isRtl = document.documentElement.dir === 'rtl'

  const parsed = parseAddressParts(currentAddress)
  const [street, setStreet] = useState(parsed.street)
  const [houseNumber, setHouseNumber] = useState(parsed.houseNumber)
  const [city, setCity] = useState(parsed.city)
  const [refreshing, setRefreshing] = useState(false)
  const streetRef = useRef<HTMLInputElement>(null)
  const closingRef = useRef(false)
  const restoreDocumentStylesRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const previousBodyOverflow = document.body.style.overflow
    const previousHtmlOverflow = document.documentElement.style.overflow

    document.body.style.overflow = 'hidden'
    document.documentElement.style.overflow = 'hidden'

    restoreDocumentStylesRef.current = () => {
      document.body.style.overflow = previousBodyOverflow
      document.documentElement.style.overflow = previousHtmlOverflow
      restoreDocumentStylesRef.current = null
    }

    return () => {
      restoreDocumentStylesRef.current?.()
    }
  }, [])

  useEffect(() => {
    const timeout = setTimeout(() => {
      if (closingRef.current) return
      streetRef.current?.focus()
    }, 120)
    return () => clearTimeout(timeout)
  }, [])

  useEffect(() => {
    if (refreshing && !locationLoading) {
      setRefreshing(false)
      safeClose()
    }
  }, [locationLoading, refreshing])

  const safeClose = useCallback(() => {
    if (closingRef.current) return
    closingRef.current = true
    blurActiveInput()
    window.scrollTo(0, 0)
    restoreDocumentStylesRef.current?.()
    requestAnimationFrame(() => {
      onClose()
      requestAnimationFrame(() => {
        window.scrollTo(0, 0)
      })
    })
  }, [onClose])

  const handleConfirm = useCallback(() => {
    const address = buildAddress(street, houseNumber, city)
    if (address) {
      onConfirm(address)
    }
    safeClose()
  }, [street, houseNumber, city, onConfirm, safeClose])

  const handleUseCurrentLocation = useCallback(() => {
    blurActiveInput()
    setRefreshing(true)
    onUseCurrentLocation()
  }, [onUseCurrentLocation])

  const canConfirm = street.trim().length > 0

  return (
    <>
      <div style={overlayStyle} onClick={safeClose} />
      <div style={sheetStyle}>
        <div style={headerStyle}>
          <span style={titleStyle}>{t('addressPicker.title')}</span>
          <button type="button" onClick={safeClose} style={closeStyle}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <button type="button" onClick={handleUseCurrentLocation} style={currentLocationBtnStyle} disabled={refreshing}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#3B82F6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <circle cx="12" cy="12" r="3" />
            <line x1="12" y1="2" x2="12" y2="5" />
            <line x1="12" y1="19" x2="12" y2="22" />
            <line x1="2" y1="12" x2="5" y2="12" />
            <line x1="19" y1="12" x2="22" y2="12" />
          </svg>
          <span style={{ flex: 1 }}>
            {refreshing ? t('addressPicker.refreshingLocation') : t('addressPicker.useCurrentLocation')}
          </span>
          {refreshing && <span style={spinnerStyle} />}
        </button>

        <div style={dividerStyle} />

        <div style={fieldsStyle}>
          <div style={fieldRowStyle}>
            <div style={fieldGroupStyle}>
              <label style={fieldLabelStyle}>{t('addressPicker.street')}</label>
              <input
                ref={streetRef}
                type="text"
                value={street}
                onChange={(e) => setStreet(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleConfirm() } }}
                placeholder={t('addressPicker.searchPlaceholder')}
                style={fieldInputStyle}
                dir={isRtl ? 'rtl' : 'ltr'}
                autoComplete="street-address"
                enterKeyHint="done"
              />
            </div>
            <div style={houseNumberGroupStyle}>
              <label style={fieldLabelStyle}>{t('addressPicker.houseNumber')}</label>
              <input
                type="text"
                value={houseNumber}
                onChange={(e) => setHouseNumber(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleConfirm() } }}
                placeholder="—"
                style={fieldInputStyle}
                dir="ltr"
                inputMode="text"
                enterKeyHint="done"
              />
            </div>
          </div>

          <div style={fieldGroupStyle}>
            <label style={fieldLabelStyle}>{t('addressPicker.city')}</label>
            <input
              type="text"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleConfirm() } }}
              placeholder="—"
              style={fieldInputStyle}
              dir={isRtl ? 'rtl' : 'ltr'}
              autoComplete="address-level2"
              enterKeyHint="done"
            />
          </div>
        </div>

        <button
          type="button"
          onClick={handleConfirm}
          style={{
            ...confirmBtnStyle,
            ...(canConfirm ? null : confirmBtnDisabledStyle),
          }}
          disabled={!canConfirm}
        >
          {t('addressPicker.confirm')}
        </button>
      </div>
    </>
  )
}

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(15,23,42,0.4)',
  zIndex: 9998,
}

const sheetStyle: CSSProperties = {
  position: 'fixed',
  bottom: 0,
  left: 0,
  right: 0,
  zIndex: 9999,
  background: '#FFFFFF',
  borderTopLeftRadius: 24,
  borderTopRightRadius: 24,
  boxShadow: '0 -8px 32px rgba(15,23,42,0.12)',
  padding: '16px 20px calc(14px + env(safe-area-inset-bottom, 0px))',
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  maxHeight: '85dvh',
  overflowY: 'auto',
  WebkitOverflowScrolling: 'touch',
}

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
}

const titleStyle: CSSProperties = {
  fontSize: 18,
  fontWeight: 900,
  color: '#0F172A',
}

const closeStyle: CSSProperties = {
  appearance: 'none',
  border: 'none',
  background: 'rgba(241,245,249,0.9)',
  borderRadius: 999,
  width: 32,
  height: 32,
  display: 'grid',
  placeItems: 'center',
  cursor: 'pointer',
  color: '#64748B',
  padding: 0,
}

const currentLocationBtnStyle: CSSProperties = {
  appearance: 'none',
  border: '1px solid rgba(59,130,246,0.2)',
  background: 'rgba(239,246,255,0.5)',
  borderRadius: 14,
  padding: '12px 14px',
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  fontSize: 15,
  fontWeight: 700,
  color: '#1D4ED8',
  cursor: 'pointer',
  textAlign: 'start',
  width: '100%',
}

const spinnerStyle: CSSProperties = {
  width: 16,
  height: 16,
  border: '2px solid rgba(59,130,246,0.2)',
  borderTopColor: '#3B82F6',
  borderRadius: '50%',
  animation: 'spin 0.6s linear infinite',
  flexShrink: 0,
}

const dividerStyle: CSSProperties = {
  height: 1,
  background: 'rgba(226,232,240,0.8)',
  margin: '0 -4px',
}

const fieldsStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
}

const fieldRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 72px',
  gap: 10,
}

const fieldGroupStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
}

const houseNumberGroupStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  width: 72,
}

const fieldLabelStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 800,
  color: '#64748B',
  letterSpacing: 0.3,
}

const fieldInputStyle: CSSProperties = {
  appearance: 'none',
  border: '1.5px solid rgba(226,232,240,0.95)',
  borderRadius: 12,
  padding: '10px 12px',
  fontSize: 16,
  fontWeight: 600,
  color: '#0F172A',
  background: '#F8FAFC',
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
  fontFamily: 'inherit',
  transition: 'border-color 150ms ease',
}

const confirmBtnStyle: CSSProperties = {
  appearance: 'none',
  border: 'none',
  minHeight: 48,
  borderRadius: 16,
  background: 'linear-gradient(180deg, #2563EB 0%, #1D4ED8 100%)',
  color: '#FFFFFF',
  fontSize: 16,
  fontWeight: 900,
  cursor: 'pointer',
  boxShadow: '0 12px 28px rgba(37,99,235,0.18)',
  width: '100%',
  flexShrink: 0,
}

const confirmBtnDisabledStyle: CSSProperties = {
  opacity: 0.45,
  cursor: 'default',
}
