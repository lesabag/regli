import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import NotificationsBell from '../components/NotificationsBell'
import MapView from '../components/MapView'
import DurationPicker from '../components/DurationPicker'
import ActionButton from '../components/ActionButton'
import SearchingSheet from '../components/SearchingSheet'
import CompletionCard from '../components/CompletionCard'
import CardSetupForm from '../components/CardSetupForm'
import MessageBanner from '../components/MessageBanner'
import IOSDateTimeSheet from '../components/IOSDateTimeSheet'
import ProfileAvatar from '../components/ProfileAvatar'
import GroupedHistory from '../components/GroupedHistory'
import type { HistoryItem } from '../components/GroupedHistory'
import type { GpsQuality } from '../hooks/useJobTracking'
import { useClientFlow } from '../hooks/useClientFlow'
import { useProfilePhoto } from '../hooks/useProfilePhoto'
import { useNearbyWalkers } from '../hooks/useNearbyWalkers'
import { usePushNotifications } from '../hooks/usePushNotifications'
import { DURATION_OPTIONS, type DurationType } from '../lib/payments'
import { formatShortAddress } from '../utils/addressFormat'
import { getServiceLabels } from '../utils/serviceLifecycle'
import { getDurationSummary } from '../utils/serviceTiming'

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function toLocalDatetimeInputValue(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`
}

function parseLocalDateTime(value: string | null | undefined): Date | null {
  if (!value || typeof value !== 'string') return null
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/)
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

function getNowPlus15LocalInput(): string {
  return toLocalDatetimeInputValue(new Date(Date.now() + 15 * 60 * 1000))
}

function shouldResetScheduledValue(value: string | null | undefined): boolean {
  const dt = parseLocalDateTime(value)
  if (!dt) return true
  return dt.getTime() < Date.now() + 15 * 60 * 1000
}

function dogNamesStorageKey(profileId: string): string {
  return `regli_client_recent_dog_names_${profileId}`
}

function normalizeDogName(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

type AppRole = 'client' | 'walker' | 'admin'

interface ClientDashboardProps {
  profile: {
    id: string
    email: string | null
    full_name: string | null
    role: AppRole
  }
  onSignOut: () => Promise<void>
  showOnboardingWowToken?: number
}

interface UpcomingBookingItem {
  id: string
  dogName: string
  location: string
  scheduledFor: string | null
  startsInMin: number | null
  price: number | null
}

export default function ClientDashboard({
  profile,
  onSignOut,
  showOnboardingWowToken = 0,
}: ClientDashboardProps) {
  const clientName = profile.full_name || profile.email || 'Client'
  const flow = useClientFlow(profile.id, clientName)
  const photo = useProfilePhoto(profile.id)
  usePushNotifications(profile.id)

  const [burgerOpen, setBurgerOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [walkHistoryOpen, setWalkHistoryOpen] = useState(true)
  const [historyView, setHistoryView] = useState<'menu' | 'all'>('menu')
  const [showScheduleSheet, setShowScheduleSheet] = useState(false)
  const [showDogNameSheet, setShowDogNameSheet] = useState(false)
  const [recentDogNames, setRecentDogNames] = useState<string[]>([])
  const [dogNameDraft, setDogNameDraft] = useState('')
  const [showFirstBookingWow, setShowFirstBookingWow] = useState(false)
  const [resumeFirstBookingWowAfterCardSetup, setResumeFirstBookingWowAfterCardSetup] = useState(false)
  const [guidedBookingField, setGuidedBookingField] = useState<'dogName' | 'duration' | 'payment' | null>(null)
  const [shouldAnimateGuidedField, setShouldAnimateGuidedField] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const lastOnboardingWowTokenRef = useRef(0)

  useEffect(() => {
    const style = document.createElement('style')
    style.setAttribute('data-regli-client-overflow-guard', 'true')
    style.textContent = `
      html,
      body,
      #root {
        width: 100%;
        max-width: 100%;
        min-width: 0;
        margin: 0;
        overflow-x: hidden;
        background: #F8FAFC;
      }

      body {
        position: relative;
      }

      #root {
        min-height: 100dvh;
      }

      .leaflet-container,
      .leaflet-pane,
      .leaflet-map-pane {
        max-width: 100%;
      }

      .regli-client-screen {
        width: 100%;
        max-width: 100%;
        overflow-x: hidden;
        box-sizing: border-box;
      }

      .regli-client-screen > * {
        max-width: 100%;
        box-sizing: border-box;
      }

      @keyframes regliGuidedFieldPulse {
        0% {
          opacity: 0.72;
          transform: translateY(4px) scale(0.992);
          box-shadow: 0 0 0 0 rgba(59, 130, 246, 0);
        }

        55% {
          opacity: 1;
          transform: translateY(0) scale(1);
          box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.12);
        }

        100% {
          opacity: 1;
          transform: translateY(0) scale(1);
          box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.12);
        }
      }
    `
    document.head.appendChild(style)

    const previousBodyOverflowX = document.body.style.overflowX
    const previousDocumentOverflowX = document.documentElement.style.overflowX
    document.body.style.overflowX = 'hidden'
    document.documentElement.style.overflowX = 'hidden'

    return () => {
      document.head.removeChild(style)
      document.body.style.overflowX = previousBodyOverflowX
      document.documentElement.style.overflowX = previousDocumentOverflowX
    }
  }, [])

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [flow.screenState, flow.bookingTiming])

  useEffect(() => {
    if (scrollRef.current && flow.completionJob) scrollRef.current.scrollTop = 0
  }, [flow.completionJob?.jobId])


  useEffect(() => {
    if (flow.bookingTiming === 'asap') {
      setShowScheduleSheet(false)
    }
  }, [flow.bookingTiming])

  useEffect(() => {
    if (!showScheduleSheet) return
    if (flow.bookingTiming !== 'scheduled') return
    if (shouldResetScheduledValue(flow.scheduledFor)) {
      flow.setScheduledFor(getNowPlus15LocalInput())
    }
  }, [flow.bookingTiming, flow.scheduledFor, flow.setScheduledFor, showScheduleSheet])

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(dogNamesStorageKey(profile.id))
      if (!raw) return
      const parsed = JSON.parse(raw) as string[]
      if (Array.isArray(parsed)) {
        setRecentDogNames(
          parsed
            .map((name) => normalizeDogName(String(name ?? '')))
            .filter(Boolean)
            .slice(0, 8),
        )
      }
    } catch {
      // noop
    }
  }, [profile.id])

  useEffect(() => {
    if (!showDogNameSheet) return
    setDogNameDraft(flow.dogName || '')
  }, [flow.dogName, showDogNameSheet])

  useEffect(() => {
    if (!showOnboardingWowToken || showOnboardingWowToken === lastOnboardingWowTokenRef.current) return
    lastOnboardingWowTokenRef.current = showOnboardingWowToken
    setResumeFirstBookingWowAfterCardSetup(false)
    setShowFirstBookingWow(true)
  }, [showOnboardingWowToken])

  useEffect(() => {
    if (!resumeFirstBookingWowAfterCardSetup) return
    if (flow.cardLoading || flow.setupClientSecret) return

    setResumeFirstBookingWowAfterCardSetup(false)
    if (flow.savedCard) {
      scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }, [flow.cardLoading, flow.savedCard, flow.setupClientSecret, resumeFirstBookingWowAfterCardSetup])

  const [serviceClockNow, setServiceClockNow] = useState(() => Date.now())

  useEffect(() => {
    const activeService =
      (flow.screenState === 'tracking' || flow.screenState === 'active') &&
      !!flow.activeJob?.service_started_at &&
      !flow.activeJob?.service_completed_at

    if (!activeService) return

    const id = window.setInterval(() => {
      setServiceClockNow(Date.now())
    }, 1000)

    return () => window.clearInterval(id)
  }, [
    flow.activeJob?.id,
    flow.activeJob?.service_started_at,
    flow.activeJob?.service_completed_at,
    flow.screenState,
  ])

  const handleSignOut = useCallback(async () => {
    try {
      await onSignOut()
    } catch {
      window.location.reload()
    }
  }, [onSignOut])

  const handleFindWalker = useCallback(() => {
    if (!flow.dogName.trim() || !flow.location.trim() || !flow.duration || !flow.savedCard) return
    flow.requestWalk()
  }, [flow.dogName, flow.duration, flow.location, flow.savedCard, flow.requestWalk])

  const handleFirstBookingAddPayment = useCallback(() => {
    setShowFirstBookingWow(false)
    setResumeFirstBookingWowAfterCardSetup(true)
    flow.requestCardSetup()
  }, [flow.requestCardSetup])

  const persistRecentDogNames = useCallback(
    (names: string[]) => {
      setRecentDogNames(names)
      try {
        window.localStorage.setItem(dogNamesStorageKey(profile.id), JSON.stringify(names))
      } catch {
        // noop
      }
    },
    [profile.id],
  )

  const commitDogName = useCallback(
    (rawValue: string) => {
      const nextName = normalizeDogName(rawValue)
      flow.setDogName(nextName)
      if (!nextName) return
      const nextNames = [nextName, ...recentDogNames.filter((name) => name !== nextName)].slice(0, 8)
      persistRecentDogNames(nextNames)
    },
    [flow, persistRecentDogNames, recentDogNames],
  )

  const openDogNameSheet = useCallback(() => {
    setDogNameDraft(flow.dogName || '')
    setShowDogNameSheet(true)
  }, [flow.dogName])

  const closeDogNameSheet = useCallback(() => {
    setShowDogNameSheet(false)
  }, [])

  const submitDogNameSheet = useCallback(() => {
    commitDogName(dogNameDraft)
    setShowDogNameSheet(false)
  }, [commitDogName, dogNameDraft])

  const handleFirstBookingStart = useCallback(() => {
    setShowFirstBookingWow(false)
    setResumeFirstBookingWowAfterCardSetup(false)
    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }, [])

  const upcomingScheduledItems = useMemo<UpcomingBookingItem[]>(
    () =>
      flow.upcomingJobs.map((j) => ({
        id: j.id,
        dogName: j.dog_name || 'Walk',
        location: formatShortAddress(j.address || j.location),
        scheduledFor: j.scheduled_for,
        startsInMin: flow.startsInMinutes(j.scheduled_for),
        price: j.scheduled_fee_snapshot ?? j.price,
      })),
    [flow.upcomingJobs, flow.startsInMinutes],
  )

  const anyFlow = flow as typeof flow & {
    completedJobs?: Array<Record<string, unknown>>
    recentActivity?: Array<Record<string, unknown>>
    recentJobs?: Array<Record<string, unknown>>
    requests?: Array<Record<string, unknown>>
    ratings?: Array<Record<string, unknown>>
    ratingsReceived?: Array<Record<string, unknown>>
    recentRatings?: Array<Record<string, unknown>>
    recentRatingsReceived?: Array<Record<string, unknown>>
    setDogName?: (value: string) => void
    setLocation?: (value: string) => void
    setDuration?: (value: DurationType | null) => void
    setBookingTiming?: (value: 'asap' | 'scheduled') => void
    hideHistoryItem?: (id: string) => Promise<void>
  }

  const ratingsSource = (anyFlow.recentRatingsReceived ??
    anyFlow.ratingsReceived ??
    []) as Array<Record<string, unknown>>

  const ratingByJobId = useMemo(() => {
    const map = new Map<string, { rating: number | null; review: string | null }>()

    ratingsSource.forEach((r) => {
      const jobId =
        typeof r.job_id === 'string'
          ? r.job_id
          : typeof r.jobId === 'string'
            ? r.jobId
            : null

      if (!jobId) return

      const ratingRaw =
        typeof r.rating === 'number'
          ? r.rating
          : typeof r.stars === 'number'
            ? r.stars
            : null

      const review =
        typeof r.review === 'string'
          ? r.review
          : typeof r.comment === 'string'
            ? r.comment
            : typeof r.reviewText === 'string'
              ? r.reviewText
              : null

      map.set(jobId, {
        rating: ratingRaw == null ? null : Math.max(1, Math.min(5, Math.round(ratingRaw))),
        review,
      })
    })

    return map
  }, [ratingsSource])

  const allHistoryItems = useMemo<HistoryItem[]>(() => {
    const source = (
      anyFlow.completedJobs ??
      anyFlow.recentActivity ??
      anyFlow.recentJobs ??
      anyFlow.requests ??
      []
    ) as Array<Record<string, unknown>>

    return source
      .map((item, index) => {
        const itemId = typeof item.id === 'string' ? item.id : `history-${index}`

        const walkerName =
          typeof item.walker_name === 'string'
            ? item.walker_name
            : typeof item.walkerName === 'string'
              ? item.walkerName
              : typeof item.walker_id === 'string'
                ? flow.walkerNameById.get(item.walker_id) || 'Walker'
                : 'Walker'

        const dogName =
          typeof item.dog_name === 'string'
            ? item.dog_name
            : typeof item.dogName === 'string'
              ? item.dogName
              : 'Walk'

        const location =
          typeof item.location === 'string'
            ? item.location
            : typeof item.address === 'string'
              ? item.address
              : null

        const createdAt =
          typeof item.completed_at === 'string'
            ? item.completed_at
            : typeof item.created_at === 'string'
              ? item.created_at
              : typeof item.updated_at === 'string'
                ? item.updated_at
                : null

        const durationMinutes =
          typeof item.duration_minutes === 'number'
            ? item.duration_minutes
            : typeof item.durationMinutes === 'number'
              ? item.durationMinutes
              : typeof item.duration === 'number'
                ? item.duration
                : null

        const price =
          typeof item.price === 'number'
            ? item.price
            : typeof item.scheduled_fee_snapshot === 'number'
              ? item.scheduled_fee_snapshot
              : null
        const tipAmount = typeof item.tip_amount === 'number' ? item.tip_amount : null

        const ratingInfo = ratingByJobId.get(itemId)

        return {
          id: itemId,
          status:
            typeof item.status === 'string'
              ? item.status
              : typeof item.state === 'string'
                ? item.state
                : 'completed',
          dog_name: dogName,
          address: formatShortAddress(location),
          created_at: createdAt,
          completed_at: createdAt,
          duration_minutes: durationMinutes,
          tip_amount: tipAmount,
          price,
          walker_id: typeof item.walker_id === 'string' ? item.walker_id : null,
          walker_name: walkerName,
          hidden_by_client: item.hidden_by_client === true,
          review: ratingInfo?.review ?? null,
          rating: ratingInfo?.rating ?? null,
          client_lat: typeof item.client_lat === 'number' ? item.client_lat : null,
          client_lng: typeof item.client_lng === 'number' ? item.client_lng : null,
          lat: typeof item.lat === 'number' ? item.lat : null,
          lng: typeof item.lng === 'number' ? item.lng : null,
          latitude: typeof item.latitude === 'number' ? item.latitude : null,
          longitude: typeof item.longitude === 'number' ? item.longitude : null,
        }
      })
  }, [
    anyFlow.completedJobs,
    anyFlow.recentActivity,
    anyFlow.recentJobs,
    anyFlow.requests,
    flow.walkerNameById,
    ratingByJobId,
  ])

  const visibleHistoryItems = useMemo(
    () => allHistoryItems.filter((item) => item.hidden_by_client !== true).slice(0, 7),
    [allHistoryItems],
  )

  const hasCompletionPrompt = !!flow.completionJob
  const preferredWalkers = flow.favoriteWalkers
  const favoriteIndicatorLabel =
    preferredWalkers.length === 1
      ? `Favorite walker: ${
          preferredWalkers[0]?.walker?.full_name ||
          preferredWalkers[0]?.walker?.email ||
          flow.walkerNameById.get(preferredWalkers[0]?.walker_id ?? '') ||
          'Walker'
        }`
      : `Favorite walkers (${preferredWalkers.length})`
  const isSearching = flow.screenState === 'searching'
  const isTrackingState = flow.screenState === 'tracking' || flow.screenState === 'active'
  const trackingLabels = getServiceLabels(flow.activeJob?.service_type)
  const isIdleState = flow.screenState === 'idle' && !hasCompletionPrompt
  const shouldShowFirstBookingWow =
    showFirstBookingWow && isIdleState && !flow.completionJob && !flow.tipJob
  const hasSavedPaymentMethod = !!flow.savedCard
  const hasPreviousBookingActivity =
    allHistoryItems.length > 0 ||
    upcomingScheduledItems.length > 0 ||
    !!flow.currentJob ||
    !!flow.activeJob ||
    !!flow.completionJob ||
    !!flow.tipJob
  const shouldUseSteplessGuidance = !hasPreviousBookingActivity && isIdleState && !showFirstBookingWow
  const nextGuidedBookingField: 'dogName' | 'duration' | 'payment' | null = !shouldUseSteplessGuidance
    ? null
    : !flow.dogName.trim()
      ? 'dogName'
      : !flow.duration
        ? 'duration'
        : !flow.savedCard
          ? 'payment'
          : null
  const isDogNameGuided = guidedBookingField === 'dogName'
  const isDurationGuided = guidedBookingField === 'duration'
  const isPaymentGuided = guidedBookingField === 'payment'
  const shouldShowGuidanceCtaHelper = guidedBookingField !== null && !flow.loading && !flow.cardLoading
  const showBanners =
    flow.screenState === 'idle' ||
    flow.screenState === 'searching' ||
    flow.screenState === 'tracking' ||
    flow.screenState === 'active'
  const showNearbyWalkers = flow.screenState === 'idle' || flow.screenState === 'searching'

  useEffect(() => {
    setGuidedBookingField((current) => (current === nextGuidedBookingField ? current : nextGuidedBookingField))
  }, [nextGuidedBookingField])

  useEffect(() => {
    if (!guidedBookingField) {
      setShouldAnimateGuidedField(false)
      return
    }

    setShouldAnimateGuidedField(true)
    const timeoutId = window.setTimeout(() => {
      setShouldAnimateGuidedField(false)
    }, 1400)

    return () => window.clearTimeout(timeoutId)
  }, [guidedBookingField])

  const nearbyWalkers = useNearbyWalkers(
    flow.hasUserLocation ? flow.userLocation : null,
    flow.hasUserLocation && showNearbyWalkers,
  )

  const mapUserLocation: [number, number] =
    flow.userLocation ?? flow.walkerLocation ?? ([32.0853, 34.7818] as [number, number])

  const trackingGpsQuality: GpsQuality =
    flow.gpsQuality === 'last_known' ? 'delayed' : flow.gpsQuality

  const requestDurationLabel = formatDurationLabelFromMinutes(flow.currentJob?.duration_minutes) ||
    flow.selectedDuration.label ||
    'Walk'
  const requestPriceLabel =
    flow.currentJob?.price != null && flow.currentJob.price > 0
      ? `₪${flow.currentJob.price}`
      : flow.adjustedPriceILS > 0
        ? `₪${flow.adjustedPriceILS}`
        : '₪0'
  const trackingDurationSummary = useMemo(
    () =>
      getDurationSummary({
        plannedMinutes: flow.activeJob?.duration_minutes ?? null,
        startedAt: flow.activeJob?.service_started_at ?? null,
        completedAt: flow.activeJob?.service_completed_at ?? null,
        now: serviceClockNow,
      }),
    [
      flow.activeJob?.duration_minutes,
      flow.activeJob?.service_started_at,
      flow.activeJob?.service_completed_at,
      serviceClockNow,
    ],
  )
  const completionJobDetails = useMemo(
    () =>
      flow.completionJob
        ? flow.completedJobs.find((job) => job.id === flow.completionJob?.jobId) ?? null
        : null,
    [flow.completedJobs, flow.completionJob],
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

  const closeAll = useCallback(() => {
    setBurgerOpen(false)
    setProfileOpen(false)
    setHistoryView('menu')
  }, [])

  const handleBookAgain = useCallback(
    (item: HistoryItem) => {
      if (typeof anyFlow.setBookingTiming === 'function') {
        anyFlow.setBookingTiming('asap')
      }

      const dogName =
        typeof item.dog_name === 'string'
          ? item.dog_name
          : typeof item.dogName === 'string'
            ? item.dogName
            : null

      const location =
        typeof item.address === 'string'
          ? item.address
          : typeof item.location === 'string'
            ? item.location
            : null

      const durationValueRaw =
        typeof item.duration_minutes === 'number'
          ? item.duration_minutes
          : typeof item.durationMinutes === 'number'
            ? item.durationMinutes
            : null

      if (typeof anyFlow.setDogName === 'function' && dogName) {
        anyFlow.setDogName(dogName)
      }

      if (typeof anyFlow.setLocation === 'function' && location) {
        anyFlow.setLocation(formatShortAddress(location))
      }

      if (
        typeof anyFlow.setDuration === 'function' &&
        (durationValueRaw === 20 || durationValueRaw === 40 || durationValueRaw === 60)
      ) {
        anyFlow.setDuration(durationValueRaw as unknown as DurationType)
      }

      setBurgerOpen(false)
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
      })
    },
    [anyFlow],
  )

  const openScheduleSheet = useCallback(() => {
    flow.setBookingTiming('scheduled')
    if (shouldResetScheduledValue(flow.scheduledFor)) {
      flow.setScheduledFor(getNowPlus15LocalInput())
    }
    setShowScheduleSheet(true)
  }, [flow])

  const clearScheduleToAsap = useCallback(() => {
    flow.setBookingTiming('asap')
    setShowScheduleSheet(false)
  }, [flow])

  const openFavoritesMenu = useCallback(() => {
    setProfileOpen(false)
    setHistoryView('menu')
    setBurgerOpen(true)
    requestAnimationFrame(() => {
      document.getElementById('client-favorites-section')?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      })
    })
  }, [])

  const currentMapStyle: React.CSSProperties = isTrackingState
    ? trackingMapContainerStyle
    : isSearching
      ? searchingMapContainerStyle
      : idleMapContainerStyle

  const currentSheetScrollStyle: React.CSSProperties = isIdleState
    ? idleSheetScrollStyle
    : sheetScrollStyle

  return (
    <div className="regli-client-screen" style={screenStyle}>
      <div style={topUiLayerStyle}>
        <div style={floatingTopBarStyle}>
          <button
            type="button"
            onClick={() => {
              setProfileOpen(false)
              setHistoryView('menu')
              setBurgerOpen((v) => !v)
            }}
            style={controlBtnStyle}
            aria-label="Menu"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#0F172A"
              strokeWidth="2.2"
              strokeLinecap="round"
            >
              <line x1="4" y1="7" x2="20" y2="7" />
              <line x1="4" y1="12" x2="20" y2="12" />
              <line x1="4" y1="17" x2="20" y2="17" />
            </svg>
          </button>

          <div style={topRightGroupStyle}>
            <div style={bellWrapStyle}>
              <NotificationsBell />
            </div>
          </div>
        </div>

        {showBanners && (flow.error || flow.successMessage || flow.availabilityNotice) && (
          <div style={floatingMessagesStyle}>
            {flow.availabilityNotice && (
              <MessageBanner
                text={flow.availabilityNotice.title}
                title={flow.availabilityNotice.title}
                subtitle={flow.availabilityNotice.subtitle}
                kind="info"
                onDismiss={flow.clearAvailabilityNotice}
                icon={
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="7" />
                    <line x1="16.65" y1="16.65" x2="21" y2="21" />
                  </svg>
                }
              />
            )}
            {flow.error && (
              <MessageBanner text={flow.error} kind="error" onDismiss={flow.clearError} />
            )}
            {flow.successMessage && (
              <MessageBanner
                text={flow.successMessage}
                kind="success"
                onDismiss={flow.clearSuccess}
              />
            )}
          </div>
        )}
      </div>

      <div style={{ ...mapContainerBaseStyle, ...currentMapStyle }}>
        <MapView
          userLocation={mapUserLocation}
          showUserMarker={true}
          isSearching={isSearching}
          nearbyWalkers={showNearbyWalkers ? nearbyWalkers : []}
          {...(isTrackingState && flow.walkerLocation
            ? {
                walkerLocation: flow.walkerLocation,
                walkerBearing: flow.walkerBearing,
                isArrived: flow.isArrived,
                gpsQuality: trackingGpsQuality,
                proximityLevel: flow.proximityLevel,
                routePolyline: flow.routePolyline ?? undefined,
              }
            : {})}
        />
      </div>

      {burgerOpen && (
        <>
          <div style={menuOverlayStyle} onClick={closeAll} />
          <div style={menuPanelStyle}>
            <div style={menuHeaderRowStyle}>
              <div style={menuHeaderLeftStyle}>
                <button
                  type="button"
                  onClick={() => {
                    if (historyView === 'all') {
                      setHistoryView('menu')
                    } else {
                      closeAll()
                    }
                  }}
                  style={menuBackButtonStyle}
                  aria-label={historyView === 'all' ? 'Back' : 'Close'}
                >
                  {historyView === 'all' ? '‹' : '☰'}
                </button>
                <span style={menuTitleStyle}>{historyView === 'all' ? 'All history' : 'Menu'}</span>
              </div>
            </div>

            <div style={menuScrollAreaStyle}>
              {historyView === 'all' ? (
                <BurgerSection title="All history" subtitle="Your previous orders and reviews.">
                  <GroupedHistory
                    items={allHistoryItems}
                    role="client"
                    compact
                    onBookAgain={handleBookAgain}
                    onHide={anyFlow.hideHistoryItem}
                    favoriteWalkerIds={flow.favoriteWalkerIds}
                    onToggleFavoriteWalker={flow.toggleFavoriteWalker}
                    emptyTitle="No walk history yet"
                    emptySubtitle="Your completed walks and reviews will appear here."
                  />
                </BurgerSection>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setBurgerOpen(false)
                      setProfileOpen(true)
                    }}
                    style={menuProfileButtonStyle}
                  >
                    <div style={{ position: 'relative', flexShrink: 0 }}>
                      <ProfileAvatar url={photo.avatarUrl} name={clientName} size={48} borderRadius={16} />
                    </div>
                    <div style={menuProfileTextStyle}>
                      <div style={profileNameStyle}>{clientName}</div>
                      {profile.email && <div style={profileEmailStyle}>{profile.email}</div>}
                      {flow.avgRating !== null && (
                        <div style={profileRatingStyle}>
                          <span style={{ color: '#F59E0B' }}>★</span> {flow.avgRating} · review score
                        </div>
                      )}
                    </div>
                    <div style={menuProfileChevronStyle}>›</div>
                  </button>

                  <BurgerSection
                    title="Future orders"
                    subtitle="Scheduled walks waiting to be dispatched."
                  >
                    <BurgerUpcomingList
                      items={upcomingScheduledItems}
                      onCancel={flow.cancelScheduledJob}
                    />
                  </BurgerSection>

                  <BurgerSection
                    id="client-favorites-section"
                    title="Preferred walkers"
                    subtitle="Saved walkers for quick reference."
                  >
                    <FavoriteWalkerMenuList
                      favorites={flow.favoriteWalkers}
                      fallbackNames={flow.walkerNameById}
                      onToggleFavorite={flow.toggleFavoriteWalker}
                    />
                  </BurgerSection>

                  <section style={burgerSectionStyle}>
                    <button
                      type="button"
                      onClick={() => setWalkHistoryOpen((v) => !v)}
                      style={accordionButtonStyle}
                    >
                      <div>
                        <div style={burgerSectionTitleStyle}>Walk history</div>
                        <div style={burgerSectionSubtitleStyle}>Recent completed orders.</div>
                      </div>
                      <div style={accordionChevronStyle}>{walkHistoryOpen ? '−' : '+'}</div>
                    </button>

                    {walkHistoryOpen && (
                      <div style={{ marginTop: 10 }}>
                        <GroupedHistory
                          items={visibleHistoryItems}
                          role="client"
                          compact
                          onBookAgain={handleBookAgain}
                          onHide={anyFlow.hideHistoryItem}
                          favoriteWalkerIds={flow.favoriteWalkerIds}
                          onToggleFavoriteWalker={flow.toggleFavoriteWalker}
                          emptyTitle="No walk history yet"
                          emptySubtitle="Your completed walks and reviews will appear here."
                        />
                        {allHistoryItems.length > 7 && (
                          <div style={{ marginTop: 10, textAlign: 'center' }}>
                            <button
                              type="button"
                              onClick={() => setHistoryView('all')}
                              style={viewAllButtonStyle}
                            >
                              View all
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </section>
                </>
              )}
            </div>

            <div style={menuDividerStyle} />

            <button
              type="button"
              onClick={() => {
                closeAll()
                void handleSignOut()
              }}
              style={menuActionStyle}
            >
              Sign out
            </button>
          </div>
        </>
      )}

      {profileOpen && (
        <>
          <div style={menuOverlayStyle} onClick={closeAll} />
          <div style={profilePanelStyle}>
            <div style={profileSectionStyle}>
              <div style={{ position: 'relative' }}>
                <ProfileAvatar
                  url={photo.avatarUrl}
                  name={clientName}
                  size={56}
                  borderRadius={18}
                  onClick={() => fileInputRef.current?.click()}
                />
                <div style={cameraIconStyle}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="#FFFFFF">
                    <path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z" />
                    <path d="M9 2 7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2h-3.17L15 2H9z" />
                  </svg>
                </div>
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

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={profileNameStyle}>{clientName}</div>
                {profile.email && <div style={profileEmailStyle}>{profile.email}</div>}
                {flow.avgRating !== null && (
                  <div style={profileRatingStyle}>
                    <span style={{ color: '#F59E0B' }}>★</span> {flow.avgRating} · review score
                  </div>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      <div style={sheetStyle}>
        <div style={sheetHandleStyle} />

        <div ref={scrollRef} style={currentSheetScrollStyle}>
          {isIdleState && (
            <div style={idleSheetContentStyle}>
              <div style={bookingCardStyle}>
                <div style={sheetHeaderRowStyle}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <span style={sheetGreetingStyle}>Hi, {clientName.split(' ')[0]}</span>
                  </div>
                </div>

                <div style={compactFormGridStyle}>
                  <div style={compactFieldStyle}>
                    <button
                      type="button"
                      onClick={openDogNameSheet}
                      style={{
                        ...dogInputButtonStyle,
                        ...(isDogNameGuided ? guidedFieldButtonStyle : null),
                        ...(isDogNameGuided && shouldAnimateGuidedField ? guidedFieldAnimationStyle : null),
                      }}
                    >
                      <div
                        style={{
                          ...dogInputShellStyle,
                          ...(isDogNameGuided ? guidedFieldShellStyle : null),
                        }}
                      >
                        <div style={dogThumbStyle}>🐶</div>
                        <div style={dogInputButtonContentStyle}>
                          <div
                            style={
                              flow.dogName.trim()
                                ? dogInputValueTextStyle
                                : dogInputPlaceholderTextStyle
                            }
                          >
                            {flow.dogName.trim() || "Dog's name"}
                          </div>
                        </div>
                        <div style={dogInputChevronStyle}>›</div>
                      </div>
                    </button>
                    {isDogNameGuided && (
                      <div style={guidedFieldHelperStyle}>Start here</div>
                    )}
                  </div>

                  {preferredWalkers.length > 0 && (
                    <button
                      type="button"
                      onClick={openFavoritesMenu}
                      style={preferredWalkerIndicatorStyle}
                    >
                      {preferredWalkers.length === 1 && (
                        <ProfileAvatar
                          url={preferredWalkers[0]?.walker?.avatar_url ?? null}
                          name={favoriteIndicatorLabel}
                          size={18}
                          borderRadius={999}
                        />
                      )}
                      <span>♥</span>
                      <span style={preferredWalkerIndicatorTextStyle}>{favoriteIndicatorLabel}</span>
                    </button>
                  )}

                  <div style={compactFieldStyle}>
                    <div style={compactFieldLabelStyle}>Pickup</div>
                    <input
                      value={flow.location}
                      onChange={(e) => flow.setLocation(e.target.value)}
                      placeholder={
                        flow.locationLoading ? 'Finding your location...' : 'Pickup location'
                      }
                      style={inputStyle}
                    />
                  </div>

                  <div style={compactFieldStyle}>
                    <div style={scheduledHeaderRowStyle}>
                      <label style={scheduledLabelStyle}>BOOK</label>
                      {flow.bookingTiming === 'scheduled' ? (
                        <div style={scheduledActionsStyle}>
                          <button
                            type="button"
                            onClick={clearScheduleToAsap}
                            style={scheduledAsapBtnStyle}
                          >
                            BOOK NOW
                          </button>
                          <button
                            type="button"
                            onClick={openScheduleSheet}
                            style={scheduledEditBtnStyle}
                          >
                            Edit
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={openScheduleSheet}
                          style={scheduledEditBtnStyle}
                        >
                          Schedule
                        </button>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={openScheduleSheet}
                      style={{
                        ...scheduledSummaryCardStyle,
                        ...(flow.bookingTiming === 'scheduled'
                          ? scheduledSummaryCardActiveStyle
                          : null),
                      }}
                    >
                      <div style={scheduledSummaryMainStyle}>
                        {flow.bookingTiming === 'scheduled'
                          ? formatScheduledDate(flow.scheduledFor)
                          : 'NOW'}
                      </div>
                      <div style={scheduledSummarySubStyle}>
                        {flow.bookingTiming === 'scheduled'
                          ? 'Dispatch starts automatically about 15 min before the walk.'
                          : 'We’ll start finding a walker right away.'}
                      </div>
                    </button>
                  </div>

                  <div style={compactFieldStyle}>
                    {isDurationGuided && (
                      <div style={guidedFieldHintAboveStyle}>Choose a duration</div>
                    )}
                    <div
                      style={{
                        ...compactDurationWrapStyle,
                        ...(isDurationGuided ? durationGuidedFieldShellStyle : null),
                        ...(isDurationGuided && shouldAnimateGuidedField ? guidedFieldAnimationStyle : null),
                      }}
                    >
                      <DurationPicker
                        options={DURATION_OPTIONS}
                        selected={flow.duration ?? ''}
                        onSelect={(v) => flow.setDuration(v as DurationType)}
                        surgeMultiplier={flow.surgeMultiplier}
                        surgeLevel={flow.surgeLevel}
                      />
                    </div>
                  </div>

                  <div style={compactFieldStyle}>
                    {isPaymentGuided && (
                      <div style={guidedFieldHintAboveStyle}>Add payment method</div>
                    )}
                    <div
                      style={{
                        ...compactPaymentWrapStyle,
                        ...(isPaymentGuided ? paymentGuidedFieldShellStyle : null),
                        ...(isPaymentGuided && shouldAnimateGuidedField ? guidedFieldAnimationStyle : null),
                      }}
                    >
                      <CardSetupForm
                        savedCard={flow.savedCard}
                        setupClientSecret={flow.setupClientSecret}
                        loadingCard={flow.cardLoading}
                        loadError={flow.cardError}
                        onRequestSetup={flow.requestCardSetup}
                        onChangeCard={flow.changeCard}
                        onSetupComplete={flow.onCardSetupComplete}
                        onCancelSetup={flow.cancelCardSetup}
                        onRetry={flow.retryLoadCard}
                      />
                    </div>
                  </div>
                </div>

                <div style={feeLabelStyle}>
                  {flow.bookingTiming === 'scheduled'
                    ? 'Price locked now · payment visible · auto dispatch later'
                    : 'Service fee included · charged after walk'}
                </div>
              </div>
            </div>
          )}

          {isSearching && (
            <div style={sheetContentStyle}>
              <SearchingSheet
                elapsedSeconds={flow.elapsedSeconds}
                durationLabel={requestDurationLabel}
                priceLabel={requestPriceLabel}
                onCancel={flow.cancelSearch}
              />
            </div>
          )}

          {(flow.screenState === 'tracking' || flow.screenState === 'active') && flow.activeJob && (
            <div style={sheetContentStyle}>
              <TrackingCard
                walkerName={
                  flow.activeJob.walker_id
                    ? flow.walkerNameById.get(flow.activeJob.walker_id) || 'Walker'
                    : 'Walker'
                }
                dogName={flow.activeJob.dog_name}
                phase={
                  flow.screenPhase === 'in_progress' ||
                  flow.screenPhase === 'arrival_confirmed' ||
                  flow.screenPhase === 'arrived_pending_confirmation'
                    ? flow.screenPhase
                    : 'on_the_way'
                }
                isArrived={flow.isArrived}
                etaMinutes={flow.etaMinutes}
                displayEtaSeconds={flow.displayEtaSeconds}
                distanceMeters={flow.distanceMeters}
                gpsQuality={trackingGpsQuality}
                startActionLabel={trackingLabels.startAction}
                activeTitle={trackingLabels.activeTitle}
                onConfirmArrival={flow.screenPhase === 'arrived_pending_confirmation' ? flow.confirmArrival : undefined}
                confirmingArrival={flow.arrivalConfirming}
                elapsedLabel={trackingDurationSummary.elapsedLabel}
                plannedLabel={trackingDurationSummary.plannedLabel}
                actualLabel={trackingDurationSummary.actualLabel}
              />
            </div>
          )}

        </div>

        {isIdleState && (
          <div style={stickyCtaWrapStyle}>
            {shouldShowGuidanceCtaHelper && (
              <div style={guidedCtaHelperStyle}>Complete the highlighted field to continue</div>
            )}
            <div style={stickyMainActionStyle}>
              <ActionButton
                label={
                  flow.loading
                    ? flow.bookingTiming === 'scheduled'
                      ? 'Scheduling...'
                      : 'Requesting...'
                    : flow.cardLoading
                      ? 'Loading payment...'
                      : !flow.savedCard
                        ? 'Add a card'
                        : flow.bookingTiming === 'scheduled'
                          ? 'Schedule walk'
                          : 'Find nearby providers'
                }
                onClick={handleFindWalker}
                loading={flow.loading || flow.cardLoading}
                disabled={
                  !flow.dogName.trim() ||
                  !flow.location.trim() ||
                  !flow.duration ||
                  !flow.savedCard ||
                  (flow.bookingTiming === 'scheduled' && !flow.scheduledFor)
                }
              />
            </div>
          </div>
        )}
      </div>

      {hasCompletionPrompt && flow.completionJob && (
        <div style={completionOverlayStyle}>
          <div style={completionOverlayBackdropStyle} />
          <div style={completionOverlayCardStyle}>
            <CompletionCard
              promptKey={flow.completionJob.jobId}
              title={getServiceLabels(null).completedTitle}
              subtitle={`Rate ${flow.completionJob.walkerName}`}
              metaRows={completionMetaRows}
              onRate={flow.submitCompletionRating}
              ratingSubmitting={flow.completionRatingSubmitting}
              alreadyRated={flow.ratedJobIds.has(flow.completionJob.jobId)}
              favoriteLabel={flow.completionJob.walkerName}
              favoriteActive={
                flow.completionJob.walkerId
                  ? flow.favoriteWalkerIds.has(flow.completionJob.walkerId)
                  : false
              }
              onToggleFavorite={
                flow.completionJob.walkerId
                  ? () => {
                      void flow.toggleFavoriteWalker(flow.completionJob!.walkerId!)
                    }
                  : undefined
              }
              onDismiss={flow.dismissCompletion}
            />
          </div>
        </div>
      )}

      {!hasCompletionPrompt && flow.tipJob && (
        <div style={completionOverlayStyle}>
          <div style={completionOverlayBackdropStyle} />
          <div style={completionOverlayCardStyle}>
            <TipPromptCard
              walkerName={flow.tipJob.walkerName}
              submitting={flow.tipSubmitting}
              onSubmit={flow.submitTip}
              onDismiss={flow.dismissTip}
            />
          </div>
        </div>
      )}

      {shouldShowFirstBookingWow && (
        <div style={firstBookingWowOverlayStyle}>
          <div style={firstBookingWowCardStyle}>
            <div
              style={{
                ...firstBookingWowBadgeStyle,
                background: flow.cardLoading
                  ? 'rgba(148, 163, 184, 0.16)'
                  : hasSavedPaymentMethod
                    ? 'rgba(91, 124, 250, 0.10)'
                    : 'rgba(245, 158, 11, 0.12)',
              }}
            >
              {flow.cardLoading ? '…' : hasSavedPaymentMethod ? '✨' : '💳'}
            </div>

            <div style={firstBookingWowTitleStyle}>
              {flow.cardLoading
                ? 'Checking your payment setup'
                : hasSavedPaymentMethod
                  ? 'You’re ready to book'
                  : 'You’re almost ready'}
            </div>

            <div style={firstBookingWowBodyStyle}>
              {flow.cardLoading
                ? 'This only takes a moment.'
                : hasSavedPaymentMethod
                  ? 'Add the service details and we’ll find a provider nearby.'
                  : 'Add a payment method before your first booking.'}
            </div>

            {!flow.cardLoading && !hasSavedPaymentMethod && (
              <div style={firstBookingWowHelperStyle}>
                You’ll only be charged after the service is completed.
              </div>
            )}

            <button
              type="button"
              onClick={hasSavedPaymentMethod ? handleFirstBookingStart : handleFirstBookingAddPayment}
              disabled={flow.cardLoading}
              style={{
                ...firstBookingWowButtonStyle,
                ...(flow.cardLoading ? firstBookingWowButtonDisabledStyle : null),
              }}
            >
              {flow.cardLoading
                ? 'Checking...'
                : hasSavedPaymentMethod
                  ? 'Start booking'
                  : 'Add payment method'}
            </button>
          </div>
        </div>
      )}

      {showDogNameSheet && (
        <>
          <div style={bottomSheetOverlayStyle} onClick={closeDogNameSheet} />
          <div style={dogNameSheetStyle}>
            <div style={bottomSheetHandleStyle} />
            <div style={dogNameSheetHeaderStyle}>
              <div style={dogNameSheetTitleStyle}>Dog name</div>
              <div style={dogNameSheetSubtitleStyle}>
                Pick a previous name quickly or type a new one.
              </div>
            </div>

            {!!recentDogNames.length && (
              <div style={dogNameSuggestionsWrapStyle}>
                {recentDogNames.map((name) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => {
                      setDogNameDraft(name)
                      commitDogName(name)
                      setShowDogNameSheet(false)
                    }}
                    style={dogNameChipStyle}
                  >
                    <span>🐶</span>
                    <span>{name}</span>
                  </button>
                ))}
              </div>
            )}

            <div style={dogNameInputCardStyle}>
              <div style={dogNameInputLabelStyle}>Add new</div>
              <input
                autoFocus
                value={dogNameDraft}
                onChange={(e) => setDogNameDraft(e.target.value)}
                placeholder="Type dog name"
                style={dogNameSheetInputStyle}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    submitDogNameSheet()
                  }
                }}
              />
            </div>

            <div style={dogNameSheetActionsStyle}>
              <button type="button" onClick={closeDogNameSheet} style={dogNameSecondaryBtnStyle}>
                Cancel
              </button>
              <button
                type="button"
                onClick={submitDogNameSheet}
                style={dogNamePrimaryBtnStyle}
                disabled={!normalizeDogName(dogNameDraft)}
              >
                Save
              </button>
            </div>
          </div>
        </>
      )}

      <IOSDateTimeSheet
        open={showScheduleSheet}
        value={flow.scheduledFor || getNowPlus15LocalInput()}
        minValue={getNowPlus15LocalInput()}
        title="Choose date & time"
        subtitle=""
        onChange={flow.setScheduledFor}
        onClose={() => setShowScheduleSheet(false)}
        onConfirm={(val) => {
          flow.setBookingTiming('scheduled')
          flow.setScheduledFor(val)
          setShowScheduleSheet(false)
        }}
        onBackToNow={() => {
          flow.setBookingTiming('asap')
          setShowScheduleSheet(false)
        }}
      />
    </div>
  )
}

const firstBookingWowOverlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 45,
  display: 'grid',
  placeItems: 'end center',
  padding:
    'calc(env(safe-area-inset-top, 0px) + 20px) 18px calc(env(safe-area-inset-bottom, 0px) + 24px)',
  background: 'linear-gradient(180deg, rgba(15,23,42,0.08) 0%, rgba(15,23,42,0.18) 100%)',
}

const firstBookingWowCardStyle: React.CSSProperties = {
  width: 'min(100%, 420px)',
  borderRadius: 28,
  background: 'rgba(255,255,255,0.96)',
  border: '1px solid rgba(255,255,255,0.72)',
  boxShadow: '0 24px 60px rgba(15, 23, 42, 0.18)',
  padding: 22,
  display: 'grid',
  gap: 12,
  boxSizing: 'border-box',
  fontFamily: 'Inter, system-ui, sans-serif',
}

const firstBookingWowBadgeStyle: React.CSSProperties = {
  width: 48,
  height: 48,
  borderRadius: 16,
  display: 'grid',
  placeItems: 'center',
  fontSize: 24,
}

const firstBookingWowTitleStyle: React.CSSProperties = {
  color: '#0F172A',
  fontSize: 28,
  lineHeight: 1.04,
  fontWeight: 900,
}

const firstBookingWowBodyStyle: React.CSSProperties = {
  color: '#5E6B83',
  fontSize: 14,
  lineHeight: 1.55,
}

const firstBookingWowHelperStyle: React.CSSProperties = {
  color: '#64748B',
  fontSize: 13,
  lineHeight: 1.5,
}

const firstBookingWowButtonStyle: React.CSSProperties = {
  appearance: 'none',
  border: 'none',
  minHeight: 54,
  borderRadius: 18,
  background: 'linear-gradient(180deg, #0F172A 0%, #233B74 100%)',
  color: '#FFFFFF',
  fontSize: 16,
  fontWeight: 800,
  cursor: 'pointer',
}

const firstBookingWowButtonDisabledStyle: React.CSSProperties = {
  opacity: 0.68,
  cursor: 'default',
}

function BurgerSection({
  id,
  title,
  subtitle,
  children,
}: {
  id?: string
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <section id={id} style={burgerSectionStyle}>
      <div style={burgerSectionHeaderStyle}>
        <div style={burgerSectionTitleStyle}>{title}</div>
      </div>
      {subtitle && <div style={burgerSectionSubtitleStyle}>{subtitle}</div>}
      <div style={{ marginTop: 10 }}>{children}</div>
    </section>
  )
}

function FavoriteWalkerMenuList({
  favorites,
  fallbackNames,
  onToggleFavorite,
}: {
  favorites: ReturnType<typeof useClientFlow>['favoriteWalkers']
  fallbackNames: Map<string, string>
  onToggleFavorite: (walkerId: string) => Promise<void>
}) {
  if (favorites.length === 0) {
    return <div style={burgerEmptyStateStyle}>No preferred walkers yet.</div>
  }

  return (
    <div style={favoriteMenuListStyle}>
      {favorites.map((favorite) => {
        const walkerName =
          favorite.walker?.full_name ||
          favorite.walker?.email ||
          fallbackNames.get(favorite.walker_id) ||
          'Walker'

        return (
          <div key={favorite.walker_id} style={favoriteMenuItemStyle}>
            <ProfileAvatar
              url={favorite.walker?.avatar_url ?? null}
              name={walkerName}
              size={34}
              borderRadius={12}
            />
            <div style={favoriteMenuTextStyle}>
              <div style={favoriteMenuNameStyle}>{walkerName}</div>
              <div style={favoriteMenuSubStyle}>Preferred walker</div>
            </div>
            <button
              type="button"
              onClick={() => {
                void onToggleFavorite(favorite.walker_id)
              }}
              style={favoriteMenuRemoveStyle}
            >
              Remove
            </button>
          </div>
        )
      })}
    </div>
  )
}

function TipPromptCard({
  walkerName,
  submitting,
  onSubmit,
  onDismiss,
}: {
  walkerName: string
  submitting: boolean
  onSubmit: (amount: number) => Promise<void>
  onDismiss: () => void
}) {
  const [customOpen, setCustomOpen] = useState(false)
  const [customAmount, setCustomAmount] = useState('')

  const parsedCustomAmount = Math.max(0, Math.round(Number(customAmount)))

  return (
    <div style={tipCardStyle}>
      <div style={tipIconStyle}>₪</div>
      <h3 style={tipTitleStyle}>Add a tip for {walkerName}?</h3>
      <p style={tipSubtitleStyle}>Optional, separate from the walk payment.</p>

      <div style={tipPresetRowStyle}>
        {[5, 10, 15].map((amount) => (
          <button
            key={amount}
            type="button"
            disabled={submitting}
            onClick={() => {
              void onSubmit(amount)
            }}
            style={tipPresetButtonStyle}
          >
            ₪{amount}
          </button>
        ))}
      </div>

      {customOpen ? (
        <div style={tipCustomRowStyle}>
          <input
            value={customAmount}
            onChange={(event) => setCustomAmount(event.target.value.replace(/[^\d]/g, ''))}
            inputMode="numeric"
            placeholder="Custom"
            style={tipCustomInputStyle}
          />
          <button
            type="button"
            disabled={submitting || parsedCustomAmount <= 0}
            onClick={() => {
              if (parsedCustomAmount > 0) void onSubmit(parsedCustomAmount)
            }}
            style={{
              ...tipCustomSubmitStyle,
              opacity: submitting || parsedCustomAmount <= 0 ? 0.55 : 1,
            }}
          >
            Send
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setCustomOpen(true)} style={tipCustomToggleStyle}>
          Custom amount
        </button>
      )}

      <button type="button" onClick={onDismiss} disabled={submitting} style={tipSkipButtonStyle}>
        No tip
      </button>
    </div>
  )
}

function BurgerUpcomingList({
  items,
  onCancel,
}: {
  items: UpcomingBookingItem[]
  onCancel?: (id: string) => void
}) {
  if (items.length === 0) {
    return <div style={burgerEmptyStateStyle}>No future orders.</div>
  }

  return (
    <div style={burgerListStyle}>
      {items.slice(0, 3).map((item) => (
        <div key={item.id} style={burgerListCardStyle}>
          <div style={burgerListCardHeaderStyle}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={burgerListTitleStyle}>{item.dogName}</div>
              <div style={burgerListSubtitleStyle}>{formatShortAddress(item.location) || 'Scheduled walk'}</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              {item.price != null && <div style={burgerListPriceStyle}>₪{item.price}</div>}
              {onCancel && (
                <button
                  type="button"
                  onClick={() => onCancel(item.id)}
                  style={clientUpcomingCancelBtnStyle}
                >
                  Cancel
                </button>
              )}
            </div>
          </div>
          <div style={burgerListMetaRowStyle}>
            <div style={burgerListMetaStyle}>{formatScheduledDate(item.scheduledFor)}</div>
            {item.startsInMin != null && item.startsInMin >= 0 && item.startsInMin <= 60 && (
              <div style={clientUpcomingBadgeStyle}>starts in {item.startsInMin} min</div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

function TrackingCard({
  walkerName,
  dogName,
  phase,
  isArrived,
  etaMinutes,
  displayEtaSeconds,
  distanceMeters,
  gpsQuality,
  startActionLabel,
  activeTitle,
  onConfirmArrival,
  confirmingArrival,
  elapsedLabel,
  plannedLabel,
  actualLabel,
}: {
  walkerName: string
  dogName: string | null
  phase: 'on_the_way' | 'arrived_pending_confirmation' | 'arrival_confirmed' | 'in_progress'
  isArrived: boolean
  etaMinutes: number | null
  displayEtaSeconds: number | null
  distanceMeters: number | null
  gpsQuality: GpsQuality
  startActionLabel: string
  activeTitle: string
  onConfirmArrival?: () => void
  confirmingArrival?: boolean
  elapsedLabel: string | null
  plannedLabel: string | null
  actualLabel: string | null
}) {
  const isServiceActive = phase === 'in_progress'
  const isArrivalPending = phase === 'arrived_pending_confirmation'
  const isArrivalConfirmed = phase === 'arrival_confirmed'
  const topBadge = isServiceActive ? activeTitle : isArrivalPending ? 'Provider arrived' : 'On the way'
  const title = isServiceActive ? activeTitle : isArrivalPending ? 'Provider has arrived' : 'On the way'
  const subtitle = isServiceActive
    ? dogName
      ? `${dogName} is currently in service`
      : 'Your service is in progress'
    : isArrivalPending
      ? 'Confirm the provider is with you before service starts'
      : isArrivalConfirmed
        ? `${walkerName} is ready to ${startActionLabel.toLowerCase()}`
        : `${walkerName} is heading to you`

  return (
    <div style={trackingCardStyle}>
      <div style={trackingTopBadgeStyle}>{topBadge}</div>
      <div style={trackingTitleStyle}>{title}</div>
      <div style={trackingSubtitleStyle}>{subtitle}</div>

      <div style={trackingStatsGridStyle}>
        <div style={trackingStatCardStyle}>
          <div style={trackingStatLabelStyle}>ETA</div>
          <div style={trackingStatValueStyle}>
            {formatEta(etaMinutes, displayEtaSeconds, isArrived || isArrivalPending || isArrivalConfirmed)}
          </div>
        </div>
        <div style={trackingStatCardStyle}>
          <div style={trackingStatLabelStyle}>Distance</div>
          <div style={trackingStatValueStyle}>
            {formatDistance(distanceMeters, isArrived || isArrivalPending || isArrivalConfirmed)}
          </div>
        </div>
        <div style={trackingStatCardStyle}>
          <div style={trackingStatLabelStyle}>GPS</div>
          <div style={trackingStatValueStyle}>{formatGpsQuality(gpsQuality)}</div>
        </div>
      </div>

      {(elapsedLabel || plannedLabel || actualLabel) && (
        <div style={trackingTimerPanelStyle}>
          {elapsedLabel && (
            <div style={trackingTimerPrimaryRowStyle}>
              <span style={trackingTimerLabelStyle}>Elapsed</span>
              <span style={trackingTimerValueStyle}>{elapsedLabel}</span>
            </div>
          )}
          {(plannedLabel || actualLabel) && (
            <div style={trackingTimerMetaRowStyle}>
              {plannedLabel && <span style={trackingTimerMetaStyle}>Planned: {plannedLabel}</span>}
              {actualLabel && <span style={trackingTimerMetaStyle}>Actual: {actualLabel}</span>}
            </div>
          )}
        </div>
      )}

      {isArrivalPending && onConfirmArrival && (
        <div style={{ marginTop: 16 }}>
          <ActionButton
            label={confirmingArrival ? 'Confirming...' : 'Confirm arrival'}
            onClick={onConfirmArrival}
            loading={!!confirmingArrival}
            disabled={!!confirmingArrival}
          />
        </div>
      )}
    </div>
  )
}

function parseDateTimeFlexible(value: string | null | undefined): Date | null {
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

function formatScheduledDate(value: string | null | undefined): string {
  const dt = parseDateTimeFlexible(value)
  if (!dt) return 'Scheduled walk'
  return dt.toLocaleString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function formatDurationLabelFromMinutes(minutes: number | null | undefined): string {
  if (minutes === 20 || minutes === 40 || minutes === 60) return `${minutes} min`
  return ''
}

function formatEta(
  etaMinutes: number | null,
  displayEtaSeconds: number | null,
  isArrived: boolean,
): string {
  if (isArrived) return 'Arrived'
  if (displayEtaSeconds != null && displayEtaSeconds >= 0 && displayEtaSeconds < 60) {
    return `${displayEtaSeconds}s`
  }
  if (etaMinutes != null && etaMinutes >= 0) return `${etaMinutes} min`
  return '—'
}

function formatDistance(distanceMeters: number | null, isArrived: boolean): string {
  if (isArrived) return 'Here'
  if (distanceMeters == null || Number.isNaN(distanceMeters)) return '—'
  if (distanceMeters < 1000) return `${Math.round(distanceMeters)} m`
  return `${(distanceMeters / 1000).toFixed(1)} km`
}

function formatGpsQuality(gpsQuality: GpsQuality): string {
  switch (gpsQuality) {
    case 'live':
      return 'Live'
    case 'delayed':
      return 'Delayed'
    case 'offline':
      return 'Offline'
    default:
      return 'Live'
  }
}

const screenStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  left: 0,
  right: 0,
  background: '#F8FAFC',
  overflow: 'hidden',
  overflowX: 'hidden',
  display: 'flex',
  flexDirection: 'column',
  isolation: 'isolate',
  width: '100%',
  minWidth: 0,
  maxWidth: '100%',
  maxInlineSize: '100dvw',
  boxSizing: 'border-box',
  contain: 'layout paint',
}

const topUiLayerStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  pointerEvents: 'none',
  zIndex: 5000,
  overflow: 'hidden',
  width: '100%',
  maxWidth: '100%',
  boxSizing: 'border-box',
}

const mapContainerBaseStyle: React.CSSProperties = {
  position: 'relative',
  flexShrink: 0,
  minHeight: 220,
  overflow: 'hidden',
  width: '100%',
  maxWidth: '100%',
  boxSizing: 'border-box',
}

const idleMapContainerStyle: React.CSSProperties = {
  height: '40dvh',
}

const searchingMapContainerStyle: React.CSSProperties = {
  height: '40dvh',
}

const trackingMapContainerStyle: React.CSSProperties = {
  height: '40dvh',
}

const floatingTopBarStyle: React.CSSProperties = {
  position: 'fixed',
  top: 'calc(16px + env(safe-area-inset-top))',
  left: 'max(14px, env(safe-area-inset-left, 0px))',
  right: 'max(14px, env(safe-area-inset-right, 0px))',
  zIndex: 3001,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  pointerEvents: 'none',
  boxSizing: 'border-box',
  maxWidth: 'none',
  minWidth: 0,
}

const controlBtnStyle: React.CSSProperties = {
  width: 44,
  height: 44,
  borderRadius: 16,
  border: '1px solid rgba(255,255,255,0.9)',
  background: 'rgba(255,255,255,0.96)',
  boxShadow: '0 8px 24px rgba(15, 23, 42, 0.18)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  pointerEvents: 'auto',
  backdropFilter: 'blur(10px)',
}

const topRightGroupStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  pointerEvents: 'auto',
}

const bellWrapStyle: React.CSSProperties = {
  width: 38,
  height: 38,
  display: 'grid',
  placeItems: 'center',
}

const floatingMessagesStyle: React.CSSProperties = {
  position: 'fixed',
  left: 'max(14px, env(safe-area-inset-left, 0px))',
  right: 'max(14px, env(safe-area-inset-right, 0px))',
  top: 'calc(74px + env(safe-area-inset-top))',
  zIndex: 3000,
  display: 'grid',
  gap: 8,
  pointerEvents: 'none',
  boxSizing: 'border-box',
  minWidth: 0,
  maxWidth: 'none',
}

const sheetStyle: React.CSSProperties = {
  position: 'relative',
  marginTop: -18,
  alignSelf: 'stretch',
  flex: 1,
  minHeight: 0,
  width: '100%',
  maxWidth: '100%',
  borderTopLeftRadius: 28,
  borderTopRightRadius: 28,
  background: '#FFFFFF',
  boxShadow: '0 -10px 30px rgba(15, 23, 42, 0.10)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  zIndex: 1,
  boxSizing: 'border-box',
  marginLeft: 0,
  marginRight: 0,
}

const sheetHandleStyle: React.CSSProperties = {
  width: 40,
  height: 4,
  borderRadius: 999,
  background: '#CBD5E1',
  margin: '8px auto 6px',
  flexShrink: 0,
}

const sheetScrollStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  overflowX: 'hidden',
  padding: '0 14px 12px',
  WebkitOverflowScrolling: 'touch',
  width: '100%',
  maxWidth: '100%',
  boxSizing: 'border-box',
}

const idleSheetScrollStyle: React.CSSProperties = {
  ...sheetScrollStyle,
  overflowY: 'auto',
  paddingBottom: 6,
}

const sheetContentStyle: React.CSSProperties = {
  paddingBottom: 12,
  width: '100%',
  maxWidth: '100%',
  boxSizing: 'border-box',
}

const idleSheetContentStyle: React.CSSProperties = {
  paddingBottom: 6,
}

const bookingCardStyle: React.CSSProperties = {
  display: 'grid',
  gap: 8,
}

const sheetHeaderRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 8,
}

const sheetGreetingStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  fontWeight: 700,
  color: '#94A3B8',
  marginBottom: 0,
}

const compactFormGridStyle: React.CSSProperties = {
  display: 'grid',
  gap: 8,
}

const preferredWalkerIndicatorStyle: React.CSSProperties = {
  justifySelf: 'flex-start',
  maxWidth: '100%',
  border: '1px solid #FDE68A',
  background: '#FFFBEB',
  color: '#92400E',
  borderRadius: 999,
  padding: '5px 9px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 12,
  fontWeight: 800,
  lineHeight: 1,
  cursor: 'pointer',
  fontFamily: 'inherit',
  WebkitTapHighlightColor: 'transparent',
  overflow: 'hidden',
}

const preferredWalkerIndicatorTextStyle: React.CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const compactFieldStyle: React.CSSProperties = {
  display: 'grid',
  gap: 3,
}

const guidedFieldButtonStyle: React.CSSProperties = {
  borderRadius: 18,
  transformOrigin: 'center top',
  willChange: 'transform, box-shadow, opacity',
}

const guidedFieldShellStyle: React.CSSProperties = {
  borderColor: '#60A5FA',
  boxShadow: '0 0 0 4px rgba(96, 165, 250, 0.18)',
  background: '#F8FBFF',
}

const guidedFieldHelperStyle: React.CSSProperties = {
  marginTop: 3,
  fontSize: 11,
  fontWeight: 700,
  color: '#2563EB',
  lineHeight: 1.35,
}

const guidedFieldHintAboveStyle: React.CSSProperties = {
  ...guidedFieldHelperStyle,
  marginTop: 0,
  marginBottom: 3,
}

const compactFieldLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  letterSpacing: 0.6,
  textTransform: 'uppercase',
  color: '#64748B',
}

const dogInputShellStyle: React.CSSProperties = {
  height: 45,
  borderRadius: 15,
  border: '1px solid #E2E8F0',
  background: '#FFFFFF',
  display: 'flex',
  alignItems: 'center',
  overflow: 'hidden',
}

const dogThumbStyle: React.CSSProperties = {
  width: 38,
  height: 38,
  borderRadius: 12,
  marginLeft: 4,
  marginRight: 2,
  background: 'linear-gradient(180deg, #FEF3C7 0%, #FDE68A 100%)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 18,
  flexShrink: 0,
}

const dogInputButtonStyle: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  padding: 0,
  textAlign: 'left',
  cursor: 'pointer',
}

const dogInputButtonContentStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  height: '100%',
}

const dogInputValueTextStyle: React.CSSProperties = {
  fontSize: 16,
  color: '#0F172A',
  fontWeight: 700,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const dogInputPlaceholderTextStyle: React.CSSProperties = {
  fontSize: 16,
  color: '#94A3B8',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const dogInputChevronStyle: React.CSSProperties = {
  paddingRight: 12,
  color: '#94A3B8',
  fontSize: 24,
  lineHeight: 1,
  flexShrink: 0,
}

const bottomSheetOverlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(15, 23, 42, 0.26)',
  zIndex: 120,
}

const dogNameSheetStyle: React.CSSProperties = {
  position: 'fixed',
  left: 'env(safe-area-inset-left, 0px)',
  right: 'env(safe-area-inset-right, 0px)',
  bottom: 0,
  zIndex: 121,
  borderTopLeftRadius: 28,
  borderTopRightRadius: 28,
  background: '#FFFFFF',
  boxShadow: '0 -16px 44px rgba(15, 23, 42, 0.20)',
  padding: '10px 16px calc(18px + env(safe-area-inset-bottom))',
  display: 'grid',
  gap: 14,
  boxSizing: 'border-box',
  maxWidth: '100%',
  overflowX: 'hidden',
}

const bottomSheetHandleStyle: React.CSSProperties = {
  width: 42,
  height: 4,
  borderRadius: 999,
  background: '#CBD5E1',
  margin: '0 auto 2px',
}

const dogNameSheetHeaderStyle: React.CSSProperties = {
  display: 'grid',
  gap: 4,
}

const dogNameSheetTitleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 900,
  color: '#0F172A',
}

const dogNameSheetSubtitleStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.45,
  color: '#64748B',
}

const dogNameSuggestionsWrapStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 10,
}

const dogNameChipStyle: React.CSSProperties = {
  height: 40,
  borderRadius: 999,
  border: '1px solid #DBEAFE',
  background: '#EFF6FF',
  color: '#1D4ED8',
  fontSize: 14,
  fontWeight: 800,
  padding: '0 14px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  cursor: 'pointer',
}

const dogNameInputCardStyle: React.CSSProperties = {
  borderRadius: 18,
  border: '1px solid #E2E8F0',
  background: '#FFFFFF',
  padding: 12,
  display: 'grid',
  gap: 8,
}

const dogNameInputLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 800,
  letterSpacing: 0.4,
  textTransform: 'uppercase',
  color: '#64748B',
}

const dogNameSheetInputStyle: React.CSSProperties = {
  width: '100%',
  height: 48,
  borderRadius: 14,
  border: '1px solid #E2E8F0',
  background: '#FFFFFF',
  outline: 'none',
  padding: '0 14px',
  fontSize: 17,
  color: '#0F172A',
  boxSizing: 'border-box',
}

const dogNameSheetActionsStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 10,
}

const dogNameSecondaryBtnStyle: React.CSSProperties = {
  height: 48,
  borderRadius: 16,
  border: '1px solid #E2E8F0',
  background: '#FFFFFF',
  color: '#0F172A',
  fontSize: 15,
  fontWeight: 800,
  cursor: 'pointer',
}

const dogNamePrimaryBtnStyle: React.CSSProperties = {
  height: 48,
  borderRadius: 16,
  border: 'none',
  background: '#2563EB',
  color: '#FFFFFF',
  fontSize: 15,
  fontWeight: 800,
  cursor: 'pointer',
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  height: 44,
  borderRadius: 15,
  border: '1px solid #E2E8F0',
  background: '#FFFFFF',
  outline: 'none',
  padding: '0 12px',
  fontSize: 16,
  color: '#0F172A',
  boxSizing: 'border-box',
}

const scheduledHeaderRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  marginBottom: 0,
}

const scheduledLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  letterSpacing: 0.6,
  textTransform: 'uppercase',
  color: '#64748B',
}

const scheduledActionsStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
}

const scheduledAsapBtnStyle: React.CSSProperties = {
  border: 'none',
  background: 'none',
  color: '#0F172A',
  fontSize: 12,
  fontWeight: 800,
  cursor: 'pointer',
  padding: 0,
}

const scheduledEditBtnStyle: React.CSSProperties = {
  border: 'none',
  background: 'none',
  color: '#2563EB',
  fontSize: 12,
  fontWeight: 800,
  cursor: 'pointer',
  padding: 0,
}

const scheduledSummaryCardStyle: React.CSSProperties = {
  width: '100%',
  textAlign: 'left',
  border: '1px solid #E2E8F0',
  background: 'linear-gradient(180deg, #FFFFFF 0%, #F8FAFC 100%)',
  borderRadius: 16,
  padding: '9px 12px',
  cursor: 'pointer',
  boxShadow: '0 4px 14px rgba(15, 23, 42, 0.04)',
}

const scheduledSummaryCardActiveStyle: React.CSSProperties = {
  border: '1px solid rgba(37, 99, 235, 0.28)',
  background: 'linear-gradient(180deg, #FFFFFF 0%, #EFF6FF 100%)',
}

const scheduledSummaryMainStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 800,
  color: '#0F172A',
  lineHeight: 1.3,
}

const scheduledSummarySubStyle: React.CSSProperties = {
  marginTop: 3,
  fontSize: 11,
  color: '#64748B',
  lineHeight: 1.35,
}

const compactDurationWrapStyle: React.CSSProperties = {
  marginTop: 0,
  border: '2px solid transparent',
  borderRadius: 24,
  padding: 2,
  boxSizing: 'border-box',
  transition: 'border-color 180ms ease, background-color 180ms ease, box-shadow 220ms ease',
  transformOrigin: 'center top',
  willChange: 'transform, box-shadow, opacity',
}

const durationGuidedFieldShellStyle: React.CSSProperties = {
  border: '2px solid #3B82F6',
  background: 'rgba(59,130,246,0.06)',
  boxShadow: '0 0 0 3px rgba(59,130,246,0.12)',
}

const guidedFieldAnimationStyle: React.CSSProperties = {
  animation: 'regliGuidedFieldPulse 420ms cubic-bezier(0.22, 1, 0.36, 1) 1',
}

const compactPaymentWrapStyle: React.CSSProperties = {
  marginTop: 0,
  border: '2px solid transparent',
  borderRadius: 24,
  padding: 2,
  boxSizing: 'border-box',
  transition: 'border-color 180ms ease, background-color 180ms ease, box-shadow 220ms ease',
  transformOrigin: 'center top',
  willChange: 'transform, box-shadow, opacity',
}

const paymentGuidedFieldShellStyle: React.CSSProperties = {
  border: '2px solid #3B82F6',
  background: 'rgba(59,130,246,0.06)',
  boxShadow: '0 0 0 3px rgba(59,130,246,0.12)',
}

const feeLabelStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#64748B',
  lineHeight: 1.3,
  textAlign: 'center',
  paddingTop: 0,
}

const stickyCtaWrapStyle: React.CSSProperties = {
  padding: '6px 14px calc(8px + env(safe-area-inset-bottom))',
  borderTop: '1px solid rgba(226, 232, 240, 0.9)',
  background: 'rgba(255,255,255,0.96)',
  backdropFilter: 'blur(10px)',
  flexShrink: 0,
}

const guidedCtaHelperStyle: React.CSSProperties = {
  marginBottom: 8,
  fontSize: 12,
  fontWeight: 700,
  lineHeight: 1.35,
  color: '#2563EB',
  textAlign: 'center',
}

const stickyMainActionStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
}

const completionOverlayStyle: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  zIndex: 4000,
  display: 'flex',
  alignItems: 'flex-end',
  justifyContent: 'center',
  padding: '18px 14px calc(18px + env(safe-area-inset-bottom))',
  boxSizing: 'border-box',
  pointerEvents: 'auto',
  overflow: 'hidden',
  width: '100%',
  maxWidth: '100%',
  maxInlineSize: '100dvw',
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

const tipCardStyle: React.CSSProperties = {
  position: 'relative',
  borderRadius: 24,
  background: '#FFFFFF',
  boxShadow: '0 24px 70px rgba(15, 23, 42, 0.20)',
  padding: 22,
  display: 'grid',
  gap: 12,
  textAlign: 'center',
}

const tipIconStyle: React.CSSProperties = {
  width: 48,
  height: 48,
  borderRadius: 16,
  background: '#FFFBEB',
  color: '#B45309',
  display: 'grid',
  placeItems: 'center',
  justifySelf: 'center',
  fontSize: 24,
  fontWeight: 900,
}

const tipTitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 20,
  fontWeight: 900,
  color: '#0F172A',
  lineHeight: 1.18,
}

const tipSubtitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  color: '#64748B',
  lineHeight: 1.4,
}

const tipPresetRowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  gap: 8,
}

const tipPresetButtonStyle: React.CSSProperties = {
  height: 46,
  borderRadius: 16,
  border: '1px solid #FDE68A',
  background: '#FFFBEB',
  color: '#92400E',
  fontSize: 16,
  fontWeight: 900,
  cursor: 'pointer',
  fontFamily: 'inherit',
}

const tipCustomToggleStyle: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: '#2563EB',
  fontSize: 13,
  fontWeight: 800,
  cursor: 'pointer',
  fontFamily: 'inherit',
}

const tipCustomRowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr auto',
  gap: 8,
}

const tipCustomInputStyle: React.CSSProperties = {
  height: 44,
  borderRadius: 14,
  border: '1px solid #E2E8F0',
  padding: '0 12px',
  fontSize: 15,
  fontWeight: 800,
  outline: 'none',
  boxSizing: 'border-box',
}

const tipCustomSubmitStyle: React.CSSProperties = {
  height: 44,
  borderRadius: 14,
  border: 'none',
  background: '#0F172A',
  color: '#FFFFFF',
  padding: '0 16px',
  fontSize: 14,
  fontWeight: 900,
  cursor: 'pointer',
  fontFamily: 'inherit',
}

const tipSkipButtonStyle: React.CSSProperties = {
  height: 44,
  borderRadius: 14,
  border: '1px solid #E2E8F0',
  background: '#FFFFFF',
  color: '#64748B',
  fontSize: 14,
  fontWeight: 800,
  cursor: 'pointer',
  fontFamily: 'inherit',
}

const trackingCardStyle: React.CSSProperties = {
  width: '100%',
  maxWidth: '100%',
  borderRadius: 22,
  border: '1px solid #E2E8F0',
  background: 'linear-gradient(180deg, #FFFFFF 0%, #F8FAFC 100%)',
  padding: 16,
  display: 'grid',
  gap: 12,
  boxSizing: 'border-box',
  overflow: 'hidden',
}

const trackingTopBadgeStyle: React.CSSProperties = {
  justifySelf: 'start',
  padding: '6px 10px',
  borderRadius: 999,
  background: 'rgba(37, 99, 235, 0.10)',
  color: '#1D4ED8',
  fontSize: 12,
  fontWeight: 800,
}

const trackingTitleStyle: React.CSSProperties = {
  fontSize: 24,
  fontWeight: 900,
  color: '#0F172A',
  lineHeight: 1.05,
  minWidth: 0,
  overflowWrap: 'anywhere',
}

const trackingSubtitleStyle: React.CSSProperties = {
  fontSize: 14,
  color: '#475569',
  lineHeight: 1.45,
  minWidth: 0,
  overflowWrap: 'anywhere',
}

const trackingStatsGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  gap: 10,
  minWidth: 0,
}

const trackingStatCardStyle: React.CSSProperties = {
  minWidth: 0,
  borderRadius: 16,
  background: '#FFFFFF',
  border: '1px solid #E2E8F0',
  padding: '12px 10px',
  display: 'grid',
  gap: 6,
  justifyItems: 'center',
  boxSizing: 'border-box',
}

const trackingStatLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  color: '#64748B',
  textTransform: 'uppercase',
  letterSpacing: 0.6,
}

const trackingStatValueStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 900,
  color: '#0F172A',
  textAlign: 'center',
  minWidth: 0,
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const trackingTimerPanelStyle: React.CSSProperties = {
  marginTop: 14,
  borderRadius: 18,
  background: '#F8FAFC',
  border: '1px solid #E2E8F0',
  padding: '14px 16px',
  display: 'grid',
  gap: 8,
}

const trackingTimerPrimaryRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
}

const trackingTimerLabelStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: '#64748B',
}

const trackingTimerValueStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 800,
  color: '#0F172A',
  fontVariantNumeric: 'tabular-nums',
}

const trackingTimerMetaRowStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 10,
}

const trackingTimerMetaStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: '#475569',
}

const menuOverlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(15, 23, 42, 0.26)',
  zIndex: 40000,
  overflow: 'hidden',
}

const menuPanelStyle: React.CSSProperties = {
  position: 'fixed',
  top: 'calc(16px + env(safe-area-inset-top))',
  left: 'max(12px, env(safe-area-inset-left, 0px))',
  bottom: 'calc(16px + env(safe-area-inset-bottom))',
  width: 'min(360px, calc(100% - 24px))',
  maxWidth: 'calc(100% - 24px)',
  borderRadius: 28,
  background: '#FFFFFF',
  boxShadow: '0 24px 60px rgba(15, 23, 42, 0.22)',
  zIndex: 40001,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  boxSizing: 'border-box',
}

const menuHeaderRowStyle: React.CSSProperties = {
  padding: '16px 16px 10px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
}

const menuHeaderLeftStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
}

const menuBackButtonStyle: React.CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: 12,
  border: '1px solid #E2E8F0',
  background: '#FFFFFF',
  color: '#0F172A',
  fontSize: 18,
  fontWeight: 800,
  cursor: 'pointer',
}

const menuTitleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 900,
  color: '#0F172A',
}

const menuScrollAreaStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  padding: '0 16px 14px',
}

const menuProfileButtonStyle: React.CSSProperties = {
  width: '100%',
  border: '1px solid #E2E8F0',
  background: '#FFFFFF',
  borderRadius: 20,
  padding: 12,
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  cursor: 'pointer',
  textAlign: 'left',
  marginBottom: 16,
}

const menuProfileTextStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
}

const menuProfileChevronStyle: React.CSSProperties = {
  color: '#94A3B8',
  fontSize: 24,
  lineHeight: 1,
  flexShrink: 0,
}

const menuDividerStyle: React.CSSProperties = {
  height: 1,
  background: '#E2E8F0',
}

const menuActionStyle: React.CSSProperties = {
  height: 52,
  border: 'none',
  background: '#FFFFFF',
  color: '#DC2626',
  fontSize: 15,
  fontWeight: 800,
  cursor: 'pointer',
}

const burgerSectionStyle: React.CSSProperties = {
  display: 'grid',
  gap: 2,
  paddingBottom: 14,
}


const burgerSectionHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
}

const burgerSectionTitleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 900,
  color: '#0F172A',
}

const burgerSectionSubtitleStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#64748B',
  lineHeight: 1.45,
}

const viewAllButtonStyle: React.CSSProperties = {
  border: 'none',
  background: 'none',
  color: '#2563EB',
  fontSize: 12,
  fontWeight: 800,
  cursor: 'pointer',
  padding: 0,
}

const accordionButtonStyle: React.CSSProperties = {
  width: '100%',
  border: 'none',
  background: 'transparent',
  padding: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  cursor: 'pointer',
  textAlign: 'left',
}

const accordionChevronStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 999,
  background: '#F8FAFC',
  border: '1px solid #E2E8F0',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: '#0F172A',
  fontSize: 18,
  fontWeight: 800,
  flexShrink: 0,
}

const burgerListStyle: React.CSSProperties = {
  display: 'grid',
  gap: 10,
}

const favoriteMenuListStyle: React.CSSProperties = {
  display: 'grid',
  gap: 8,
  maxHeight: 220,
  overflowY: 'auto',
  WebkitOverflowScrolling: 'touch',
  paddingRight: 2,
}

const favoriteMenuItemStyle: React.CSSProperties = {
  borderRadius: 16,
  border: '1px solid #E2E8F0',
  background: '#FFFFFF',
  padding: 10,
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  minWidth: 0,
}

const favoriteMenuTextStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
}

const favoriteMenuNameStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 900,
  color: '#0F172A',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const favoriteMenuSubStyle: React.CSSProperties = {
  marginTop: 2,
  fontSize: 11,
  fontWeight: 700,
  color: '#94A3B8',
}

const favoriteMenuRemoveStyle: React.CSSProperties = {
  border: 'none',
  background: '#FEF2F2',
  color: '#B91C1C',
  borderRadius: 999,
  padding: '7px 10px',
  fontSize: 12,
  fontWeight: 800,
  cursor: 'pointer',
  fontFamily: 'inherit',
  flexShrink: 0,
}

const burgerListCardStyle: React.CSSProperties = {
  borderRadius: 18,
  border: '1px solid #E2E8F0',
  background: '#FFFFFF',
  padding: 12,
}

const burgerListCardHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 10,
}

const burgerListTitleStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 800,
  color: '#0F172A',
}

const burgerListSubtitleStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#64748B',
  lineHeight: 1.4,
  marginTop: 3,
}

const burgerListPriceStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 900,
  color: '#0F172A',
}

const burgerListMetaRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  marginTop: 6,
}

const burgerListMetaStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#475569',
}

const clientUpcomingBadgeStyle: React.CSSProperties = {
  padding: '4px 8px',
  borderRadius: 999,
  background: 'rgba(37, 99, 235, 0.10)',
  color: '#1D4ED8',
  fontSize: 11,
  fontWeight: 800,
  whiteSpace: 'nowrap',
}

const clientUpcomingCancelBtnStyle: React.CSSProperties = {
  height: 30,
  padding: '0 10px',
  borderRadius: 999,
  border: '1px solid rgba(239, 68, 68, 0.25)',
  background: '#FFFFFF',
  color: '#DC2626',
  fontSize: 12,
  fontWeight: 800,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const burgerEmptyStateStyle: React.CSSProperties = {
  borderRadius: 18,
  border: '1px dashed #CBD5E1',
  background: '#F8FAFC',
  padding: 14,
  fontSize: 13,
  color: '#64748B',
}

const profilePanelStyle: React.CSSProperties = {
  position: 'fixed',
  top: 'calc(72px + env(safe-area-inset-top))',
  right: 'max(14px, env(safe-area-inset-right, 0px))',
  width: 'min(320px, calc(100% - 28px))',
  maxWidth: 'calc(100% - 28px)',
  borderRadius: 24,
  background: '#FFFFFF',
  boxShadow: '0 24px 60px rgba(15, 23, 42, 0.18)',
  zIndex: 40001,
  overflow: 'hidden',
  boxSizing: 'border-box',
}

const profileSectionStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  padding: 16,
}

const cameraIconStyle: React.CSSProperties = {
  position: 'absolute',
  right: -2,
  bottom: -2,
  width: 18,
  height: 18,
  borderRadius: 999,
  background: '#2563EB',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  boxShadow: '0 4px 12px rgba(37, 99, 235, 0.35)',
}

const profileNameStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 900,
  color: '#0F172A',
}

const profileEmailStyle: React.CSSProperties = {
  marginTop: 4,
  fontSize: 12,
  color: '#64748B',
  wordBreak: 'break-word',
}

const profileRatingStyle: React.CSSProperties = {
  marginTop: 6,
  fontSize: 12,
  color: '#64748B',
  fontWeight: 800,
}
