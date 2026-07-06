import type { PayMeWebhookEvent, PayMeWebhookParseResult } from './types'

export function parsePayMeWebhookEvent(payload: unknown): PayMeWebhookParseResult {
  const normalizedPayload =
    payload && typeof payload === 'object' ? (payload as PayMeWebhookEvent) : {}

  const externalEventId =
    typeof normalizedPayload.id === 'string' && normalizedPayload.id.trim().length > 0
      ? normalizedPayload.id
      : null
  const eventType =
    typeof normalizedPayload.type === 'string' && normalizedPayload.type.trim().length > 0
      ? normalizedPayload.type
      : null

  return {
    handled: false,
    provider: 'payme',
    externalEventId,
    eventType,
    message: 'PayMe webhook routing is not implemented yet.',
  }
}
