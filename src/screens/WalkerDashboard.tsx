import { hapticMedium, hapticSuccess } from '../utils/haptics'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import NotificationsBell from '../components/NotificationsBell'
import ProfileAvatar from '../components/ProfileAvatar'
import CompactRatingList from '../components/CompactRatingList'
import CompletionCard from '../components/CompletionCard'
import GroupedHistory from '../components/GroupedHistory'
import type { HistoryItem } from '../components/GroupedHistory'
import { useWalkerFlow } from '../hooks/useWalkerFlow'
import { useProfilePhoto } from '../hooks/useProfilePhoto'
import { usePushNotifications } from '../hooks/usePushNotifications'
import { supabase } from '../services/supabaseClient'
import { formatShortAddress } from '../utils/addressFormat'
import { getServiceLabels } from '../utils/serviceLifecycle'
import { getDurationSummary } from '../utils/serviceTiming'
import i18n from '../i18n'
import {
  getProfileServiceOptions,
  normalizeProfileServiceTypes,
  type ProfileServiceType,
} from '../lib/profileServiceTypes'

const REQUEST_TIMEOUT_SECONDS = 20
type MenuPage = 'main' | 'settings' | 'history' | 'futureOrders'

type AppRole = 'client' | 'walker' | 'admin'

interface WalkerDashboardProps {
  profile: {
    id: string
    email: string | null
    full_name: string | null
    role: AppRole
    service_type?: string | null
    service_types?: string[] | null
  }
  onSignOut: () => Promise<void>
  showOnboardingWowToken?: number
  stripeReturnToken?: number
}

function friendlyError(raw: string): string {
  const lower = raw.toLowerCase()
  if (lower.includes('load failed') || lower.includes('fetch') || lower.includes('network')) {
    return 'Connection issue. Retrying...'
  }
  if (lower.includes('timeout')) return 'Request timed out. Try again.'
  // Only show "Session expired" if it's truly a no_session error from auth
  if (lower.includes('no_session') && (lower.includes('auth') || lower.includes('postgres'))) {
    return 'Session expired. Please sign in again.'
  }
  if (lower.includes('invalid token') || (lower.includes('auth') && lower.includes('jwt'))) {
    return 'Authentication issue. Please refresh and try again.'
  }
  if (lower.includes('attempt_expired')) {
    return 'This offer expired. Waiting for the next request.'
  }
  if (lower.includes('permission') || lower.includes('forbidden')) {
    return "You don't have permission for this action."
  }
  if (raw.length > 60) return 'Something went wrong. Please try again.'
  return raw
}

function durationFromMinutes(minutes: number | null | undefined): string {
  if (typeof minutes !== 'number' || minutes <= 0) return '—'
  return `${minutes} min`
}

function formatRelativeDate(value: string | null | undefined): string {
  if (!value) return 'Recently'
  const dt = new Date(value)
  if (Number.isNaN(dt.getTime())) return 'Recently'

  const diffMs = Date.now() - dt.getTime()
  const diffMin = Math.round(diffMs / 60000)
  if (diffMin < 60) return 'Recently'
  if (diffMin < 24 * 60) return `${Math.floor(diffMin / 60)}h ago`
  if (diffMin < 7 * 24 * 60) return `${Math.floor(diffMin / (24 * 60))}d ago`

  return dt.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
  })
}

function providerAutoOnlineStorageKey(profileId: string) {
  return `regli_provider_auto_online_${profileId}`
}

function getPreferredCustomerKey(input: {
  clientId?: string | null
  clientName?: string | null
}): string {
  const clientId = input.clientId?.trim()
  if (clientId) return clientId
  const clientName = input.clientName?.trim()
  if (clientName) return `name:${clientName.toLowerCase()}`
  return ''
}

function isPersistableCustomerKey(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function getCustomerDisplayName(
  input: {
    client?: { full_name?: string | null; email?: string | null } | null
    clientName?: string | null
    customerName?: string | null
    requesterName?: string | null
    ownerName?: string | null
    profileName?: string | null
    userName?: string | null
    dogName?: string | null
    petName?: string | null
    orderName?: string | null
  },
  isHebrew: boolean,
): string {
  const humanName =
    input.client?.full_name?.trim() ||
    input.client?.email?.trim() ||
    input.clientName?.trim() ||
    input.customerName?.trim() ||
    input.requesterName?.trim() ||
    input.ownerName?.trim() ||
    input.profileName?.trim() ||
    input.userName?.trim()

  if (humanName) return humanName

  const orderName = input.dogName?.trim() || input.petName?.trim() || input.orderName?.trim()
  if (orderName) return orderName

  return isHebrew ? 'לקוח' : 'Customer'
}

export default function WalkerDashboard({
  profile,
  onSignOut,
  showOnboardingWowToken = 0,
  stripeReturnToken = 0,
}: WalkerDashboardProps) {
  const { t } = useTranslation()
  const walkerName = profile.full_name || profile.email || 'Walker'
  const flow = useWalkerFlow(profile.id, walkerName)
  const photo = useProfilePhoto(profile.id)
  usePushNotifications(profile.id)
  const isRtl = i18n.resolvedLanguage === 'he'
  const isHebrew = i18n.resolvedLanguage === 'he'
  const greetingLabel = isRtl ? `היי, ${walkerName}` : `Hey, ${walkerName}`
  const preferredCustomersLabel = isRtl ? 'לקוחות מועדפים' : 'Preferred customers'
  const preferredCustomersSubtitle = isRtl
    ? 'לקוחות ששמרת לגישה מהירה.'
    : 'Saved customers for quick reference.'
  const noPreferredCustomersLabel = isRtl ? 'אין עדיין לקוחות מועדפים.' : 'No preferred customers yet.'
  const profileServiceOptions = useMemo(() => getProfileServiceOptions(isHebrew), [isHebrew])
  const serviceTypeSectionTitle = isHebrew ? 'סוג שירות' : 'Service type'
  const serviceTypeSectionSubtitle = isHebrew
    ? 'בחר את סוג השירות הראשי שאתה מציע.'
    : 'Choose the main service you provide.'
  const serviceTypeSavedLabel = isHebrew ? 'סוג השירות נשמר.' : 'Service type saved.'
  const serviceTypeSavingLabel = isHebrew ? 'שומר...' : 'Saving...'
  const serviceTypeErrorLabel = isHebrew
    ? 'לא הצלחנו לשמור את סוג השירות.'
    : 'We could not save the service type.'

  const [burgerOpen, setBurgerOpen] = useState(false)
  const [menuPage, setMenuPage] = useState<MenuPage>('main')
  const [showStripeGate, setShowStripeGate] = useState(false)
  const [showOnboardingWow, setShowOnboardingWow] = useState(false)
  const [isCheckingPayout, setIsCheckingPayout] = useState(false)
  const [payoutCtaAnimationStopped, setPayoutCtaAnimationStopped] = useState(false)
  const [payoutCtaNudgeActive, setPayoutCtaNudgeActive] = useState(false)
  const [compRating, setCompRating] = useState(0)
  const [compHover, setCompHover] = useState(0)
  const [compPressed, setCompPressed] = useState(0)
  const [compReview, setCompReview] = useState('')
  const [compRatingDone, setCompRatingDone] = useState(false)
  const [hiddenHistoryIds, setHiddenHistoryIds] = useState<Set<string>>(new Set())
  const [preferredCustomerIds, setPreferredCustomerIds] = useState<Set<string>>(new Set())
  const [preferredCustomerNames, setPreferredCustomerNames] = useState<Map<string, string>>(new Map())
  const [profileServiceTypes, setProfileServiceTypes] = useState<ProfileServiceType[]>(
    normalizeProfileServiceTypes(profile.service_types ?? profile.service_type),
  )
  const [serviceTypeSaving, setServiceTypeSaving] = useState(false)
  const [serviceTypeSaveError, setServiceTypeSaveError] = useState<string | null>(null)
  const [serviceTypeSavedAt, setServiceTypeSavedAt] = useState(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const handledWowTokenRef = useRef(0)
  const autoOnlineInFlightRef = useRef(false)

  const closeAll = useCallback(() => {
    setBurgerOpen(false)
    setMenuPage('main')
  }, [])

  useEffect(() => {
    setProfileServiceTypes(normalizeProfileServiceTypes(profile.service_types ?? profile.service_type))
  }, [profile.service_type, profile.service_types])

  const handleProfileServiceTypeToggle = useCallback(async (nextServiceType: ProfileServiceType) => {
    if (serviceTypeSaving) return
    const previousServiceTypes = profileServiceTypes
    const nextServiceTypes = profileServiceTypes.includes(nextServiceType)
      ? profileServiceTypes.length > 1
        ? profileServiceTypes.filter((value) => value !== nextServiceType)
        : profileServiceTypes
      : [...profileServiceTypes, nextServiceType]

    if (nextServiceTypes === previousServiceTypes) return

    setProfileServiceTypes(nextServiceTypes)
    setServiceTypeSaving(true)
    setServiceTypeSaveError(null)

    const { error } = await supabase
      .from('profiles')
      .update({
        service_types: nextServiceTypes,
        service_type: nextServiceTypes[0] ?? null,
      })
      .eq('id', profile.id)

    if (error) {
      console.warn('[WalkerDashboard] failed to update service_type:', error.message)
      setProfileServiceTypes(previousServiceTypes)
      setServiceTypeSaveError(serviceTypeErrorLabel)
      setServiceTypeSaving(false)
      return
    }

    setServiceTypeSaving(false)
    setServiceTypeSavedAt(Date.now())
  }, [profile.id, profileServiceTypes, serviceTypeErrorLabel, serviceTypeSaving])

  const prevCompJobId = useRef<string | null>(null)
  useEffect(() => {
    const jobId = flow.completionSuccess?.jobId ?? null
    if (jobId !== prevCompJobId.current) {
      prevCompJobId.current = jobId
      setCompRating(0)
      setCompHover(0)
      setCompPressed(0)
      setCompReview('')
      setCompRatingDone(jobId ? flow.ratedJobIds.has(jobId) : false)
    }
  }, [flow.completionSuccess?.jobId, flow.ratedJobIds])

  const handleCompRatingSubmit = useCallback(() => {
    if (compRating < 1) return
    flow.submitCompletionRating(compRating, compReview.trim())
    setCompRatingDone(true)
  }, [compRating, compReview, flow.submitCompletionRating])

  const [serviceClockNow, setServiceClockNow] = useState(() => Date.now())

  const topRequest = flow.openJobs[0] ?? null
  const activeJob = flow.activeJobs[0] ?? null
  const onTheWayJob = flow.onTheWayJobs[0] ?? null
  const activeLabels = getServiceLabels(activeJob?.service_type)
  const walkerStartServiceLabel = isHebrew ? 'התחל שירות' : 'Start service'
  const walkerCompleteServiceLabel = isHebrew ? 'סיים שירות' : 'Complete service'
  const activeJobCanComplete =
    !!activeJob &&
    !!activeJob.service_started_at &&
    (activeJob.booking_timing !== 'scheduled' || activeJob.dispatch_state === 'dispatched')

  const requestPrice = topRequest
    ? topRequest.walker_earnings != null
      ? `₪${topRequest.walker_earnings.toFixed(0)}`
      : topRequest.price != null
        ? `₪${(topRequest.price * 0.8).toFixed(0)}`
        : '—'
    : '—'

  const requestDuration = durationFromMinutes(topRequest?.duration_minutes)
  const topOffer = flow.activeOffers.find((offer) => offer.request_id === topRequest?.id) ?? null

  useEffect(() => {
    const runningService = !!activeJob?.service_started_at && !activeJob?.service_completed_at
    if (!runningService) return

    const id = window.setInterval(() => {
      setServiceClockNow(Date.now())
    }, 1000)

    return () => window.clearInterval(id)
  }, [activeJob?.id, activeJob?.service_started_at, activeJob?.service_completed_at])

  const activeDurationSummary = useMemo(
    () =>
      getDurationSummary({
        plannedMinutes: activeJob?.duration_minutes ?? null,
        startedAt: activeJob?.service_started_at ?? null,
        completedAt: activeJob?.service_completed_at ?? null,
        now: serviceClockNow,
      }),
    [
      activeJob?.duration_minutes,
      activeJob?.service_started_at,
      activeJob?.service_completed_at,
      serviceClockNow,
    ],
  )

  const completionJobDetails = useMemo(
    () =>
      flow.completionSuccess
        ? flow.completedJobs.find((job) => job.id === flow.completionSuccess?.jobId) ?? null
        : null,
    [flow.completedJobs, flow.completionSuccess],
  )

  const completionDurationSummary = useMemo(
    () =>
      getDurationSummary({
        plannedMinutes: completionJobDetails?.duration_minutes ?? null,
        startedAt: completionJobDetails?.service_started_at ?? null,
        completedAt: completionJobDetails?.service_completed_at ?? null,
      }),
    [
      completionJobDetails?.duration_minutes,
      completionJobDetails?.service_started_at,
      completionJobDetails?.service_completed_at,
    ],
  )

  const completionMetaRows = useMemo(() => {
    const rows: Array<{ label: string; value: string }> = []
    if (completionDurationSummary.plannedLabel) {
      rows.push({ label: 'Planned', value: completionDurationSummary.plannedLabel })
    }
    if (completionDurationSummary.actualLabel) {
      rows.push({ label: 'Actual', value: completionDurationSummary.actualLabel })
    }
    return rows
  }, [completionDurationSummary.actualLabel, completionDurationSummary.plannedLabel])

  const allHistoryItems = useMemo<HistoryItem[]>(() => {
    const ratingByJobId = new Map<string, { rating: number; review: string | null }>()
    flow.ratingsReceived.forEach((r) => {
      ratingByJobId.set(r.job_id, { rating: r.rating, review: r.review })
    })

    return flow.completedJobs
      .map((j) => {
        const ratingInfo = ratingByJobId.get(j.id)
        return {
          id: j.id,
          dog_name: j.dog_name || 'Walk',
          client_name: getCustomerDisplayName(
            {
              client: j.client,
              clientName: j.client?.full_name || j.client?.email || null,
              dogName: j.dog_name,
            },
            isHebrew,
          ),
          client_id: j.client?.id ?? j.client_id ?? null,
          client_favorite_key: getPreferredCustomerKey({
            clientId: j.client?.id ?? j.client_id ?? null,
            clientName: getCustomerDisplayName(
              {
                client: j.client,
                clientName: j.client?.full_name || j.client?.email || null,
                dogName: j.dog_name,
              },
              isHebrew,
            ),
          }),
          address: formatShortAddress(j.location),
          rating: ratingInfo?.rating ?? null,
          review: ratingInfo?.review ?? null,
          price: j.walker_earnings ?? (j.price != null ? Math.round(j.price * 0.8) : null),
          duration_minutes: j.duration_minutes ?? null,
          tip_amount: j.tip_amount ?? null,
          status: j.status,
          created_at: j.created_at,
          completed_at: j.created_at,
          hidden_by_walker: hiddenHistoryIds.has(j.id),
        }
      })
  }, [flow.completedJobs, flow.ratingsReceived, hiddenHistoryIds, isHebrew])

  const visibleHistoryItems = useMemo(
    () => allHistoryItems.filter((item) => item.hidden_by_walker !== true).slice(0, 7),
    [allHistoryItems],
  )

  const clientNameById = useMemo(() => {
    const map = new Map<string, string>()
    flow.completedJobs.forEach((j) => {
      if (j.client?.id) {
        map.set(
          j.client.id,
          getCustomerDisplayName(
            {
              client: j.client,
              clientName: j.client.full_name || j.client.email || null,
              dogName: j.dog_name,
            },
            isHebrew,
          ),
        )
      }
    })
    return map
  }, [flow.completedJobs, isHebrew])

  const formattedRatings = useMemo(
    () =>
      flow.ratingsReceived.slice(0, 4).map((r) => ({
        id: r.id,
        rating: r.rating,
        review: r.review,
        authorName: clientNameById.get(r.from_user_id) || (isHebrew ? 'לקוח' : 'Customer'),
        date: formatRelativeDate(r.created_at),
      })),
    [flow.ratingsReceived, clientNameById, isHebrew],
  )

  const upcomingFutureItems = useMemo(
    () =>
      flow.futureJobs.map((job) => ({
        id: job.id,
        dogName: job.dog_name || t('booking.walkFallback'),
        clientName: getCustomerDisplayName(
          {
            client: job.client,
            clientName: job.client?.full_name || job.client?.email || null,
            dogName: job.dog_name,
          },
          isHebrew,
        ),
        address: formatShortAddress(job.address || job.location || ''),
        scheduledFor: job.scheduled_for,
        startsInMinutes: flow.startsInMinutes(job.scheduled_for),
        durationLabel: durationFromMinutes(job.duration_minutes),
        earningsLabel:
          job.walker_earnings != null
            ? `₪${job.walker_earnings.toFixed(0)}`
            : job.price != null
              ? `₪${Math.round(job.price * 0.8)}`
              : null,
      })),
    [flow.futureJobs, flow.startsInMinutes, t, isHebrew],
  )

  const incomingTitle = i18n.resolvedLanguage === 'he' ? 'הזמנה חדשה' : 'New order arrived'
  const idleHeroTitle = flow.isOnline ? (isHebrew ? 'מצב מחובר' : 'Connected') : (isHebrew ? 'לא מחובר' : 'Offline')
  const idleHeroSubtitle = flow.isOnline
    ? isHebrew
      ? 'מוכן להזמנות'
      : 'Ready for orders'
    : isHebrew
      ? 'התחבר כדי להתחיל לקבל הזמנות'
      : 'Go online to start receiving orders'
  const idleWaitingTitle = flow.isOnline
    ? isHebrew
      ? 'מחכה להזמנות…'
      : 'Waiting for new orders…'
    : isHebrew
      ? 'מוכן להתחברות'
      : 'Ready to go online'
  const idleWaitingBody = flow.isOnline
    ? isHebrew
      ? 'בקשות קרובות יופיעו כאן.'
      : 'Nearby requests will appear here.'
    : isHebrew
      ? 'הפעל את מצב המחובר כדי לקבל הזמנות חדשות בזמן אמת.'
      : 'Turn on your connected mode to receive new orders in real time.'
  const completedJobsCount = flow.completedJobs.filter((job) => job.status === 'completed').length
  const walletPayoutReady =
    !!flow.connectStatus?.connected &&
    !!flow.connectStatus?.stripe_connect_onboarding_complete &&
    !!flow.connectStatus?.payouts_enabled
  const walletNeedsSetup = !flow.connectLoading && !walletPayoutReady

  useEffect(() => {
    if (!walletNeedsSetup) {
      setPayoutCtaAnimationStopped(false)
      setPayoutCtaNudgeActive(false)
      return
    }

    if (payoutCtaAnimationStopped) {
      setPayoutCtaNudgeActive(false)
      return
    }

    const nudgeStart = window.setTimeout(() => {
      setPayoutCtaNudgeActive(true)
    }, 3600)
    const nudgeStop = window.setTimeout(() => {
      setPayoutCtaNudgeActive(false)
    }, 4550)

    return () => {
      window.clearTimeout(nudgeStart)
      window.clearTimeout(nudgeStop)
    }
  }, [payoutCtaAnimationStopped, walletNeedsSetup])

  useEffect(() => {
    if (!flow.takenNotice) return
    const id = window.setTimeout(() => flow.dismissTakenNotice(), 3000)
    return () => window.clearTimeout(id)
  }, [flow.takenNotice, flow.dismissTakenNotice])

  const [countdown, setCountdown] = useState(REQUEST_TIMEOUT_SECONDS)
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const trackedVisibleOfferKeyRef = useRef<string | null>(null)
  const visibleOfferStartedAtRef = useRef<number | null>(null)
  const timeoutFiredForOfferKeyRef = useRef<string | null>(null)

  const clearCountdown = useCallback(() => {
    if (countdownRef.current) {
      clearInterval(countdownRef.current)
      countdownRef.current = null
    }
  }, [])

  useEffect(() => {
    const isIncoming = flow.screenState === 'incoming_request' && topRequest
    if (!isIncoming) {
      clearCountdown()
      trackedVisibleOfferKeyRef.current = null
      visibleOfferStartedAtRef.current = null
      timeoutFiredForOfferKeyRef.current = null
      return
    }

    const visibleOfferKey = `${topRequest.id}:${topOffer?.id ?? 'none'}`

    const computeRemaining = () => {
      const startedAt = visibleOfferStartedAtRef.current ?? Date.now()
      return Math.max(0, REQUEST_TIMEOUT_SECONDS - Math.floor((Date.now() - startedAt) / 1000))
    }

    if (visibleOfferKey !== trackedVisibleOfferKeyRef.current) {
      clearCountdown()
      trackedVisibleOfferKeyRef.current = visibleOfferKey
      visibleOfferStartedAtRef.current = Date.now()
      timeoutFiredForOfferKeyRef.current = null
      setCountdown(REQUEST_TIMEOUT_SECONDS)

      countdownRef.current = setInterval(() => {
        const nextRemaining = computeRemaining()
        setCountdown(nextRemaining)
        if (nextRemaining <= 0 && timeoutFiredForOfferKeyRef.current !== visibleOfferKey) {
          timeoutFiredForOfferKeyRef.current = visibleOfferKey
          console.info('[WalkerDashboard] incoming offer timed out', {
            request_id: topRequest.id,
            attempt_id: topOffer?.id ?? null,
          })
          clearCountdown()
          void flow.handleDecline(topRequest.id, 'timeout')
        }
      }, 1000)
    } else {
      setCountdown(computeRemaining())
      if (computeRemaining() <= 0 && timeoutFiredForOfferKeyRef.current !== visibleOfferKey) {
        timeoutFiredForOfferKeyRef.current = visibleOfferKey
        console.info('[WalkerDashboard] incoming offer timed out', {
          request_id: topRequest.id,
          attempt_id: topOffer?.id ?? null,
        })
        clearCountdown()
        void flow.handleDecline(topRequest.id, 'timeout')
      }
    }

    return () => clearCountdown()
  }, [flow.screenState, topRequest?.id, topOffer?.id, flow.handleDecline, clearCountdown, topRequest])

  const isActiveOrCompleted = flow.screenState === 'on_the_way' || flow.screenState === 'active' || flow.screenState === 'completed'

  const hideHistoryItem = useCallback(
    async (id: string) => {
      setHiddenHistoryIds((current) => {
        const next = new Set(current)
        next.add(id)
        return next
      })
    },
    [],
  )

  const fetchPreferredCustomers = useCallback(async () => {
    const { data, error } = await supabase
      .from('favorite_customers')
      .select('client_id, created_at')
      .eq('walker_id', profile.id)
      .order('created_at', { ascending: false })

    if (error) {
      console.warn('[WalkerDashboard] favorite customers unavailable:', error.message)
      return
    }

    const rows = ((data as Array<{ client_id: string | null }> | null) ?? []).filter(
      (row): row is { client_id: string } => typeof row.client_id === 'string' && row.client_id.trim().length > 0,
    )
    const ids = rows.map((row) => row.client_id)
    setPreferredCustomerIds(new Set(ids))

    if (ids.length === 0) {
      setPreferredCustomerNames(new Map())
      return
    }

    const { data: profilesData, error: profilesError } = await supabase
      .from('profiles')
      .select('id, full_name, email')
      .in('id', ids)

    if (profilesError) {
      console.warn('[WalkerDashboard] favorite customer profiles unavailable:', profilesError.message)
      setPreferredCustomerNames((current) => {
        const next = new Map(current)
        ids.forEach((id) => {
          if (!next.has(id)) next.set(id, isHebrew ? 'לקוח' : 'Customer')
        })
        return next
      })
      return
    }

    const nextNames = new Map<string, string>()
    ;((profilesData as Array<{ id: string; full_name: string | null; email: string | null }> | null) ?? []).forEach(
      (profileRow) => {
        nextNames.set(
          profileRow.id,
          getCustomerDisplayName(
            {
              client: {
                full_name: profileRow.full_name,
                email: profileRow.email,
              },
            },
            isHebrew,
          ),
        )
      },
    )
    ids.forEach((id) => {
      if (!nextNames.has(id)) nextNames.set(id, isHebrew ? 'לקוח' : 'Customer')
    })
    setPreferredCustomerNames(nextNames)
  }, [isHebrew, profile.id])

  useEffect(() => {
    void fetchPreferredCustomers()
  }, [fetchPreferredCustomers])

  const toggleFavoriteClient = useCallback(async (clientKey: string, clientName: string) => {
    if (!clientKey) return
    const previousIds = new Set(preferredCustomerIds)
    const previousNames = new Map(preferredCustomerNames)
    const nextIsSaved = !preferredCustomerIds.has(clientKey)

    setPreferredCustomerIds((current) => {
      const next = new Set(current)
      if (nextIsSaved) {
        next.add(clientKey)
      } else {
        next.delete(clientKey)
      }
      return next
    })
    setPreferredCustomerNames((current) => {
      const next = new Map(current)
      if (nextIsSaved) {
        next.set(clientKey, clientName)
      } else {
        next.delete(clientKey)
      }
      return next
    })

    if (!isPersistableCustomerKey(clientKey)) {
      console.warn('[WalkerDashboard] favorite customer missing persistable client_id; keeping local fallback only', {
        clientKey,
      })
      return
    }

    if (nextIsSaved) {
      const { error } = await supabase.from('favorite_customers').insert({
        walker_id: profile.id,
        client_id: clientKey,
      })

      if (error && error.code !== '23505') {
        console.warn('[WalkerDashboard] failed to save favorite customer:', error.message)
        setPreferredCustomerIds(previousIds)
        setPreferredCustomerNames(previousNames)
        return
      }
    } else {
      const { error } = await supabase
        .from('favorite_customers')
        .delete()
        .eq('walker_id', profile.id)
        .eq('client_id', clientKey)

      if (error) {
        console.warn('[WalkerDashboard] failed to remove favorite customer:', error.message)
        setPreferredCustomerIds(previousIds)
        setPreferredCustomerNames(previousNames)
        return
      }
    }

    void fetchPreferredCustomers()
  }, [fetchPreferredCustomers, preferredCustomerIds, preferredCustomerNames, profile.id])

  const completionClientId = completionJobDetails?.client?.id ?? flow.completionSuccess?.clientId ?? null
  const completionClientName =
    getCustomerDisplayName(
      {
        client: completionJobDetails?.client ?? null,
        clientName: completionJobDetails?.client?.full_name || completionJobDetails?.client?.email || null,
        customerName: flow.completionSuccess?.clientName || null,
        dogName: completionJobDetails?.dog_name || null,
        petName: flow.completionSuccess?.dogName || null,
      },
      isHebrew,
    )
  const completionClientKey = getPreferredCustomerKey({
    clientId: completionClientId,
    clientName: completionClientName,
  })
  const completionClientSaved = completionClientKey ? preferredCustomerIds.has(completionClientKey) : false
  const preferredCustomers = useMemo(() => {
    return Array.from(preferredCustomerIds).map((key) => ({
      key,
      name:
        preferredCustomerNames.get(key) ||
        (key === completionClientKey ? completionClientName : isHebrew ? 'לקוח' : 'Customer'),
    }))
  }, [completionClientKey, completionClientName, isHebrew, preferredCustomerIds, preferredCustomerNames])

  const handleOnlineToggle = useCallback(async () => {
    if (!flow.isOnline) {
      const ok = await flow.toggleOnline()
      if (!ok) {
        setShowStripeGate(true)
      }
      return
    }
    setShowStripeGate(false)
    await flow.toggleOnline()
  }, [flow])

  const handleStripeSetup = useCallback(async (rememberAutoOnline = false) => {
    if (isCheckingPayout) return
    setIsCheckingPayout(true)
    if (rememberAutoOnline) {
      try {
        window.localStorage.setItem(providerAutoOnlineStorageKey(profile.id), '1')
      } catch {
        // noop
      }
    }
    try {
      if (flow.connectStatus?.connected) {
        await flow.handleContinueOnboarding()
        return
      }
      await flow.handleConnectAccount()
    } finally {
      setIsCheckingPayout(false)
    }
  }, [flow, isCheckingPayout, profile.id])

  useEffect(() => {
    if (!showOnboardingWowToken) return
    if (handledWowTokenRef.current === showOnboardingWowToken) return
    handledWowTokenRef.current = showOnboardingWowToken
    setShowOnboardingWow(true)
    setShowStripeGate(false)
  }, [showOnboardingWowToken])

  useEffect(() => {
    if (!flow.stripeReadyForOnline) return
    setShowStripeGate(false)
  }, [flow.stripeReadyForOnline])

  useEffect(() => {
    const refreshConnect = () => {
      void flow.fetchConnectStatus()
    }

    window.addEventListener('focus', refreshConnect)
    document.addEventListener('visibilitychange', refreshConnect)
    window.addEventListener('pageshow', refreshConnect)

    return () => {
      window.removeEventListener('focus', refreshConnect)
      document.removeEventListener('visibilitychange', refreshConnect)
      window.removeEventListener('pageshow', refreshConnect)
    }
  }, [flow.fetchConnectStatus])

  useEffect(() => {
    if (!stripeReturnToken) return
    setShowStripeGate(false)
    setShowOnboardingWow(false)
    void flow.fetchConnectStatus()
  }, [flow.fetchConnectStatus, stripeReturnToken])

  useEffect(() => {
    let pendingAutoOnline = false
    try {
      pendingAutoOnline = window.localStorage.getItem(providerAutoOnlineStorageKey(profile.id)) === '1'
    } catch {
      pendingAutoOnline = false
    }

    if (!pendingAutoOnline || !flow.stripeReadyForOnline || flow.isOnline || autoOnlineInFlightRef.current) {
      return
    }

    autoOnlineInFlightRef.current = true
    void (async () => {
      const ok = await flow.toggleOnline()
      autoOnlineInFlightRef.current = false
      if (!ok) return
      try {
        window.localStorage.removeItem(providerAutoOnlineStorageKey(profile.id))
      } catch {
        // noop
      }
      setShowOnboardingWow(false)
      setShowStripeGate(false)
    })()
  }, [flow.isOnline, flow.stripeReadyForOnline, flow.toggleOnline, profile.id])

  const handleOnboardingWowPrimary = useCallback(async () => {
    if (isCheckingPayout) return
    if (flow.stripeReadyForOnline) {
      const ok = await flow.toggleOnline()
      if (ok) {
        setShowOnboardingWow(false)
      }
      return
    }
    await handleStripeSetup(true)
  }, [flow.stripeReadyForOnline, flow.toggleOnline, handleStripeSetup, isCheckingPayout])

  return (
    <>
      <style>{`
        .walker-dashboard-screen {
          scrollbar-width: none;
          -ms-overflow-style: none;
        }
        .walker-dashboard-screen::-webkit-scrollbar {
          display: none;
          width: 0;
          height: 0;
        }
        .walker-menu-scroll::-webkit-scrollbar {
          display: none;
          width: 0;
          height: 0;
        }
        @keyframes walkerPayoutPulse {
          0%, 100% {
            transform: scale(1);
            box-shadow: 0 8px 18px rgba(217, 119, 6, 0.10);
          }
          50% {
            transform: scale(1.02);
            box-shadow: 0 10px 22px rgba(217, 119, 6, 0.18);
          }
        }
        @keyframes walkerPayoutNudge {
          0%, 100% {
            transform: scale(1);
          }
          50% {
            transform: scale(1.03);
          }
        }
        @keyframes walkerDrawerInLtr {
          from {
            transform: translateX(-18px);
            opacity: 0;
          }
          to {
            transform: translateX(0);
            opacity: 1;
          }
        }
        @keyframes walkerDrawerInRtl {
          from {
            transform: translateX(18px);
            opacity: 0;
          }
          to {
            transform: translateX(0);
            opacity: 1;
          }
        }
      `}</style>
      <div className="walker-dashboard-screen" style={screenStyle}>
        <div style={headerStyle}>
          <div style={headerIdentityRowStyle}>
            <ProfileAvatar
              url={photo.avatarUrl}
              name={walkerName}
              size={48}
              borderRadius={18}
              onClick={() => fileInputRef.current?.click()}
            />
            <div style={headerIdentityStyle}>
              <h2 style={greetingStyle}>{greetingLabel}</h2>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) photo.uploadAvatar(file)
                  e.target.value = ''
                }}
              />
              {photo.uploading ? <div style={uploadStatusStyle}>Uploading photo...</div> : null}
              {photo.error ? <div style={uploadErrorStyle}>{photo.error}</div> : null}
            </div>
          </div>

          <div style={headerTopRowStyle}>
            <button
              type="button"
              onClick={() => {
                setMenuPage('main')
                setBurgerOpen((v) => !v)
              }}
              style={headerMenuBtnStyle}
              aria-label={t('menu.menu')}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0F172A" strokeWidth="2.2" strokeLinecap="round">
                <line x1="4" y1="7" x2="20" y2="7" />
                <line x1="4" y1="12" x2="20" y2="12" />
                <line x1="4" y1="17" x2="20" y2="17" />
              </svg>
            </button>

            {isActiveOrCompleted ? (
              <div style={activeSessionChipStyle}>
                {flow.screenState === 'active' ? activeLabels.activeTitle : t('tracking.onTheWay')}
              </div>
            ) : (
              <div />
            )}

            <div style={bellWrapStyle}>
              <NotificationsBell />
            </div>
          </div>
        </div>

        {showStripeGate && (
          <>
            <div style={stripeGateOverlayStyle} onClick={() => setShowStripeGate(false)} />
            <div style={stripeGateCardStyle}>
              <div style={stripeGateEyebrowStyle}>Payout setup</div>
              <div style={stripeGateTitleStyle}>You&apos;re almost ready to go online</div>
              <div style={stripeGateBodyStyle}>
                Complete your payout setup to start receiving requests.
              </div>
              <div style={stripeGateActionsStyle}>
                <button
                  type="button"
                  disabled={isCheckingPayout}
                  onClick={() => void handleStripeSetup(false)}
                  style={{
                    ...stripeGatePrimaryStyle,
                    ...(isCheckingPayout ? stripeGatePrimaryDisabledStyle : null),
                  }}
                >
                  {isCheckingPayout ? 'Checking...' : 'Complete setup'}
                </button>
                <button type="button" onClick={() => setShowStripeGate(false)} style={stripeGateSecondaryStyle}>
                  Maybe later
                </button>
              </div>
            </div>
          </>
        )}

        {showOnboardingWow && (
          <>
            <div style={stripeGateOverlayStyle} onClick={() => setShowOnboardingWow(false)} />
            <div style={stripeGateCardStyle}>
              <div style={stripeGateEyebrowStyle}>First step</div>
              <div style={stripeGateTitleStyle}>
                {flow.connectLoading
                  ? 'Checking payout setup'
                  : flow.stripeReadyForOnline
                    ? 'Ready to receive your first request?'
                    : 'Complete payout setup to go online'}
              </div>
              <div style={stripeGateBodyStyle}>
                {flow.connectLoading
                  ? 'We are checking your payout status so we can get you online smoothly.'
                  : flow.stripeReadyForOnline
                    ? 'Turn on availability whenever you’re ready to start receiving bookings.'
                    : 'Set up payouts once so you can receive requests and get paid.'}
              </div>
              <div style={stripeGateActionsStyle}>
                <button
                  type="button"
                  disabled={isCheckingPayout}
                  onClick={() => void handleOnboardingWowPrimary()}
                  style={{
                    ...stripeGatePrimaryStyle,
                    ...(isCheckingPayout ? stripeGatePrimaryDisabledStyle : null),
                  }}
                >
                  {flow.connectLoading
                    ? 'Checking...'
                    : flow.stripeReadyForOnline
                      ? 'Go online'
                      : isCheckingPayout
                        ? 'Checking...'
                        : 'Complete setup'}
                </button>
                {!flow.connectLoading && !flow.stripeReadyForOnline ? (
                  <button type="button" onClick={() => setShowOnboardingWow(false)} style={stripeGateSecondaryStyle}>
                    Maybe later
                  </button>
                ) : (
                  <button type="button" onClick={() => setShowOnboardingWow(false)} style={stripeGateSecondaryStyle}>
                    Maybe later
                  </button>
                )}
              </div>
            </div>
          </>
        )}

        {burgerOpen && (
          <>
            <div style={menuOverlayStyle} onClick={closeAll} />
            <div
              style={{
                ...menuPanelStyle,
                ...(isRtl ? menuPanelRtlStyle : menuPanelLtrStyle),
              }}
            >
              <div style={menuHeaderRowStyle}>
                <div style={menuHeaderLeftStyle}>
                  <button
                    type="button"
                    onClick={() => {
                      if (menuPage !== 'main') {
                        setMenuPage('main')
                      } else {
                        closeAll()
                      }
                    }}
                    style={menuBackButtonStyle}
                    aria-label={menuPage !== 'main' ? t('common.back') : t('common.close')}
                  >
                    {menuPage !== 'main' ? '‹' : '✕'}
                  </button>
                  <span style={menuTitleStyle}>
                    {menuPage === 'settings'
                      ? t('menu.settings')
                      : menuPage === 'history'
                        ? t('menu.tripHistory')
                        : menuPage === 'futureOrders'
                          ? t('menu.futureOrders')
                          : t('menu.menu')}
                  </span>
                </div>
              </div>

              <div className="walker-menu-scroll" style={menuScrollAreaStyle}>
                {menuPage === 'history' ? (
                  <BurgerSection title={t('menu.tripHistory')} subtitle={t('menu.allHistorySubtitle')}>
                      <GroupedHistory
                        items={allHistoryItems}
                        role="walker"
                        compact
                        onHide={hideHistoryItem}
                        favoriteClientIds={preferredCustomerIds}
                        onToggleFavoriteClient={toggleFavoriteClient}
                        emptyTitle={t('menu.noWalkHistory')}
                        emptySubtitle={t('menu.noWalkHistorySubtitle')}
                      />
                  </BurgerSection>
                ) : menuPage === 'settings' ? (
                  <>
                    <BurgerSection title={walkerName} subtitle={profile.email || t('common.provider')}>
                      <div style={settingsProfileRowStyle}>
                        <div style={{ position: 'relative' }}>
                          <ProfileAvatar
                            url={photo.avatarUrl}
                            name={walkerName}
                            size={52}
                            borderRadius={18}
                            onClick={() => fileInputRef.current?.click()}
                          />
                          <input
                            ref={fileInputRef}
                            type="file"
                            accept="image/*"
                            style={{ display: 'none' }}
                            onChange={(e) => {
                              const file = e.target.files?.[0]
                              if (file) photo.uploadAvatar(file)
                              e.target.value = ''
                            }}
                          />
                        </div>
                        <div style={settingsProfileMetaStyle}>
                          <div style={settingsProfileTitleStyle}>{walkerName}</div>
                          {flow.avgRating !== null && (
                            <div style={profileRatingStyle}>
                              <span style={{ color: '#F59E0B' }}>★</span> {flow.avgRating} · {flow.ratingsReceived.length} reviews
                            </div>
                          )}
                          <button
                            type="button"
                            onClick={() => fileInputRef.current?.click()}
                            style={settingsPhotoButtonStyle}
                          >
                            Change photo
                          </button>
                          {photo.uploading && <div style={uploadStatusStyle}>Uploading photo...</div>}
                          {photo.error && <div style={uploadErrorStyle}>{photo.error}</div>}
                        </div>
                      </div>
                    </BurgerSection>

                    <BurgerSection title={t('common.language')} subtitle={t('menu.settings')}>
                      <div style={languageSelectorRowStyle}>
                        <button
                          type="button"
                          onClick={() => {
                            void i18n.changeLanguage('en')
                          }}
                          style={{
                            ...languageButtonStyle,
                            ...(i18n.resolvedLanguage === 'en' ? languageButtonActiveStyle : null),
                          }}
                        >
                          EN
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            void i18n.changeLanguage('he')
                          }}
                          style={{
                            ...languageButtonStyle,
                            ...(i18n.resolvedLanguage === 'he' ? languageButtonActiveStyle : null),
                          }}
                        >
                          עברית
                        </button>
                      </div>
                    </BurgerSection>

                    <BurgerSection title={serviceTypeSectionTitle} subtitle={serviceTypeSectionSubtitle}>
                      <div style={serviceTypeSelectorRowStyle}>
                        {profileServiceOptions.map((option) => {
                          const selected = profileServiceTypes.includes(option.value)
                          return (
                            <button
                              key={option.value}
                              type="button"
                              onClick={() => {
                                void handleProfileServiceTypeToggle(option.value)
                              }}
                              disabled={serviceTypeSaving}
                              style={{
                                ...serviceTypeButtonStyle,
                                ...(selected ? serviceTypeButtonActiveStyle : null),
                                opacity: serviceTypeSaving && !selected ? 0.72 : 1,
                              }}
                            >
                              <span style={serviceTypeButtonIconStyle}>{option.icon}</span>
                              <span style={serviceTypeButtonLabelStyle}>{option.label}</span>
                              <span style={serviceTypeButtonDescriptionStyle}>{option.description}</span>
                              {serviceTypeSaving && selected ? <span style={serviceTypeButtonMetaStyle}>{serviceTypeSavingLabel}</span> : null}
                            </button>
                          )
                        })}
                      </div>
                      {serviceTypeSaveError ? (
                        <div style={serviceTypeStatusErrorStyle}>{serviceTypeSaveError}</div>
                      ) : !serviceTypeSaving && serviceTypeSavedAt > 0 ? (
                        <div style={serviceTypeStatusSuccessStyle}>{serviceTypeSavedLabel}</div>
                      ) : null}
                    </BurgerSection>

                    <BurgerSection
                      title={preferredCustomersLabel}
                      subtitle={preferredCustomersSubtitle}
                    >
                      {preferredCustomers.length === 0 ? (
                        <div style={emptyMenuCardStyle}>{noPreferredCustomersLabel}</div>
                      ) : (
                        <div style={preferredCustomerListStyle}>
                          {preferredCustomers.map((customer) => (
                            <div key={customer.key} style={preferredCustomerRowStyle}>
                              <div style={preferredCustomerHeartStyle}>♥</div>
                              <div style={preferredCustomerNameStyle}>{customer.name}</div>
                            </div>
                          ))}
                        </div>
                      )}
                    </BurgerSection>

                    <div style={menuFooterActionWrapStyle}>
                      <MenuNavRow
                        icon="↪"
                        label={t('menu.signOut')}
                        destructive
                        onClick={() => {
                          closeAll()
                          void onSignOut()
                        }}
                      />
                    </div>
                  </>
                ) : menuPage === 'futureOrders' ? (
                  <BurgerSection
                    title={t('menu.futureOrders')}
                    subtitle={t('menu.futureOrdersSubtitle')}
                  >
                    {upcomingFutureItems.length === 0 ? (
                      <div style={emptyMenuCardStyle}>{t('menu.noFutureOrders')}</div>
                    ) : (
                      <div style={futureOrderListStyle}>
                        {upcomingFutureItems.map((item) => (
                          <div key={item.id} style={futureOrderCardStyle}>
                            <div style={futureOrderTopStyle}>
                              <div>
                                <div style={futureOrderTitleStyle}>{item.dogName}</div>
                                <div style={futureOrderSubtitleStyle}>{item.clientName}</div>
                              </div>
                              {item.earningsLabel && (
                                <div style={futureOrderPriceStyle}>{item.earningsLabel}</div>
                              )}
                            </div>
                            {item.address && <div style={futureOrderAddressStyle}>{item.address}</div>}
                            <div style={futureOrderMetaStyle}>
                              {item.scheduledFor && (
                                <span>{t('menu.scheduledFor', { time: new Date(item.scheduledFor).toLocaleString() })}</span>
                              )}
                              {typeof item.startsInMinutes === 'number' && (
                                <span>{t('menu.startsInMinutes', { count: item.startsInMinutes })}</span>
                              )}
                              {item.durationLabel !== '—' && <span>{item.durationLabel}</span>}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </BurgerSection>
                ) : (
                  <>
                    <div style={menuProfileButtonStyle}>
                      <ProfileAvatar url={photo.avatarUrl} name={walkerName} size={52} borderRadius={18} />
                      <div style={menuProfileTextStyle}>
                        <div style={profileNameStyle}>{walkerName}</div>
                        {profile.email && <div style={profileEmailStyle}>{profile.email}</div>}
                        {flow.avgRating !== null && (
                          <div style={profileRatingStyle}>
                            <span style={{ color: '#F59E0B' }}>★</span> {flow.avgRating} · {flow.ratingsReceived.length} reviews
                          </div>
                        )}
                      </div>
                    </div>

                    <div style={menuRowListStyle}>
                      <MenuNavRow icon="⚙️" label={t('menu.settings')} onClick={() => setMenuPage('settings')} />
                      <MenuNavRow icon="🕘" label={t('menu.tripHistory')} onClick={() => setMenuPage('history')} />
                      <MenuNavRow icon="📅" label={t('menu.futureOrders')} onClick={() => setMenuPage('futureOrders')} />
                      <MenuNavRow icon="♥" label={preferredCustomersLabel} onClick={() => setMenuPage('settings')} />
                    </div>

                    <BurgerSection title={t('menu.latestTrips')} subtitle={t('menu.walkHistorySubtitle')}>
                      <GroupedHistory
                        items={visibleHistoryItems}
                        role="walker"
                        compact
                        onHide={hideHistoryItem}
                        favoriteClientIds={preferredCustomerIds}
                        onToggleFavoriteClient={toggleFavoriteClient}
                        emptyTitle={t('menu.noWalkHistory')}
                        emptySubtitle={t('menu.noWalkHistorySubtitle')}
                      />
                    </BurgerSection>
                  </>
                )}
              </div>
            </div>
          </>
        )}

        <div style={contentStyle}>
          {flow.error && (
            <div style={toastErrorStyle}>
              <span>{friendlyError(flow.error)}</span>
              <button onClick={flow.clearError} style={toastDismissStyle}>×</button>
            </div>
          )}

          {flow.successMessage && flow.screenState !== 'completed' && (
            <div style={toastSuccessStyle}>
              <span>{flow.successMessage}</span>
              <button onClick={flow.clearSuccess} style={toastDismissStyle}>×</button>
            </div>
          )}

          {flow.screenState === 'offline' && (
            <div className="sheet-state-enter">
              <div style={idleHeroStyle}>
                <div style={idleHeroGlowStyle} />
                <div style={idleHeroBadgeStyle}>{idleHeroTitle}</div>
                <button
                  type="button"
                  onClick={() => void handleOnlineToggle()}
                  style={{
                    ...idleHeroToggleStyle,
                    background: flow.isOnline ? 'linear-gradient(180deg, #16A34A 0%, #15803D 100%)' : '#CBD5E1',
                  }}
                >
                  <div
                    style={{
                    ...idleHeroToggleKnobStyle,
                      transform: flow.isOnline ? 'translateX(28px)' : 'translateX(0)',
                    }}
                  />
                </button>
                <div style={idleHeroTitleStyle}>{idleHeroSubtitle}</div>
                <div style={idleHeroBodyStyle}>{idleWaitingBody}</div>
              </div>

              <div style={idleCardGridStyle}>
                <div style={idleRadarCardStyle}>
                  <RadarVisual />
                  <div style={idleInfoCardTextWrapStyle}>
                    <div style={idleInfoCardTitleStyle}>{idleWaitingTitle}</div>
                    <div style={idleInfoCardBodyStyle}>
                      {flow.connectLoading
                        ? 'Checking payout setup...'
                        : isHebrew
                          ? 'הפעל את מצב המחובר כדי להתחיל לקבל בקשות קרובות.'
                          : 'Turn on connected mode to start receiving nearby requests.'}
                    </div>
                  </div>
                </div>

                <div style={idleStatsCardStyle}>
                  <div style={idleInfoCardTitleStyle}>{isHebrew ? 'נתונים מהירים' : 'Quick stats'}</div>
                  <div style={idleStatsGridStyle}>
                    <div style={idleStatItemStyle}>
                      <span style={idleStatLabelStyle}>{isHebrew ? 'דירוג' : 'Rating'}</span>
                      <span style={idleStatValueStyle}>{flow.avgRating != null ? flow.avgRating.toFixed(1) : '—'}</span>
                    </div>
                    <div style={idleStatItemStyle}>
                      <span style={idleStatLabelStyle}>{isHebrew ? 'הושלמו' : 'Completed'}</span>
                      <span style={idleStatValueStyle}>{completedJobsCount}</span>
                    </div>
                  </div>
                </div>

                <div style={walletCardStyle}>
                  <div style={idleInfoCardTitleStyle}>{isHebrew ? 'ארנק' : 'Wallet'}</div>
                  <div style={walletGridStyle}>
                    <div style={walletMetricStyle}>
                      <span style={walletMetricLabelStyle}>{isHebrew ? 'זמין' : 'Available'}</span>
                      <span style={walletMetricValueStyle}>₪{flow.wallet.availableBalance.toFixed(0)}</span>
                    </div>
                    <div style={walletMetricStyle}>
                      <span style={walletMetricLabelStyle}>{isHebrew ? 'ממתין' : 'Pending'}</span>
                      <span style={walletMetricValueStyle}>₪{flow.wallet.pendingEarnings.toFixed(0)}</span>
                    </div>
                  </div>
                  <div style={walletStatusWrapStyle}>
                    {flow.connectLoading ? (
                      <span style={walletStatusNeutralStyle}>
                        {isHebrew ? 'בודק הגדרת תשלומים...' : 'Checking payout setup...'}
                      </span>
                    ) : walletPayoutReady ? (
                      <span style={walletStatusReadyStyle}>
                        {isHebrew ? 'מוכן לקבל תשלומים' : 'Ready to receive payouts'}
                      </span>
                    ) : (
                      <>
                        <span style={walletStatusWarningStyle}>
                          {isHebrew
                            ? 'השלם הגדרת תשלומים כדי לקבל כספים'
                            : 'Complete payout setup to receive earnings'}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setPayoutCtaAnimationStopped(true)
                            void handleStripeSetup(false)
                          }}
                          disabled={isCheckingPayout}
                          style={{
                            ...walletSetupButtonStyle,
                            ...(!payoutCtaAnimationStopped && !payoutCtaNudgeActive ? walletSetupButtonPulseStyle : null),
                            ...(!payoutCtaAnimationStopped && payoutCtaNudgeActive ? walletSetupButtonPulseAndNudgeStyle : null),
                            ...(isCheckingPayout ? walletSetupButtonDisabledStyle : null),
                          }}
                        >
                          {isCheckingPayout
                            ? isHebrew
                              ? 'בודק...'
                              : 'Checking...'
                            : isHebrew
                              ? 'הגדר תשלומים'
                              : 'Set up payouts'}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {flow.screenState === 'waiting' && (
            <div className="sheet-state-enter">
              <div style={{ ...idleHeroStyle, ...idleHeroOnlineStyle }}>
                <div style={idleHeroGlowStyle} />
                <div style={{ ...idleHeroBadgeStyle, background: 'rgba(22, 163, 74, 0.12)', color: '#15803D' }}>
                  {idleHeroTitle}
                </div>
                <button
                  type="button"
                  onClick={() => void handleOnlineToggle()}
                  style={{
                    ...idleHeroToggleStyle,
                    background: 'linear-gradient(180deg, #16A34A 0%, #15803D 100%)',
                  }}
                >
                  <div
                    style={{
                      ...idleHeroToggleKnobStyle,
                      transform: 'translateX(28px)',
                    }}
                  />
                </button>
                <div style={idleHeroTitleStyle}>{idleHeroSubtitle}</div>
                <div style={idleHeroBodyStyle}>{idleWaitingBody}</div>
              </div>

              <div style={idleCardGridStyle}>
                <div style={idleRadarCardStyle}>
                  <RadarVisual />
                  <div style={idleInfoCardTextWrapStyle}>
                    <div style={idleInfoCardTitleStyle}>{idleWaitingTitle}</div>
                    <div style={idleInfoCardBodyStyle}>{idleWaitingBody}</div>
                  </div>
                </div>

                <div style={idleStatsCardStyle}>
                  <div style={idleInfoCardTitleStyle}>{isHebrew ? 'נתונים מהירים' : 'Quick stats'}</div>
                  <div style={idleStatsGridStyle}>
                    <div style={idleStatItemStyle}>
                      <span style={idleStatLabelStyle}>{isHebrew ? 'דירוג' : 'Rating'}</span>
                      <span style={idleStatValueStyle}>{flow.avgRating != null ? flow.avgRating.toFixed(1) : '—'}</span>
                    </div>
                    <div style={idleStatItemStyle}>
                      <span style={idleStatLabelStyle}>{isHebrew ? 'הושלמו' : 'Completed'}</span>
                      <span style={idleStatValueStyle}>{completedJobsCount}</span>
                    </div>
                  </div>
                </div>

                <div style={walletCardStyle}>
                  <div style={idleInfoCardTitleStyle}>{isHebrew ? 'ארנק' : 'Wallet'}</div>
                  <div style={walletGridStyle}>
                    <div style={walletMetricStyle}>
                      <span style={walletMetricLabelStyle}>{isHebrew ? 'זמין' : 'Available'}</span>
                      <span style={walletMetricValueStyle}>₪{flow.wallet.availableBalance.toFixed(0)}</span>
                    </div>
                    <div style={walletMetricStyle}>
                      <span style={walletMetricLabelStyle}>{isHebrew ? 'ממתין' : 'Pending'}</span>
                      <span style={walletMetricValueStyle}>₪{flow.wallet.pendingEarnings.toFixed(0)}</span>
                    </div>
                  </div>
                  <div style={walletStatusWrapStyle}>
                    {flow.connectLoading ? (
                      <span style={walletStatusNeutralStyle}>
                        {isHebrew ? 'בודק הגדרת תשלומים...' : 'Checking payout setup...'}
                      </span>
                    ) : walletPayoutReady ? (
                      <span style={walletStatusReadyStyle}>
                        {isHebrew ? 'מוכן לקבל תשלומים' : 'Ready to receive payouts'}
                      </span>
                    ) : (
                      <>
                        <span style={walletStatusWarningStyle}>
                          {isHebrew
                            ? 'השלם הגדרת תשלומים כדי לקבל כספים'
                            : 'Complete payout setup to receive earnings'}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setPayoutCtaAnimationStopped(true)
                            void handleStripeSetup(false)
                          }}
                          disabled={isCheckingPayout}
                          style={{
                            ...walletSetupButtonStyle,
                            ...(!payoutCtaAnimationStopped && !payoutCtaNudgeActive ? walletSetupButtonPulseStyle : null),
                            ...(!payoutCtaAnimationStopped && payoutCtaNudgeActive ? walletSetupButtonPulseAndNudgeStyle : null),
                            ...(isCheckingPayout ? walletSetupButtonDisabledStyle : null),
                          }}
                        >
                          {isCheckingPayout
                            ? isHebrew
                              ? 'בודק...'
                              : 'Checking...'
                            : isHebrew
                              ? 'הגדר תשלומים'
                              : 'Set up payouts'}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {flow.screenState === 'on_the_way' && onTheWayJob && (
            <div className="sheet-state-enter" style={activeCardStyle}>
              <div style={activeHeaderRowStyle}>
                <div style={onTheWayBadgeStyle}>
                  <div style={onTheWayBadgeDotStyle} />
                  {flow.screenPhase === 'arrived_pending_confirmation'
                    ? 'Waiting for client confirmation'
                    : flow.screenPhase === 'arrival_confirmed'
                      ? 'Arrival confirmed'
                      : 'Head to the client'}
                </div>
              </div>

              <h3 style={activeDogNameStyle}>{onTheWayJob.dog_name || 'Dog'}</h3>
              <p style={activeClientStyle}>
                {isHebrew ? 'עבור ' : 'for '}
                {getCustomerDisplayName(
                  {
                    client: onTheWayJob.client ?? null,
                    clientName: onTheWayJob.client?.full_name || onTheWayJob.client?.email || null,
                    dogName: onTheWayJob.dog_name || null,
                  },
                  isHebrew,
                )}
              </p>

              {onTheWayJob.location && (
                <div style={activeLocationStyle}>
                  <span style={ellipsisStyle}>{formatShortAddress(onTheWayJob.address || onTheWayJob.location)}</span>
                </div>
              )}

              {flow.screenPhase === 'arrived_pending_confirmation' && (
                <div style={waitingStateStyle}>
                  <div style={waitingStateTitleStyle}>Waiting for client to confirm arrival</div>
                  <div style={waitingStateBodyStyle}>
                    The service can start as soon as the client confirms you are with them.
                  </div>
                </div>
              )}

              <button
                onClick={async () => {
                  await hapticSuccess()
                  if (flow.screenPhase === 'on_the_way') {
                    void flow.markArrived(onTheWayJob.id)
                    return
                  }
                  void flow.startService(onTheWayJob.id)
                }}
                disabled={flow.screenPhase === 'arrived_pending_confirmation'}
                style={completeBtnStyle}
              >
                {flow.screenPhase === 'on_the_way'
                  ? 'Arrived'
                  : flow.screenPhase === 'arrival_confirmed'
                    ? walkerStartServiceLabel
                    : 'Waiting for client'}
              </button>
            </div>
          )}

          {flow.screenState === 'active' && activeJob && (
            <div className="sheet-state-enter" style={activeCardStyle}>
              <div style={activeHeaderRowStyle}>
                <div style={activeBadgeStyle}>
                  <div style={activeBadgeDotStyle} />
                  {activeLabels.activeTitle}
                </div>
              </div>

              <h3 style={activeDogNameStyle}>{activeJob.dog_name || 'Dog'}</h3>
              <p style={activeClientStyle}>
                {isHebrew ? 'עבור ' : 'for '}
                {getCustomerDisplayName(
                  {
                    client: activeJob.client ?? null,
                    clientName: activeJob.client?.full_name || activeJob.client?.email || null,
                    dogName: activeJob.dog_name || null,
                  },
                  isHebrew,
                )}
              </p>

              {activeJob.location && (
                <div style={activeLocationStyle}>
                  <span style={ellipsisStyle}>{formatShortAddress(activeJob.address || activeJob.location)}</span>
                </div>
              )}

              {flow.completionPaymentError?.jobId === activeJob.id && (
                <div style={completionPaymentErrorStyle}>
                  {flow.completionPaymentError.message}
                </div>
              )}

              {(activeDurationSummary.elapsedLabel ||
                activeDurationSummary.plannedLabel ||
                activeDurationSummary.actualLabel) && (
                <div style={serviceTimerPanelStyle}>
                  {activeDurationSummary.elapsedLabel && (
                    <div style={serviceTimerPrimaryRowStyle}>
                      <span style={serviceTimerLabelStyle}>Elapsed</span>
                      <span style={serviceTimerValueStyle}>{activeDurationSummary.elapsedLabel}</span>
                    </div>
                  )}
                  {(activeDurationSummary.plannedLabel || activeDurationSummary.actualLabel) && (
                    <div style={serviceTimerMetaRowStyle}>
                      {activeDurationSummary.plannedLabel && (
                        <span style={serviceTimerMetaStyle}>Planned: {activeDurationSummary.plannedLabel}</span>
                      )}
                      {activeDurationSummary.actualLabel && (
                        <span style={serviceTimerMetaStyle}>Actual: {activeDurationSummary.actualLabel}</span>
                      )}
                    </div>
                  )}
                </div>
              )}

              <button
                onClick={async () => {
                  await hapticSuccess()
                  void flow.handleComplete(activeJob.id)
                }}
                disabled={
                  flow.completingJobId === activeJob.id ||
                  flow.pendingClientConfirmation === activeJob.id ||
                  !activeJobCanComplete
                }
                style={{
                  ...completeBtnStyle,
                  ...(flow.pendingClientConfirmation === activeJob.id ? pendingConfirmationBtnStyle : null),
                  opacity:
                    flow.completingJobId === activeJob.id ||
                    flow.pendingClientConfirmation === activeJob.id ||
                    !activeJobCanComplete
                      ? 0.7
                      : 1,
                  cursor:
                    flow.completingJobId === activeJob.id ||
                    flow.pendingClientConfirmation === activeJob.id ||
                    !activeJobCanComplete
                      ? 'not-allowed'
                      : 'pointer',
                }}
              >
                {flow.completingJobId === activeJob.id
                  ? 'Completing...'
                  : flow.pendingClientConfirmation === activeJob.id
                    ? t('completion.walkerWaiting')
                    : activeJobCanComplete
                      ? walkerCompleteServiceLabel
                      : 'Available at dispatch time'}
              </button>
            </div>
          )}

          {flow.screenState === 'completed' && flow.completionSuccess && (
            <div className="sheet-state-enter" style={completionCardStyle}>
              <div style={checkStyle}>✓</div>
              <h3 style={completionTitleStyle}>{getServiceLabels(null).completedTitle}</h3>
              <p style={completionSubStyle}>
                {isHebrew ? `השירות של ${completionClientName}` : `${completionClientName}'s service`}
              </p>

              {flow.completionSuccess.earnings != null && flow.completionSuccess.earnings > 0 && (
                <div style={earningsRowStyle}>
                  <span style={earningsLabelStyle}>Earned</span>
                  <span style={earningsValueStyle}>₪{flow.completionSuccess.earnings.toFixed(0)}</span>
                </div>
              )}

              {!!completionMetaRows.length && (
                <div style={serviceTimerPanelStyle}>
                  <div style={serviceTimerMetaRowStyle}>
                    {completionMetaRows.map((row) => (
                      <span key={`${row.label}:${row.value}`} style={serviceTimerMetaStyle}>
                        {row.label}: {row.value}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {!compRatingDone && (
                <div style={inlineRatingContainerStyle}>
                  <p style={ratingPromptStyle}>
                    {isHebrew ? `איך היה עם ${completionClientName}?` : `How was ${completionClientName}?`}
                  </p>
                  <div style={starsRowStyle}>
                    {[1, 2, 3, 4, 5].map((star) => {
                      const isActive = star <= (compHover || compRating)
                      const isPressed = star === compPressed
                      return (
                        <button
                          key={star}
                          type="button"
                          onMouseEnter={() => setCompHover(star)}
                          onMouseLeave={() => setCompHover(0)}
                          onMouseDown={() => setCompPressed(star)}
                          onMouseUp={() => setCompPressed(0)}
                          onTouchStart={() => {
                            setCompPressed(star)
                            setCompHover(star)
                          }}
                          onTouchEnd={() => {
                            setCompPressed(0)
                            setCompHover(0)
                          }}
                          onClick={async () => {
                            setCompRating(star)
                            await hapticMedium()
                          }}
                          style={{
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            fontSize: 34,
                            lineHeight: 1,
                            color: isActive ? '#F59E0B' : '#D1D5DB',
                            padding: 4,
                            transition: 'color 0.15s ease, transform 0.15s ease',
                            transform: isPressed ? 'scale(1.3)' : compHover === star ? 'scale(1.15)' : 'scale(1)',
                            WebkitTapHighlightColor: 'transparent',
                          }}
                        >
                          ★
                        </button>
                      )
                    })}
                  </div>

                  <div
                    style={{
                      overflow: 'hidden',
                      transition: 'max-height 0.3s ease, opacity 0.3s ease',
                      maxHeight: compRating > 0 ? 200 : 0,
                      opacity: compRating > 0 ? 1 : 0,
                    }}
                  >
                    <textarea
                      value={compReview}
                      onChange={(e) => setCompReview(e.target.value)}
                      placeholder="Share your feedback (optional)"
                      rows={2}
                      style={compTextareaStyle}
                    />
                    <button
                      onClick={handleCompRatingSubmit}
                      disabled={flow.completionRatingSubmitting}
                      style={{
                        ...submitRatingBtnStyle,
                        opacity: flow.completionRatingSubmitting ? 0.7 : 1,
                        cursor: flow.completionRatingSubmitting ? 'not-allowed' : 'pointer',
                      }}
                    >
                      {flow.completionRatingSubmitting ? 'Sending...' : 'Submit rating'}
                    </button>
                  </div>
                </div>
              )}

              {compRatingDone && (
                <div style={thanksBannerStyle}>
                  <span style={thanksTextStyle}>Thanks for your feedback!</span>
                </div>
              )}

              {formattedRatings.length > 0 && (
                <div style={recentRatingsSectionStyle}>
                  <h4 style={recentRatingsHeadingStyle}>Recent reviews</h4>
                  <CompactRatingList ratings={formattedRatings} limit={2} onViewAll={() => {}} />
                </div>
              )}

              <button onClick={flow.dismissCompletion} style={dismissBtnStyle}>
                {compRatingDone ? 'Done' : 'Skip & go online'}
              </button>
            </div>
          )}
        </div>
      </div>

      {flow.screenState === 'incoming_request' && topRequest && (
        <div style={overlayStyle}>
          <div style={overlayBackdropStyle} />
          <div style={bottomSheetStyle}>
            <div style={sheetHeaderStyle}>
              <div style={incomingSheetTitleWrapStyle}>
                <span style={newRequestLabelStyle}>{incomingTitle}</span>
                <span style={incomingSheetSubtitleStyle}>
                  {getCustomerDisplayName(
                    {
                      client: topRequest.client ?? null,
                      clientName: topRequest.client?.full_name || topRequest.client?.email || null,
                      dogName: topRequest.dog_name || null,
                    },
                    isHebrew,
                  )}
                </span>
              </div>
              <span style={{ ...countdownLabelStyle, color: countdown <= 5 ? '#EF4444' : '#F59E0B' }}>
                {countdown}s
              </span>
            </div>

            <div style={progressTrackStyle}>
              <div style={{ ...progressFillStyle, width: `${(countdown / REQUEST_TIMEOUT_SECONDS) * 100}%` }} />
            </div>

            <div style={incomingMainCardStyle}>
              <div style={incomingInfoCardStyle}>
                <div style={incomingInfoLabelStyle}>{isHebrew ? 'שם הזמנה' : 'Order name'}</div>
                <div style={dogNameStyle}>{topRequest.dog_name || t('booking.walkFallback')}</div>
              </div>

              {topRequest.location && (
                <div style={reqLocationStyle}>
                  <div style={incomingInfoLabelStyle}>{isHebrew ? 'כתובת' : 'Location'}</div>
                  <span style={ellipsisStyle}>{formatShortAddress(topRequest.address || topRequest.location)}</span>
                </div>
              )}

              <div style={incomingMetaRowStyle}>
                <div style={incomingMetaCardStyle}>
                  <span style={incomingMetaLabelStyle}>{t('booking.durationQuestion')}</span>
                  <span style={incomingMetaValueStyle}>{requestDuration}</span>
                </div>
                <div style={incomingMetaCardStyle}>
                  <span style={incomingMetaLabelStyle}>{t('booking.priceLabel')}</span>
                  <span style={{ ...incomingMetaValueStyle, color: '#15803D' }}>{requestPrice}</span>
                </div>
              </div>
            </div>

            {flow.openJobs.length > 1 && <div style={queueHintStyle}>+{flow.openJobs.length - 1} more in queue</div>}

            <div style={ctaContainerStyle}>
              <button
                onClick={async () => {
                  await hapticMedium()
                  clearCountdown()
                  void flow.handleDecline(topRequest.id)
                }}
                style={declineBtnStyle}
              >
                Decline
              </button>
              <button
                onClick={async () => {
                  await hapticMedium()
                  void flow.handleAccept(topRequest.id)
                }}
                style={acceptBtnStyle}
                className="request-accept-btn"
              >
                Accept
              </button>
            </div>
          </div>
        </div>
      )}

      {flow.takenNotice && (
        <div style={takenToastWrapStyle}>
          <div style={takenToastStyle}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#0F172A' }}>Request taken</div>
              <div style={{ fontSize: 12, color: '#94A3B8', marginTop: 1 }}>Another walker accepted this one</div>
            </div>
          </div>
        </div>
      )}

      {flow.reviewRequiredJob && !flow.completionSuccess && (
        <div style={completionOverlayStyle}>
          <div style={completionOverlayBackdropStyle} />
          <div style={completionOverlayCardStyle}>
            <div
              style={{
                padding: '20px',
                borderRadius: 28,
                background: '#FFFFFF',
                border: '1px solid #E2E8F0',
                boxShadow: '0 14px 40px rgba(15,23,42,0.06)',
              }}
            >
              <div style={{ ...checkStyle, background: '#FEF3C7', color: '#B45309' }}>⚠️</div>
              <div style={completionTitleStyle}>{t('completion.issueUnderReview')}</div>
              <div style={completionSubStyle}>{t('completion.reviewPendingSubtitle')}</div>
              <button onClick={flow.dismissReviewRequired} style={dismissBtnStyle}>
                {t('completion.backToDashboard')}
              </button>
            </div>
          </div>
        </div>
      )}

      {flow.completionSuccess && (
        <div style={completionOverlayStyle}>
          <div style={completionOverlayBackdropStyle} />
          <div style={completionOverlayCardStyle}>
            <CompletionCard
              promptKey={flow.completionSuccess.jobId}
              title={getServiceLabels(null).completedTitle}
              subtitle={isHebrew ? `דרג את ${completionClientName}` : `Rate ${completionClientName}`}
              metaRows={completionMetaRows}
              earnings={
                flow.completionSuccess.earnings != null && flow.completionSuccess.earnings > 0
                  ? `₪${flow.completionSuccess.earnings.toFixed(0)}`
                  : undefined
              }
              onRate={flow.submitCompletionRating}
              ratingSubmitting={flow.completionRatingSubmitting}
              alreadyRated={flow.ratedJobIds.has(flow.completionSuccess.jobId)}
              favoriteLabel={completionClientName}
              favoriteInactiveLabel={isHebrew ? `שמור את ${completionClientName}` : `Save ${completionClientName}`}
              favoriteActiveLabel={isHebrew ? `${completionClientName} נשמר` : `${completionClientName} saved`}
              favoriteActive={completionClientSaved}
              onToggleFavorite={
                completionClientKey
                  ? () => {
                      void toggleFavoriteClient(completionClientKey, completionClientName)
                    }
                  : undefined
              }
              onDismiss={flow.dismissCompletion}
            />
          </div>
        </div>
      )}
    </>
  )
}

function BurgerSection({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: ReactNode
}) {
  return (
    <section style={burgerSectionStyle}>
      <div style={burgerSectionHeaderStyle}>
        <div style={burgerSectionTitleStyle}>{title}</div>
        {subtitle ? <div style={burgerSectionSubtitleStyle}>{subtitle}</div> : null}
      </div>
      {children}
    </section>
  )
}

function MenuNavRow({
  icon,
  label,
  destructive = false,
  onClick,
}: {
  icon: string
  label: string
  destructive?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        ...menuNavRowStyle,
        ...(destructive ? menuNavRowDestructiveStyle : null),
      }}
    >
      <span style={menuNavIconStyle}>{icon}</span>
      <span style={{ flex: 1, textAlign: 'start' }}>{label}</span>
      {!destructive && <span style={menuNavChevronStyle}>›</span>}
    </button>
  )
}

function RadarVisual() {
  return (
    <div style={idleRadarVisualStyle} aria-hidden="true">
      <svg viewBox="0 0 320 150" width="100%" height="100%" preserveAspectRatio="xMidYMid meet">
        <defs>
          <radialGradient id="walkerRadarGlow" cx="50%" cy="50%" r="62%">
            <stop offset="0%" stopColor="rgba(91,124,250,0.18)" />
            <stop offset="45%" stopColor="rgba(91,124,250,0.08)" />
            <stop offset="100%" stopColor="rgba(91,124,250,0)" />
          </radialGradient>
          <linearGradient id="walkerRadarSweep" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="rgba(91,124,250,0.28)" />
            <stop offset="55%" stopColor="rgba(91,124,250,0.08)" />
            <stop offset="100%" stopColor="rgba(91,124,250,0)" />
          </linearGradient>
        </defs>

        <rect x="0" y="0" width="320" height="150" rx="22" fill="transparent" />
        <circle cx="160" cy="75" r="64" fill="url(#walkerRadarGlow)" />
        <circle cx="160" cy="75" r="58" fill="none" stroke="rgba(91,124,250,0.18)" strokeWidth="1.5" />
        <circle cx="160" cy="75" r="42" fill="none" stroke="rgba(91,124,250,0.16)" strokeWidth="1.5" />
        <circle cx="160" cy="75" r="26" fill="none" stroke="rgba(91,124,250,0.16)" strokeWidth="1.5" />
        <line x1="36" y1="75" x2="284" y2="75" stroke="rgba(148,163,184,0.16)" strokeWidth="1" />
        <line x1="160" y1="16" x2="160" y2="134" stroke="rgba(148,163,184,0.16)" strokeWidth="1" />

        <path d="M160 75 L160 17 A58 58 0 0 1 218 75 Z" fill="url(#walkerRadarSweep)" opacity="0.92">
          <animateTransform
            attributeName="transform"
            type="rotate"
            from="0 160 75"
            to="360 160 75"
            dur="5.6s"
            repeatCount="indefinite"
          />
        </path>

        <circle cx="160" cy="75" r="6" fill="#5B7CFA">
          <animate
            attributeName="r"
            values="5.5;7.5;5.5"
            dur="1.9s"
            repeatCount="indefinite"
          />
          <animate
            attributeName="opacity"
            values="0.95;1;0.95"
            dur="1.9s"
            repeatCount="indefinite"
          />
        </circle>

        <circle cx="160" cy="75" r="10" fill="none" stroke="rgba(91,124,250,0.28)" strokeWidth="2">
          <animate
            attributeName="r"
            values="10;36"
            dur="2.2s"
            repeatCount="indefinite"
          />
          <animate
            attributeName="opacity"
            values="0.6;0"
            dur="2.2s"
            repeatCount="indefinite"
          />
        </circle>

        <circle cx="160" cy="75" r="10" fill="none" stroke="rgba(91,124,250,0.18)" strokeWidth="1.5">
          <animate
            attributeName="r"
            values="10;50"
            dur="2.2s"
            begin="1.1s"
            repeatCount="indefinite"
          />
          <animate
            attributeName="opacity"
            values="0.45;0"
            dur="2.2s"
            begin="1.1s"
            repeatCount="indefinite"
          />
        </circle>
      </svg>
    </div>
  )
}

const screenStyle: React.CSSProperties = {
  minHeight: '100dvh',
  background: '#F8FAFC',
  color: '#0F172A',
  fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
  overflowY: 'auto',
  scrollbarWidth: 'none',
  msOverflowStyle: 'none',
  WebkitOverflowScrolling: 'touch',
}

const headerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'stretch',
  gap: 6,
  margin: 'calc(10px + env(safe-area-inset-top)) 18px 4px',
  padding: '0',
  position: 'sticky',
  top: 0,
  zIndex: 20,
  background: 'transparent',
}

const headerMenuBtnStyle: React.CSSProperties = {
  width: 44,
  height: 44,
  borderRadius: 14,
  border: '1px solid rgba(226,232,240,0.9)',
  background: 'rgba(255,255,255,0.92)',
  boxShadow: '0 6px 16px rgba(15, 23, 42, 0.05)',
  display: 'grid',
  placeItems: 'center',
  cursor: 'pointer',
}

const greetingStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 21,
  fontWeight: 800,
  lineHeight: 1.1,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const headerTopRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
}

const headerIdentityRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '0',
}

const headerIdentityStyle: React.CSSProperties = {
  minWidth: 0,
  flex: 1,
  display: 'grid',
  gap: 2,
}

const bellWrapStyle: React.CSSProperties = {
  width: 44,
  height: 44,
  borderRadius: 14,
  background: 'rgba(255,255,255,0.92)',
  border: '1px solid rgba(226,232,240,0.9)',
  boxShadow: '0 6px 16px rgba(15, 23, 42, 0.05)',
  display: 'grid',
  placeItems: 'center',
}

const activeSessionChipStyle: React.CSSProperties = {
  padding: '8px 10px',
  borderRadius: 999,
  background: 'rgba(224, 242, 254, 0.92)',
  color: '#0369A1',
  fontSize: 11,
  fontWeight: 800,
  whiteSpace: 'nowrap',
}

const stripeGateOverlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 29,
  background: 'rgba(15, 23, 42, 0.24)',
}

const stripeGateCardStyle: React.CSSProperties = {
  position: 'fixed',
  left: 16,
  right: 16,
  bottom: 'calc(16px + env(safe-area-inset-bottom))',
  zIndex: 30,
  borderRadius: 28,
  background: 'rgba(255,255,255,0.98)',
  border: '1px solid rgba(255,255,255,0.72)',
  boxShadow: '0 24px 56px rgba(15, 23, 42, 0.20)',
  padding: 22,
  display: 'grid',
  gap: 12,
}

const stripeGateEyebrowStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 800,
  color: '#5B7CFA',
  textTransform: 'uppercase',
}

const stripeGateTitleStyle: React.CSSProperties = {
  fontSize: 28,
  lineHeight: 1.05,
  fontWeight: 900,
  color: '#0F172A',
}

const stripeGateBodyStyle: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.55,
  color: '#5E6B83',
}

const stripeGateActionsStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 10,
  marginTop: 4,
}

const stripeGatePrimaryStyle: React.CSSProperties = {
  appearance: 'none',
  border: 'none',
  minHeight: 52,
  borderRadius: 18,
  background: 'linear-gradient(180deg, #0F172A 0%, #233B74 100%)',
  color: '#FFFFFF',
  fontSize: 15,
  fontWeight: 800,
  cursor: 'pointer',
}

const stripeGatePrimaryDisabledStyle: React.CSSProperties = {
  opacity: 0.6,
  cursor: 'not-allowed',
  boxShadow: 'none',
}

const stripeGateSecondaryStyle: React.CSSProperties = {
  appearance: 'none',
  border: '1px solid rgba(145, 164, 196, 0.24)',
  minHeight: 52,
  borderRadius: 18,
  background: '#FFFFFF',
  color: '#23314F',
  fontSize: 15,
  fontWeight: 700,
  cursor: 'pointer',
}

const menuOverlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(15, 23, 42, 0.18)',
  zIndex: 30,
}

const menuPanelStyle: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  bottom: 0,
  width: 'min(86vw, 360px)',
  maxHeight: '100dvh',
  overflow: 'hidden',
  background: 'rgba(255,255,255,0.96)',
  backdropFilter: 'blur(16px) saturate(135%)',
  WebkitBackdropFilter: 'blur(16px) saturate(135%)',
  boxShadow: '0 18px 48px rgba(15, 23, 42, 0.16)',
  zIndex: 31,
  display: 'flex',
  flexDirection: 'column',
  paddingTop: 'env(safe-area-inset-top)',
  paddingBottom: 'env(safe-area-inset-bottom)',
}

const menuPanelLtrStyle: React.CSSProperties = {
  left: 0,
  borderTopRightRadius: 28,
  borderBottomRightRadius: 28,
  animation: 'walkerDrawerInLtr 0.22s ease-out',
}

const menuPanelRtlStyle: React.CSSProperties = {
  right: 0,
  borderTopLeftRadius: 28,
  borderBottomLeftRadius: 28,
  animation: 'walkerDrawerInRtl 0.22s ease-out',
}

const menuHeaderRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '22px 20px 14px',
  borderBottom: '1px solid #E5E7EB',
}

const menuHeaderLeftStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
}

const menuBackButtonStyle: React.CSSProperties = {
  appearance: 'none',
  width: 36,
  height: 36,
  borderRadius: 12,
  border: '1px solid #E2E8F0',
  background: '#F8FAFC',
  cursor: 'pointer',
  fontSize: 24,
  fontWeight: 700,
  color: '#0F172A',
}

const menuTitleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 800,
}

const menuProfileButtonStyle: React.CSSProperties = {
  margin: '0 0 20px',
  border: '1px solid #E2E8F0',
  background: 'linear-gradient(180deg, #FFFFFF 0%, #F8FAFC 100%)',
  borderRadius: 24,
  padding: 16,
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  textAlign: 'left',
}

const menuProfileTextStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
}

const menuScrollAreaStyle: React.CSSProperties = {
  padding: 16,
  overflowY: 'auto',
  scrollbarWidth: 'none',
  msOverflowStyle: 'none',
}

const menuRowListStyle: React.CSSProperties = {
  display: 'grid',
  gap: 12,
  marginBottom: 20,
}

const burgerSectionStyle: React.CSSProperties = {
  display: 'grid',
  gap: 14,
  marginBottom: 20,
}

const burgerSectionHeaderStyle: React.CSSProperties = {
  display: 'grid',
  gap: 4,
}

const burgerSectionTitleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 800,
  color: '#0F172A',
}

const burgerSectionSubtitleStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.5,
  color: '#64748B',
}

const menuFooterActionWrapStyle: React.CSSProperties = {
  marginTop: 6,
}

const menuNavRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  width: '100%',
  padding: '16px 18px',
  borderRadius: 20,
  border: '1px solid #E2E8F0',
  background: '#FFFFFF',
  color: '#0F172A',
  fontSize: 15,
  fontWeight: 800,
  cursor: 'pointer',
  textAlign: 'left',
}

const menuNavRowDestructiveStyle: React.CSSProperties = {
  color: '#DC2626',
  borderColor: 'rgba(248, 113, 113, 0.28)',
  background: '#FEF2F2',
}

const menuNavIconStyle: React.CSSProperties = {
  width: 24,
  textAlign: 'center',
  flexShrink: 0,
}

const menuNavChevronStyle: React.CSSProperties = {
  fontSize: 22,
  color: '#94A3B8',
  lineHeight: 1,
}

const profileNameStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 800,
  color: '#0F172A',
}

const profileEmailStyle: React.CSSProperties = {
  marginTop: 3,
  fontSize: 12,
  color: '#94A3B8',
}

const profileRatingStyle: React.CSSProperties = {
  marginTop: 6,
  fontSize: 12,
  color: '#64748B',
  fontWeight: 700,
}

const uploadStatusStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#64748B',
}

const uploadErrorStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#DC2626',
}

const settingsProfileRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 14,
}

const settingsProfileMetaStyle: React.CSSProperties = {
  flex: 1,
  display: 'grid',
  gap: 6,
}

const settingsProfileTitleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 800,
  color: '#0F172A',
}

const settingsPhotoButtonStyle: React.CSSProperties = {
  appearance: 'none',
  border: '1px solid #E2E8F0',
  background: '#FFFFFF',
  color: '#334155',
  borderRadius: 999,
  padding: '8px 12px',
  fontSize: 12,
  fontWeight: 800,
  cursor: 'pointer',
  justifySelf: 'start',
}

const languageSelectorRowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 10,
}

const languageButtonStyle: React.CSSProperties = {
  appearance: 'none',
  minHeight: 48,
  borderRadius: 16,
  border: '1px solid #E2E8F0',
  background: '#FFFFFF',
  color: '#334155',
  fontSize: 15,
  fontWeight: 800,
  cursor: 'pointer',
}

const languageButtonActiveStyle: React.CSSProperties = {
  background: '#0F172A',
  color: '#FFFFFF',
  borderColor: '#0F172A',
}

const serviceTypeSelectorRowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 10,
}

const serviceTypeButtonStyle: React.CSSProperties = {
  appearance: 'none',
  minHeight: 116,
  borderRadius: 18,
  border: '1px solid #E2E8F0',
  background: '#FFFFFF',
  color: '#334155',
  padding: '14px 12px',
  display: 'grid',
  justifyItems: 'start',
  alignContent: 'start',
  gap: 6,
  textAlign: 'left',
  cursor: 'pointer',
}

const serviceTypeButtonActiveStyle: React.CSSProperties = {
  borderColor: '#0F172A',
  background: '#F8FAFC',
  boxShadow: '0 10px 24px rgba(15, 23, 42, 0.08)',
}

const serviceTypeButtonIconStyle: React.CSSProperties = {
  fontSize: 22,
  lineHeight: 1,
}

const serviceTypeButtonLabelStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 800,
  color: '#0F172A',
}

const serviceTypeButtonDescriptionStyle: React.CSSProperties = {
  fontSize: 12,
  lineHeight: 1.45,
  color: '#64748B',
}

const serviceTypeButtonMetaStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: '#0F172A',
}

const serviceTypeStatusSuccessStyle: React.CSSProperties = {
  marginTop: 10,
  fontSize: 12,
  fontWeight: 700,
  color: '#15803D',
}

const serviceTypeStatusErrorStyle: React.CSSProperties = {
  marginTop: 10,
  fontSize: 12,
  fontWeight: 700,
  color: '#DC2626',
}

const emptyMenuCardStyle: React.CSSProperties = {
  padding: '16px 18px',
  borderRadius: 20,
  border: '1px dashed #CBD5E1',
  background: '#F8FAFC',
  color: '#64748B',
  fontSize: 14,
  fontWeight: 600,
}

const preferredCustomerListStyle: React.CSSProperties = {
  display: 'grid',
  gap: 10,
}

const preferredCustomerRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '14px 16px',
  borderRadius: 18,
  border: '1px solid #E2E8F0',
  background: 'linear-gradient(180deg, #FFFFFF 0%, #F8FAFC 100%)',
}

const preferredCustomerHeartStyle: React.CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 999,
  display: 'grid',
  placeItems: 'center',
  background: '#FEF3C7',
  color: '#B45309',
  fontSize: 15,
  lineHeight: 1,
  flexShrink: 0,
}

const preferredCustomerNameStyle: React.CSSProperties = {
  minWidth: 0,
  fontSize: 14,
  fontWeight: 700,
  color: '#0F172A',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const futureOrderListStyle: React.CSSProperties = {
  display: 'grid',
  gap: 12,
}

const futureOrderCardStyle: React.CSSProperties = {
  borderRadius: 22,
  border: '1px solid #E2E8F0',
  background: '#FFFFFF',
  padding: 16,
  display: 'grid',
  gap: 10,
}

const futureOrderTopStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'start',
  justifyContent: 'space-between',
  gap: 12,
}

const futureOrderTitleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 800,
  color: '#0F172A',
}

const futureOrderSubtitleStyle: React.CSSProperties = {
  marginTop: 3,
  fontSize: 13,
  color: '#64748B',
}

const futureOrderPriceStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 900,
  color: '#15803D',
}

const futureOrderAddressStyle: React.CSSProperties = {
  fontSize: 13,
  color: '#334155',
}

const futureOrderMetaStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 10,
  fontSize: 12,
  color: '#64748B',
  fontWeight: 700,
}

const contentStyle: React.CSSProperties = {
  padding: '2px 18px calc(20px + env(safe-area-inset-bottom))',
  display: 'grid',
  gap: 8,
  boxSizing: 'border-box',
}

const toastErrorStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 10,
  padding: '14px 16px',
  borderRadius: 18,
  background: '#FEF2F2',
  color: '#B91C1C',
  fontSize: 14,
  fontWeight: 700,
}

const toastSuccessStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 10,
  padding: '14px 16px',
  borderRadius: 18,
  background: '#ECFDF5',
  color: '#166534',
  fontSize: 14,
  fontWeight: 700,
}

const toastDismissStyle: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  fontSize: 20,
  cursor: 'pointer',
}

const idleHeroStyle: React.CSSProperties = {
  position: 'relative',
  overflow: 'hidden',
  padding: '16px 16px 14px',
  borderRadius: 28,
  background:
    'radial-gradient(circle at top, rgba(91,124,250,0.18) 0%, rgba(91,124,250,0.04) 28%, rgba(255,255,255,0.96) 62%), linear-gradient(180deg, #FFFFFF 0%, #F8FAFC 100%)',
  border: '1px solid rgba(226,232,240,0.9)',
  boxShadow: '0 18px 40px rgba(15,23,42,0.10)',
  display: 'grid',
  justifyItems: 'center',
  gap: 6,
}

const idleHeroOnlineStyle: React.CSSProperties = {
  background:
    'radial-gradient(circle at top, rgba(22,163,74,0.18) 0%, rgba(22,163,74,0.04) 28%, rgba(255,255,255,0.96) 62%), linear-gradient(180deg, #FFFFFF 0%, #F8FAFC 100%)',
}

const idleHeroGlowStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 'auto auto -30px -30px',
  width: 120,
  height: 120,
  borderRadius: '50%',
  background: 'radial-gradient(circle, rgba(255,255,255,0.8) 0%, rgba(255,255,255,0) 70%)',
  pointerEvents: 'none',
}

const idleHeroBadgeStyle: React.CSSProperties = {
  position: 'relative',
  zIndex: 1,
  padding: '5px 9px',
  borderRadius: 999,
  background: 'rgba(91,124,250,0.10)',
  color: '#4157B2',
  fontSize: 10,
  fontWeight: 800,
}

const idleHeroToggleStyle: React.CSSProperties = {
  position: 'relative',
  zIndex: 1,
  width: 66,
  height: 38,
  borderRadius: 999,
  border: 'none',
  padding: 3,
  boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.24)',
  cursor: 'pointer',
  transition: 'background 0.2s ease',
}

const idleHeroToggleKnobStyle: React.CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: '50%',
  background: '#FFFFFF',
  boxShadow: '0 8px 16px rgba(15,23,42,0.18)',
  transition: 'transform 0.2s ease',
}

const idleHeroTitleStyle: React.CSSProperties = {
  position: 'relative',
  zIndex: 1,
  fontSize: 20,
  lineHeight: 1.08,
  fontWeight: 900,
  color: '#0F172A',
  textAlign: 'center',
}

const idleHeroBodyStyle: React.CSSProperties = {
  position: 'relative',
  zIndex: 1,
  maxWidth: 280,
  fontSize: 12,
  lineHeight: 1.35,
  color: '#64748B',
  textAlign: 'center',
}

const idleCardGridStyle: React.CSSProperties = {
  display: 'grid',
  gap: 6,
}

const idleRadarCardStyle: React.CSSProperties = {
  position: 'relative',
  overflow: 'hidden',
  borderRadius: 22,
  background:
    'radial-gradient(circle at 20% 20%, rgba(91,124,250,0.14) 0%, rgba(91,124,250,0.04) 24%, rgba(255,255,255,0.96) 60%), linear-gradient(180deg, #FFFFFF 0%, #F8FAFC 100%)',
  border: '1px solid #E2E8F0',
  boxShadow: '0 12px 26px rgba(15,23,42,0.06)',
  padding: '12px 12px 14px',
  display: 'grid',
  gap: 8,
}

const idleRadarVisualStyle: React.CSSProperties = {
  position: 'relative',
  height: 92,
  borderRadius: 18,
  background:
    'radial-gradient(circle at center, rgba(91,124,250,0.12) 0%, rgba(91,124,250,0.04) 28%, rgba(255,255,255,0) 29%), linear-gradient(180deg, rgba(255,255,255,0.86) 0%, rgba(248,250,252,0.98) 100%)',
  border: '1px solid rgba(226,232,240,0.9)',
  display: 'grid',
  placeItems: 'center',
}

const idleInfoCardTextWrapStyle: React.CSSProperties = {
  display: 'grid',
  gap: 4,
}

const idleStatsCardStyle: React.CSSProperties = {
  borderRadius: 22,
  background: 'linear-gradient(180deg, #FFFFFF 0%, #F8FAFC 100%)',
  border: '1px solid #E2E8F0',
  boxShadow: '0 12px 26px rgba(15,23,42,0.06)',
  padding: 10,
  display: 'grid',
  gap: 7,
}

const idleInfoCardTitleStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 800,
  color: '#0F172A',
}

const idleInfoCardBodyStyle: React.CSSProperties = {
  fontSize: 12,
  lineHeight: 1.35,
  color: '#64748B',
}

const idleStatsGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 6,
}

const idleStatItemStyle: React.CSSProperties = {
  padding: '8px 10px',
  borderRadius: 14,
  background: '#F8FAFC',
  border: '1px solid #E2E8F0',
  display: 'grid',
  gap: 2,
}

const idleStatLabelStyle: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 800,
  color: '#64748B',
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
}

const idleStatValueStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 900,
  color: '#0F172A',
}

const walletCardStyle: React.CSSProperties = {
  borderRadius: 22,
  background: 'linear-gradient(180deg, #FFFFFF 0%, #F8FAFC 100%)',
  border: '1px solid #E2E8F0',
  boxShadow: '0 12px 26px rgba(15,23,42,0.06)',
  padding: 10,
  display: 'grid',
  gap: 8,
}

const walletGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 6,
}

const walletMetricStyle: React.CSSProperties = {
  padding: '9px 10px',
  borderRadius: 14,
  background: '#F8FAFC',
  border: '1px solid #E2E8F0',
  display: 'grid',
  gap: 4,
}

const walletMetricLabelStyle: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 800,
  color: '#64748B',
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
}

const walletMetricValueStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 900,
  color: '#0F172A',
}

const walletStatusWrapStyle: React.CSSProperties = {
  display: 'grid',
  gap: 8,
  marginTop: 2,
}

const walletStatusNeutralStyle: React.CSSProperties = {
  fontSize: 11,
  lineHeight: 1.35,
  color: '#64748B',
  fontWeight: 700,
}

const walletStatusReadyStyle: React.CSSProperties = {
  fontSize: 11,
  lineHeight: 1.35,
  color: '#15803D',
  fontWeight: 800,
}

const walletStatusWarningStyle: React.CSSProperties = {
  fontSize: 11,
  lineHeight: 1.35,
  color: '#9A6B16',
  fontWeight: 700,
}

const walletSetupButtonStyle: React.CSSProperties = {
  appearance: 'none',
  justifySelf: 'start',
  minHeight: 34,
  padding: '0 12px',
  borderRadius: 999,
  border: '1px solid rgba(217, 119, 6, 0.16)',
  background: '#FFF7ED',
  color: '#9A3412',
  fontSize: 12,
  fontWeight: 800,
  cursor: 'pointer',
  transformOrigin: 'center',
  transition: 'transform 0.22s ease, box-shadow 0.22s ease, opacity 0.22s ease',
}

const walletSetupButtonDisabledStyle: React.CSSProperties = {
  opacity: 0.7,
  cursor: 'not-allowed',
}

const walletSetupButtonPulseStyle: React.CSSProperties = {
  animation: 'walkerPayoutPulse 2.5s ease-in-out infinite',
}

const walletSetupButtonPulseAndNudgeStyle: React.CSSProperties = {
  animation: 'walkerPayoutPulse 2.5s ease-in-out infinite, walkerPayoutNudge 0.85s ease-in-out 1',
}

const activeCardStyle: React.CSSProperties = {
  padding: '20px',
  borderRadius: 28,
  background: '#FFFFFF',
  border: '1px solid #E2E8F0',
  boxShadow: '0 14px 40px rgba(15,23,42,0.06)',
  display: 'flex',
  flexDirection: 'column',
  boxSizing: 'border-box',
  marginBottom: 'calc(10px + env(safe-area-inset-bottom))',
}

const activeHeaderRowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
}

const activeBadgeStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 12px',
  borderRadius: 999,
  background: '#ECFDF5',
  color: '#166534',
  fontSize: 12,
  fontWeight: 800,
}

const activeBadgeDotStyle: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: 999,
  background: '#16A34A',
}

const onTheWayBadgeStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 12px',
  borderRadius: 999,
  background: '#EFF6FF',
  color: '#1D4ED8',
  fontSize: 12,
  fontWeight: 800,
}

const onTheWayBadgeDotStyle: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: 999,
  background: '#2563EB',
}

const activeDogNameStyle: React.CSSProperties = {
  margin: '14px 0 4px',
  fontSize: 24,
  fontWeight: 800,
}

const activeClientStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 15,
  color: '#64748B',
  fontWeight: 700,
}

const activeLocationStyle: React.CSSProperties = {
  marginTop: 12,
  padding: '14px 16px',
  borderRadius: 18,
  background: '#F8FAFC',
  border: '1px solid #E2E8F0',
}

const completionPaymentErrorStyle: React.CSSProperties = {
  marginTop: 12,
  padding: '12px 14px',
  borderRadius: 16,
  background: '#FEF2F2',
  border: '1px solid #FECACA',
  color: '#991B1B',
  fontSize: 13,
  fontWeight: 700,
  lineHeight: 1.45,
}

const waitingStateStyle: React.CSSProperties = {
  marginTop: 12,
  padding: '14px 16px',
  borderRadius: 16,
  background: '#F8FAFC',
  border: '1px solid #E2E8F0',
  display: 'grid',
  gap: 4,
}

const waitingStateTitleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 800,
  color: '#0F172A',
}

const waitingStateBodyStyle: React.CSSProperties = {
  fontSize: 13,
  color: '#64748B',
  lineHeight: 1.45,
}

const ellipsisStyle: React.CSSProperties = {
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const completeBtnStyle: React.CSSProperties = {
  width: 'min(100%, 224px)',
  minHeight: 48,
  alignSelf: 'center',
  flexShrink: 0,
  borderRadius: 16,
  border: 'none',
  background: '#08153B',
  color: '#FFFFFF',
  fontSize: 15,
  fontWeight: 800,
  cursor: 'pointer',
  marginTop: 16,
  padding: '12px 18px',
  lineHeight: 1.2,
  boxSizing: 'border-box',
  WebkitTapHighlightColor: 'transparent',
}

const pendingConfirmationBtnStyle: React.CSSProperties = {
  background: '#F59E0B',
  color: '#FFFFFF',
}

const serviceTimerPanelStyle: React.CSSProperties = {
  marginTop: 14,
  borderRadius: 18,
  background: '#F8FAFC',
  border: '1px solid #E2E8F0',
  padding: '14px 16px',
  display: 'grid',
  gap: 8,
}

const serviceTimerPrimaryRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
}

const serviceTimerLabelStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: '#64748B',
}

const serviceTimerValueStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 800,
  color: '#0F172A',
  fontVariantNumeric: 'tabular-nums',
}

const serviceTimerMetaRowStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 10,
}

const serviceTimerMetaStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: '#475569',
}

const completionCardStyle: React.CSSProperties = {
  padding: '20px',
  borderRadius: 28,
  background: '#FFFFFF',
  border: '1px solid #E2E8F0',
  boxShadow: '0 14px 40px rgba(15,23,42,0.06)',
}

const checkStyle: React.CSSProperties = {
  width: 56,
  height: 56,
  borderRadius: 999,
  display: 'grid',
  placeItems: 'center',
  background: '#ECFDF5',
  color: '#15803D',
  fontSize: 28,
  fontWeight: 900,
  margin: '0 auto',
}

const completionTitleStyle: React.CSSProperties = {
  margin: '14px 0 4px',
  textAlign: 'center',
  fontSize: 22,
  fontWeight: 800,
}

const completionSubStyle: React.CSSProperties = {
  margin: 0,
  textAlign: 'center',
  color: '#64748B',
  fontWeight: 700,
}

const earningsRowStyle: React.CSSProperties = {
  marginTop: 16,
  padding: '14px 16px',
  borderRadius: 18,
  background: '#F8FAFC',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
}

const earningsLabelStyle: React.CSSProperties = {
  fontSize: 13,
  color: '#64748B',
  fontWeight: 700,
}

const earningsValueStyle: React.CSSProperties = {
  fontSize: 20,
  color: '#0F172A',
  fontWeight: 900,
}

const inlineRatingContainerStyle: React.CSSProperties = {
  marginTop: 18,
}

const ratingPromptStyle: React.CSSProperties = {
  margin: 0,
  textAlign: 'center',
  fontSize: 14,
  fontWeight: 700,
  color: '#475569',
}

const starsRowStyle: React.CSSProperties = {
  marginTop: 10,
  display: 'flex',
  justifyContent: 'center',
  gap: 2,
}

const compTextareaStyle: React.CSSProperties = {
  width: '100%',
  marginTop: 10,
  borderRadius: 16,
  border: '1px solid #E2E8F0',
  padding: '12px 14px',
  fontSize: 14,
  outline: 'none',
  resize: 'none',
  boxSizing: 'border-box',
}

const submitRatingBtnStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 46,
  borderRadius: 16,
  border: 'none',
  background: '#08153B',
  color: '#FFFFFF',
  fontSize: 14,
  fontWeight: 800,
  cursor: 'pointer',
  marginTop: 10,
}

const thanksBannerStyle: React.CSSProperties = {
  marginTop: 16,
  padding: '12px 14px',
  borderRadius: 16,
  background: '#ECFDF5',
  textAlign: 'center',
}

const thanksTextStyle: React.CSSProperties = {
  color: '#166534',
  fontWeight: 800,
  fontSize: 14,
}

const recentRatingsSectionStyle: React.CSSProperties = {
  marginTop: 18,
}

const recentRatingsHeadingStyle: React.CSSProperties = {
  margin: '0 0 10px',
  fontSize: 15,
  fontWeight: 800,
  color: '#0F172A',
}

const dismissBtnStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 46,
  borderRadius: 16,
  border: '1px solid #E2E8F0',
  background: '#FFFFFF',
  color: '#334155',
  fontSize: 14,
  fontWeight: 800,
  cursor: 'pointer',
  marginTop: 16,
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 40,
}

const overlayBackdropStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: 'rgba(15,23,42,0.28)',
}

const bottomSheetStyle: React.CSSProperties = {
  position: 'absolute',
  left: 0,
  right: 0,
  bottom: 0,
  background: '#FFFFFF',
  borderTopLeftRadius: 28,
  borderTopRightRadius: 28,
  padding: '18px 18px calc(18px + env(safe-area-inset-bottom))',
  boxShadow: '0 -18px 60px rgba(15,23,42,0.16)',
}

const sheetHeaderStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  gap: 12,
}

const incomingSheetTitleWrapStyle: React.CSSProperties = {
  display: 'grid',
  gap: 4,
}

const newRequestLabelStyle: React.CSSProperties = {
  fontSize: 20,
  fontWeight: 900,
  color: '#0F172A',
}

const incomingSheetSubtitleStyle: React.CSSProperties = {
  fontSize: 13,
  color: '#64748B',
  fontWeight: 700,
}

const countdownLabelStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 900,
}

const progressTrackStyle: React.CSSProperties = {
  marginTop: 12,
  height: 6,
  borderRadius: 999,
  background: '#E2E8F0',
  overflow: 'hidden',
}

const progressFillStyle: React.CSSProperties = {
  height: '100%',
  borderRadius: 999,
  background: '#F59E0B',
  transition: 'width 1s linear',
}

const dogNameStyle: React.CSSProperties = {
  fontSize: 24,
  fontWeight: 900,
  color: '#0F172A',
}

const incomingMainCardStyle: React.CSSProperties = {
  marginTop: 16,
  padding: 18,
  borderRadius: 24,
  background: '#FFFFFF',
  border: '1px solid #E2E8F0',
  boxShadow: '0 12px 26px rgba(15,23,42,0.08)',
}

const incomingInfoCardStyle: React.CSSProperties = {
  padding: '14px 16px',
  borderRadius: 18,
  background: '#F8FAFC',
  border: '1px solid #E2E8F0',
  display: 'grid',
  gap: 6,
}

const incomingInfoLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  color: '#64748B',
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
}

const reqLocationStyle: React.CSSProperties = {
  marginTop: 10,
  padding: '14px 16px',
  borderRadius: 18,
  background: '#F8FAFC',
  border: '1px solid #E2E8F0',
}

const incomingMetaRowStyle: React.CSSProperties = {
  marginTop: 14,
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 10,
}

const incomingMetaCardStyle: React.CSSProperties = {
  padding: '12px 14px',
  borderRadius: 18,
  background: '#F8FAFC',
  border: '1px solid #E2E8F0',
  display: 'grid',
  gap: 4,
}

const incomingMetaLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  color: '#64748B',
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
}

const incomingMetaValueStyle: React.CSSProperties = {
  fontSize: 15,
  color: '#0F172A',
  fontWeight: 800,
}

const queueHintStyle: React.CSSProperties = {
  marginTop: 12,
  fontSize: 12,
  color: '#64748B',
  fontWeight: 700,
}

const ctaContainerStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 10,
  marginTop: 18,
}

const acceptBtnStyle: React.CSSProperties = {
  minHeight: 52,
  borderRadius: 18,
  border: 'none',
  background: '#08153B',
  color: '#FFFFFF',
  fontSize: 16,
  fontWeight: 800,
  cursor: 'pointer',
}

const declineBtnStyle: React.CSSProperties = {
  minHeight: 52,
  borderRadius: 18,
  border: '1px solid #E2E8F0',
  background: '#FFFFFF',
  color: '#334155',
  fontSize: 16,
  fontWeight: 800,
  cursor: 'pointer',
}

const takenToastWrapStyle: React.CSSProperties = {
  position: 'fixed',
  left: 18,
  right: 18,
  bottom: 'calc(18px + env(safe-area-inset-bottom))',
  zIndex: 45,
}

const takenToastStyle: React.CSSProperties = {
  padding: '14px 16px',
  borderRadius: 18,
  background: '#FFFFFF',
  boxShadow: '0 14px 40px rgba(15,23,42,0.14)',
}

const completionOverlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 50,
  display: 'flex',
  alignItems: 'flex-end',
  justifyContent: 'center',
  padding: '18px 14px calc(18px + env(safe-area-inset-bottom))',
  boxSizing: 'border-box',
  pointerEvents: 'auto',
}

const completionOverlayBackdropStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: 'rgba(15, 23, 42, 0.26)',
}

const completionOverlayCardStyle: React.CSSProperties = {
  position: 'relative',
  width: 'min(420px, 100%)',
  maxWidth: '100%',
  boxSizing: 'border-box',
}
