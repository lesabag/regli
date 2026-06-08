import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getProfileServiceTypeLabel, type ProfileServiceType } from '../lib/profileServiceTypes'
import { getBookingPricingModelForService } from '../lib/serviceTypes'
import { supabase } from '../services/supabaseClient'

type BookingType = 'asap' | 'scheduled'
type PricingModel = 'time_based' | 'fixed_visit'
type RadiusOptionValue = 'unlimited' | '5' | '10' | '15' | '25' | 'custom'

type PreferenceRow = {
  id?: string
  provider_id: string
  service_type: ProfileServiceType
  pricing_model: PricingModel
  booking_type: BookingType
  is_enabled: boolean
  hourly_rate_min: string
  hourly_rate_preferred: string
  visit_fee_min: string
  visit_fee_preferred: string
  service_radius_km: string
  accepts_multi_item: boolean
  max_item_count: string
}

type PreferenceDbRow = {
  id: string
  provider_id: string
  service_type: ProfileServiceType
  pricing_model: PricingModel | 'visit_based' | 'hybrid'
  booking_type: BookingType
  is_enabled: boolean
  hourly_rate_min: number | null
  hourly_rate_preferred: number | null
  visit_fee_min: number | null
  visit_fee_preferred: number | null
  service_radius_km: number | null
  accepts_multi_item: boolean
  max_item_count: number | null
}

function normalizePricingModel(value: string | null | undefined): PricingModel {
  const normalized = (value ?? '').trim().toLowerCase()
  if (normalized === 'fixed_visit' || normalized === 'visit_based') return 'fixed_visit'
  return 'time_based'
}

const BOOKING_TYPES: BookingType[] = ['asap', 'scheduled']
const SERVICE_RADIUS_PRESETS = [5, 10, 15, 25] as const

function toInputValue(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? '' : String(value)
}

function createDefaultRow(providerId: string, serviceType: ProfileServiceType, bookingType: BookingType): PreferenceRow {
  const pricingModel = getBookingPricingModelForService(serviceType)
  return {
    provider_id: providerId,
    service_type: serviceType,
    pricing_model: pricingModel,
    booking_type: bookingType,
    is_enabled: true,
    hourly_rate_min: '',
    hourly_rate_preferred: '',
    visit_fee_min: '',
    visit_fee_preferred: '',
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
    pricing_model: normalizePricingModel(row.pricing_model),
    booking_type: row.booking_type,
    is_enabled: row.is_enabled,
    hourly_rate_min: toInputValue(row.hourly_rate_min),
    hourly_rate_preferred: toInputValue(row.hourly_rate_preferred),
    visit_fee_min: toInputValue(row.visit_fee_min),
    visit_fee_preferred: toInputValue(row.visit_fee_preferred),
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

function getRadiusOptionValue(value: string): RadiusOptionValue {
  const trimmed = value.trim()
  if (!trimmed) return 'unlimited'
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) return 'custom'
  const matchedPreset = SERVICE_RADIUS_PRESETS.find((preset) => preset === parsed)
  return matchedPreset ? String(matchedPreset) as RadiusOptionValue : 'custom'
}

function getRadiusDisplayValue(value: RadiusOptionValue, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (value === 'unlimited') return t('providerPricing.radiusOptions.unlimited')
  if (value === 'custom') return t('providerPricing.radiusOptions.custom')
  return t('providerPricing.radiusOptions.kmValue', { value })
}

function getRadiusHelperText(value: RadiusOptionValue, t: (key: string) => string): string {
  if (value === 'unlimited') return t('providerPricing.radiusHelper.unlimited')
  return t('providerPricing.radiusHelper.limited')
}

function buildRowsSignature(rows: PreferenceRow[]): string {
  return JSON.stringify(
    rows
      .map((row) => ({
        id: row.id ?? null,
        service_type: row.service_type,
        pricing_model: row.pricing_model,
        booking_type: row.booking_type,
        is_enabled: row.is_enabled,
        hourly_rate_min: row.hourly_rate_min.trim(),
        hourly_rate_preferred: row.hourly_rate_preferred.trim(),
        visit_fee_min: row.visit_fee_min.trim(),
        visit_fee_preferred: row.visit_fee_preferred.trim(),
        service_radius_km: row.service_radius_km.trim(),
        accepts_multi_item: row.accepts_multi_item,
        max_item_count: row.max_item_count.trim(),
      }))
      .sort((a, b) =>
        `${a.service_type}:${a.booking_type}`.localeCompare(`${b.service_type}:${b.booking_type}`),
      ),
  )
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
    () => serviceTypes,
    [serviceTypes],
  )

  const [rows, setRows] = useState<PreferenceRow[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [customRadiusKeys, setCustomRadiusKeys] = useState<string[]>([])
  const [activeServiceType, setActiveServiceType] = useState<ProfileServiceType | null>(serviceTypes[0] ?? null)
  const [activeBookingType, setActiveBookingType] = useState<BookingType>('asap')
  const [lastSavedRowsSignature, setLastSavedRowsSignature] = useState('')
  const radiusOptions = useMemo(
    () => [
      { value: 'unlimited' as const, label: t('providerPricing.radiusOptions.unlimited') },
      ...SERVICE_RADIUS_PRESETS.map((preset) => ({
        value: String(preset) as RadiusOptionValue,
        label: t('providerPricing.radiusOptions.kmValue', { value: preset }),
      })),
      { value: 'custom' as const, label: t('providerPricing.radiusOptions.custom') },
    ],
    [t],
  )

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
        .select('id, provider_id, service_type, pricing_model, booking_type, is_enabled, hourly_rate_min, hourly_rate_preferred, visit_fee_min, visit_fee_preferred, service_radius_km, accepts_multi_item, max_item_count')
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
      setLastSavedRowsSignature(buildRowsSignature(nextRows))
      setCustomRadiusKeys(
        nextRows
          .filter((row) => getRadiusOptionValue(row.service_radius_km) === 'custom')
          .map((row) => `${row.service_type}:${row.booking_type}`),
      )
      setLoading(false)
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [providerId, supportedServices])

  useEffect(() => {
    if (supportedServices.includes(activeServiceType ?? ('dog_walker' as ProfileServiceType))) return
    setActiveServiceType(supportedServices[0] ?? null)
  }, [activeServiceType, supportedServices])

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

  function getRadiusRowKey(serviceType: ProfileServiceType, bookingType: BookingType): string {
    return `${serviceType}:${bookingType}`
  }

  async function handleSave() {
    setError(null)
    setSuccess(null)

    for (const row of rows) {
      const minValue = parseOptionalNumber(
        row.pricing_model === 'fixed_visit' ? row.visit_fee_min : row.hourly_rate_min,
      )
      const preferredValue = parseOptionalNumber(
        row.pricing_model === 'fixed_visit' ? row.visit_fee_preferred : row.hourly_rate_preferred,
      )

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
      pricing_model: getBookingPricingModelForService(row.service_type),
      booking_type: row.booking_type,
      is_enabled: row.is_enabled,
      hourly_rate_min: parseOptionalNumber(row.hourly_rate_min),
      hourly_rate_preferred: parseOptionalNumber(row.hourly_rate_preferred),
      visit_fee_min: parseOptionalNumber(row.visit_fee_min),
      visit_fee_preferred: parseOptionalNumber(row.visit_fee_preferred),
      service_radius_km: parseOptionalNumber(row.service_radius_km),
      accepts_multi_item: row.pricing_model === 'fixed_visit' ? false : row.accepts_multi_item,
      max_item_count:
        row.pricing_model === 'fixed_visit'
          ? null
          : row.accepts_multi_item
            ? parseOptionalNumber(row.max_item_count)
            : null,
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
    setLastSavedRowsSignature(buildRowsSignature(rows))
    setSuccess(t('providerPricing.saved'))
  }

  const groupedRows = supportedServices.map((serviceType) => ({
    serviceType,
    rows: BOOKING_TYPES.map((bookingType) =>
      rows.find((row) => row.service_type === serviceType && row.booking_type === bookingType)
      ?? createDefaultRow(providerId, serviceType, bookingType),
    ),
  }))
  const activeServiceRows = groupedRows.find((group) => group.serviceType === activeServiceType) ?? groupedRows[0] ?? null
  const activeRow = activeServiceRows?.rows.find((row) => row.booking_type === activeBookingType) ?? activeServiceRows?.rows[0] ?? null
  const hasUnsavedChanges =
    rows.length > 0 &&
    lastSavedRowsSignature.length > 0 &&
    buildRowsSignature(rows) !== lastSavedRowsSignature

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
        <div style={editorStackStyle}>
          {supportedServices.length > 1 && (
            <div style={selectorRowStyle}>
              {groupedRows.map(({ serviceType }) => (
                <button
                  key={serviceType}
                  type="button"
                  onClick={() => setActiveServiceType(serviceType)}
                  style={{
                    ...selectorPillStyle,
                    ...(activeServiceRows?.serviceType === serviceType ? selectorPillActiveStyle : null),
                  }}
                >
                  {getProfileServiceTypeLabel(serviceType, isHebrew)}
                </button>
              ))}
            </div>
          )}

          {activeServiceRows && (
            <div style={serviceCardStyle}>
              <div style={serviceHeaderStyle}>
                <div style={serviceTitleStyle}>{getProfileServiceTypeLabel(activeServiceRows.serviceType, isHebrew)}</div>
              </div>

              <div style={selectorRowStyle}>
                {activeServiceRows.rows.map((row) => (
                  <button
                    key={`${row.service_type}:${row.booking_type}:pill`}
                    type="button"
                    onClick={() => setActiveBookingType(row.booking_type)}
                    style={{
                      ...selectorPillStyle,
                      ...(activeRow?.booking_type === row.booking_type ? selectorPillActiveStyle : null),
                    }}
                  >
                    {row.booking_type === 'asap' ? t('providerPricing.asap') : t('providerPricing.scheduled')}
                  </button>
                ))}
              </div>

              {activeRow && (() => {
                const row = activeRow
                const radiusRowKey = getRadiusRowKey(row.service_type, row.booking_type)
                const isCustomRadius = customRadiusKeys.includes(radiusRowKey)
                const radiusOptionValue = isCustomRadius ? 'custom' : getRadiusOptionValue(row.service_radius_km)

                return (
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
                        <span style={fieldLabelStyle}>
                          {row.pricing_model === 'fixed_visit'
                            ? t('providerPricing.visitFeeMin')
                            : t('providerPricing.hourlyRateMin')}
                        </span>
                        <input
                          inputMode="decimal"
                          value={row.pricing_model === 'fixed_visit' ? row.visit_fee_min : row.hourly_rate_min}
                          onChange={(event) => updateRow(
                            row.service_type,
                            row.booking_type,
                            row.pricing_model === 'fixed_visit'
                              ? { visit_fee_min: event.target.value }
                              : { hourly_rate_min: event.target.value },
                          )}
                          style={inputStyle}
                          placeholder="0"
                        />
                      </label>

                      <label style={fieldStyle}>
                        <span style={fieldLabelStyle}>
                          {row.pricing_model === 'fixed_visit'
                            ? t('providerPricing.visitFeePreferred')
                            : t('providerPricing.hourlyRatePreferred')}
                        </span>
                        <input
                          inputMode="decimal"
                          value={row.pricing_model === 'fixed_visit' ? row.visit_fee_preferred : row.hourly_rate_preferred}
                          onChange={(event) => updateRow(
                            row.service_type,
                            row.booking_type,
                            row.pricing_model === 'fixed_visit'
                              ? { visit_fee_preferred: event.target.value }
                              : { hourly_rate_preferred: event.target.value },
                          )}
                          style={inputStyle}
                          placeholder="0"
                        />
                      </label>

                      <label style={fieldStyle}>
                        <span style={fieldLabelStyle}>{t('providerPricing.serviceRadiusKm')}</span>
                        <div style={radiusFieldStackStyle}>
                          <div style={selectWrapStyle}>
                            <select
                              value={radiusOptionValue}
                              onChange={(event) => {
                                const nextValue = event.target.value as RadiusOptionValue
                                if (nextValue === 'unlimited') {
                                  setCustomRadiusKeys((current) => current.filter((key) => key !== radiusRowKey))
                                  updateRow(row.service_type, row.booking_type, { service_radius_km: '' })
                                  return
                                }
                                if (nextValue === 'custom') {
                                  setCustomRadiusKeys((current) =>
                                    current.includes(radiusRowKey) ? current : [...current, radiusRowKey],
                                  )
                                  return
                                }
                                setCustomRadiusKeys((current) => current.filter((key) => key !== radiusRowKey))
                                updateRow(row.service_type, row.booking_type, { service_radius_km: nextValue })
                              }}
                              style={selectStyle}
                            >
                              {radiusOptions.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                            <span style={selectChevronStyle}>▼</span>
                          </div>

                          {isCustomRadius ? (
                            <input
                              inputMode="decimal"
                              value={row.service_radius_km}
                              onChange={(event) => updateRow(row.service_type, row.booking_type, { service_radius_km: event.target.value })}
                              style={inputStyle}
                              placeholder={t('providerPricing.radiusOptions.customPlaceholder')}
                              aria-label={t('providerPricing.serviceRadiusKm')}
                            />
                          ) : (
                            <div style={radiusPreviewStyle}>
                              {getRadiusDisplayValue(radiusOptionValue, t)}
                            </div>
                          )}
                          <div style={radiusHelperStyle}>
                            {getRadiusHelperText(radiusOptionValue, t)}
                          </div>
                        </div>
                      </label>
                    </div>

                    {row.pricing_model !== 'fixed_visit' ? (
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
                    ) : null}
                  </div>
                )
              })()}
            </div>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => void handleSave()}
        disabled={saving || loading || !hasUnsavedChanges}
        style={{
          ...saveButtonStyle,
          ...(saving || loading || !hasUnsavedChanges ? saveButtonDisabledStyle : null),
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

const editorStackStyle: React.CSSProperties = {
  display: 'grid',
  gap: 10,
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

const serviceCardStyle: React.CSSProperties = {
  borderRadius: 18,
  border: '1px solid rgba(226, 232, 240, 0.95)',
  background: 'linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(248,250,252,0.98) 100%)',
  boxShadow: '0 10px 24px rgba(15, 23, 42, 0.06)',
  padding: 11,
  display: 'grid',
  gap: 9,
}

const selectorRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  flexWrap: 'nowrap',
  overflowX: 'auto',
  overscrollBehaviorX: 'contain',
  paddingBottom: 2,
}

const selectorPillStyle: React.CSSProperties = {
  appearance: 'none',
  border: '1px solid rgba(145, 164, 196, 0.20)',
  background: 'rgba(255,255,255,0.84)',
  color: '#475569',
  minHeight: 34,
  padding: '0 12px',
  borderRadius: 999,
  fontSize: 12.5,
  fontWeight: 800,
  whiteSpace: 'nowrap',
  cursor: 'pointer',
  flexShrink: 0,
}

const selectorPillActiveStyle: React.CSSProperties = {
  border: '1px solid rgba(91, 124, 250, 0.24)',
  background: '#EEF4FF',
  color: '#233B74',
  boxShadow: '0 10px 20px rgba(91, 124, 250, 0.10)',
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

const bookingCardStyle: React.CSSProperties = {
  borderRadius: 16,
  border: '1px solid rgba(226, 232, 240, 0.85)',
  background: 'rgba(255,255,255,0.76)',
  padding: 11,
  display: 'grid',
  gap: 9,
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
  gap: 8,
}

const fieldStyle: React.CSSProperties = {
  display: 'grid',
  gap: 6,
  minWidth: 0,
}

const radiusFieldStackStyle: React.CSSProperties = {
  display: 'grid',
  gap: 8,
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
  height: 38,
  borderRadius: 12,
  border: '1px solid rgba(203, 213, 225, 0.95)',
  background: '#FFFFFF',
  padding: '0 11px',
  fontSize: 13.5,
  color: '#0F172A',
  boxSizing: 'border-box',
  outline: 'none',
}

const selectWrapStyle: React.CSSProperties = {
  position: 'relative',
}

const selectStyle: React.CSSProperties = {
  width: '100%',
  height: 38,
  appearance: 'none',
  WebkitAppearance: 'none',
  MozAppearance: 'none',
  borderRadius: 12,
  border: '1px solid rgba(203, 213, 225, 0.95)',
  background: 'linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(248,250,252,0.98) 100%)',
  padding: '0 34px 0 11px',
  fontSize: 13.5,
  color: '#0F172A',
  boxSizing: 'border-box',
  outline: 'none',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.8)',
}

const selectChevronStyle: React.CSSProperties = {
  position: 'absolute',
  insetInlineEnd: 11,
  top: '50%',
  transform: 'translateY(-50%)',
  fontSize: 10,
  color: '#64748B',
  pointerEvents: 'none',
}

const radiusPreviewStyle: React.CSSProperties = {
  minHeight: 16,
  fontSize: 12,
  lineHeight: 1.4,
  color: '#64748B',
  paddingInline: 2,
}

const radiusHelperStyle: React.CSSProperties = {
  minHeight: 16,
  fontSize: 11,
  lineHeight: 1.35,
  color: '#94A3B8',
  paddingInline: 2,
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
  opacity: 1,
  background: '#D7DFEA',
  color: '#F8FAFC',
  boxShadow: 'none',
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
