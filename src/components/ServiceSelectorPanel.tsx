import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { PawPrint } from 'lucide-react'
import {
  FIXED_VISIT_BOOKING_SERVICES,
  SERVICE_ICONS,
  SERVICE_I18N_KEYS,
  type ServiceType,
} from '../lib/serviceTypes'

interface ServiceSelectorPanelProps {
  selected: ServiceType
  onSelect: (service: ServiceType) => void
  onMorePress: () => void
  services?: ServiceType[]
}

export default function ServiceSelectorPanel({
  selected,
  onSelect,
  onMorePress,
  services,
}: ServiceSelectorPanelProps) {
  const { t } = useTranslation()

  const visiblePrimaryServices = (services ?? ['dog_walking', 'babysitter']).filter(
    (svc): svc is ServiceType => svc === 'dog_walking' || svc === 'babysitter',
  )
  const visibleFixedVisitServices = (services ?? FIXED_VISIT_BOOKING_SERVICES).filter((svc) =>
    FIXED_VISIT_BOOKING_SERVICES.includes(svc),
  )
  const hasFixedVisitServices = visibleFixedVisitServices.length > 0
  const isMoreSelected = visibleFixedVisitServices.includes(selected)
  const fixedVisitButtonLabel = isMoreSelected
    ? t(SERVICE_I18N_KEYS[selected].label)
    : t('booking.fixedVisit.otherService')
  const renderServiceIcon = (service: ServiceType) => {
    if (service === 'dog_walking') {
      return <PawPrint size={14} strokeWidth={2.2} color="#FACC15" />
    }
    return SERVICE_ICONS[service]
  }

  return (
    <div style={wrapStyle}>
      <div style={titleStyle}>{t('booking.chooseService')}</div>
      <div className="service-panel-scroll" style={rowStyle}>
        {visiblePrimaryServices.map((svc) => {
          const isActive = selected === svc
          return (
            <button
              key={svc}
              type="button"
              onClick={() => onSelect(svc)}
              style={{
                ...itemStyle,
                ...(isActive ? itemActiveStyle : null),
              }}
            >
              <div style={{ ...iconWrapStyle, ...(isActive ? iconWrapActiveStyle : null) }}>
                <span style={iconStyle}>{renderServiceIcon(svc)}</span>
              </div>
              <span style={isActive ? labelActiveStyle : labelStyle}>
                {t(SERVICE_I18N_KEYS[svc].label)}
              </span>
            </button>
          )
        })}

        {hasFixedVisitServices && (
          <button
            type="button"
            onClick={onMorePress}
            style={{
              ...itemStyle,
              ...(isMoreSelected ? itemActiveStyle : null),
            }}
          >
            <span style={isMoreSelected ? labelActiveStyle : labelStyle}>{fixedVisitButtonLabel}</span>
            <span style={isMoreSelected ? chevronActiveStyle : chevronStyle}>▼</span>
          </button>
        )}
      </div>
    </div>
  )
}

const wrapStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
}

const titleStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: '#64748B',
  letterSpacing: 0.1,
}

const rowStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  width: '100%',
  padding: '1px 1px 2px',
}

const itemStyle: CSSProperties = {
  appearance: 'none',
  border: '1px solid rgba(148, 163, 184, 0.12)',
  outline: 'none',
  background: 'rgba(255,255,255,0.92)',
  display: 'flex',
  flexDirection: 'row',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  height: 38,
  padding: '0 12px',
  cursor: 'pointer',
  fontFamily: 'inherit',
  WebkitTapHighlightColor: 'transparent',
  touchAction: 'manipulation',
  minWidth: 0,
  flex: '1 1 0',
  borderRadius: 999,
  boxShadow: '0 6px 14px rgba(15, 23, 42, 0.04), inset 0 1px 0 rgba(255,255,255,0.82)',
}

const itemActiveStyle: CSSProperties = {
  borderColor: 'rgba(15, 23, 42, 0.08)',
  background: 'linear-gradient(180deg, #172554 0%, #0F172A 100%)',
  boxShadow: '0 10px 22px rgba(15, 23, 42, 0.18), inset 0 1px 0 rgba(255,255,255,0.08)',
}

const iconWrapStyle: CSSProperties = {
  width: 20,
  height: 20,
  borderRadius: 999,
  background: 'transparent',
  display: 'grid',
  placeItems: 'center',
  border: 'none',
  boxSizing: 'border-box',
  transition: 'background 150ms ease, box-shadow 150ms ease',
}

const iconWrapActiveStyle: CSSProperties = {
  background: 'rgba(255,255,255,0.12)',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06)',
}

const iconStyle: CSSProperties = {
  fontSize: 14,
  lineHeight: 1,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
}

const labelStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: '#64748B',
  lineHeight: 1.2,
  textAlign: 'center',
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const labelActiveStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 800,
  color: '#F8FAFC',
  lineHeight: 1.2,
  textAlign: 'center',
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const chevronStyle: CSSProperties = {
  fontSize: 10,
  lineHeight: 1,
  color: '#64748B',
  flexShrink: 0,
}

const chevronActiveStyle: CSSProperties = {
  ...chevronStyle,
  color: '#F8FAFC',
}
