export const FOREGROUND_PUSH_EVENT = 'regli:foreground-push'
export const PUSH_DEEP_LINK_EVENT = 'regli:push-deep-link'

export type PushNotificationType =
  | 'provider_accepted'
  | 'provider_on_the_way'
  | 'provider_arrived'
  | 'service_started'
  | 'service_completed'
  | 'payment_update'
  | 'dispute_update'
  | 'new_dispatch_offer'
  | 'dispatch_expiring_soon'
  | 'scheduled_booking_reminder'
  | 'client_confirmation'
  | 'payout_update'
  | 'new_request'
  | 'dispatch_started'
  | 'job_accepted'
  | 'walker_arrived'
  | 'job_completed'
  | 'payment_success'
  | 'payment_received'
  | 'job_accepted_self'
  | 'job_completed_self'
  | 'new_rating'

export type PushAudience = 'client' | 'provider' | 'system'

export interface PushNotificationPayload {
  type: PushNotificationType | string
  title: string
  body: string
  deepLink: string | null
  related_job_id: string | null
  created_at: string
}

export interface ParsedPushDeepLink {
  kind: 'booking' | 'dispatch' | 'wallet' | 'notifications' | 'unknown'
  id: string | null
  raw: string
}

type PushDefinition = {
  audience: PushAudience
  deepLinkKind: ParsedPushDeepLink['kind']
  dedupWindowMs: number
  suppressForegroundWhenBellActive: boolean
}

const PUSH_DEFINITIONS: Record<string, PushDefinition> = {
  provider_accepted: { audience: 'client', deepLinkKind: 'booking', dedupWindowMs: 6_000, suppressForegroundWhenBellActive: true },
  provider_on_the_way: { audience: 'client', deepLinkKind: 'booking', dedupWindowMs: 8_000, suppressForegroundWhenBellActive: true },
  provider_arrived: { audience: 'client', deepLinkKind: 'booking', dedupWindowMs: 12_000, suppressForegroundWhenBellActive: true },
  service_started: { audience: 'client', deepLinkKind: 'booking', dedupWindowMs: 8_000, suppressForegroundWhenBellActive: true },
  service_completed: { audience: 'client', deepLinkKind: 'booking', dedupWindowMs: 15_000, suppressForegroundWhenBellActive: true },
  payment_update: { audience: 'client', deepLinkKind: 'wallet', dedupWindowMs: 15_000, suppressForegroundWhenBellActive: true },
  dispute_update: { audience: 'client', deepLinkKind: 'booking', dedupWindowMs: 15_000, suppressForegroundWhenBellActive: true },
  new_dispatch_offer: { audience: 'provider', deepLinkKind: 'dispatch', dedupWindowMs: 20_000, suppressForegroundWhenBellActive: true },
  dispatch_expiring_soon: { audience: 'provider', deepLinkKind: 'dispatch', dedupWindowMs: 15_000, suppressForegroundWhenBellActive: true },
  scheduled_booking_reminder: { audience: 'provider', deepLinkKind: 'dispatch', dedupWindowMs: 60_000, suppressForegroundWhenBellActive: true },
  client_confirmation: { audience: 'provider', deepLinkKind: 'booking', dedupWindowMs: 10_000, suppressForegroundWhenBellActive: true },
  payout_update: { audience: 'provider', deepLinkKind: 'wallet', dedupWindowMs: 20_000, suppressForegroundWhenBellActive: true },
  new_request: { audience: 'provider', deepLinkKind: 'dispatch', dedupWindowMs: 20_000, suppressForegroundWhenBellActive: true },
  dispatch_started: { audience: 'provider', deepLinkKind: 'dispatch', dedupWindowMs: 20_000, suppressForegroundWhenBellActive: true },
  job_accepted: { audience: 'client', deepLinkKind: 'booking', dedupWindowMs: 6_000, suppressForegroundWhenBellActive: true },
  walker_arrived: { audience: 'client', deepLinkKind: 'booking', dedupWindowMs: 12_000, suppressForegroundWhenBellActive: true },
  job_completed: { audience: 'client', deepLinkKind: 'booking', dedupWindowMs: 15_000, suppressForegroundWhenBellActive: true },
  payment_success: { audience: 'client', deepLinkKind: 'wallet', dedupWindowMs: 15_000, suppressForegroundWhenBellActive: true },
  payment_received: { audience: 'provider', deepLinkKind: 'wallet', dedupWindowMs: 20_000, suppressForegroundWhenBellActive: true },
  job_accepted_self: { audience: 'provider', deepLinkKind: 'booking', dedupWindowMs: 8_000, suppressForegroundWhenBellActive: true },
  job_completed_self: { audience: 'provider', deepLinkKind: 'booking', dedupWindowMs: 15_000, suppressForegroundWhenBellActive: true },
  new_rating: { audience: 'system', deepLinkKind: 'notifications', dedupWindowMs: 20_000, suppressForegroundWhenBellActive: true },
}

export function getPushDefinition(type: string): PushDefinition {
  return PUSH_DEFINITIONS[type] ?? {
    audience: 'system',
    deepLinkKind: 'notifications',
    dedupWindowMs: 6_000,
    suppressForegroundWhenBellActive: false,
  }
}

export function buildPushDeepLink(type: string, relatedJobId?: string | null): string | null {
  const definition = getPushDefinition(type)
  if (!relatedJobId) {
    if (definition.deepLinkKind === 'wallet') return 'regli://wallet'
    if (definition.deepLinkKind === 'notifications') return 'regli://notifications'
    return null
  }

  if (definition.deepLinkKind === 'dispatch') {
    return `regli://dispatch/${relatedJobId}`
  }
  if (definition.deepLinkKind === 'booking') {
    return `regli://booking/${relatedJobId}`
  }
  if (definition.deepLinkKind === 'wallet') {
    return `regli://wallet/${relatedJobId}`
  }
  return `regli://notifications/${relatedJobId}`
}

export function normalizePushPayload(input: Partial<PushNotificationPayload> & {
  type?: string | null
  title?: string | null
  body?: string | null
  message?: string | null
  related_job_id?: string | null
  deepLink?: string | null
  created_at?: string | null
}): PushNotificationPayload {
  const type = input.type?.trim() || 'new_request'
  const relatedJobId = input.related_job_id ?? null
  return {
    type,
    title: input.title?.trim() || 'Notification',
    body: input.body?.trim() || input.message?.trim() || '',
    deepLink: input.deepLink?.trim() || buildPushDeepLink(type, relatedJobId),
    related_job_id: relatedJobId,
    created_at: input.created_at || new Date().toISOString(),
  }
}

export function buildPushDedupKey(payload: PushNotificationPayload): string {
  return [
    payload.type,
    payload.related_job_id ?? '',
    payload.deepLink ?? '',
    payload.title.trim().toLowerCase(),
    payload.body.trim().toLowerCase(),
  ].join('::')
}

export function getPushDedupWindowMs(type: string): number {
  return getPushDefinition(type).dedupWindowMs
}

export function shouldSuppressForegroundPush(payload: PushNotificationPayload): boolean {
  return getPushDefinition(payload.type).suppressForegroundWhenBellActive
}

export function parsePushDeepLink(urlLike: string): ParsedPushDeepLink | null {
  const value = urlLike.trim()
  if (!value.startsWith('regli://')) return null

  const stripped = value.replace('regli://', '')
  const [head, id = null] = stripped.split('/')
  if (head === 'booking') return { kind: 'booking', id, raw: value }
  if (head === 'dispatch') return { kind: 'dispatch', id, raw: value }
  if (head === 'wallet') return { kind: 'wallet', id, raw: value }
  if (head === 'notifications') return { kind: 'notifications', id, raw: value }
  return { kind: 'unknown', id, raw: value }
}

export function emitPushDeepLink(route: ParsedPushDeepLink) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(PUSH_DEEP_LINK_EVENT, { detail: route }))
}
