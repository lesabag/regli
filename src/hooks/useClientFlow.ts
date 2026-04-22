import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase, invokeEdgeFunction } from '../services/supabaseClient'
import { startDispatch } from '../lib/startDispatch'
import { useJobTracking } from './useJobTracking'
import { createNotification } from '../components/NotificationsBell'
import { formatShortAddress } from '../utils/addressFormat'

type ScreenState = 'idle' | 'searching' | 'accepted' | 'tracking' | 'active'
type GpsQuality = 'live' | 'delayed' | 'offline' | 'last_known'
type ProximityLevel = 'far' | 'near' | 'arrived' | 'very_near' | 'arriving'
type SurgeLevel = 'normal' | 'busy' | 'very_busy'

type SavedCard = {
  id: string
  brand: string
  last4: string
  expMonth?: number
  expYear?: number
} | null

type PaymentMethodsResponse = {
  customerId?: string
  cards?: Array<{
    id: string
    brand: string
    last4: string
    expMonth?: number
    expYear?: number
  }>
  clientSecret?: string
}

type CompletionJob = {
  jobId: string
  walkerName: string
  walkerId: string | null
} | null

type LiveOrderEventPayload = {
  jobId?: string
  type?: 'accepted' | 'started' | 'start_walk' | 'complete' | 'completed'
  message?: string
  walkerId?: string | null
  walkerName?: string | null
}

type WalkRequestRow = {
  id: string
  client_id: string
  walker_id: string | null
  selected_walker_id: string | null
  status: 'awaiting_payment' | 'open' | 'accepted' | 'completed' | 'cancelled' | string
  dog_name: string | null
  location: string | null
  address?: string | null
  price: number | null
  scheduled_fee_snapshot: number | null
  duration_minutes: number | null
  requested_window_minutes?: number | null
  booking_timing: 'asap' | 'scheduled' | null
  scheduled_for: string | null
  dispatch_state: 'queued' | 'dispatched' | 'expired' | 'cancelled' | null
  smart_dispatch_state?: 'idle' | 'dispatching' | 'assigned' | 'exhausted' | 'cancelled' | null
  walker_lat: number | null
  walker_lng: number | null
  last_location_update: string | null
  payment_status?: 'unpaid' | 'authorized' | 'paid' | 'failed' | 'refunded' | string | null
  paid_at?: string | null
  created_at?: string | null
  completed_at?: string | null
}

type RatingRow = {
  id: string
  job_id: string
  from_user_id: string
  to_user_id: string
  rating: number
  review: string | null
  created_at: string
}

type QueryResult<T> = {
  data: T | null
  error: { message: string } | null
}

const JOB_SELECT =
  'id, client_id, walker_id, selected_walker_id, status, dog_name, location, address, price, scheduled_fee_snapshot, duration_minutes, requested_window_minutes, booking_timing, scheduled_for, dispatch_state, smart_dispatch_state, walker_lat, walker_lng, last_location_update, payment_status, paid_at, created_at'

const COMPLETION_PROMPT_RECENT_MS = 30 * 60 * 1000
const CANCEL_SUPPRESS_MS = 2 * 60 * 1000


function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function toLocalDatetimeInputValue(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`
}

function getNowPlus15LocalInput(): string {
  return toLocalDatetimeInputValue(new Date(Date.now() + 15 * 60 * 1000))
}

function parseWallClockDate(value: string | null | undefined): Date | null {
  if (!value || typeof value !== 'string') return null

  const normalized = value.trim().replace(' ', 'T')
  const hasExplicitTimezone = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(normalized)

  if (hasExplicitTimezone) {
    const isoLike = normalized.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')
    const dt = new Date(isoLike)
    return Number.isNaN(dt.getTime()) ? null : dt
  }

  const match = normalized.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/,
  )

  if (!match) return null

  const [, year, month, day, hour, minute, second] = match
  const dt = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second || '0'),
    0,
  )

  return Number.isNaN(dt.getTime()) ? null : dt
}

function formatScheduledSummaryValue(value: string | null | undefined): string {
  const dt = parseWallClockDate(value)
  if (!dt) return ''
  return dt.toLocaleString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function settledQuery<T>(
  result: PromiseSettledResult<QueryResult<T>>,
  label: string,
): QueryResult<T> {
  if (result.status === 'fulfilled') return result.value

  const message = result.reason instanceof Error ? result.reason.message : String(result.reason)
  console.warn(`[useClientFlow] ${label} query failed:`, message)
  return { data: null, error: { message } }
}

function completionDismissStorageKey(profileId: string): string {
  return `regli_client_completion_dismissed_${profileId}`
}

function startedWalkStorageKey(profileId: string): string {
  return `regli_client_started_walks_${profileId}`
}

function getLifecycleEventRank(type: 'accepted' | 'start_walk' | 'complete'): number {
  if (type === 'complete') return 3
  if (type === 'start_walk') return 2
  return 1
}

function getJobEventTime(job: WalkRequestRow): number {
  const value = job.paid_at ?? job.created_at ?? null
  if (!value) return 0
  const ts = new Date(value).getTime()
  return Number.isNaN(ts) ? 0 : ts
}

function getCreatedTime(job: Pick<WalkRequestRow, 'created_at'>): number {
  if (!job.created_at) return 0
  const ts = new Date(job.created_at).getTime()
  return Number.isNaN(ts) ? 0 : ts
}

function isActiveUiCandidate(job: WalkRequestRow): boolean {
  if (!isCurrentClientJob(job)) return false
  if (job.status !== 'awaiting_payment' && job.status !== 'open' && job.status !== 'accepted') return false
  if (job.dispatch_state === 'cancelled' || job.dispatch_state === 'expired') return false
  if (job.smart_dispatch_state === 'cancelled' || job.smart_dispatch_state === 'exhausted') return false
  if (job.payment_status === 'failed' || job.payment_status === 'refunded') return false
  return true
}

function getNewestActiveRequest(
  rows: WalkRequestRow[],
  suppressedIds: Map<string, number>,
  staleCutoff: number,
): WalkRequestRow | null {
  const now = Date.now()
  const candidates = rows
    .filter(isActiveUiCandidate)
    .filter((job) => {
      const suppressedAt = suppressedIds.get(job.id)
      if (suppressedAt && now - suppressedAt < CANCEL_SUPPRESS_MS) return false
      if (getCreatedTime(job) <= staleCutoff) return false
      return true
    })
    .sort((a, b) => getCreatedTime(b) - getCreatedTime(a))

  return candidates[0] ?? null
}

function isRecentCompletion(job: WalkRequestRow): boolean {
  const ts = getJobEventTime(job)
  if (!ts) return false
  return Date.now() - ts <= COMPLETION_PROMPT_RECENT_MS
}

function getCompletionPromptJob(
  completed: WalkRequestRow[],
  ratedJobIds: Set<string>,
  dismissedJobIds: Set<string>,
  flowCompletedJobIds: Set<string>,
): WalkRequestRow | null {
  return (
    completed
      .filter(
        (job) =>
          job.status === 'completed' &&
          !!job.walker_id &&
          (isRecentCompletion(job) || flowCompletedJobIds.has(job.id)) &&
          !ratedJobIds.has(job.id) &&
          !dismissedJobIds.has(job.id),
      )
      .sort((a, b) => getJobEventTime(b) - getJobEventTime(a))[0] ?? null
  )
}


type LastBookingDraft = {
  dogName: string
  location: string
  duration: '20min' | '40min' | '60min'
}

function bookingDraftStorageKey(profileId: string): string {
  return `regli_client_last_booking_${profileId}`
}

function isFutureScheduledJob(job: WalkRequestRow): boolean {
  if (job.booking_timing !== 'scheduled') return false
  if (job.status === 'completed' || job.status === 'cancelled') return false
  return job.dispatch_state !== 'dispatched'
}

function isCurrentClientJob(job: WalkRequestRow): boolean {
  if (job.booking_timing !== 'scheduled') return true
  return job.dispatch_state === 'dispatched'
}

function normalizeClientScreen(job: WalkRequestRow | null): ScreenState {
  if (!job) return 'idle'

  if (job.status === 'accepted') {
    if (job.booking_timing === 'scheduled' && job.dispatch_state !== 'dispatched') {
      return 'idle'
    }
    return 'tracking'
  }

  if (job.status === 'open' || job.status === 'awaiting_payment') {
    if (job.booking_timing === 'scheduled' && job.dispatch_state !== 'dispatched') {
      return 'idle'
    }
    return 'searching'
  }

  return 'idle'
}

export function useClientFlow(profileId: string, _profileName: string) {
  const [screenState, setScreenState] = useState<ScreenState>('idle')
  const [searchStartTime, setSearchStartTime] = useState<number | null>(null)
  const [currentJobId, setCurrentJobId] = useState<string | null>(null)
  const [currentJob, setCurrentJob] = useState<WalkRequestRow | null>(null)

  const [dogName, _setDogName] = useState('')
  const [location, _setLocation] = useState('')
  const [duration, _setDuration] = useState<'20min' | '40min' | '60min'>('20min')

  const [bookingTiming, setBookingTiming] = useState<'asap' | 'scheduled'>('asap')
  const [scheduledFor, setScheduledFor] = useState<string | null>(getNowPlus15LocalInput())
  const scheduledMinInput = getNowPlus15LocalInput()

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  const [gpsQualityBase, setGpsQualityBase] = useState<GpsQuality>('live')
  const [completionJob, setCompletionJob] = useState<CompletionJob>(null)
  const [completionRatingSubmitting, setCompletionRatingSubmitting] = useState(false)

  const [userLocationBase, setUserLocationBase] = useState<[number, number] | null>(null)
  const [locationLoading, setLocationLoading] = useState(true)
  const [walkerNameById, setWalkerNameById] = useState<Map<string, string>>(new Map())
  const [upcomingJobs, setUpcomingJobs] = useState<WalkRequestRow[]>([])
  const [completedJobs, setCompletedJobs] = useState<Array<WalkRequestRow & { hidden_by_client?: boolean }>>([])
  const [ratings, setRatings] = useState<RatingRow[]>([])
  const [ratingsReceived, setRatingsReceived] = useState<RatingRow[]>([])
  const [hiddenHistoryIds, setHiddenHistoryIds] = useState<Set<string>>(new Set())

  const acceptNotifiedRef = useRef<Set<string>>(new Set())
  const arriveNotifiedRef = useRef<Set<string>>(new Set())
  const completeNotifiedRef = useRef<Set<string>>(new Set())
  const liveEventNotifiedRef = useRef<Set<string>>(new Set())
  const lifecycleEventRankRef = useRef<Map<string, number>>(new Map())
  const dismissedCompletionIdsRef = useRef<Set<string>>(new Set())
  const suppressedActiveRequestIdsRef = useRef<Map<string, number>>(new Map())
  const staleActiveCutoffRef = useRef(0)
  const flowCompletedJobIdsRef = useRef<Set<string>>(new Set())
  const startedWalkIdsRef = useRef<Set<string>>(new Set())
  const lastActiveJobIdRef = useRef<string | null>(null)

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
      const raw = window.localStorage.getItem(startedWalkStorageKey(profileId))
      const parsed = raw ? (JSON.parse(raw) as string[]) : []
      startedWalkIdsRef.current = new Set(Array.isArray(parsed) ? parsed : [])
    } catch {
      startedWalkIdsRef.current = new Set()
    }
  }, [profileId])

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(`regli_client_history_hidden_${profileId}`)
      if (!raw) return
      const parsed = JSON.parse(raw) as string[]
      if (Array.isArray(parsed)) setHiddenHistoryIds(new Set(parsed))
    } catch {
      // noop
    }
  }, [profileId])

  useEffect(() => {
    if (!navigator.geolocation) {
      setGpsQualityBase('offline')
      setLocationLoading(false)
      return
    }

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = pos.coords.latitude
        const lng = pos.coords.longitude

        setUserLocationBase([lat, lng])
        setGpsQualityBase('live')

        try {
          const res = await fetch(
            `https://nominatim.openstreetmap.org/reverse?format=json&addressdetails=1&lat=${lat}&lon=${lng}`,
          )
          const data = await res.json()
          const address =
            formatShortAddress(data?.display_name, data?.address) ||
            data?.display_name ||
            `${lat.toFixed(4)}, ${lng.toFixed(4)}`
          _setLocation((prev) => prev || address)
        } catch {
          _setLocation((prev) => prev || `${lat.toFixed(4)}, ${lng.toFixed(4)}`)
        }

        setLocationLoading(false)
      },
      () => {
        setGpsQualityBase('offline')
        setLocationLoading(false)
      },
      { enableHighAccuracy: true },
    )
  }, [])

  const clearError = useCallback(() => setError(null), [])
  const clearSuccess = useCallback(() => setSuccessMessage(null), [])

  const showLifecycleBanner = useCallback(
    (jobId: string, type: 'accepted' | 'start_walk' | 'complete', message: string) => {
      const nextRank = getLifecycleEventRank(type)
      const currentRank = lifecycleEventRankRef.current.get(jobId) ?? 0
      if (nextRank < currentRank) return

      lifecycleEventRankRef.current.set(jobId, nextRank)
      setSuccessMessage(null)
      window.setTimeout(() => {
        setSuccessMessage(message)
      }, 0)
    },
    [],
  )


  const persistBookingDraft = useCallback(
    (patch: Partial<LastBookingDraft>) => {
      try {
        const key = bookingDraftStorageKey(profileId)
        const currentRaw = window.localStorage.getItem(key)
        const current = currentRaw ? (JSON.parse(currentRaw) as Partial<LastBookingDraft>) : {}
        const next: LastBookingDraft = {
          dogName:
            typeof patch.dogName === 'string'
              ? patch.dogName
              : typeof current.dogName === 'string'
                ? current.dogName
                : '',
          location:
            typeof patch.location === 'string'
              ? patch.location
              : typeof current.location === 'string'
                ? current.location
                : '',
          duration:
            patch.duration === '20min' || patch.duration === '40min' || patch.duration === '60min'
              ? patch.duration
              : current.duration === '20min' || current.duration === '40min' || current.duration === '60min'
                ? current.duration
                : '20min',
        }
        window.localStorage.setItem(key, JSON.stringify(next))
      } catch {
        // noop
      }
    },
    [profileId],
  )

  const setDogName = useCallback(
    (value: string) => {
      _setDogName(value)
      persistBookingDraft({ dogName: value })
    },
    [persistBookingDraft],
  )

  const setLocation = useCallback(
    (value: string) => {
      _setLocation(value)
      persistBookingDraft({ location: value })
    },
    [persistBookingDraft],
  )

  const setDuration = useCallback(
    (value: '20min' | '40min' | '60min') => {
      _setDuration(value)
      persistBookingDraft({ duration: value })
    },
    [persistBookingDraft],
  )

  const [savedCard, setSavedCard] = useState<SavedCard>(null)
  const [stripeCustomerId, setStripeCustomerId] = useState<string | null>(null)
  const [setupClientSecret, setSetupClientSecret] = useState<string | null>(null)
  const [cardLoading, setCardLoading] = useState(true)
  const [cardError, setCardError] = useState(false)

  const hasUserLocationBase = !!userLocationBase
  const avgRating = useMemo(() => {
    if (ratingsReceived.length === 0) return null
    const sum = ratingsReceived.reduce((acc, r) => acc + r.rating, 0)
    return Math.round((sum / ratingsReceived.length) * 10) / 10
  }, [ratingsReceived])
  const scheduledSummary = formatScheduledSummaryValue(scheduledFor)

  const surgeMultiplier = 1
  const surgeLevel: SurgeLevel = 'normal'

  const elapsedSeconds = searchStartTime ? Math.floor((Date.now() - searchStartTime) / 1000) : 0

  const selectedDuration = { label: duration }
  const adjustedPriceILS = duration === '20min' ? 36 : duration === '40min' ? 60 : 80

  const ratedJobIds = useMemo(() => new Set(ratings.map((r) => r.job_id)), [ratings])

  function durationToMinutes(value: '20min' | '40min' | '60min'): number {
    if (value === '20min') return 20
    if (value === '40min') return 40
    return 60
  }

  const startsInMinutes = useCallback((date: string | null | undefined) => {
    const dt = parseWallClockDate(date)
    if (!dt) return null
    return Math.max(0, Math.floor((dt.getTime() - Date.now()) / 60000))
  }, [])

  const persistHiddenHistory = useCallback(
    (next: Set<string>) => {
      setHiddenHistoryIds(new Set(next))
      try {
        window.localStorage.setItem(
          `regli_client_history_hidden_${profileId}`,
          JSON.stringify(Array.from(next)),
        )
      } catch {
        // noop
      }
    },
    [profileId],
  )

  const loadPaymentMethods = useCallback(async () => {
    setCardLoading(true)
    setCardError(false)
    try {
      const { data, error: paymentError } = await invokeEdgeFunction<PaymentMethodsResponse>(
        'manage-payment-method',
        { body: { action: 'get-or-create-customer' } },
      )

      if (paymentError) {
        throw new Error(paymentError)
      }

      const firstCard = data?.cards?.[0] ?? null
      setStripeCustomerId(data?.customerId ?? null)
      setSavedCard(firstCard)
    } catch (err) {
      console.warn('[useClientFlow] payment method load failed:', err instanceof Error ? err.message : err)
      setCardError(true)
      setSavedCard(null)
    } finally {
      setCardLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadPaymentMethods()
  }, [loadPaymentMethods])

  const hideHistoryItem = useCallback(
    async (id: string) => {
      const next = new Set(hiddenHistoryIds)
      next.add(id)
      persistHiddenHistory(next)
      setCompletedJobs((prev) =>
        prev.map((job) => (job.id === id ? { ...job, hidden_by_client: true } : job)),
      )
    },
    [hiddenHistoryIds, persistHiddenHistory],
  )

  const loadWalkerName = useCallback(
    async (walkerId: string | null | undefined) => {
      if (!walkerId) return
      if (walkerNameById.has(walkerId)) return

      const { data } = await supabase
        .from('profiles')
        .select('full_name, email')
        .eq('id', walkerId)
        .maybeSingle()

      const label = data?.full_name || data?.email || 'Walker'
      setWalkerNameById((prev) => {
        const next = new Map(prev)
        next.set(walkerId, label)
        return next
      })
    },
    [walkerNameById],
  )

  const trackingJobId =
    currentJob &&
    currentJob.status === 'accepted' &&
    (screenState === 'tracking' || screenState === 'active')
      ? currentJob.id
      : null

  const {
    walkerLocation: trackedWalkerLocation,
    walkerBearing,
    userLocation: trackingUserLocation,
    hasUserLocation: trackingHasUserLocation,
    etaMinutes,
    displayEtaSeconds,
    isArrived,
    gpsQuality: trackingGpsQualityRaw,
    distanceMeters,
    proximityLevel: trackingProximityLevel,
    routePolyline,
  } = useJobTracking(trackingJobId)

  const fallbackWalkerLocation = useMemo<[number, number] | null>(() => {
    if (!currentJob || currentJob.walker_lat == null || currentJob.walker_lng == null) return null
    return [currentJob.walker_lat, currentJob.walker_lng]
  }, [currentJob])

  const walkerLocation = trackedWalkerLocation ?? fallbackWalkerLocation
  const userLocation =
    trackingHasUserLocation && trackingUserLocation
      ? trackingUserLocation
      : userLocationBase ?? ([32.0853, 34.7818] as [number, number])

  const hasUserLocation = trackingHasUserLocation || hasUserLocationBase
  const gpsQuality: GpsQuality =
    trackingGpsQualityRaw === 'none' ? gpsQualityBase : (trackingGpsQualityRaw as GpsQuality)

  const proximityLevel: ProximityLevel =
    trackingProximityLevel === 'very_near' || trackingProximityLevel === 'arriving'
      ? trackingProximityLevel
      : (trackingProximityLevel as ProximityLevel)

  const activeJob =
    currentJob &&
    currentJob.status === 'accepted' &&
    (screenState === 'accepted' || screenState === 'tracking' || screenState === 'active')
      ? currentJob
      : null

  const persistStartedWalkIds = useCallback(
    (next: Set<string>) => {
      startedWalkIdsRef.current = next
      try {
        window.localStorage.setItem(startedWalkStorageKey(profileId), JSON.stringify(Array.from(next)))
      } catch {
        // noop
      }
    },
    [profileId],
  )

  const clearActiveState = useCallback(() => {
    setScreenState('idle')
    setCurrentJob(null)
    setCurrentJobId(null)
    setSearchStartTime(null)
  }, [])

  const fetchCurrentAndLists = useCallback(async () => {
    const [
      currentResult,
      upcomingResult,
      completedResult,
      ratingsResult,
      ratingsReceivedResult,
    ] = await Promise.allSettled([
      supabase
        .from('walk_requests')
        .select(JOB_SELECT)
        .eq('client_id', profileId)
        .in('status', ['awaiting_payment', 'open', 'accepted'])
        .or('booking_timing.is.null,booking_timing.eq.asap,dispatch_state.eq.dispatched')
        .order('created_at', { ascending: false })
        .limit(10),
      supabase
        .from('walk_requests')
        .select(JOB_SELECT)
        .eq('client_id', profileId)
        .eq('booking_timing', 'scheduled')
        .in('status', ['open', 'accepted', 'awaiting_payment'])
        .order('scheduled_for', { ascending: true }),
      supabase
        .from('walk_requests')
        .select(JOB_SELECT)
        .eq('client_id', profileId)
        .in('status', ['completed', 'cancelled'])
        .order('created_at', { ascending: false })
        .limit(50),
      supabase
        .from('ratings')
        .select('*')
        .eq('from_user_id', profileId)
        .order('created_at', { ascending: false }),
      supabase
        .from('ratings')
        .select('*')
        .eq('to_user_id', profileId)
        .order('created_at', { ascending: false }),
    ])

    const currentRes = settledQuery<WalkRequestRow[]>(currentResult, 'current request')
    const upcomingRes = settledQuery<WalkRequestRow[]>(upcomingResult, 'upcoming requests')
    const completedRes = settledQuery<WalkRequestRow[]>(completedResult, 'completed requests')
    const ratingsRes = settledQuery<RatingRow[]>(ratingsResult, 'ratings given')
    const ratingsReceivedRes = settledQuery<RatingRow[]>(ratingsReceivedResult, 'ratings received')

    if (currentRes.error) {
      console.warn('[useClientFlow] current request unavailable:', currentRes.error.message)
    }
    if (upcomingRes.error) {
      console.warn('[useClientFlow] upcoming requests unavailable:', upcomingRes.error.message)
    }
    if (completedRes.error) {
      console.warn('[useClientFlow] completed requests unavailable:', completedRes.error.message)
    }
    if (ratingsRes.error) {
      console.warn('[useClientFlow] ratings given unavailable:', ratingsRes.error.message)
    }
    if (ratingsReceivedRes.error) {
      console.warn('[useClientFlow] ratings received unavailable:', ratingsReceivedRes.error.message)
    }

    if (currentRes.error) {
      // Preserve the current UI state on transient read failures.
    } else {
      const currentRows = (currentRes.data as WalkRequestRow[] | null) ?? []
      const row = getNewestActiveRequest(
        currentRows,
        suppressedActiveRequestIdsRef.current,
        staleActiveCutoffRef.current,
      )

      if (!row) {
        clearActiveState()
      } else {
        setCurrentJob(row)
        setCurrentJobId(row.id)
        lastActiveJobIdRef.current = row.id
        if (row.walker_id) void loadWalkerName(row.walker_id)
        setScreenState(
          row.status === 'accepted' && startedWalkIdsRef.current.has(row.id)
            ? 'active'
            : normalizeClientScreen(row),
        )
        if (row.status === 'accepted') {
          setSearchStartTime(null)
        } else if ((row.status === 'open' || row.status === 'awaiting_payment') && isCurrentClientJob(row)) {
          setSearchStartTime((prev) => prev ?? Date.now())
        }
      }
    }

    const upcoming = ((upcomingRes.data as WalkRequestRow[] | null) ?? []).filter(isFutureScheduledJob)
    setUpcomingJobs(upcoming)

    const completed = ((completedRes.data as WalkRequestRow[] | null) ?? []).map((job) => ({
      ...job,
      hidden_by_client: hiddenHistoryIds.has(job.id),
    }))
    const lastActiveCompleted = completed.find(
      (job) => job.status === 'completed' && job.id === lastActiveJobIdRef.current,
    )
    if (lastActiveCompleted) {
      flowCompletedJobIdsRef.current.add(lastActiveCompleted.id)
    }
    setCompletedJobs(completed)

    const nextRatings = (ratingsRes.data as RatingRow[] | null) ?? []
    setRatings(nextRatings)
    setRatingsReceived((ratingsReceivedRes.data as RatingRow[] | null) ?? [])

    const nextRatedJobIds = new Set(nextRatings.map((r) => r.job_id))
    const pendingCompletion = getCompletionPromptJob(
      completed,
      nextRatedJobIds,
      dismissedCompletionIdsRef.current,
      flowCompletedJobIdsRef.current,
    )

    if (pendingCompletion) {
      const walkerLabel = pendingCompletion.walker_id
        ? walkerNameById.get(pendingCompletion.walker_id) || 'Walker'
        : 'Walker'
      setCompletionJob((prev) => {
        const next = {
          jobId: pendingCompletion.id,
          walkerId: pendingCompletion.walker_id,
          walkerName: walkerLabel,
        }
        if (
          prev?.jobId === next.jobId &&
          prev.walkerId === next.walkerId &&
          prev.walkerName === next.walkerName
        ) {
          return prev
        }
        return next
      })
    } else {
      setCompletionJob((prev) => {
        if (
          prev &&
          flowCompletedJobIdsRef.current.has(prev.jobId) &&
          !nextRatedJobIds.has(prev.jobId) &&
          !dismissedCompletionIdsRef.current.has(prev.jobId)
        ) {
          return prev
        }
        return null
      })
    }

    const walkerIds = new Set<string>()
    for (const row of [
      ...upcoming,
      ...completed,
      ...(((currentRes.data as WalkRequestRow[] | null) ?? [])),
    ]) {
      if (row.walker_id) walkerIds.add(row.walker_id)
    }
    walkerIds.forEach((id) => {
      void loadWalkerName(id)
    })
  }, [profileId, loadWalkerName, hiddenHistoryIds, clearActiveState])

  useEffect(() => {
    void fetchCurrentAndLists()
  }, [fetchCurrentAndLists])

  useEffect(() => {
    const refresh = () => {
      void fetchCurrentAndLists()
    }

    const pollId = window.setInterval(refresh, 5000)

    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refresh()
    }

    window.addEventListener('focus', refresh)
    window.addEventListener('pageshow', refresh)
    document.addEventListener('visibilitychange', refreshWhenVisible)

    return () => {
      window.clearInterval(pollId)
      window.removeEventListener('focus', refresh)
      window.removeEventListener('pageshow', refresh)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [fetchCurrentAndLists])

  useEffect(() => {
    const channel = supabase
      .channel(`client-flow-${profileId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'walk_requests', filter: `client_id=eq.${profileId}` },
        (payload) => {
          const updated = (payload.new ?? null) as WalkRequestRow | null
          if (!updated) return

          if (updated.walker_id) {
            void loadWalkerName(updated.walker_id)
          }

          const isSuppressed =
            !!suppressedActiveRequestIdsRef.current.get(updated.id) ||
            getCreatedTime(updated) <= staleActiveCutoffRef.current
          const nextState = normalizeClientScreen(updated)

          if (
            (updated.status === 'open' || updated.status === 'awaiting_payment') &&
            isCurrentClientJob(updated) &&
            !isSuppressed &&
            currentJobId === updated.id
          ) {
            setCurrentJob(updated)
            setCurrentJobId(updated.id)
            lastActiveJobIdRef.current = updated.id
            setSearchStartTime((prev) => prev ?? Date.now())
            setScreenState(nextState)
          }

          if (updated.status === 'accepted' && !isSuppressed && currentJobId === updated.id) {
            setCurrentJob(updated)
            setCurrentJobId(updated.id)
            lastActiveJobIdRef.current = updated.id
            setSearchStartTime(null)
            setScreenState(startedWalkIdsRef.current.has(updated.id) ? 'active' : nextState)

            if (!acceptNotifiedRef.current.has(updated.id)) {
              acceptNotifiedRef.current.add(updated.id)
              const walkerLabel = updated.walker_id
                ? walkerNameById.get(updated.walker_id) || 'Walker'
                : 'Walker'
              showLifecycleBanner(
                updated.id,
                'accepted',
                `${walkerLabel} accepted your request and is heading to you${updated.dog_name ? ` for ${updated.dog_name}` : ''}.`,
              )
            }
          }

          if (updated.status === 'completed') {
            const belongsToCurrentFlow =
              updated.id === currentJobId || updated.id === lastActiveJobIdRef.current

            if (belongsToCurrentFlow) {
              flowCompletedJobIdsRef.current.add(updated.id)
              const nextStarted = new Set(startedWalkIdsRef.current)
              nextStarted.delete(updated.id)
              persistStartedWalkIds(nextStarted)
              clearActiveState()
            }

            if (!completeNotifiedRef.current.has(updated.id)) {
              completeNotifiedRef.current.add(updated.id)
              showLifecycleBanner(
                updated.id,
                'complete',
                `Walk completed${updated.dog_name ? ` for ${updated.dog_name}` : ''}.`,
              )
            }

            if (
              belongsToCurrentFlow &&
              updated.walker_id &&
              !ratedJobIds.has(updated.id) &&
              !dismissedCompletionIdsRef.current.has(updated.id)
            ) {
              const walkerLabel = walkerNameById.get(updated.walker_id) || 'Walker'
              setCompletionJob({
                jobId: updated.id,
                walkerId: updated.walker_id,
                walkerName: walkerLabel,
              })
            }
          }

          if (updated.status === 'cancelled') {
            if (updated.id === currentJobId) {
              clearActiveState()
            }
          }

          void fetchCurrentAndLists()
        },
      )
      .on(
        'broadcast',
        { event: 'live_order_event' },
        (payload) => {
          const event = payload.payload as LiveOrderEventPayload | null
          if (!event?.jobId || !event.type) return

          const key = `${event.type}:${event.jobId}`
          if (liveEventNotifiedRef.current.has(key)) return
          liveEventNotifiedRef.current.add(key)

          if (event.type === 'started' || event.type === 'start_walk') {
            const nextStarted = new Set(startedWalkIdsRef.current)
            nextStarted.add(event.jobId)
            persistStartedWalkIds(nextStarted)
            if (event.jobId === currentJobId || event.jobId === lastActiveJobIdRef.current) {
              setScreenState('active')
            }
            showLifecycleBanner(event.jobId, 'start_walk', event.message || 'Walk has started.')
          } else if (event.type === 'accepted') {
            showLifecycleBanner(
              event.jobId,
              'accepted',
              event.message || 'Walker accepted your request and is heading to you.',
            )
          } else if (event.type === 'complete' || event.type === 'completed') {
            flowCompletedJobIdsRef.current.add(event.jobId)
            const nextStarted = new Set(startedWalkIdsRef.current)
            nextStarted.delete(event.jobId)
            persistStartedWalkIds(nextStarted)
            if (!completeNotifiedRef.current.has(event.jobId)) {
              completeNotifiedRef.current.add(event.jobId)
              showLifecycleBanner(event.jobId, 'complete', event.message || 'Walk completed.')
            }
            if (
              event.walkerId &&
              !ratedJobIds.has(event.jobId) &&
              !dismissedCompletionIdsRef.current.has(event.jobId)
            ) {
              setCompletionJob({
                jobId: event.jobId,
                walkerId: event.walkerId,
                walkerName: event.walkerName || walkerNameById.get(event.walkerId) || 'Walker',
              })
            }
            void fetchCurrentAndLists()
          }
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'ratings', filter: `from_user_id=eq.${profileId}` },
        () => {
          void fetchCurrentAndLists()
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'ratings', filter: `to_user_id=eq.${profileId}` },
        () => {
          void fetchCurrentAndLists()
        },
      )
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [
    profileId,
    currentJobId,
    walkerNameById,
    fetchCurrentAndLists,
    loadWalkerName,
    clearActiveState,
    ratedJobIds,
    persistStartedWalkIds,
    showLifecycleBanner,
  ])

  useEffect(() => {
    if (!currentJob || currentJob.status !== 'accepted' || screenState !== 'tracking') return
    if (!isArrived) return
    if (arriveNotifiedRef.current.has(currentJob.id)) return

    arriveNotifiedRef.current.add(currentJob.id)
    const walkerLabel = currentJob.walker_id
      ? walkerNameById.get(currentJob.walker_id) || 'Walker'
      : 'Walker'

    setSuccessMessage(`${walkerLabel} has arrived${currentJob.dog_name ? ` for ${currentJob.dog_name}` : ''}.`)
  }, [currentJob, isArrived, profileId, screenState, walkerNameById])

  const cancelSearch = useCallback(async () => {
    if (!currentJobId) {
      staleActiveCutoffRef.current = Date.now()
      clearActiveState()
      return
    }

    const cancelledJobId = currentJobId
    const previousCutoff = staleActiveCutoffRef.current
    const cancelStartedAt = Date.now()
    suppressedActiveRequestIdsRef.current.set(cancelledJobId, cancelStartedAt)
    staleActiveCutoffRef.current = Math.max(staleActiveCutoffRef.current, cancelStartedAt)
    clearActiveState()

    const { error: cancelError } = await supabase
      .from('walk_requests')
      .update({ status: 'cancelled', smart_dispatch_state: 'cancelled', dispatch_state: 'cancelled' })
      .eq('id', cancelledJobId)
      .eq('client_id', profileId)
      .in('status', ['awaiting_payment', 'open'])

    if (cancelError) {
      suppressedActiveRequestIdsRef.current.delete(cancelledJobId)
      staleActiveCutoffRef.current = previousCutoff
      setError(cancelError.message)
      return
    }

    setSuccessMessage('Request cancelled')
    void fetchCurrentAndLists()
  }, [currentJobId, profileId, fetchCurrentAndLists, clearActiveState])

  const cancelScheduledJob = useCallback(async (id: string) => {
    const { error: cancelError } = await supabase
      .from('walk_requests')
      .update({ status: 'cancelled', dispatch_state: 'cancelled', smart_dispatch_state: 'cancelled' })
      .eq('id', id)
      .eq('client_id', profileId)
      .neq('dispatch_state', 'dispatched')

    if (cancelError) {
      setError(cancelError.message)
      return
    }

    setSuccessMessage('Scheduled walk cancelled')
    void fetchCurrentAndLists()
  }, [profileId, fetchCurrentAndLists])

  const requestCardSetup = useCallback(async () => {
    setCardLoading(true)
    setCardError(false)
    try {
      const { data, error: setupError } = await invokeEdgeFunction<PaymentMethodsResponse>(
        'manage-payment-method',
        { body: { action: 'create-setup-intent' } },
      )

      if (setupError) throw new Error(setupError)
      if (!data?.clientSecret) throw new Error('Failed to start card setup')
      setSetupClientSecret(data.clientSecret)
    } catch (err) {
      setCardError(true)
      setError(err instanceof Error ? err.message : 'Failed to start card setup')
    } finally {
      setCardLoading(false)
    }
  }, [])

  const changeCard = useCallback(() => {
    void requestCardSetup()
  }, [requestCardSetup])

  const onCardSetupComplete = useCallback(() => {
    setSetupClientSecret(null)
    void loadPaymentMethods()
  }, [loadPaymentMethods])

  const cancelCardSetup = useCallback(() => {
    setSetupClientSecret(null)
  }, [])

  const retryLoadCard = useCallback(() => {
    void loadPaymentMethods()
  }, [loadPaymentMethods])

  const submitCompletionRating = useCallback(
    async (rating?: number, review?: string) => {
      if (!completionJob || !rating || rating < 1) return

      const job = completedJobs.find((row) => row.id === completionJob.jobId)
      let walkerId = completionJob.walkerId ?? job?.walker_id ?? null

      if (!walkerId) {
        const { data: completionRow } = await supabase
          .from('walk_requests')
          .select('walker_id')
          .eq('id', completionJob.jobId)
          .eq('client_id', profileId)
          .maybeSingle()

        walkerId = completionRow?.walker_id ?? null
      }

      if (!walkerId) {
        setError('Unable to find assigned walker for rating')
        return
      }

      setCompletionRatingSubmitting(true)
      const trimmedReview = review?.trim() || null

      const { error: insertError } = await supabase.from('ratings').insert({
        job_id: completionJob.jobId,
        from_user_id: profileId,
        to_user_id: walkerId,
        rating,
        review: trimmedReview,
      })

      if (insertError && insertError.code !== '23505') {
        setError(insertError.message)
        setCompletionRatingSubmitting(false)
        return
      }

      const walkerLabel = walkerNameById.get(walkerId) || completionJob.walkerName || 'Walker'
      try {
        await createNotification({
          userId: profileId,
          type: 'rating_submitted',
          title: 'Thanks for rating',
          message: `You rated ${walkerLabel} ${rating} stars.`,
          relatedJobId: completionJob.jobId,
        })
        await createNotification({
          userId: walkerId,
          type: 'new_rating',
          title: 'New Rating Received',
          message: trimmedReview
            ? `You received a ${rating}-star rating: "${trimmedReview}"`
            : `You received a ${rating}-star rating!`,
          relatedJobId: completionJob.jobId,
        })
      } catch {
        // noop
      }

      setCompletionRatingSubmitting(false)
      flowCompletedJobIdsRef.current.delete(completionJob.jobId)
      setCompletionJob(null)
      void fetchCurrentAndLists()
    },
    [completionJob, completedJobs, profileId, walkerNameById, fetchCurrentAndLists],
  )

  const dismissCompletion = useCallback(() => {
    setCompletionJob((current) => {
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

  const requestWalk = useCallback(async () => {
    if (!dogName.trim()) {
      setError('Enter name')
      return
    }
    if (!location.trim()) {
      setError('Enter location')
      return
    }
    if (!savedCard || !stripeCustomerId) {
      setError('Add a valid payment method before booking')
      return
    }

    const bookingLocation = formatShortAddress(location) || location.trim()

    try {
      setLoading(true)
      setError(null)
      setSuccessMessage(null)
      if (bookingLocation !== location) {
        _setLocation(bookingLocation)
        persistBookingDraft({ location: bookingLocation })
      }

      const response = await invokeEdgeFunction<{
        jobId?: string
        paymentIntentId?: string
        clientSecret?: string
        paymentStatus?: string
      }>('create-payment-intent', {
        body: {
          bookingTiming,
          timing: bookingTiming,
          serviceType: duration === '20min' ? 'quick' : duration === '40min' ? 'standard' : 'energy',
          dogName,
          location: bookingLocation,
          customerId: stripeCustomerId,
          paymentMethodId: savedCard.id,
          scheduledFor: bookingTiming === 'scheduled' ? scheduledFor : null,
        },
      })

      if (response.error) throw new Error(response.error)
      if (!response.data?.jobId) throw new Error('Failed to create walk request')
      if (
        response.data.paymentStatus !== 'requires_capture' &&
        response.data.paymentStatus !== 'authorized' &&
        response.data.paymentStatus !== 'succeeded' &&
        response.data.paymentStatus !== 'paid'
      ) {
        throw new Error('Payment was not authorized. Please update your card and try again.')
      }

      const jobId = response.data.jobId
      const durationMinutes = durationToMinutes(duration)
      const shouldSearchNow = bookingTiming === 'asap'

      const statusPatch: Record<string, unknown> = {
        status: 'open',
        duration_minutes: durationMinutes,
        price: adjustedPriceILS,
      }
      if (bookingTiming === 'scheduled') {
        statusPatch.dispatch_state = 'queued'
      } else {
        statusPatch.booking_timing = 'asap'
      }

      const { error: normalizeError } = await supabase
        .from('walk_requests')
        .update(statusPatch)
        .eq('id', jobId)
        .eq('client_id', profileId)

      if (normalizeError) {
        throw new Error(normalizeError.message)
      }

      const { data: job, error: jobError } = await supabase
        .from('walk_requests')
        .select(JOB_SELECT)
        .eq('id', jobId)
        .maybeSingle()

      if (jobError || !job) {
        throw new Error(jobError?.message || 'Failed to load walk request')
      }

      const createdJob = job as WalkRequestRow
      setCurrentJobId(createdJob.id)
      setCurrentJob(createdJob)
      lastActiveJobIdRef.current = createdJob.id

      if (shouldSearchNow) {
        const { data: walkers, error: walkersError } = await supabase
          .from('profiles')
          .select('id')
          .eq('role', 'walker')
          .eq('is_online', true)

        if (walkersError) {
          throw new Error(walkersError.message)
        }

        const ranked =
          walkers?.map((walker, index) => ({
            walkerId: walker.id,
            score: 1 - index * 0.01,
            meta: {},
          })) ?? []

        if (ranked.length === 0) {
          throw new Error('No walkers online')
        }

        const dispatchResult = await startDispatch({
          requestId: createdJob.id,
          rankedCandidates: ranked,
          resetExisting: true,
        })

        if (!dispatchResult.ok) {
          throw new Error(dispatchResult.error || dispatchResult.details || 'Dispatch did not start')
        }

        setSearchStartTime(Date.now())
        setScreenState('searching')
        setSuccessMessage('Searching for a walker...')
      } else {
        setBookingTiming('asap')
        setScheduledFor(getNowPlus15LocalInput())
        setSearchStartTime(null)
        setScreenState('idle')
        setSuccessMessage('Scheduled walk saved')
      }

      void fetchCurrentAndLists()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to request walk'
      setError(message)
      setScreenState('idle')
      setSearchStartTime(null)
      setCurrentJob(null)
      setCurrentJobId(null)
    } finally {
      setLoading(false)
    }
  }, [
    adjustedPriceILS,
    bookingTiming,
    dogName,
    duration,
    fetchCurrentAndLists,
    location,
    persistBookingDraft,
    profileId,
    savedCard,
    scheduledFor,
    stripeCustomerId,
  ])

  return {
    screenState,
    setScreenState,
    searchStartTime,

    dogName,
    setDogName,

    location,
    setLocation,
    locationLoading,

    userLocation,
    hasUserLocation,

    duration,
    setDuration,
    selectedDuration,

    bookingTiming,
    setBookingTiming,

    scheduledFor,
    setScheduledFor,
    scheduledMinInput,
    scheduledSummary,

    loading,
    error,
    successMessage,
    clearError,
    clearSuccess,

    savedCard,
    upcomingJobs,
    completedJobs,
    ratings,
    ratingsReceived,
    recentRatings: ratings.slice(0, 8),
    recentRatingsReceived: ratingsReceived.slice(0, 8),
    walkerNameById,
    completionJob,

    activeJob,
    isWalkActive: screenState === 'active',
    currentJob,
    walkerLocation,
    walkerBearing,
    isArrived,
    proximityLevel,
    routePolyline,

    gpsQuality,
    avgRating,

    surgeMultiplier,
    surgeLevel,

    setupClientSecret,
    cardLoading,
    cardError,

    elapsedSeconds,
    adjustedPriceILS,

    etaMinutes,
    displayEtaSeconds,
    distanceMeters,

    completionRatingSubmitting,
    ratedJobIds,

    startsInMinutes,
    hideHistoryItem,
    cancelSearch,
    cancelScheduledJob,
    requestCardSetup,
    changeCard,
    onCardSetupComplete,
    cancelCardSetup,
    retryLoadCard,
    submitCompletionRating,
    dismissCompletion,

    requestWalk,
  }
}
