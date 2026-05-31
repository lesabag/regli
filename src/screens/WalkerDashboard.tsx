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
import { normalizeSupportedLanguage, type SupportedLanguage } from '../i18n'
import {
  PROFILE_SERVICE_TYPES,
  getProfileServiceOptions,
  getProfileServiceTypeLabel,
  normalizeProfileServiceTypes,
  type ProfileServiceType,
} from '../lib/profileServiceTypes'
import {
  buildLegacyServiceAttributesFromCapabilities,
  buildProviderCapabilityRows,
  getCapabilityScope,
  getCapabilityShortBio,
  mergeProviderCapabilitiesSources,
  type ProviderCapabilitiesMap,
  type ProviderCapabilityRow,
} from '../lib/providerCapabilities'
import { getBookingPricingModelForService } from '../lib/serviceTypes'
import { normalizeAgeRangeValue } from '../lib/dispatchRanking'
import { getProviderEarnings, logPayoutSummary } from '../lib/payoutTruth'
import { hasProviderIssue } from '../utils/completionReview'

const REQUEST_TIMEOUT_SECONDS = 20
type MenuPage = 'main' | 'settings' | 'history' | 'futureOrders' | 'earnings' | 'preferredCustomers'
type EarningsPeriod = 'today' | 'week' | 'month'

type AppRole = 'client' | 'walker' | 'admin'

type ServiceAttributes = Record<string, Record<string, unknown>>
type ProviderExperienceRange = '0_1' | '1_3' | '3_5' | '5_10' | '10_plus'
type ProviderLanguage = 'hebrew' | 'english' | 'russian' | 'arabic' | 'french'
type AvailabilityFormRow = {
  dayOfWeek: number
  isActive: boolean
  startTime: string
  endTime: string
}

type AvailabilityFormState = Record<ProfileServiceType, AvailabilityFormRow[]>
type SettingsSectionKey = 'language' | 'serviceType' | 'availability' | 'pricing' | 'about' | 'capabilities' | 'preferredCustomers'
type ProviderPricingSummaryPreferenceRow = {
  service_type: ProfileServiceType
  booking_type: 'asap' | 'scheduled'
  is_enabled: boolean
  pricing_model: 'time_based' | 'fixed_visit' | 'visit_based' | 'hybrid' | null
  hourly_rate_min: number | null
  hourly_rate_preferred: number | null
  visit_fee_min: number | null
  visit_fee_preferred: number | null
  service_radius_km: number | null
}
const PROVIDER_BIO_MAX_CHARS = 160
const PROVIDER_BIO_MENU_PREVIEW_MAX_CHARS = 60

const AVAILABILITY_DAY_ORDER = [0, 1, 2, 3, 4, 5, 6] as const
const DEFAULT_AVAILABILITY_START = '09:00'
const DEFAULT_AVAILABILITY_END = '17:00'
const PROVIDER_EXPERIENCE_OPTIONS: Array<{ value: ProviderExperienceRange; labelEn: string; labelHe: string; years: number }> = [
  { value: '0_1', labelEn: '0–1 years', labelHe: '0–1 שנים', years: 1 },
  { value: '1_3', labelEn: '1–3 years', labelHe: '1–3 שנים', years: 2 },
  { value: '3_5', labelEn: '3–5 years', labelHe: '3–5 שנים', years: 4 },
  { value: '5_10', labelEn: '5–10 years', labelHe: '5–10 שנים', years: 7 },
  { value: '10_plus', labelEn: '10+ years', labelHe: '10+ שנים', years: 10 },
]
const PROVIDER_LANGUAGE_OPTIONS: Array<{ value: ProviderLanguage; labelEn: string; labelHe: string }> = [
  { value: 'hebrew', labelEn: 'Hebrew', labelHe: 'עברית' },
  { value: 'english', labelEn: 'English', labelHe: 'אנגלית' },
  { value: 'russian', labelEn: 'Russian', labelHe: 'רוסית' },
  { value: 'arabic', labelEn: 'Arabic', labelHe: 'ערבית' },
  { value: 'french', labelEn: 'French', labelHe: 'צרפתית' },
]

interface WalkerDashboardProps {
  profile: {
    id: string
    email: string | null
    full_name: string | null
    role: AppRole
    preferred_language?: SupportedLanguage | null
    short_bio?: string | null
    whatsapp_number?: string | null
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

function getDisplayServiceNote(serviceType: string | null | undefined, notes: string | null | undefined): string | null {
  if (!notes || hasProviderIssue(notes)) return null

  if (serviceType === 'baby_sitter') {
    return parseBabysitterNotes(notes).details
  }

  const trimmed = notes.trim()
  return trimmed || null
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
  const nextState = PROFILE_SERVICE_TYPES.reduce((state, serviceType) => {
    state[serviceType] = buildDefaultAvailabilityRows()
    return state
  }, {} as AvailabilityFormState)

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

function isGenericCustomerLabel(value: string | null | undefined): boolean {
  const normalized = (value ?? '').trim().toLowerCase()
  if (!normalized) return true
  return normalized === 'customer' || normalized === 'client' || normalized === 'לקוח'
}

function getStrictClientDisplayName(
  input: {
    client?: { full_name?: string | null } | null
    profileName?: string | null
    customerName?: string | null
  },
  isHebrew: boolean,
): string {
  const candidates = [
    input.client?.full_name?.trim() || null,
    input.profileName?.trim() || null,
    input.customerName?.trim() || null,
  ]

  for (const candidate of candidates) {
    if (candidate && !isGenericCustomerLabel(candidate)) return candidate
  }

  return isHebrew ? 'לקוח' : 'Client'
}

function getProviderExperienceYears(range: ProviderExperienceRange | ''): number {
  return PROVIDER_EXPERIENCE_OPTIONS.find((option) => option.value === range)?.years ?? 0
}

function getProviderExperienceRangeFromYears(years: number | null | undefined): ProviderExperienceRange | '' {
  if (typeof years !== 'number' || !Number.isFinite(years) || years <= 0) return ''
  if (years >= 10) return '10_plus'
  if (years >= 7) return '5_10'
  if (years >= 4) return '3_5'
  if (years >= 2) return '1_3'
  return '0_1'
}

function countCodePoints(value: string): number {
  return Array.from(value).length
}

function trimToCodePoints(value: string, maxChars: number): string {
  return Array.from(value).slice(0, maxChars).join('')
}

function truncateCodePoints(value: string | null | undefined, maxChars: number): string | null {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return null
  const chars = Array.from(trimmed)
  if (chars.length <= maxChars) return trimmed
  return `${chars.slice(0, maxChars).join('').trimEnd()}…`
}

function formatProviderPricingRange(params: {
  isHebrew: boolean
  min: number | null
  preferred: number | null
}): string {
  const { isHebrew, min, preferred } = params
  if (min != null && preferred != null) return `₪${Math.round(min)}–₪${Math.round(preferred)}`
  if (min != null) return isHebrew ? `החל מ־₪${Math.round(min)}` : `From ₪${Math.round(min)}`
  if (preferred != null) return isHebrew ? `סביב ₪${Math.round(preferred)}` : `Around ₪${Math.round(preferred)}`
  return isHebrew ? 'לא הוגדר' : 'Not set'
}

function formatProviderServiceRangeLabel(params: {
  isHebrew: boolean
  radiusKm: number | null
}): string {
  const { isHebrew, radiusKm } = params
  if (radiusKm == null) return isHebrew ? 'ללא הגבלה' : 'Unlimited'
  return isHebrew ? `${Math.round(radiusKm)} ק״מ` : `${Math.round(radiusKm)} km`
}

export default function WalkerDashboard({
  profile,
  onSignOut,
  showOnboardingWowToken = 0,
  stripeReturnToken = 0,
}: WalkerDashboardProps) {
  const { t } = useTranslation()
  const handleLanguageChange = useCallback((language: SupportedLanguage) => {
    const nextLanguage = normalizeSupportedLanguage(language) ?? 'en'
    void i18n.changeLanguage(nextLanguage)
    void supabase
      .from('profiles')
      .update({ preferred_language: nextLanguage })
      .eq('id', profile.id)
      .then(({ error }) => {
        if (error) {
          console.warn('[language] failed to persist preferred language', {
            userId: profile.id,
            language: nextLanguage,
            error: error.message,
          })
        }
      })
  }, [profile.id])

  const walkerName = profile.full_name || profile.email || 'Walker'
  const flow = useWalkerFlow(profile.id, walkerName)
  const photo = useProfilePhoto(profile.id)
  const isRtl = i18n.resolvedLanguage === 'he'
  const isHebrew = i18n.resolvedLanguage === 'he'
  const greetingLabel = isRtl ? `היי, ${walkerName}` : `Hey, ${walkerName}`
  const preferredCustomersLabel = isRtl ? 'לקוחות מועדפים' : 'Preferred customers'
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
  const todayAvailabilityPricingLabel = t('providerPricing.title')
  const unavailableTodayLabel = isHebrew ? 'לא זמין היום' : 'Unavailable today'
  const headerRatingValue = flow.avgRating != null ? flow.avgRating.toFixed(1) : null
  const walletTitle = isHebrew ? 'ארנק' : 'Wallet'
  const reviewsLabel = isHebrew ? 'ביקורות' : 'Reviews'
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
  const [preferredCustomerAvatars, setPreferredCustomerAvatars] = useState<Map<string, string | null>>(new Map())
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
  const initialProviderCapabilities = useMemo(
    () => mergeProviderCapabilitiesSources({
      fallbackServiceAttributes: profile.service_attributes,
      shortBio: profile.short_bio ?? null,
    }),
    [profile.service_attributes, profile.short_bio],
  )
  const [providerCapabilities, setProviderCapabilities] = useState<ProviderCapabilitiesMap>(initialProviderCapabilities)
  const providerProfileCapabilities = useMemo(
    () => getCapabilityScope<Record<string, unknown>>(providerCapabilities, 'provider_profile') ?? {},
    [providerCapabilities],
  )
  const [providerBio, setProviderBio] = useState(getCapabilityShortBio(initialProviderCapabilities, profile.short_bio ?? null))
  const [providerWhatsAppNumber, setProviderWhatsAppNumber] = useState(profile.whatsapp_number ?? '')
  const [providerBioSaving, setProviderBioSaving] = useState(false)
  const [providerBioSavedAt, setProviderBioSavedAt] = useState(0)
  const [providerBioError, setProviderBioError] = useState<string | null>(null)
  const [pricingSummaryRows, setPricingSummaryRows] = useState<ProviderPricingSummaryPreferenceRow[]>([])
  const [openPricingSummaryTooltip, setOpenPricingSummaryTooltip] = useState<'asap' | 'scheduled' | null>(null)
  const availabilityRowsRef = useRef(availabilityRows)
  const pricingSummaryTooltipRef = useRef<HTMLSpanElement | null>(null)
  const [expandedAvailabilityKey, setExpandedAvailabilityKey] = useState<string | null>(null)
  const [settingsSectionsOpen, setSettingsSectionsOpen] = useState<Record<SettingsSectionKey, boolean>>({
    language: false,
    serviceType: false,
    availability: false,
    pricing: false,
    about: false,
    capabilities: false,
    preferredCustomers: false,
  })
  const [capSaving, setCapSaving] = useState(false)
  const [capSavedAt, setCapSavedAt] = useState(0)
  const [capError, setCapError] = useState<string | null>(null)
  const [capabilitiesLoading, setCapabilitiesLoading] = useState(false)
  const [provExperienceRange, setProvExperienceRange] = useState<ProviderExperienceRange | ''>(() => {
    const experienceRange = typeof providerProfileCapabilities.experienceRange === 'string'
      ? providerProfileCapabilities.experienceRange as ProviderExperienceRange
      : ''
    if (experienceRange) return experienceRange
    const experienceYears = typeof providerProfileCapabilities.experienceYears === 'number'
      ? providerProfileCapabilities.experienceYears
      : null
    return getProviderExperienceRangeFromYears(experienceYears)
  })
  const [provLanguages, setProvLanguages] = useState<ProviderLanguage[]>(() => {
    const rawLanguages = providerProfileCapabilities.languagesSpoken ?? providerProfileCapabilities.languages
    return Array.isArray(rawLanguages)
      ? rawLanguages.filter((value): value is ProviderLanguage => typeof value === 'string') as ProviderLanguage[]
      : []
  })
  const [provDogSizes, setProvDogSizes] = useState<string[]>(() => {
    const sa = getCapabilityScope<Record<string, unknown>>(initialProviderCapabilities, 'dog_walker')
    return Array.isArray(sa?.supportedDogSizes) ? (sa.supportedDogSizes as string[]) : []
  })
  const [provDogEnergy, setProvDogEnergy] = useState<string[]>(() => {
    const sa = getCapabilityScope<Record<string, unknown>>(initialProviderCapabilities, 'dog_walker')
    return Array.isArray(sa?.supportedEnergyLevels) ? (sa.supportedEnergyLevels as string[]) : []
  })
  const [provDogExp, setProvDogExp] = useState<number>(() => {
    const sa = getCapabilityScope<Record<string, unknown>>(initialProviderCapabilities, 'dog_walker')
    return typeof sa?.experienceYears === 'number' ? (sa.experienceYears as number) : 0
  })
  const [provDogNotes, setProvDogNotes] = useState<string>(() => {
    const sa = getCapabilityScope<Record<string, unknown>>(initialProviderCapabilities, 'dog_walker')
    return typeof sa?.notes === 'string' ? (sa.notes as string) : ''
  })
  const [provSitterAges, setProvSitterAges] = useState<string[]>(() => {
    const sa = getCapabilityScope<Record<string, unknown>>(initialProviderCapabilities, 'baby_sitter')
    return Array.isArray(sa?.supportedAgeRanges)
      ? (sa.supportedAgeRanges as unknown[])
          .map((range) => normalizeAgeRangeValue(range))
          .filter((range): range is '1-2' | '2-4' | '5-7' | '7+' => range !== null)
      : []
  })
  const [provSitterExp, setProvSitterExp] = useState<number>(() => {
    const sa = getCapabilityScope<Record<string, unknown>>(initialProviderCapabilities, 'baby_sitter')
    return typeof sa?.experienceYears === 'number' ? (sa.experienceYears as number) : 0
  })
  const [provSitterNotes, setProvSitterNotes] = useState<string>(() => {
    const sa = getCapabilityScope<Record<string, unknown>>(initialProviderCapabilities, 'baby_sitter')
    return typeof sa?.notes === 'string' ? (sa.notes as string) : ''
  })
  const providerBioCharCount = useMemo(() => countCodePoints(providerBio), [providerBio])
  const providerBioMenuPreview = useMemo(
    () => truncateCodePoints(providerBio, PROVIDER_BIO_MENU_PREVIEW_MAX_CHARS),
    [providerBio],
  )
  const capDirty = useMemo(() => {
    const providerProfileSa = getCapabilityScope<Record<string, unknown>>(providerCapabilities, 'provider_profile') ?? {}
    const dogSa = getCapabilityScope<Record<string, unknown>>(providerCapabilities, 'dog_walker') ?? {}
    const sitterSa = getCapabilityScope<Record<string, unknown>>(providerCapabilities, 'baby_sitter') ?? {}
    const origDogSizes = Array.isArray(dogSa.supportedDogSizes) ? (dogSa.supportedDogSizes as string[]) : []
    const origDogEnergy = Array.isArray(dogSa.supportedEnergyLevels) ? (dogSa.supportedEnergyLevels as string[]) : []
    const origDogExp = typeof dogSa.experienceYears === 'number' ? (dogSa.experienceYears as number) : 0
    const origDogNotes = typeof dogSa.notes === 'string' ? (dogSa.notes as string) : ''
    const origExperienceRange =
      typeof providerProfileSa.experienceRange === 'string'
        ? providerProfileSa.experienceRange as ProviderExperienceRange
        : getProviderExperienceRangeFromYears(
            typeof providerProfileSa.experienceYears === 'number' ? providerProfileSa.experienceYears : null,
          )
    const origLanguagesRaw = providerProfileSa.languagesSpoken ?? providerProfileSa.languages
    const origLanguages = Array.isArray(origLanguagesRaw)
      ? origLanguagesRaw.filter((value): value is ProviderLanguage => typeof value === 'string')
      : []
    const origSitterAges = Array.isArray(sitterSa.supportedAgeRanges)
      ? (sitterSa.supportedAgeRanges as unknown[])
          .map((range) => normalizeAgeRangeValue(range))
          .filter((range): range is '1-2' | '2-4' | '5-7' | '7+' => range !== null)
      : []
    const origSitterExp = typeof sitterSa.experienceYears === 'number' ? (sitterSa.experienceYears as number) : 0
    const origSitterNotes = typeof sitterSa.notes === 'string' ? (sitterSa.notes as string) : ''
    const arrEq = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i])
    return (
      provExperienceRange !== origExperienceRange ||
      !arrEq(provLanguages, origLanguages) ||
      !arrEq(provDogSizes, origDogSizes) ||
      !arrEq(provDogEnergy, origDogEnergy) ||
      provDogExp !== origDogExp ||
      provDogNotes !== origDogNotes ||
      !arrEq(provSitterAges, origSitterAges) ||
      provSitterExp !== origSitterExp ||
      provSitterNotes !== origSitterNotes
    )
  }, [
    providerCapabilities,
    provExperienceRange,
    provLanguages,
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
    const mergedCapabilities = mergeProviderCapabilitiesSources({
      fallbackServiceAttributes: profile.service_attributes,
      shortBio: profile.short_bio ?? null,
    })
    setProviderCapabilities(mergedCapabilities)
    setProviderBio(getCapabilityShortBio(mergedCapabilities, profile.short_bio ?? null))
    const providerProfileAttrs = getCapabilityScope<Record<string, unknown>>(mergedCapabilities, 'provider_profile') ?? {}
    const nextExperienceRange =
      typeof providerProfileAttrs.experienceRange === 'string'
        ? providerProfileAttrs.experienceRange as ProviderExperienceRange
        : getProviderExperienceRangeFromYears(
            typeof providerProfileAttrs.experienceYears === 'number' ? providerProfileAttrs.experienceYears : null,
          )
    const rawLanguages = providerProfileAttrs.languagesSpoken ?? providerProfileAttrs.languages
    setProvExperienceRange(nextExperienceRange)
    setProvLanguages(
      Array.isArray(rawLanguages)
        ? rawLanguages.filter((value): value is ProviderLanguage => typeof value === 'string')
        : [],
    )
    const dogAttrs = getCapabilityScope<Record<string, unknown>>(mergedCapabilities, 'dog_walker') ?? {}
    setProvDogSizes(Array.isArray(dogAttrs.supportedDogSizes) ? (dogAttrs.supportedDogSizes as string[]) : [])
    setProvDogEnergy(Array.isArray(dogAttrs.supportedEnergyLevels) ? (dogAttrs.supportedEnergyLevels as string[]) : [])
    setProvDogExp(typeof dogAttrs.experienceYears === 'number' ? (dogAttrs.experienceYears as number) : 0)
    setProvDogNotes(typeof dogAttrs.notes === 'string' ? (dogAttrs.notes as string) : '')
    const sitterAttrs = getCapabilityScope<Record<string, unknown>>(mergedCapabilities, 'baby_sitter') ?? {}
    setProvSitterAges(
      Array.isArray(sitterAttrs.supportedAgeRanges)
        ? (sitterAttrs.supportedAgeRanges as unknown[])
            .map((range) => normalizeAgeRangeValue(range))
            .filter((range): range is '1-2' | '2-4' | '5-7' | '7+' => range !== null)
        : [],
    )
    setProvSitterExp(typeof sitterAttrs.experienceYears === 'number' ? (sitterAttrs.experienceYears as number) : 0)
    setProvSitterNotes(typeof sitterAttrs.notes === 'string' ? (sitterAttrs.notes as string) : '')
  }, [profile.service_attributes, profile.short_bio])

  useEffect(() => {
    setProviderWhatsAppNumber(profile.whatsapp_number ?? '')
  }, [profile.whatsapp_number])

  useEffect(() => {
    let cancelled = false

    const loadProviderCapabilities = async () => {
      setCapabilitiesLoading(true)
      const { data, error } = await supabase
        .from('provider_capabilities')
        .select('provider_id, capability_scope, capabilities, updated_at')
        .eq('provider_id', profile.id)

      if (cancelled) return

      if (error) {
        console.warn('[WalkerDashboard] failed to load provider_capabilities:', error.message)
        setCapabilitiesLoading(false)
        return
      }

      const mergedCapabilities = mergeProviderCapabilitiesSources({
        rows: (data as ProviderCapabilityRow[] | null) ?? [],
        fallbackServiceAttributes: profile.service_attributes,
        shortBio: profile.short_bio ?? null,
      })

      setProviderCapabilities(mergedCapabilities)
      setProviderBio(getCapabilityShortBio(mergedCapabilities, profile.short_bio ?? null))
      const providerProfileAttrs = getCapabilityScope<Record<string, unknown>>(mergedCapabilities, 'provider_profile') ?? {}
      const nextExperienceRange =
        typeof providerProfileAttrs.experienceRange === 'string'
          ? providerProfileAttrs.experienceRange as ProviderExperienceRange
          : getProviderExperienceRangeFromYears(
              typeof providerProfileAttrs.experienceYears === 'number' ? providerProfileAttrs.experienceYears : null,
            )
      const rawLanguages = providerProfileAttrs.languagesSpoken ?? providerProfileAttrs.languages
      setProvExperienceRange(nextExperienceRange)
      setProvLanguages(
        Array.isArray(rawLanguages)
          ? rawLanguages.filter((value): value is ProviderLanguage => typeof value === 'string')
          : [],
      )
      const dogAttrs = getCapabilityScope<Record<string, unknown>>(mergedCapabilities, 'dog_walker') ?? {}
      setProvDogSizes(Array.isArray(dogAttrs.supportedDogSizes) ? (dogAttrs.supportedDogSizes as string[]) : [])
      setProvDogEnergy(Array.isArray(dogAttrs.supportedEnergyLevels) ? (dogAttrs.supportedEnergyLevels as string[]) : [])
      setProvDogExp(typeof dogAttrs.experienceYears === 'number' ? (dogAttrs.experienceYears as number) : 0)
      setProvDogNotes(typeof dogAttrs.notes === 'string' ? (dogAttrs.notes as string) : '')
      const sitterAttrs = getCapabilityScope<Record<string, unknown>>(mergedCapabilities, 'baby_sitter') ?? {}
      setProvSitterAges(
        Array.isArray(sitterAttrs.supportedAgeRanges)
          ? (sitterAttrs.supportedAgeRanges as unknown[])
              .map((range) => normalizeAgeRangeValue(range))
              .filter((range): range is '1-2' | '2-4' | '5-7' | '7+' => range !== null)
          : [],
      )
      setProvSitterExp(typeof sitterAttrs.experienceYears === 'number' ? (sitterAttrs.experienceYears as number) : 0)
      setProvSitterNotes(typeof sitterAttrs.notes === 'string' ? (sitterAttrs.notes as string) : '')
      setCapabilitiesLoading(false)
    }

    void loadProviderCapabilities()

    return () => {
      cancelled = true
    }
  }, [profile.id, profile.service_attributes, profile.short_bio])

  useEffect(() => {
    availabilityRowsRef.current = availabilityRows
  }, [availabilityRows])

  useEffect(() => {
    if (openPricingSummaryTooltip == null) return undefined

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (pricingSummaryTooltipRef.current?.contains(target)) return
      setOpenPricingSummaryTooltip(null)
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenPricingSummaryTooltip(null)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [openPricingSummaryTooltip])

  useEffect(() => {
    let cancelled = false

    const loadPricingSummary = async () => {
      const { data, error } = await supabase
        .from('provider_service_preferences')
        .select('service_type, booking_type, is_enabled, pricing_model, hourly_rate_min, hourly_rate_preferred, visit_fee_min, visit_fee_preferred, service_radius_km')
        .eq('provider_id', profile.id)

      if (cancelled) return
      if (error) {
        console.warn('[WalkerDashboard] failed to load provider pricing summary:', error.message)
        setPricingSummaryRows([])
        return
      }

      setPricingSummaryRows((data as ProviderPricingSummaryPreferenceRow[] | null) ?? [])
    }

    void loadPricingSummary()

    return () => {
      cancelled = true
    }
  }, [profile.id])

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

    const existing = providerCapabilities
    const next: ProviderCapabilitiesMap = { ...existing }

    next.provider_profile = {
      ...(getCapabilityScope<Record<string, unknown>>(existing, 'provider_profile') ?? {}),
      experienceRange: provExperienceRange || null,
      experienceYears: getProviderExperienceYears(provExperienceRange),
      languagesSpoken: provLanguages,
      shortBio: providerBio.trim() || null,
    }

    if (profileServiceTypes.includes('dog_walker')) {
      next.dog_walker = {
        ...(getCapabilityScope<Record<string, unknown>>(existing, 'dog_walker') ?? {}),
        supportedDogSizes: provDogSizes,
        supportedEnergyLevels: provDogEnergy,
        experienceYears: provDogExp,
        notes: provDogNotes.trim() || null,
      }
    }

    if (profileServiceTypes.includes('baby_sitter')) {
      next.baby_sitter = {
        ...(getCapabilityScope<Record<string, unknown>>(existing, 'baby_sitter') ?? {}),
        supportedAgeRanges: provSitterAges
          .map((range) => normalizeAgeRangeValue(range))
          .filter((range): range is '1-2' | '2-4' | '5-7' | '7+' => range !== null),
        experienceYears: provSitterExp,
        notes: provSitterNotes.trim() || null,
      }
    }

    const capabilityRows = buildProviderCapabilityRows(profile.id, next).map((row) => ({
      ...row,
      updated_at: new Date().toISOString(),
    }))
    const legacyServiceAttributes = buildLegacyServiceAttributesFromCapabilities(next)

    const [{ error: capabilityError }, { error: profileError }] = await Promise.all([
      capabilityRows.length > 0
        ? supabase
            .from('provider_capabilities')
            .upsert(capabilityRows, { onConflict: 'provider_id,capability_scope' })
        : Promise.resolve({ error: null }),
      supabase
      .from('profiles')
      .update({ service_attributes: legacyServiceAttributes })
      .eq('id', profile.id)
    ])

    if (capabilityError || profileError) {
      setCapError(isHebrew ? 'לא הצלחנו לשמור.' : 'Could not save capabilities.')
      setCapSaving(false)
      return
    }

    setProviderCapabilities(next)
    setCapSaving(false)
    setCapSavedAt(Date.now())
  }, [
    capSaving, profile.id, profileServiceTypes, isHebrew, providerCapabilities, providerBio,
    provExperienceRange, provLanguages,
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

  const handleSaveProviderBio = useCallback(async () => {
    if (providerBioSaving) return
    setProviderBioSaving(true)
    setProviderBioError(null)
    setProviderBioSavedAt(0)

    const nextBio = trimToCodePoints(providerBio.trim(), PROVIDER_BIO_MAX_CHARS)
    const nextWhatsAppNumber = providerWhatsAppNumber.trim()
    console.debug('[WalkerDashboard] saving short_bio', {
      user_id: profile.id,
      short_bio: nextBio,
      whatsapp_number: nextWhatsAppNumber || null,
      char_count: countCodePoints(nextBio),
    })

    const nextCapabilities = {
      ...providerCapabilities,
      provider_profile: {
        ...(getCapabilityScope<Record<string, unknown>>(providerCapabilities, 'provider_profile') ?? {}),
        shortBio: nextBio || null,
      },
    }
    const providerCapabilityRows = buildProviderCapabilityRows(profile.id, nextCapabilities).map((row) => ({
      ...row,
      updated_at: new Date().toISOString(),
    }))

    const [{ data, error }, { error: capabilityError }] = await Promise.all([
      supabase
        .from('profiles')
        .update({
          short_bio: nextBio || null,
          whatsapp_number: nextWhatsAppNumber || null,
          service_attributes: buildLegacyServiceAttributesFromCapabilities(nextCapabilities),
        })
        .eq('id', profile.id)
        .select('id, short_bio, whatsapp_number')
        .maybeSingle(),
      providerCapabilityRows.length > 0
        ? supabase
            .from('provider_capabilities')
            .upsert(providerCapabilityRows, { onConflict: 'provider_id,capability_scope' })
        : Promise.resolve({ error: null }),
    ])

    console.debug('[WalkerDashboard] short_bio update result', {
      user_id: profile.id,
      short_bio: nextBio,
      whatsapp_number: nextWhatsAppNumber || null,
      result: data,
      error: error ?? capabilityError,
    })

    if (error || capabilityError) {
      console.warn('[WalkerDashboard] failed to save short_bio:', {
        user_id: profile.id,
        short_bio: nextBio,
        whatsapp_number: nextWhatsAppNumber || null,
        error: error ?? capabilityError,
      })
      setProviderBioError(error?.message || capabilityError?.message || t('providerProfile.bioSaveError'))
      setProviderBioSaving(false)
      return
    }

    if (!data?.id) {
      console.warn('[WalkerDashboard] short_bio update returned no row', {
        user_id: profile.id,
        short_bio: nextBio,
        whatsapp_number: nextWhatsAppNumber || null,
        result: data,
      })
      setProviderBioError(t('providerProfile.bioSaveError'))
      setProviderBioSaving(false)
      return
    }

    setProviderBio((data.short_bio as string | null) ?? '')
    setProviderWhatsAppNumber((data.whatsapp_number as string | null) ?? '')
    setProviderCapabilities(nextCapabilities)
    setProviderBioSaving(false)
    setProviderBioSavedAt(Date.now())
  }, [profile.id, providerBio, providerBioSaving, providerCapabilities, providerWhatsAppNumber, t])

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
  const isFixedVisitRequest = getBookingPricingModelForService(topRequest?.service_type) === 'fixed_visit'
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
    if (!topRequest) return
    const clientName = getCustomerDisplayName(
      {
        client: topRequest.client ?? null,
        clientName: topRequest.client?.full_name || topRequest.client?.email || null,
        dogName: topRequest.dog_name || null,
      },
      isHebrew,
    )
    const resolvedClientAvatar = topRequest.client?.avatar_url ?? null

    console.debug('[WalkerDashboard] incoming request client avatar', {
      client_id: topRequest.client_id ?? topRequest.client?.id ?? null,
      client_name: clientName,
      client_avatar_raw: topRequest.client?.avatar_url ?? null,
      resolved_client_avatar: resolvedClientAvatar,
      fallback_used: !resolvedClientAvatar,
    })
  }, [isHebrew, topRequest])

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
    () => {
      if (!flow.completionSuccess) return null
      const completedJob =
        flow.completedJobs.find((job) => job.id === flow.completionSuccess?.jobId) ?? null

      if (completedJob) return completedJob

      return {
        id: flow.completionSuccess.jobId,
        client: flow.completionSuccess.clientId
          ? {
              id: flow.completionSuccess.clientId,
              full_name: flow.completionSuccess.clientName ?? null,
              email: null,
            }
          : null,
        dog_name: flow.completionSuccess.dogName ?? null,
        dog_count: flow.completionSuccess.dogCount ?? null,
        duration_minutes: flow.completionSuccess.durationMinutes ?? null,
        service_started_at: flow.completionSuccess.serviceStartedAt ?? null,
        service_completed_at: flow.completionSuccess.serviceCompletedAt ?? null,
        service_type: flow.completionSuccess.serviceType ?? null,
      }
    },
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

  useEffect(() => {
    if (!flow.completionSuccess) return
    const startedTs = completionJobDetails?.service_started_at ? new Date(completionJobDetails.service_started_at).getTime() : null
    const completedTs = completionJobDetails?.service_completed_at ? new Date(completionJobDetails.service_completed_at).getTime() : null
    const diffSeconds =
      startedTs != null && completedTs != null && !Number.isNaN(startedTs) && !Number.isNaN(completedTs)
        ? Math.max(0, Math.floor((completedTs - startedTs) / 1000))
        : null
    console.debug('[WalkerDashboard] completion card duration', {
      service_started_at: completionJobDetails?.service_started_at ?? null,
      service_completed_at: completionJobDetails?.service_completed_at ?? null,
      computedDiffSeconds: diffSeconds,
      computedActualDurationLabel: completionDurationSummary.actualLabel ?? '—',
    })
  }, [
    completionDurationSummary.actualLabel,
    completionJobDetails?.service_completed_at,
    completionJobDetails?.service_started_at,
    flow.completionSuccess,
  ])

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
    rows.push({
      label: isHebrew ? 'משך בפועל' : 'Actual duration',
      value: completionDurationSummary.actualLabel || '—',
    })
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
      setPreferredCustomerAvatars(new Map())
      return
    }

    const { data: profilesData, error: profilesError } = await supabase
      .from('profiles')
      .select('id, full_name, avatar_url')
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
      setPreferredCustomerAvatars((current) => {
        const next = new Map(current)
        ids.forEach((id) => {
          if (!next.has(id)) next.set(id, null)
        })
        return next
      })
      return
    }

    const nextNames = new Map<string, string>()
    const nextAvatars = new Map<string, string | null>()
    ;((profilesData as Array<{ id: string; full_name: string | null; avatar_url?: string | null }> | null) ?? []).forEach(
      (profileRow) => {
        nextNames.set(
          profileRow.id,
          getCustomerDisplayName(
            {
              client: {
                full_name: profileRow.full_name,
              },
            },
            isHebrew,
          ),
        )
        nextAvatars.set(profileRow.id, profileRow.avatar_url ?? null)
      },
    )
    ids.forEach((id) => {
      if (!nextNames.has(id)) nextNames.set(id, isHebrew ? 'לקוח' : 'Customer')
      if (!nextAvatars.has(id)) nextAvatars.set(id, null)
    })
    setPreferredCustomerNames(nextNames)
    setPreferredCustomerAvatars(nextAvatars)
  }, [isHebrew, profile.id])

  useEffect(() => {
    void fetchPreferredCustomers()
  }, [fetchPreferredCustomers])

  const completionClientId = completionJobDetails?.client?.id ?? flow.completionSuccess?.clientId ?? null
  const completionClientLookupKey = getPreferredCustomerKey({
    clientId: completionClientId,
    clientName: isGenericCustomerLabel(flow.completionSuccess?.clientName)
      ? null
      : flow.completionSuccess?.clientName ?? null,
  })
  const completionClientMapName =
    (completionClientId ? preferredCustomerNames.get(completionClientId) ?? null : null) ??
    (completionClientLookupKey ? preferredCustomerNames.get(completionClientLookupKey) ?? null : null)
  const completionClientMapAvatar =
    (completionClientId ? preferredCustomerAvatars.get(completionClientId) ?? null : null) ??
    (completionClientLookupKey ? preferredCustomerAvatars.get(completionClientLookupKey) ?? null : null)
  const completionClientAvatarUrl =
    (completionJobDetails?.client && 'avatar_url' in completionJobDetails.client
      ? completionJobDetails.client.avatar_url ?? null
      : null) ??
    completionClientMapAvatar
  const completionClientName = getStrictClientDisplayName(
    {
      client: completionJobDetails?.client ?? null,
      profileName: completionClientMapName,
      customerName: isGenericCustomerLabel(flow.completionSuccess?.clientName)
        ? null
        : flow.completionSuccess?.clientName || null,
    },
    isHebrew,
  )
  const completionClientKey = getPreferredCustomerKey({
    clientId: completionClientId,
    clientName: completionClientName,
  })
  const completionClientSaved = completionClientKey ? preferredCustomerIds.has(completionClientKey) : false

  const toggleFavoriteClient = useCallback(async (clientKey: string, clientName: string) => {
    if (!clientKey) return
    const previousIds = new Set(preferredCustomerIds)
    const previousNames = new Map(preferredCustomerNames)
    const previousAvatars = new Map(preferredCustomerAvatars)
    const nextIsSaved = !preferredCustomerIds.has(clientKey)
    const optimisticClientName =
      clientKey === completionClientKey
        ? getStrictClientDisplayName(
            {
              client: completionJobDetails?.client ?? null,
              profileName: completionClientMapName,
              customerName: isGenericCustomerLabel(clientName) ? null : clientName,
            },
            isHebrew,
          )
        : clientName

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
        next.set(clientKey, optimisticClientName)
      } else {
        next.delete(clientKey)
      }
      return next
    })
    setPreferredCustomerAvatars((current) => {
      const next = new Map(current)
      if (nextIsSaved) {
        const completionAvatar =
          completionClientId && clientKey === completionClientId
            ? completionClientAvatarUrl
            : null
        next.set(clientKey, completionAvatar)
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
        setPreferredCustomerAvatars(previousAvatars)
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
        setPreferredCustomerAvatars(previousAvatars)
        return
      }
    }

    void fetchPreferredCustomers()
  }, [
    completionClientKey,
    completionClientMapName,
    completionJobDetails?.client,
    completionClientAvatarUrl,
    completionClientId,
    fetchPreferredCustomers,
    isHebrew,
    preferredCustomerAvatars,
    preferredCustomerIds,
    preferredCustomerNames,
    profile.id,
  ])

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

  const openSettingsSection = useCallback((section: SettingsSectionKey) => {
    setBurgerOpen(true)
    setMenuPage('settings')
    setSettingsSectionsOpen((current) => ({ ...current, [section]: true }))
  }, [])

  const toggleSettingsSection = useCallback((section: SettingsSectionKey) => {
    setSettingsSectionsOpen((current) => ({ ...current, [section]: !current[section] }))
  }, [])

  const handleManageAvailability = useCallback(() => {
    openSettingsSection('availability')
  }, [openSettingsSection])

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

  const pricingSummaryCardRows = useMemo(() => {
    const primaryServiceType = profileServiceTypes[0] ?? null
    const scopedRows = primaryServiceType
      ? pricingSummaryRows.filter((row) => row.service_type === primaryServiceType)
      : pricingSummaryRows

    const sourceRows = scopedRows.length > 0 ? scopedRows : pricingSummaryRows
    const rowsByBookingType = new Map(
      sourceRows
        .filter((row) => row.is_enabled)
        .map((row) => [row.booking_type, row] as const),
    )

    return (['asap', 'scheduled'] as const)
      .map((bookingType) => {
        const row = rowsByBookingType.get(bookingType)
        if (!row) return null
        const normalizedPricingModel =
          row.pricing_model === 'fixed_visit' || row.pricing_model === 'visit_based' ? 'fixed_visit' : 'time_based'
        const min = normalizedPricingModel === 'fixed_visit' ? row.visit_fee_min : row.hourly_rate_min
        const preferred = normalizedPricingModel === 'fixed_visit' ? row.visit_fee_preferred : row.hourly_rate_preferred
        const isUnlimited = row.service_radius_km == null
        return {
          bookingType,
          label: bookingType === 'asap' ? 'ASAP' : (isHebrew ? 'מתוזמן' : 'Scheduled'),
          priceLabel: formatProviderPricingRange({ isHebrew, min, preferred }),
          rangeLabel: formatProviderServiceRangeLabel({ isHebrew, radiusKm: row.service_radius_km }),
          tooltipLabel: isUnlimited
            ? (isHebrew ? 'מומלץ לספקים חדשים.' : 'Recommended for new providers.')
            : (isHebrew ? 'לקוחות מחוץ לאזור הזה לא יראו אתכם.' : 'Customers outside this area will not see you.'),
        }
      })
      .filter((row): row is NonNullable<typeof row> => row != null)
  }, [isHebrew, pricingSummaryRows, profileServiceTypes])

  const isHomeDashboard = flow.screenState === 'offline' || flow.screenState === 'waiting'
  const preferredCustomerItems = useMemo(
    () => Array.from(preferredCustomerIds).map((clientId) => ({
      id: clientId,
      name: preferredCustomerNames.get(clientId)?.trim() || (isHebrew ? 'לקוח' : 'Customer'),
      avatarUrl: preferredCustomerAvatars.get(clientId) ?? null,
    })),
    [isHebrew, preferredCustomerAvatars, preferredCustomerIds, preferredCustomerNames],
  )

  const renderHomeDashboard = useCallback((connected: boolean) => (
    <div className="sheet-state-enter" style={homeDashboardShellStyle}>
      <div style={homeDashboardStatusSectionStyle}>
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
      </div>

      <div style={homeDashboardSummaryStackStyle}>
        <div style={homeDashboardMiddleGroupStyle}>
          {renderTodayAvailabilityCard()}

          <div style={todayAvailabilityPricingCardStyle}>
            <div style={todayAvailabilityHeaderStyle}>
              <div style={todayAvailabilityTitleStyle}>{todayAvailabilityPricingLabel}</div>
              <button
                type="button"
                onClick={() => openSettingsSection('pricing')}
                style={todayAvailabilityManageButtonStyle}
              >
                <span>{isHebrew ? 'נהל תמחור' : 'Manage pricing'}</span>
                <span style={todayAvailabilityManageChevronStyle}>›</span>
              </button>
            </div>
            <div style={todayAvailabilityListStyle}>
              {pricingSummaryCardRows.length > 0 ? pricingSummaryCardRows.map((item, index) => (
                <div
                  key={item.bookingType}
                  style={{
                    ...todayAvailabilityRowStyle,
                    ...pricingSummaryRowStyle,
                    ...(index > 0 ? todayAvailabilityRowWithDividerStyle : null),
                  }}
                >
                  <span style={pricingSummaryBookingTypeStyle}>{item.label}</span>
                  <span style={pricingSummaryPriceStyle}>{item.priceLabel}</span>
                  <span
                    ref={openPricingSummaryTooltip === item.bookingType ? pricingSummaryTooltipRef : null}
                    style={pricingSummaryRangeWrapStyle}
                  >
                    <span style={pricingSummaryRangeLabelStyle}>{item.rangeLabel}</span>
                    <button
                      type="button"
                      aria-label={item.tooltipLabel}
                      aria-expanded={openPricingSummaryTooltip === item.bookingType}
                      onClick={() => setOpenPricingSummaryTooltip((current) => (
                        current === item.bookingType ? null : item.bookingType
                      ))}
                      style={pricingSummaryInfoButtonStyle}
                    >
                      <span style={pricingSummaryInfoIconStyle}>ⓘ</span>
                    </button>
                    {openPricingSummaryTooltip === item.bookingType ? (
                      <span role="tooltip" style={pricingSummaryTooltipBubbleStyle}>
                        {item.tooltipLabel}
                      </span>
                    ) : null}
                  </span>
                </div>
              )) : (
                <div style={todayAvailabilityPricingSubtitleStyle}>
                  {isHebrew
                    ? 'נהלו טווחי מחירים והעדפות שירות לכל סוג הזמנה.'
                    : 'Manage pricing ranges and service preferences for each booking type.'}
                </div>
              )}
            </div>
          </div>
        </div>

        <div style={{ ...dashboardSectionStyle, ...walletSectionStyle, ...homeDashboardWalletSectionStyle }}>
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
    </div>
  ), [
    flow.avgRating,
    flow.connectLoading,
    flow.wallet.availableBalance,
    flow.wallet.pendingEarnings,
    handleOnlineToggle,
    handleStripeSetup,
    idleHeroTitle,
    isCheckingPayout,
    isHebrew,
    nearbyRequestsBody,
    onlineLabel,
    payoutCtaAnimationStopped,
    payoutCtaNudgeActive,
    readyForOrdersTitle,
    renderTodayAvailabilityCard,
    reviewsLabel,
    openSettingsSection,
    walletPayoutReady,
    walletTitle,
    todayAvailabilityPricingLabel,
    pricingSummaryCardRows,
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
      <div
        className="walker-dashboard-screen"
        style={{
          ...screenStyle,
          ...(isHomeDashboard ? homeScreenStyle : null),
        }}
      >
        <div
          style={{
            ...dashboardBackgroundStyle,
            ...(isHomeDashboard ? homeDashboardBackgroundStyle : null),
          }}
        >
          <div
            style={{
              ...headerStyle,
              ...(isHomeDashboard ? homeHeaderStyle : null),
            }}
          >
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
                  {headerRatingValue ? (
                    <div style={headerRatingStyle}>
                      <span style={headerRatingStarStyle}>★</span> {headerRatingValue}
                    </div>
                  ) : null}
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
                              : menuPage === 'preferredCustomers'
                                ? preferredCustomersLabel
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
                ) : menuPage === 'preferredCustomers' ? (
                  <BurgerSection
                    title={preferredCustomersLabel}
                    subtitle={isHebrew ? 'לקוחות שמורים לעיון מהיר.' : 'Saved customers for quick reference'}
                  >
                    {preferredCustomerItems.length === 0 ? (
                      <div style={emptyMenuCardStyle}>
                        {isHebrew ? 'אין לקוחות מועדפים עדיין' : 'No preferred customers yet'}
                      </div>
                    ) : (
                      <div style={preferredCustomerListStyle}>
                        {preferredCustomerItems.map((item) => (
                          <div key={item.id} style={preferredCustomerCardStyle}>
                            <div style={preferredCustomerIdentityStyle}>
                              <ProfileAvatar
                                url={item.avatarUrl}
                                name={item.name}
                                size={44}
                                borderRadius={16}
                              />
                              <div style={preferredCustomerTextStyle}>
                                <div style={preferredCustomerNameStyle}>{item.name}</div>
                                <div style={preferredCustomerMetaStyle}>{preferredCustomersLabel}</div>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </BurgerSection>
                ) : menuPage === 'settings' ? (
                  <>
                    <SettingsCollapsibleSection
                      title={t('common.language')}
                      subtitle={t('menu.settings')}
                      open={settingsSectionsOpen.language}
                      onToggle={() => toggleSettingsSection('language')}
                    >
                      <div style={languageSelectorRowStyle}>
                        <button
                          type="button"
                          onClick={() => {
                            handleLanguageChange('en')
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
                            handleLanguageChange('he')
                          }}
                          style={{
                            ...languageButtonStyle,
                            ...(i18n.resolvedLanguage === 'he' ? languageButtonActiveStyle : null),
                          }}
                        >
                          עברית
                        </button>
                      </div>
                    </SettingsCollapsibleSection>

                    <SettingsCollapsibleSection
                      title={t('providerProfile.aboutMe')}
                      subtitle={t('providerProfile.aboutMeSubtitle')}
                      open={settingsSectionsOpen.about}
                      onToggle={() => toggleSettingsSection('about')}
                    >
                      <div style={providerBioSectionStyle}>
                        <div style={providerBioFieldStyle}>
                          <div style={providerBioFieldLabelStyle}>{t('providerProfile.whatsappNumber')}</div>
                          <input
                            type="tel"
                            inputMode="tel"
                            autoComplete="tel"
                            value={providerWhatsAppNumber}
                            onChange={(event) => {
                              setProviderWhatsAppNumber(event.target.value)
                              setProviderBioSavedAt(0)
                              setProviderBioError(null)
                            }}
                            placeholder={t('providerProfile.whatsappNumberPlaceholder')}
                            style={providerBioInputStyle}
                          />
                        </div>
                        <textarea
                          value={providerBio}
                          onChange={(event) => {
                            setProviderBio(trimToCodePoints(event.target.value, PROVIDER_BIO_MAX_CHARS))
                            setProviderBioSavedAt(0)
                            setProviderBioError(null)
                          }}
                          placeholder={t('providerProfile.aboutMePlaceholder')}
                          style={providerBioTextareaStyle}
                          rows={3}
                        />
                        <div style={providerBioFooterStyle}>
                          <div style={providerBioCounterStyle}>
                            {t('providerProfile.bioHint', { count: providerBioCharCount })}
                          </div>
                          <button
                            type="button"
                            onClick={() => void handleSaveProviderBio()}
                            disabled={providerBioSaving}
                            style={{
                              ...providerBioSaveButtonStyle,
                              ...(providerBioSaving ? providerBioSaveButtonDisabledStyle : null),
                            }}
                          >
                            {providerBioSaving ? t('providerPricing.saving') : t('common.save')}
                          </button>
                        </div>
                        {providerBioError ? (
                          <div style={serviceTypeStatusErrorStyle}>{providerBioError}</div>
                        ) : providerBioSavedAt > 0 ? (
                          <div style={serviceTypeStatusSuccessStyle}>{t('providerProfile.bioSaved')}</div>
                        ) : null}
                      </div>
                    </SettingsCollapsibleSection>

                    <SettingsCollapsibleSection
                      title={serviceTypeSectionTitle}
                      subtitle={serviceTypeSectionSubtitle}
                      open={settingsSectionsOpen.serviceType}
                      onToggle={() => toggleSettingsSection('serviceType')}
                    >
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
                              <span
                                style={{
                                  ...serviceTypeButtonIconStyle,
                                  ...(selected ? serviceTypeButtonIconActiveStyle : null),
                                }}
                              >
                                {option.icon}
                              </span>
                              <span
                                style={{
                                  ...serviceTypeButtonLabelStyle,
                                  ...(selected ? serviceTypeButtonLabelActiveStyle : null),
                                }}
                              >
                                {option.label}
                              </span>
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
                    </SettingsCollapsibleSection>

                    <SettingsCollapsibleSection
                      title={isHebrew ? 'יכולות שירות' : 'Service capabilities'}
                      subtitle={isHebrew ? 'הגדר את ההעדפות והניסיון שלך.' : 'Define your preferences and experience.'}
                      open={settingsSectionsOpen.capabilities}
                      onToggle={() => toggleSettingsSection('capabilities')}
                    >
                        <div style={capEditorStyle}>
                          <div style={capSectionStyle}>
                            <div style={capSectionLabelStyle}>
                              {isHebrew ? 'פרופיל ספק' : 'Provider profile'}
                            </div>

                            <div style={capFieldStyle}>
                              <div style={capFieldLabelStyle}>{isHebrew ? 'שנות ניסיון' : 'Experience'}</div>
                              <div style={capChipRowStyle}>
                                {PROVIDER_EXPERIENCE_OPTIONS.map((option) => (
                                  <button
                                    key={option.value}
                                    type="button"
                                    onClick={() => setProvExperienceRange(option.value)}
                                    style={{ ...capChipStyle, ...(provExperienceRange === option.value ? capChipSelectedStyle : null) }}
                                  >
                                    {isHebrew ? option.labelHe : option.labelEn}
                                  </button>
                                ))}
                              </div>
                            </div>

                            <div style={capFieldStyle}>
                              <div style={capFieldLabelStyle}>{isHebrew ? 'שפות' : 'Languages'}</div>
                              <div style={capChipRowStyle}>
                                {PROVIDER_LANGUAGE_OPTIONS.map((option) => {
                                  const selected = provLanguages.includes(option.value)
                                  return (
                                    <button
                                      key={option.value}
                                      type="button"
                                      onClick={() => setProvLanguages((prev) =>
                                        selected
                                          ? prev.filter((value) => value !== option.value)
                                          : [...prev, option.value]
                                      )}
                                      style={{ ...capChipStyle, ...(selected ? capChipSelectedStyle : null) }}
                                    >
                                      {isHebrew ? option.labelHe : option.labelEn}
                                    </button>
                                  )
                                })}
                              </div>
                            </div>
                          </div>

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
                          {!capError && capabilitiesLoading ? (
                            <div style={serviceTypeStatusMutedStyle}>
                              {isHebrew ? 'טוען יכולות שמורות...' : 'Loading saved capabilities...'}
                            </div>
                          ) : null}
                          {!capSaving && capSavedAt > 0 && !capDirty && !capError && (
                            <div style={serviceTypeStatusSuccessStyle}>
                              {isHebrew ? 'היכולות נשמרו.' : 'Capabilities saved.'}
                            </div>
                          )}
                        </div>
                    </SettingsCollapsibleSection>

                    <SettingsCollapsibleSection
                      title={availabilitySectionTitle}
                      subtitle={availabilitySectionSubtitle}
                      open={settingsSectionsOpen.availability}
                      onToggle={() => toggleSettingsSection('availability')}
                    >
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
                    </SettingsCollapsibleSection>

                    <SettingsCollapsibleSection
                      title={t('providerPricing.title')}
                      subtitle={t('providerPricing.subtitle')}
                      open={settingsSectionsOpen.pricing}
                      onToggle={() => toggleSettingsSection('pricing')}
                    >
                      <ProviderPricingPreferences
                        providerId={profile.id}
                        serviceTypes={profileServiceTypes}
                      />
                    </SettingsCollapsibleSection>

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
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        style={menuProfileAvatarButtonStyle}
                        aria-label={t('common.changePhoto')}
                      >
                        <ProfileAvatar url={photo.avatarUrl} name={walkerName} size={52} borderRadius={18} />
                      </button>
                      <div style={menuProfileTextStyle}>
                        <div style={profileHeaderTopRowStyle}>
                          <div style={profileNameStyle}>{walkerName}</div>
                          <button
                            type="button"
                            onClick={() => fileInputRef.current?.click()}
                            style={menuChangePhotoButtonStyle}
                          >
                            {t('common.changePhoto')}
                          </button>
                        </div>
                        {profile.email && <div style={profileEmailStyle}>{profile.email}</div>}
                        {providerBioMenuPreview ? (
                          <div style={profileBioPreviewStyle}>{providerBioMenuPreview}</div>
                        ) : null}
                        {flow.avgRating !== null && (
                          <div style={profileRatingStyle}>
                            <span style={{ color: '#F59E0B' }}>★</span> {flow.avgRating} · {flow.ratingsReceived.length} reviews
                          </div>
                        )}
                        {photo.uploading ? <div style={uploadStatusStyle}>Uploading photo...</div> : null}
                        {photo.error ? <div style={uploadErrorStyle}>{photo.error}</div> : null}
                      </div>
                    </div>

                    <div style={menuRowListStyle}>
                      <MenuNavRow icon="⚙️" label={t('menu.settings')} onClick={() => setMenuPage('settings')} />
                      <MenuNavRow icon="₪" label={isHebrew ? 'רווחים' : 'Earnings'} onClick={() => setMenuPage('earnings')} />
                      <MenuNavRow icon="🕘" label={t('menu.tripHistory')} onClick={() => setMenuPage('history')} />
                      <MenuNavRow icon="📅" label={t('menu.futureOrders')} onClick={() => setMenuPage('futureOrders')} />
                      <MenuNavRow icon="♥" label={preferredCustomersLabel} onClick={() => setMenuPage('preferredCustomers')} />
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

          <div
            style={{
              ...contentStyle,
              ...(isHomeDashboard ? homeContentStyle : null),
            }}
          >
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

          {(flow.screenState === 'on_the_way' && onTheWayJob) || (flow.screenState === 'active' && activeJob) ? (() => {
            const missionJob = flow.screenState === 'active' ? activeJob : onTheWayJob
            if (!missionJob) return null

            const isMissionActive = flow.screenState === 'active'
            const missionHasProviderIssue = isMissionActive ? activeJobHasProviderIssue : onTheWayJobHasProviderIssue
            const missionCustomerName = getCustomerDisplayName(
              {
                client: missionJob.client ?? null,
                clientName: missionJob.client?.full_name || missionJob.client?.email || null,
                dogName: missionJob.dog_name || null,
              },
              isHebrew,
            )
            const missionDogCountLabel = isDogServiceType(missionJob.service_type)
              ? formatDogCountLabel(missionJob.dog_count ?? 1, { isHebrew })
              : null
            const missionAddress = missionJob.location ? formatShortAddress(missionJob.address || missionJob.location) : null
            const missionNote = getDisplayServiceNote(missionJob.service_type, missionJob.notes)
            const isFixedVisitMission = getBookingPricingModelForService(missionJob.service_type) === 'fixed_visit'
            const missionFixedVisitPriceLabel = formatMoney(
              missionJob.walker_earnings ?? getEstimatedProviderEarnings(missionJob) ?? missionJob.price,
            )

            const missionStatusLabel = isMissionActive
              ? activeLabels.activeTitle
              : flow.screenPhase === 'arrived_pending_confirmation'
                ? (isHebrew ? 'ממתין לאישור הלקוח' : 'Waiting for confirmation')
                : flow.screenPhase === 'arrival_confirmed'
                  ? (isHebrew ? 'הגעת ללקוח' : 'Arrived')
                  : (isHebrew ? 'בדרך ללקוח' : 'On the way')

            const missionHeadline = isMissionActive
              ? (missionJob.dog_name || (isHebrew ? 'השירות פעיל' : 'Service is live'))
              : missionJob.dog_name || (isHebrew ? 'משימה פעילה' : 'Live mission')

            const missionSubline = isMissionActive
              ? (isHebrew ? 'השירות פעיל כעת' : 'Your service is now active')
              : flow.screenPhase === 'arrival_confirmed'
                ? (isHebrew ? 'אפשר להתחיל את השירות' : 'Ready to start the service')
                : flow.screenPhase === 'arrived_pending_confirmation'
                  ? (isHebrew ? 'ממתין לאישור הלקוח כדי להתחיל' : 'Waiting for client confirmation to start')
                  : (isHebrew ? 'נווט אל הלקוח והכן את השירות' : 'Head to the client and prepare the service')

            const missionProgressStep = isMissionActive
              ? 3
              : flow.screenPhase === 'arrival_confirmed' || flow.screenPhase === 'arrived_pending_confirmation'
                ? 2
                : 1

            const missionMetaItems = isMissionActive
              ? (
                  isFixedVisitMission
                    ? [
                        { label: t('tracking.visitFee'), value: missionFixedVisitPriceLabel },
                        activeDurationSummary.elapsedLabel
                          ? { label: isHebrew ? 'עבר' : 'Elapsed', value: activeDurationSummary.elapsedLabel }
                          : null,
                      ].filter(Boolean)
                    : [
                        activeDurationSummary.elapsedLabel
                          ? { label: isHebrew ? 'עבר' : 'Elapsed', value: activeDurationSummary.elapsedLabel }
                          : null,
                        activeDurationSummary.plannedLabel
                          ? { label: isHebrew ? 'מתוכנן' : 'Planned', value: activeDurationSummary.plannedLabel }
                          : null,
                        activeDurationSummary.actualLabel
                          ? { label: isHebrew ? 'בפועל' : 'Actual', value: activeDurationSummary.actualLabel }
                          : null,
                      ].filter(Boolean)
                ) as Array<{ label: string; value: string }>
              : [
                  isFixedVisitMission
                    ? { label: t('tracking.visitFee'), value: missionFixedVisitPriceLabel }
                    : missionJob.duration_minutes
                      ? { label: isHebrew ? 'משך' : 'Duration', value: durationFromMinutes(missionJob.duration_minutes) }
                      : null,
                  !isFixedVisitMission && missionDogCountLabel
                    ? { label: isHebrew ? 'פרטים' : 'Details', value: missionDogCountLabel }
                    : null,
                ].filter(Boolean) as Array<{ label: string; value: string }>

            const missionCtaDisabled = isMissionActive
              ? flow.completingJobId === missionJob.id ||
                flow.pendingClientConfirmation === missionJob.id ||
                !activeJobCanComplete
              : flow.screenPhase === 'arrived_pending_confirmation'

            const missionCtaLabel = isMissionActive
              ? flow.completingJobId === missionJob.id
                ? (isHebrew ? 'מסיים...' : 'Completing...')
                : flow.pendingClientConfirmation === missionJob.id
                  ? t('completion.walkerWaiting')
                  : activeJobCanComplete
                    ? walkerCompleteServiceLabel
                    : (isHebrew ? 'זמין במועד השירות' : 'Available at dispatch time')
              : flow.screenPhase === 'on_the_way'
                ? (isHebrew ? 'הגעתי' : 'Confirm arrival')
                : flow.screenPhase === 'arrival_confirmed'
                  ? walkerStartServiceLabel
                  : (isHebrew ? 'ממתין ללקוח' : 'Waiting for client')

            const missionSupportTitle = missionHasProviderIssue
              ? (isHebrew ? 'ממתין לבדיקת התמיכה' : 'Waiting for support review')
              : flow.screenPhase === 'arrived_pending_confirmation'
                ? (isHebrew ? 'ממתין לאישור הלקוח' : 'Waiting for client confirmation')
                : (isHebrew ? 'מוכן לשלב הבא' : 'Ready for the next step')

            const missionSupportBody = missionHasProviderIssue
              ? (
                  isHebrew
                    ? 'השירות חסום כרגע עד לעדכון מצוות התמיכה.'
                    : 'This mission is temporarily blocked until support reviews the request.'
                )
              : flow.screenPhase === 'arrived_pending_confirmation'
                ? (isHebrew ? 'השירות יתחיל ברגע שהלקוח יאשר שהגעת.' : 'The service can start as soon as the client confirms you are with them.')
                : (isHebrew ? 'הכול מוכן. אפשר להתקדם לשלב הבא.' : 'Everything is ready. You can move to the next step.')

            return (
              <div className="sheet-state-enter" style={activeCardStyle}>
                <div style={activeHeaderRowStyle}>
                  <div style={isMissionActive ? activeBadgeStyle : onTheWayBadgeStyle}>
                    <div style={isMissionActive ? activeBadgeDotStyle : onTheWayBadgeDotStyle} />
                    {missionStatusLabel}
                  </div>
                </div>

                <div style={missionProgressStyle}>
                  {[1, 2, 3].map((step) => (
                    <span
                      key={step}
                      style={{
                        ...missionProgressSegmentStyle,
                        opacity: step <= missionProgressStep ? 1 : 0.28,
                      }}
                    />
                  ))}
                </div>

                <div style={missionHeroStackStyle}>
                  <h3 style={activeDogNameStyle}>{missionHeadline}</h3>
                  <p style={missionSublineStyle}>{missionSubline}</p>
                  <p style={activeClientStyle}>
                    {isHebrew ? 'עבור ' : 'for '}
                    {missionCustomerName}
                    {missionDogCountLabel ? ` · ${missionDogCountLabel}` : ''}
                  </p>
                </div>

                {missionAddress && (
                  <div style={activeLocationStyle}>
                    <div style={missionInfoLabelStyle}>{isHebrew ? 'מיקום הלקוח' : 'Client location'}</div>
                    <span style={ellipsisStyle}>{missionAddress}</span>
                  </div>
                )}

                {missionNote && (
                  <div style={missionNotesStyle}>
                    <div style={missionInfoLabelStyle}>{isHebrew ? 'הערות שירות' : 'Service notes'}</div>
                    <div style={missionNotesBodyStyle}>{missionNote}</div>
                  </div>
                )}

                {flow.completionPaymentError?.jobId === missionJob.id && (
                  <div style={completionPaymentErrorStyle}>
                    {flow.completionPaymentError.message}
                  </div>
                )}

                {missionMetaItems.length > 0 && (
                  <div style={serviceTimerPanelStyle}>
                    {missionMetaItems.map((item) => (
                      <div key={item.label} style={missionMetaCardStyle}>
                        <span style={serviceTimerLabelStyle}>{item.label}</span>
                        <span style={serviceTimerValueStyle}>{item.value}</span>
                      </div>
                    ))}
                  </div>
                )}

                {(missionHasProviderIssue || flow.screenPhase === 'arrived_pending_confirmation' || flow.screenPhase === 'arrival_confirmed') && (
                  <div style={waitingStateStyle}>
                    <div style={waitingStateTitleStyle}>{missionSupportTitle}</div>
                    <div style={waitingStateBodyStyle}>{missionSupportBody}</div>
                    {missionHasProviderIssue ? (
                      <div style={reportIssueFeedbackStyle}>
                        {isHebrew ? 'המשימה תישאר מושהית עד לעדכון מהתמיכה.' : 'The mission will stay paused until support updates the request.'}
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

                {(!missionHasProviderIssue || (!isMissionActive && flow.screenPhase === 'on_the_way')) && (
                  <button
                    onClick={async () => {
                      await hapticSuccess()
                      if (isMissionActive) {
                        void flow.handleComplete(missionJob.id)
                        return
                      }
                      if (flow.screenPhase === 'on_the_way') {
                        void flow.markArrived(missionJob.id)
                        return
                      }
                      void flow.startService(missionJob.id)
                    }}
                    disabled={missionCtaDisabled}
                    style={{
                      ...completeBtnStyle,
                      ...(isMissionActive && flow.pendingClientConfirmation === missionJob.id ? pendingConfirmationBtnStyle : null),
                      opacity: missionCtaDisabled ? 0.72 : 1,
                      cursor: missionCtaDisabled ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {missionCtaLabel}
                  </button>
                )}
              </div>
            )
          })() : null}

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
              <div style={incomingClientHeroStyle}>
                <ProfileAvatar
                  name={getCustomerDisplayName(
                    {
                      client: topRequest.client ?? null,
                      clientName: topRequest.client?.full_name || topRequest.client?.email || null,
                      dogName: topRequest.dog_name || null,
                    },
                    isHebrew,
                  )}
                  url={topRequest.client?.avatar_url ?? null}
                  size={58}
                />
                <div style={incomingClientHeroBodyStyle}>
                  <div style={incomingClientHeroNameStyle}>
                    {getCustomerDisplayName(
                      {
                        client: topRequest.client ?? null,
                        clientName: topRequest.client?.full_name || topRequest.client?.email || null,
                        dogName: topRequest.dog_name || null,
                      },
                      isHebrew,
                    )}
                  </div>
                  <div style={incomingClientHeroMetaStyle}>
                    {isHebrew ? 'לקוח פעיל' : 'Active client'}
                  </div>
                </div>
              </div>

                <div style={incomingInfoCardStyle}>
                  <div style={incomingInfoLabelStyle}>
                    {isFixedVisitRequest
                    ? (isHebrew ? 'שירות' : 'Service')
                    : isBabysitterRequest
                      ? (isHebrew ? 'פרטי שירות' : 'Service details')
                      : (isHebrew ? 'שם' : 'Name')}
                </div>
                <div style={dogNameStyle}>
                  {isFixedVisitRequest
                    ? topRequest.notes || t('tracking.fixedVisit')
                    : isBabysitterRequest
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
                      {isFixedVisitRequest
                      ? t('tracking.visitFee')
                      : isBabysitterRequest
                        ? (isHebrew ? 'משך מבוקש' : 'Requested duration')
                        : t('booking.durationQuestion')}
                    </span>
                    <span style={incomingMetaValueStyle}>
                      {isFixedVisitRequest
                      ? requestPrice
                      : isBabysitterRequest
                      ? babysitterRequestNotes.duration || requestDuration
                      : `${requestDuration}${isDogServiceType(topRequest.service_type) ? ` · ${requestDogCountLabel}` : ''}`}
                  </span>
                </div>
                <div style={incomingMetaCardStyle}>
                  <span style={incomingMetaLabelStyle}>
                    {isBabysitterRequest ? (isHebrew ? 'תקציב לקוח' : 'Client budget') : t('booking.priceLabel')}
                  </span>
                  <span style={incomingPriceValueStyle}>
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

function SettingsCollapsibleSection({
  title,
  subtitle,
  open,
  onToggle,
  children,
}: {
  title: string
  subtitle?: string
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <section style={burgerSectionStyle}>
      <button type="button" onClick={onToggle} style={settingsCollapseButtonStyle} aria-expanded={open}>
        <div style={settingsCollapseButtonTextStyle}>
          <div style={burgerSectionTitleStyle}>{title}</div>
          {subtitle ? <div style={burgerSectionSubtitleStyle}>{subtitle}</div> : null}
        </div>
        <span style={settingsCollapseIconStyle}>{open ? '−' : '+'}</span>
      </button>
      {open ? children : null}
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

const homeScreenStyle: React.CSSProperties = {
  overflowY: 'hidden',
}

const dashboardBackgroundStyle: React.CSSProperties = {
  minHeight: '100dvh',
  background: 'linear-gradient(180deg, #FAFBFD 0%, #F4F7FB 100%)',
}

const homeDashboardBackgroundStyle: React.CSSProperties = {
  height: '100dvh',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
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

const homeHeaderStyle: React.CSSProperties = {
  position: 'relative',
  flexShrink: 0,
  marginBottom: 0,
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

const headerRatingStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.3,
  color: '#475569',
  fontWeight: 700,
}

const headerRatingStarStyle: React.CSSProperties = {
  color: '#D4A017',
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
  alignItems: 'flex-start',
  gap: 14,
  textAlign: 'left',
}

const menuProfileAvatarButtonStyle: React.CSSProperties = {
  appearance: 'none',
  padding: 0,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  flexShrink: 0,
}

const menuProfileTextStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'grid',
  gap: 4,
}

const profileHeaderTopRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
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

const settingsCollapseButtonStyle: React.CSSProperties = {
  appearance: 'none',
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 14,
  padding: 0,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  textAlign: 'start',
}

const settingsCollapseButtonTextStyle: React.CSSProperties = {
  minWidth: 0,
  display: 'grid',
  gap: 4,
  flex: 1,
}

const settingsCollapseIconStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 999,
  border: '1px solid #E2E8F0',
  background: '#FFFFFF',
  color: '#334155',
  display: 'grid',
  placeItems: 'center',
  fontSize: 18,
  fontWeight: 800,
  flexShrink: 0,
  lineHeight: 1,
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

const preferredCustomerListStyle: React.CSSProperties = {
  display: 'grid',
  gap: 10,
}

const preferredCustomerCardStyle: React.CSSProperties = {
  border: '1px solid #E2E8F0',
  background: '#FFFFFF',
  borderRadius: 22,
  padding: '14px 16px',
  boxShadow: '0 10px 24px rgba(15,23,42,0.04)',
}

const preferredCustomerIdentityStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  minWidth: 0,
}

const preferredCustomerTextStyle: React.CSSProperties = {
  minWidth: 0,
  display: 'grid',
  gap: 3,
}

const preferredCustomerNameStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 800,
  color: '#0F172A',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const preferredCustomerMetaStyle: React.CSSProperties = {
  fontSize: 12,
  lineHeight: 1.4,
  color: '#64748B',
  fontWeight: 600,
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
  minWidth: 0,
}

const profileEmailStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#94A3B8',
}

const profileBioPreviewStyle: React.CSSProperties = {
  fontSize: 12.5,
  color: '#475569',
  lineHeight: 1.35,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const profileRatingStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#64748B',
  fontWeight: 700,
}

const menuChangePhotoButtonStyle: React.CSSProperties = {
  flexShrink: 0,
  padding: '5px 9px',
  borderRadius: 999,
  border: '1px solid rgba(226,232,240,0.95)',
  background: 'rgba(248,250,252,0.96)',
  color: '#0F172A',
  fontSize: 11,
  fontWeight: 800,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const uploadStatusStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#64748B',
}

const uploadErrorStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#DC2626',
}

const languageSelectorRowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 8,
  justifyContent: 'start',
  maxWidth: 152,
}

const languageButtonStyle: React.CSSProperties = {
  appearance: 'none',
  minHeight: 32,
  borderRadius: 12,
  border: '1px solid #E2E8F0',
  background: '#FFFFFF',
  color: '#334155',
  fontSize: 12,
  fontWeight: 800,
  padding: '0 10px',
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
  gap: 7,
}

const serviceTypeButtonStyle: React.CSSProperties = {
  appearance: 'none',
  minHeight: 46,
  borderRadius: 13,
  border: '1px solid rgba(203, 213, 225, 0.95)',
  background: 'linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(248,250,252,0.98) 100%)',
  color: '#334155',
  padding: '8px 9px',
  display: 'grid',
  alignItems: 'center',
  justifyContent: 'center',
  gridTemplateColumns: '18px minmax(0, 1fr)',
  columnGap: 7,
  textAlign: 'center',
  cursor: 'pointer',
  boxShadow: '0 6px 16px rgba(15, 23, 42, 0.04)',
}

const serviceTypeButtonActiveStyle: React.CSSProperties = {
  borderColor: 'rgba(30, 64, 175, 0.28)',
  background: 'linear-gradient(180deg, rgba(37, 99, 235, 0.14) 0%, rgba(15, 23, 42, 0.08) 100%)',
  boxShadow: '0 10px 22px rgba(37, 99, 235, 0.12), inset 0 1px 0 rgba(255,255,255,0.4)',
}

const serviceTypeButtonIconStyle: React.CSSProperties = {
  fontSize: 15,
  lineHeight: 1,
  flexShrink: 0,
}

const serviceTypeButtonIconActiveStyle: React.CSSProperties = {
  filter: 'saturate(1.1)',
}

const serviceTypeButtonLabelStyle: React.CSSProperties = {
  fontSize: 11.5,
  fontWeight: 800,
  color: '#1E293B',
  whiteSpace: 'normal',
  lineHeight: 1.2,
  overflowWrap: 'anywhere',
}

const serviceTypeButtonLabelActiveStyle: React.CSSProperties = {
  color: '#0F172A',
}

const serviceTypeButtonMetaStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  color: '#0F172A',
  gridColumn: '1 / -1',
  justifySelf: 'center',
  marginTop: 2,
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

const serviceTypeStatusMutedStyle: React.CSSProperties = {
  marginTop: 10,
  fontSize: 12,
  fontWeight: 600,
  color: '#64748B',
}

const providerBioSectionStyle: React.CSSProperties = {
  display: 'grid',
  gap: 10,
}

const providerBioFieldStyle: React.CSSProperties = {
  display: 'grid',
  gap: 6,
}

const providerBioFieldLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: '#64748B',
}

const providerBioInputStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 42,
  borderRadius: 14,
  border: '1px solid rgba(226, 232, 240, 0.95)',
  background: 'rgba(255,255,255,0.96)',
  padding: '0 14px',
  fontSize: 13.5,
  lineHeight: 1.4,
  color: '#0F172A',
  boxSizing: 'border-box',
  outline: 'none',
  fontFamily: 'inherit',
}

const providerBioTextareaStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 84,
  borderRadius: 16,
  border: '1px solid rgba(226, 232, 240, 0.95)',
  background: 'rgba(255,255,255,0.96)',
  padding: '10px 14px',
  fontSize: 13.5,
  lineHeight: 1.45,
  color: '#0F172A',
  boxSizing: 'border-box',
  resize: 'none',
  outline: 'none',
  fontFamily: 'inherit',
}

const providerBioFooterStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
}

const providerBioCounterStyle: React.CSSProperties = {
  fontSize: 11.5,
  fontWeight: 700,
  color: '#64748B',
}

const providerBioSaveButtonStyle: React.CSSProperties = {
  appearance: 'none',
  minHeight: 34,
  borderRadius: 12,
  border: '1px solid rgba(15, 23, 42, 0.10)',
  background: 'linear-gradient(180deg, #172554 0%, #0F172A 100%)',
  color: '#FFFFFF',
  padding: '0 12px',
  fontSize: 12.5,
  fontWeight: 800,
  cursor: 'pointer',
  fontFamily: 'inherit',
  flexShrink: 0,
}

const providerBioSaveButtonDisabledStyle: React.CSSProperties = {
  opacity: 0.7,
  cursor: 'default',
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
  width: '100%',
  maxWidth: 560,
  margin: '0 auto',
}

const homeContentStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  overflow: 'hidden',
  paddingTop: 10,
  paddingBottom: 'calc(18px + env(safe-area-inset-bottom))',
}

const homeDashboardShellStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 0,
}

const homeDashboardStatusSectionStyle: React.CSSProperties = {
  width: '100%',
  flexShrink: 0,
}

const homeDashboardSummaryStackStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'space-between',
  gap: 10,
  paddingTop: 18,
}

const homeDashboardMiddleGroupStyle: React.CSSProperties = {
  display: 'grid',
  gap: 8,
  marginTop: 'auto',
  marginBottom: 'auto',
}

const homeDashboardWalletSectionStyle: React.CSSProperties = {
  flexShrink: 0,
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
  width: '100%',
  padding: '14px 16px',
  borderRadius: 28,
  background:
    'linear-gradient(180deg, #FFFFFF 0%, #F9FBFD 100%)',
  border: '1px solid rgba(226,232,240,0.95)',
  boxShadow: '0 14px 28px rgba(15,23,42,0.06)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
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
  width: 66,
  height: 56,
  display: 'grid',
  placeItems: 'center',
  flexShrink: 0,
}

const homeStatusAccentOrbStyle: React.CSSProperties = {
  position: 'absolute',
  right: -8,
  top: -6,
  width: 68,
  height: 68,
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
  fontSize: 18,
  lineHeight: 1.08,
  fontWeight: 900,
  color: '#0F172A',
}

const homeStatusBodyStyle: React.CSSProperties = {
  fontSize: 10.5,
  lineHeight: 1.3,
  color: '#64748B',
}

const todayAvailabilityCardStyle: React.CSSProperties = {
  width: '100%',
  borderRadius: 24,
  background: 'linear-gradient(180deg, #FFFFFF 0%, #FBFCFE 100%)',
  border: '1px solid #E7EDF4',
  boxShadow: '0 12px 24px rgba(15,23,42,0.04)',
  padding: '11px 13px 9px',
  display: 'grid',
  gap: 6,
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

const todayAvailabilityPricingCardStyle: React.CSSProperties = {
  width: '100%',
  borderRadius: 24,
  background: 'linear-gradient(180deg, #FFFFFF 0%, #FBFCFE 100%)',
  border: '1px solid #E7EDF4',
  boxShadow: '0 12px 24px rgba(15,23,42,0.04)',
  padding: '11px 13px 9px',
  display: 'grid',
  gap: 6,
  overflow: 'visible',
}

const pricingSummaryRowStyle: React.CSSProperties = {
  gridTemplateColumns: 'minmax(0, 74px) minmax(0, 1fr) auto',
  alignItems: 'center',
  gap: 10,
}

const pricingSummaryBookingTypeStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 800,
  color: '#334155',
}

const pricingSummaryPriceStyle: React.CSSProperties = {
  minWidth: 0,
  fontSize: 13,
  fontWeight: 900,
  color: '#0F172A',
}

const pricingSummaryRangeWrapStyle: React.CSSProperties = {
  position: 'relative',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  justifySelf: 'end',
  maxWidth: '100%',
  overflow: 'visible',
}

const pricingSummaryRangeLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: '#64748B',
  whiteSpace: 'nowrap',
}

const pricingSummaryInfoButtonStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 18,
  height: 18,
  borderRadius: 999,
  border: 'none',
  background: 'transparent',
  padding: 0,
  cursor: 'pointer',
  flexShrink: 0,
  WebkitTapHighlightColor: 'transparent',
}

const pricingSummaryInfoIconStyle: React.CSSProperties = {
  fontSize: 12,
  lineHeight: 1,
  color: '#94A3B8',
  flexShrink: 0,
  pointerEvents: 'none',
}

const pricingSummaryTooltipBubbleStyle: React.CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 10px)',
  right: 0,
  zIndex: 40,
  minWidth: 164,
  maxWidth: 220,
  borderRadius: 14,
  padding: '10px 12px',
  background: 'rgba(15, 23, 42, 0.96)',
  color: '#F8FAFC',
  fontSize: 12,
  lineHeight: 1.45,
  fontWeight: 600,
  boxShadow: '0 16px 40px rgba(15, 23, 42, 0.22)',
  backdropFilter: 'blur(16px)',
  WebkitBackdropFilter: 'blur(16px)',
  whiteSpace: 'normal',
  textAlign: 'start',
}

const todayAvailabilityPricingSubtitleStyle: React.CSSProperties = {
  fontSize: 12,
  lineHeight: 1.45,
  color: '#64748B',
  fontWeight: 600,
}

const todayAvailabilityListStyle: React.CSSProperties = {
  display: 'grid',
}

const todayAvailabilityRowStyle: React.CSSProperties = {
  minHeight: 40,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
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

const dashboardSectionStyle: React.CSSProperties = {
  display: 'grid',
  gap: 8,
  width: '100%',
}

const dashboardSectionTitleStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 800,
  color: '#0F172A',
}

const walletSectionStyle: React.CSSProperties = {
  marginTop: 6,
}

const walletDashboardGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 7,
}

const walletDashboardMetricCardStyle: React.CSSProperties = {
  padding: '10px 11px 9px',
  borderRadius: 20,
  background: '#FFFFFF',
  border: '1px solid #E7EDF4',
  boxShadow: '0 8px 16px rgba(15,23,42,0.035)',
  display: 'grid',
  gap: 4,
  minHeight: 66,
}

const walletDashboardMetricLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: '#64748B',
  lineHeight: 1.35,
}

const walletDashboardMetricValueStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 900,
  color: '#0F172A',
}

const walletDashboardStatusRowStyle: React.CSSProperties = {
  minHeight: 28,
  padding: '0 2px',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
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
  position: 'fixed',
  left: 18,
  right: 18,
  bottom: 'calc(12px + env(safe-area-inset-bottom))',
  width: 'auto',
  maxWidth: 560,
  margin: '0 auto',
  zIndex: 34,
  padding: '18px',
  borderRadius: 30,
  background: 'linear-gradient(180deg, rgba(8,15,33,0.98) 0%, rgba(14,23,43,0.98) 100%)',
  border: '1px solid rgba(96, 165, 250, 0.12)',
  boxShadow: '0 24px 52px rgba(2,6,23,0.34), inset 0 1px 0 rgba(255,255,255,0.04)',
  display: 'flex',
  flexDirection: 'column',
  boxSizing: 'border-box',
  gap: 14,
}

const activeHeaderRowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
}

const activeBadgeStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 12px',
  borderRadius: 999,
  background: 'rgba(34, 197, 94, 0.14)',
  color: '#BBF7D0',
  fontSize: 12,
  fontWeight: 800,
  letterSpacing: 0.2,
  boxShadow: 'inset 0 0 0 1px rgba(74, 222, 128, 0.18)',
}

const activeBadgeDotStyle: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: 999,
  background: '#4ADE80',
  boxShadow: '0 0 0 6px rgba(74, 222, 128, 0.16)',
}

const onTheWayBadgeStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 12px',
  borderRadius: 999,
  background: 'rgba(59, 130, 246, 0.16)',
  color: '#BFDBFE',
  fontSize: 12,
  fontWeight: 800,
  letterSpacing: 0.2,
  boxShadow: 'inset 0 0 0 1px rgba(96, 165, 250, 0.16)',
}

const onTheWayBadgeDotStyle: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: 999,
  background: '#60A5FA',
  boxShadow: '0 0 0 6px rgba(96, 165, 250, 0.14)',
}

const missionProgressStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  gap: 8,
}

const missionProgressSegmentStyle: React.CSSProperties = {
  height: 4,
  borderRadius: 999,
  background: 'linear-gradient(90deg, rgba(96,165,250,0.92) 0%, rgba(56,189,248,0.92) 100%)',
  transition: 'opacity 180ms ease',
}

const missionHeroStackStyle: React.CSSProperties = {
  display: 'grid',
  gap: 4,
}

const activeDogNameStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 24,
  fontWeight: 800,
  color: '#F8FAFC',
}

const missionSublineStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  fontWeight: 700,
  color: 'rgba(191, 219, 254, 0.94)',
}

const activeClientStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 15,
  color: 'rgba(203, 213, 225, 0.82)',
  fontWeight: 700,
}

const activeLocationStyle: React.CSSProperties = {
  padding: '14px 16px',
  borderRadius: 18,
  background: 'rgba(15, 23, 42, 0.62)',
  border: '1px solid rgba(148, 163, 184, 0.14)',
  color: '#F8FAFC',
  display: 'grid',
  gap: 6,
}

const missionInfoLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  color: 'rgba(148, 163, 184, 0.86)',
  letterSpacing: 0.4,
  textTransform: 'uppercase',
}

const missionNotesStyle: React.CSSProperties = {
  padding: '14px 16px',
  borderRadius: 18,
  background: 'rgba(15, 23, 42, 0.42)',
  border: '1px solid rgba(148, 163, 184, 0.12)',
  display: 'grid',
  gap: 6,
}

const missionNotesBodyStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.55,
  color: 'rgba(226, 232, 240, 0.88)',
}

const completionPaymentErrorStyle: React.CSSProperties = {
  padding: '12px 14px',
  borderRadius: 16,
  background: 'rgba(127, 29, 29, 0.32)',
  border: '1px solid rgba(248, 113, 113, 0.22)',
  color: '#FECACA',
  fontSize: 13,
  fontWeight: 700,
  lineHeight: 1.45,
}

const waitingStateStyle: React.CSSProperties = {
  padding: '14px 16px',
  borderRadius: 18,
  background: 'rgba(15, 23, 42, 0.5)',
  border: '1px solid rgba(148, 163, 184, 0.12)',
  display: 'grid',
  gap: 6,
}

const waitingStateTitleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 800,
  color: '#F8FAFC',
}

const waitingStateBodyStyle: React.CSSProperties = {
  fontSize: 13,
  color: 'rgba(203, 213, 225, 0.82)',
  lineHeight: 1.45,
}

const ellipsisStyle: React.CSSProperties = {
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const completeBtnStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 56,
  alignSelf: 'stretch',
  flexShrink: 0,
  borderRadius: 20,
  border: '1px solid rgba(125, 211, 252, 0.12)',
  background: 'linear-gradient(180deg, #17306D 0%, #0D1E49 100%)',
  color: '#FFFFFF',
  fontSize: 15,
  fontWeight: 800,
  cursor: 'pointer',
  padding: '14px 18px',
  lineHeight: 1.2,
  boxSizing: 'border-box',
  WebkitTapHighlightColor: 'transparent',
  boxShadow: '0 18px 34px rgba(29, 78, 216, 0.22)',
}

const pendingConfirmationBtnStyle: React.CSSProperties = {
  background: 'linear-gradient(180deg, #F59E0B 0%, #D97706 100%)',
  color: '#FFFFFF',
  border: '1px solid rgba(251, 191, 36, 0.28)',
}

const serviceTimerPanelStyle: React.CSSProperties = {
  borderRadius: 20,
  background: 'transparent',
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))',
  gap: 10,
}

const serviceTimerLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: 'rgba(148, 163, 184, 0.9)',
  textTransform: 'uppercase',
  letterSpacing: 0.35,
}

const serviceTimerValueStyle: React.CSSProperties = {
  fontSize: 17,
  fontWeight: 800,
  color: '#F8FAFC',
  fontVariantNumeric: 'tabular-nums',
}

const missionMetaCardStyle: React.CSSProperties = {
  minHeight: 66,
  borderRadius: 18,
  background: 'rgba(15, 23, 42, 0.54)',
  border: '1px solid rgba(96, 165, 250, 0.12)',
  padding: '12px 14px',
  display: 'grid',
  alignContent: 'space-between',
  gap: 8,
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
  minHeight: 40,
  borderRadius: 12,
  border: '1px solid rgba(248, 113, 113, 0.22)',
  background: 'rgba(127, 29, 29, 0.2)',
  color: '#FCA5A5',
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
  color: '#93C5FD',
  textAlign: 'center',
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
  background: 'linear-gradient(180deg, rgba(8,15,33,0.99) 0%, rgba(14,23,43,0.99) 100%)',
  borderTopLeftRadius: 28,
  borderTopRightRadius: 28,
  padding: '18px 18px calc(18px + env(safe-area-inset-bottom))',
  boxShadow: '0 -24px 70px rgba(2,6,23,0.45)',
  borderTop: '1px solid rgba(96, 165, 250, 0.12)',
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
  color: '#F8FAFC',
}

const incomingSheetSubtitleStyle: React.CSSProperties = {
  fontSize: 13,
  color: 'rgba(203, 213, 225, 0.8)',
  fontWeight: 700,
}

const countdownLabelStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 900,
  color: '#F8FAFC',
}

const progressTrackStyle: React.CSSProperties = {
  marginTop: 12,
  height: 6,
  borderRadius: 999,
  background: 'rgba(148, 163, 184, 0.22)',
  overflow: 'hidden',
}

const progressFillStyle: React.CSSProperties = {
  height: '100%',
  borderRadius: 999,
  background: '#F59E0B',
  transition: 'width 1s linear',
}

const dogNameStyle: React.CSSProperties = {
  fontSize: 22,
  fontWeight: 900,
  color: '#F8FAFC',
}

const incomingMainCardStyle: React.CSSProperties = {
  marginTop: 16,
  padding: 18,
  borderRadius: 24,
  background: 'rgba(15, 23, 42, 0.52)',
  border: '1px solid rgba(96, 165, 250, 0.12)',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.03)',
}

const incomingClientHeroStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  marginBottom: 14,
}

const incomingClientHeroBodyStyle: React.CSSProperties = {
  minWidth: 0,
  display: 'grid',
  gap: 4,
}

const incomingClientHeroNameStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 800,
  color: '#F8FAFC',
  lineHeight: 1.2,
}

const incomingClientHeroMetaStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: 'rgba(191, 219, 254, 0.82)',
}

const incomingInfoCardStyle: React.CSSProperties = {
  padding: '14px 16px',
  borderRadius: 18,
  background: 'rgba(8, 15, 33, 0.5)',
  border: '1px solid rgba(148, 163, 184, 0.12)',
  display: 'grid',
  gap: 6,
}

const incomingInfoLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  color: 'rgba(148, 163, 184, 0.86)',
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
}

const reqLocationStyle: React.CSSProperties = {
  marginTop: 10,
  padding: '14px 16px',
  borderRadius: 18,
  background: 'rgba(8, 15, 33, 0.5)',
  border: '1px solid rgba(148, 163, 184, 0.12)',
  color: '#F8FAFC',
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
  background: 'rgba(8, 15, 33, 0.5)',
  border: '1px solid rgba(148, 163, 184, 0.12)',
  display: 'grid',
  gap: 4,
}

const incomingMetaLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  color: 'rgba(148, 163, 184, 0.86)',
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
}

const incomingMetaValueStyle: React.CSSProperties = {
  fontSize: 15,
  color: '#F8FAFC',
  fontWeight: 800,
}

const incomingPriceValueStyle: React.CSSProperties = {
  ...incomingMetaValueStyle,
  fontSize: 24,
  lineHeight: 1.05,
  color: '#4ADE80',
  fontWeight: 900,
  letterSpacing: -0.3,
}

const queueHintStyle: React.CSSProperties = {
  marginTop: 12,
  fontSize: 12,
  color: 'rgba(203, 213, 225, 0.76)',
  fontWeight: 700,
  textAlign: 'center',
}

const ctaContainerStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 10,
  marginTop: 18,
}

const acceptBtnStyle: React.CSSProperties = {
  minHeight: 54,
  borderRadius: 18,
  border: '1px solid rgba(125, 211, 252, 0.12)',
  background: 'linear-gradient(180deg, #17306D 0%, #0D1E49 100%)',
  color: '#FFFFFF',
  fontSize: 16,
  fontWeight: 800,
  cursor: 'pointer',
  boxShadow: '0 18px 34px rgba(29, 78, 216, 0.2)',
}

const declineBtnStyle: React.CSSProperties = {
  minHeight: 54,
  borderRadius: 18,
  border: '1px solid rgba(148, 163, 184, 0.2)',
  background: 'rgba(15, 23, 42, 0.62)',
  color: '#E2E8F0',
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
