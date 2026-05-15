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
  services?: ServiceType[]
}

export default function MoreServicesSheet({
  onSelect,
  onClose,
  services,
}: MoreServicesSheetProps) {
  const { t } = useTranslation()
  const visibleServices = services && services.length > 0
    ? MORE_SERVICES.filter((svc) => services.includes(svc))
    : MORE_SERVICES

  return (
    <>
      <div style={overlayStyle} onClick={onClose} />
      <div style={sheetStyle}>
        <div style={handleStyle} />
        <div style={titleStyle}>{t('services.more')}</div>
        <div style={listStyle}>
          {visibleServices.map((svc) => (
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
  background: 'rgba(2, 6, 23, 0.58)',
  zIndex: 9998,
}

const sheetStyle: CSSProperties = {
  position: 'fixed',
  bottom: 'max(6px, env(safe-area-inset-bottom, 0px))',
  left: 'max(8px, env(safe-area-inset-left, 0px))',
  right: 'max(8px, env(safe-area-inset-right, 0px))',
  zIndex: 9999,
  background: 'linear-gradient(180deg, rgba(14,17,22,0.94) 0%, rgba(20,24,31,0.96) 100%)',
  border: '1px solid rgba(148, 163, 184, 0.12)',
  borderRadius: 30,
  boxShadow: '0 20px 40px rgba(2, 6, 23, 0.30), inset 0 1px 0 rgba(255,255,255,0.04)',
  backdropFilter: 'blur(24px)',
  WebkitBackdropFilter: 'blur(24px)',
  padding: '12px 16px calc(16px + env(safe-area-inset-bottom, 0px))',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}

const handleStyle: CSSProperties = {
  width: 42,
  height: 4,
  borderRadius: 999,
  background: 'rgba(148, 163, 184, 0.52)',
  margin: '0 auto 4px',
}

const titleStyle: CSSProperties = {
  fontSize: 17,
  fontWeight: 900,
  color: '#F8FAFC',
  paddingBottom: 4,
}

const listStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
}

const itemStyle: CSSProperties = {
  appearance: 'none',
  border: '1px solid rgba(148, 163, 184, 0.10)',
  background: 'rgba(255,255,255,0.03)',
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  padding: '12px 10px',
  borderRadius: 16,
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
  background: 'rgba(17, 24, 39, 0.78)',
  borderRadius: 12,
  flexShrink: 0,
}

const itemLabelStyle: CSSProperties = {
  fontSize: 15,
  fontWeight: 700,
  color: '#F8FAFC',
}
