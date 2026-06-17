import i18n from '../i18n.ts'

type DurationSummaryInput = {
  plannedMinutes?: number | null
  startedAt?: string | null
  completedAt?: string | null
  now?: number
}

export type DurationSummary = {
  elapsedSeconds: number | null
  elapsedLabel: string | null
  plannedLabel: string | null
  actualLabel: string | null
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null
  const ts = new Date(value).getTime()
  return Number.isNaN(ts) ? null : ts
}

function formatClock(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const secs = safe % 60
  return [hours, minutes, secs].map((value) => String(value).padStart(2, '0')).join(':')
}

function getUnitLabel(
  value: number,
  unit: 'hour' | 'minute' | 'second',
  isHebrew: boolean,
): string {
  if (!isHebrew) {
    if (unit === 'hour') return value === 1 ? 'hour' : 'hours'
    if (unit === 'minute') return value === 1 ? 'min' : 'min'
    return value === 1 ? 'sec' : 'sec'
  }

  if (unit === 'hour') return value === 1 ? 'שעה' : 'שעות'
  if (unit === 'minute') return value === 1 ? 'דקה' : 'דקות'
  return value === 1 ? 'שניה' : 'שניות'
}

function formatCountWithUnit(
  value: number,
  unit: 'hour' | 'minute' | 'second',
  isHebrew: boolean,
): string {
  return `${value} ${getUnitLabel(value, unit, isHebrew)}`
}

function resolveIsHebrew(locale?: string): boolean {
  return (locale ?? i18n.resolvedLanguage) === 'he'
}

function pluralizeEnglishUnit(unit: 'hour' | 'minute' | 'second', value: number): string {
  if (unit === 'hour') return value === 1 ? 'hour' : 'hours'
  if (unit === 'minute') return value === 1 ? 'minute' : 'minutes'
  return value === 1 ? 'second' : 'seconds'
}

function formatFullDurationUnit(
  value: number,
  unit: 'hour' | 'minute' | 'second',
  isHebrew: boolean,
): string {
  if (isHebrew) return formatCountWithUnit(value, unit, true)
  return `${value} ${pluralizeEnglishUnit(unit, value)}`
}

export function localizeDurationLabel(raw: string | null | undefined, locale?: string): string | null {
  const trimmed = raw?.trim()
  if (!trimmed) return null

  const isHebrew = resolveIsHebrew(locale)
  const normalized = trimmed.toLowerCase()
  const patterns: Array<{ unit: 'hour' | 'minute' | 'second'; match: RegExpMatchArray | null }> = [
    { unit: 'hour', match: normalized.match(/^(\d+(?:\.\d+)?)\s*(hour|hours|hr|hrs|h)$/i) },
    { unit: 'hour', match: normalized.match(/^(hour|hours|hr|hrs|h)\s*(\d+(?:\.\d+)?)$/i) },
    { unit: 'minute', match: normalized.match(/^(\d+(?:\.\d+)?)\s*(minute|minutes|min|mins|m)$/i) },
    { unit: 'minute', match: normalized.match(/^(minute|minutes|min|mins|m)\s*(\d+(?:\.\d+)?)$/i) },
    { unit: 'second', match: normalized.match(/^(\d+(?:\.\d+)?)\s*(second|seconds|sec|secs|s)$/i) },
    { unit: 'second', match: normalized.match(/^(second|seconds|sec|secs|s)\s*(\d+(?:\.\d+)?)$/i) },
  ]

  for (const pattern of patterns) {
    if (!pattern.match) continue
    const amountRaw = pattern.match.slice(1).find((part) => /\d/.test(part)) ?? null
    if (!amountRaw) return trimmed
    const amount = Number(amountRaw)
    if (!Number.isFinite(amount)) return trimmed
    return formatFullDurationUnit(amount, pattern.unit, isHebrew)
  }

  return trimmed
}

export function formatDurationFromMinutes(
  minutes: number | null | undefined,
  locale?: string,
): string | null {
  if (minutes == null || Number.isNaN(minutes)) return null
  const safe = Math.max(0, Math.round(minutes))
  const isHebrew = resolveIsHebrew(locale)
  if (safe <= 0) return null
  if (safe < 60) return formatCountWithUnit(safe, 'minute', isHebrew)
  if (safe % 60 === 0) return formatCountWithUnit(safe / 60, 'hour', isHebrew)
  if (safe % 30 === 0) return formatCountWithUnit(safe / 60, 'hour', isHebrew)
  return formatCountWithUnit(safe, 'minute', isHebrew)
}

export function formatElapsedDurationFromSeconds(
  seconds: number | null | undefined,
  locale?: string,
): string | null {
  if (seconds == null || Number.isNaN(seconds)) return null

  const safe = Math.max(0, Math.floor(seconds))
  const isHebrew = resolveIsHebrew(locale)

  if (safe < 60) return formatCountWithUnit(safe, 'second', isHebrew)

  const totalMinutes = Math.floor(safe / 60)
  if (totalMinutes < 60) return formatCountWithUnit(totalMinutes, 'minute', isHebrew)

  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (minutes <= 0) return formatCountWithUnit(hours, 'hour', isHebrew)
  return `${formatCountWithUnit(hours, 'hour', isHebrew)} ${formatCountWithUnit(minutes, 'minute', isHebrew)}`
}

export function getElapsedSeconds(
  startedAt: string | null | undefined,
  completedAt?: string | null | undefined,
  now: number = Date.now(),
): number | null {
  const startedTs = parseTimestamp(startedAt)
  if (startedTs == null) return null

  const completedTs = parseTimestamp(completedAt)
  const endTs = completedTs ?? now

  if (endTs < startedTs) return 0
  return Math.max(0, Math.floor((endTs - startedTs) / 1000))
}

export function getDurationSummary(input: DurationSummaryInput): DurationSummary {
  const elapsedSeconds = getElapsedSeconds(input.startedAt, input.completedAt, input.now)
  const plannedLabel = formatDurationFromMinutes(input.plannedMinutes ?? null)
  const actualLabel = formatElapsedDurationFromSeconds(elapsedSeconds)

  return {
    elapsedSeconds,
    elapsedLabel: elapsedSeconds == null ? null : formatClock(elapsedSeconds),
    plannedLabel,
    actualLabel,
  }
}
