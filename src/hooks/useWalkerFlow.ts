import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase, invokeEdgeFunction } from '../services/supabaseClient'
import { createNotification } from '../components/NotificationsBell'
import { useWalkerTracking } from './useWalkerTracking'
import { track, AnalyticsEvent } from '../lib/analytics'

export type WalkerScreenState =
  | 'offline'
  | 'waiting'
  | 'incoming_request'
  | 'active'
  | 'completed'

interface WalkRequestRow {
  id: string
  client_id: string
  walker_id: string | null
  selected_walker_id: string | null
  status: 'open' | 'accepted' | 'completed' | 'cancelled'
  dog_name: string | null
  location: string | null
  address: string | null
  notes: string | null
  created_at: string | null
  price: number | null
  platform_fee: number | null
  walker_earnings: number | null
  payment_status: 'unpaid' | 'authorized' | 'paid' | 'failed' | 'refunded'
  paid_at: string | null
  stripe_payment_intent_id: string | null
  booking_timing?: 'asap' | 'scheduled'
  scheduled_for?: string | null
  dispatch_state?: 'queued' | 'dispatched' | 'expired' | 'cancelled' | null
  smart_dispatch_state?:
    | 'idle'
    | 'dispatching'
    | 'assigned'
    | 'exhausted'
    | 'cancelled'
    | null
  client?: { id: string; full_name: string | null; email: string | null } | null
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
  location: string | null
  address: string | null
  notes: string | null
  request_created_at: string | null
  price: number | null
  platform_fee: number | null
  walker_earnings: number | null
  payment_status: 'unpaid' | 'authorized' | 'paid' | 'failed' | 'refunded'
  paid_at: string | null
  stripe_payment_intent_id: string | null
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

interface ConnectStatus {
  connected: boolean
  stripe_connect_account_id: string | null
  stripe_connect_onboarding_complete: boolean
  payouts_enabled: boolean
  charges_enabled: boolean
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
  const [openJobs, setOpenJobs] = useState<WalkRequestRow[]>([])
  const [myJobs, setMyJobs] = useState<WalkRequestRow[]>([])
  const [activeOffers, setActiveOffers] = useState<DispatchOfferRow[]>([])

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

  const [completingJobId, setCompletingJobId] = useState<string | null>(null)
  const [completionSuccess, setCompletionSuccess] = useState<{
    jobId: string
    clientId: string
    dogName: string
    earnings: number | null
    clientName: string
  } | null>(null)

  const [completionRatingSubmitting, setCompletionRatingSubmitting] = useState(false)

  const [isOnline, setIsOnline] = useState(false)
  const [onlineLoading, setOnlineLoading] = useState(true)

  const [takenNotice, setTakenNotice] = useState(false)
  const prevOfferIdsRef = useRef<Set<string>>(new Set())
  const prevFutureIdsRef = useRef<Set<string>>(new Set())
  const transitionInitRef = useRef(false)
  const autoDispatchInFlightRef = useRef<Set<string>>(new Set())
  const dismissedCompletionIdsRef = useRef<Set<string>>(new Set())

  const firstName = (profileName || '').split(' ')[0] || profileName

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

  const futureJobs = useMemo(() => myJobs.filter((j) => isFutureJob(j)), [myJobs])

  const activeJobs = useMemo(
    () => myJobs.filter((j) => j.status === 'accepted' && isDispatchedScheduledJob(j) && !isFutureJob(j)),
    [myJobs],
  )

  const assignedJobs = useMemo(() => [...activeJobs, ...futureJobs], [activeJobs, futureJobs])

  const completedJobs = useMemo(
    () => myJobs.filter((j) => j.status === 'completed' || j.status === 'cancelled'),
    [myJobs],
  )

  const activeJobIds = useMemo(() => activeJobs.map((j) => j.id), [activeJobs])
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
    const id = setInterval(broadcast, 5_000)
    return () => clearInterval(id)
  }, [isOnline, profileId])

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

        setSuccessMessage('Walk is now active')
        track(AnalyticsEvent.SERVICE_STARTED, {
          request_id: job.id,
          provider_id: profileId,
          client_id: data.client_id ?? undefined,
          source_screen: 'walker_dashboard',
        })

        if (data.client_id) {
          await createNotification({
            userId: data.client_id,
            type: 'dispatch_started',
            title: 'Your walk is starting',
            message: `${profileName} is on the way for ${dogLabel}.`,
            relatedJobId: job.id,
          })
        }

        await createNotification({
          userId: profileId,
          type: 'dispatch_started',
          title: 'Walk is now active',
          message: `Head to ${dogLabel}'s pickup. Tracking is live now.`,
          relatedJobId: job.id,
        })

        if (data.client_id) {
          invokeEdgeFunction('send-push-notification', {
            body: {
              title: 'Your walk is starting',
              body: `${profileName} is on the way for ${dogLabel}.`,
              targetUserId: data.client_id,
              data: { jobId: job.id },
            },
          }).catch((err) => console.error('[Push] Failed to notify client (dispatch):', err))
        }

        invokeEdgeFunction('send-push-notification', {
          body: {
            title: 'Walk is now active',
            body: `Tracking is live for ${dogLabel}.`,
            targetUserId: profileId,
            data: { jobId: job.id },
          },
        }).catch((err) => console.error('[Push] Failed to notify walker (dispatch):', err))

        return true
      } finally {
        autoDispatchInFlightRef.current.delete(job.id)
      }
    },
    [profileId, profileName, walkerPosition],
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
    if (!walkerPosition || activeJobs.length === 0) return

    let cancelled = false

    const pushActiveJobLocation = async () => {
      if (cancelled) return
      const pos = walkerPosRef.current
      if (!pos) return

      const activeTrackingIds = activeJobs
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
  }, [activeJobs, profileId, walkerPosition])

  const pendingFromJobs = useMemo(() => {
    return myJobs
      .filter((j) => j.status === 'accepted' && j.payment_status === 'authorized')
      .reduce((sum, j) => sum + (j.walker_earnings ?? (j.price != null ? j.price * 0.8 : 0)), 0)
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
    if (assignedJobs.length > 0) return 'active'
    if (isOnline && visibleOpenJobs.length > 0) return 'incoming_request'
    if (isOnline) return 'waiting'
    return 'offline'
  }, [completionSuccess, assignedJobs, isOnline, visibleOpenJobs])

  useEffect(() => {
    if (completionSuccess) return

    const pendingCompletion = completedJobs.find(
      (job) =>
        job.status === 'completed' &&
        !!job.client_id &&
        !ratedJobIds.has(job.id) &&
        !dismissedCompletionIdsRef.current.has(job.id),
    )

    if (!pendingCompletion) return

    setCompletionSuccess({
      jobId: pendingCompletion.id,
      clientId: pendingCompletion.client_id,
      dogName: pendingCompletion.dog_name || 'the dog',
      earnings:
        pendingCompletion.walker_earnings ??
        (pendingCompletion.price != null ? Math.round(pendingCompletion.price * 0.8 * 100) / 100 : null),
      clientName: pendingCompletion.client?.full_name || pendingCompletion.client?.email || 'Client',
    })
  }, [completedJobs, completionSuccess, ratedJobIds])

  useEffect(() => {
    const futureIds = new Set(futureJobs.map((j) => j.id))

    if (!transitionInitRef.current) {
      prevFutureIdsRef.current = futureIds
      transitionInitRef.current = true
      return
    }

    const becameActive = activeJobs.find((j) => prevFutureIdsRef.current.has(j.id))
    prevFutureIdsRef.current = futureIds

    if (becameActive) {
      setSuccessMessage('Walk is now active')
    }
  }, [futureJobs, activeJobs])

  const fetchAll = useCallback(async () => {
    setLoading(true)
    setError(null)

    const selectFields =
      'id, client_id, walker_id, selected_walker_id, status, dog_name, location, address, notes, created_at, price, platform_fee, walker_earnings, payment_status, paid_at, stripe_payment_intent_id, booking_timing, scheduled_for, dispatch_state, smart_dispatch_state, client:profiles!walk_requests_client_id_fkey(id, full_name, email)'

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
              location: request?.location ?? null,
              address: request?.address ?? null,
              notes: request?.notes ?? null,
              request_created_at: request?.created_at ?? attempt.created_at,
              price: request?.price ?? null,
              platform_fee: request?.platform_fee ?? null,
              walker_earnings: request?.walker_earnings ?? null,
              payment_status: request?.payment_status ?? 'authorized',
              paid_at: request?.paid_at ?? null,
              stripe_payment_intent_id: request?.stripe_payment_intent_id ?? null,
              booking_timing: request?.booking_timing,
              scheduled_for: request?.scheduled_for ?? null,
              smart_dispatch_state: request?.smart_dispatch_state ?? 'dispatching',
              client_full_name: request?.client?.full_name ?? null,
              client_email: request?.client?.email ?? null,
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
            location: request?.location ?? null,
            address: request?.address ?? null,
            notes: request?.notes ?? null,
            created_at: request?.created_at ?? attempt.created_at,
            price: request?.price ?? null,
            platform_fee: request?.platform_fee ?? null,
            walker_earnings: request?.walker_earnings ?? null,
            payment_status: request?.payment_status ?? 'authorized',
            paid_at: request?.paid_at ?? null,
            stripe_payment_intent_id: request?.stripe_payment_intent_id ?? null,
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

    setActiveOffers(offers)

    const newOpen: WalkRequestRow[] = offers.map((offer) => ({
      id: offer.request_id,
      client_id: offer.client_id ?? '',
      walker_id: null,
      selected_walker_id: offer.selected_walker_id,
      status: 'open' as const,
      dog_name: offer.dog_name,
      location: offer.location,
      address: offer.address,
      notes: offer.notes,
      created_at: offer.request_created_at,
      price: offer.price,
      platform_fee: offer.platform_fee,
      walker_earnings: offer.walker_earnings,
      payment_status: offer.payment_status,
      paid_at: offer.paid_at,
      stripe_payment_intent_id: offer.stripe_payment_intent_id,
      booking_timing: offer.booking_timing,
      scheduled_for: offer.scheduled_for,
      dispatch_state: offer.dispatch_state as WalkRequestRow['dispatch_state'],
      smart_dispatch_state: offer.smart_dispatch_state,
      client: {
        id: offer.client_id ?? '',
        full_name: offer.client_full_name,
        email: offer.client_email,
      },
    })).sort((a, b) => {
      const aOffer = offers.find((o) => o.request_id === a.id)
      const bOffer = offers.find((o) => o.request_id === b.id)
      return (aOffer?.attempt_no ?? 9999) - (bOffer?.attempt_no ?? 9999)
    })

    const { data: mine, error: mineErr } = await supabase
      .from('walk_requests')
      .select(selectFields)
      .eq('walker_id', profileId)
      .order('created_at', { ascending: false })

    if (mineErr) {
      setError(mineErr.message)
      setLoading(false)
      return
    }

    let newMine = (((mine as Record<string, unknown>[] | null) ?? []).map((row) => ({
      ...row,
      client: Array.isArray(row.client) ? row.client[0] || null : row.client,
    })) as WalkRequestRow[])

    if (acceptedJobsFromAttempts.length > 0) {
      const mineIds = new Set(newMine.map((job) => job.id))
      newMine = [
        ...acceptedJobsFromAttempts.filter((job) => !mineIds.has(job.id)),
        ...newMine,
      ]
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
    setLoading(false)
  }, [profileId, declinedIds])


  useEffect(() => {
    if (!isOnline) return

    const id = window.setInterval(() => {
      void fetchAll()
    }, 4000)

    return () => window.clearInterval(id)
  }, [isOnline, fetchAll])

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
    setConnectLoading(true)
    setConnectError(null)
    try {
      const hasAuth = await prepareEdgeFunctionAuth()
      if (!hasAuth) {
        setConnectError('Authentication issue. Please refresh and try again.')
        setConnectLoading(false)
        return
      }
      const { data, error } = await invokeEdgeFunction<ConnectStatus>('get-connect-status')
      if (error) {
        setConnectError(error || 'Failed to load payout account status.')
        setConnectLoading(false)
        return
      }
      if (!data) {
        setConnectError('Empty response.')
        setConnectLoading(false)
        return
      }
      setConnectStatus(data as ConnectStatus)
      setConnectError(null)
    } catch {
      setConnectError('Failed to load payout account status.')
    } finally {
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
    setIsOnline(newValue)

    const { error } = await supabase.from('profiles').update({ is_online: newValue }).eq('id', profileId)
    if (error) {
      console.error('[useWalkerFlow] toggleOnline error:', error.message)
      setIsOnline(!newValue)
    }
  }, [isOnline, profileId])

  useEffect(() => {
    fetchAll()
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

    const tSub = setTimeout(() => {
      ch1 = supabase
        .channel(`wf-requests-${profileId}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'walk_requests' }, () => {
          void fetchAll()
          void fetchWallet()
        })
        .subscribe()

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

      ch5 = supabase
        .channel(`wf-dispatch-${profileId}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'dispatch_candidates', filter: `walker_id=eq.${profileId}` },
          () => {
            void fetchAll()
          },
        )
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'dispatch_attempts' },
          () => {
            void fetchAll()
          },
        )
        .subscribe()
    }, 800)

    return () => {
      clearTimeout(t1)
      clearTimeout(t2)
      clearTimeout(tSub)
      if (ch1) supabase.removeChannel(ch1)
      if (ch2) supabase.removeChannel(ch2)
      if (ch3) supabase.removeChannel(ch3)
      if (ch4) supabase.removeChannel(ch4)
      if (ch5) supabase.removeChannel(ch5)
    }
  }, [
    profileId,
    fetchAll,
    fetchRatings,
    fetchWallet,
    fetchBalanceAdjustments,
    fetchConnectStatus,
    fetchOnlineStatus,
  ])

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

      track(AnalyticsEvent.PROVIDER_MATCHED, {
        request_id: requestId,
        provider_id: profileId,
        client_id: job.client_id ?? undefined,
        price: job.price ?? undefined,
        actor_role: 'provider',
        source_screen: 'walker_dashboard',
      })

      if (dispatchNow || job.booking_timing !== 'scheduled') {
        track(AnalyticsEvent.SERVICE_STARTED, {
          request_id: requestId,
          provider_id: profileId,
          client_id: job.client_id ?? undefined,
          source_screen: 'walker_dashboard',
        })
      }

      setSuccessMessage(dispatchNow ? 'Walk is now active' : 'Job accepted!')
      await fetchAll()

      const dogLabel = job.dog_name || 'a dog'

      if (job.client_id) {
        const isScheduled = job.booking_timing === 'scheduled'
        await createNotification({
          userId: job.client_id,
          type: dispatchNow ? 'dispatch_started' : 'job_accepted',
          title: dispatchNow ? 'Your walk is starting' : 'Walker Accepted',
          message: dispatchNow
            ? `${profileName} is on the way for ${dogLabel}.`
            : isScheduled
              ? `${profileName} accepted your scheduled walk for ${dogLabel}. Dispatch will start at the booked time.`
              : `${profileName} accepted your walk request for ${dogLabel}.`,
          relatedJobId: requestId,
        })

        invokeEdgeFunction('send-push-notification', {
          body: {
            title: dispatchNow ? 'Your walk is starting' : 'Walker Accepted',
            body: dispatchNow
              ? `${profileName} is on the way for ${dogLabel}.`
              : isScheduled
                ? `${profileName} confirmed ${dogLabel}'s scheduled walk.`
                : `${profileName} is on the way for ${dogLabel}'s walk!`,
            targetUserId: job.client_id,
            data: { jobId: requestId },
          },
        }).catch((err) => console.error('[Push] Failed to notify client (accepted):', err))
      }

      await createNotification({
        userId: profileId,
        type: dispatchNow ? 'dispatch_started' : 'job_accepted_self',
        title: dispatchNow ? 'Walk is now active' : 'Job Accepted',
        message: dispatchNow
          ? `Tracking is live for ${dogLabel}.`
          : job.booking_timing === 'scheduled'
            ? `You accepted a scheduled walk for ${dogLabel}. It will move to active only when dispatch starts.`
            : `You accepted a walk for ${dogLabel}. Head to the location and start the walk!`,
        relatedJobId: requestId,
      })
    },
    [activeOffers, openJobs, profileId, profileName, fetchAll, walkerPosition],
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
    async (requestId: string) => {
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

      if (!offer) {
        await fetchAll()
        return
      }

      const hasAuth = await prepareEdgeFunctionAuth()
      if (!hasAuth) {
        setError('Authentication issue. Please refresh and try again.')
        return
      }

      const { error: fnError } = await invokeEdgeFunction('decline-dispatch', {
        body: {
          requestId,
          attemptId: offer.id,
          timeoutSeconds: 12,
        },
      })

      if (fnError) {
        console.error('[useWalkerFlow] decline dispatch error:', fnError)
      }

      await fetchAll()
    },
    [profileId, activeOffers, fetchAll],
  )

  const handleComplete = useCallback(
    async (id: string) => {
      setError(null)
      setSuccessMessage(null)

      const job = myJobs.find((j) => j.id === id)
      if (job?.booking_timing === 'scheduled' && job.dispatch_state !== 'dispatched') {
        setError('This future order is not active yet. Completion is available only after dispatch starts.')
        return
      }

      setCompletingJobId(id)

      try {
        if (job?.stripe_payment_intent_id) {
          const { data, error: captureErr } = await invokeEdgeFunction<{
            success?: boolean
            error?: string
            details?: string
            alreadyCompleted?: boolean
            alreadyCaptured?: boolean
          }>('capture-payment', { body: { jobId: id } })

          if (captureErr) {
            console.error('[handleComplete] Edge function error:', captureErr)
            await fetchAll()
            const refreshedJob = myJobs.find((j) => j.id === id)
            if (refreshedJob?.status !== 'completed') {
              setError(`Completion failed: ${captureErr}. Tap to retry.`)
              return
            }
          } else if (!data?.success) {
            console.error('[handleComplete] Capture returned failure:', data)
            const details = data?.details || ''

            if (details.includes('requires_payment_method') || details.includes('requires_confirmation')) {
              console.error('[handleComplete] Upstream payment failure — releasing job', id)
              setError("This walk cannot be completed because the client's payment was never authorized. The job has been released.")
              await supabase
                .from('walk_requests')
                .update({
                  status: 'cancelled',
                  walker_lat: null,
                  walker_lng: null,
                  last_location_update: null,
                })
                .eq('id', id)
              await fetchAll()
              return
            }

            await fetchAll()
            const refreshedJob = myJobs.find((j) => j.id === id)
            if (refreshedJob?.status !== 'completed') {
              setError(data?.details || data?.error || 'Failed to capture payment. Tap to retry.')
              return
            }
          }
        } else {
          const { error } = await supabase
            .from('walk_requests')
            .update({
              status: 'completed',
              walker_lat: null,
              walker_lng: null,
              last_location_update: null,
            })
            .eq('id', id)
          if (error) {
            setError(error.message)
            return
          }
        }

        const earnings =
          job?.walker_earnings ??
          (job?.price != null ? Math.round(job.price * 0.8 * 100) / 100 : null)

        track(AnalyticsEvent.SERVICE_COMPLETED, {
          request_id: id,
          provider_id: profileId,
          client_id: job?.client_id ?? undefined,
          price: job?.price ?? undefined,
          earnings: earnings ?? undefined,
          actor_role: 'provider',
          source_screen: 'walker_dashboard',
        })

        track(AnalyticsEvent.PAYMENT_CAPTURED, {
          request_id: id,
          provider_id: profileId,
          price: job?.price ?? undefined,
          payment_intent_id: job?.stripe_payment_intent_id ?? undefined,
          source_screen: 'walker_dashboard',
        })

        setCompletionSuccess({
          jobId: id,
          clientId: job?.client_id || '',
          dogName: job?.dog_name || 'the dog',
          earnings,
          clientName: job?.client?.full_name || job?.client?.email || 'Client',
        })

        await fetchAll()
        await fetchWallet()

        const dogLabel = job?.dog_name || 'your dog'

        if (job?.client_id) {
          await createNotification({
            userId: job.client_id,
            type: 'job_completed',
            title: 'Walk Completed',
            message: `${profileName} completed the walk for ${dogLabel}.`,
            relatedJobId: id,
          }).catch(() => {})

          invokeEdgeFunction('send-push-notification', {
            body: {
              title: 'Walk Completed',
              body: `${dogLabel}'s walk with ${profileName} is done!`,
              targetUserId: job.client_id,
              data: { jobId: id },
            },
          }).catch((err) => console.error('[Push] Failed to notify client (completed):', err))
        }

        const notifyEarnings =
          job?.walker_earnings ??
          (job?.price != null ? Math.round((job.price ?? 0) * 0.8) : null)

        if (notifyEarnings && notifyEarnings > 0) {
          await createNotification({
            userId: profileId,
            type: 'payment_received',
            title: 'Payment Received',
            message: `${notifyEarnings} ILS has been added to your wallet for walking ${dogLabel}.`,
            relatedJobId: id,
          }).catch(() => {})

          invokeEdgeFunction('send-push-notification', {
            body: {
              title: 'Payment Received',
              body: `₪${notifyEarnings} added to your wallet for walking ${dogLabel}.`,
              targetUserId: profileId,
              data: { jobId: id },
            },
          }).catch((err) => console.error('[Push] Failed to notify walker (payment):', err))
        }
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
    [myJobs, profileId, profileName, fetchAll, fetchWallet],
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

      const { error } = await supabase.from('ratings').insert({
        job_id: ratingJobId,
        from_user_id: profileId,
        to_user_id: job.client_id,
        rating,
        review: review || null,
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
        has_review: !!review,
        actor_role: 'provider',
        source_screen: 'walker_dashboard',
      })

      await createNotification({
        userId: job.client_id,
        type: 'new_rating',
        title: 'New Rating Received',
        message: `Your walker rated you ${rating} stars for the walk with ${job.dog_name || 'your dog'}.`,
        relatedJobId: ratingJobId,
      })

      invokeEdgeFunction('send-push-notification', {
        body: {
          title: 'New Rating Received',
          body: `You received a ${rating}-star rating!`,
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

      const { error } = await supabase.from('ratings').insert({
        job_id: completionSuccess.jobId,
        from_user_id: profileId,
        to_user_id: completionSuccess.clientId,
        rating,
        review: review || null,
      })

      if (error && error.code !== '23505') {
        setError(error.message)
      } else {
        track(AnalyticsEvent.REVIEW_SUBMITTED, {
          request_id: completionSuccess.jobId,
          provider_id: profileId,
          client_id: completionSuccess.clientId,
          rating_value: rating,
          has_review: !!review,
          actor_role: 'provider',
          source_screen: 'walker_dashboard',
        })

        await createNotification({
          userId: completionSuccess.clientId,
          type: 'new_rating',
          title: 'New Rating Received',
          message: `Your walker rated you ${rating} stars for the walk with ${completionSuccess.dogName}.`,
          relatedJobId: completionSuccess.jobId,
        }).catch(() => {})

        invokeEdgeFunction('send-push-notification', {
          body: {
            title: 'New Rating Received',
            body: `You received a ${rating}-star rating!`,
            targetUserId: completionSuccess.clientId,
            data: { jobId: completionSuccess.jobId },
          },
        }).catch((err) => console.error('[Push] Failed to notify client (rating):', err))
      }

      setCompletionRatingSubmitting(false)
      await fetchRatings()
    },
    [completionSuccess, profileId, fetchRatings],
  )

  const openRatingModal = useCallback((jobId: string) => setRatingJobId(jobId), [])
  const closeRatingModal = useCallback(() => setRatingJobId(null), [])
  const dismissCompletion = useCallback(() => {
    setCompletionSuccess((current) => {
      if (current) dismissedCompletionIdsRef.current.add(current.jobId)
      return null
    })
  }, [])
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

      const { data: linkData, error: linkErr } = await invokeEdgeFunction<{ url?: string; error?: string }>('create-connect-onboarding-link')
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

      const { data, error } = await invokeEdgeFunction<{ url?: string; error?: string }>('create-connect-onboarding-link')
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
    activeJob: assignedJobs[0] ?? null,
    activeJobs: assignedJobs,
    futureJobs,
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
    handleConnectAccount,
    handleContinueOnboarding,
    fetchConnectStatus,

    completingJobId,
    completionSuccess,
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

    startsInMinutes,

    handleAccept,
    handleDecline,
    unassignFutureJob,
    handleComplete,
    handleRelease,
  }
}
