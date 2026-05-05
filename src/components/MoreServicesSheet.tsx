import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import {
  MORE_SERVICES,
  SERVICE_ICONS,
  SERVICE_I18N_KEYS,
  type ServiceType,
} from '../lib/serviceTypes'

interface MoreServicesSheetProps {
  onSelect: (service: ServiceType) => void
  onClose: () => void
}

export default function MoreServicesSheet({
  onSelect,
  onClose,
}: MoreServicesSheetProps) {
  const { t } = useTranslation()

  return (
    <>
      <div style={overlayStyle} onClick={onClose} />
      <div style={sheetStyle}>
        <div style={handleStyle} />
        <div style={titleStyle}>{t('services.more')}</div>
        <div style={listStyle}>
          {MORE_SERVICES.map((svc) => (
            <button
              key={svc}
              type="button"
              onClick={() => {
                onSelect(svc)
                onClose()
              }}
              style={itemStyle}
            >
              <span style={itemIconStyle}>{SERVICE_ICONS[svc]}</span>
              <span style={itemLabelStyle}>{t(SERVICE_I18N_KEYS[svc].label)}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  )
}

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(15,23,42,0.3)',
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
  padding: '8px 20px calc(14px + env(safe-area-inset-bottom, 0px))',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
}

const handleStyle: CSSProperties = {
  width: 42,
  height: 4,
  borderRadius: 999,
  background: '#CBD5E1',
  margin: '0 auto 4px',
}

const titleStyle: CSSProperties = {
  fontSize: 17,
  fontWeight: 900,
  color: '#0F172A',
  paddingBottom: 4,
}

const listStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
}

const itemStyle: CSSProperties = {
  appearance: 'none',
  border: 'none',
  background: 'transparent',
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  padding: '12px 4px',
  borderRadius: 14,
  cursor: 'pointer',
  fontFamily: 'inherit',
  WebkitTapHighlightColor: 'transparent',
  touchAction: 'manipulation',
}

const itemIconStyle: CSSProperties = {
  fontSize: 22,
  width: 36,
  height: 36,
  display: 'grid',
  placeItems: 'center',
  background: '#F1F5F9',
  borderRadius: 12,
  flexShrink: 0,
}

const itemLabelStyle: CSSProperties = {
  fontSize: 15,
  fontWeight: 700,
  color: '#0F172A',
}
