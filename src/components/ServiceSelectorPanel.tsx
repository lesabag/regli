import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { PawPrint } from 'lucide-react'
import {
  PRIMARY_SERVICES,
  MORE_SERVICES,
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

  const visiblePrimaryServices = services && services.length > 0
    ? PRIMARY_SERVICES.filter((svc) => services.includes(svc))
    : PRIMARY_SERVICES
  const visibleMoreServices = services && services.length > 0
    ? MORE_SERVICES.filter((svc) => services.includes(svc))
    : MORE_SERVICES
  const isMoreSelected = (visibleMoreServices as readonly ServiceType[]).includes(selected)
  const renderServiceIcon = (service: ServiceType) => {
    if (service === 'dog_walking') {
      return <PawPrint size={16} strokeWidth={2.2} color="#FACC15" />
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

        {isMoreSelected && (
          <button
            key={selected}
            type="button"
            onClick={onMorePress}
            style={{
              ...itemStyle,
              ...itemActiveStyle,
            }}
          >
            <div style={{ ...iconWrapStyle, ...iconWrapActiveStyle }}>
              <span style={iconStyle}>{renderServiceIcon(selected)}</span>
            </div>
            <span style={labelActiveStyle}>
              {t(SERVICE_I18N_KEYS[selected].label)}
            </span>
          </button>
        )}

        {visibleMoreServices.length > 0 && (
          <button
            type="button"
            onClick={onMorePress}
            style={itemStyle}
          >
            <div style={iconWrapStyle}>
              <span style={moreIconStyle}>⋯</span>
            </div>
            <span style={labelStyle}>{t('services.more')}</span>
          </button>
        )}
      </div>
    </div>
  )
}

const wrapStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}

const titleStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: '#64748B',
  letterSpacing: 0.1,
}

const rowStyle: CSSProperties = {
  display: 'flex',
  gap: 10,
  overflowX: 'auto',
  WebkitOverflowScrolling: 'touch',
  scrollbarWidth: 'none',
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
  gap: 8,
  height: 44,
  padding: '0 15px',
  cursor: 'pointer',
  fontFamily: 'inherit',
  WebkitTapHighlightColor: 'transparent',
  touchAction: 'manipulation',
  minWidth: 132,
  flexShrink: 0,
  borderRadius: 999,
  boxShadow: '0 6px 14px rgba(15, 23, 42, 0.04), inset 0 1px 0 rgba(255,255,255,0.82)',
}

const itemActiveStyle: CSSProperties = {
  borderColor: 'rgba(15, 23, 42, 0.08)',
  background: 'linear-gradient(180deg, #172554 0%, #0F172A 100%)',
  boxShadow: '0 10px 22px rgba(15, 23, 42, 0.18), inset 0 1px 0 rgba(255,255,255,0.08)',
}

const iconWrapStyle: CSSProperties = {
  width: 24,
  height: 24,
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
  fontSize: 16,
  lineHeight: 1,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
}

const moreIconStyle: CSSProperties = {
  fontSize: 18,
  lineHeight: 1,
  color: '#64748B',
  fontWeight: 700,
}

const labelStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: '#64748B',
  lineHeight: 1.2,
  textAlign: 'left',
  maxWidth: 'none',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const labelActiveStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 800,
  color: '#F8FAFC',
  lineHeight: 1.2,
  textAlign: 'left',
  maxWidth: 'none',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
