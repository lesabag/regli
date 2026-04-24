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

function formatMinutesLabel(minutes: number | null | undefined): string | null {
  if (minutes == null || Number.isNaN(minutes)) return null
  const safe = Math.max(0, Math.round(minutes))
  return `${safe} min`
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
  const plannedLabel = formatMinutesLabel(input.plannedMinutes ?? null)
  const actualLabel =
    elapsedSeconds == null ? null : formatMinutesLabel(Math.round(elapsedSeconds / 60))

  return {
    elapsedSeconds,
    elapsedLabel: elapsedSeconds == null ? null : formatClock(elapsedSeconds),
    plannedLabel,
    actualLabel,
  }
}
