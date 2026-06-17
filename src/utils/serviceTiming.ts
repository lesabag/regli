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

export function formatDurationFromMinutes(minutes: number | null | undefined): string | null {
  if (minutes == null || Number.isNaN(minutes)) return null
  const safe = Math.max(0, Math.round(minutes))
  const isHebrew = i18n.resolvedLanguage === 'he'
  if (safe <= 0) return null
  if (safe < 60) return isHebrew ? `${safe} דק׳` : `${safe} min`
  if (safe % 60 === 0) return isHebrew ? `${safe / 60} שעה` : `${safe / 60} h`
  if (safe % 30 === 0) return isHebrew ? `${safe / 60} שעה` : `${safe / 60} h`
  return isHebrew ? `${safe} דק׳` : `${safe} min`
}

export function formatElapsedDurationFromSeconds(seconds: number | null | undefined): string | null {
  if (seconds == null || Number.isNaN(seconds)) return null

  const safe = Math.max(0, Math.floor(seconds))
  const isHebrew = i18n.resolvedLanguage === 'he'

  if (safe < 60) return isHebrew ? `${safe} שניות` : `${safe} sec`

  const totalMinutes = Math.floor(safe / 60)
  if (totalMinutes < 60) return isHebrew ? `${totalMinutes} דק׳` : `${totalMinutes} min`

  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (minutes <= 0) return isHebrew ? `${hours} שעה` : `${hours} h`
  return isHebrew ? `${hours} שעה ${minutes} דק׳` : `${hours} h ${minutes} min`
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
