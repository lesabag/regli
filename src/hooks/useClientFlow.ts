import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase, invokeEdgeFunction } from '../services/supabaseClient'
import { distanceKm, rankWalkerCandidates } from '../lib/dispatchRanking'
import { startDispatch } from '../lib/startDispatch'
import { DURATION_OPTIONS, type DurationType } from '../lib/payments'
import { useJobTracking } from './useJobTracking'
import { createNotification } from '../components/NotificationsBell'
import { formatShortAddress } from '../utils/addressFormat'
import { getServiceLabels, getServicePhase, type ServicePhase } from '../utils/serviceLifecycle'
import {
  appendCompletionReviewMarker,
  isCompletionReviewRequired,
} from '../utils/completionReview'
import i18n from '../i18n'

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

const DURATION_PRICE_BY_TYPE: Record<DurationType, number> = DURATION_OPTIONS.reduce(
  (map, option) => {
    map[option.value] = option.priceILS
    return map
  },
  {} as Record<DurationType, number>,
)

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

type TipJob = {
  jobId: string
  walkerName: string
  walkerId: string
} | null

type AvailabilityNotice = {
  title: string
  subtitle: string
} | null

type LiveOrderEventPayload = {
  jobId?: string
  type?: 'accepted' | 'arrived' | 'started' | 'start_walk' | 'complete' | 'completed' | 'completion_pending'
  message?: string
  walkerId?: string | null
  walkerName?: string | null
}

type PendingCompletionConfirmation = {
  jobId: string
  walkerName: string
  walkerId: string | null
} | null

type CompletionReviewJob = {
  jobId: string
  walkerName: string
  walkerId: string | null
} | null

type CapturePaymentResponse = {
  success?: boolean
  error?: string
  details?: string
  code?: string
  jobId?: string
  paymentStatus?: string
  paidAt?: string
  alreadyCompleted?: boolean
  alreadyCaptured?: boolean
}

type ReverseGeocodeOptions = {
  force?: boolean
}

type AddressSource = 'gps' | 'manual'

type WalkRequestRow = {
  id: string
  client_id: string
  walker_id: string | null
  selected_walker_id: string | null
  status: 'awaiting_payment' | 'open' | 'accepted' | 'completed' | 'cancelled' | string
  service_type?: string | null
  dog_name: string | null
  location: string | null
  address?: string | null
  notes?: string | null
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
  smart_dispatch_last_error?: string | null
  smart_dispatch_completed_at?: string | null
  paid_at?: string | null
  created_at?: string | null
  completed_at?: string | null
  provider_arrived_at?: string | null
  client_arrival_confirmed_at?: string | null
  service_started_at?: string | null
  service_completed_at?: string | null
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

type FavoriteWalkerRow = {
  id: string
  client_id: string
  walker_id: string
  created_at: string
  walker?: {
    id: string
    full_name: string | null
    email: string | null
    avatar_url?: string | null
  } | null
}

type FavoriteWalkerQueryRow = Omit<FavoriteWalkerRow, 'walker'> & {
  walker?:
    | FavoriteWalkerRow['walker']
    | Array<NonNullable<FavoriteWalkerRow['walker']>>
    | null
}

type TipRow = {
  id: string
  walk_request_id: string
  client_id: string
  walker_id: string
  amount: number
  currency: string
  status: string
  stripe_payment_intent_id: string | null
  created_at: string
}

type DispatchWalkerProfile = {
  id: string
  last_lat: number | null
  last_lng: number | null
}

type DispatchRatingRow = {
  to_user_id: string
  rating: number
}

type QueryResult<T> = {
  data: T | null
  error: { message: string } | null
}

const JOB_SELECT =
  'id, client_id, walker_id, selected_walker_id, status, service_type, dog_name, location, address, notes, price, scheduled_fee_snapshot, duration_minutes, requested_window_minutes, booking_timing, scheduled_for, dispatch_state, smart_dispatch_state, smart_dispatch_last_error, smart_dispatch_completed_at, walker_lat, walker_lng, last_location_update, payment_status, paid_at, created_at, provider_arrived_at, client_arrival_confirmed_at, service_started_at, service_completed_at'

const COMPLETION_PROMPT_RECENT_MS = 30 * 60 * 1000
const CANCEL_SUPPRESS_MS = 2 * 60 * 1000
const LOCATION_REFRESH_METERS = 50


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

function completionReviewDismissStorageKey(profileId: string): string {
  return `regli_client_completion_review_dismissed_${profileId}`
}

function getLifecycleEventRank(type: 'accepted' | 'arrived' | 'start_walk' | 'complete'): number {
  if (type === 'complete') return 4
  if (type === 'start_walk') return 3
  if (type === 'arrived') return 2
  return 1
}

function isCompletionReviewJob(job: Pick<WalkRequestRow, 'status' | 'notes'> | null | undefined): boolean {
  return !!job && job.status === 'accepted' && isCompletionReviewRequired(job.notes)
}

function getJobEventTime(job: WalkRequestRow): number {
  const value = job.service_completed_at ?? job.paid_at ?? job.created_at ?? null
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

function isExhaustedUiCandidate(job: WalkRequestRow): boolean {
  if (!isCurrentClientJob(job)) return false
  if (job.smart_dispatch_state === 'exhausted') return true
  return (
    job.status === 'cancelled' &&
    typeof job.smart_dispatch_last_error === 'string' &&
    job.smart_dispatch_last_error.toLowerCase().includes('all candidates exhausted')
  )
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

function getNewestExhaustedRequest(
  rows: WalkRequestRow[],
  suppressedIds: Map<string, number>,
  staleCutoff: number,
): WalkRequestRow | null {
  const now = Date.now()
  const candidates = rows
    .filter(isExhaustedUiCandidate)
    .filter((job) => {
      const suppressedAt = suppressedIds.get(job.id)
      if (suppressedAt && now - suppressedAt < CANCEL_SUPPRESS_MS) return false
      if (getCreatedTime(job) <= staleCutoff) return false
      return true
    })
    .sort((a, b) => getCreatedTime(b) - getCreatedTime(a))

  return candidates[0] ?? null
}

function isDispatchUnavailableMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase()
  return (
    normalized.includes('no walkers online') ||
    normalized.includes('no candidates available') ||
    normalized.includes('all candidates exhausted') ||
    normalized.includes('no providers available')
  )
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
  duration?: '20min' | '40min' | '60min'
}

function bookingDraftStorageKey(profileId: string): string {
  return `regli_client_last_booking_${profileId}`
}

function reusableServiceNameStorageKey(profileId: string): string {
  return `regli_client_reusable_service_name_${profileId}`
}

function addressSourceStorageKey(profileId: string): string {
  return `regli_client_address_source_${profileId}`
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

function mapScreenStateFromPhase(phase: ServicePhase): ScreenState {
  if (phase === 'searching') return 'searching'
  if (
    phase === 'on_the_way' ||
    phase === 'arrived_pending_confirmation' ||
    phase === 'arrival_confirmed'
  ) {
    return 'tracking'
  }
  if (phase === 'in_progress') return 'active'
  return 'idle'
}

function mergeWalkRequest(prev: WalkRequestRow | null, next: WalkRequestRow): WalkRequestRow {
  if (!prev || prev.id !== next.id) return next

  const merged = { ...prev } as WalkRequestRow
  const mergedRecord = merged as Record<string, unknown>
  const prevRecord = prev as unknown as Record<string, unknown>
  const entries = Object.entries(next) as Array<[keyof WalkRequestRow, WalkRequestRow[keyof WalkRequestRow]]>

  entries.forEach(([key, value]) => {
    if (value !== null && value !== undefined) {
      mergedRecord[key as string] = value
      return
    }

    if (
      key === 'provider_arrived_at' ||
      key === 'client_arrival_confirmed_at' ||
      key === 'service_started_at' ||
      key === 'service_completed_at' ||
      key === 'walker_lat' ||
      key === 'walker_lng' ||
      key === 'last_location_update'
    ) {
      if (prevRecord[key as string] != null) {
        mergedRecord[key as string] = prevRecord[key as string]
      }
      return
    }

    mergedRecord[key as string] = value
  })

  return merged
}

export function useClientFlow(profileId: string, _profileName: string) {
  const [screenState, setScreenState] = useState<ScreenState>('idle')
  const [screenPhase, setScreenPhase] = useState<ServicePhase>('idle')
  const [searchStartTime, setSearchStartTime] = useState<number | null>(null)
  const [searchClockNow, setSearchClockNow] = useState(() => Date.now())
  const [currentJobId, setCurrentJobId] = useState<string | null>(null)
  const [currentJob, setCurrentJob] = useState<WalkRequestRow | null>(null)

  const [dogName, _setDogName] = useState('')
  const [location, _setLocation] = useState('')
  const [duration, _setDuration] = useState<'20min' | '40min' | '60min' | null>(null)

  const [bookingTiming, setBookingTiming] = useState<'asap' | 'scheduled'>('asap')
  const [scheduledFor, setScheduledFor] = useState<string | null>(getNowPlus15LocalInput())
  const scheduledMinInput = getNowPlus15LocalInput()

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [availabilityNotice, setAvailabilityNotice] = useState<AvailabilityNotice>(null)

  const [gpsQualityBase, setGpsQualityBase] = useState<GpsQuality>('live')
  const [completionJob, setCompletionJob] = useState<CompletionJob>(null)
  const [completionRatingSubmitting, setCompletionRatingSubmitting] = useState(false)
  const [arrivalConfirming, setArrivalConfirming] = useState(false)
  const [pendingCompletionConfirmation, setPendingCompletionConfirmation] = useState<PendingCompletionConfirmation>(null)
  const [completionConfirming, setCompletionConfirming] = useState(false)
  const [completionConfirmError, setCompletionConfirmError] = useState<string | null>(null)
  const [completionReviewJob, setCompletionReviewJob] = useState<CompletionReviewJob>(null)
  const [tipJob, setTipJob] = useState<TipJob>(null)
  const [tipSubmitting, setTipSubmitting] = useState(false)

  const [userLocationBase, setUserLocationBase] = useState<[number, number] | null>(null)
  const [locationLoading, setLocationLoading] = useState(true)
  const [locationRefreshing, setLocationRefreshing] = useState(false)
  const [locationError, setLocationError] = useState<string | null>(null)
  const [addressSource, setAddressSource] = useState<AddressSource>('gps')
  const [walkerNameById, setWalkerNameById] = useState<Map<string, string>>(new Map())
  const [upcomingJobs, setUpcomingJobs] = useState<WalkRequestRow[]>([])
  const [completedJobs, setCompletedJobs] = useState<Array<WalkRequestRow & { hidden_by_client?: boolean; tip_amount?: number | null }>>([])
  const [ratings, setRatings] = useState<RatingRow[]>([])
  const [ratingsReceived, setRatingsReceived] = useState<RatingRow[]>([])
  const [favoriteWalkers, setFavoriteWalkers] = useState<FavoriteWalkerRow[]>([])
  const [hiddenHistoryIds, setHiddenHistoryIds] = useState<Set<string>>(new Set())
  const [dismissedCompletionReviewIds, setDismissedCompletionReviewIds] = useState<Set<string>>(new Set())

  const acceptNotifiedRef = useRef<Set<string>>(new Set())
  const arriveNotifiedRef = useRef<Set<string>>(new Set())
  const startNotifiedRef = useRef<Set<string>>(new Set())
  const completeNotifiedRef = useRef<Set<string>>(new Set())
  const liveEventNotifiedRef = useRef<Set<string>>(new Set())
  const lifecycleEventRankRef = useRef<Map<string, number>>(new Map())
  const lifecyclePhaseRef = useRef<Map<string, ServicePhase>>(new Map())
  const exhaustedDispatchNotifiedRef = useRef<Set<string>>(new Set())
  const dismissedCompletionIdsRef = useRef<Set<string>>(new Set())
  const suppressedActiveRequestIdsRef = useRef<Map<string, number>>(new Map())
  const staleActiveCutoffRef = useRef(0)
  const flowCompletedJobIdsRef = useRef<Set<string>>(new Set())
  const lastActiveJobIdRef = useRef<string | null>(null)
  const lastAutoLocationRef = useRef<string>('')
  const lastGeocodeCoordsRef = useRef<[number, number] | null>(null)
  const latestResolvedLocationRef = useRef<string>('')
  const reusableServiceNameRef = useRef<string>('')
  const reusableServiceNameAutofilledRef = useRef(false)
  const dismissedExhaustedRequestIdRef = useRef<string | null>(null)
  const fullRefreshInFlightRef = useRef<Promise<void> | null>(null)
  const currentOnlyRefreshInFlightRef = useRef<Promise<void> | null>(null)
  const addressSourceRef = useRef<AddressSource>('gps')
  const searchStartTimeRef = useRef<number | null>(null)

  const setAddressSourceValue = useCallback(
    (nextSource: AddressSource) => {
      addressSourceRef.current = nextSource
      setAddressSource(nextSource)
      try {
        window.localStorage.setItem(addressSourceStorageKey(profileId), nextSource)
      } catch {
        // noop
      }
    },
    [profileId],
  )

  const beginSearchAttempt = useCallback(() => {
    const startedAt = Date.now()
    if (import.meta.env.DEV) {
      console.log('[search timer] start', startedAt, 'request_walk')
    }
    searchStartTimeRef.current = startedAt
    setSearchClockNow(startedAt)
    setSearchStartTime(startedAt)
    return startedAt
  }, [])

  const clearSearchAttempt = useCallback(() => {
    searchStartTimeRef.current = null
    setSearchStartTime(null)
    setSearchClockNow(Date.now())
  }, [])

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(completionReviewDismissStorageKey(profileId))
      const parsed = raw ? (JSON.parse(raw) as string[]) : []
      setDismissedCompletionReviewIds(new Set(Array.isArray(parsed) ? parsed : []))
    } catch {
      setDismissedCompletionReviewIds(new Set())
    }
  }, [profileId])

  const persistDismissedCompletionReviewIds = useCallback(
    (nextIds: Set<string>) => {
      setDismissedCompletionReviewIds(nextIds)
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

  const shouldShowCompletionReview = useCallback(
    (jobId: string) => !dismissedCompletionReviewIds.has(jobId),
    [dismissedCompletionReviewIds],
  )

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
      const raw = window.localStorage.getItem(`regli_client_history_hidden_${profileId}`)
      if (!raw) return
      const parsed = JSON.parse(raw) as string[]
      if (Array.isArray(parsed)) setHiddenHistoryIds(new Set(parsed))
    } catch {
      // noop
    }
  }, [profileId])

  useEffect(() => {
    let nextSource: AddressSource = 'gps'
    try {
      const stored = window.localStorage.getItem(addressSourceStorageKey(profileId))
      if (stored === 'manual' || stored === 'gps') {
        nextSource = stored
      }
    } catch {
      // noop
    }
    addressSourceRef.current = nextSource
    setAddressSource(nextSource)
  }, [profileId])

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(bookingDraftStorageKey(profileId))
      if (!raw) return
      const parsed = JSON.parse(raw) as Partial<LastBookingDraft>
      const lastName = typeof parsed.dogName === 'string' ? parsed.dogName.trim() : ''
      const lastLocation = typeof parsed.location === 'string' ? parsed.location.trim() : ''
      if (lastName) {
        _setDogName((current) => current || lastName)
      }
      if (lastLocation) {
        lastAutoLocationRef.current = lastLocation
        latestResolvedLocationRef.current = lastLocation
        _setLocation((current) => current || lastLocation)
      }
    } catch {
      // noop
    }
  }, [profileId])

  useEffect(() => {
    reusableServiceNameAutofilledRef.current = false
    try {
      reusableServiceNameRef.current =
        window.localStorage.getItem(reusableServiceNameStorageKey(profileId))?.trim() ?? ''
    } catch {
      reusableServiceNameRef.current = ''
    }
  }, [profileId])

  useEffect(() => {
    if (reusableServiceNameAutofilledRef.current) return
    if (screenState !== 'idle') return
    if (currentJob) return
    if (dogName.trim()) return

    const reusableName = reusableServiceNameRef.current.trim()
    if (!reusableName) return

    reusableServiceNameAutofilledRef.current = true
    _setDogName((current) => current.trim() || reusableName)
    try {
      const key = bookingDraftStorageKey(profileId)
      const currentRaw = window.localStorage.getItem(key)
      const current = currentRaw ? (JSON.parse(currentRaw) as Partial<LastBookingDraft>) : {}
      window.localStorage.setItem(
        key,
        JSON.stringify({
          dogName: reusableName,
          location: typeof current.location === 'string' ? current.location : '',
          duration:
            current.duration === '20min' || current.duration === '40min' || current.duration === '60min'
              ? current.duration
              : '20min',
        } satisfies LastBookingDraft),
      )
    } catch {
      // noop
    }
  }, [currentJob, dogName, profileId, screenState])

  const geoDistanceMeters = useCallback((from: [number, number], to: [number, number]) => {
    const toRad = (deg: number) => (deg * Math.PI) / 180
    const earthRadius = 6371000
    const dLat = toRad(to[0] - from[0])
    const dLng = toRad(to[1] - from[1])
    const lat1 = toRad(from[0])
    const lat2 = toRad(to[0])
    const h =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2)
    return 2 * earthRadius * Math.asin(Math.sqrt(h))
  }, [])

  const reverseGeocodeRef = useRef<((lat: number, lng: number, options?: ReverseGeocodeOptions) => Promise<string>) | null>(null)

  useEffect(() => {
    let cancelled = false

    reverseGeocodeRef.current = async (lat: number, lng: number, options?: ReverseGeocodeOptions) => {
      const force = options?.force === true
      const nextCoords: [number, number] = [lat, lng]
      const lastCoords = lastGeocodeCoordsRef.current
      if (!force && lastCoords && geoDistanceMeters(lastCoords, nextCoords) < LOCATION_REFRESH_METERS) {
        return latestResolvedLocationRef.current || location.trim() || `${lat.toFixed(4)}, ${lng.toFixed(4)}`
      }

      lastGeocodeCoordsRef.current = nextCoords

      try {
        const lang = i18n.resolvedLanguage || 'he'
        const res = await fetch(
          `https://nominatim.openstreetmap.org/reverse?format=json&addressdetails=1&lat=${lat}&lon=${lng}&accept-language=${lang}`,
        )
        const data = await res.json()
        if (cancelled) return

        const formattedAddress = formatShortAddress(data?.display_name, data?.address)
        const displayAddress =
          typeof data?.display_name === 'string' &&
          !/^-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?$/.test(data.display_name.trim())
            ? data.display_name.trim()
            : ''
        const address = formattedAddress || displayAddress

        if (!address) {
          throw new Error('Reverse geocode did not return a human-readable address')
        }

        _setLocation((prev) => {
          if (force) {
            lastAutoLocationRef.current = address
            latestResolvedLocationRef.current = address
            return address
          }
          const trimmedPrev = prev.trim()
          if (!trimmedPrev || trimmedPrev === lastAutoLocationRef.current) {
            const prevHasNumber = /\d/.test(trimmedPrev)
            const nextHasNumber = /\d/.test(address)
            if (prevHasNumber && !nextHasNumber) {
              latestResolvedLocationRef.current = trimmedPrev
              return prev
            }
            lastAutoLocationRef.current = address
            latestResolvedLocationRef.current = address
            return address
          }
          return prev
        })
        return address
      } catch {
        if (cancelled) return latestResolvedLocationRef.current || location.trim()
        const previousReadableAddress =
          latestResolvedLocationRef.current.trim() ||
          location.trim() ||
          lastAutoLocationRef.current.trim()

        if (force) {
          setLocationError(i18n.t('addressPicker.locationError'))
        }

        return previousReadableAddress
      }
    }

    return () => { cancelled = true }
  }, [geoDistanceMeters, location])

  useEffect(() => {
    if (!navigator.geolocation) {
      setGpsQualityBase('offline')
      setLocationLoading(false)
      return
    }

    let cancelled = false

    const onSuccess = (pos: GeolocationPosition) => {
      if (cancelled) return
      const lat = pos.coords.latitude
      const lng = pos.coords.longitude
      setUserLocationBase([lat, lng])
      setGpsQualityBase('live')
      setLocationLoading(false)
      if (addressSourceRef.current === 'gps' && reverseGeocodeRef.current) {
        void reverseGeocodeRef.current(lat, lng, { force: true })
      }
    }

    const onError = () => {
      if (cancelled) return
      setGpsQualityBase('offline')
      setLocationLoading(false)
    }

    navigator.geolocation.getCurrentPosition(onSuccess, onError, {
      enableHighAccuracy: true,
      maximumAge: 60_000,
      timeout: 8_000,
    })

    const watchId = navigator.geolocation.watchPosition(onSuccess, onError, {
      enableHighAccuracy: true,
      maximumAge: 15_000,
      timeout: 15_000,
    })

    const onResume = () => {
      if (document.visibilityState === 'hidden') return
      navigator.geolocation.getCurrentPosition(onSuccess, () => {}, {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 10_000,
      })
    }

    document.addEventListener('visibilitychange', onResume)
    window.addEventListener('focus', onResume)

    return () => {
      cancelled = true
      navigator.geolocation.clearWatch(watchId)
      document.removeEventListener('visibilitychange', onResume)
      window.removeEventListener('focus', onResume)
    }
  }, [])

  useEffect(() => {
    if (screenState !== 'searching' || !searchStartTime) return

    setSearchClockNow(Date.now())
    const id = window.setInterval(() => {
      setSearchClockNow(Date.now())
    }, 1000)

    return () => window.clearInterval(id)
  }, [screenState, searchStartTime])

  const refreshLocation = useCallback(async () => {
    if (!navigator.geolocation) {
      setGpsQualityBase('offline')
      setLocationError(i18n.t('addressPicker.locationError'))
      return false
    }

    setLocationRefreshing(true)
    setLocationError(null)
    setError(null)
    setAddressSourceValue('gps')
    lastAutoLocationRef.current = ''
    lastGeocodeCoordsRef.current = null

    return await new Promise<boolean>((resolve) => {
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          const lat = pos.coords.latitude
          const lng = pos.coords.longitude
          setUserLocationBase([lat, lng])
          setGpsQualityBase('live')
          try {
            if (reverseGeocodeRef.current) {
              await reverseGeocodeRef.current(lat, lng, { force: true })
            }
            resolve(true)
          } finally {
            setLocationRefreshing(false)
          }
        },
        () => {
          setGpsQualityBase('offline')
          const message = i18n.t('addressPicker.locationError')
          setLocationError(message)
          setError(message)
          setLocationRefreshing(false)
          resolve(false)
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 10_000 },
      )
    })
  }, [setAddressSourceValue])

  const clearError = useCallback(() => {
    setError(null)
    setCompletionConfirmError(null)
    setLocationError(null)
  }, [])
  const clearSuccess = useCallback(() => setSuccessMessage(null), [])
  const clearAvailabilityNotice = useCallback(() => setAvailabilityNotice(null), [])
  const dismissExhaustedRequest = useCallback(() => {
    const exhaustedJobId =
      currentJob?.smart_dispatch_state === 'exhausted'
        ? currentJob.id
        : currentJobId
    if (exhaustedJobId) {
      dismissedExhaustedRequestIdRef.current = exhaustedJobId
    }
    setAvailabilityNotice(null)
    setError(null)
    setSuccessMessage(null)
    setScreenState('idle')
    setScreenPhase('idle')
    setCurrentJob(null)
    setCurrentJobId(null)
    clearSearchAttempt()
  }, [clearSearchAttempt, currentJob, currentJobId])
  const clearExhaustedRequestForRetry = useCallback(() => {
    dismissExhaustedRequest()
  }, [dismissExhaustedRequest])

  const showDispatchExhaustedMessage = useCallback((jobId: string) => {
    if (exhaustedDispatchNotifiedRef.current.has(jobId)) return
    exhaustedDispatchNotifiedRef.current.add(jobId)
    setError(null)
    setSuccessMessage(null)
    setAvailabilityNotice({
      title: 'No providers available right now',
      subtitle: 'Try again in a few minutes',
    })
  }, [])

  const showLifecycleBanner = useCallback(
    (jobId: string, type: 'accepted' | 'arrived' | 'start_walk' | 'complete', message: string) => {
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

  const saveReusableServiceName = useCallback(
    (value: string) => {
      const normalized = value.trim()
      if (!normalized) return
      reusableServiceNameRef.current = normalized
      try {
        window.localStorage.setItem(reusableServiceNameStorageKey(profileId), normalized)
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
      lastAutoLocationRef.current = ''
      setLocationError(null)
      setAddressSourceValue('manual')
      _setLocation(value)
      persistBookingDraft({ location: value })
    },
    [persistBookingDraft, setAddressSourceValue],
  )

  const setDuration = useCallback(
    (value: '20min' | '40min' | '60min' | null) => {
      _setDuration(value)
      if (value) {
        persistBookingDraft({ duration: value })
      }
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

  const elapsedSeconds = searchStartTime ? Math.floor((searchClockNow - searchStartTime) / 1000) : 0

  const selectedDuration = { label: duration ?? '' }
  const adjustedPriceILS = duration ? DURATION_PRICE_BY_TYPE[duration] ?? 0 : 0

  const ratedJobIds = useMemo(() => new Set(ratings.map((r) => r.job_id)), [ratings])
  const favoriteWalkerIds = useMemo(
    () => new Set(favoriteWalkers.map((favorite) => favorite.walker_id)),
    [favoriteWalkers],
  )

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

  useEffect(() => {
    if (screenState !== 'idle') return
    if (!latestResolvedLocationRef.current) return

    _setLocation((prev) => {
      const trimmedPrev = prev.trim()
      if (!trimmedPrev || trimmedPrev === lastAutoLocationRef.current) {
        lastAutoLocationRef.current = latestResolvedLocationRef.current
        return latestResolvedLocationRef.current
      }
      return prev
    })
  }, [screenState])

  const fetchFavoriteWalkers = useCallback(async () => {
    const { data, error } = await supabase
      .from('favorite_walkers')
      .select('id, client_id, walker_id, created_at, walker:profiles!favorite_walkers_walker_id_fkey(id, full_name, email, avatar_url)')
      .eq('client_id', profileId)
      .order('created_at', { ascending: false })

    if (error) {
      console.warn('[useClientFlow] favorite walkers unavailable:', error.message)
      setFavoriteWalkers([])
      return
    }

    const rows = ((data as unknown as FavoriteWalkerQueryRow[] | null) ?? []).map((row) => ({
      ...row,
      walker: Array.isArray(row.walker) ? row.walker[0] ?? null : row.walker ?? null,
    }))
    setFavoriteWalkers(rows)
  }, [profileId])

  useEffect(() => {
    void fetchFavoriteWalkers()
  }, [fetchFavoriteWalkers])

  const toggleFavoriteWalker = useCallback(
    async (walkerId: string) => {
      if (!walkerId) return

      const isFavorite = favoriteWalkerIds.has(walkerId)
      if (isFavorite) {
        setFavoriteWalkers((prev) => prev.filter((favorite) => favorite.walker_id !== walkerId))
        const { error } = await supabase
          .from('favorite_walkers')
          .delete()
          .eq('client_id', profileId)
          .eq('walker_id', walkerId)

        if (error) {
          setError(error.message)
          void fetchFavoriteWalkers()
          return
        }
      } else {
        const optimistic: FavoriteWalkerRow = {
          id: `optimistic-${walkerId}`,
          client_id: profileId,
          walker_id: walkerId,
          created_at: new Date().toISOString(),
          walker: {
            id: walkerId,
            full_name: walkerNameById.get(walkerId) ?? 'Walker',
            email: null,
            avatar_url: null,
          },
        }
        setFavoriteWalkers((prev) => [optimistic, ...prev])
        const { error } = await supabase.from('favorite_walkers').insert({
          client_id: profileId,
          walker_id: walkerId,
        })

        if (error && error.code !== '23505') {
          setError(error.message)
          void fetchFavoriteWalkers()
          return
        }
      }

      void fetchFavoriteWalkers()
    },
    [favoriteWalkerIds, fetchFavoriteWalkers, profileId, walkerNameById],
  )

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
    !isCompletionReviewJob(currentJob) &&
    (
      screenPhase === 'on_the_way' ||
      screenPhase === 'arrived_pending_confirmation' ||
      screenPhase === 'arrival_confirmed' ||
      screenPhase === 'in_progress'
    )
      ? currentJob
      : null

  const clearActiveState = useCallback(() => {
    setScreenState('idle')
    setScreenPhase('idle')
    setCompletionReviewJob(null)
    setCurrentJob(null)
    setCurrentJobId(null)
    clearSearchAttempt()
  }, [clearSearchAttempt])

  const resetBookingComposerAfterCompletion = useCallback(() => {
    setBookingTiming('asap')
    setScheduledFor(getNowPlus15LocalInput())
    _setDuration(null)
    setLoading(false)
    setError(null)
    setSuccessMessage(null)
    setAvailabilityNotice(null)
    setPendingCompletionConfirmation(null)
    setCompletionConfirmError(null)
    setCompletionConfirming(false)
    setCompletionRatingSubmitting(false)
    setTipSubmitting(false)
    clearActiveState()
  }, [clearActiveState])

  const applyCurrentRows = useCallback((currentRows: WalkRequestRow[]) => {
    const row = getNewestActiveRequest(
      currentRows,
      suppressedActiveRequestIdsRef.current,
      staleActiveCutoffRef.current,
    )
    const exhaustedRow = getNewestExhaustedRequest(
      currentRows,
      suppressedActiveRequestIdsRef.current,
      staleActiveCutoffRef.current,
    )

    if (!row) {
      setCompletionReviewJob(null)
      if (screenState === 'searching' && currentJobId) {
        return
      }
      if (exhaustedRow && exhaustedRow.id !== dismissedExhaustedRequestIdRef.current) {
        const belongsToCurrentFlow =
          exhaustedRow.id === currentJobId ||
          exhaustedRow.id === lastActiveJobIdRef.current ||
          screenState === 'searching'

        if (belongsToCurrentFlow) {
          setCurrentJob((prev) => mergeWalkRequest(prev, exhaustedRow))
          setCurrentJobId(exhaustedRow.id)
          lastActiveJobIdRef.current = exhaustedRow.id
          setScreenPhase('idle')
          setScreenState('idle')
          clearSearchAttempt()
          showDispatchExhaustedMessage(exhaustedRow.id)
          return
        }
      }
      clearActiveState()
      return
    }

    setAvailabilityNotice(null)
    const nextPhase = getServicePhase(row)
    lifecyclePhaseRef.current.set(row.id, nextPhase)
    setCurrentJob((prev) => mergeWalkRequest(prev, row))
    setCurrentJobId(row.id)
    lastActiveJobIdRef.current = row.id
    if (row.walker_id) void loadWalkerName(row.walker_id)
    if (isCompletionReviewJob(row)) {
      const walkerLabel = row.walker_id ? walkerNameById.get(row.walker_id) || 'Provider' : 'Provider'
      setCompletionReviewJob(
        shouldShowCompletionReview(row.id)
          ? {
              jobId: row.id,
              walkerId: row.walker_id,
              walkerName: walkerLabel,
            }
          : null,
      )
      setPendingCompletionConfirmation(null)
      setScreenPhase('idle')
      setScreenState('idle')
      clearSearchAttempt()
      return
    }
    setCompletionReviewJob(null)
    setScreenPhase(nextPhase)
    setScreenState(mapScreenStateFromPhase(nextPhase))
    if (row.status === 'accepted') {
      clearSearchAttempt()
    }
  }, [
    clearSearchAttempt,
    clearActiveState,
    currentJobId,
    loadWalkerName,
    screenState,
    showDispatchExhaustedMessage,
    walkerNameById,
    shouldShowCompletionReview,
  ])

  const fetchCurrentJobState = useCallback(async () => {
    if (currentOnlyRefreshInFlightRef.current) {
      await currentOnlyRefreshInFlightRef.current
      return
    }

    const run = (async () => {
      const { data, error } = await supabase
        .from('walk_requests')
        .select(JOB_SELECT)
        .eq('client_id', profileId)
        .in('status', ['awaiting_payment', 'open', 'accepted'])
        .or('booking_timing.is.null,booking_timing.eq.asap,dispatch_state.eq.dispatched')
        .order('created_at', { ascending: false })
        .limit(10)

      if (error) {
        console.warn('[useClientFlow] current request unavailable:', error.message)
        return
      }

      applyCurrentRows((data as WalkRequestRow[] | null) ?? [])
    })().finally(() => {
      currentOnlyRefreshInFlightRef.current = null
    })

    currentOnlyRefreshInFlightRef.current = run
    await run
  }, [applyCurrentRows, profileId])

  const fetchJobById = useCallback(
    async (jobId: string) => {
      const { data, error } = await supabase
        .from('walk_requests')
        .select(JOB_SELECT)
        .eq('id', jobId)
        .eq('client_id', profileId)
        .maybeSingle()

      if (error) {
        console.warn('[useClientFlow] job refresh unavailable:', error.message, 'jobId:', jobId)
        return null
      }

      return (data as WalkRequestRow | null) ?? null
    },
    [profileId],
  )

  const fetchCurrentAndLists = useCallback(async () => {
    if (fullRefreshInFlightRef.current) {
      await fullRefreshInFlightRef.current
      return
    }

    const run = (async () => {
    const [
      currentResult,
      upcomingResult,
      completedResult,
      ratingsResult,
      ratingsReceivedResult,
      tipsResult,
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
      supabase
        .from('walker_tips')
        .select('*')
        .eq('client_id', profileId)
        .order('created_at', { ascending: false }),
    ])

    const currentRes = settledQuery<WalkRequestRow[]>(currentResult, 'current request')
    const upcomingRes = settledQuery<WalkRequestRow[]>(upcomingResult, 'upcoming requests')
    const completedRes = settledQuery<WalkRequestRow[]>(completedResult, 'completed requests')
    const ratingsRes = settledQuery<RatingRow[]>(ratingsResult, 'ratings given')
    const ratingsReceivedRes = settledQuery<RatingRow[]>(ratingsReceivedResult, 'ratings received')
    const tipsRes = settledQuery<TipRow[]>(tipsResult, 'walker tips')

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
    if (tipsRes.error) {
      console.warn('[useClientFlow] walker tips unavailable:', tipsRes.error.message)
    }

    if (currentRes.error) {
      // Preserve the current UI state on transient read failures.
    } else {
      applyCurrentRows((currentRes.data as WalkRequestRow[] | null) ?? [])
    }

    const upcoming = ((upcomingRes.data as WalkRequestRow[] | null) ?? []).filter(isFutureScheduledJob)
    upcoming.forEach((job) => {
      lifecyclePhaseRef.current.set(job.id, getServicePhase(job))
    })
    setUpcomingJobs(upcoming)

    const tipByJobId = new Map<string, number>()
    for (const tip of (tipsRes.data as TipRow[] | null) ?? []) {
      if (!tipByJobId.has(tip.walk_request_id)) {
        tipByJobId.set(tip.walk_request_id, tip.amount)
      }
    }

    const completed = ((completedRes.data as WalkRequestRow[] | null) ?? []).map((job) => ({
      ...job,
      hidden_by_client: hiddenHistoryIds.has(job.id),
      tip_amount: tipByJobId.get(job.id) ?? null,
    }))
    completed.forEach((job) => {
      lifecyclePhaseRef.current.set(job.id, getServicePhase(job))
    })
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
    })().finally(() => {
      fullRefreshInFlightRef.current = null
    })

    fullRefreshInFlightRef.current = run
    await run
  }, [
    applyCurrentRows,
    profileId,
    loadWalkerName,
    hiddenHistoryIds,
  ])

  useEffect(() => {
    void fetchCurrentAndLists()
  }, [fetchCurrentAndLists])

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'hidden') return
      if (screenState === 'idle') {
        void fetchCurrentAndLists()
        return
      }
      void fetchCurrentJobState()
    }

    const pollId = window.setInterval(
      refresh,
      screenState === 'idle' ? 12_000 : 10_000,
    )

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
  }, [fetchCurrentAndLists, fetchCurrentJobState, screenState])

  useEffect(() => {
    const channel = supabase
      .channel(`client-flow-${profileId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'walk_requests', filter: `client_id=eq.${profileId}` },
        (payload) => {
          const updated = (payload.new ?? null) as WalkRequestRow | null
          if (!updated) return

          if (
            updated.smart_dispatch_state === 'exhausted' &&
            updated.id === dismissedExhaustedRequestIdRef.current
          ) {
            return
          }

          if (updated.walker_id) {
            void loadWalkerName(updated.walker_id)
          }

          const belongsToCurrentFlow =
            updated.id === currentJobId ||
            updated.id === lastActiveJobIdRef.current ||
            screenState === 'searching'

          const previousPhase = lifecyclePhaseRef.current.get(updated.id) ?? 'idle'
          const nextPhase = getServicePhase(updated)
          lifecyclePhaseRef.current.set(updated.id, nextPhase)

          if (updated.smart_dispatch_state === 'exhausted' && belongsToCurrentFlow) {
            setCurrentJob((prev) => mergeWalkRequest(prev, updated))
            setCurrentJobId(updated.id)
            lastActiveJobIdRef.current = updated.id
            setScreenPhase('idle')
            setScreenState('idle')
            clearSearchAttempt()
            showDispatchExhaustedMessage(updated.id)
            void fetchCurrentAndLists()
            return
          }

          const isSuppressed =
            !!suppressedActiveRequestIdsRef.current.get(updated.id) ||
            getCreatedTime(updated) <= staleActiveCutoffRef.current
          if (
            (updated.status === 'open' || updated.status === 'awaiting_payment') &&
            isCurrentClientJob(updated) &&
            !isSuppressed &&
            currentJobId === updated.id
          ) {
            setCurrentJob((prev) => mergeWalkRequest(prev, updated))
            setCurrentJobId(updated.id)
            lastActiveJobIdRef.current = updated.id
            setScreenPhase(nextPhase)
            setScreenState(mapScreenStateFromPhase(nextPhase))
          }

          if (updated.status === 'accepted' && !isSuppressed && currentJobId === updated.id) {
            const labels = getServiceLabels(updated.service_type)
            setCurrentJob((prev) => mergeWalkRequest(prev, updated))
            setCurrentJobId(updated.id)
            lastActiveJobIdRef.current = updated.id
            clearSearchAttempt()
            if (isCompletionReviewJob(updated)) {
              const walkerLabel = updated.walker_id
                ? walkerNameById.get(updated.walker_id) || 'Provider'
                : 'Provider'
              setCompletionReviewJob(
                shouldShowCompletionReview(updated.id)
                  ? {
                      jobId: updated.id,
                      walkerId: updated.walker_id,
                      walkerName: walkerLabel,
                    }
                  : null,
              )
              setPendingCompletionConfirmation(null)
              setScreenPhase('idle')
              setScreenState('idle')
              void fetchCurrentAndLists()
              return
            }
            setCompletionReviewJob(null)
            setScreenPhase(nextPhase)
            setScreenState(mapScreenStateFromPhase(nextPhase))

            if (!acceptNotifiedRef.current.has(updated.id)) {
              acceptNotifiedRef.current.add(updated.id)
              showLifecycleBanner(
                updated.id,
                'accepted',
                'Provider is on the way.',
              )
            }

            if (updated.provider_arrived_at && !updated.client_arrival_confirmed_at && !arriveNotifiedRef.current.has(updated.id)) {
              arriveNotifiedRef.current.add(updated.id)
              showLifecycleBanner(updated.id, 'arrived', 'Provider has arrived.')
            }

            if (
              nextPhase === 'in_progress' &&
              previousPhase !== 'in_progress' &&
              previousPhase !== 'completed' &&
              !updated.service_completed_at &&
              !startNotifiedRef.current.has(updated.id)
            ) {
              startNotifiedRef.current.add(updated.id)
              showLifecycleBanner(updated.id, 'start_walk', labels.startedPast)
            }
          }

          if (
            updated.status === 'accepted' &&
            updated.service_completed_at &&
            updated.service_started_at &&
            !isCompletionReviewJob(updated) &&
            (updated.id === currentJobId || updated.id === lastActiveJobIdRef.current)
          ) {
            const walkerLabel = updated.walker_id
              ? walkerNameById.get(updated.walker_id) || 'Provider'
              : 'Provider'
            setPendingCompletionConfirmation((prev) => {
              if (prev?.jobId === updated.id) return prev
              return {
                jobId: updated.id,
                walkerName: walkerLabel,
                walkerId: updated.walker_id,
              }
            })
          }

          if (updated.status === 'completed') {
            setCompletionReviewJob(null)
            const belongsToCurrentFlow =
              updated.id === currentJobId || updated.id === lastActiveJobIdRef.current

            if (belongsToCurrentFlow) {
              flowCompletedJobIdsRef.current.add(updated.id)
              clearActiveState()
            }

            if (!completeNotifiedRef.current.has(updated.id)) {
              completeNotifiedRef.current.add(updated.id)
              showLifecycleBanner(updated.id, 'complete', getServiceLabels(updated.service_type).completedPast)
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
            setCompletionReviewJob(null)
            if (updated.id === currentJobId) {
              if (
                typeof updated.smart_dispatch_last_error === 'string' &&
                updated.smart_dispatch_last_error.toLowerCase().includes('all candidates exhausted')
              ) {
                setCurrentJob((prev) => mergeWalkRequest(prev, updated))
                setCurrentJobId(updated.id)
                lastActiveJobIdRef.current = updated.id
                setScreenPhase('idle')
                setScreenState('idle')
                clearSearchAttempt()
                showDispatchExhaustedMessage(updated.id)
                void fetchCurrentAndLists()
                return
              }
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
            if (completeNotifiedRef.current.has(event.jobId)) return
            if (event.jobId === currentJobId || event.jobId === lastActiveJobIdRef.current) {
              setScreenPhase('in_progress')
              setScreenState('active')
            }
            if (!startNotifiedRef.current.has(event.jobId)) {
              startNotifiedRef.current.add(event.jobId)
              showLifecycleBanner(event.jobId, 'start_walk', event.message || 'Service started.')
            }
          } else if (event.type === 'accepted') {
            showLifecycleBanner(
              event.jobId,
              'accepted',
              event.message || 'Provider is on the way.',
            )
          } else if (event.type === 'arrived') {
            if (event.jobId === currentJobId || event.jobId === lastActiveJobIdRef.current) {
              setScreenPhase('arrived_pending_confirmation')
              setScreenState('tracking')
            }
            showLifecycleBanner(event.jobId, 'arrived', event.message || 'Provider has arrived.')
            void fetchCurrentAndLists()
          } else if (event.type === 'completion_pending') {
            if (currentJob?.id === event.jobId && isCompletionReviewJob(currentJob)) return
            const walkerLabel = event.walkerName || (event.walkerId ? walkerNameById.get(event.walkerId) : null) || 'Provider'
            setPendingCompletionConfirmation({
              jobId: event.jobId,
              walkerName: walkerLabel,
              walkerId: event.walkerId ?? null,
            })
          } else if (event.type === 'complete' || event.type === 'completed') {
            flowCompletedJobIdsRef.current.add(event.jobId)
            lifecyclePhaseRef.current.set(event.jobId, 'completed')
            if (!completeNotifiedRef.current.has(event.jobId)) {
              completeNotifiedRef.current.add(event.jobId)
              showLifecycleBanner(event.jobId, 'complete', event.message || 'Service completed.')
            }
            if (
              event.walkerId &&
              !ratedJobIds.has(event.jobId) &&
              !dismissedCompletionIdsRef.current.has(event.jobId)
            ) {
              setCompletionReviewJob(null)
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
    currentJob,
    walkerNameById,
    fetchCurrentAndLists,
    loadWalkerName,
    clearActiveState,
    ratedJobIds,
    showLifecycleBanner,
    screenState,
    showDispatchExhaustedMessage,
    shouldShowCompletionReview,
  ])

  useEffect(() => {
    if (!currentJob || currentJob.status !== 'accepted' || !currentJob.provider_arrived_at) return
    if (currentJob.client_arrival_confirmed_at) return
    if (arriveNotifiedRef.current.has(currentJob.id)) return

    arriveNotifiedRef.current.add(currentJob.id)
    setSuccessMessage('Provider has arrived.')
  }, [currentJob])

  useEffect(() => {
    if (
      currentJob &&
      currentJob.status === 'accepted' &&
      currentJob.service_started_at &&
      currentJob.service_completed_at &&
      !isCompletionReviewJob(currentJob)
    ) {
      setPendingCompletionConfirmation((prev) => {
        if (prev?.jobId === currentJob.id) return prev
        const walkerLabel = currentJob.walker_id
          ? walkerNameById.get(currentJob.walker_id) || 'Provider'
          : 'Provider'
        return {
          jobId: currentJob.id,
          walkerName: walkerLabel,
          walkerId: currentJob.walker_id,
        }
      })
    } else if (
      currentJob &&
      currentJob.status === 'accepted' &&
      (!currentJob.service_completed_at || isCompletionReviewJob(currentJob))
    ) {
      setPendingCompletionConfirmation((prev) => {
        if (prev?.jobId === currentJob.id) return null
        return prev
      })
    }
    if (currentJob && isCompletionReviewJob(currentJob)) {
      const walkerLabel = currentJob.walker_id
        ? walkerNameById.get(currentJob.walker_id) || 'Provider'
        : 'Provider'
      setCompletionReviewJob(
        shouldShowCompletionReview(currentJob.id)
          ? {
              jobId: currentJob.id,
              walkerId: currentJob.walker_id,
              walkerName: walkerLabel,
            }
          : null,
      )
      return
    }
    setCompletionReviewJob((prev) => {
      if (prev?.jobId === currentJob?.id) return null
      return prev
    })
  }, [currentJob, walkerNameById, shouldShowCompletionReview])

  const confirmArrival = useCallback(async () => {
    if (!currentJobId) return

    setArrivalConfirming(true)
    setError(null)

    const now = new Date().toISOString()
    const { data, error: confirmError } = await supabase
      .from('walk_requests')
      .update({ client_arrival_confirmed_at: now })
      .eq('id', currentJobId)
      .eq('client_id', profileId)
      .eq('status', 'accepted')
      .not('provider_arrived_at', 'is', null)
      .is('client_arrival_confirmed_at', null)
      .select(JOB_SELECT)
      .maybeSingle()

    if (confirmError) {
      setError(confirmError.message)
      setArrivalConfirming(false)
      return
    }

    if (data) {
      const nextJob = data as WalkRequestRow
      setCurrentJob((prev) => mergeWalkRequest(prev, nextJob))
      setScreenPhase('arrival_confirmed')
      setScreenState('tracking')
    } else {
      setCurrentJob((prev) =>
        prev
          ? mergeWalkRequest(prev, {
              ...prev,
              client_arrival_confirmed_at: now,
            })
          : prev,
      )
      setScreenPhase('arrival_confirmed')
      setScreenState('tracking')
    }

    setSuccessMessage('Arrival confirmed.')
    setArrivalConfirming(false)
    void fetchCurrentAndLists()
  }, [currentJobId, fetchCurrentAndLists, profileId])

  const confirmCompletion = useCallback(async () => {
    const pending =
      pendingCompletionConfirmation ??
      (currentJob?.service_completed_at
        ? {
            jobId: currentJob.id,
            walkerId: currentJob.walker_id,
            walkerName: currentJob.walker_id
              ? walkerNameById.get(currentJob.walker_id) || 'Provider'
              : 'Provider',
          }
        : null)

    if (!pending) {
      if (import.meta.env.DEV) {
        console.error('[confirmCompletion] No pending completion state')
      }
      return
    }

    if (import.meta.env.DEV) {
      console.log('[confirmCompletion] Starting confirmation', {
        requestId: pending.jobId,
        walkerId: pending.walkerId,
        currentJobId: currentJob?.id ?? null,
      })
    }

    const fallbackJob =
      (currentJob?.id === pending.jobId ? currentJob : null) ??
      completedJobs.find((job) => job.id === pending.jobId) ??
      null

    setCompletionConfirming(true)
    setError(null)
    setCompletionConfirmError(null)

    try {
      const payload = { jobId: pending.jobId }
      if (import.meta.env.DEV) {
        console.log('[confirmCompletion] Invoking capture-payment', payload)
      }
      const { data, error: captureErr } = await invokeEdgeFunction<CapturePaymentResponse>(
        'capture-payment',
        { body: payload },
      )

      if (captureErr) {
        if (import.meta.env.DEV) {
          console.error('[confirmCompletion] Capture error:', captureErr)
        }
        const message = String(captureErr)
        setError(message)
        setCompletionConfirmError(message)
        return
      }
      if (import.meta.env.DEV) {
        console.log('[confirmCompletion] capture-payment result', data)
      }
      if (data && data.jobId && data.jobId !== pending.jobId) {
        const mismatchMessage = `Completion returned an unexpected job (${data.jobId}). Please refresh and try again.`
        if (import.meta.env.DEV) {
          console.error('[confirmCompletion] Job id mismatch', {
            expected: pending.jobId,
            received: data.jobId,
          })
        }
        setError(mismatchMessage)
        setCompletionConfirmError(mismatchMessage)
        return
      }
      if (data && !data.success && !data.alreadyCompleted && !data.alreadyCaptured) {
        const message = data.details || data.error || 'Payment capture failed.'
        setError(message)
        setCompletionConfirmError(message)
        return
      }

      const refreshedJob = await fetchJobById(pending.jobId)
      const paidAt = data?.paidAt ?? new Date().toISOString()
      const completedJob =
        refreshedJob?.status === 'completed'
          ? refreshedJob
          : fallbackJob
            ? mergeWalkRequest(fallbackJob, {
                ...fallbackJob,
                status: 'completed',
                payment_status: 'paid',
                paid_at: paidAt,
                service_completed_at: fallbackJob.service_completed_at ?? paidAt,
              })
            : null

      setPendingCompletionConfirmation(null)
      setCompletionConfirmError(null)
      setCompletionReviewJob(null)
      flowCompletedJobIdsRef.current.add(pending.jobId)
      lifecyclePhaseRef.current.set(pending.jobId, 'completed')

      if (completedJob) {
        setCompletedJobs((prev) => {
          const existing = prev.find((job) => job.id === completedJob.id) ?? null
          const nextJob = {
            ...(existing ?? {}),
            ...completedJob,
            hidden_by_client: hiddenHistoryIds.has(completedJob.id),
            tip_amount: existing?.tip_amount ?? null,
          }
          const remaining = prev.filter((job) => job.id !== completedJob.id)
          return [nextJob, ...remaining].sort((a, b) => getJobEventTime(b) - getJobEventTime(a))
        })
      }

      clearActiveState()

      if (pending.walkerId && !ratedJobIds.has(pending.jobId)) {
        setCompletionJob({
          jobId: pending.jobId,
          walkerId: pending.walkerId,
          walkerName: pending.walkerName,
        })
      }

      void fetchCurrentAndLists()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Payment capture failed.'
      if (import.meta.env.DEV) {
        console.error('[confirmCompletion] Unhandled error:', err)
      }
      setError(message)
      setCompletionConfirmError(message)
    } finally {
      setCompletionConfirming(false)
    }
  }, [
    pendingCompletionConfirmation,
    currentJob,
    walkerNameById,
    completedJobs,
    fetchJobById,
    hiddenHistoryIds,
    ratedJobIds,
    clearActiveState,
    fetchCurrentAndLists,
  ])

  const rejectCompletion = useCallback(async () => {
    const pending = pendingCompletionConfirmation
    if (!pending) return

    setError(null)
    setCompletionConfirmError(null)
    const now = new Date().toISOString()
    const targetJob =
      (currentJob?.id === pending.jobId ? currentJob : null) ?? (await fetchJobById(pending.jobId))
    const nextNotes = appendCompletionReviewMarker(targetJob?.notes, now)
    const nextDismissedIds = new Set(dismissedCompletionReviewIds)
    nextDismissedIds.delete(pending.jobId)
    persistDismissedCompletionReviewIds(nextDismissedIds)

    const { data, error: updateErr } = await supabase
      .from('walk_requests')
      .update({ notes: nextNotes })
      .eq('id', pending.jobId)
      .eq('client_id', profileId)
      .eq('status', 'accepted')
      .select(JOB_SELECT)
      .maybeSingle()

    if (updateErr) {
      setError(updateErr.message)
      return
    }

    const updatedJob = (data as WalkRequestRow | null) ?? null
    setPendingCompletionConfirmation(null)
    setCompletionConfirmError(null)
    setCompletionJob(null)
    setTipJob(null)
    if (updatedJob?.walker_id) {
      void loadWalkerName(updatedJob.walker_id)
    }
    if (updatedJob) {
      setCurrentJob((prev) => mergeWalkRequest(prev, updatedJob))
      setCurrentJobId(updatedJob.id)
      lastActiveJobIdRef.current = updatedJob.id
      setCompletionReviewJob({
        jobId: updatedJob.id,
        walkerId: updatedJob.walker_id,
        walkerName: updatedJob.walker_id
          ? walkerNameById.get(updatedJob.walker_id) || pending.walkerName
          : pending.walkerName,
      })
    }
    setScreenPhase('idle')
    setScreenState('idle')
    clearSearchAttempt()
    void fetchCurrentAndLists()
  }, [
    pendingCompletionConfirmation,
    profileId,
    currentJob,
    dismissedCompletionReviewIds,
    fetchJobById,
    fetchCurrentAndLists,
    loadWalkerName,
    persistDismissedCompletionReviewIds,
    walkerNameById,
    clearSearchAttempt,
  ])

  const dismissCompletionReview = useCallback(() => {
    if (!completionReviewJob) return
    const nextIds = new Set(dismissedCompletionReviewIds)
    nextIds.add(completionReviewJob.jobId)
    persistDismissedCompletionReviewIds(nextIds)
    setCompletionReviewJob(null)
    setPendingCompletionConfirmation(null)
    setCompletionJob(null)
    setTipJob(null)
    setScreenPhase('idle')
    setScreenState('idle')
  }, [completionReviewJob, dismissedCompletionReviewIds, persistDismissedCompletionReviewIds])

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
      setTipJob({
        jobId: completionJob.jobId,
        walkerId,
        walkerName: walkerLabel,
      })
      setCompletionJob(null)
      void fetchCurrentAndLists()
    },
    [completionJob, completedJobs, profileId, walkerNameById, fetchCurrentAndLists],
  )

  const dismissCompletion = useCallback(() => {
    setCompletionJob((current) => {
      if (current) {
        if (current.walkerId) {
          setTipJob({
            jobId: current.jobId,
            walkerId: current.walkerId,
            walkerName: current.walkerName,
          })
        }
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
      } else {
        resetBookingComposerAfterCompletion()
      }
      return null
    })
  }, [profileId, resetBookingComposerAfterCompletion])

  const submitTip = useCallback(
    async (amount: number) => {
      if (!tipJob || amount <= 0) return

      setTipSubmitting(true)
      const { error: tipError } = await supabase.from('walker_tips').insert({
        walk_request_id: tipJob.jobId,
        client_id: profileId,
        walker_id: tipJob.walkerId,
        amount,
        currency: 'ILS',
        status: 'pending_payment',
      })

      if (tipError && tipError.code !== '23505') {
        setError(tipError.message)
        setTipSubmitting(false)
        return
      }

      if (!tipError) {
        try {
          await createNotification({
            userId: tipJob.walkerId,
            type: 'payment_received',
            title: 'Tip received',
            message: `You received a ₪${amount} tip`,
            relatedJobId: tipJob.jobId,
          })
        } catch {
          // noop
        }
      }

      setTipSubmitting(false)
      setTipJob(null)
      resetBookingComposerAfterCompletion()
      setSuccessMessage('Tip saved')
      void fetchCurrentAndLists()
    },
    [fetchCurrentAndLists, profileId, resetBookingComposerAfterCompletion, tipJob],
  )

  const dismissTip = useCallback(() => {
    setTipJob(null)
    resetBookingComposerAfterCompletion()
  }, [resetBookingComposerAfterCompletion])

  const requestWalk = useCallback(async () => {
    if (!dogName.trim()) {
      setError('Enter name')
      return
    }
    if (!location.trim()) {
      setError('Enter location')
      return
    }
    if (!duration) {
      setError('Choose duration')
      return
    }
    if (!savedCard || !stripeCustomerId) {
      setError('Add a valid payment method before booking')
      return
    }

    const preferredLiveLocation =
      latestResolvedLocationRef.current &&
      (!location.trim() || location.trim() === lastAutoLocationRef.current)
        ? latestResolvedLocationRef.current
        : location.trim()

    const bookingLocation = formatShortAddress(preferredLiveLocation) || preferredLiveLocation
    let createdJobId: string | null = null

    try {
      setLoading(true)
      setError(null)
      setSuccessMessage(null)
      setAvailabilityNotice(null)
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
      createdJobId = jobId
      saveReusableServiceName(dogName)
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

      if (shouldSearchNow) {
        dismissedExhaustedRequestIdRef.current = null
        setCurrentJobId(createdJob.id)
        setCurrentJob(createdJob)
        lastActiveJobIdRef.current = createdJob.id

        const { data: walkers, error: walkersError } = await supabase
          .from('profiles')
          .select('id, last_lat, last_lng')
          .eq('role', 'walker')
          .eq('is_online', true)

        if (walkersError) {
          throw new Error(walkersError.message)
        }

        const onlineWalkers = (walkers as DispatchWalkerProfile[] | null) ?? []
        const walkerIds = onlineWalkers.map((walker) => walker.id)

        let ratingsByWalker = new Map<string, { total: number; count: number }>()
        if (walkerIds.length > 0) {
          const { data: ratingsRows, error: ratingsError } = await supabase
            .from('ratings')
            .select('to_user_id, rating')
            .in('to_user_id', walkerIds)

          if (ratingsError) {
            throw new Error(ratingsError.message)
          }

          ratingsByWalker = ((ratingsRows as DispatchRatingRow[] | null) ?? []).reduce((map, row) => {
            const current = map.get(row.to_user_id) ?? { total: 0, count: 0 }
            current.total += row.rating
            current.count += 1
            map.set(row.to_user_id, current)
            return map
          }, new Map<string, { total: number; count: number }>())
        }

        const ranked = rankWalkerCandidates(
          onlineWalkers.map((walker) => {
            const ratingStats = ratingsByWalker.get(walker.id)
            const hasWalkerLocation =
              userLocation &&
              typeof walker.last_lat === 'number' &&
              Number.isFinite(walker.last_lat) &&
              typeof walker.last_lng === 'number' &&
              Number.isFinite(walker.last_lng)

            return {
              walkerId: walker.id,
              distanceKm: hasWalkerLocation
                ? distanceKm(userLocation![0], userLocation![1], walker.last_lat!, walker.last_lng!)
                : null,
              avgRating:
                ratingStats && ratingStats.count > 0
                  ? ratingStats.total / ratingStats.count
                  : null,
              reviewCount: ratingStats?.count ?? 0,
            }
          }),
        ).map((candidate) => ({
          walkerId: candidate.walkerId,
          score: candidate.score,
          meta: {
            source: 'useClientFlow',
            distance_score: candidate.distanceScore,
            rating_score: candidate.ratingScore,
            review_count_score: candidate.reviewCountScore,
            distance_km: candidate.distanceKm,
            avg_rating: candidate.avgRating,
            review_count: candidate.reviewCount,
          },
        }))

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

        beginSearchAttempt()
        setScreenState('searching')
        setScreenPhase('searching')
        setSuccessMessage('Searching for a walker...')
        _setDuration(null)
      } else {
        dismissedExhaustedRequestIdRef.current = null
        setBookingTiming('asap')
        setScheduledFor(null)
        clearSearchAttempt()
        setScreenState('idle')
        setCurrentJob(null)
        setCurrentJobId(null)
        setSuccessMessage('Scheduled walk saved')
        _setDuration(null)
      }

      void fetchCurrentAndLists()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to request walk'
      const wasCancelled =
        message.toLowerCase().includes('request is not open') &&
        createdJobId != null &&
        suppressedActiveRequestIdsRef.current.has(createdJobId)
      if (wasCancelled) {
        // Suppress — user already cancelled; showing this would overwrite the success message
      } else if (isDispatchUnavailableMessage(message)) {
        setError(null)
        setAvailabilityNotice({
          title: 'No providers available right now',
          subtitle: 'Try again in a few minutes',
        })
      } else {
        setError(message)
        setAvailabilityNotice(null)
      }
      setScreenState('idle')
      clearSearchAttempt()
      setCurrentJob(null)
      setCurrentJobId(null)
    } finally {
      setLoading(false)
    }
  }, [
    adjustedPriceILS,
    bookingTiming,
    beginSearchAttempt,
    clearSearchAttempt,
    dogName,
    duration,
    fetchCurrentAndLists,
    location,
    persistBookingDraft,
    profileId,
    savedCard,
    scheduledFor,
    stripeCustomerId,
    saveReusableServiceName,
  ])

  return {
    screenState,
    screenPhase,
    setScreenState,
    searchStartTime,

    dogName,
    setDogName,

    location,
    setLocation,
    addressSource,
    refreshLocation,
    locationLoading,
    locationRefreshing,
    locationError,

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
    availabilityNotice,
    clearError,
    clearSuccess,
    clearAvailabilityNotice,
    dismissExhaustedRequest,
    clearExhaustedRequestForRetry,

    savedCard,
    upcomingJobs,
    completedJobs,
    ratings,
    ratingsReceived,
    favoriteWalkers,
    favoriteWalkerIds,
    recentRatings: ratings.slice(0, 8),
    recentRatingsReceived: ratingsReceived.slice(0, 8),
    walkerNameById,
    completionJob,
    completionReviewJob,
    tipJob,

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
    arrivalConfirming,
    completionConfirming,
    completionConfirmError,
    pendingCompletionConfirmation,
    confirmCompletion,
    rejectCompletion,
    dismissCompletionReview,
    tipSubmitting,
    ratedJobIds,

    startsInMinutes,
    hideHistoryItem,
    confirmArrival,
    cancelSearch,
    cancelScheduledJob,
    requestCardSetup,
    changeCard,
    onCardSetupComplete,
    cancelCardSetup,
    retryLoadCard,
    toggleFavoriteWalker,
    submitCompletionRating,
    dismissCompletion,
    submitTip,
    dismissTip,
    requestWalk,
  }
}
