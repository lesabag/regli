export const BUSINESS_TIMEZONE = 'Asia/Jerusalem'

export type ProviderAvailabilityRow = {
  provider_id: string
  service_type: string | null
  day_of_week: number | null
  start_time: string | null
  end_time: string | null
  is_active: boolean | null
}

const WEEKDAY_TO_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

function normalizeServiceType(value: string | null | undefined): 'dog_walker' | 'baby_sitter' | null {
  const normalized = (value ?? '').trim().toLowerCase()
  if (!normalized) return null
  if (normalized === 'dog_walker' || normalized === 'dog-walker' || normalized === 'dog_walking') {
    return 'dog_walker'
  }
  if (normalized === 'baby_sitter' || normalized === 'baby-sitter' || normalized === 'babysitter') {
    return 'baby_sitter'
  }
  return null
}

function parseTimeToMinutes(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const [hourRaw, minuteRaw] = trimmed.split(':')
  const hour = Number(hourRaw)
  const minute = Number(minuteRaw)
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return hour * 60 + minute
}

function getBusinessLocalParts(value: string | Date): { dayOfWeek: number; minutesOfDay: number } | null {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return null

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIMEZONE,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const parts = formatter.formatToParts(date)
  const weekday = parts.find((part) => part.type === 'weekday')?.value ?? ''
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '')
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '')
  const dayOfWeek = WEEKDAY_TO_INDEX[weekday]

  if (dayOfWeek == null || !Number.isInteger(hour) || !Number.isInteger(minute)) {
    return null
  }

  return {
    dayOfWeek,
    minutesOfDay: hour * 60 + minute,
  }
}

export function groupProviderAvailabilityRows(rows: ProviderAvailabilityRow[]): Map<string, ProviderAvailabilityRow[]> {
  const grouped = new Map<string, ProviderAvailabilityRow[]>()
  for (const row of rows) {
    const current = grouped.get(row.provider_id) ?? []
    current.push(row)
    grouped.set(row.provider_id, current)
  }
  return grouped
}

export function isProviderAvailableAt(
  rows: ProviderAvailabilityRow[],
  serviceType: string | null | undefined,
  at: string | Date,
): boolean {
  const localParts = getBusinessLocalParts(at)
  if (!localParts) return false

  const normalizedServiceType = normalizeServiceType(serviceType)
  const relevantRows = rows.filter((row) => {
    if (row.is_active === false) return false
    if (normalizedServiceType == null) return true
    return normalizeServiceType(row.service_type) === normalizedServiceType
  })

  // Safe default for v1: providers without configured hours are unavailable until they set them.
  if (relevantRows.length === 0) return false

  return relevantRows.some((row) => {
    if (row.day_of_week == null || row.start_time == null || row.end_time == null) return false
    if (row.day_of_week !== localParts.dayOfWeek) return false

    const startMinutes = parseTimeToMinutes(row.start_time)
    const endMinutes = parseTimeToMinutes(row.end_time)
    if (startMinutes == null || endMinutes == null || endMinutes <= startMinutes) return false

    return localParts.minutesOfDay >= startMinutes && localParts.minutesOfDay < endMinutes
  })
}
