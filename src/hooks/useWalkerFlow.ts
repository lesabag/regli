import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { supabase, invokeEdgeFunction } from '../services/supabaseClient'
import { createNotification } from '../components/NotificationsBell'
import { useWalkerTracking } from './useWalkerTracking'
import { track, AnalyticsEvent } from '../lib/analytics'
import { getServiceLabels, getServicePhase, type ServicePhase } from '../utils/serviceLifecycle'
import {
  isCompletionReviewRequired,
  appendProviderIssueMarker,
  hasProviderIssue,
} from '../utils/completionReview'
import { getProviderEarnings } from '../lib/payoutTruth'

interface CapacitorAppState {
  isActive: boolean
}

interface CapacitorAppPlugin {
  addListener(
    eventName: 'appStateChange',
    listenerFunc: (state: CapacitorAppState) => void,
  ): Promise<PluginListenerHandle>
}

const NativeApp = registerPlugin<CapacitorAppPlugin>('App')

export type WalkerScreenState =
  | 'offline'
  | 'waiting'
  | 'incoming_request'
  | 'on_the_way'
  | 'active'
  | 'completed'

export type WalkerScreenPhase =
  | 'offline'
  | 'waiting'
  | 'incoming_request'
  | 'on_the_way'
  | 'arrived_pending_confirmation'
  | 'arrival_confirmed'
  | 'in_progress'
  | 'completed'

interface WalkRequestRow {
  id: string
  client_id: string
  walker_id: string | null
  selected_walker_id: string | null
  status: 'open' | 'accepted' | 'completed' | 'cancelled'
  service_type?: string | null
  dog_name: string | null
  dog_count?: number | null
  location: string | null
  address: string | null
  notes: string | null
  created_at: string | null
  price: number | null
  duration_minutes?: number | null
  platform_fee: number | null
  walker_earnings: number | null
  payment_status: 'unpaid' | 'authorized' | 'paid' | 'failed' | 'refunded'
  paid_at: string | null
  stripe_payment_intent_id: string | null
  provider_arrived_at?: string | null
  client_arrival_confirmed_at?: string | null
  service_started_at?: string | null
  service_completed_at?: string | null
  booking_timing?: 'asap' | 'scheduled'
  scheduled_for?: string | null
  tip_amount?: number | null
  dispatch_state?: 'queued' | 'dispatched' | 'expired' | 'cancelled' | null
  smart_dispatch_state?:
    | 'idle'
    | 'dispatching'
    | 'assigned'
    | 'exhausted'
    | 'cancelled'
    | null
  client?: { id: string; full_name: string | null; email: string | null; avatar_url?: string | null } | null
}

interface DispatchOfferRow {
  id: string
  request_id: string
  walker_id: string
  rank: number
  score: number
  status: 'pending' | 'accepted' | 'expired' | 'rejected' | 'skipped' | 'cancelled'
  offered_at: string
  expires_at: string
  attempt_no: number
  request_status: string
  dispatch_state: string
  client_id: string | null
  selected_walker_id: string | null
  dog_name: string | null
  dog_count?: number | null
  location: string | null
  address: string | null
  notes: string | null
  request_created_at: string | null
  price: number | null
  duration_minutes?: number | null
  platform_fee: number | null
  walker_earnings: number | null
  payment_status: 'unpaid' | 'authorized' | 'paid' | 'failed' | 'refunded'
  paid_at: string | null
  stripe_payment_intent_id: string | null
  service_type?: string | null
  provider_arrived_at?: string | null
  client_arrival_confirmed_at?: string | null
  service_started_at?: string | null
  service_completed_at?: string | null
  booking_timing?: 'asap' | 'scheduled'
  scheduled_for?: string | null
  smart_dispatch_state?:
    | 'idle'
    | 'dispatching'
    | 'assigned'
    | 'exhausted'
    | 'cancelled'
    | null
  client_full_name: string | null
  client_email: string | null
  client_avatar_url?: string | null
}

interface DispatchCandidateRow {
  request_id: string
  walker_id: string
  rank: number
  score: number
}

interface DispatchAttemptRow {
  id: string
  request_id: string
  attempt_no: number
  status: 'pending' | 'accepted' | 'expired' | 'rejected' | 'skipped' | 'cancelled'
  expires_at: string
  created_at: string
  accepted_by_walker_id: string | null
}

interface RatingRow {
  id: string
  job_id: string
  from_user_id: string
  to_user_id: string
  rating: number
  review: string | null
  created_at: string
}

interface TipRow {
  id: string
  walk_request_id: string
  walker_id: string
  amount: number
  created_at: string
}

interface ConnectStatus {
  connected: boolean
  stripe_connect_account_id: string | null
  stripe_connect_onboarding_complete: boolean
  payouts_enabled: boolean
  charges_enabled: boolean
}

function isStripeReadyForOnline(status: ConnectStatus | null | undefined): boolean {
  return !!(
    status?.connected &&
    status.stripe_connect_onboarding_complete &&
    status.payouts_enabled &&
    status.charges_enabled
  )
}

async function prepareEdgeFunctionAuth(): Promise<boolean> {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  return !!session?.access_token
}

function isDispatchedScheduledJob(job: {
  booking_timing?: 'asap' | 'scheduled'
  dispatch_state?: 'queued' | 'dispatched' | 'expired' | 'cancelled' | null
}): boolean {
  if (job.booking_timing !== 'scheduled') return true
  return job.dispatch_state === 'dispatched'
}

function isFutureJob(job: {
  booking_timing?: 'asap' | 'scheduled'
  scheduled_for?: string | null
  dispatch_state?: 'queued' | 'dispatched' | 'expired' | 'cancelled' | null
  status: string
}): boolean {
  if (job.booking_timing !== 'scheduled') return false
  if (job.status === 'completed' || job.status === 'cancelled') return false
  return job.dispatch_state !== 'dispatched'
}

function startsInMinutes(value: string | null | undefined): number | null {
  if (!value) return null
  const ts = new Date(value).getTime()
  if (Number.isNaN(ts)) return null
  return Math.max(0, Math.ceil((ts - Date.now()) / 60000))
}

const AUTO_DISPATCH_LEAD_MINUTES = 15
const AUTO_DISPATCH_POLL_MS = 20_000
const COMPLETION_PROMPT_RECENT_MS = 30 * 60 * 1000
const IDLE_WALKER_POLL_MS = 20_000
const ACTIVE_WALKER_POLL_MS = 4_000
const IDLE_LOCATION_BROADCAST_MS = 15_000
const ACTIVE_LOCATION_BROADCAST_MS = 5_000
const CONNECT_STATUS_RETRY_DELAY_MS = 1_000
const CONNECT_STATUS_MAX_ATTEMPTS = 3
const REALTIME_SUBSCRIBED_HYDRATION_THROTTLE_MS = 4_000

function logDispatchRealtime(message: string, details?: Record<string, unknown>) {
  if (!import.meta.env.DEV) return
  console.log('[useWalkerFlow][dispatch-realtime]', message, details ?? {})
}

function logRecovery(
  tag: '[Recovery]' | '[RealtimeReconnect]' | '[Hydration]' | '[ForegroundResume]',
  message: string,
  details?: Record<string, unknown>,
) {
  console.log(tag, message, details ?? {})
}

declare global {
  interface Window {
    __regliRefreshWalkerOffers?: (() => void) | undefined
  }
}

function completionDismissStorageKey(profileId: string): string {
  return `regli_walker_completion_dismissed_${profileId}`
}

function completionReviewDismissStorageKey(profileId: string): string {
  return `regli_walker_completion_review_dismissed_${profileId}`
}

function sendClientLiveOrderEvent(params: {
  clientId: string | null | undefined
  jobId: string
  type: 'accepted' | 'arrived' | 'start_walk' | 'complete' | 'completion_pending'
  message: string
  walkerId?: string | null
  walkerName?: string | null
}) {
  if (!params.clientId) return

  const channel = supabase.channel(`client-flow-${params.clientId}`)
  const timeout = window.setTimeout(() => {
    void supabase.removeChannel(channel)
  }, 3000)

  channel.subscribe((status) => {
    if (status !== 'SUBSCRIBED') return

    void channel
      .send({
        type: 'broadcast',
        event: 'live_order_event',
        payload: {
          jobId: params.jobId,
          type: params.type,
          message: params.message,
          walkerId: params.walkerId,
          walkerName: params.walkerName,
        },
      })
      .finally(() => {
        window.clearTimeout(timeout)
        void supabase.removeChannel(channel)
      })
  })
}

function getJobEventTime(job: Pick<WalkRequestRow, 'paid_at' | 'created_at'>): number {
  const value = job.paid_at ?? job.created_at ?? null
  if (!value) return 0
  const ts = new Date(value).getTime()
  return Number.isNaN(ts) ? 0 : ts
}

function getWalkerJobPhase(job: WalkRequestRow): Exclude<ServicePhase, 'idle' | 'searching'> {
  const phase = getServicePhase(job)
  if (phase === 'idle' || phase === 'searching') return 'on_the_way'
  return phase
}

function isRecentCompletion(job: Pick<WalkRequestRow, 'paid_at' | 'created_at'>): boolean {
  const ts = getJobEventTime(job)
  if (!ts) return false
  return Date.now() - ts <= COMPLETION_PROMPT_RECENT_MS
}

function isCompletionReviewJob(job: Pick<WalkRequestRow, 'status' | 'notes'> | null | undefined): boolean {
  return !!job && job.status === 'accepted' && isCompletionReviewRequired(job.notes)
}

function getCompletionPromptJob(
  completedJobs: WalkRequestRow[],
  ratedJobIds: Set<string>,
  dismissedJobIds: Set<string>,
  flowCompletedJobIds: Set<string>,
): WalkRequestRow | null {
  return (
    completedJobs
      .filter(
        (job) =>
          job.status === 'completed' &&
          !!job.client_id &&
          (isRecentCompletion(job) || flowCompletedJobIds.has(job.id)) &&
          !ratedJobIds.has(job.id) &&
          !dismissedJobIds.has(job.id),
      )
      .sort((a, b) => getJobEventTime(b) - getJobEventTime(a))[0] ?? null
  )
}

function shouldAutoDispatch(job: {
  booking_timing?: 'asap' | 'scheduled'
  status?: string
  walker_id?: string | null
  scheduled_for?: string | null
  dispatch_state?: 'queued' | 'dispatched' | 'expired' | 'cancelled' | null
}): boolean {
  if (job.booking_timing !== 'scheduled') return false
  if (job.status !== 'accepted') return false
  if (!job.walker_id) return false
  if (job.dispatch_state === 'dispatched') return false
  if (!job.scheduled_for) return false
  const startTs = new Date(job.scheduled_for).getTime()
  if (Number.isNaN(startTs)) return false
  return startTs - Date.now() <= AUTO_DISPATCH_LEAD_MINUTES * 60 * 1000
}

export function useWalkerFlow(profileId: string, profileName: string) {
  useEffect(() => {
    console.log('[useWalkerFlow] mounted', {
      profileId,
      profileName,
    })
  }, [profileId, profileName])

  const [openJobs, setOpenJobs] = useState<WalkRequestRow[]>([])
  const [myJobs, setMyJobs] = useState<WalkRequestRow[]>([])
  const [activeOffers, setActiveOffers] = useState<DispatchOfferRow[]>([])
  const retainedIncomingOfferRef = useRef<DispatchOfferRow | null>(null)

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  const [declinedIds, setDeclinedIds] = useState<Set<string>>(new Set())

  const [ratingsReceived, setRatingsReceived] = useState<RatingRow[]>([])
  const [ratingsGiven, setRatingsGiven] = useState<RatingRow[]>([])
  const [ratingJobId, setRatingJobId] = useState<string | null>(null)
  const [ratingSubmitting, setRatingSubmitting] = useState(false)

  const [walletData, setWalletData] = useState<{
    available_balance: number
    pending_balance: number
    total_earned: number
  } | null>(null)
  const [balanceAdjustments, setBalanceAdjustments] = useState<
    {
      id: string
      job_id: string | null
      type: string
      amount: number
      description: string | null
      created_at: string
    }[]
  >([])

  const [connectStatus, setConnectStatus] = useState<ConnectStatus | null>(null)
  const [connectLoading, setConnectLoading] = useState(true)
  const [connectError, setConnectError] = useState<string | null>(null)
  const connectStatusRequestRef = useRef<Promise<ConnectStatus | null> | null>(null)

  const [completingJobId, setCompletingJobId] = useState<string | null>(null)
  const [pendingClientConfirmation, setPendingClientConfirmation] = useState<string | null>(null)
  const [completionSuccess, setCompletionSuccess] = useState<{
    jobId: string
    clientId: string
    dogName: string
    earnings: number | null
    clientName: string
  } | null>(null)
  const [completionBlockedJob] = useState<WalkRequestRow | null>(null)
  const [completionPaymentError] = useState<{
    jobId: string
    message: string
  } | null>(null)

  const [completionRatingSubmitting, setCompletionRatingSubmitting] = useState(false)
  const [dismissedReviewRequiredIds, setDismissedReviewRequiredIds] = useState<Set<string>>(new Set())

  const [isOnline, setIsOnline] = useState(false)
  const [onlineLoading, setOnlineLoading] = useState(true)

  const [takenNotice, setTakenNotice] = useState(false)
  const prevOfferIdsRef = useRef<Set<string>>(new Set())
  const prevFutureIdsRef = useRef<Set<string>>(new Set())
  const transitionInitRef = useRef(false)
  const autoDispatchInFlightRef = useRef<Set<string>>(new Set())
  const dismissedCompletionIdsRef = useRef<Set<string>>(new Set())
  const flowCompletedJobIdsRef = useRef<Set<string>>(new Set())
  const shownStateMessagesRef = useRef<Set<string>>(new Set())
  const lastAcceptedJobIdRef = useRef<string | null>(null)
  const candidateRequestIdsRef = useRef<Set<string>>(new Set())
  const assignedJobIdsRef = useRef<Set<string>>(new Set())
  const currentWalkerIdRef = useRef<string | null>(profileId || null)
  const fetchAllInFlightRef = useRef<Promise<void> | null>(null)
  const hydrationRunIdRef = useRef(0)
  const realtimeHydrationAtRef = useRef<Map<string, number>>(new Map())
  const firstName = (profileName || '').split(' ')[0] || profileName
  const [isDocumentVisible, setIsDocumentVisible] = useState(() =>
    typeof document === 'undefined' ? true : !document.hidden,
  )

  const hasActiveWalkerWork =
    activeOffers.length > 0 ||
    myJobs.some((job) => job.status === 'accepted' && !isFutureJob(job))

  const showStateMessage = useCallback((jobId: string, event: string, message: string) => {
    const key = `${event}:${jobId}`
    if (shownStateMessagesRef.current.has(key)) return
    shownStateMessagesRef.current.add(key)
    setSuccessMessage(message)
  }, [])

  const clearRetainedIncomingOffer = useCallback((requestId?: string | null) => {
    if (!requestId) {
      retainedIncomingOfferRef.current = null
      return
    }
    if (retainedIncomingOfferRef.current?.request_id === requestId) {
      retainedIncomingOfferRef.current = null
    }
  }, [])

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(completionDismissStorageKey(profileId))
      const parsed = raw ? (JSON.parse(raw) as string[]) : []
      dismissedCompletionIdsRef.current = new Set(Array.isArray(parsed) ? parsed : [])
    } catch {
      dismissedCompletionIdsRef.current = new Set()
    }
  }, [profileId])

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(completionReviewDismissStorageKey(profileId))
      const parsed = raw ? (JSON.parse(raw) as string[]) : []
      setDismissedReviewRequiredIds(new Set(Array.isArray(parsed) ? parsed : []))
    } catch {
      setDismissedReviewRequiredIds(new Set())
    }
  }, [profileId])

  const persistDismissedReviewRequiredIds = useCallback(
    (nextIds: Set<string>) => {
      setDismissedReviewRequiredIds(nextIds)
      try {
        window.localStorage.setItem(
          completionReviewDismissStorageKey(profileId),
          JSON.stringify(Array.from(nextIds)),
        )
      } catch {
        // noop
      }
    },
    [profileId],
  )

  useEffect(() => {
    if (typeof document === 'undefined') return

    const handleVisibilityChange = () => {
      const nextVisible = !document.hidden
      setIsDocumentVisible(nextVisible)
      logRecovery('[ForegroundResume]', 'provider document visibility changed', {
        profileId,
        isVisible: nextVisible,
      })
      if (nextVisible) {
        void fetchAllRef.current('document_visible')
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [profileId])

  const avgRating = useMemo(() => {
    if (ratingsReceived.length === 0) return null
    const sum = ratingsReceived.reduce((acc, r) => acc + r.rating, 0)
    return Math.round((sum / ratingsReceived.length) * 10) / 10
  }, [ratingsReceived])

  const ratedJobIds = useMemo(() => {
    const set = new Set<string>()
    ratingsGiven.forEach((r) => set.add(r.job_id))
    return set
  }, [ratingsGiven])

  const visibleMyJobs = useMemo(() => {
    if (!completionBlockedJob) return myJobs
    const withoutBlocked = myJobs.filter((job) => job.id !== completionBlockedJob.id)
    return [completionBlockedJob, ...withoutBlocked]
  }, [myJobs, completionBlockedJob])

  const futureJobs = useMemo(() => visibleMyJobs.filter((j) => isFutureJob(j)), [visibleMyJobs])

  const reviewRequiredJobs = useMemo(
    () =>
      visibleMyJobs.filter(
        (j) => j.status === 'accepted' && isDispatchedScheduledJob(j) && !isFutureJob(j) && isCompletionReviewJob(j),
      ),
    [visibleMyJobs],
  )

  const onTheWayJobs = useMemo(
    () =>
      visibleMyJobs.filter(
        (j) =>
          j.status === 'accepted' &&
          isDispatchedScheduledJob(j) &&
          !isFutureJob(j) &&
          !isCompletionReviewJob(j) &&
          !j.service_started_at,
      ),
    [visibleMyJobs],
  )

  const activeJobs = useMemo(
    () =>
      visibleMyJobs.filter(
        (j) =>
          j.status === 'accepted' &&
          isDispatchedScheduledJob(j) &&
          !isFutureJob(j) &&
          !isCompletionReviewJob(j) &&
          !!j.service_started_at,
      ),
    [visibleMyJobs],
  )

  const reviewRequiredJob = useMemo(
    () => reviewRequiredJobs.find((job) => !dismissedReviewRequiredIds.has(job.id)) ?? null,
    [reviewRequiredJobs, dismissedReviewRequiredIds],
  )

  useEffect(() => {
    const current = activeJobs[0] ?? onTheWayJobs[0] ?? null
    if (current) lastAcceptedJobIdRef.current = current.id
  }, [activeJobs, onTheWayJobs])

  const completedJobs = useMemo(
    () => myJobs.filter((j) => j.status === 'completed' || j.status === 'cancelled'),
    [myJobs],
  )

  useEffect(() => {
    const completedLastAccepted = completedJobs.find(
      (job) => job.status === 'completed' && job.id === lastAcceptedJobIdRef.current,
    )
    if (completedLastAccepted) {
      flowCompletedJobIdsRef.current.add(completedLastAccepted.id)
    }
  }, [completedJobs])

  const activeJobIds = useMemo(
    () => [...onTheWayJobs, ...activeJobs].map((j) => j.id),
    [activeJobs, onTheWayJobs],
  )
  useWalkerTracking(activeJobIds)

  const [walkerPosition, setWalkerPosition] = useState<[number, number] | null>(null)
  const walkerGeoInitRef = useRef(false)

  useEffect(() => {
    if (!navigator.geolocation) return

    const onPos = (pos: GeolocationPosition) => {
      setWalkerPosition([pos.coords.latitude, pos.coords.longitude])
    }
    const onErr = (err: GeolocationPositionError) => {
      console.warn('[useWalkerFlow] geolocation error:', err.code, err.message)
    }

    if (!walkerGeoInitRef.current) {
      walkerGeoInitRef.current = true
      navigator.geolocation.getCurrentPosition(onPos, onErr, {
        enableHighAccuracy: false,
        maximumAge: 60000,
        timeout: 5000,
      })
    }

    const watchId = navigator.geolocation.watchPosition(onPos, onErr, {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 10000,
    })
    return () => navigator.geolocation.clearWatch(watchId)
  }, [])

  const walkerPosRef = useRef(walkerPosition)
  walkerPosRef.current = walkerPosition

  useEffect(() => {
    if (!isOnline) {
      void supabase.from('profiles').update({ last_lat: null, last_lng: null }).eq('id', profileId)
      return
    }

    if (!isDocumentVisible) return

    const broadcast = () => {
      const pos = walkerPosRef.current
      if (!pos) return
      void supabase
        .from('profiles')
        .update({ last_lat: pos[0], last_lng: pos[1] })
        .eq('id', profileId)
        .then(({ error }) => {
          if (error) console.error('[useWalkerFlow] broadcast error:', error.message)
        })
    }

    broadcast()
    const id = setInterval(
      broadcast,
      hasActiveWalkerWork ? ACTIVE_LOCATION_BROADCAST_MS : IDLE_LOCATION_BROADCAST_MS,
    )
    return () => clearInterval(id)
  }, [hasActiveWalkerWork, isDocumentVisible, isOnline, profileId])

  const autoDispatchScheduledJob = useCallback(
    async (job: WalkRequestRow) => {
      if (!shouldAutoDispatch(job)) return false
      if (autoDispatchInFlightRef.current.has(job.id)) return false

      autoDispatchInFlightRef.current.add(job.id)
      try {
        const { data, error } = await supabase
          .from('walk_requests')
          .update({
            dispatch_state: 'dispatched',
            ...(walkerPosition
              ? {
                  walker_lat: walkerPosition[0],
                  walker_lng: walkerPosition[1],
                  last_location_update: new Date().toISOString(),
                }
              : {}),
          })
          .eq('id', job.id)
          .eq('walker_id', profileId)
          .eq('status', 'accepted')
          .eq('booking_timing', 'scheduled')
          .eq('dispatch_state', 'queued')
          .select('id, client_id, walker_id, dog_name')
          .maybeSingle()

        if (error) {
          console.error('[useWalkerFlow] auto dispatch failed:', error.message)
          return false
        }
        if (!data) return false

        const dogLabel = data.dog_name || 'the walk'

        showStateMessage(job.id, 'accepted', 'Head to the client')
        track(AnalyticsEvent.SERVICE_STARTED, {
          request_id: job.id,
          provider_id: profileId,
          client_id: data.client_id ?? undefined,
          source_screen: 'walker_dashboard',
        })

        await createNotification({
          userId: profileId,
          type: 'dispatch_started',
          title: 'Head to the client',
          message: `Head to ${dogLabel}'s pickup. Start the walk when you're ready.`,
          relatedJobId: job.id,
        })

        if (data.client_id) {
          invokeEdgeFunction('send-push-notification', {
            body: {
              title: 'Walker on the way',
              body: `${profileName} is heading to you for ${dogLabel}.`,
              targetUserId: data.client_id,
              data: { jobId: job.id },
            },
          }).catch((err) => console.error('[Push] Failed to notify client (dispatch):', err))
          void createNotification({
            userId: data.client_id,
            type: 'job_accepted',
            title: 'Walker on the way',
            message: `${profileName} is heading to you for ${dogLabel}.`,
            relatedJobId: job.id,
          })
        }

        invokeEdgeFunction('send-push-notification', {
          body: {
              title: 'Head to the client',
              body: `Head to ${dogLabel}'s pickup.`,
            targetUserId: profileId,
            data: { jobId: job.id },
          },
        }).catch((err) => console.error('[Push] Failed to notify walker (dispatch):', err))

        return true
      } finally {
        autoDispatchInFlightRef.current.delete(job.id)
      }
    },
    [profileId, profileName, walkerPosition, showStateMessage],
  )

  useEffect(() => {
    if (!isOnline) return

    const candidate = myJobs.find((j) => shouldAutoDispatch(j))
    if (!candidate) return

    void autoDispatchScheduledJob(candidate)
    const timer = setInterval(() => {
      const nextCandidate = myJobs.find((j) => shouldAutoDispatch(j))
      if (nextCandidate) void autoDispatchScheduledJob(nextCandidate)
    }, AUTO_DISPATCH_POLL_MS)

    return () => clearInterval(timer)
  }, [isOnline, myJobs, autoDispatchScheduledJob])

  useEffect(() => {
    if (!walkerPosition || onTheWayJobs.length === 0) return

    let cancelled = false

    const pushActiveJobLocation = async () => {
      if (cancelled) return
      const pos = walkerPosRef.current
      if (!pos) return

      const activeTrackingIds = onTheWayJobs
        .filter((j) => isDispatchedScheduledJob(j))
        .map((j) => j.id)

      if (activeTrackingIds.length === 0) return

      const { error } = await supabase
        .from('walk_requests')
        .update({
          walker_lat: pos[0],
          walker_lng: pos[1],
          last_location_update: new Date().toISOString(),
        })
        .in('id', activeTrackingIds)
        .eq('walker_id', profileId)
        .eq('status', 'accepted')

      if (error) {
        console.error('[useWalkerFlow] active tracking update error:', error.message)
      }
    }

    void pushActiveJobLocation()
    const id = setInterval(() => {
      void pushActiveJobLocation()
    }, 5_000)

    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [onTheWayJobs, profileId, walkerPosition])

  const pendingFromJobs = useMemo(() => {
    return myJobs
      .filter((j) => j.status === 'accepted' && j.payment_status === 'authorized')
      .reduce((sum, j) => sum + getProviderEarnings(j), 0)
  }, [myJobs])

  const totalAdjustments = useMemo(() => {
    return balanceAdjustments.reduce((sum, adj) => sum + adj.amount, 0)
  }, [balanceAdjustments])

  const wallet = useMemo(() => {
    const dbAvailable = walletData?.available_balance ?? 0
    const dbPending = walletData?.pending_balance ?? 0
    const pending = dbPending + pendingFromJobs
    const adjustedAvailable = Math.max(0, dbAvailable + totalAdjustments)

    return {
      availableBalance: Math.round(adjustedAvailable * 100) / 100,
      pendingEarnings: Math.round(pending * 100) / 100,
    }
  }, [walletData, pendingFromJobs, totalAdjustments])

  const visibleOpenJobs = useMemo(
    () => openJobs.filter((j) => !declinedIds.has(j.id)),
    [openJobs, declinedIds],
  )

  const screenState: WalkerScreenState = useMemo(() => {
    if (completionSuccess) return 'completed'
    if (activeJobs.length > 0) return 'active'
    if (onTheWayJobs.length > 0) return 'on_the_way'
    if (isOnline && visibleOpenJobs.length > 0) return 'incoming_request'
    if (isOnline) return 'waiting'
    return 'offline'
  }, [completionSuccess, activeJobs, onTheWayJobs, isOnline, visibleOpenJobs])

  const screenPhase: WalkerScreenPhase = useMemo(() => {
    if (completionSuccess) return 'completed'
    if (activeJobs.length > 0) return 'in_progress'
    const currentOnTheWayJob = onTheWayJobs[0] ?? null
    if (currentOnTheWayJob) {
      const phase = getWalkerJobPhase(currentOnTheWayJob)
      if (phase === 'arrival_confirmed') return 'arrival_confirmed'
      if (phase === 'arrived_pending_confirmation') return 'arrived_pending_confirmation'
      return 'on_the_way'
    }
    if (isOnline && visibleOpenJobs.length > 0) return 'incoming_request'
    if (isOnline) return 'waiting'
    return 'offline'
  }, [completionSuccess, activeJobs, onTheWayJobs, isOnline, visibleOpenJobs])

  useEffect(() => {
    const pendingCompletion = getCompletionPromptJob(
      completedJobs,
      ratedJobIds,
      dismissedCompletionIdsRef.current,
      flowCompletedJobIdsRef.current,
    )

    if (!pendingCompletion) {
      setCompletionSuccess((prev) => {
        if (
          prev &&
          flowCompletedJobIdsRef.current.has(prev.jobId) &&
          !ratedJobIds.has(prev.jobId) &&
          !dismissedCompletionIdsRef.current.has(prev.jobId)
        ) {
          return prev
        }
        return null
      })
      return
    }

    setCompletionSuccess((prev) => {
      const next = {
        jobId: pendingCompletion.id,
        clientId: pendingCompletion.client_id,
        dogName: pendingCompletion.dog_name || 'the dog',
        earnings: pendingCompletion.walker_earnings,
        clientName: pendingCompletion.client?.full_name || pendingCompletion.client?.email || 'Client',
      }

      if (
        prev?.jobId === next.jobId &&
        prev.clientId === next.clientId &&
        prev.dogName === next.dogName &&
        prev.earnings === next.earnings &&
        prev.clientName === next.clientName
      ) {
        return prev
      }

      return next
    })
  }, [completedJobs, ratedJobIds])

  useEffect(() => {
    if (!pendingClientConfirmation) return
    const confirmed = completedJobs.find((j) => j.id === pendingClientConfirmation)
    if (!confirmed) {
      const stillActive = myJobs.find((j) => j.id === pendingClientConfirmation && j.status === 'accepted')
      if (stillActive && (!stillActive.service_completed_at || isCompletionReviewJob(stillActive))) {
        setPendingClientConfirmation(null)
      }
      return
    }
    setPendingClientConfirmation(null)
    flowCompletedJobIdsRef.current.add(confirmed.id)
    const labels = getServiceLabels(confirmed.service_type)
    showStateMessage(confirmed.id, 'completed', labels.completedPast)
    setCompletionSuccess({
      jobId: confirmed.id,
      clientId: confirmed.client_id,
      dogName: confirmed.dog_name || 'the dog',
      earnings: confirmed.walker_earnings,
      clientName: confirmed.client?.full_name || confirmed.client?.email || 'Client',
    })
  }, [pendingClientConfirmation, completedJobs, myJobs, showStateMessage])

  useEffect(() => {
    if (pendingClientConfirmation) return
    const pendingJob = myJobs.find(
      (j) =>
        j.status === 'accepted' &&
        !!j.service_completed_at &&
        !!j.service_started_at &&
        !isCompletionReviewJob(j),
    )
    if (pendingJob) {
      setPendingClientConfirmation(pendingJob.id)
    }
  }, [pendingClientConfirmation, myJobs])

  useEffect(() => {
    if (reviewRequiredJobs.length === 0 && dismissedReviewRequiredIds.size === 0) return
    const activeReviewIds = new Set(reviewRequiredJobs.map((job) => job.id))
    const nextDismissedIds = new Set(
      Array.from(dismissedReviewRequiredIds).filter((jobId) => activeReviewIds.has(jobId)),
    )
    if (nextDismissedIds.size === dismissedReviewRequiredIds.size) return
    persistDismissedReviewRequiredIds(nextDismissedIds)
  }, [reviewRequiredJobs, dismissedReviewRequiredIds, persistDismissedReviewRequiredIds])

  useEffect(() => {
    const futureIds = new Set(futureJobs.map((j) => j.id))

    if (!transitionInitRef.current) {
      prevFutureIdsRef.current = futureIds
      transitionInitRef.current = true
      return
    }

    const becameDispatched = onTheWayJobs.find((j) => prevFutureIdsRef.current.has(j.id))
    prevFutureIdsRef.current = futureIds

    if (becameDispatched) {
      showStateMessage(becameDispatched.id, 'accepted', 'Head to the client')
    }
  }, [futureJobs, onTheWayJobs, showStateMessage])

  const fetchAll = useCallback(async (reason = 'full_refresh') => {
    if (fetchAllInFlightRef.current) {
      logRecovery('[Hydration]', 'provider hydration already in flight', {
        profileId,
        reason,
      })
      await fetchAllInFlightRef.current
      return
    }

    const run = (async () => {
    const runId = ++hydrationRunIdRef.current
    logRecovery('[Hydration]', 'provider hydration started', {
      profileId,
      reason,
      runId,
      isOnline,
      isDocumentVisible,
    })

    setLoading(true)
    setError(null)

    const selectFields =
      'id, client_id, walker_id, selected_walker_id, status, service_type, dog_name, dog_count, location, address, notes, created_at, price, duration_minutes, platform_fee, walker_earnings, payment_status, paid_at, stripe_payment_intent_id, provider_arrived_at, client_arrival_confirmed_at, service_started_at, service_completed_at, booking_timing, scheduled_for, dispatch_state, smart_dispatch_state, client:profiles!walk_requests_client_id_fkey(id, full_name, email, avatar_url)'

    const now = new Date().toISOString()
    let acceptedJobsFromAttempts: WalkRequestRow[] = []

    const { data: offersData, error: offersErr } = await supabase
      .from('active_dispatch_offers')
      .select('*')
      .eq('walker_id', profileId)
      .eq('status', 'pending')
      .gt('expires_at', now)
      .order('expires_at', { ascending: true })

    if (offersErr) {
      setError(offersErr.message)
      setLoading(false)
      return
    }

    let offers = ((offersData as DispatchOfferRow[] | null) ?? []).filter(
      (offer) => !declinedIds.has(offer.request_id),
    )

    if (offers.length > 0) {
      console.debug('[useWalkerFlow] raw active_dispatch_offers dog_count', offers.map((offer) => ({
        request_id: offer.request_id,
        offer_id: offer.id,
        dog_count: offer.dog_count ?? null,
      })))
      console.debug('[useWalkerFlow] raw active_dispatch_offers client avatar', offers.map((offer) => ({
        request_id: offer.request_id,
        client_id: offer.client_id ?? null,
        client_name: offer.client_full_name ?? offer.client_email ?? null,
        client_avatar_raw: offer.client_avatar_url ?? null,
      })))
    }

    const offerRequestIds = [...new Set(offers.map((offer) => offer.request_id))]
    if (offerRequestIds.length > 0) {
      const { data: offerRequestRowsData, error: offerRequestsErr } = await supabase
        .from('walk_requests')
        .select(selectFields)
        .in('id', offerRequestIds)
        .in('status', ['open', 'accepted'])

      if (offerRequestsErr) {
        console.warn('[useWalkerFlow] live offer request details unavailable:', offerRequestsErr.message)
      } else {
        const offerRequestById = new Map(
          (((offerRequestRowsData as Record<string, unknown>[] | null) ?? []).map((row) => ({
            ...row,
            client: Array.isArray(row.client) ? row.client[0] || null : row.client,
          })) as WalkRequestRow[]).map((request) => [request.id, request]),
        )

        offers = offers.map((offer) => {
          const request = offerRequestById.get(offer.request_id)
          if (!request) return offer

          return {
            ...offer,
            client_id: request.client_id ?? offer.client_id ?? null,
            selected_walker_id: request.selected_walker_id ?? offer.selected_walker_id ?? null,
            dog_name: request.dog_name ?? offer.dog_name ?? null,
            dog_count: request.dog_count ?? offer.dog_count ?? null,
            location: request.location ?? offer.location ?? null,
            address: request.address ?? offer.address ?? null,
            notes: request.notes ?? offer.notes ?? null,
            request_created_at: request.created_at ?? offer.request_created_at ?? null,
            price: request.price ?? offer.price ?? null,
            duration_minutes: request.duration_minutes ?? offer.duration_minutes ?? null,
            platform_fee: request.platform_fee ?? offer.platform_fee ?? null,
            walker_earnings: request.walker_earnings ?? offer.walker_earnings ?? null,
            payment_status: request.payment_status ?? offer.payment_status,
            paid_at: request.paid_at ?? offer.paid_at ?? null,
            stripe_payment_intent_id:
              request.stripe_payment_intent_id ?? offer.stripe_payment_intent_id ?? null,
            service_type: request.service_type ?? offer.service_type ?? null,
            provider_arrived_at: request.provider_arrived_at ?? offer.provider_arrived_at ?? null,
            client_arrival_confirmed_at:
              request.client_arrival_confirmed_at ?? offer.client_arrival_confirmed_at ?? null,
            service_started_at: request.service_started_at ?? offer.service_started_at ?? null,
            service_completed_at:
              request.service_completed_at ?? offer.service_completed_at ?? null,
            booking_timing: request.booking_timing ?? offer.booking_timing,
            scheduled_for: request.scheduled_for ?? offer.scheduled_for ?? null,
            dispatch_state: request.dispatch_state ?? offer.dispatch_state,
            smart_dispatch_state: request.smart_dispatch_state ?? offer.smart_dispatch_state,
            client_full_name: request.client?.full_name ?? offer.client_full_name,
            client_email: request.client?.email ?? offer.client_email,
            client_avatar_url: request.client?.avatar_url ?? offer.client_avatar_url ?? null,
          }
        })
      }
    }

    const offerClientIds = [...new Set(offers.map((offer) => offer.client_id).filter((value): value is string => !!value))]
    if (offerClientIds.length > 0) {
      const { data: offerClientProfilesData, error: offerClientProfilesErr } = await supabase
        .from('profiles')
        .select('id, avatar_url')
        .in('id', offerClientIds)

      if (offerClientProfilesErr) {
        console.warn('[useWalkerFlow] offer client avatar lookup unavailable:', offerClientProfilesErr.message)
      } else {
        const avatarByClientId = new Map(
          (((offerClientProfilesData as Array<{ id: string; avatar_url: string | null }> | null) ?? []).map((row) => [
            row.id,
            row.avatar_url ?? null,
          ])),
        )

        offers = offers.map((offer) => ({
          ...offer,
          client_avatar_url: avatarByClientId.get(offer.client_id ?? '') ?? offer.client_avatar_url ?? null,
        }))

        console.debug('[useWalkerFlow] resolved incoming offer client avatar', offers.map((offer) => ({
          request_id: offer.request_id,
          client_id: offer.client_id ?? null,
          client_name: offer.client_full_name ?? offer.client_email ?? null,
          client_avatar_raw: offer.client_avatar_url ?? null,
          resolved_client_avatar: offer.client_avatar_url ?? null,
          fallback_used: !offer.client_avatar_url,
        })))
      }
    }

    const { data: candidateRows, error: candidatesErr } = await supabase
      .from('dispatch_candidates')
      .select('request_id, walker_id, rank, score')
      .eq('walker_id', profileId)

    if (candidatesErr) {
      setError(candidatesErr.message)
      setLoading(false)
      return
    }

    const candidates = (candidateRows as DispatchCandidateRow[] | null) ?? []
    const candidateRequestIds = [...new Set(candidates.map((candidate) => candidate.request_id))]
    candidateRequestIdsRef.current = new Set(candidateRequestIds)

    if (candidateRequestIds.length > 0) {
      const { data: attemptRows, error: attemptsErr } = await supabase
        .from('dispatch_attempts')
        .select('id, request_id, attempt_no, status, expires_at, created_at, accepted_by_walker_id')
        .in('request_id', candidateRequestIds)
        .in('status', ['pending', 'accepted'])
        .order('created_at', { ascending: false })

      if (attemptsErr) {
        setError(attemptsErr.message)
        setLoading(false)
        return
      }

      const candidateByAttempt = new Map(
        candidates.map((candidate) => [`${candidate.request_id}:${candidate.rank}`, candidate]),
      )
      const currentOfferKeys = new Set(
        offers.map((offer) => `${offer.request_id}:${offer.attempt_no}`),
      )
      const attempts = (attemptRows as DispatchAttemptRow[] | null) ?? []
      const pendingAttempts = attempts.filter(
        (attempt) =>
          attempt.status === 'pending' &&
          new Date(attempt.expires_at).getTime() > Date.now() &&
          candidateByAttempt.has(`${attempt.request_id}:${attempt.attempt_no}`) &&
          !currentOfferKeys.has(`${attempt.request_id}:${attempt.attempt_no}`) &&
          !declinedIds.has(attempt.request_id),
      )
      const acceptedAttempts = attempts.filter(
        (attempt) =>
          attempt.status === 'accepted' &&
          attempt.accepted_by_walker_id === profileId &&
          candidateByAttempt.has(`${attempt.request_id}:${attempt.attempt_no}`),
      )

      const missingRequestIds = [
        ...new Set([...pendingAttempts, ...acceptedAttempts].map((attempt) => attempt.request_id)),
      ]

      if (missingRequestIds.length > 0) {
        const { data: requestRowsData, error: requestsErr } = await supabase
          .from('walk_requests')
          .select(selectFields)
          .in('id', missingRequestIds)
          .in('status', ['open', 'accepted'])

        if (requestsErr) {
          console.warn('[useWalkerFlow] fallback request details unavailable:', requestsErr.message)
        }

        const requestById = new Map(
          (((requestRowsData as Record<string, unknown>[] | null) ?? []).map((row) => ({
            ...row,
            client: Array.isArray(row.client) ? row.client[0] || null : row.client,
          })) as WalkRequestRow[]).map((request) => [request.id, request]),
        )

        const fallbackOffers = pendingAttempts
          .map((attempt): DispatchOfferRow | null => {
            const candidate = candidateByAttempt.get(`${attempt.request_id}:${attempt.attempt_no}`)
            const request = requestById.get(attempt.request_id)

            if (!candidate || request?.walker_id) return null

            return {
              id: attempt.id,
              request_id: attempt.request_id,
              walker_id: candidate.walker_id,
              rank: candidate.rank,
              score: candidate.score,
              status: attempt.status,
              offered_at: attempt.created_at,
              expires_at: attempt.expires_at,
              attempt_no: attempt.attempt_no,
              request_status: request?.status ?? 'open',
              dispatch_state: request?.dispatch_state ?? 'dispatched',
              client_id: request?.client_id ?? null,
            selected_walker_id: request?.selected_walker_id ?? null,
            dog_name: request?.dog_name ?? null,
            dog_count: request?.dog_count ?? null,
            location: request?.location ?? null,
            address: request?.address ?? null,
              notes: request?.notes ?? null,
              request_created_at: request?.created_at ?? attempt.created_at,
              price: request?.price ?? null,
              duration_minutes: request?.duration_minutes ?? null,
              platform_fee: request?.platform_fee ?? null,
              walker_earnings: request?.walker_earnings ?? null,
              payment_status: request?.payment_status ?? 'authorized',
              paid_at: request?.paid_at ?? null,
              stripe_payment_intent_id: request?.stripe_payment_intent_id ?? null,
              service_type: request?.service_type ?? null,
              provider_arrived_at: request?.provider_arrived_at ?? null,
              client_arrival_confirmed_at: request?.client_arrival_confirmed_at ?? null,
              service_started_at: request?.service_started_at ?? null,
              service_completed_at: request?.service_completed_at ?? null,
              booking_timing: request?.booking_timing,
              scheduled_for: request?.scheduled_for ?? null,
              smart_dispatch_state: request?.smart_dispatch_state ?? 'dispatching',
              client_full_name: request?.client?.full_name ?? null,
              client_email: request?.client?.email ?? null,
              client_avatar_url: request?.client?.avatar_url ?? null,
            }
          })
          .filter((offer): offer is DispatchOfferRow => offer !== null)

        offers = [...offers, ...fallbackOffers]

        acceptedJobsFromAttempts = acceptedAttempts.map((attempt) => {
          const request = requestById.get(attempt.request_id)
          const scheduledTs = request?.scheduled_for ? new Date(request.scheduled_for).getTime() : null
          const scheduledIsDue = scheduledTs != null && !Number.isNaN(scheduledTs) && scheduledTs <= Date.now()

          return {
            id: attempt.request_id,
            client_id: request?.client_id ?? '',
            walker_id: profileId,
            selected_walker_id: request?.selected_walker_id ?? profileId,
            status: 'accepted' as const,
            dog_name: request?.dog_name ?? null,
            dog_count: request?.dog_count ?? null,
            location: request?.location ?? null,
            address: request?.address ?? null,
            notes: request?.notes ?? null,
            created_at: request?.created_at ?? attempt.created_at,
            price: request?.price ?? null,
            duration_minutes: request?.duration_minutes ?? null,
            platform_fee: request?.platform_fee ?? null,
            walker_earnings: request?.walker_earnings ?? null,
            payment_status: request?.payment_status ?? 'authorized',
            paid_at: request?.paid_at ?? null,
            stripe_payment_intent_id: request?.stripe_payment_intent_id ?? null,
            service_type: request?.service_type ?? null,
            provider_arrived_at: request?.provider_arrived_at ?? null,
            client_arrival_confirmed_at: request?.client_arrival_confirmed_at ?? null,
            service_started_at: request?.service_started_at ?? null,
            service_completed_at: request?.service_completed_at ?? null,
            booking_timing: request?.booking_timing,
            scheduled_for: request?.scheduled_for ?? null,
            dispatch_state:
              request?.dispatch_state ??
              (request?.booking_timing === 'scheduled' && !scheduledIsDue ? 'queued' : 'dispatched'),
            smart_dispatch_state: request?.smart_dispatch_state ?? 'assigned',
            client: request?.client ?? null,
          }
        })
      }
    }

    const buildOpenJobs = (offerRows: DispatchOfferRow[]): WalkRequestRow[] =>
      offerRows.map((offer) => ({
      id: offer.request_id,
      client_id: offer.client_id ?? '',
      walker_id: null,
      selected_walker_id: offer.selected_walker_id,
      status: 'open' as const,
      dog_name: offer.dog_name,
      dog_count: offer.dog_count ?? null,
      location: offer.location,
      address: offer.address,
      notes: offer.notes,
      created_at: offer.request_created_at,
      price: offer.price,
      duration_minutes: offer.duration_minutes ?? null,
      platform_fee: offer.platform_fee,
      walker_earnings: offer.walker_earnings,
      payment_status: offer.payment_status,
      paid_at: offer.paid_at,
      stripe_payment_intent_id: offer.stripe_payment_intent_id,
      service_type: offer.service_type ?? null,
      provider_arrived_at: offer.provider_arrived_at ?? null,
      client_arrival_confirmed_at: offer.client_arrival_confirmed_at ?? null,
      service_started_at: offer.service_started_at ?? null,
      service_completed_at: offer.service_completed_at ?? null,
      booking_timing: offer.booking_timing,
      scheduled_for: offer.scheduled_for,
      dispatch_state: offer.dispatch_state as WalkRequestRow['dispatch_state'],
      smart_dispatch_state: offer.smart_dispatch_state,
      client: {
        id: offer.client_id ?? '',
        full_name: offer.client_full_name,
        email: offer.client_email,
        avatar_url: offer.client_avatar_url ?? null,
      },
    })).sort((a, b) => {
      const aOffer = offerRows.find((o) => o.request_id === a.id)
      const bOffer = offerRows.find((o) => o.request_id === b.id)
      return (aOffer?.attempt_no ?? 9999) - (bOffer?.attempt_no ?? 9999)
    })

    const [mineResult, tipsResult] = await Promise.allSettled([
      supabase
        .from('walk_requests')
        .select(selectFields)
        .eq('walker_id', profileId)
        .order('created_at', { ascending: false }),
      supabase
        .from('walker_tips')
        .select('id, walk_request_id, walker_id, amount, created_at')
        .eq('walker_id', profileId)
        .order('created_at', { ascending: false }),
    ])

    if (mineResult.status === 'rejected') {
      setError(mineResult.reason instanceof Error ? mineResult.reason.message : 'Failed to load jobs')
      setLoading(false)
      return
    }

    if (mineResult.value.error) {
      setError(mineResult.value.error.message)
      setLoading(false)
      return
    }

    const tipByJobId = new Map<string, number>()
    if (tipsResult.status === 'fulfilled') {
      if (tipsResult.value.error) {
        console.warn('[useWalkerFlow] walker tips unavailable:', tipsResult.value.error.message)
      } else {
        for (const tip of ((tipsResult.value.data as TipRow[] | null) ?? [])) {
          if (!tipByJobId.has(tip.walk_request_id)) {
            tipByJobId.set(tip.walk_request_id, tip.amount)
          }
        }
      }
    } else {
      console.warn('[useWalkerFlow] walker tips unavailable:', tipsResult.reason)
    }

    let newMine = (((mineResult.value.data as Record<string, unknown>[] | null) ?? []).map((row) => ({
      ...row,
      client: Array.isArray(row.client) ? row.client[0] || null : row.client,
    })) as WalkRequestRow[])

    newMine = newMine.map((job) => ({
      ...job,
      tip_amount: tipByJobId.get(job.id) ?? null,
    }))

    if (acceptedJobsFromAttempts.length > 0) {
      const mineIds = new Set(newMine.map((job) => job.id))
      newMine = [
        ...acceptedJobsFromAttempts.filter((job) => !mineIds.has(job.id)),
        ...newMine,
      ]
    }

    let mergedOffers = offers
    const retainedIncomingOffer = retainedIncomingOfferRef.current
    if (retainedIncomingOffer && !declinedIds.has(retainedIncomingOffer.request_id)) {
      const hasFreshOffer = offers.some((offer) => offer.id === retainedIncomingOffer.id)
      const retainedAssignedToMe = newMine.some((job) => job.id === retainedIncomingOffer.request_id)

      if (hasFreshOffer) {
        retainedIncomingOfferRef.current =
          offers.find((offer) => offer.id === retainedIncomingOffer.id) ?? retainedIncomingOffer
      } else if (!retainedAssignedToMe) {
        const { data: retainedRequestRow, error: retainedRequestError } = await supabase
          .from('walk_requests')
          .select('id, status, walker_id')
          .eq('id', retainedIncomingOffer.request_id)
          .maybeSingle()

        if (retainedRequestError) {
          console.warn('[useWalkerFlow] retained offer request lookup unavailable:', retainedRequestError.message)
        }

        const canKeepRetainedOffer =
          !retainedRequestError &&
          !!retainedRequestRow &&
          retainedRequestRow.status === 'open' &&
          retainedRequestRow.walker_id == null

        if (canKeepRetainedOffer) {
          mergedOffers = [retainedIncomingOffer, ...offers]
        } else {
          clearRetainedIncomingOffer(retainedIncomingOffer.request_id)
        }
      }
    }

    if (!retainedIncomingOfferRef.current && mergedOffers.length > 0) {
      retainedIncomingOfferRef.current = mergedOffers[0]
    }

    mergedOffers = mergedOffers.filter(
      (offer, index, self) =>
        !declinedIds.has(offer.request_id) &&
        self.findIndex((candidate) => candidate.id === offer.id) === index,
    )

    setActiveOffers(mergedOffers)

    const newOpen = buildOpenJobs(mergedOffers)
    if (mergedOffers.length > 0) {
      console.debug('[useWalkerFlow] mapped incoming request dog_count', mergedOffers.map((offer) => ({
        request_id: offer.request_id,
        dog_count: offer.dog_count ?? null,
      })))
      console.debug('[useWalkerFlow] openJobs dog_count', newOpen.map((job) => ({
        request_id: job.id,
        dog_count: job.dog_count ?? null,
      })))
    }
    const newOfferIds = new Set(newOpen.map((j) => j.id))
    const myJobIds = new Set(newMine.map((j) => j.id))
    const prev = prevOfferIdsRef.current

    if (prev.size > 0) {
      for (const id of prev) {
        if (!newOfferIds.has(id) && !myJobIds.has(id) && !declinedIds.has(id)) {
          setTakenNotice(true)
          break
        }
      }
    }
    prevOfferIdsRef.current = newOfferIds

    setOpenJobs(newOpen)
    setMyJobs(newMine)
    assignedJobIdsRef.current = new Set(newMine.map((job) => job.id))
    logRecovery('[Recovery]', 'provider state hydrated from database', {
      profileId,
      reason,
      runId,
      openOfferCount: newOpen.length,
      myJobCount: newMine.length,
      onTheWayCount: newMine.filter(
        (job) =>
          job.status === 'accepted' &&
          isDispatchedScheduledJob(job) &&
          !isFutureJob(job) &&
          !isCompletionReviewJob(job) &&
          !job.service_started_at,
      ).length,
      activeCount: newMine.filter(
        (job) =>
          job.status === 'accepted' &&
          isDispatchedScheduledJob(job) &&
          !isFutureJob(job) &&
          !isCompletionReviewJob(job) &&
          !!job.service_started_at,
      ).length,
      completionReviewCount: newMine.filter((job) => isCompletionReviewJob(job)).length,
    })
    setLoading(false)
    })().finally(() => {
      fetchAllInFlightRef.current = null
    })

    fetchAllInFlightRef.current = run
    await run
  }, [profileId, declinedIds, clearRetainedIncomingOffer])

  const fetchAllRef = useRef(fetchAll)
  const isDocumentVisibleRef = useRef(isDocumentVisible)
  const refreshOffersRef = useRef(fetchAll)

  useEffect(() => {
    fetchAllRef.current = fetchAll
    refreshOffersRef.current = fetchAll
  }, [fetchAll])

  useEffect(() => {
    isDocumentVisibleRef.current = isDocumentVisible
  }, [isDocumentVisible])

  useEffect(() => {
    const refreshOnResume = () => {
      logRecovery('[ForegroundResume]', 'provider window focus/pageshow refresh', {
        profileId,
        isOnline,
        isDocumentVisible: isDocumentVisibleRef.current,
      })
      void fetchAllRef.current('window_focus_or_pageshow')
    }

    window.addEventListener('focus', refreshOnResume)
    window.addEventListener('pageshow', refreshOnResume)

    return () => {
      window.removeEventListener('focus', refreshOnResume)
      window.removeEventListener('pageshow', refreshOnResume)
    }
  }, [isOnline, profileId])

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return

    let cancelled = false
    let handle: PluginListenerHandle | null = null

    NativeApp.addListener('appStateChange', (state) => {
      logRecovery('[ForegroundResume]', 'provider native app state changed', {
        profileId,
        isActive: state.isActive,
        isOnline,
        isDocumentVisible: isDocumentVisibleRef.current,
      })
      if (state.isActive) {
        void fetchAllRef.current('native_foreground_resume')
      }
    })
      .then((listener) => {
        if (cancelled) {
          void listener.remove()
          return
        }
        handle = listener
      })
      .catch((err) => {
        console.warn('[ForegroundResume] provider native app state listener unavailable', err)
      })

    return () => {
      cancelled = true
      if (handle) void handle.remove()
    }
  }, [isOnline, profileId])

  useEffect(() => {
    currentWalkerIdRef.current = profileId || null
  }, [profileId])

  useEffect(() => {
    console.log('[useWalkerFlow] walker id state', {
      currentUserProfileId: profileId,
      currentWalkerIdCandidate: profileId,
      isDocumentVisible,
      isOnline,
      onlineLoading,
    })
  }, [profileId, isDocumentVisible, isOnline, onlineLoading])


  useEffect(() => {
    if (!isOnline || !isDocumentVisible) return

    const id = window.setInterval(() => {
      void fetchAll(hasActiveWalkerWork ? 'poll_active_provider_work' : 'poll_idle_provider')
    }, hasActiveWalkerWork ? ACTIVE_WALKER_POLL_MS : IDLE_WALKER_POLL_MS)

    return () => window.clearInterval(id)
  }, [fetchAll, hasActiveWalkerWork, isDocumentVisible, isOnline])

  useEffect(() => {
    if (!isOnline || !isDocumentVisible) return
    void fetchAll('online_visible_resume')
  }, [fetchAll, isDocumentVisible, isOnline])
  const fetchRatings = useCallback(async () => {
    const { data: received } = await supabase.from('ratings').select('*').eq('to_user_id', profileId)
    setRatingsReceived((received as RatingRow[]) || [])

    const { data: given } = await supabase.from('ratings').select('*').eq('from_user_id', profileId)
    setRatingsGiven((given as RatingRow[]) || [])
  }, [profileId])

  const fetchWallet = useCallback(async () => {
    const { data } = await supabase
      .from('walker_wallets')
      .select('available_balance, pending_balance, total_earned')
      .eq('walker_id', profileId)
      .maybeSingle()
    setWalletData(data ?? { available_balance: 0, pending_balance: 0, total_earned: 0 })
  }, [profileId])

  const fetchBalanceAdjustments = useCallback(async () => {
    const { data } = await supabase
      .from('walker_balance_adjustments')
      .select('id, job_id, type, amount, description, created_at')
      .eq('walker_id', profileId)
      .order('created_at', { ascending: false })
    setBalanceAdjustments(data || [])
  }, [profileId])

  const fetchConnectStatus = useCallback(async () => {
    if (connectStatusRequestRef.current) {
      return connectStatusRequestRef.current
    }

    const request = (async () => {
      setConnectLoading(true)
      setConnectError(null)

      let lastErrorMessage: string | null = null

      for (let attempt = 1; attempt <= CONNECT_STATUS_MAX_ATTEMPTS; attempt += 1) {
        try {
          const hasAuth = await prepareEdgeFunctionAuth()
          if (!hasAuth) {
            lastErrorMessage = 'Authentication issue. Please refresh and try again.'
          } else {
            const { data, error } = await invokeEdgeFunction<ConnectStatus>('get-connect-status')
            if (error) {
              lastErrorMessage = error || 'Failed to load payout account status.'
            } else if (!data) {
              lastErrorMessage = 'Failed to load payout account status.'
            } else {
              const nextStatus = data as ConnectStatus
              setConnectStatus(nextStatus)
              setConnectError(null)
              return nextStatus
            }
          }
        } catch {
          lastErrorMessage = 'Failed to load payout account status.'
        }

        if (attempt < CONNECT_STATUS_MAX_ATTEMPTS) {
          await new Promise((resolve) => window.setTimeout(resolve, CONNECT_STATUS_RETRY_DELAY_MS))
        }
      }

      setConnectError(lastErrorMessage || 'Failed to load payout account status.')
      return null
    })()

    connectStatusRequestRef.current = request

    try {
      return await request
    } finally {
      connectStatusRequestRef.current = null
      setConnectLoading(false)
    }
  }, [])

  const fetchOnlineStatus = useCallback(async () => {
    const { data } = await supabase.from('profiles').select('is_online').eq('id', profileId).maybeSingle()
    setIsOnline(data?.is_online ?? false)
    setOnlineLoading(false)
  }, [profileId])

  const toggleOnline = useCallback(async () => {
    const newValue = !isOnline

    if (newValue) {
      const latestStatus = await fetchConnectStatus()
      if (!isStripeReadyForOnline(latestStatus ?? connectStatus)) {
        return false
      }
    }

    setIsOnline(newValue)

    const { error } = await supabase.from('profiles').update({ is_online: newValue }).eq('id', profileId)
    if (error) {
      console.error('[useWalkerFlow] toggleOnline error:', error.message)
      setIsOnline(!newValue)
      return false
    }
    return true
  }, [connectStatus, fetchConnectStatus, isOnline, profileId])

  useEffect(() => {
    logRecovery('[Recovery]', 'provider cold-start hydration scheduled', { profileId })
    void fetchAllRef.current('cold_start')
    fetchOnlineStatus()

    const t1 = setTimeout(() => {
      void fetchRatings()
      void fetchWallet()
    }, 600)

    const t2 = setTimeout(() => {
      void fetchBalanceAdjustments()
      void fetchConnectStatus()
    }, 1200)

    let ch1: ReturnType<typeof supabase.channel> | null = null
    let ch2: ReturnType<typeof supabase.channel> | null = null
    let ch3: ReturnType<typeof supabase.channel> | null = null
    let ch4: ReturnType<typeof supabase.channel> | null = null
    let ch5: ReturnType<typeof supabase.channel> | null = null
    let ch6: ReturnType<typeof supabase.channel> | null = null
    let isCleaningUp = false

    const hydrateOnSubscribed = (reason: string, channelName: string) => {
      const now = Date.now()
      const lastRunAt = realtimeHydrationAtRef.current.get(reason) ?? 0
      if (now - lastRunAt < REALTIME_SUBSCRIBED_HYDRATION_THROTTLE_MS) {
        logRecovery('[RealtimeReconnect]', 'provider realtime subscribed hydration throttled', {
          profileId,
          channelName,
          reason,
          msSinceLastRun: now - lastRunAt,
        })
        return
      }

      realtimeHydrationAtRef.current.set(reason, now)
      void fetchAllRef.current(reason)
    }

    const logRealtimeStatus = (channelName: string, status: string) => {
      if (isCleaningUp && status === 'CLOSED') {
        logRecovery('[RealtimeReconnect]', 'provider realtime closed during cleanup', {
          profileId,
          channelName,
        })
        return false
      }

      logRecovery('[RealtimeReconnect]', 'provider realtime status changed', {
        profileId,
        channelName,
        status,
      })
      return true
    }

    const tSub = setTimeout(() => {
      const requestsChannelName = `wf-requests-${profileId}`
      ch1 = supabase
        .channel(requestsChannelName)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'walk_requests', filter: `walker_id=eq.${profileId}` },
          () => {
            if (!isDocumentVisibleRef.current) return
            void fetchAllRef.current('realtime_walker_request_change')
            void fetchWallet()
          },
        )
        .subscribe((status) => {
          if (!logRealtimeStatus(requestsChannelName, status)) return
          if (status === 'SUBSCRIBED') {
            hydrateOnSubscribed('realtime_walk_requests_subscribed', requestsChannelName)
          }
        })

      ch2 = supabase
        .channel(`wf-ratings-${profileId}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'ratings' }, () => {
          void fetchRatings()
        })
        .subscribe()

      ch3 = supabase
        .channel(`wf-wallet-${profileId}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'walker_wallets', filter: `walker_id=eq.${profileId}` },
          () => {
            void fetchWallet()
          },
        )
        .subscribe()

      ch4 = supabase
        .channel(`wf-adjustments-${profileId}`)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'walker_balance_adjustments',
            filter: `walker_id=eq.${profileId}`,
          },
          () => {
            void fetchBalanceAdjustments()
            void fetchWallet()
          },
        )
        .subscribe()

      const dispatchChannelName = `wf-dispatch-${profileId}`
      ch5 = supabase
        .channel(dispatchChannelName)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'dispatch_candidates', filter: `walker_id=eq.${profileId}` },
          () => {
            if (!isDocumentVisibleRef.current) return
            void fetchAllRef.current('realtime_dispatch_candidate_change')
          },
        )
        .subscribe((status) => {
          if (!logRealtimeStatus(dispatchChannelName, status)) return
          if (status === 'SUBSCRIBED') {
            hydrateOnSubscribed('realtime_dispatch_candidates_subscribed', dispatchChannelName)
          }
        })

      ch6 = supabase
        .channel(`wf-tips-${profileId}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'walker_tips', filter: `walker_id=eq.${profileId}` },
          () => {
            if (!isDocumentVisibleRef.current) return
            void fetchAllRef.current('realtime_walker_tip_change')
          },
        )
        .subscribe()
    }, 800)

    return () => {
      clearTimeout(t1)
      clearTimeout(t2)
      clearTimeout(tSub)
      isCleaningUp = true
      if (ch1) supabase.removeChannel(ch1)
      if (ch2) supabase.removeChannel(ch2)
      if (ch3) supabase.removeChannel(ch3)
      if (ch4) supabase.removeChannel(ch4)
      if (ch5) supabase.removeChannel(ch5)
      if (ch6) supabase.removeChannel(ch6)
    }
  }, [
    profileId,
    fetchRatings,
    fetchWallet,
    fetchBalanceAdjustments,
    fetchConnectStatus,
    fetchOnlineStatus,
  ])

  useEffect(() => {
    if (!profileId) {
      console.log('[useWalkerFlow] realtime setup skipped: missing walker id', {
        currentUserProfileId: profileId,
        currentWalkerIdCandidate: profileId,
      })
      logDispatchRealtime('subscription skipped: missing walker_id')
      return
    }

    const walkerId = profileId
    const channelName = `dispatch_attempts_provider_${walkerId}`

    console.log('[useWalkerFlow] realtime subscription created', {
      currentUserProfileId: walkerId,
      currentWalkerIdCandidate: walkerId,
      channelName,
    })
    logDispatchRealtime('subscription created with walker_id', {
      currentWalkerId: walkerId,
      channelName,
    })

    let cleanedUp = false
    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'dispatch_attempts',
        },
        (payload) => {
          const nextRecord =
            typeof payload?.new === 'object' && payload.new ? payload.new : null
          const previousRecord =
            typeof payload?.old === 'object' && payload.old ? payload.old : null
          const row = (nextRecord ?? previousRecord) as Record<string, unknown> | null
          const rowWalkerId = typeof row?.['walker_id'] === 'string' ? row['walker_id'] : null
          const requestId = typeof row?.['request_id'] === 'string' ? row['request_id'] : null
          const status = typeof row?.['status'] === 'string' ? row['status'] : null
          const currentWalkerId = currentWalkerIdRef.current
          const matchedWalker = !!rowWalkerId && rowWalkerId === currentWalkerId

          console.log('[useWalkerFlow] realtime event received', {
            channelName,
            eventType: payload.eventType,
            currentWalkerId,
            rowWalkerId,
            requestId,
            status,
            matchedWalker,
          })

          logDispatchRealtime('Realtime event received', {
            currentWalkerId,
            channelName,
            eventType: payload.eventType,
            payloadNew: nextRecord,
            payloadOld: previousRecord,
            rowWalkerId,
            requestId,
            status,
            matchedWalker,
          })

          if (!matchedWalker) {
            return
          }

          console.log('[useWalkerFlow] matched walker id', {
            channelName,
            currentWalkerId,
            rowWalkerId,
            requestId,
          })

          if (status !== 'pending') {
            return
          }

          console.log('[useWalkerFlow] refresh triggered', {
            channelName,
            currentWalkerId,
            requestId,
          })
          logDispatchRealtime('refresh triggered', {
            channelName,
            currentWalkerId,
            requestId,
          })
          void refreshOffersRef.current('realtime_dispatch_attempt_pending')
        },
      )
      .subscribe((status) => {
        if (cleanedUp && status === 'CLOSED') {
          logRecovery('[RealtimeReconnect]', 'provider dispatch attempt realtime closed during cleanup', {
            profileId: walkerId,
            channelName,
          })
          return
        }

        logRecovery('[RealtimeReconnect]', 'provider dispatch attempt realtime status changed', {
          profileId: walkerId,
          channelName,
          status,
        })
        console.log('[useWalkerFlow] realtime subscribe status', {
          currentUserProfileId: walkerId,
          currentWalkerIdCandidate: walkerId,
          channelName,
          status,
        })
        logDispatchRealtime('subscription status callback', {
          currentWalkerId: walkerId,
          channelName,
          status,
        })
        if (status === 'SUBSCRIBED') {
          const reason = 'realtime_dispatch_attempts_subscribed'
          const now = Date.now()
          const lastRunAt = realtimeHydrationAtRef.current.get(reason) ?? 0
          if (now - lastRunAt < REALTIME_SUBSCRIBED_HYDRATION_THROTTLE_MS) {
            logRecovery('[RealtimeReconnect]', 'provider dispatch attempt subscribed hydration throttled', {
              profileId: walkerId,
              channelName,
              reason,
              msSinceLastRun: now - lastRunAt,
            })
            return
          }
          realtimeHydrationAtRef.current.set(reason, now)
          void refreshOffersRef.current(reason)
        }
      })

    return () => {
      const cleanupReason = cleanedUp ? 'duplicate_cleanup' : currentWalkerIdRef.current === walkerId ? 'unmount' : 'walker_id_changed'
      cleanedUp = true
      console.log('[useWalkerFlow] realtime subscription cleanup', {
        currentUserProfileId: walkerId,
        currentWalkerIdCandidate: walkerId,
        channelName,
        cleanupReason,
      })
      logDispatchRealtime('subscription cleanup', {
        currentWalkerId: walkerId,
        channelName,
        cleanupReason,
      })
      void supabase.removeChannel(channel)
    }
  }, [profileId])

  useEffect(() => {
    if (!import.meta.env.DEV) return

    window.__regliRefreshWalkerOffers = () => {
      logDispatchRealtime('manual refresh invoked', { currentWalkerId: profileId })
      void fetchAllRef.current()
    }

    return () => {
      if (window.__regliRefreshWalkerOffers) {
        delete window.__regliRefreshWalkerOffers
      }
    }
  }, [profileId])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.has('connect_return') || params.has('connect_refresh')) {
      const url = new URL(window.location.href)
      url.searchParams.delete('connect_return')
      url.searchParams.delete('connect_refresh')
      window.history.replaceState({}, '', url.toString())
      void fetchConnectStatus()
    }
  }, [fetchConnectStatus])

  const handleAccept = useCallback(
    async (requestId: string) => {
      setError(null)
      setSuccessMessage(null)

      const offer = activeOffers.find((o) => o.request_id === requestId)
      const job = openJobs.find((j) => j.id === requestId)

      if (!offer || !job) {
        setError('This request is no longer available.')
        clearRetainedIncomingOffer(requestId)
        await fetchAll()
        return
      }

      const hasAuth = await prepareEdgeFunctionAuth()
      if (!hasAuth) {
        setError('Authentication issue. Please refresh and try again.')
        return
      }

      const { data, error: fnError } = await supabase.functions.invoke('accept-dispatch', {
        body: {
          requestId,
          attemptId: offer.id,
        },
      })

      if (fnError || !data?.ok) {
        const errorMsg = data?.result?.code || fnError?.message || 'Failed to accept job'
        // Only show specific errors, ignore generic ones
        if (errorMsg.toLowerCase().includes('no_session') || errorMsg.toLowerCase().includes('jwt')) {
          setError('Authentication issue. Please refresh and try again.')
        } else {
          setError(errorMsg)
        }
        await fetchAll()
        return
      }

      clearRetainedIncomingOffer(requestId)

      const nextDispatchState =
        job.booking_timing === 'scheduled'
          ? job.dispatch_state === 'dispatched'
            ? 'dispatched'
            : 'queued'
          : 'dispatched'

      if (walkerPosition) {
        await supabase
          .from('walk_requests')
          .update({
            selected_walker_id: profileId,
            walker_lat: walkerPosition[0],
            walker_lng: walkerPosition[1],
            last_location_update: new Date().toISOString(),
            dispatch_state: nextDispatchState,
          })
          .eq('id', requestId)
          .eq('walker_id', profileId)
      } else {
        await supabase
          .from('walk_requests')
          .update({
            selected_walker_id: profileId,
            dispatch_state: nextDispatchState,
          })
          .eq('id', requestId)
          .eq('walker_id', profileId)
      }

      const shouldStartScheduledNow = !!job && shouldAutoDispatch({
        booking_timing: job.booking_timing,
        status: 'accepted',
        walker_id: profileId,
        scheduled_for: job.scheduled_for,
        dispatch_state: nextDispatchState,
      })

      if (shouldStartScheduledNow && job.booking_timing === 'scheduled') {
        await supabase
          .from('walk_requests')
          .update({
            dispatch_state: 'dispatched',
            ...(walkerPosition
              ? {
                  walker_lat: walkerPosition[0],
                  walker_lng: walkerPosition[1],
                  last_location_update: new Date().toISOString(),
                }
              : {}),
          })
          .eq('id', requestId)
          .eq('walker_id', profileId)
      }

      const dispatchNow =
        job.booking_timing !== 'scheduled' ||
        nextDispatchState === 'dispatched' ||
        shouldStartScheduledNow
      const labels = getServiceLabels(job.service_type)

      track(AnalyticsEvent.PROVIDER_MATCHED, {
        request_id: requestId,
        provider_id: profileId,
        client_id: job.client_id ?? undefined,
        price: job.price ?? undefined,
        actor_role: 'provider',
        source_screen: 'walker_dashboard',
      })

      showStateMessage(requestId, 'accepted', dispatchNow ? 'Head to the client' : 'Job accepted')
        await fetchAll()

      const dogLabel = job.dog_name || 'a dog'

      if (job.client_id) {
        const isScheduled = job.booking_timing === 'scheduled'
        const clientNotifTitle = dispatchNow ? 'Walker on the way' : 'Walker Accepted'
        const clientNotifMessage = dispatchNow
          ? `${profileName} is heading to you for ${dogLabel}.`
          : isScheduled
            ? `${profileName} confirmed ${dogLabel}'s scheduled walk.`
            : `${profileName} is on the way for ${dogLabel}'s walk!`
        invokeEdgeFunction('send-push-notification', {
          body: {
            title: clientNotifTitle,
            body: clientNotifMessage,
            targetUserId: job.client_id,
            data: { jobId: requestId },
          },
        }).catch((err) => console.error('[Push] Failed to notify client (accepted):', err))
        void createNotification({
          userId: job.client_id,
          type: 'job_accepted',
          title: clientNotifTitle,
          message: clientNotifMessage,
          relatedJobId: requestId,
        })
      }

      await createNotification({
        userId: profileId,
        type: dispatchNow ? 'dispatch_started' : 'job_accepted_self',
        title: dispatchNow ? 'Head to the client' : 'Job Accepted',
        message: dispatchNow
          ? `Head to the pickup for ${dogLabel}. ${labels.startAction} when the client confirms arrival.`
          : job.booking_timing === 'scheduled'
            ? `You accepted a scheduled booking for ${dogLabel}. Head to the client when dispatch starts.`
            : `You accepted a booking for ${dogLabel}. Head to the location and wait for arrival confirmation.`,
        relatedJobId: requestId,
      })
    },
    [activeOffers, openJobs, profileId, profileName, fetchAll, walkerPosition, showStateMessage, clearRetainedIncomingOffer],
  )

  const unassignFutureJob = useCallback(
    async (jobId: string) => {
      setError(null)
      setSuccessMessage(null)

      const job = myJobs.find((j) => j.id === jobId)
      if (!job || !isFutureJob(job)) {
        setError('This future order can no longer be changed here.')
        return
      }

      const confirmed = window.confirm('Leave this scheduled walk?')
      if (!confirmed) return

      const { error } = await supabase
        .from('walk_requests')
        .update({
          walker_id: null,
          selected_walker_id: null,
          status: 'open',
          walker_lat: null,
          walker_lng: null,
          last_location_update: null,
          smart_dispatch_state: 'idle',
        })
        .eq('id', jobId)
        .eq('walker_id', profileId)
        .neq('dispatch_state', 'dispatched')

      if (error) {
        setError(error.message || 'Failed to leave scheduled walk')
        return
      }

      setMyJobs((prev) => prev.filter((j) => j.id !== jobId))
      setSuccessMessage('You left the scheduled walk')
      await fetchAll()
    },
    [fetchAll, myJobs, profileId],
  )

  const handleDecline = useCallback(
    async (requestId: string, reason: 'manual' | 'timeout' = 'manual') => {
      track(AnalyticsEvent.PROVIDER_REJECTED, {
        request_id: requestId,
        provider_id: profileId,
        actor_role: 'provider',
        source_screen: 'walker_dashboard',
      })

      const offer = activeOffers.find((o) => o.request_id === requestId)

      setDeclinedIds((prev) => {
        const next = new Set(prev)
        next.add(requestId)
        return next
      })
      clearRetainedIncomingOffer(requestId)

      if (!offer) {
        await fetchAll()
        return
      }

      console.info('[useWalkerFlow] decline dispatch', {
        request_id: requestId,
        attempt_id: offer.id,
        provider_id: profileId,
        reason,
      })

      const hasAuth = await prepareEdgeFunctionAuth()
      if (!hasAuth) {
        setError('Authentication issue. Please refresh and try again.')
        return
      }

      const { data, error: fnError } = await invokeEdgeFunction('decline-dispatch', {
        body: {
          requestId,
          attemptId: offer.id,
          timeoutSeconds: 20,
        },
      })

      if (fnError) {
        console.error('[useWalkerFlow] decline dispatch error:', fnError)
      } else {
        console.info('[useWalkerFlow] decline dispatch advanced', {
          request_id: requestId,
          attempt_id: offer.id,
          provider_id: profileId,
          reason,
          result: data ?? null,
        })
      }

      await fetchAll()
    },
    [profileId, activeOffers, fetchAll, clearRetainedIncomingOffer],
  )

  const markArrived = useCallback(
    async (jobId: string) => {
      const job = myJobs.find((item) => item.id === jobId)
      if (!job) return

      const now = new Date().toISOString()
      const patch: Record<string, unknown> = { provider_arrived_at: job.provider_arrived_at ?? now }
      if (walkerPosition) {
        patch.walker_lat = walkerPosition[0]
        patch.walker_lng = walkerPosition[1]
        patch.last_location_update = now
      }

      const { error: arriveError } = await supabase
        .from('walk_requests')
        .update(patch)
        .eq('id', jobId)
        .eq('walker_id', profileId)
        .eq('status', 'accepted')

      if (arriveError) {
        setError(arriveError.message)
        return
      }

      track(AnalyticsEvent.PROVIDER_ARRIVED, {
        request_id: jobId,
        provider_id: profileId,
        client_id: job.client_id ?? undefined,
        source_screen: 'walker_dashboard',
      })

      showStateMessage(jobId, 'arrived', 'Arrived at the client')
      sendClientLiveOrderEvent({
        clientId: job.client_id,
        jobId,
        type: 'arrived',
        message: 'Provider has arrived.',
        walkerId: profileId,
        walkerName: profileName,
      })

      await createNotification({
        userId: profileId,
        type: 'dispatch_started',
        title: 'Arrived',
        message: 'You have arrived. Wait for the client to confirm before starting.',
        relatedJobId: jobId,
      }).catch(() => {})

      if (job.client_id) {
        const dogLabel = job.dog_name || 'your pet'
        invokeEdgeFunction('send-push-notification', {
          body: {
            title: 'Walker has arrived',
            body: `${profileName} has arrived for ${dogLabel}.`,
            targetUserId: job.client_id,
            data: { jobId },
          },
        }).catch((err) => console.error('[Push] Failed to notify client (arrived):', err))
        void createNotification({
          userId: job.client_id,
          type: 'walker_arrived',
          title: 'Walker has arrived',
          message: `${profileName} has arrived for ${dogLabel}.`,
          relatedJobId: jobId,
        })
      }

      await fetchAll()
    },
    [fetchAll, myJobs, profileId, profileName, showStateMessage, walkerPosition],
  )

  const startService = useCallback(
    async (jobId: string) => {
      const job = myJobs.find((item) => item.id === jobId)
      if (!job) return
      if (!job.client_arrival_confirmed_at) {
        setError('Wait for the client to confirm arrival before starting.')
        return
      }
      if (hasProviderIssue(job.notes)) {
        setError('Waiting for support review before the service can start.')
        return
      }

      const now = new Date().toISOString()
      const { data, error: startError } = await supabase
        .from('walk_requests')
        .update({ service_started_at: job.service_started_at ?? now })
        .eq('id', jobId)
        .eq('walker_id', profileId)
        .eq('status', 'accepted')
        .not('client_arrival_confirmed_at', 'is', null)
        .select('id')
        .maybeSingle()

      if (startError) {
        setError(startError.message)
        return
      }

      if (!data) {
        setError('Client confirmation is required before starting.')
        return
      }

      const labels = getServiceLabels(job.service_type)
      track(AnalyticsEvent.SERVICE_STARTED, {
        request_id: jobId,
        provider_id: profileId,
        client_id: job.client_id ?? undefined,
        source_screen: 'walker_dashboard',
      })

      showStateMessage(jobId, 'active', labels.startedPast)
      sendClientLiveOrderEvent({
        clientId: job.client_id,
        jobId,
        type: 'start_walk',
        message: labels.startedPast,
        walkerId: profileId,
        walkerName: profileName,
      })
      void createNotification({
        userId: profileId,
        type: 'dispatch_started',
        title: labels.activeTitle,
        message: `${labels.startedPast}. ${labels.completeAction} when the work is done.`,
        relatedJobId: jobId,
      })

      if (job.client_id) {
        const dogLabel = job.dog_name || 'your pet'
        invokeEdgeFunction('send-push-notification', {
          body: {
            title: labels.activeTitle,
            body: `${profileName} has started the service for ${dogLabel}.`,
            targetUserId: job.client_id,
            data: { jobId },
          },
        }).catch((err) => console.error('[Push] Failed to notify client (service_started):', err))
        void createNotification({
          userId: job.client_id,
          type: 'job_accepted',
          title: labels.activeTitle,
          message: `${profileName} has started the service for ${dogLabel}.`,
          relatedJobId: jobId,
        })
      }

      await fetchAll()
    },
    [fetchAll, myJobs, profileId, profileName, showStateMessage],
  )

  const handleComplete = useCallback(
    async (id: string) => {
      setError(null)
      setSuccessMessage(null)

      const job = myJobs.find((j) => j.id === id) ?? completionBlockedJob
      if (job?.booking_timing === 'scheduled' && job.dispatch_state !== 'dispatched') {
        setError('This future order is not ready yet. Completion is available only after dispatch starts.')
        return
      }
      if (!job?.service_started_at) {
        setError('Start the service after client arrival confirmation before completing it.')
        return
      }
      if (isCompletionReviewJob(job)) {
        setError('Issue reported - this service is under review.')
        return
      }

      if (pendingClientConfirmation === id) return

      setCompletingJobId(id)

      try {
        const serviceCompletedAt = job.service_completed_at ?? new Date().toISOString()
        const { error: serviceCompleteError } = await supabase
          .from('walk_requests')
          .update({ service_completed_at: serviceCompletedAt })
          .eq('id', id)
          .eq('walker_id', profileId)
          .eq('status', 'accepted')
          .not('service_started_at', 'is', null)

        if (serviceCompleteError) {
          setError(serviceCompleteError.message)
          return
        }

        setPendingClientConfirmation(id)

        const labels = getServiceLabels(job?.service_type)

        if (job?.client_id) {
          sendClientLiveOrderEvent({
            clientId: job.client_id,
            jobId: id,
            type: 'completion_pending',
            message: labels.completedPast,
            walkerId: profileId,
            walkerName: profileName,
          })

          invokeEdgeFunction('send-push-notification', {
            body: {
              title: 'Confirm Service Completion',
              body: `${profileName} marked the service as complete. Please confirm.`,
              targetUserId: job.client_id,
              data: { jobId: id },
            },
          }).catch((err) => console.error('[Push] Failed to notify client (completion_pending):', err))
          void createNotification({
            userId: job.client_id,
            type: 'job_completed',
            title: 'Service Completed',
            message: `${profileName} marked the service as complete. Please confirm.`,
            relatedJobId: id,
          })
        }

        track(AnalyticsEvent.SERVICE_COMPLETED, {
          request_id: id,
          provider_id: profileId,
          client_id: job?.client_id ?? undefined,
          price: job?.price ?? undefined,
          actor_role: 'provider',
          source_screen: 'walker_dashboard',
        })

        await fetchAll()
      } catch (err) {
        console.error('[handleComplete] Unhandled error:', err)
        try {
          await fetchAll()
        } catch {
          // noop
        }
        setError(err instanceof Error ? err.message : 'Something went wrong. Tap to retry.')
      } finally {
        setCompletingJobId(null)
      }
    },
    [myJobs, completionBlockedJob, pendingClientConfirmation, profileId, profileName, fetchAll],
  )

  const reportIssue = useCallback(
    async (jobId: string): Promise<boolean> => {
      setError(null)

      const { data: jobRow, error: fetchErr } = await supabase
        .from('walk_requests')
        .select('id, notes, client_id, service_started_at, walker_id')
        .eq('id', jobId)
        .maybeSingle()

      if (fetchErr || !jobRow) {
        setError(fetchErr?.message ?? 'Job not found')
        return false
      }

      if (jobRow.service_started_at) {
        setError('Cannot report issue after service has started')
        return false
      }

      if (hasProviderIssue(jobRow.notes)) {
        setSuccessMessage('Issue already reported.')
        return true
      }

      const updatedNotes = appendProviderIssueMarker(jobRow.notes, new Date().toISOString())
      const { error: updateErr } = await supabase
        .from('walk_requests')
        .update({ notes: updatedNotes })
        .eq('id', jobId)

      if (updateErr) {
        setError(updateErr.message)
        return false
      }

      if (jobRow.client_id) {
        await createNotification({
          userId: jobRow.client_id,
          type: 'provider_reported_issue',
          title: 'Issue Reported',
          message: 'Your provider reported an issue and cannot start the service yet. Our support team will follow up.',
          relatedJobId: jobId,
        })
      }

      if (jobRow.walker_id) {
        await createNotification({
          userId: jobRow.walker_id,
          type: 'provider_reported_issue',
          title: 'Issue Reported',
          message: 'Service is paused until support reviews the request.',
          relatedJobId: jobId,
        })
      }

      setSuccessMessage('Issue reported. Support will review.')
      await fetchAll()
      return true
    },
    [fetchAll],
  )

  const handleRelease = useCallback(
    async (id: string) => {
      setError(null)

      const { error } = await supabase
        .from('walk_requests')
        .update({
          status: 'open',
          walker_id: null,
          selected_walker_id: null,
          walker_lat: null,
          walker_lng: null,
          last_location_update: null,
          smart_dispatch_state: 'idle',
        })
        .eq('id', id)

      if (error) {
        setError(error.message)
        return
      }

      setSuccessMessage('Job released.')
      await fetchAll()
    },
    [fetchAll],
  )

  const submitRating = useCallback(
    async (rating: number, review: string) => {
      if (!ratingJobId || rating < 1) return

      const job = myJobs.find((j) => j.id === ratingJobId)
      if (!job) return

      setRatingSubmitting(true)
      const trimmedReview = review.trim()

      const { error } = await supabase.from('ratings').insert({
        job_id: ratingJobId,
        from_user_id: profileId,
        to_user_id: job.client_id,
        rating,
        review: trimmedReview || null,
      })

      if (error) {
        setError(error.message)
        setRatingSubmitting(false)
        return
      }

      track(AnalyticsEvent.REVIEW_SUBMITTED, {
        request_id: ratingJobId,
        provider_id: profileId,
        client_id: job.client_id,
        rating_value: rating,
        has_review: !!trimmedReview,
        actor_role: 'provider',
        source_screen: 'walker_dashboard',
      })

      await createNotification({
        userId: job.client_id,
        type: 'new_rating',
        title: 'New Rating Received',
        message: trimmedReview
          ? `Your walker rated you ${rating} stars: "${trimmedReview}"`
          : `Your walker rated you ${rating} stars for the walk with ${job.dog_name || 'your dog'}.`,
        relatedJobId: ratingJobId,
      })

      invokeEdgeFunction('send-push-notification', {
        body: {
          title: 'New Rating Received',
          body: trimmedReview
            ? `You received a ${rating}-star rating: "${trimmedReview}"`
            : `You received a ${rating}-star rating!`,
          targetUserId: job.client_id,
          data: { jobId: ratingJobId },
        },
      }).catch((err) => console.error('[Push] Failed to notify client (rating):', err))

      setRatingSubmitting(false)
      setRatingJobId(null)
      setSuccessMessage('Rating submitted!')
      await fetchRatings()
    },
    [ratingJobId, myJobs, profileId, fetchRatings],
  )

  const submitCompletionRating = useCallback(
    async (rating: number, review: string) => {
      if (!completionSuccess || rating < 1 || !completionSuccess.clientId) return

      setCompletionRatingSubmitting(true)
      const trimmedReview = review.trim()

      const { error } = await supabase.from('ratings').insert({
        job_id: completionSuccess.jobId,
        from_user_id: profileId,
        to_user_id: completionSuccess.clientId,
        rating,
        review: trimmedReview || null,
      })

      if (error && error.code !== '23505') {
        setError(error.message)
      } else {
        track(AnalyticsEvent.REVIEW_SUBMITTED, {
          request_id: completionSuccess.jobId,
          provider_id: profileId,
          client_id: completionSuccess.clientId,
          rating_value: rating,
          has_review: !!trimmedReview,
          actor_role: 'provider',
          source_screen: 'walker_dashboard',
        })

        await createNotification({
          userId: completionSuccess.clientId,
          type: 'new_rating',
          title: 'New Rating Received',
          message: trimmedReview
            ? `Your walker rated you ${rating} stars: "${trimmedReview}"`
            : `Your walker rated you ${rating} stars for the walk with ${completionSuccess.dogName}.`,
          relatedJobId: completionSuccess.jobId,
        }).catch(() => {})

        invokeEdgeFunction('send-push-notification', {
          body: {
            title: 'New Rating Received',
            body: trimmedReview
              ? `You received a ${rating}-star rating: "${trimmedReview}"`
              : `You received a ${rating}-star rating!`,
            targetUserId: completionSuccess.clientId,
            data: { jobId: completionSuccess.jobId },
          },
        }).catch((err) => console.error('[Push] Failed to notify client (rating):', err))
      }

      setCompletionRatingSubmitting(false)
      flowCompletedJobIdsRef.current.delete(completionSuccess.jobId)
      setCompletionSuccess(null)
      await fetchRatings()
    },
    [completionSuccess, profileId, fetchRatings],
  )

  const openRatingModal = useCallback((jobId: string) => setRatingJobId(jobId), [])
  const closeRatingModal = useCallback(() => setRatingJobId(null), [])
  const dismissCompletion = useCallback(() => {
    setCompletionSuccess((current) => {
      if (current) {
        dismissedCompletionIdsRef.current.add(current.jobId)
        flowCompletedJobIdsRef.current.delete(current.jobId)
        try {
          window.localStorage.setItem(
            completionDismissStorageKey(profileId),
            JSON.stringify(Array.from(dismissedCompletionIdsRef.current)),
          )
        } catch {
          // noop
        }
      }
      return null
    })
  }, [profileId])
  const dismissReviewRequired = useCallback(() => {
    if (!reviewRequiredJob) return
    const nextIds = new Set(dismissedReviewRequiredIds)
    nextIds.add(reviewRequiredJob.id)
    persistDismissedReviewRequiredIds(nextIds)
    setPendingClientConfirmation((prev) => (prev === reviewRequiredJob.id ? null : prev))
    setSuccessMessage(null)
  }, [
    reviewRequiredJob,
    dismissedReviewRequiredIds,
    persistDismissedReviewRequiredIds,
  ])
  const clearError = useCallback(() => setError(null), [])
  const clearSuccess = useCallback(() => setSuccessMessage(null), [])
  const dismissTakenNotice = useCallback(() => setTakenNotice(false), [])

  const handleConnectAccount = useCallback(async () => {
    setConnectError(null)
    setConnectLoading(true)
    try {
      const hasAuth = await prepareEdgeFunctionAuth()
      if (!hasAuth) {
        setConnectError('Authentication issue. Please refresh and try again.')
        setConnectLoading(false)
        return
      }

      const { data: acctData, error: acctErr } = await invokeEdgeFunction<{ accountId?: string; error?: string }>('create-connect-account')
      if (acctErr) {
        setConnectError(acctErr || 'Failed to create connect account')
        setConnectLoading(false)
        return
      }
      const acct = acctData as { accountId?: string; error?: string } | null
      if (!acct?.accountId) {
        setConnectError(acct?.error || 'Failed to create connect account')
        setConnectLoading(false)
        return
      }

      const { data: linkData, error: linkErr } = await invokeEdgeFunction<{ url?: string; error?: string }>(
        'create-connect-onboarding-link',
        {
          body: {
            useNativeDeepLink: Capacitor.isNativePlatform(),
          },
        },
      )
      if (linkErr) {
        setConnectError(linkErr || 'Failed to get onboarding link')
        setConnectLoading(false)
        return
      }
      const link = linkData as { url?: string; error?: string } | null
      if (!link?.url) {
        setConnectError(link?.error || 'Failed to get onboarding link')
        setConnectLoading(false)
        return
      }

      window.location.href = link.url
    } catch {
      setConnectError('Failed to start onboarding')
      setConnectLoading(false)
    }
  }, [])

  const handleContinueOnboarding = useCallback(async () => {
    setConnectError(null)
    setConnectLoading(true)
    try {
      const hasAuth = await prepareEdgeFunctionAuth()
      if (!hasAuth) {
        setConnectError('Authentication issue. Please refresh and try again.')
        setConnectLoading(false)
        return
      }

      const { data, error } = await invokeEdgeFunction<{ url?: string; error?: string }>(
        'create-connect-onboarding-link',
        {
          body: {
            useNativeDeepLink: Capacitor.isNativePlatform(),
          },
        },
      )
      if (error) {
        setConnectError(error || 'Failed to get onboarding link')
        setConnectLoading(false)
        return
      }
      const link = data as { url?: string; error?: string } | null
      if (!link?.url) {
        setConnectError(link?.error || 'Failed to get onboarding link')
        setConnectLoading(false)
        return
      }

      window.location.href = link.url
    } catch {
      setConnectError('Failed to continue onboarding')
      setConnectLoading(false)
    }
  }, [])

  const recentJobs = useMemo(() => completedJobs.slice(0, 2), [completedJobs])
  const recentRatings = useMemo(() => ratingsReceived.slice(0, 2), [ratingsReceived])

  return {
    screenState,
    firstName,
    avgRating,
    ratingsReceived,
    ratingsGiven,

    openJobs: visibleOpenJobs,
    activeOffers,
    activeJob: activeJobs[0] ?? null,
    activeJobs,
    onTheWayJobs,
    futureJobs,
    reviewRequiredJob,
    reviewRequiredJobs,
    completedJobs,
    recentJobs,
    recentRatings,
    ratedJobIds,

    loading,
    error,
    successMessage,
    clearError,
    clearSuccess,

    wallet,

    connectStatus,
    connectLoading,
    connectError,
    stripeReadyForOnline: isStripeReadyForOnline(connectStatus),
    handleConnectAccount,
    handleContinueOnboarding,
    fetchConnectStatus,

    completingJobId,
    pendingClientConfirmation,
    reviewRequiredJobIds: new Set(
      myJobs.filter((job) => isCompletionReviewJob(job)).map((job) => job.id),
    ),
    dismissReviewRequired,
    completionSuccess,
    completionPaymentError,
    completionRatingSubmitting,
    dismissCompletion,
    submitCompletionRating,

    ratingJobId,
    ratingSubmitting,
    openRatingModal,
    closeRatingModal,
    submitRating,

    isOnline,
    onlineLoading,
    toggleOnline,

    takenNotice,
    dismissTakenNotice,

    walkerPosition,
    screenPhase,

    startsInMinutes,

    handleAccept,
    handleDecline,
    markArrived,
    startService,
    unassignFutureJob,
    handleComplete,
    handleRelease,
    reportIssue,
  }
}
