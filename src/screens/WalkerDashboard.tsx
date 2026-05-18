import { hapticMedium, hapticSuccess } from '../utils/haptics'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import NotificationsBell from '../components/NotificationsBell'
import ProfileAvatar from '../components/ProfileAvatar'
import CompletionCard from '../components/CompletionCard'
import GroupedHistory from '../components/GroupedHistory'
import ProviderPricingPreferences from '../components/ProviderPricingPreferences'
import type { HistoryItem } from '../components/GroupedHistory'
import { useWalkerFlow } from '../hooks/useWalkerFlow'
import { useProfilePhoto } from '../hooks/useProfilePhoto'
import { usePushNotifications } from '../hooks/usePushNotifications'
import { supabase } from '../services/supabaseClient'
import { formatShortAddress } from '../utils/addressFormat'
import { formatDogCountLabel, isDogServiceType } from '../utils/dogCount'
import { getServiceLabels } from '../utils/serviceLifecycle'
import { formatDurationFromMinutes, getDurationSummary } from '../utils/serviceTiming'
import {
  BUSINESS_TIMEZONE,
  type ProviderAvailabilityRow,
} from '../utils/providerAvailability'
import i18n from '../i18n'
import {
  getProfileServiceOptions,
  getProfileServiceTypeLabel,
  normalizeProfileServiceTypes,
  type ProfileServiceType,
} from '../lib/profileServiceTypes'
import { normalizeAgeRangeValue } from '../lib/dispatchRanking'
import { getProviderEarnings, logPayoutSummary } from '../lib/payoutTruth'
import { hasProviderIssue } from '../utils/completionReview'

const REQUEST_TIMEOUT_SECONDS = 20
type MenuPage = 'main' | 'settings' | 'history' | 'futureOrders' | 'earnings'
type EarningsPeriod = 'today' | 'week' | 'month'

type AppRole = 'client' | 'walker' | 'admin'

type ServiceAttributes = Record<string, Record<string, unknown>>
type AvailabilityFormRow = {
  dayOfWeek: number
  isActive: boolean
  startTime: string
  endTime: string
}

type AvailabilityFormState = Record<ProfileServiceType, AvailabilityFormRow[]>

const AVAILABILITY_DAY_ORDER = [0, 1, 2, 3, 4, 5, 6] as const
const DEFAULT_AVAILABILITY_START = '09:00'
const DEFAULT_AVAILABILITY_END = '17:00'

interface WalkerDashboardProps {
  profile: {
    id: string
    email: string | null
    full_name: string | null
    role: AppRole
    service_type?: string | null
    service_types?: string[] | null
    service_attributes?: ServiceAttributes | null
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
  return formatDurationFromMinutes(minutes) ?? '—'
}

function parseBabysitterNotes(notes: string | null | undefined): {
  details: string | null
  startTime: string | null
  duration: string | null
  budget: string | null
} {
  const parsed: {
    details: string | null
    startTime: string | null
    duration: string | null
    budget: string | null
  } = {
    details: null,
    startTime: null,
    duration: null,
    budget: null,
  }

  if (!notes) return parsed

  notes.split('\n').forEach((line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    if (trimmed.startsWith('Service details:')) parsed.details = trimmed.replace('Service details:', '').trim()
    if (trimmed.startsWith('Start time:')) parsed.startTime = trimmed.replace('Start time:', '').trim()
    if (trimmed.startsWith('Requested duration:')) parsed.duration = trimmed.replace('Requested duration:', '').trim()
    if (trimmed.startsWith('Client budget:')) parsed.budget = trimmed.replace('Client budget:', '').trim()
  })

  return parsed
}

function formatMoney(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `₪${Math.round(value).toLocaleString()}`
}

function getJobCompletedTime(job: {
  service_completed_at?: string | null
  paid_at?: string | null
  created_at: string | null
}): number {
  const value = job.service_completed_at ?? job.paid_at ?? job.created_at ?? null
  if (!value) return 0
  const ts = new Date(value).getTime()
  return Number.isNaN(ts) ? 0 : ts
}

function getEstimatedProviderEarnings(job: { price: number | null; walker_earnings: number | null }): number | null {
  if (job.walker_earnings != null) return job.walker_earnings
  if (job.price == null) return null
  return getProviderEarnings(job)
}

function startOfTodayMs(): number {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function startOfWeekMs(): number {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  const day = date.getDay()
  const diff = day === 0 ? 6 : day - 1
  date.setDate(date.getDate() - diff)
  return date.getTime()
}

function startOfMonthMs(): number {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  date.setDate(1)
  return date.getTime()
}

function normalizeAvailabilityTimeValue(value: string | null | undefined): string {
  if (typeof value !== 'string' || !value.trim()) return DEFAULT_AVAILABILITY_START
  return value.slice(0, 5)
}

function buildDefaultAvailabilityRows(): AvailabilityFormRow[] {
  return AVAILABILITY_DAY_ORDER.map((dayOfWeek) => ({
    dayOfWeek,
    isActive: false,
    startTime: DEFAULT_AVAILABILITY_START,
    endTime: DEFAULT_AVAILABILITY_END,
  }))
}

function buildAvailabilityState(rows: ProviderAvailabilityRow[]): AvailabilityFormState {
  const nextState: AvailabilityFormState = {
    dog_walker: buildDefaultAvailabilityRows(),
    baby_sitter: buildDefaultAvailabilityRows(),
  }

  for (const row of rows) {
    const serviceType = normalizeProfileServiceTypes([row.service_type])[0]
    if (!serviceType) continue
    if (typeof row.day_of_week !== 'number' || row.day_of_week < 0 || row.day_of_week > 6) continue
    const targetIndex = nextState[serviceType].findIndex((entry) => entry.dayOfWeek === row.day_of_week)
    if (targetIndex < 0) continue

    nextState[serviceType][targetIndex] = {
      dayOfWeek: row.day_of_week,
      isActive: row.is_active !== false,
      startTime: normalizeAvailabilityTimeValue(row.start_time ?? DEFAULT_AVAILABILITY_START),
      endTime: normalizeAvailabilityTimeValue(row.end_time ?? DEFAULT_AVAILABILITY_END),
    }
  }

  return nextState
}

function parseAvailabilityInputMinutes(value: string): number | null {
  const [hoursRaw, minutesRaw] = value.split(':')
  const hours = Number(hoursRaw)
  const minutes = Number(minutesRaw)
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null
  return hours * 60 + minutes
}

function getAvailabilityRowKey(serviceType: ProfileServiceType, dayOfWeek: number): string {
  return `${serviceType}-${dayOfWeek}`
}

function formatAvailabilityTimeRange(startTime: string, endTime: string): string {
  return `${startTime}\u2013${endTime}`
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
  const profileServiceIconByType = useMemo(
    () => new Map(profileServiceOptions.map((option) => [option.value, option.icon])),
    [profileServiceOptions],
  )
  const serviceTypeSectionTitle = isHebrew ? 'סוג שירות' : 'Service type'
  const serviceTypeSectionSubtitle = isHebrew
    ? 'בחר את סוג השירות הראשי שאתה מציע.'
    : 'Choose the main service you provide.'
  const serviceTypeSavedLabel = isHebrew ? 'סוג השירות נשמר.' : 'Service type saved.'
  const serviceTypeSavingLabel = isHebrew ? 'שומר...' : 'Saving...'
  const serviceTypeErrorLabel = isHebrew
    ? 'לא הצלחנו לשמור את סוג השירות.'
    : 'We could not save the service type.'
  const availabilitySectionTitle = isHebrew ? 'שעות עבודה' : 'Working hours'
  const availabilitySectionSubtitle = isHebrew
    ? 'לקוחות יראו אותך רק בזמן שאתה זמין לשירות שנבחר.'
    : 'Clients only see you when you are available for the selected service.'
  const availabilityTimezoneLabel = isHebrew
    ? `כל השעות לפי שעון ישראל (${BUSINESS_TIMEZONE}).`
    : `All times use Israel time (${BUSINESS_TIMEZONE}).`
  const availabilityUnsetLabel = isHebrew
    ? 'בלי שעות מוגדרות תישאר לא זמין עד לשמירה.'
    : 'Without saved hours, you stay unavailable until you set them.'
  const availabilitySaveLabel = isHebrew ? 'שמור שעות' : 'Save hours'
  const availabilitySavingLabel = isHebrew ? 'שומר שעות...' : 'Saving hours...'
  const availabilitySavedLabel = isHebrew ? 'שעות העבודה נשמרו.' : 'Working hours saved.'
  const availabilityErrorLabel = isHebrew ? 'לא הצלחנו לשמור את השעות.' : 'We could not save working hours.'
  const availabilitySelectServiceLabel = isHebrew
    ? 'בחר לפחות שירות אחד כדי להגדיר שעות עבודה.'
    : 'Choose at least one service before setting working hours.'
  const availabilityInvalidRangeLabel = isHebrew
    ? 'שעת הסיום חייבת להיות אחרי שעת ההתחלה.'
    : 'End time must be after start time.'
  const availabilityEnabledLabel = isHebrew ? 'זמין' : 'Active'
  const availabilityStartLabel = isHebrew ? 'התחלה' : 'Start'
  const availabilityEndLabel = isHebrew ? 'סיום' : 'End'
  const availabilityUnavailableLabel = isHebrew ? 'לא זמין' : 'Unavailable'
  const availabilityEditLabel = isHebrew ? 'ערוך שעות' : 'Edit hours'
  const availabilityAutoEnableLabel = isHebrew ? 'הפעל יום זה כדי לקבוע שעות.' : 'Turn this day on to set hours.'
  const todayAvailabilityTitle = isHebrew ? 'הזמינות שלך היום' : 'Today’s availability'
  const todayAvailabilityManageLabel = isHebrew ? 'נהל זמינות' : 'Manage availability'
  const unavailableTodayLabel = isHebrew ? 'לא זמין היום' : 'Unavailable today'
  const greetingSubtitle = isHebrew ? 'כיף לראות אותך!' : 'Good to see you!'
  const performanceTitle = isHebrew ? 'ביצועים' : 'Performance'
  const walletTitle = isHebrew ? 'ארנק' : 'Wallet'
  const reviewsLabel = isHebrew ? 'ביקורות' : 'Reviews'
  const completedLabel = isHebrew ? 'הושלמו' : 'Completed'
  const onlineLabel = isHebrew ? 'מחובר' : 'Online'
  const readyForOrdersTitle = isHebrew ? 'מוכן להזמנות' : 'Ready for orders'
  const nearbyRequestsBody = isHebrew ? 'בקשות קרובות יופיעו כאן.' : 'Nearby requests will appear here.'
  const availabilityDayLabels = useMemo(
    () => [
      isHebrew ? 'א׳' : 'Sun',
      isHebrew ? 'ב׳' : 'Mon',
      isHebrew ? 'ג׳' : 'Tue',
      isHebrew ? 'ד׳' : 'Wed',
      isHebrew ? 'ה׳' : 'Thu',
      isHebrew ? 'ו׳' : 'Fri',
      isHebrew ? 'ש׳' : 'Sat',
    ],
    [isHebrew],
  )

  const [burgerOpen, setBurgerOpen] = useState(false)
  const [menuPage, setMenuPage] = useState<MenuPage>('main')
  const [showStripeGate, setShowStripeGate] = useState(false)
  const [showOnboardingWow, setShowOnboardingWow] = useState(false)
  const [isCheckingPayout, setIsCheckingPayout] = useState(false)
  const [payoutCtaAnimationStopped, setPayoutCtaAnimationStopped] = useState(false)
  const [payoutCtaNudgeActive, setPayoutCtaNudgeActive] = useState(false)
  const [earningsPeriod, setEarningsPeriod] = useState<EarningsPeriod>('month')
  const [reportIssueOpen, setReportIssueOpen] = useState(false)
  const [reportIssueFeedback, setReportIssueFeedback] = useState<string | null>(null)
  const [reportIssueSubmitting, setReportIssueSubmitting] = useState(false)
  const [hiddenHistoryIds, setHiddenHistoryIds] = useState<Set<string>>(new Set())
  const [preferredCustomerIds, setPreferredCustomerIds] = useState<Set<string>>(new Set())
  const [preferredCustomerNames, setPreferredCustomerNames] = useState<Map<string, string>>(new Map())
  const [profileServiceTypes, setProfileServiceTypes] = useState<ProfileServiceType[]>(
    normalizeProfileServiceTypes(profile.service_types ?? profile.service_type),
  )
  const [serviceTypeSaving, setServiceTypeSaving] = useState(false)
  const [serviceTypeSaveError, setServiceTypeSaveError] = useState<string | null>(null)
  const [serviceTypeSavedAt, setServiceTypeSavedAt] = useState(0)
  const [availabilityRows, setAvailabilityRows] = useState<AvailabilityFormState>(() => buildAvailabilityState([]))
  const [availabilityLoading, setAvailabilityLoading] = useState(true)
  const [availabilitySaving, setAvailabilitySaving] = useState(false)
  const [availabilityError, setAvailabilityError] = useState<string | null>(null)
  const [availabilitySavedAt, setAvailabilitySavedAt] = useState(0)
  const availabilityRowsRef = useRef(availabilityRows)
  const [expandedAvailabilityKey, setExpandedAvailabilityKey] = useState<string | null>(null)
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false)
  const [capSaving, setCapSaving] = useState(false)
  const [capSavedAt, setCapSavedAt] = useState(0)
  const [capError, setCapError] = useState<string | null>(null)
  const [provDogSizes, setProvDogSizes] = useState<string[]>(() => {
    const sa = profile.service_attributes?.dog_walker
    return Array.isArray(sa?.supportedDogSizes) ? (sa.supportedDogSizes as string[]) : []
  })
  const [provDogEnergy, setProvDogEnergy] = useState<string[]>(() => {
    const sa = profile.service_attributes?.dog_walker
    return Array.isArray(sa?.supportedEnergyLevels) ? (sa.supportedEnergyLevels as string[]) : []
  })
  const [provDogExp, setProvDogExp] = useState<number>(() => {
    const sa = profile.service_attributes?.dog_walker
    return typeof sa?.experienceYears === 'number' ? (sa.experienceYears as number) : 0
  })
  const [provDogNotes, setProvDogNotes] = useState<string>(() => {
    const sa = profile.service_attributes?.dog_walker
    return typeof sa?.notes === 'string' ? (sa.notes as string) : ''
  })
  const [provSitterAges, setProvSitterAges] = useState<string[]>(() => {
    const sa = profile.service_attributes?.baby_sitter
    return Array.isArray(sa?.supportedAgeRanges)
      ? (sa.supportedAgeRanges as unknown[])
          .map((range) => normalizeAgeRangeValue(range))
          .filter((range): range is '1-2' | '2-4' | '5-7' | '7+' => range !== null)
      : []
  })
  const [provSitterExp, setProvSitterExp] = useState<number>(() => {
    const sa = profile.service_attributes?.baby_sitter
    return typeof sa?.experienceYears === 'number' ? (sa.experienceYears as number) : 0
  })
  const [provSitterNotes, setProvSitterNotes] = useState<string>(() => {
    const sa = profile.service_attributes?.baby_sitter
    return typeof sa?.notes === 'string' ? (sa.notes as string) : ''
  })
  const capDirty = useMemo(() => {
    const sa = profile.service_attributes ?? {}
    const dogSa = sa.dog_walker ?? {}
    const sitterSa = sa.baby_sitter ?? {}
    const origDogSizes = Array.isArray(dogSa.supportedDogSizes) ? (dogSa.supportedDogSizes as string[]) : []
    const origDogEnergy = Array.isArray(dogSa.supportedEnergyLevels) ? (dogSa.supportedEnergyLevels as string[]) : []
    const origDogExp = typeof dogSa.experienceYears === 'number' ? (dogSa.experienceYears as number) : 0
    const origDogNotes = typeof dogSa.notes === 'string' ? (dogSa.notes as string) : ''
    const origSitterAges = Array.isArray(sitterSa.supportedAgeRanges)
      ? (sitterSa.supportedAgeRanges as unknown[])
          .map((range) => normalizeAgeRangeValue(range))
          .filter((range): range is '1-2' | '2-4' | '5-7' | '7+' => range !== null)
      : []
    const origSitterExp = typeof sitterSa.experienceYears === 'number' ? (sitterSa.experienceYears as number) : 0
    const origSitterNotes = typeof sitterSa.notes === 'string' ? (sitterSa.notes as string) : ''
    const arrEq = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i])
    return (
      !arrEq(provDogSizes, origDogSizes) ||
      !arrEq(provDogEnergy, origDogEnergy) ||
      provDogExp !== origDogExp ||
      provDogNotes !== origDogNotes ||
      !arrEq(provSitterAges, origSitterAges) ||
      provSitterExp !== origSitterExp ||
      provSitterNotes !== origSitterNotes
    )
  }, [
    profile.service_attributes,
    provDogSizes, provDogEnergy, provDogExp, provDogNotes,
    provSitterAges, provSitterExp, provSitterNotes,
  ])

  const fileInputRef = useRef<HTMLInputElement>(null)
  const handledWowTokenRef = useRef(0)
  const autoOnlineInFlightRef = useRef(false)

  const closeAll = useCallback(() => {
    setBurgerOpen(false)
    setMenuPage('main')
  }, [])

  const serviceSelectionRequiredLabel = isHebrew
    ? 'יש לבחור לפחות שירות אחד בהגדרות לפני מעבר לאונליין.'
    : 'Please choose at least one service in Settings before going online.'
  const hasSelectedProfileService = profileServiceTypes.length > 0

  useEffect(() => {
    setProfileServiceTypes(normalizeProfileServiceTypes(profile.service_types ?? profile.service_type))
  }, [profile.service_type, profile.service_types])

  useEffect(() => {
    availabilityRowsRef.current = availabilityRows
  }, [availabilityRows])

  const loadAvailability = useCallback(async (): Promise<ProviderAvailabilityRow[] | null> => {
    try {
      const { data, error } = await supabase
        .from('provider_availability')
        .select('provider_id, service_type, day_of_week, start_time, end_time, is_active')
        .eq('provider_id', profile.id)

      if (error) {
        console.warn('[WalkerDashboard] failed to load provider_availability:', error.message)
        setAvailabilityError(availabilityErrorLabel)
        return null
      }

      const rows = (data as ProviderAvailabilityRow[] | null) ?? []
      setAvailabilityRows(buildAvailabilityState(rows))
      setAvailabilityError(null)
      return rows
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('[WalkerDashboard] unexpected provider_availability load error:', message)
      setAvailabilityError(availabilityErrorLabel)
      return null
    }
  }, [availabilityErrorLabel, profile.id])

  useEffect(() => {
    let cancelled = false

    const runAvailabilityLoad = async () => {
      setAvailabilityLoading(true)
      try {
        if (cancelled) return
        await loadAvailability()
      } finally {
        if (!cancelled) {
          setAvailabilityLoading(false)
        }
      }
    }

    void runAvailabilityLoad()

    return () => {
      cancelled = true
    }
  }, [loadAvailability])

  const handleAvailabilityRowChange = useCallback((
    serviceType: ProfileServiceType,
    dayOfWeek: number,
    patch: Partial<AvailabilityFormRow>,
  ) => {
    setAvailabilityRows((prev) => ({
      ...prev,
      [serviceType]: prev[serviceType].map((row) => (
        row.dayOfWeek === dayOfWeek
          ? { ...row, ...patch }
          : row
      )),
    }))
  }, [])

  const handleAvailabilityToggle = useCallback((
    serviceType: ProfileServiceType,
    dayOfWeek: number,
    nextIsActive: boolean,
  ) => {
    handleAvailabilityRowChange(serviceType, dayOfWeek, {
      isActive: nextIsActive,
    })

    const rowKey = getAvailabilityRowKey(serviceType, dayOfWeek)
    if (nextIsActive) {
      setExpandedAvailabilityKey(rowKey)
    } else {
      setExpandedAvailabilityKey((current) => (current === rowKey ? null : current))
    }
  }, [handleAvailabilityRowChange])

  const handleAvailabilityRowPress = useCallback((
    serviceType: ProfileServiceType,
    row: AvailabilityFormRow,
  ) => {
    const rowKey = getAvailabilityRowKey(serviceType, row.dayOfWeek)

    if (!row.isActive) {
      handleAvailabilityToggle(serviceType, row.dayOfWeek, true)
      return
    }

    setExpandedAvailabilityKey((current) => (current === rowKey ? null : rowKey))
  }, [handleAvailabilityToggle])

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

  const handleSaveCapabilities = useCallback(async () => {
    if (capSaving) return
    setCapSaving(true)
    setCapError(null)

    const existing: ServiceAttributes = (profile.service_attributes as ServiceAttributes) ?? {}
    const next: ServiceAttributes = { ...existing }

    if (profileServiceTypes.includes('dog_walker')) {
      next.dog_walker = {
        ...(existing.dog_walker ?? {}),
        supportedDogSizes: provDogSizes,
        supportedEnergyLevels: provDogEnergy,
        experienceYears: provDogExp,
        notes: provDogNotes.trim() || null,
      }
    }

    if (profileServiceTypes.includes('baby_sitter')) {
      next.baby_sitter = {
        ...(existing.baby_sitter ?? {}),
        supportedAgeRanges: provSitterAges
          .map((range) => normalizeAgeRangeValue(range))
          .filter((range): range is '1-2' | '2-4' | '5-7' | '7+' => range !== null),
        experienceYears: provSitterExp,
        notes: provSitterNotes.trim() || null,
      }
    }

    const { error } = await supabase
      .from('profiles')
      .update({ service_attributes: next })
      .eq('id', profile.id)

    if (error) {
      setCapError(isHebrew ? 'לא הצלחנו לשמור.' : 'Could not save capabilities.')
      setCapSaving(false)
      return
    }

    setCapSaving(false)
    setCapSavedAt(Date.now())
  }, [
    capSaving, profile.id, profile.service_attributes, profileServiceTypes, isHebrew,
    provDogSizes, provDogEnergy, provDogExp, provDogNotes,
    provSitterAges, provSitterExp, provSitterNotes,
  ])

  const handleSaveAvailability = useCallback(async () => {
    if (availabilitySaving) return
    if (profileServiceTypes.length === 0) {
      setAvailabilityError(availabilitySelectServiceLabel)
      return
    }

    const rowsToSave = availabilityRowsRef.current
    const activeRows = profileServiceTypes.flatMap((serviceType) =>
      rowsToSave[serviceType]
        .filter((row) => row.isActive)
        .map((row) => ({ serviceType, row })),
    )

    for (const entry of activeRows) {
      const startMinutes = parseAvailabilityInputMinutes(entry.row.startTime)
      const endMinutes = parseAvailabilityInputMinutes(entry.row.endTime)
      if (startMinutes == null || endMinutes == null || endMinutes <= startMinutes) {
        setAvailabilityError(availabilityInvalidRangeLabel)
        return
      }
    }

    setAvailabilitySaving(true)
    setAvailabilityError(null)

    const payload = profileServiceTypes.flatMap((serviceType) =>
      rowsToSave[serviceType].map((row) => ({
        provider_id: profile.id,
        service_type: serviceType,
        day_of_week: row.dayOfWeek,
        start_time: `${row.startTime}:00`,
        end_time: `${row.endTime}:00`,
        is_active: row.isActive,
      })),
    )

    const { error } = await supabase
      .from('provider_availability')
      .upsert(payload, {
        onConflict: 'provider_id,service_type,day_of_week',
      })

    if (error) {
      console.warn('[WalkerDashboard] failed to save provider_availability:', error.message)
      setAvailabilityError(availabilityErrorLabel)
      setAvailabilitySaving(false)
      return
    }

    try {
      const refreshedRows = await loadAvailability()
      if (refreshedRows == null) {
        return
      }

      setAvailabilitySavedAt(Date.now())
    } finally {
      setAvailabilitySaving(false)
    }
  }, [
    availabilityErrorLabel,
    availabilityInvalidRangeLabel,
    availabilitySaving,
    availabilitySelectServiceLabel,
    loadAvailability,
    profile.id,
    profileServiceTypes,
  ])

  const [serviceClockNow, setServiceClockNow] = useState(() => Date.now())

  const topRequest = flow.openJobs[0] ?? null
  const activeJob = flow.activeJobs[0] ?? null
  const onTheWayJob = flow.onTheWayJobs[0] ?? null
  const onTheWayJobHasProviderIssue = hasProviderIssue(onTheWayJob?.notes)
  const activeJobHasProviderIssue = hasProviderIssue(activeJob?.notes)
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
        ? `₪${Math.round(topRequest.price * 0.8)}`
        : '—'
    : '—'

  const requestDuration = durationFromMinutes(topRequest?.duration_minutes)
  const requestDogCountLabel = formatDogCountLabel(topRequest?.dog_count ?? 1, { isHebrew })
  const isBabysitterRequest = topRequest?.service_type === 'baby_sitter'
  const babysitterRequestNotes = useMemo(
    () => parseBabysitterNotes(topRequest?.notes),
    [topRequest?.notes],
  )
  const topOffer = flow.activeOffers.find((offer) => offer.request_id === topRequest?.id) ?? null

  useEffect(() => {
    if (!topRequest) return
    console.debug('[WalkerDashboard] displayed dog count', {
      request_id: topRequest.id,
      topRequestDogCount: topRequest.dog_count ?? null,
      topOfferDogCount: topOffer?.dog_count ?? null,
      label: requestDogCountLabel,
    })
  }, [requestDogCountLabel, topOffer?.dog_count, topRequest])

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
    if (isDogServiceType(completionJobDetails?.service_type) && completionJobDetails) {
      rows.push({
        label: isHebrew ? 'Dogs' : 'Dogs',
        value: formatDogCountLabel(completionJobDetails.dog_count ?? 1, { isHebrew }),
      })
    }
    if (completionDurationSummary.plannedLabel) {
      rows.push({ label: 'Planned', value: completionDurationSummary.plannedLabel })
    }
    if (completionDurationSummary.actualLabel) {
      rows.push({ label: 'Actual', value: completionDurationSummary.actualLabel })
    }
    return rows
  }, [
    completionDurationSummary.actualLabel,
    completionDurationSummary.plannedLabel,
    completionJobDetails,
    isHebrew,
  ])

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
          price: j.walker_earnings ?? null,
          dog_count: j.dog_count ?? 1,
          service_type: j.service_type ?? null,
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
        dogCount: job.dog_count ?? 1,
        service_type: job.service_type ?? null,
        scheduledFor: job.scheduled_for,
        startsInMinutes: flow.startsInMinutes(job.scheduled_for),
        durationLabel: durationFromMinutes(job.duration_minutes),
        earningsLabel:
          job.walker_earnings != null
            ? `₪${job.walker_earnings.toFixed(0)}`
            : null,
      })),
    [flow.futureJobs, flow.startsInMinutes, t, isHebrew],
  )

  const incomingTitle = i18n.resolvedLanguage === 'he' ? 'הזמנה חדשה' : 'New order arrived'
  const idleHeroTitle = flow.isOnline ? (isHebrew ? 'מצב מחובר' : 'Connected') : (isHebrew ? 'לא מחובר' : 'Offline')
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
  const todayDayOfWeek = new Date().getDay()
  const todayAvailabilityRows = useMemo(
    () =>
      profileServiceTypes.map((serviceType) => {
        const todayRow = availabilityRows[serviceType].find((row) => row.dayOfWeek === todayDayOfWeek) ?? null
        return {
          serviceType,
          label: getProfileServiceTypeLabel(serviceType, isHebrew),
          isAvailable: !!todayRow?.isActive,
          summary:
            todayRow?.isActive
              ? formatAvailabilityTimeRange(todayRow.startTime, todayRow.endTime)
              : unavailableTodayLabel,
        }
      }),
    [availabilityRows, isHebrew, profileServiceTypes, todayDayOfWeek, unavailableTodayLabel],
  )
  const walletPayoutReady =
    !!flow.connectStatus?.connected &&
    !!flow.connectStatus?.stripe_connect_onboarding_complete &&
    !!flow.connectStatus?.payouts_enabled
  const walletNeedsSetup = !flow.connectLoading && !walletPayoutReady
  const earningsSummary = useMemo(() => {
    const completed = flow.completedJobs
      .filter((job) => job.status === 'completed')
      .sort((a, b) => getJobCompletedTime(b) - getJobCompletedTime(a))

    const todayStart = startOfTodayMs()
    const weekStart = startOfWeekMs()
    const monthStart = startOfMonthMs()

    let today = 0
    let week = 0
    let month = 0
    const todayJobs = completed.filter((job) => getJobCompletedTime(job) >= todayStart)
    const weekJobs = completed.filter((job) => getJobCompletedTime(job) >= weekStart)
    const monthJobs = completed.filter((job) => getJobCompletedTime(job) >= monthStart)

    completed.forEach((job) => {
      const earnings = job.walker_earnings ?? getEstimatedProviderEarnings(job) ?? 0
      const completedAt = getJobCompletedTime(job)
      if (completedAt >= todayStart) today += earnings
      if (completedAt >= weekStart) week += earnings
      if (completedAt >= monthStart) month += earnings
    })

    logPayoutSummary('earnings summary', monthJobs)

    return {
      today,
      week,
      month,
      completedCount: completed.length,
      completed,
      todayJobs,
      weekJobs,
      monthJobs,
    }
  }, [flow.completedJobs])
  const selectedEarningsJobs = useMemo(() => {
    if (earningsPeriod === 'today') return earningsSummary.todayJobs
    if (earningsPeriod === 'week') return earningsSummary.weekJobs
    return earningsSummary.monthJobs
  }, [earningsPeriod, earningsSummary.monthJobs, earningsSummary.todayJobs, earningsSummary.weekJobs])
  const selectedEarningsTotal = useMemo(
    () =>
      selectedEarningsJobs.reduce(
        (sum, job) => sum + (job.walker_earnings ?? getEstimatedProviderEarnings(job) ?? 0),
        0,
      ),
    [selectedEarningsJobs],
  )
  const selectedEarningsLabel =
    earningsPeriod === 'today'
      ? (isHebrew ? 'היום' : 'Today')
      : earningsPeriod === 'week'
        ? (isHebrew ? 'השבוע' : 'This week')
        : (isHebrew ? 'החודש' : 'This month')
  const earningsHistoryItems = useMemo(
    () =>
      selectedEarningsJobs.slice(0, 30).map((job) => {
        const hasStoredEarnings = job.walker_earnings != null
        const earnings = hasStoredEarnings ? job.walker_earnings : getEstimatedProviderEarnings(job)
        const completedAt = getJobCompletedTime(job)
        const date = completedAt > 0 ? new Date(completedAt) : null
        const labels = getServiceLabels(job.service_type)
        const customerName = getCustomerDisplayName(
          {
            client: job.client,
            clientName: job.client?.full_name || job.client?.email || null,
            dogName: job.dog_name,
          },
          isHebrew,
        )

        return {
          id: job.id,
          dateLabel: date
            ? date.toLocaleDateString(isHebrew ? 'he-IL' : 'en-US', {
                day: 'numeric',
                month: 'short',
              })
            : isHebrew ? 'לאחרונה' : 'Recently',
          timeLabel: date
            ? date.toLocaleTimeString(isHebrew ? 'he-IL' : 'en-US', {
                hour: '2-digit',
                minute: '2-digit',
              })
            : '',
          serviceLabel: labels.itemLabel,
          dogCountLabel: formatDogCountLabel(job.dog_count ?? 1, { isHebrew }),
          durationLabel: durationFromMinutes(job.duration_minutes),
          customerName,
          totalPriceLabel: formatMoney(job.price),
          earningsLabel: formatMoney(earnings),
          isEstimated: !hasStoredEarnings,
          statusLabel: job.status === 'completed'
            ? (isHebrew ? 'הושלם' : 'Completed')
            : (isHebrew ? 'בוטל' : 'Cancelled'),
        }
      }),
    [selectedEarningsJobs, isHebrew],
  )

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
    if (!hasSelectedProfileService) {
      setServiceTypeSaveError(serviceSelectionRequiredLabel)
      setBurgerOpen(true)
      setMenuPage('settings')
      return
    }
    if (!flow.isOnline) {
      const ok = await flow.toggleOnline()
      if (!ok) {
        setShowStripeGate(true)
      }
      return
    }
    setShowStripeGate(false)
    await flow.toggleOnline()
  }, [flow, hasSelectedProfileService, serviceSelectionRequiredLabel])

  const handleManageAvailability = useCallback(() => {
    setBurgerOpen(true)
    setMenuPage('settings')
  }, [])

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
    if (!burgerOpen) return

    const previousBodyOverflow = document.body.style.overflow
    const previousHtmlOverflow = document.documentElement.style.overflow
    const previousBodyTouchAction = document.body.style.touchAction

    document.body.style.overflow = 'hidden'
    document.documentElement.style.overflow = 'hidden'
    document.body.style.touchAction = 'none'

    return () => {
      document.body.style.overflow = previousBodyOverflow
      document.documentElement.style.overflow = previousHtmlOverflow
      document.body.style.touchAction = previousBodyTouchAction
    }
  }, [burgerOpen])

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

    if (!hasSelectedProfileService) {
      setServiceTypeSaveError(serviceSelectionRequiredLabel)
      setBurgerOpen(true)
      setMenuPage('settings')
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
  }, [flow.isOnline, flow.stripeReadyForOnline, flow.toggleOnline, hasSelectedProfileService, profile.id, serviceSelectionRequiredLabel])

  const handleOnboardingWowPrimary = useCallback(async () => {
    if (isCheckingPayout) return
    if (!hasSelectedProfileService) {
      setServiceTypeSaveError(serviceSelectionRequiredLabel)
      setBurgerOpen(true)
      setMenuPage('settings')
      return
    }
    if (flow.stripeReadyForOnline) {
      const ok = await flow.toggleOnline()
      if (ok) {
        setShowOnboardingWow(false)
      }
      return
    }
    await handleStripeSetup(true)
  }, [flow.stripeReadyForOnline, flow.toggleOnline, handleStripeSetup, hasSelectedProfileService, isCheckingPayout, serviceSelectionRequiredLabel])

  const renderTodayAvailabilityCard = useCallback(() => {
    if (todayAvailabilityRows.length === 0) return null

    return (
      <div style={todayAvailabilityCardStyle}>
        <div style={todayAvailabilityHeaderStyle}>
          <div style={todayAvailabilityTitleStyle}>{todayAvailabilityTitle}</div>
          <button type="button" onClick={handleManageAvailability} style={todayAvailabilityManageButtonStyle}>
            <span>{todayAvailabilityManageLabel}</span>
            <span style={todayAvailabilityManageChevronStyle}>›</span>
          </button>
        </div>
        <div style={todayAvailabilityListStyle}>
          {todayAvailabilityRows.map((item, index) => (
            <div
              key={item.serviceType}
              style={{
                ...todayAvailabilityRowStyle,
                ...(index > 0 ? todayAvailabilityRowWithDividerStyle : null),
              }}
            >
              <div style={todayAvailabilityServiceWrapStyle}>
                <div style={todayAvailabilityServiceIconStyle}>
                  {profileServiceIconByType.get(item.serviceType) ?? '•'}
                </div>
                <span style={todayAvailabilityServiceLabelStyle}>{item.label}</span>
              </div>
              {item.isAvailable ? (
                <span style={todayAvailabilityTimePillStyle}>{item.summary}</span>
              ) : (
                <span style={todayAvailabilityUnavailableStyle}>{item.summary}</span>
              )}
            </div>
          ))}
        </div>
      </div>
    )
  }, [
    handleManageAvailability,
    profileServiceIconByType,
    todayAvailabilityManageLabel,
    todayAvailabilityRows,
    todayAvailabilityTitle,
  ])

  const renderHomeDashboard = useCallback((connected: boolean) => (
    <div className="sheet-state-enter">
      <div style={homeDashboardTopStackStyle}>
        <div style={{ ...homeStatusCardStyle, ...(connected ? homeStatusCardOnlineStyle : null) }}>
          <div style={homeStatusContentStyle}>
            <div style={homeStatusBadgeStyle}>
              <span style={homeStatusDotStyle} />
              <span>{connected ? onlineLabel : idleHeroTitle}</span>
            </div>
            <div style={homeStatusTitleStyle}>{readyForOrdersTitle}</div>
            <div style={homeStatusBodyStyle}>{nearbyRequestsBody}</div>
          </div>
          <div style={homeStatusRightStyle}>
            <div style={homeStatusAccentOrbStyle} />
            <button
              type="button"
              onClick={() => void handleOnlineToggle()}
              style={{
                ...homeStatusToggleStyle,
                background: connected ? 'linear-gradient(180deg, #22C55E 0%, #16A34A 100%)' : '#D6DEE8',
              }}
            >
              <div
                style={{
                  ...homeStatusToggleKnobStyle,
                  transform: connected ? 'translateX(20px)' : 'translateX(0)',
                }}
              />
            </button>
          </div>
        </div>

        {renderTodayAvailabilityCard()}

        <div style={waitingCardStyle}>
          <div style={waitingCardCopyStyle}>
            <div style={waitingCardTitleStyle}>{idleWaitingTitle}</div>
            <div style={waitingCardBodyStyle}>{idleWaitingBody}</div>
          </div>
          <div style={waitingCardVisualWrapStyle}>
            <RadarVisual />
          </div>
        </div>
      </div>

      <div style={dashboardSectionStyle}>
        <div style={dashboardSectionTitleStyle}>{performanceTitle}</div>
        <div style={performanceGridStyle}>
          <div style={performanceMetricCardStyle}>
            <div style={{ ...performanceMetricIconStyle, background: 'rgba(245, 158, 11, 0.12)', color: '#D97706' }}>★</div>
            <div style={performanceMetricValueStyle}>{flow.avgRating != null ? flow.avgRating.toFixed(1) : '—'}</div>
            <div style={performanceMetricMetaStyle}>{reviewsLabel}</div>
          </div>
          <div style={performanceMetricCardStyle}>
            <div style={{ ...performanceMetricIconStyle, background: 'rgba(59, 130, 246, 0.12)', color: '#2563EB' }}>✓</div>
            <div style={performanceMetricValueStyle}>{completedJobsCount}</div>
            <div style={performanceMetricMetaStyle}>{completedLabel}</div>
          </div>
        </div>
      </div>

      <div style={dashboardSectionStyle}>
        <div style={dashboardSectionTitleStyle}>{walletTitle}</div>
        <div style={walletDashboardGridStyle}>
          <div style={walletDashboardMetricCardStyle}>
            <div style={walletDashboardMetricLabelStyle}>{isHebrew ? 'זמין' : 'Available balance'}</div>
            <div style={walletDashboardMetricValueStyle}>₪{flow.wallet.availableBalance.toFixed(0)}</div>
          </div>
          <div style={walletDashboardMetricCardStyle}>
            <div style={walletDashboardMetricLabelStyle}>{isHebrew ? 'ממתין' : 'Pending balance'}</div>
            <div style={walletDashboardMetricValueStyle}>₪{flow.wallet.pendingEarnings.toFixed(0)}</div>
          </div>
        </div>
        <div style={walletDashboardStatusRowStyle}>
          {flow.connectLoading ? (
            <span style={walletStatusNeutralStyle}>{isHebrew ? 'בודק הגדרת תשלומים...' : 'Checking payout setup...'}</span>
          ) : walletPayoutReady ? (
            <span style={walletDashboardReadyStyle}>{isHebrew ? 'מוכן לקבל תשלומים' : 'Ready to receive payouts'}</span>
          ) : (
            <>
              <span style={walletStatusWarningStyle}>
                {isHebrew ? 'השלם הגדרת תשלומים כדי לקבל כספים' : 'Complete payout setup to receive earnings'}
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
  ), [
    completedJobsCount,
    flow.avgRating,
    flow.connectLoading,
    flow.wallet.availableBalance,
    flow.wallet.pendingEarnings,
    handleOnlineToggle,
    handleStripeSetup,
    idleHeroTitle,
    idleWaitingBody,
    idleWaitingTitle,
    isCheckingPayout,
    isHebrew,
    nearbyRequestsBody,
    onlineLabel,
    payoutCtaAnimationStopped,
    payoutCtaNudgeActive,
    readyForOrdersTitle,
    renderTodayAvailabilityCard,
    reviewsLabel,
    completedLabel,
    performanceTitle,
    walletPayoutReady,
    walletTitle,
  ])

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
        <div style={dashboardBackgroundStyle}>
          <div style={headerStyle}>
            <div style={headerTopRowStyle}>
              <div style={headerIdentityRowStyle}>
                <ProfileAvatar
                  url={photo.avatarUrl}
                  name={walkerName}
                  size={50}
                  borderRadius={18}
                  onClick={() => fileInputRef.current?.click()}
                />
                <div style={headerIdentityStyle}>
                  <h2 style={greetingStyle}>{greetingLabel}</h2>
                  <div style={headerSubtitleStyle}>{greetingSubtitle}</div>
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

              <div style={headerActionsStyle}>
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

                <div style={bellWrapStyle}>
                  <NotificationsBell />
                </div>
              </div>
            </div>
            {isActiveOrCompleted ? (
              <div style={activeSessionChipStyle}>
                {flow.screenState === 'active' ? activeLabels.activeTitle : t('tracking.onTheWay')}
              </div>
            ) : null}
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
                            : menuPage === 'earnings'
                              ? (isHebrew ? 'רווחים' : 'Earnings')
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
                ) : menuPage === 'earnings' ? (
                  <BurgerSection
                    title={isHebrew ? 'רווחים' : 'Earnings'}
                    subtitle={isHebrew ? 'סיכום תשלומים והיסטוריית עבודות שהושלמו.' : 'Payout summary and completed job history.'}
                  >
                    <div style={earningsHeroCardStyle}>
                      <button
                        type="button"
                        onClick={() => setEarningsPeriod('month')}
                        style={{
                          ...earningsHeroTopButtonStyle,
                          ...(earningsPeriod === 'month' ? earningsHeroTopButtonActiveStyle : null),
                        }}
                      >
                        <div>
                          <div style={earningsHeroLabelStyle}>{isHebrew ? 'רווחי ספק החודש' : 'Provider earnings this month'}</div>
                          <div style={earningsHeroValueStyle}>{formatMoney(earningsSummary.month)}</div>
                        </div>
                        <div style={earningsHeroBadgeStyle}>
                          {earningsPeriod === 'month'
                            ? (isHebrew ? 'נבחר' : 'Selected')
                            : (isHebrew ? 'סינון' : 'Filter')}
                        </div>
                      </button>
                      <div style={earningsMetricGridStyle}>
                        <EarningsMetric
                          label={isHebrew ? 'רווחים היום' : 'Earnings today'}
                          value={formatMoney(earningsSummary.today)}
                          selected={earningsPeriod === 'today'}
                          onClick={() => setEarningsPeriod('today')}
                        />
                        <EarningsMetric
                          label={isHebrew ? 'רווחים השבוע' : 'Earnings week'}
                          value={formatMoney(earningsSummary.week)}
                          selected={earningsPeriod === 'week'}
                          onClick={() => setEarningsPeriod('week')}
                        />
                        <EarningsMetric
                          label={isHebrew ? 'עבודות החודש' : 'Month jobs'}
                          value={String(earningsSummary.monthJobs.length)}
                          selected={earningsPeriod === 'month'}
                          onClick={() => setEarningsPeriod('month')}
                        />
                      </div>
                      <div style={earningsWalletStripStyle}>
                        <div>
                          <span style={earningsWalletLabelStyle}>{isHebrew ? 'ממתין לתשלום' : 'Pending payout'}</span>
                          <strong style={earningsWalletValueStyle}>{formatMoney(flow.wallet.pendingEarnings)}</strong>
                        </div>
                        <div>
                          <span style={earningsWalletLabelStyle}>{isHebrew ? 'זמין' : 'Available'}</span>
                          <strong style={earningsWalletValueStyle}>{formatMoney(flow.wallet.availableBalance)}</strong>
                        </div>
                      </div>
                      {earningsHistoryItems.some((item) => item.isEstimated) && (
                        <div style={earningsEstimateNoteStyle}>
                          {isHebrew
                            ? 'חלק מהרווחים הם הערכה לפי 80% ממחיר ההזמנה.'
                            : 'Some earnings are estimated at 80% of request price.'}
                        </div>
                      )}
                    </div>

                    {!walletPayoutReady && (
                      <div style={earningsPayoutCtaStyle}>
                        <div>
                          <div style={earningsPayoutTitleStyle}>{isHebrew ? 'הגדרת תשלומים' : 'Set up payouts'}</div>
                          <div style={earningsPayoutSubtitleStyle}>
                            {isHebrew
                              ? 'השלם את Stripe Connect כדי לקבל תשלומים לחשבון שלך.'
                              : 'Complete Stripe Connect to receive payouts to your account.'}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            void handleStripeSetup(false)
                          }}
                          disabled={flow.connectLoading || isCheckingPayout}
                          style={{
                            ...earningsPayoutButtonStyle,
                            ...((flow.connectLoading || isCheckingPayout) ? walletSetupButtonDisabledStyle : null),
                          }}
                        >
                          {flow.connectLoading || isCheckingPayout
                            ? (isHebrew ? 'בודק...' : 'Checking...')
                            : (isHebrew ? 'הגדרת תשלומים' : 'Set up payouts')}
                        </button>
                      </div>
                    )}

                    <div style={earningsHistoryHeaderStyle}>
                      <span>
                        {isHebrew ? 'היסטוריית רווחים' : 'Earnings history'} · {selectedEarningsLabel}
                      </span>
                      <span>{earningsHistoryItems.length} · {formatMoney(selectedEarningsTotal)}</span>
                    </div>
                    {earningsHistoryItems.length === 0 ? (
                      <div style={emptyMenuCardStyle}>
                        {isHebrew ? 'אין עבודות שהושלמו בתקופה הזו.' : 'No completed jobs in this period.'}
                      </div>
                    ) : (
                      <div style={earningsHistoryListStyle}>
                        {earningsHistoryItems.map((item) => (
                          <div key={item.id} style={earningsHistoryCardStyle}>
                            <div style={earningsHistoryTopStyle}>
                              <div>
                                <div style={earningsHistoryTitleStyle}>{item.customerName}</div>
                                <div style={earningsHistoryMetaStyle}>
                                  <span>{item.dateLabel}</span>
                                  {item.timeLabel && <span>{item.timeLabel}</span>}
                                  <span>{item.serviceLabel}</span>
                                </div>
                              </div>
                              <div style={earningsHistoryAmountWrapStyle}>
                                <span style={earningsHistoryAmountLabelStyle}>
                                  {item.isEstimated
                                    ? (isHebrew ? 'רווח משוער' : 'Estimated earnings')
                                    : (isHebrew ? 'רווח' : 'Earnings')}
                                </span>
                                <span style={{
                                  ...earningsHistoryAmountStyle,
                                  ...(item.isEstimated ? earningsHistoryAmountEstimatedStyle : null),
                                }}>
                                  {item.earningsLabel}
                                </span>
                              </div>
                            </div>
                            <div style={earningsHistoryDetailGridStyle}>
                              <span>{isHebrew ? 'משך' : 'Duration'}: {item.durationLabel}</span>
                              <span>{isHebrew ? 'מחיר הזמנה' : 'Request price'}: {item.totalPriceLabel}</span>
                              <span>{isHebrew ? 'סטטוס' : 'Status'}: {item.statusLabel}</span>
                            </div>
                            {item.isEstimated && (
                              <div style={earningsFallbackStyle}>
                                {isHebrew
                                  ? 'הערכה לפי 80% ממחיר ההזמנה.'
                                  : 'Estimated at 80% of request price.'}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
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

                    <BurgerSection title={availabilitySectionTitle} subtitle={availabilitySectionSubtitle}>
                      <div style={availabilityIntroStyle}>{availabilityUnsetLabel}</div>
                      <div style={availabilityTimezonePillStyle}>{availabilityTimezoneLabel}</div>

                      {availabilityLoading ? (
                        <div style={availabilityLoadingStyle}>{isHebrew ? 'טוען שעות עבודה...' : 'Loading working hours...'}</div>
                      ) : availabilityError ? (
                        <div style={availabilityEmptyStyle}>{availabilityError}</div>
                      ) : profileServiceTypes.length === 0 ? (
                        <div style={availabilityEmptyStyle}>{availabilitySelectServiceLabel}</div>
                      ) : (
                        <>
                          {profileServiceTypes.map((serviceType) => (
                            <div key={serviceType} style={availabilityServiceCardStyle}>
                              <div style={availabilityServiceHeaderStyle}>
                                <div style={availabilityServiceTitleStyle}>
                                  {getProfileServiceTypeLabel(serviceType, isHebrew)}
                                </div>
                              </div>

                              <div style={availabilityGridStyle}>
                                {availabilityRows[serviceType].map((row, index) => {
                                  const rowKey = getAvailabilityRowKey(serviceType, row.dayOfWeek)
                                  const isExpanded = expandedAvailabilityKey === rowKey
                                  return (
                                    <div
                                      key={rowKey}
                                      style={{
                                        ...availabilityDayBlockStyle,
                                        ...(row.isActive ? availabilityDayBlockActiveStyle : null),
                                        ...(index > 0 ? availabilityDayBlockWithDividerStyle : null),
                                      }}
                                    >
                                      <button
                                        type="button"
                                        onClick={() => handleAvailabilityRowPress(serviceType, row)}
                                        style={availabilityRowButtonStyle}
                                      >
                                        <div style={availabilityRowDayWrapStyle}>
                                          <span style={availabilityDayLabelStyle}>{availabilityDayLabels[row.dayOfWeek]}</span>
                                        </div>

                                        <div style={availabilityRowMetaStyle}>
                                          <span style={row.isActive ? availabilityTimePillStyle : availabilityUnavailableTextStyle}>
                                            {row.isActive
                                              ? `${row.startTime} → ${row.endTime}`
                                              : availabilityUnavailableLabel}
                                          </span>
                                          <span
                                            style={{
                                              ...availabilityChevronStyle,
                                              ...(isExpanded ? availabilityChevronExpandedStyle : null),
                                            }}
                                          >
                                            ›
                                          </span>
                                        </div>
                                      </button>

                                      <button
                                        type="button"
                                        style={availabilityToggleShellStyle}
                                        aria-label={`${availabilityDayLabels[row.dayOfWeek]} ${availabilityEnabledLabel}`}
                                        aria-pressed={row.isActive}
                                        role="switch"
                                        onClick={(event) => {
                                          event.stopPropagation()
                                          handleAvailabilityToggle(serviceType, row.dayOfWeek, !row.isActive)
                                        }}
                                      >
                                        <span
                                          style={{
                                            ...availabilityToggleTrackStyle,
                                            ...(row.isActive ? availabilityToggleTrackActiveStyle : null),
                                          }}
                                        >
                                          <span
                                            style={{
                                              ...availabilityToggleThumbStyle,
                                              ...(row.isActive ? availabilityToggleThumbActiveStyle : null),
                                            }}
                                          />
                                        </span>
                                      </button>

                                      <div
                                        style={{
                                          ...availabilityEditorWrapStyle,
                                          ...(isExpanded ? availabilityEditorWrapExpandedStyle : null),
                                        }}
                                      >
                                        <div style={availabilityEditorStyle}>
                                          {row.isActive ? (
                                            <>
                                              <div style={availabilityEditorHeaderStyle}>{availabilityEditLabel}</div>
                                              <div style={availabilityTimeInputsStyle}>
                                                <label style={availabilityTimeFieldStyle}>
                                                  <span style={availabilityTimeLabelStyle}>{availabilityStartLabel}</span>
                                                  <input
                                                    type="time"
                                                    value={row.startTime}
                                                    onChange={(event) => {
                                                      handleAvailabilityRowChange(serviceType, row.dayOfWeek, {
                                                        startTime: event.target.value,
                                                      })
                                                    }}
                                                    style={availabilityTimeInputStyle}
                                                  />
                                                </label>

                                                <label style={availabilityTimeFieldStyle}>
                                                  <span style={availabilityTimeLabelStyle}>{availabilityEndLabel}</span>
                                                  <input
                                                    type="time"
                                                    value={row.endTime}
                                                    onChange={(event) => {
                                                      handleAvailabilityRowChange(serviceType, row.dayOfWeek, {
                                                        endTime: event.target.value,
                                                      })
                                                    }}
                                                    style={availabilityTimeInputStyle}
                                                  />
                                                </label>
                                              </div>
                                            </>
                                          ) : (
                                            <div style={availabilityEditorHintStyle}>{availabilityAutoEnableLabel}</div>
                                          )}
                                        </div>
                                      </div>
                                    </div>
                                  )
                                })}
                              </div>
                            </div>
                          ))}

                          <button
                            type="button"
                            onClick={() => {
                              void handleSaveAvailability()
                            }}
                            disabled={availabilitySaving}
                            style={{
                              ...availabilitySaveButtonStyle,
                              opacity: availabilitySaving ? 0.72 : 1,
                            }}
                          >
                            {availabilitySaving ? availabilitySavingLabel : availabilitySaveLabel}
                          </button>
                        </>
                      )}

                      {availabilityError && !availabilityLoading ? (
                        <div style={serviceTypeStatusErrorStyle}>{availabilityError}</div>
                      ) : !availabilitySaving && availabilitySavedAt > 0 ? (
                        <div style={serviceTypeStatusSuccessStyle}>{availabilitySavedLabel}</div>
                      ) : null}
                    </BurgerSection>

                    <BurgerSection
                      title={t('providerPricing.title')}
                      subtitle={t('providerPricing.subtitle')}
                    >
                      <ProviderPricingPreferences
                        providerId={profile.id}
                        serviceTypes={profileServiceTypes}
                      />
                    </BurgerSection>

                    <BurgerSection
                      title={isHebrew ? 'יכולות שירות' : 'Service capabilities'}
                      subtitle={isHebrew ? 'הגדר את ההעדפות והניסיון שלך.' : 'Define your preferences and experience.'}
                    >
                      {!capabilitiesOpen ? (
                        <button
                          type="button"
                          onClick={() => setCapabilitiesOpen(true)}
                          style={capToggleButtonStyle}
                        >
                          {isHebrew ? 'ערוך יכולות' : 'Edit capabilities'}
                        </button>
                      ) : (
                        <div style={capEditorStyle}>
                          {profileServiceTypes.includes('dog_walker') && (
                            <div style={capSectionStyle}>
                              {profileServiceTypes.length > 1 && (
                                <div style={capSectionLabelStyle}>
                                  {isHebrew ? 'הליכת כלבים' : 'Dog walking'}
                                </div>
                              )}

                              <div style={capFieldStyle}>
                                <div style={capFieldLabelStyle}>{isHebrew ? 'גדלי כלבים' : 'Dog sizes'}</div>
                                <div style={capChipRowStyle}>
                                  {(['S', 'M', 'L', 'XL'] as const).map((size) => {
                                    const sel = provDogSizes.includes(size)
                                    return (
                                      <button
                                        key={size}
                                        type="button"
                                        onClick={() => setProvDogSizes((prev) =>
                                          sel ? prev.filter((s) => s !== size) : [...prev, size]
                                        )}
                                        style={{ ...capChipStyle, ...(sel ? capChipSelectedStyle : null) }}
                                      >
                                        {size}
                                      </button>
                                    )
                                  })}
                                </div>
                              </div>

                              <div style={capFieldStyle}>
                                <div style={capFieldLabelStyle}>{isHebrew ? 'רמות אנרגיה' : 'Energy levels'}</div>
                                <div style={capChipRowStyle}>
                                  {(['low', 'medium', 'high'] as const).map((level) => {
                                    const sel = provDogEnergy.includes(level)
                                    const label = level === 'low' ? (isHebrew ? 'נמוך' : 'Low')
                                      : level === 'medium' ? (isHebrew ? 'בינוני' : 'Medium')
                                      : (isHebrew ? 'גבוה' : 'High')
                                    return (
                                      <button
                                        key={level}
                                        type="button"
                                        onClick={() => setProvDogEnergy((prev) =>
                                          sel ? prev.filter((s) => s !== level) : [...prev, level]
                                        )}
                                        style={{ ...capChipStyle, ...(sel ? capChipSelectedStyle : null) }}
                                      >
                                        {label}
                                      </button>
                                    )
                                  })}
                                </div>
                              </div>

                              <div style={capFieldStyle}>
                                <div style={capFieldLabelStyle}>{isHebrew ? 'שנות ניסיון' : 'Experience'}</div>
                                <div style={capChipRowStyle}>
                                  {[0, 1, 2, 3, 5, 10].map((yr) => (
                                    <button
                                      key={yr}
                                      type="button"
                                      onClick={() => setProvDogExp(yr)}
                                      style={{ ...capChipStyle, ...(provDogExp === yr ? capChipSelectedStyle : null) }}
                                    >
                                      {yr === 0 ? (isHebrew ? 'חדש' : 'New') : `${yr}+`}
                                    </button>
                                  ))}
                                </div>
                              </div>

                              <div style={capFieldStyle}>
                                <div style={capFieldLabelStyle}>{isHebrew ? 'הערות' : 'Notes'}</div>
                                <textarea
                                  value={provDogNotes}
                                  onChange={(e) => setProvDogNotes(e.target.value)}
                                  placeholder={isHebrew ? 'לדוגמה: נוח עם כלבים גדולים' : 'e.g. Comfortable with large dogs'}
                                  rows={2}
                                  style={capTextareaStyle}
                                />
                              </div>
                            </div>
                          )}

                          {profileServiceTypes.includes('baby_sitter') && (
                            <div style={capSectionStyle}>
                              {profileServiceTypes.length > 1 && (
                                <div style={capSectionLabelStyle}>
                                  {isHebrew ? 'שמרטפות' : 'Baby sitting'}
                                </div>
                              )}

                              <div style={capFieldStyle}>
                                <div style={capFieldLabelStyle}>{isHebrew ? 'טווחי גילאים' : 'Age ranges'}</div>
                                <div style={capChipRowStyle}>
                                  {(['1-2', '2-4', '5-7', '7+'] as const).map((range) => {
                                    const sel = provSitterAges.includes(range)
                                    const label = range === '1-2' ? '1–2' : range === '2-4' ? '2–4' : range === '5-7' ? '5–7' : '7+'
                                    return (
                                      <button
                                        key={range}
                                        type="button"
                                        onClick={() => setProvSitterAges((prev) =>
                                          sel ? prev.filter((s) => s !== range) : [...prev, range]
                                        )}
                                        style={{ ...capChipStyle, ...(sel ? capChipSelectedStyle : null) }}
                                      >
                                        {label}
                                      </button>
                                    )
                                  })}
                                </div>
                              </div>

                              <div style={capFieldStyle}>
                                <div style={capFieldLabelStyle}>{isHebrew ? 'שנות ניסיון' : 'Experience'}</div>
                                <div style={capChipRowStyle}>
                                  {[0, 1, 2, 3, 5, 10].map((yr) => (
                                    <button
                                      key={yr}
                                      type="button"
                                      onClick={() => setProvSitterExp(yr)}
                                      style={{ ...capChipStyle, ...(provSitterExp === yr ? capChipSelectedStyle : null) }}
                                    >
                                      {yr === 0 ? (isHebrew ? 'חדש' : 'New') : `${yr}+`}
                                    </button>
                                  ))}
                                </div>
                              </div>

                              <div style={capFieldStyle}>
                                <div style={capFieldLabelStyle}>{isHebrew ? 'הערות' : 'Notes'}</div>
                                <textarea
                                  value={provSitterNotes}
                                  onChange={(e) => setProvSitterNotes(e.target.value)}
                                  placeholder={isHebrew ? 'לדוגמה: מנוסה עם תינוקות' : 'e.g. Experienced with infants'}
                                  rows={2}
                                  style={capTextareaStyle}
                                />
                              </div>
                            </div>
                          )}

                          <button
                            type="button"
                            onClick={() => void handleSaveCapabilities()}
                            disabled={capSaving || !capDirty}
                            style={{
                              ...capSaveButtonStyle,
                              ...(capSaving || !capDirty ? capSaveButtonDisabledStyle : null),
                            }}
                          >
                            {capSaving
                              ? (isHebrew ? 'שומר...' : 'Saving...')
                              : (isHebrew ? 'שמור יכולות' : 'Save capabilities')}
                          </button>

                          {capError && <div style={serviceTypeStatusErrorStyle}>{capError}</div>}
                          {!capSaving && capSavedAt > 0 && !capDirty && !capError && (
                            <div style={serviceTypeStatusSuccessStyle}>
                              {isHebrew ? 'היכולות נשמרו.' : 'Capabilities saved.'}
                            </div>
                          )}
                        </div>
                      )}
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
                      <MenuNavRow icon="₪" label={isHebrew ? 'רווחים' : 'Earnings'} onClick={() => setMenuPage('earnings')} />
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

          {flow.screenState === 'offline' && renderHomeDashboard(false)}

          {flow.screenState === 'waiting' && renderHomeDashboard(true)}

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
                {isDogServiceType(onTheWayJob.service_type) ? ` · ${formatDogCountLabel(onTheWayJob.dog_count ?? 1, { isHebrew })}` : ''}
              </p>

              {onTheWayJob.location && (
                <div style={activeLocationStyle}>
                  <span style={ellipsisStyle}>{formatShortAddress(onTheWayJob.address || onTheWayJob.location)}</span>
                </div>
              )}

              {(flow.screenPhase === 'arrived_pending_confirmation' || flow.screenPhase === 'arrival_confirmed') && (
                <div style={waitingStateStyle}>
                  <div style={waitingStateTitleStyle}>
                    {onTheWayJobHasProviderIssue
                      ? (isHebrew ? 'ממתין לבדיקת התמיכה' : 'Waiting for support review')
                      : flow.screenPhase === 'arrived_pending_confirmation'
                      ? (isHebrew ? 'ממתין לאישור הלקוח' : 'Waiting for client to confirm arrival')
                      : (isHebrew ? 'הגעה אושרה' : 'Arrival confirmed')}
                  </div>
                  <div style={waitingStateBodyStyle}>
                    {onTheWayJobHasProviderIssue
                      ? (
                          isHebrew
                            ? 'השירות חסום כרגע. דיווחת על בעיה והבקשה ממתינה לבדיקה של צוות התמיכה.'
                            : 'Service is blocked right now. You reported an issue and the request is waiting for support review.'
                        )
                      : flow.screenPhase === 'arrived_pending_confirmation'
                      ? (isHebrew ? 'השירות יתחיל ברגע שהלקוח יאשר שהגעת.' : 'The service can start as soon as the client confirms you are with them.')
                      : (isHebrew ? 'אפשר להתחיל את השירות.' : 'You can start the service now.')}
                  </div>
                  {onTheWayJobHasProviderIssue ? (
                    <div style={reportIssueFeedbackStyle}>
                      {isHebrew ? 'השירות יישאר מושהה עד לעדכון מהתמיכה.' : 'The service will stay paused until support updates the request.'}
                    </div>
                  ) : reportIssueFeedback ? (
                    <div style={reportIssueFeedbackStyle}>
                      {reportIssueFeedback}
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setReportIssueOpen(true)}
                      disabled={reportIssueSubmitting}
                      style={reportIssueBtnStyle}
                    >
                      {isHebrew ? 'דיווח על בעיה' : 'Report an issue'}
                    </button>
                  )}
                </div>
              )}

              {(!onTheWayJobHasProviderIssue || flow.screenPhase === 'on_the_way') && (
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
              )}
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
                {isDogServiceType(activeJob.service_type) ? ` · ${formatDogCountLabel(activeJob.dog_count ?? 1, { isHebrew })}` : ''}
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

              {activeJobHasProviderIssue && (
                <div style={waitingStateStyle}>
                  <div style={waitingStateTitleStyle}>
                    {isHebrew ? 'ממתין לבדיקת התמיכה' : 'Waiting for support review'}
                  </div>
                  <div style={waitingStateBodyStyle}>
                    {isHebrew
                      ? 'השירות חסום עד שהבקשה תיבדק ותקבל עדכון מצוות התמיכה.'
                      : 'Service is blocked until support reviews the request and sends an update.'}
                  </div>
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

              {!activeJobHasProviderIssue && (
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
              )}
            </div>
          )}

          </div>
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
                <div style={incomingInfoLabelStyle}>
                  {isBabysitterRequest ? (isHebrew ? 'פרטי שירות' : 'Service details') : (isHebrew ? 'שם הזמנה' : 'Order name')}
                </div>
                <div style={dogNameStyle}>
                  {isBabysitterRequest
                    ? babysitterRequestNotes.details || topRequest.dog_name || (isHebrew ? 'שירות בייביסיטר' : 'Babysitter service')
                    : topRequest.dog_name || t('booking.walkFallback')}
                </div>
              </div>

              {(isBabysitterRequest ? babysitterRequestNotes.startTime : topRequest.location) && (
                <div style={reqLocationStyle}>
                  <div style={incomingInfoLabelStyle}>{isBabysitterRequest ? (isHebrew ? 'מועד התחלה' : 'Requested time') : (isHebrew ? 'כתובת' : 'Location')}</div>
                  <span style={ellipsisStyle}>
                    {isBabysitterRequest
                      ? babysitterRequestNotes.startTime
                      : formatShortAddress(topRequest.address || topRequest.location)}
                  </span>
                </div>
              )}

              <div style={incomingMetaRowStyle}>
                <div style={incomingMetaCardStyle}>
                  <span style={incomingMetaLabelStyle}>
                    {isBabysitterRequest ? (isHebrew ? 'משך מבוקש' : 'Requested duration') : t('booking.durationQuestion')}
                  </span>
                  <span style={incomingMetaValueStyle}>
                    {isBabysitterRequest
                      ? babysitterRequestNotes.duration || requestDuration
                      : `${requestDuration}${isDogServiceType(topRequest.service_type) ? ` · ${requestDogCountLabel}` : ''}`}
                  </span>
                </div>
                <div style={incomingMetaCardStyle}>
                  <span style={incomingMetaLabelStyle}>
                    {isBabysitterRequest ? (isHebrew ? 'תקציב לקוח' : 'Client budget') : t('booking.priceLabel')}
                  </span>
                  <span style={{ ...incomingMetaValueStyle, color: '#15803D' }}>
                    {requestPrice !== '—' ? requestPrice : isBabysitterRequest ? babysitterRequestNotes.budget || '—' : '—'}
                  </span>
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

      {reportIssueOpen && (
        <div style={completionOverlayStyle}>
          <div style={completionOverlayBackdropStyle} onClick={() => setReportIssueOpen(false)} />
          <div
            style={{
              ...completionOverlayCardStyle,
              background: 'linear-gradient(180deg, rgba(14,17,22,0.94) 0%, rgba(20,24,31,0.96) 100%)',
              border: '1px solid rgba(148, 163, 184, 0.12)',
              borderRadius: 30,
              padding: '22px 18px calc(18px + env(safe-area-inset-bottom, 0px))',
              boxShadow: '0 20px 40px rgba(2, 6, 23, 0.30), inset 0 1px 0 rgba(255,255,255,0.04)',
              backdropFilter: 'blur(24px)',
              WebkitBackdropFilter: 'blur(24px)',
            }}
          >
            <div style={{ textAlign: 'center', fontSize: 28, marginBottom: 12 }}>⚠️</div>
            <div style={{ textAlign: 'center', fontWeight: 800, fontSize: 17, color: '#F8FAFC', marginBottom: 8 }}>
              {isHebrew ? 'דיווח בעיה' : 'Report Issue'}
            </div>
            <div style={{ textAlign: 'center', fontSize: 14, color: 'rgba(203, 213, 225, 0.86)', lineHeight: 1.5, marginBottom: 20 }}>
              {isHebrew
                ? 'אם אינך יכול להתחיל את השירות, צוות התמיכה ייצור איתך קשר.'
                : 'If you cannot start the service, our support team will follow up with you.'}
            </div>
            <button
              type="button"
              disabled={reportIssueSubmitting}
              onClick={async () => {
                const jobId = onTheWayJob?.id ?? activeJob?.id
                if (!jobId) return
                setReportIssueSubmitting(true)
                const ok = await flow.reportIssue(jobId)
                setReportIssueSubmitting(false)
                setReportIssueOpen(false)
                if (ok) {
                  setReportIssueFeedback(isHebrew ? 'הדיווח נשלח. צוות התמיכה יבדוק.' : 'Issue reported. Support will review.')
                  setTimeout(() => setReportIssueFeedback(null), 5000)
                }
              }}
              style={{ ...completeBtnStyle, background: '#DC2626', maxWidth: '100%', width: '100%', opacity: reportIssueSubmitting ? 0.6 : 1 }}
            >
              {reportIssueSubmitting
                ? (isHebrew ? 'שולח...' : 'Submitting...')
                : (isHebrew ? 'שלח דיווח' : 'Submit report')}
            </button>
            <button
              type="button"
              disabled={reportIssueSubmitting}
              onClick={() => setReportIssueOpen(false)}
              style={dismissBtnStyle}
            >
              {isHebrew ? 'ביטול' : 'Cancel'}
            </button>
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

function EarningsMetric({
  label,
  value,
  selected,
  onClick,
}: {
  label: string
  value: string
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        ...earningsMetricStyle,
        ...(selected ? earningsMetricSelectedStyle : null),
      }}
    >
      <span style={earningsMetricLabelStyle}>{label}</span>
      <strong style={earningsMetricValueStyle}>{value}</strong>
    </button>
  )
}

function RadarVisual() {
  return (
    <div style={waitingCardVisualStyle} aria-hidden="true">
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

const dashboardBackgroundStyle: React.CSSProperties = {
  minHeight: '100dvh',
  background: 'linear-gradient(180deg, #FAFBFD 0%, #F4F7FB 100%)',
}

const headerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'stretch',
  gap: 8,
  margin: 'calc(14px + env(safe-area-inset-top)) 18px 10px',
  padding: '0',
  position: 'sticky',
  top: 0,
  zIndex: 20,
  background: 'linear-gradient(180deg, rgba(250,251,253,0.96) 0%, rgba(250,251,253,0.88) 72%, rgba(250,251,253,0) 100%)',
  backdropFilter: 'blur(10px)',
  WebkitBackdropFilter: 'blur(10px)',
}

const headerMenuBtnStyle: React.CSSProperties = {
  width: 42,
  height: 42,
  borderRadius: 16,
  border: '1px solid rgba(226,232,240,0.9)',
  background: 'rgba(255,255,255,0.96)',
  boxShadow: '0 8px 20px rgba(15, 23, 42, 0.05)',
  display: 'grid',
  placeItems: 'center',
  cursor: 'pointer',
}

const greetingStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 24,
  fontWeight: 900,
  lineHeight: 1.1,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const headerSubtitleStyle: React.CSSProperties = {
  fontSize: 12,
  lineHeight: 1.35,
  color: '#64748B',
  fontWeight: 600,
}

const headerTopRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
}

const headerIdentityRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  padding: '0',
  minWidth: 0,
}

const headerIdentityStyle: React.CSSProperties = {
  minWidth: 0,
  flex: 1,
  display: 'grid',
  gap: 2,
}

const headerActionsStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
}

const bellWrapStyle: React.CSSProperties = {
  width: 42,
  height: 42,
  borderRadius: 16,
  background: 'rgba(255,255,255,0.96)',
  border: '1px solid rgba(226,232,240,0.9)',
  boxShadow: '0 8px 20px rgba(15, 23, 42, 0.05)',
  display: 'grid',
  placeItems: 'center',
}

const activeSessionChipStyle: React.CSSProperties = {
  alignSelf: 'flex-start',
  padding: '7px 10px',
  borderRadius: 999,
  background: 'rgba(224, 242, 254, 0.96)',
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

const earningsHeroCardStyle: React.CSSProperties = {
  border: '1px solid rgba(15, 23, 42, 0.08)',
  background: 'linear-gradient(180deg, #111827 0%, #1F2937 100%)',
  borderRadius: 24,
  padding: 18,
  color: '#FFFFFF',
  display: 'grid',
  gap: 16,
  boxShadow: '0 18px 45px rgba(15, 23, 42, 0.20)',
}

const earningsHeroTopButtonStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 12,
  alignItems: 'flex-start',
  width: '100%',
  border: '1px solid rgba(255, 255, 255, 0.10)',
  background: 'rgba(255, 255, 255, 0.04)',
  borderRadius: 18,
  padding: 12,
  color: 'inherit',
  textAlign: 'start',
  cursor: 'pointer',
}

const earningsHeroTopButtonActiveStyle: React.CSSProperties = {
  borderColor: 'rgba(255, 255, 255, 0.34)',
  background: 'rgba(255, 255, 255, 0.10)',
}

const earningsHeroLabelStyle: React.CSSProperties = {
  fontSize: 13,
  color: 'rgba(255, 255, 255, 0.72)',
  fontWeight: 800,
}

const earningsHeroValueStyle: React.CSSProperties = {
  marginTop: 4,
  fontSize: 34,
  lineHeight: 1,
  fontWeight: 900,
}

const earningsHeroBadgeStyle: React.CSSProperties = {
  border: '1px solid rgba(255, 255, 255, 0.18)',
  background: 'rgba(255, 255, 255, 0.10)',
  borderRadius: 999,
  padding: '8px 10px',
  fontSize: 12,
  fontWeight: 900,
  whiteSpace: 'nowrap',
}

const earningsMetricGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  gap: 8,
}

const earningsMetricStyle: React.CSSProperties = {
  minWidth: 0,
  border: '1px solid rgba(255, 255, 255, 0.14)',
  background: 'rgba(255, 255, 255, 0.08)',
  borderRadius: 16,
  padding: 10,
  display: 'grid',
  gap: 4,
  textAlign: 'start',
  cursor: 'pointer',
}

const earningsMetricSelectedStyle: React.CSSProperties = {
  borderColor: 'rgba(255, 255, 255, 0.38)',
  background: 'rgba(255, 255, 255, 0.16)',
  boxShadow: 'inset 0 0 0 1px rgba(255, 255, 255, 0.10)',
}

const earningsMetricLabelStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'rgba(255, 255, 255, 0.68)',
  fontWeight: 800,
}

const earningsMetricValueStyle: React.CSSProperties = {
  fontSize: 16,
  color: '#FFFFFF',
  fontWeight: 900,
  overflowWrap: 'anywhere',
}

const earningsWalletStripStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 10,
  borderTop: '1px solid rgba(255, 255, 255, 0.12)',
  paddingTop: 14,
}

const earningsWalletLabelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  color: 'rgba(255, 255, 255, 0.68)',
  fontWeight: 800,
  marginBottom: 4,
}

const earningsWalletValueStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 900,
}

const earningsEstimateNoteStyle: React.CSSProperties = {
  fontSize: 12,
  lineHeight: 1.45,
  color: 'rgba(255, 255, 255, 0.74)',
}

const earningsPayoutCtaStyle: React.CSSProperties = {
  border: '1px solid rgba(245, 158, 11, 0.28)',
  background: '#FFFBEB',
  borderRadius: 20,
  padding: 16,
  display: 'grid',
  gap: 14,
}

const earningsPayoutTitleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 900,
  color: '#92400E',
}

const earningsPayoutSubtitleStyle: React.CSSProperties = {
  marginTop: 4,
  fontSize: 13,
  lineHeight: 1.5,
  color: '#A16207',
}

const earningsPayoutButtonStyle: React.CSSProperties = {
  border: 'none',
  borderRadius: 16,
  padding: '13px 16px',
  background: '#111827',
  color: '#FFFFFF',
  fontSize: 14,
  fontWeight: 900,
  cursor: 'pointer',
}

const earningsHistoryHeaderStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  fontSize: 14,
  fontWeight: 900,
  color: '#0F172A',
}

const earningsHistoryListStyle: React.CSSProperties = {
  display: 'grid',
  gap: 12,
}

const earningsHistoryCardStyle: React.CSSProperties = {
  border: '1px solid #E2E8F0',
  background: '#FFFFFF',
  borderRadius: 20,
  padding: 14,
  display: 'grid',
  gap: 12,
}

const earningsHistoryTopStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  gap: 12,
}

const earningsHistoryTitleStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 900,
  color: '#0F172A',
}

const earningsHistoryMetaStyle: React.CSSProperties = {
  marginTop: 5,
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
  fontSize: 12,
  color: '#64748B',
  fontWeight: 700,
}

const earningsHistoryAmountStyle: React.CSSProperties = {
  fontSize: 17,
  fontWeight: 900,
  color: '#047857',
  whiteSpace: 'nowrap',
}

const earningsHistoryAmountWrapStyle: React.CSSProperties = {
  display: 'grid',
  justifyItems: 'end',
  gap: 3,
  textAlign: 'end',
}

const earningsHistoryAmountLabelStyle: React.CSSProperties = {
  fontSize: 10,
  color: '#64748B',
  fontWeight: 900,
  textTransform: 'uppercase',
  letterSpacing: 0,
}

const earningsHistoryAmountEstimatedStyle: React.CSSProperties = {
  color: '#64748B',
}

const earningsHistoryDetailGridStyle: React.CSSProperties = {
  display: 'grid',
  gap: 6,
  fontSize: 12,
  color: '#475569',
  fontWeight: 700,
}

const earningsFallbackStyle: React.CSSProperties = {
  borderTop: '1px solid #F1F5F9',
  paddingTop: 10,
  fontSize: 12,
  color: '#A16207',
  fontWeight: 800,
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

const availabilityIntroStyle: React.CSSProperties = {
  marginBottom: 10,
  fontSize: 13,
  lineHeight: 1.5,
  color: '#64748B',
  fontWeight: 600,
}

const availabilityTimezonePillStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  minHeight: 32,
  padding: '0 12px',
  borderRadius: 999,
  background: '#F3F7FB',
  border: '1px solid #E2E8F0',
  color: '#475569',
  fontSize: 12,
  fontWeight: 700,
  marginBottom: 14,
}

const availabilityLoadingStyle: React.CSSProperties = {
  padding: '16px 18px',
  borderRadius: 20,
  border: '1px dashed #CBD5E1',
  background: '#F8FAFC',
  color: '#64748B',
  fontSize: 14,
  fontWeight: 600,
}

const availabilityEmptyStyle: React.CSSProperties = {
  padding: '16px 18px',
  borderRadius: 20,
  border: '1px dashed #CBD5E1',
  background: '#F8FAFC',
  color: '#64748B',
  fontSize: 14,
  fontWeight: 600,
}

const availabilityServiceCardStyle: React.CSSProperties = {
  marginBottom: 12,
  padding: '12px 14px',
  borderRadius: 24,
  border: '1px solid #E7EDF4',
  background: '#FFFFFF',
  boxShadow: '0 14px 34px rgba(15, 23, 42, 0.06)',
}

const availabilityServiceHeaderStyle: React.CSSProperties = {
  marginBottom: 8,
}

const availabilityServiceTitleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 800,
  color: '#0F172A',
}

const availabilityGridStyle: React.CSSProperties = {
  display: 'grid',
}

const availabilityDayBlockStyle: React.CSSProperties = {
  position: 'relative',
  borderRadius: 16,
  transition: 'background-color 180ms ease, border-color 180ms ease',
}

const availabilityDayBlockActiveStyle: React.CSSProperties = {
  background: '#FBFDFF',
}

const availabilityDayBlockWithDividerStyle: React.CSSProperties = {
  borderTop: '1px solid #EEF2F7',
}

const availabilityRowButtonStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 54,
  padding: '0 66px 0 0',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  background: 'transparent',
  border: 'none',
  textAlign: 'left',
  cursor: 'pointer',
}

const availabilityRowDayWrapStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  minWidth: 42,
}

const availabilityDayLabelStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 700,
  color: '#0F172A',
}

const availabilityRowMetaStyle: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: 8,
  minWidth: 0,
}

const availabilityTimePillStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  minHeight: 30,
  maxWidth: '100%',
  padding: '0 11px',
  borderRadius: 999,
  background: '#F7FBFF',
  border: '1px solid #E6EEF6',
  color: '#0F172A',
  fontSize: 14,
  fontWeight: 700,
  whiteSpace: 'nowrap',
}

const availabilityUnavailableTextStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 500,
  color: '#A1ACBB',
}

const availabilityChevronStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 20,
  lineHeight: 1,
  color: '#94A3B8',
  fontWeight: 700,
  transition: 'transform 180ms ease, color 180ms ease',
}

const availabilityChevronExpandedStyle: React.CSSProperties = {
  transform: 'rotate(90deg)',
  color: '#64748B',
}

const availabilityToggleShellStyle: React.CSSProperties = {
  position: 'absolute',
  top: 10,
  right: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 54,
  height: 34,
  cursor: 'pointer',
}

const availabilityToggleTrackStyle: React.CSSProperties = {
  position: 'relative',
  width: 46,
  height: 28,
  borderRadius: 999,
  background: '#D5DDE7',
  transition: 'background 160ms ease',
  boxShadow: 'inset 0 0 0 1px rgba(15,23,42,0.04)',
}

const availabilityToggleTrackActiveStyle: React.CSSProperties = {
  background: '#22C55E',
}

const availabilityToggleThumbStyle: React.CSSProperties = {
  position: 'absolute',
  top: 3,
  left: 3,
  width: 22,
  height: 22,
  borderRadius: '50%',
  background: '#FFFFFF',
  boxShadow: '0 2px 6px rgba(15, 23, 42, 0.18)',
  transition: 'transform 160ms ease',
}

const availabilityToggleThumbActiveStyle: React.CSSProperties = {
  transform: 'translateX(18px)',
}

const availabilityEditorStyle: React.CSSProperties = {
  padding: '0 0 6px',
}

const availabilityEditorWrapStyle: React.CSSProperties = {
  maxHeight: 0,
  opacity: 0,
  overflow: 'hidden',
  transform: 'translateY(-4px)',
  transition: 'max-height 220ms ease, opacity 180ms ease, transform 180ms ease',
}

const availabilityEditorWrapExpandedStyle: React.CSSProperties = {
  maxHeight: 148,
  opacity: 1,
  transform: 'translateY(0)',
}

const availabilityEditorHeaderStyle: React.CSSProperties = {
  marginBottom: 6,
  fontSize: 11,
  fontWeight: 800,
  color: '#64748B',
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
}

const availabilityEditorHintStyle: React.CSSProperties = {
  padding: '0 0 2px',
  fontSize: 12,
  lineHeight: 1.45,
  color: '#94A3B8',
}

const availabilityTimeInputsStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 8,
}

const availabilityTimeFieldStyle: React.CSSProperties = {
  display: 'grid',
  gap: 4,
}

const availabilityTimeLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  color: '#7B8794',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
}

const availabilityTimeInputStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 40,
  borderRadius: 14,
  border: '1px solid #E7EDF4',
  background: '#FBFCFE',
  color: '#0F172A',
  fontSize: 14,
  fontWeight: 600,
  padding: '0 11px',
  boxSizing: 'border-box',
}

const availabilitySaveButtonStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 48,
  marginTop: 12,
  borderRadius: 16,
  border: 'none',
  background: '#08153B',
  color: '#FFFFFF',
  fontSize: 15,
  fontWeight: 800,
  cursor: 'pointer',
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
  padding: '6px 18px calc(24px + env(safe-area-inset-bottom))',
  display: 'grid',
  gap: 12,
  boxSizing: 'border-box',
}

const homeDashboardTopStackStyle: React.CSSProperties = {
  display: 'grid',
  gap: 14,
  marginBottom: 4,
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

const homeStatusCardStyle: React.CSSProperties = {
  position: 'relative',
  overflow: 'hidden',
  padding: '15px 18px',
  borderRadius: 28,
  background:
    'linear-gradient(180deg, #FFFFFF 0%, #F9FBFD 100%)',
  border: '1px solid rgba(226,232,240,0.95)',
  boxShadow: '0 14px 28px rgba(15,23,42,0.06)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 14,
}

const homeStatusCardOnlineStyle: React.CSSProperties = {
  background:
    'linear-gradient(180deg, #FFFFFF 0%, #F8FCFA 100%)',
}

const homeStatusContentStyle: React.CSSProperties = {
  position: 'relative',
  zIndex: 1,
  display: 'grid',
  gap: 4,
  minWidth: 0,
}

const homeStatusRightStyle: React.CSSProperties = {
  position: 'relative',
  width: 72,
  height: 62,
  display: 'grid',
  placeItems: 'center',
  flexShrink: 0,
}

const homeStatusAccentOrbStyle: React.CSSProperties = {
  position: 'absolute',
  right: -8,
  top: -6,
  width: 74,
  height: 74,
  borderRadius: '50%',
  background: 'radial-gradient(circle, rgba(34,197,94,0.16) 0%, rgba(34,197,94,0.04) 52%, rgba(34,197,94,0) 74%)',
}

const homeStatusBadgeStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  justifySelf: 'start',
  padding: '5px 9px',
  borderRadius: 999,
  background: 'rgba(34, 197, 94, 0.10)',
  color: '#15803D',
  fontSize: 10,
  fontWeight: 800,
}

const homeStatusDotStyle: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: '50%',
  background: '#22C55E',
  boxShadow: '0 0 0 4px rgba(34, 197, 94, 0.12)',
}

const homeStatusToggleStyle: React.CSSProperties = {
  position: 'relative',
  zIndex: 1,
  width: 50,
  height: 30,
  borderRadius: 999,
  border: 'none',
  padding: 3,
  boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.24)',
  cursor: 'pointer',
  transition: 'background 0.2s ease',
}

const homeStatusToggleKnobStyle: React.CSSProperties = {
  width: 24,
  height: 24,
  borderRadius: '50%',
  background: '#FFFFFF',
  boxShadow: '0 6px 14px rgba(15,23,42,0.16)',
  transition: 'transform 0.2s ease',
}

const homeStatusTitleStyle: React.CSSProperties = {
  fontSize: 19,
  lineHeight: 1.08,
  fontWeight: 900,
  color: '#0F172A',
}

const homeStatusBodyStyle: React.CSSProperties = {
  fontSize: 11,
  lineHeight: 1.35,
  color: '#64748B',
}

const todayAvailabilityCardStyle: React.CSSProperties = {
  borderRadius: 24,
  background: 'linear-gradient(180deg, #FFFFFF 0%, #FBFCFE 100%)',
  border: '1px solid #E7EDF4',
  boxShadow: '0 12px 24px rgba(15,23,42,0.04)',
  padding: '12px 14px 10px',
  display: 'grid',
  gap: 7,
}

const todayAvailabilityHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
}

const todayAvailabilityTitleStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 800,
  color: '#0F172A',
}

const todayAvailabilityManageButtonStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  border: 'none',
  background: 'transparent',
  padding: 0,
  color: '#2563EB',
  fontSize: 12,
  fontWeight: 700,
  cursor: 'pointer',
}

const todayAvailabilityManageChevronStyle: React.CSSProperties = {
  fontSize: 16,
  lineHeight: 1,
}

const todayAvailabilityListStyle: React.CSSProperties = {
  display: 'grid',
}

const todayAvailabilityRowStyle: React.CSSProperties = {
  minHeight: 44,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
}

const todayAvailabilityRowWithDividerStyle: React.CSSProperties = {
  borderTop: '1px solid #EEF2F7',
}

const todayAvailabilityServiceLabelStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: '#0F172A',
}

const todayAvailabilityServiceWrapStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  minWidth: 0,
}

const todayAvailabilityServiceIconStyle: React.CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 11,
  display: 'grid',
  placeItems: 'center',
  background: '#F4F7FB',
  border: '1px solid #E6EDF5',
  fontSize: 14,
  lineHeight: 1,
  flexShrink: 0,
}

const todayAvailabilityTimePillStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  minHeight: 26,
  padding: '0 9px',
  borderRadius: 999,
  background: '#F7FBFF',
  border: '1px solid #E4EDF6',
  color: '#0F172A',
  fontSize: 12,
  fontWeight: 700,
  whiteSpace: 'nowrap',
}

const todayAvailabilityUnavailableStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: '#94A3B8',
}

const waitingCardStyle: React.CSSProperties = {
  position: 'relative',
  overflow: 'hidden',
  borderRadius: 24,
  background:
    'radial-gradient(circle at 80% 40%, rgba(91,124,250,0.12) 0%, rgba(91,124,250,0.03) 28%, rgba(255,255,255,0) 54%), linear-gradient(180deg, #FFFFFF 0%, #F8FAFC 100%)',
  border: '1px solid #E4EBF3',
  boxShadow: '0 12px 24px rgba(15,23,42,0.04)',
  padding: '12px 14px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
}

const waitingCardCopyStyle: React.CSSProperties = {
  display: 'grid',
  gap: 4,
  minWidth: 0,
}

const waitingCardTitleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 800,
  color: '#0F172A',
}

const waitingCardBodyStyle: React.CSSProperties = {
  fontSize: 12,
  lineHeight: 1.45,
  color: '#64748B',
}

const waitingCardVisualWrapStyle: React.CSSProperties = {
  width: 92,
  minWidth: 92,
  opacity: 0.96,
}

const waitingCardVisualStyle: React.CSSProperties = {
  position: 'relative',
  height: 72,
  borderRadius: 16,
  background:
    'radial-gradient(circle at center, rgba(91,124,250,0.12) 0%, rgba(91,124,250,0.04) 28%, rgba(255,255,255,0) 29%), linear-gradient(180deg, rgba(255,255,255,0.86) 0%, rgba(248,250,252,0.98) 100%)',
  border: '1px solid rgba(226,232,240,0.9)',
  display: 'grid',
  placeItems: 'center',
}

const dashboardSectionStyle: React.CSSProperties = {
  display: 'grid',
  gap: 8,
}

const dashboardSectionTitleStyle: React.CSSProperties = {
  fontSize: 17,
  fontWeight: 800,
  color: '#0F172A',
}

const performanceGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 8,
}

const performanceMetricCardStyle: React.CSSProperties = {
  padding: '11px 12px 10px',
  borderRadius: 20,
  background: '#FFFFFF',
  border: '1px solid #E7EDF4',
  boxShadow: '0 8px 16px rgba(15,23,42,0.035)',
  display: 'grid',
  gap: 6,
}

const performanceMetricIconStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 10,
  display: 'grid',
  placeItems: 'center',
  fontSize: 14,
  lineHeight: 1,
}

const performanceMetricValueStyle: React.CSSProperties = {
  fontSize: 20,
  fontWeight: 900,
  color: '#0F172A',
}

const performanceMetricMetaStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: '#64748B',
  lineHeight: 1.3,
}

const walletDashboardGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 8,
}

const walletDashboardMetricCardStyle: React.CSSProperties = {
  padding: '11px 12px 10px',
  borderRadius: 20,
  background: '#FFFFFF',
  border: '1px solid #E7EDF4',
  boxShadow: '0 8px 16px rgba(15,23,42,0.035)',
  display: 'grid',
  gap: 5,
}

const walletDashboardMetricLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: '#64748B',
  lineHeight: 1.35,
}

const walletDashboardMetricValueStyle: React.CSSProperties = {
  fontSize: 19,
  fontWeight: 900,
  color: '#0F172A',
}

const walletDashboardStatusRowStyle: React.CSSProperties = {
  minHeight: 32,
  padding: '0 2px',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flexWrap: 'wrap',
}

const walletDashboardReadyStyle: React.CSSProperties = {
  fontSize: 11,
  lineHeight: 1.35,
  color: '#15803D',
  fontWeight: 800,
  padding: '6px 10px',
  borderRadius: 999,
  background: 'rgba(34, 197, 94, 0.10)',
}

const walletStatusNeutralStyle: React.CSSProperties = {
  fontSize: 11,
  lineHeight: 1.35,
  color: '#64748B',
  fontWeight: 700,
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
  background: 'transparent',
  border: '1px solid rgba(148, 163, 184, 0.10)',
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
  color: 'rgba(148, 163, 184, 0.82)',
}

const serviceTimerValueStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 800,
  color: '#F8FAFC',
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
  color: 'rgba(203, 213, 225, 0.84)',
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
  color: '#F8FAFC',
}

const completionSubStyle: React.CSSProperties = {
  margin: 0,
  textAlign: 'center',
  color: 'rgba(203, 213, 225, 0.86)',
  fontWeight: 700,
}

const reportIssueBtnStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 36,
  borderRadius: 10,
  border: '1px solid rgba(220, 38, 38, 0.25)',
  background: '#FEF2F2',
  color: '#B91C1C',
  fontSize: 12,
  fontWeight: 700,
  fontFamily: 'inherit',
  cursor: 'pointer',
  marginTop: 8,
  padding: '0 12px',
}

const reportIssueFeedbackStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: '#16A34A',
  textAlign: 'center',
  marginTop: 8,
}

const dismissBtnStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 46,
  borderRadius: 16,
  border: '1px solid rgba(96, 165, 250, 0.16)',
  background: 'transparent',
  color: '#60A5FA',
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
  background: 'rgba(2, 6, 23, 0.58)',
}

const completionOverlayCardStyle: React.CSSProperties = {
  position: 'relative',
  width: 'min(100%, 520px)',
  maxWidth: '100%',
  boxSizing: 'border-box',
}

const capToggleButtonStyle: React.CSSProperties = {
  appearance: 'none',
  border: '1px solid rgba(145, 164, 196, 0.24)',
  background: '#FFFFFF',
  color: '#23314F',
  borderRadius: 14,
  minHeight: 46,
  padding: '0 16px',
  fontSize: 14,
  fontWeight: 700,
  cursor: 'pointer',
  width: '100%',
}

const capEditorStyle: React.CSSProperties = {
  display: 'grid',
  gap: 18,
}

const capSectionStyle: React.CSSProperties = {
  display: 'grid',
  gap: 12,
}

const capSectionLabelStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 800,
  color: '#5B7CFA',
  textTransform: 'uppercase',
}

const capFieldStyle: React.CSSProperties = {
  display: 'grid',
  gap: 6,
}

const capFieldLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 800,
  color: '#23314F',
}

const capChipRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  flexWrap: 'wrap',
}

const capChipStyle: React.CSSProperties = {
  appearance: 'none',
  border: '1px solid rgba(145, 164, 196, 0.24)',
  background: '#FFFFFF',
  borderRadius: 12,
  padding: '9px 14px',
  fontSize: 14,
  fontWeight: 700,
  color: '#0F172A',
  cursor: 'pointer',
  minWidth: 44,
  textAlign: 'center',
  transition: 'all 180ms ease',
}

const capChipSelectedStyle: React.CSSProperties = {
  border: '1px solid rgba(91, 124, 250, 0.52)',
  background: '#F0F4FF',
  boxShadow: '0 6px 16px rgba(91, 124, 250, 0.12)',
  color: '#3152C8',
}

const capTextareaStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 56,
  borderRadius: 14,
  border: '1px solid rgba(145, 164, 196, 0.24)',
  background: '#FFFFFF',
  padding: '10px 14px',
  fontSize: 14,
  color: '#0F172A',
  boxSizing: 'border-box',
  outline: 'none',
  resize: 'vertical',
  fontFamily: 'inherit',
}

const capSaveButtonStyle: React.CSSProperties = {
  appearance: 'none',
  border: 'none',
  background: 'linear-gradient(180deg, #0F172A 0%, #233B74 100%)',
  color: '#FFFFFF',
  minHeight: 48,
  borderRadius: 16,
  padding: '0 18px',
  fontSize: 15,
  fontWeight: 800,
  cursor: 'pointer',
  boxShadow: '0 14px 28px rgba(15, 23, 42, 0.16)',
  width: '100%',
}

const capSaveButtonDisabledStyle: React.CSSProperties = {
  cursor: 'not-allowed',
  opacity: 0.5,
  boxShadow: 'none',
}
