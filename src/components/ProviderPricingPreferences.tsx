import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getProfileServiceTypeLabel, type ProfileServiceType } from '../lib/profileServiceTypes'
import { supabase } from '../services/supabaseClient'

type BookingType = 'asap' | 'scheduled'

type PreferenceRow = {
  id?: string
  provider_id: string
  service_type: ProfileServiceType
  pricing_model: 'time_based'
  booking_type: BookingType
  is_enabled: boolean
  hourly_rate_min: string
  hourly_rate_preferred: string
  service_radius_km: string
  accepts_multi_item: boolean
  max_item_count: string
}

type PreferenceDbRow = {
  id: string
  provider_id: string
  service_type: ProfileServiceType
  pricing_model: 'time_based' | 'visit_based' | 'hybrid'
  booking_type: BookingType
  is_enabled: boolean
  hourly_rate_min: number | null
  hourly_rate_preferred: number | null
  service_radius_km: number | null
  accepts_multi_item: boolean
  max_item_count: number | null
}

const BOOKING_TYPES: BookingType[] = ['asap', 'scheduled']

function toInputValue(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? '' : String(value)
}

function createDefaultRow(providerId: string, serviceType: ProfileServiceType, bookingType: BookingType): PreferenceRow {
  return {
    provider_id: providerId,
    service_type: serviceType,
    pricing_model: 'time_based',
    booking_type: bookingType,
    is_enabled: true,
    hourly_rate_min: '',
    hourly_rate_preferred: '',
    service_radius_km: '',
    accepts_multi_item: false,
    max_item_count: '',
  }
}

function toFormRow(providerId: string, row: PreferenceDbRow): PreferenceRow {
  return {
    id: row.id,
    provider_id: providerId,
    service_type: row.service_type,
    pricing_model: 'time_based',
    booking_type: row.booking_type,
    is_enabled: row.is_enabled,
    hourly_rate_min: toInputValue(row.hourly_rate_min),
    hourly_rate_preferred: toInputValue(row.hourly_rate_preferred),
    service_radius_km: toInputValue(row.service_radius_km),
    accepts_multi_item: row.accepts_multi_item,
    max_item_count: toInputValue(row.max_item_count),
  }
}

function parseOptionalNumber(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

export default function ProviderPricingPreferences({
  providerId,
  serviceTypes,
}: {
  providerId: string
  serviceTypes: ProfileServiceType[]
}) {
  const { t, i18n } = useTranslation()
  const isHebrew = i18n.resolvedLanguage === 'he'
  const supportedServices = useMemo(
    () => serviceTypes.filter((value): value is ProfileServiceType => value === 'dog_walker' || value === 'baby_sitter'),
    [serviceTypes],
  )

  const [rows, setRows] = useState<PreferenceRow[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      if (!providerId || supportedServices.length === 0) {
        if (!cancelled) setRows([])
        return
      }

      setLoading(true)
      setError(null)

      const { data, error } = await supabase
        .from('provider_service_preferences')
        .select('id, provider_id, service_type, pricing_model, booking_type, is_enabled, hourly_rate_min, hourly_rate_preferred, service_radius_km, accepts_multi_item, max_item_count')
        .eq('provider_id', providerId)
        .in('service_type', supportedServices)

      if (cancelled) return

      if (error) {
        setLoading(false)
        setError(error.message)
        return
      }

      const mapped = new Map<string, PreferenceRow>()
      ;((data as PreferenceDbRow[] | null) ?? []).forEach((row) => {
        mapped.set(`${row.service_type}:${row.booking_type}`, toFormRow(providerId, row))
      })

      const nextRows = supportedServices.flatMap((serviceType) =>
        BOOKING_TYPES.map((bookingType) => mapped.get(`${serviceType}:${bookingType}`) ?? createDefaultRow(providerId, serviceType, bookingType)),
      )

      setRows(nextRows)
      setLoading(false)
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [providerId, supportedServices])

  function updateRow(serviceType: ProfileServiceType, bookingType: BookingType, patch: Partial<PreferenceRow>) {
    setRows((current) =>
      current.map((row) =>
        row.service_type === serviceType && row.booking_type === bookingType
          ? { ...row, ...patch }
          : row,
      ),
    )
    setSuccess(null)
    setError(null)
  }

  async function handleSave() {
    setError(null)
    setSuccess(null)

    for (const row of rows) {
      const minValue = parseOptionalNumber(row.hourly_rate_min)
      const preferredValue = parseOptionalNumber(row.hourly_rate_preferred)

      if (minValue != null && minValue < 0) {
        setError(t('providerPricing.validation.nonNegative'))
        return
      }

      if (preferredValue != null && preferredValue < 0) {
        setError(t('providerPricing.validation.nonNegative'))
        return
      }

      if (minValue != null && preferredValue != null && preferredValue < minValue) {
        setError(t('providerPricing.validation.preferredGteMin'))
        return
      }

      const radiusValue = parseOptionalNumber(row.service_radius_km)
      if (radiusValue != null && radiusValue < 0) {
        setError(t('providerPricing.validation.nonNegative'))
        return
      }

      if (row.accepts_multi_item) {
        const maxItemCount = parseOptionalNumber(row.max_item_count)
        if (maxItemCount != null && maxItemCount < 1) {
          setError(t('providerPricing.validation.maxItemCount'))
          return
        }
      }
    }

    setSaving(true)

    const payload = rows.map((row) => ({
      provider_id: providerId,
      service_type: row.service_type,
      pricing_model: 'time_based' as const,
      booking_type: row.booking_type,
      is_enabled: row.is_enabled,
      hourly_rate_min: parseOptionalNumber(row.hourly_rate_min),
      hourly_rate_preferred: parseOptionalNumber(row.hourly_rate_preferred),
      service_radius_km: parseOptionalNumber(row.service_radius_km),
      accepts_multi_item: row.accepts_multi_item,
      max_item_count: row.accepts_multi_item ? parseOptionalNumber(row.max_item_count) : null,
    }))

    const { error } = await supabase
      .from('provider_service_preferences')
      .upsert(payload, { onConflict: 'provider_id,service_type,booking_type' })

    if (error) {
      setSaving(false)
      setError(error.message)
      return
    }

    setSaving(false)
    setSuccess(t('providerPricing.saved'))
  }

  const groupedRows = supportedServices.map((serviceType) => ({
    serviceType,
    rows: BOOKING_TYPES.map((bookingType) =>
      rows.find((row) => row.service_type === serviceType && row.booking_type === bookingType)
      ?? createDefaultRow(providerId, serviceType, bookingType),
    ),
  }))

  if (supportedServices.length === 0) {
    return (
      <div style={emptyStyle}>
        {t('providerPricing.noSupportedServices')}
      </div>
    )
  }

  return (
    <div style={wrapStyle}>
      <div style={helperTextStyle}>{t('providerPricing.helper')}</div>

      {loading ? (
        <div style={stateTextStyle}>{t('providerPricing.loading')}</div>
      ) : (
        <div style={serviceListStyle}>
          {groupedRows.map(({ serviceType, rows: serviceRows }) => (
            <div key={serviceType} style={serviceCardStyle}>
              <div style={serviceHeaderStyle}>
                <div style={serviceTitleStyle}>{getProfileServiceTypeLabel(serviceType, isHebrew)}</div>
              </div>

              <div style={bookingGridStyle}>
                {serviceRows.map((row) => (
                  <div key={`${row.service_type}:${row.booking_type}`} style={bookingCardStyle}>
                    <div style={bookingHeaderStyle}>
                      <div style={bookingTitleStyle}>
                        {row.booking_type === 'asap' ? t('providerPricing.asap') : t('providerPricing.scheduled')}
                      </div>
                      <button
                        type="button"
                        onClick={() => updateRow(row.service_type, row.booking_type, { is_enabled: !row.is_enabled })}
                        style={{
                          ...toggleStyle,
                          ...(row.is_enabled ? toggleActiveStyle : null),
                        }}
                        aria-pressed={row.is_enabled}
                      >
                        <span
                          style={{
                            ...toggleThumbStyle,
                            ...(row.is_enabled ? toggleThumbActiveStyle : null),
                          }}
                        />
                      </button>
                    </div>

                    <div style={fieldGridStyle}>
                      <label style={fieldStyle}>
                        <span style={fieldLabelStyle}>{t('providerPricing.hourlyRateMin')}</span>
                        <input
                          inputMode="decimal"
                          value={row.hourly_rate_min}
                          onChange={(event) => updateRow(row.service_type, row.booking_type, { hourly_rate_min: event.target.value })}
                          style={inputStyle}
                          placeholder="0"
                        />
                      </label>

                      <label style={fieldStyle}>
                        <span style={fieldLabelStyle}>{t('providerPricing.hourlyRatePreferred')}</span>
                        <input
                          inputMode="decimal"
                          value={row.hourly_rate_preferred}
                          onChange={(event) => updateRow(row.service_type, row.booking_type, { hourly_rate_preferred: event.target.value })}
                          style={inputStyle}
                          placeholder="0"
                        />
                      </label>

                      <label style={fieldStyle}>
                        <span style={fieldLabelStyle}>{t('providerPricing.serviceRadiusKm')}</span>
                        <input
                          inputMode="decimal"
                          value={row.service_radius_km}
                          onChange={(event) => updateRow(row.service_type, row.booking_type, { service_radius_km: event.target.value })}
                          style={inputStyle}
                          placeholder="0"
                        />
                      </label>
                    </div>

                    <div style={multiItemRowStyle}>
                      <label style={checkboxLabelStyle}>
                        <input
                          type="checkbox"
                          checked={row.accepts_multi_item}
                          onChange={(event) => updateRow(row.service_type, row.booking_type, { accepts_multi_item: event.target.checked })}
                        />
                        <span>{t('providerPricing.acceptsMultiItem')}</span>
                      </label>

                      <label style={fieldStyleCompact}>
                        <span style={fieldLabelStyle}>{t('providerPricing.maxItemCount')}</span>
                        <input
                          inputMode="numeric"
                          value={row.max_item_count}
                          onChange={(event) => updateRow(row.service_type, row.booking_type, { max_item_count: event.target.value })}
                          style={{
                            ...inputStyle,
                            opacity: row.accepts_multi_item ? 1 : 0.6,
                          }}
                          placeholder="—"
                          disabled={!row.accepts_multi_item}
                        />
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={() => void handleSave()}
        disabled={saving || loading}
        style={{
          ...saveButtonStyle,
          ...(saving || loading ? saveButtonDisabledStyle : null),
        }}
      >
        {saving ? t('providerPricing.saving') : t('providerPricing.save')}
      </button>

      {error && <div style={errorStyle}>{error}</div>}
      {!error && success && <div style={successStyle}>{success}</div>}
    </div>
  )
}

const wrapStyle: React.CSSProperties = {
  display: 'grid',
  gap: 12,
}

const helperTextStyle: React.CSSProperties = {
  fontSize: 12,
  lineHeight: 1.45,
  color: '#64748B',
}

const stateTextStyle: React.CSSProperties = {
  fontSize: 13,
  color: '#64748B',
}

const emptyStyle: React.CSSProperties = {
  fontSize: 13,
  color: '#64748B',
  padding: '4px 0',
}

const serviceListStyle: React.CSSProperties = {
  display: 'grid',
  gap: 12,
}

const serviceCardStyle: React.CSSProperties = {
  borderRadius: 18,
  border: '1px solid rgba(226, 232, 240, 0.95)',
  background: 'linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(248,250,252,0.98) 100%)',
  boxShadow: '0 10px 24px rgba(15, 23, 42, 0.06)',
  padding: 12,
  display: 'grid',
  gap: 10,
}

const serviceHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
}

const serviceTitleStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 800,
  color: '#0F172A',
}

const bookingGridStyle: React.CSSProperties = {
  display: 'grid',
  gap: 10,
}

const bookingCardStyle: React.CSSProperties = {
  borderRadius: 16,
  border: '1px solid rgba(226, 232, 240, 0.85)',
  background: 'rgba(255,255,255,0.76)',
  padding: 12,
  display: 'grid',
  gap: 10,
}

const bookingHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
}

const bookingTitleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 800,
  color: '#334155',
}

const toggleStyle: React.CSSProperties = {
  width: 42,
  height: 24,
  borderRadius: 999,
  border: '1px solid rgba(203, 213, 225, 0.95)',
  background: 'rgba(226,232,240,0.9)',
  padding: 2,
  cursor: 'pointer',
  position: 'relative',
  transition: 'all 160ms ease',
}

const toggleActiveStyle: React.CSSProperties = {
  background: '#0F172A',
  borderColor: '#0F172A',
}

const toggleThumbStyle: React.CSSProperties = {
  width: 18,
  height: 18,
  borderRadius: 999,
  background: '#FFFFFF',
  display: 'block',
  transition: 'transform 160ms ease',
  transform: 'translateX(0)',
}

const toggleThumbActiveStyle: React.CSSProperties = {
  transform: 'translateX(18px)',
}

const fieldGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 10,
}

const fieldStyle: React.CSSProperties = {
  display: 'grid',
  gap: 6,
  minWidth: 0,
}

const fieldStyleCompact: React.CSSProperties = {
  display: 'grid',
  gap: 6,
  minWidth: 90,
}

const fieldLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: '#64748B',
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  height: 40,
  borderRadius: 12,
  border: '1px solid rgba(203, 213, 225, 0.95)',
  background: '#FFFFFF',
  padding: '0 12px',
  fontSize: 14,
  color: '#0F172A',
  boxSizing: 'border-box',
  outline: 'none',
}

const multiItemRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-end',
  justifyContent: 'space-between',
  gap: 12,
}

const checkboxLabelStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 12,
  fontWeight: 700,
  color: '#334155',
}

const saveButtonStyle: React.CSSProperties = {
  height: 46,
  borderRadius: 16,
  border: 'none',
  background: 'linear-gradient(180deg, #172554 0%, #0F172A 100%)',
  color: '#FFFFFF',
  fontSize: 14,
  fontWeight: 800,
  cursor: 'pointer',
  boxShadow: '0 14px 28px rgba(15, 23, 42, 0.14)',
}

const saveButtonDisabledStyle: React.CSSProperties = {
  opacity: 0.7,
  cursor: 'default',
}

const errorStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#B91C1C',
  fontWeight: 700,
}

const successStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#047857',
  fontWeight: 700,
}
