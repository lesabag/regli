/**
 * Regli Analytics — Platform-level event tracking
 *
 * V1 event taxonomy: 20 generic, service-agnostic event names.
 * Service-specific context lives in payload fields (service_category,
 * provider_type, etc.) so events work across future verticals
 * without renaming.
 *
 * Recommended enums:
 *   service_category: dog_walking | babysitting | pet_sitting | drop_in_visit | house_help | other
 *   provider_type:    walker | babysitter | sitter | helper | other
 *   actor_role:       client | provider | admin | system
 *
 * Current transport: Supabase `analytics_events` table + console (dev).
 * Swap the transport to Mixpanel / Amplitude / Segment later by
 * changing `flush()` — call sites stay the same.
 */

import { supabase } from '../services/supabaseClient'

// ─── V1 Event taxonomy (platform-level, snake_case) ─────────────

export const AnalyticsEvent = {
  APP_OPENED:                    'app_opened',
  SERVICE_REQUEST_STARTED:       'service_request_started',
  SERVICE_REQUEST_SUBMITTED:     'service_request_submitted',
  SERVICE_REQUEST_CANCELLED:     'service_request_cancelled',
  PROVIDER_MATCHED:              'provider_matched',
  PROVIDER_ACCEPTED:             'provider_accepted',
  PROVIDER_REJECTED:             'provider_rejected',
  PROVIDER_ARRIVED:              'provider_arrived',
  SERVICE_STARTED:               'service_started',
  SERVICE_COMPLETED:             'service_completed',
  PAYMENT_AUTHORIZED:            'payment_authorized',
  PAYMENT_CAPTURED:              'payment_captured',
  PAYMENT_FAILED:                'payment_failed',
  PAYOUT_CREATED:                'payout_created',
  PAYOUT_FAILED:                 'payout_failed',
  REVIEW_SUBMITTED:              'review_submitted',
  WEBHOOK_RECEIVED:              'webhook_received',
  RECOVERY_ATTEMPT_STARTED:      'recovery_attempt_started',
  RECOVERY_ATTEMPT_SUCCEEDED:    'recovery_attempt_succeeded',
  RECOVERY_ATTEMPT_FAILED:       'recovery_attempt_failed',
} as const

export type AnalyticsEventName = (typeof AnalyticsEvent)[keyof typeof AnalyticsEvent]

// ─── Payload types ──────────────────────────────────────────────

export interface AnalyticsPayload {
  // Identity
  actor_id?: string
  actor_role?: 'client' | 'provider' | 'admin' | 'system'
  session_id?: string

  // Service context
  service_category?: string
  provider_type?: string

  // Participants
  request_id?: string
  client_id?: string
  provider_id?: string

  // Service details
  duration_minutes?: number
  price?: number
  currency?: string

  // Screen / navigation
  source_screen?: string

  // Platform
  platform?: string
  app_version?: string

  // Location
  city?: string
  zone?: string

  // State transitions
  status_before?: string
  status_after?: string

  // Error / retry
  reason_code?: string
  error_code?: string
  retry_count?: number

  // Catch-all for additional context
  [key: string]: unknown
}

// ─── Internal state ─────────────────────────────────────────────

let _userId: string | null = null
let _actorRole: 'client' | 'provider' | 'admin' | null = null
let _sessionId: string | null = null

const BUFFER: { event: string; payload: AnalyticsPayload; ts: string }[] = []
const FLUSH_INTERVAL = 5000
const FLUSH_SIZE = 10

let _flushTimer: ReturnType<typeof setInterval> | null = null

// ─── Helpers ────────────────────────────────────────────────────

/** Map profile role (e.g. 'walker') to platform-level actor_role ('provider') */
function toActorRole(profileRole: string): 'client' | 'provider' | 'admin' {
  if (profileRole === 'admin') return 'admin'
  if (profileRole === 'walker' || profileRole === 'provider') return 'provider'
  return 'client'
}

function detectPlatform(): string {
  if (typeof window === 'undefined') return 'server'
  const ua = navigator.userAgent || ''
  if (/iPhone|iPad|iPod/.test(ua) && (window as unknown as Record<string, unknown>).Capacitor) return 'ios'
  if (/Android/.test(ua) && (window as unknown as Record<string, unknown>).Capacitor) return 'android'
  return 'web'
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Identify the current user. Call once after auth resolves.
 * Accepts the raw profile role (e.g. 'walker') and maps it
 * internally to the platform-level actor_role ('provider').
 */
export function identify(userId: string, profileRole: string) {
  _userId = userId
  _actorRole = toActorRole(profileRole)
  _sessionId = crypto.randomUUID()
  console.log(`[analytics:identify] userId=${_userId}  actorRole=${_actorRole}  sessionId=${_sessionId}`)
}

/**
 * Reset identity on sign-out.
 */
export function resetIdentity() {
  flush()
  _userId = null
  _actorRole = null
  _sessionId = null
}

/**
 * Track an analytics event.
 */
export function track(event: AnalyticsEventName, payload: AnalyticsPayload = {}) {
  const enriched: AnalyticsPayload = {
    ...payload,
    actor_id: payload.actor_id ?? _userId ?? undefined,
    actor_role: payload.actor_role ?? _actorRole ?? undefined,
    session_id: payload.session_id ?? _sessionId ?? undefined,
    service_category: payload.service_category ?? 'dog_walking',
    provider_type: payload.provider_type ?? 'walker',
    platform: payload.platform ?? detectPlatform(),
    currency: payload.currency ?? 'ILS',
  }

  const entry = {
    event,
    payload: enriched,
    ts: new Date().toISOString(),
  }

  // DEBUG — always log so we can verify track() is called
  console.log(`[analytics:track] ${event}  userId=${_userId}  sessionId=${_sessionId}  bufferLen=${BUFFER.length + 1}`, enriched)

  BUFFER.push(entry)

  if (BUFFER.length >= FLUSH_SIZE) {
    flush()
  }
}

/**
 * Start the periodic flush timer. Call once at app boot.
 */
export function startFlushLoop() {
  if (_flushTimer) return
  console.log(`[analytics:startFlushLoop] interval=${FLUSH_INTERVAL}ms  flushSize=${FLUSH_SIZE}`)
  _flushTimer = setInterval(flush, FLUSH_INTERVAL)

  if (typeof window !== 'undefined') {
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush()
    })
  }
}

/**
 * Flush buffered events to the database.
 */
export async function flush() {
  if (BUFFER.length === 0) return

  const batch = BUFFER.splice(0, BUFFER.length)

  // Check auth state at flush time
  const { data: { session } } = await supabase.auth.getSession()
  const authUid = session?.user?.id ?? null

  const rows = batch.map((entry) => ({
    user_id: entry.payload.actor_id || _userId || null,
    event_name: entry.event,
    payload: entry.payload,
    created_at: entry.ts,
    session_id: _sessionId,
  }))

  // DEBUG — log exactly what we're inserting + auth state
  console.log(
    `[analytics:flush] inserting ${rows.length} rows  authUid=${authUid}  _userId=${_userId}`,
    rows.map((r) => ({ event_name: r.event_name, user_id: r.user_id, session_id: r.session_id })),
  )

  // Check for user_id / auth.uid() mismatch — this causes silent RLS rejection
  for (const row of rows) {
    if (row.user_id && authUid && row.user_id !== authUid) {
      console.error(
        `[analytics:flush] RLS MISMATCH — row.user_id=${row.user_id} but auth.uid()=${authUid}. ` +
        `This insert will be silently rejected by RLS.`,
      )
    }
    if (!authUid && row.user_id) {
      console.error(
        `[analytics:flush] NO AUTH SESSION but row.user_id=${row.user_id}. ` +
        `Insert will fail — no authenticated role, and anon policy only allows user_id IS NULL.`,
      )
    }
  }

  const { error, status, statusText } = await supabase.from('analytics_events').insert(rows)

  if (error) {
    console.error(`[analytics:flush] INSERT FAILED (${status} ${statusText}):`, error.message, error.details, error.hint)
    if (BUFFER.length < 200) {
      BUFFER.push(...batch)
    }
  } else {
    console.log(`[analytics:flush] INSERT OK (${status} ${statusText}) — ${rows.length} rows`)
  }
}
