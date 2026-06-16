export type PushNotificationType =
  | 'provider_accepted'
  | 'provider_on_the_way'
  | 'provider_arrived'
  | 'service_started'
  | 'service_completed'
  | 'rating_reminder'
  | 'five_star_rating'
  | 'future_booking_reminder'
  | 'weekly_recurring_booking_reminder'
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
  | 'tip_received'
  | 'job_accepted_self'
  | 'job_completed_self'
  | 'new_rating'

export interface PushNotificationEnvelope {
  type: PushNotificationType | string
  title: string
  body: string
  deepLink: string | null
  related_job_id: string | null
  created_at: string
  dedup_id?: string | null
}

const PUSH_DEDUP_WINDOWS_MS: Record<string, number> = {
  new_dispatch_offer: 20_000,
  dispatch_started: 20_000,
  new_request: 20_000,
  dispatch_expiring_soon: 15_000,
  rating_reminder: 30_000,
  five_star_rating: 30_000,
  future_booking_reminder: 60_000,
  weekly_recurring_booking_reminder: 60_000,
}

export function buildPushDeepLink(type: string, relatedJobId?: string | null): string | null {
  if (!relatedJobId) return null
  if (type === 'new_dispatch_offer' || type === 'dispatch_started' || type === 'dispatch_expiring_soon' || type === 'new_request' || type === 'scheduled_booking_reminder') {
    return `regli://dispatch/${relatedJobId}`
  }
  if (
    type === 'future_booking_reminder' ||
    type === 'weekly_recurring_booking_reminder' ||
    type === 'rating_reminder' ||
    type === 'five_star_rating'
  ) {
    return `regli://booking/${relatedJobId}`
  }
  if (type === 'payment_update' || type === 'payout_update' || type === 'payment_success' || type === 'payment_received' || type === 'tip_received') {
    return 'regli://wallet'
  }
  return `regli://booking/${relatedJobId}`
}

export function buildPushEnvelope(params: {
  type?: string | null
  title: string
  body: string
  relatedJobId?: string | null
  deepLink?: string | null
  createdAt?: string | null
  dedupId?: string | null
}): PushNotificationEnvelope {
  const type = params.type?.trim() || 'new_request'
  return {
    type,
    title: params.title,
    body: params.body,
    deepLink: params.deepLink?.trim() || buildPushDeepLink(type, params.relatedJobId ?? null),
    related_job_id: params.relatedJobId ?? null,
    created_at: params.createdAt || new Date().toISOString(),
    dedup_id: params.dedupId?.trim() || null,
  }
}

export function buildPushDedupKey(envelope: PushNotificationEnvelope): string {
  if (envelope.dedup_id?.trim()) {
    return [envelope.type, envelope.dedup_id.trim()].join('::')
  }

  return [
    envelope.type,
    envelope.related_job_id ?? '',
    envelope.deepLink ?? '',
    envelope.title.trim().toLowerCase(),
    envelope.body.trim().toLowerCase(),
  ].join('::')
}

export function getPushDedupWindowMs(type: string): number {
  return PUSH_DEDUP_WINDOWS_MS[type] ?? 6000
}
