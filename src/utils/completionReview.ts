const COMPLETION_REVIEW_MARKER = '[SYSTEM:COMPLETION_DISPUTED]'

function normalizeNotes(notes: string | null | undefined): string {
  return typeof notes === 'string' ? notes.trim() : ''
}

function getCompletionReviewLine(reportedAt: string): string {
  return `${COMPLETION_REVIEW_MARKER} client_reported_issue reported_at=${reportedAt} review_status=todo`
}

export function isCompletionReviewRequired(notes: string | null | undefined): boolean {
  return normalizeNotes(notes)
    .split('\n')
    .some((line) => line.trim().startsWith(COMPLETION_REVIEW_MARKER))
}

export function appendCompletionReviewMarker(
  notes: string | null | undefined,
  reportedAt: string,
): string {
  const trimmed = normalizeNotes(notes)
  if (isCompletionReviewRequired(trimmed)) return trimmed

  const markerLine = getCompletionReviewLine(reportedAt)
  return trimmed ? `${trimmed}\n${markerLine}` : markerLine
}

export function removeCompletionReviewMarker(notes: string | null | undefined): string | null {
  const trimmed = normalizeNotes(notes)
  if (!trimmed) return null

  const remainingLines = trimmed
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => !line.trim().startsWith(COMPLETION_REVIEW_MARKER))

  const nextNotes = remainingLines.join('\n').trim()
  return nextNotes || null
}
