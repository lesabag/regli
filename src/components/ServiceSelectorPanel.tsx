import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
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
              style={itemStyle}
            >
              <div style={{ ...circleStyle, ...(isActive ? circleActiveStyle : null) }}>
                <span style={iconStyle}>{SERVICE_ICONS[svc]}</span>
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
            style={itemStyle}
          >
            <div style={{ ...circleStyle, ...circleActiveStyle }}>
              <span style={iconStyle}>{SERVICE_ICONS[selected]}</span>
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
            <div style={circleStyle}>
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
  fontSize: 13,
  fontWeight: 800,
  color: '#64748B',
  letterSpacing: 0.2,
}

const rowStyle: CSSProperties = {
  display: 'flex',
  gap: 12,
  overflowX: 'auto',
  WebkitOverflowScrolling: 'touch',
  scrollbarWidth: 'none',
  padding: '2px 0',
}

const itemStyle: CSSProperties = {
  appearance: 'none',
  border: 'none',
  outline: 'none',
  background: 'transparent',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 4,
  padding: 0,
  cursor: 'pointer',
  fontFamily: 'inherit',
  WebkitTapHighlightColor: 'transparent',
  touchAction: 'manipulation',
  minWidth: 56,
  flexShrink: 0,
}

const circleStyle: CSSProperties = {
  width: 48,
  height: 48,
  borderRadius: 16,
  background: '#F1F5F9',
  display: 'grid',
  placeItems: 'center',
  border: '2px solid transparent',
  boxSizing: 'border-box',
  transition: 'border-color 150ms ease, background 150ms ease',
}

const circleActiveStyle: CSSProperties = {
  border: '2px solid #3B82F6',
  background: '#EFF6FF',
}

const iconStyle: CSSProperties = {
  fontSize: 20,
  lineHeight: 1,
}

const moreIconStyle: CSSProperties = {
  fontSize: 22,
  lineHeight: 1,
  color: '#64748B',
  fontWeight: 700,
}

const labelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: '#94A3B8',
  lineHeight: 1.2,
  textAlign: 'center',
  maxWidth: 64,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const labelActiveStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  color: '#0F172A',
  lineHeight: 1.2,
  textAlign: 'center',
  maxWidth: 64,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
