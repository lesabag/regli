import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'

interface AddressPickerSheetProps {
  currentAddress: string
  onConfirm: (address: string) => void
  onUseCurrentLocation: () => Promise<boolean>
  onClose: () => void
  locationLoading?: boolean
  locationError?: string | null
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
  locationError = null,
}: AddressPickerSheetProps) {
  const { t } = useTranslation()
  const isRtl = document.documentElement.dir === 'rtl'

  const parsed = parseAddressParts(currentAddress)
  const [street, setStreet] = useState(parsed.street)
  const [houseNumber, setHouseNumber] = useState(parsed.houseNumber)
  const [city, setCity] = useState(parsed.city)
  const [refreshing, setRefreshing] = useState(false)
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

  const handleUseCurrentLocation = useCallback(async () => {
    blurActiveInput()
    setRefreshing(true)
    const updated = await onUseCurrentLocation()
    setRefreshing(false)
    if (updated) {
      safeClose()
    }
  }, [onUseCurrentLocation])

  const canConfirm = street.trim().length > 0

  return (
    <>
      <div style={overlayStyle} onClick={safeClose} />
      <div style={sheetStyle}>
        <div style={handleStyle} />

        <div style={headerStyle}>
          <div style={titleStyle}>{t('addressPicker.title')}</div>
        </div>

        <button type="button" onClick={() => void handleUseCurrentLocation()} style={currentLocationBtnStyle} disabled={refreshing || locationLoading}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#3B82F6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <circle cx="12" cy="12" r="3" />
            <line x1="12" y1="2" x2="12" y2="5" />
            <line x1="12" y1="19" x2="12" y2="22" />
            <line x1="2" y1="12" x2="5" y2="12" />
            <line x1="19" y1="12" x2="22" y2="12" />
          </svg>
          <span style={{ flex: 1 }}>
            {refreshing || locationLoading ? t('addressPicker.refreshingLocation') : t('addressPicker.useCurrentLocation')}
          </span>
          {(refreshing || locationLoading) && <span style={spinnerStyle} />}
        </button>

        {locationError && (
          <div style={locationErrorStyle}>
            {locationError}
          </div>
        )}

        <div style={fieldsStyle}>
          <div style={fieldRowStyle}>
            <div style={fieldGroupStyle}>
              <label style={fieldLabelStyle}>{t('addressPicker.street')}</label>
              <input
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
  background: 'rgba(15,23,42,0.26)',
  zIndex: 9998,
}

const sheetStyle: CSSProperties = {
  position: 'fixed',
  bottom: 0,
  left: 'env(safe-area-inset-left, 0px)',
  right: 'env(safe-area-inset-right, 0px)',
  zIndex: 9999,
  background: '#FFFFFF',
  borderTopLeftRadius: 24,
  borderTopRightRadius: 24,
  boxShadow: '0 -8px 32px rgba(15,23,42,0.12)',
  padding: '8px 16px calc(12px + env(safe-area-inset-bottom, 0px))',
  display: 'grid',
  gap: 10,
  boxSizing: 'border-box',
  maxWidth: '100%',
  overflowX: 'hidden',
}

const handleStyle: CSSProperties = {
  width: 42,
  height: 4,
  borderRadius: 999,
  background: '#CBD5E1',
  margin: '0 auto 2px',
}

const headerStyle: CSSProperties = {
  display: 'grid',
  gap: 4,
}

const titleStyle: CSSProperties = {
  fontSize: 18,
  fontWeight: 900,
  color: '#0F172A',
}

const currentLocationBtnStyle: CSSProperties = {
  appearance: 'none',
  border: '1px solid rgba(59,130,246,0.2)',
  background: 'rgba(239,246,255,0.5)',
  borderRadius: 14,
  padding: '10px 12px',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  fontSize: 14,
  fontWeight: 700,
  color: '#1D4ED8',
  cursor: 'pointer',
  textAlign: 'start',
  width: '100%',
}

const locationErrorStyle: CSSProperties = {
  borderRadius: 14,
  border: '1px solid rgba(220,38,38,0.16)',
  background: 'rgba(254,242,242,0.96)',
  color: '#B91C1C',
  padding: '10px 12px',
  fontSize: 13,
  lineHeight: 1.45,
  textAlign: 'start',
}

const spinnerStyle: CSSProperties = {
  width: 14,
  height: 14,
  border: '2px solid rgba(59,130,246,0.2)',
  borderTopColor: '#3B82F6',
  borderRadius: '50%',
  animation: 'spin 0.6s linear infinite',
  flexShrink: 0,
}

const fieldsStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}

const fieldRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 68px',
  gap: 8,
}

const fieldGroupStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
}

const houseNumberGroupStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
  width: 68,
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
  padding: '9px 11px',
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
  minHeight: 46,
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
