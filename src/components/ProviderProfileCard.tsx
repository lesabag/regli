import { useTranslation } from 'react-i18next'
import type { CSSProperties } from 'react'
import ProfileAvatar from './ProfileAvatar'

export interface ProviderProfileCardProps {
  avatarUrl: string | null
  fullName: string
  rating: number | null
  serviceLabel?: string | null
  priceLabel?: string | null
  experienceRange?: string | null
  experienceYears?: number | null
  languages?: string[] | null
  shortBio?: string | null
  completedCount?: number | null
  whatsappAvailable?: boolean
  onClose?: () => void
}

function formatExperienceLabel(
  experienceRange: string | null | undefined,
  experienceYears: number | null | undefined,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  const normalizedRange = (experienceRange ?? '').trim().toLowerCase()
  if (normalizedRange === '0_1') return t('providerPublicProfile.experienceRanges.0_1')
  if (normalizedRange === '1_3') return t('providerPublicProfile.experienceRanges.1_3')
  if (normalizedRange === '3_5') return t('providerPublicProfile.experienceRanges.3_5')
  if (normalizedRange === '5_10') return t('providerPublicProfile.experienceRanges.5_10')
  if (normalizedRange === '10_plus') return t('providerPublicProfile.experienceRanges.10_plus')

  if (typeof experienceYears === 'number' && Number.isFinite(experienceYears) && experienceYears > 0) {
    return experienceYears >= 10
      ? t('providerPublicProfile.experienceRanges.10_plus')
      : t('providerPublicProfile.experienceYears', { count: Math.round(experienceYears) })
  }

  return null
}

function getLanguageLabel(
  language: string,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  const normalized = language.trim().toLowerCase()
  if (normalized === 'hebrew') return t('providerPublicProfile.languageOptions.hebrew')
  if (normalized === 'english') return t('providerPublicProfile.languageOptions.english')
  if (normalized === 'russian') return t('providerPublicProfile.languageOptions.russian')
  if (normalized === 'arabic') return t('providerPublicProfile.languageOptions.arabic')
  if (normalized === 'french') return t('providerPublicProfile.languageOptions.french')
  return null
}

export default function ProviderProfileCard({
  avatarUrl,
  fullName,
  rating,
  serviceLabel,
  priceLabel,
  experienceRange,
  experienceYears,
  languages,
  shortBio,
  completedCount,
  whatsappAvailable,
  onClose,
}: ProviderProfileCardProps) {
  const { t } = useTranslation()
  const experienceLabel = formatExperienceLabel(experienceRange, experienceYears, t)
  const languageLabels = (languages ?? [])
    .map((value) => getLanguageLabel(value, t))
    .filter((value): value is string => !!value)
  const trimmedBio = shortBio?.trim() || null
  const trustBadges = [
    rating != null ? `★ ${rating.toFixed(1)}` : null,
    completedCount != null && completedCount > 0
      ? t('providerPublicProfile.completedCount', { count: completedCount })
      : null,
    whatsappAvailable ? t('providerPublicProfile.whatsappAvailable') : null,
  ].filter((value): value is string => !!value)

  return (
    <div style={sheetCardStyle}>
      <div style={headerRowStyle}>
        <div style={heroRowStyle}>
          <ProfileAvatar
            url={avatarUrl}
            name={fullName}
            size={68}
            borderRadius={20}
          />
          <div style={heroCopyStyle}>
            <div style={nameStyle}>{fullName}</div>
            {serviceLabel ? <div style={servicePillStyle}>{serviceLabel}</div> : null}
          </div>
        </div>
        {onClose ? (
          <button type="button" onClick={onClose} style={closeButtonStyle} aria-label={t('common.close')}>
            ×
          </button>
        ) : null}
      </div>

      {trustBadges.length > 0 ? (
        <div style={badgeRowStyle}>
          {trustBadges.map((badge) => (
            <span key={badge} style={trustBadgeStyle}>
              {badge}
            </span>
          ))}
        </div>
      ) : null}

      <div style={detailsStackStyle}>
        {priceLabel ? (
          <InfoRow label={t('tracking.visitFee')} value={priceLabel} />
        ) : null}
        {serviceLabel ? (
          <InfoRow label={t('providerPublicProfile.service')} value={serviceLabel} />
        ) : null}
        {experienceLabel ? (
          <InfoRow label={t('providerPublicProfile.experience')} value={experienceLabel} />
        ) : null}
        {languageLabels.length > 0 ? (
          <div style={sectionStyle}>
            <div style={sectionLabelStyle}>{t('providerPublicProfile.languages')}</div>
            <div style={languageRowStyle}>
              {languageLabels.map((label) => (
                <span key={label} style={languageChipStyle}>
                  {label}
                </span>
              ))}
            </div>
          </div>
        ) : null}
        {trimmedBio ? (
          <div style={sectionStyle}>
            <div style={sectionLabelStyle}>{t('providerPublicProfile.about')}</div>
            <div style={bioStyle}>{trimmedBio}</div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={infoRowStyle}>
      <div style={sectionLabelStyle}>{label}</div>
      <div style={infoValueStyle}>{value}</div>
    </div>
  )
}

const sheetCardStyle: CSSProperties = {
  width: '100%',
  borderRadius: '30px 30px 0 0',
  background: 'linear-gradient(180deg, rgba(15,23,42,0.98) 0%, rgba(17,24,39,0.98) 100%)',
  border: '1px solid rgba(148, 163, 184, 0.18)',
  borderBottom: 'none',
  boxShadow: '0 -18px 48px rgba(2, 6, 23, 0.32)',
  padding: '14px 18px calc(18px + env(safe-area-inset-bottom, 0px))',
  display: 'grid',
  gap: 12,
  boxSizing: 'border-box',
}

const headerRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 12,
}

const heroRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  minWidth: 0,
}

const heroCopyStyle: CSSProperties = {
  display: 'grid',
  gap: 6,
  minWidth: 0,
}

const nameStyle: CSSProperties = {
  fontSize: 22,
  lineHeight: 1.08,
  fontWeight: 900,
  color: '#F8FAFC',
}

const servicePillStyle: CSSProperties = {
  justifySelf: 'start',
  maxWidth: '100%',
  padding: '6px 11px',
  borderRadius: 999,
  background: 'rgba(255,255,255,0.08)',
  color: '#CBD5E1',
  fontSize: 12,
  fontWeight: 800,
  lineHeight: 1.2,
}

const closeButtonStyle: CSSProperties = {
  appearance: 'none',
  border: 'none',
  background: 'rgba(255,255,255,0.08)',
  color: '#CBD5E1',
  width: 34,
  height: 34,
  borderRadius: 999,
  fontSize: 22,
  lineHeight: 1,
  cursor: 'pointer',
  flexShrink: 0,
}

const badgeRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
}

const trustBadgeStyle: CSSProperties = {
  padding: '7px 10px',
  borderRadius: 999,
  background: 'rgba(59, 130, 246, 0.14)',
  color: '#BFDBFE',
  fontSize: 12,
  fontWeight: 800,
  lineHeight: 1.2,
}

const detailsStackStyle: CSSProperties = {
  display: 'grid',
  gap: 12,
}

const infoRowStyle: CSSProperties = {
  display: 'grid',
  gap: 4,
}

const sectionStyle: CSSProperties = {
  display: 'grid',
  gap: 7,
}

const sectionLabelStyle: CSSProperties = {
  fontSize: 11.5,
  fontWeight: 800,
  color: '#94A3B8',
  textTransform: 'uppercase',
  letterSpacing: 0.2,
}

const infoValueStyle: CSSProperties = {
  fontSize: 15,
  lineHeight: 1.45,
  fontWeight: 700,
  color: '#F8FAFC',
}

const languageRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
}

const languageChipStyle: CSSProperties = {
  padding: '7px 10px',
  borderRadius: 999,
  background: 'rgba(255,255,255,0.06)',
  color: '#E2E8F0',
  fontSize: 12.5,
  fontWeight: 700,
  lineHeight: 1.2,
}

const bioStyle: CSSProperties = {
  fontSize: 14,
  lineHeight: 1.55,
  color: '#CBD5E1',
}
