import { Capacitor } from '@capacitor/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import NotificationsBell from '../components/NotificationsBell'
import MapView from '../components/MapView'
import ActionButton from '../components/ActionButton'
import SearchingSheet from '../components/SearchingSheet'
import CompletionCard from '../components/CompletionCard'
import ProfileAvatar from '../components/ProfileAvatar'
import ProviderProfileCard from '../components/ProviderProfileCard'
import GroupedHistory from '../components/GroupedHistory'
import type { HistoryItem } from '../components/GroupedHistory'
import type { GpsQuality } from '../hooks/useJobTracking'
import { useClientFlow } from '../hooks/useClientFlow'
import { useProfilePhoto } from '../hooks/useProfilePhoto'
import { useNearbyWalkers } from '../hooks/useNearbyWalkers'
import CardSetupForm from '../components/CardSetupForm'
import type { DurationType } from '../lib/payments'
import {
  type ServiceType,
  SERVICE_ICONS,
  SERVICE_I18N_KEYS,
  getBookingPricingModelForService,
  isServiceAvailable as checkServiceAvailable,
  mapBookingServiceTypeToRequestServiceType,
} from '../lib/serviceTypes'
import { launchEnabledBookingServices } from '../lib/launchServices'
import {
  applyDogCountPricing,
  getGuidanceServiceTypeAliases,
  getBudgetGuidance,
  getBudgetGuidanceFromProviderPreferences,
  getInitialSuggestedBudgetILS,
  type ProviderPricingPreferenceInput,
} from '../lib/pricing'
import {
  getProviderCapabilitySummary,
  mergeProviderCapabilitiesSources,
  type ProviderCapabilityRow,
} from '../lib/providerCapabilities'
import ServiceSelectorPanel from '../components/ServiceSelectorPanel'
import LegalDocumentModal from '../components/LegalDocumentModal'
import DeleteAccountModal from '../components/DeleteAccountModal'
import { hasProviderIssue, isCompletionReviewRequired } from '../utils/completionReview'
import { formatShortAddress } from '../utils/addressFormat'
import { formatDogCountLabel, isDogServiceType, normalizeDogCount } from '../utils/dogCount'
import { formatDurationFromMinutes, getDurationSummary } from '../utils/serviceTiming'
import i18n from '../i18n'
import { hapticLight, hapticMedium, hapticSuccess } from '../utils/haptics'
import { CreditCard } from 'lucide-react'
import AddressPickerSheet from '../components/AddressPickerSheet'
import { detachPaymentMethod, getPaymentMethodLabel } from '../lib/paymentMethods'
import {
  markFirstInteractionHandler,
  markFirstInteractionVisual,
} from '../utils/firstInteractionPerf'
import {
  getProfileServiceTypeLabel,
  normalizeProfileServiceType,
  normalizeProfileServiceTypes,
} from '../lib/profileServiceTypes'
import { supabase } from '../services/supabaseClient'
import { requestAccountDeletion } from '../lib/accountDeletion'
import type { LegalDocumentType } from '../lib/legalAcceptances'
import { normalizeSupportedLanguage, type SupportedLanguage } from '../i18n'

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

function parseBudgetBelowMinimumError(
  value: string | null | undefined,
): { min: number; max: number } | null {
  if (typeof value !== 'string' || !value.startsWith('budget_below_provider_minimum:')) return null
  const [, minRaw = '', maxRaw = ''] = value.split(':')
  const min = Number(minRaw)
  const max = Number(maxRaw)
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0) return null
  return {
    min: Math.round(min),
    max: Math.round(max),
  }
}

function serializeProviderPricingPreferenceRows(rows: ProviderPricingPreferenceInput[]): string {
  return JSON.stringify(
    [...rows]
      .map((row) => ({
        provider_id: row.provider_id ?? null,
        service_type: row.service_type ?? null,
        pricing_model: row.pricing_model ?? null,
        booking_type: row.booking_type ?? null,
        is_enabled: row.is_enabled ?? null,
        hourly_rate_min: row.hourly_rate_min ?? null,
        hourly_rate_preferred: row.hourly_rate_preferred ?? null,
        visit_fee_min: row.visit_fee_min ?? null,
        visit_fee_preferred: row.visit_fee_preferred ?? null,
        accepts_multi_item: row.accepts_multi_item ?? null,
        max_item_count: row.max_item_count ?? null,
      }))
      .sort((a, b) => {
        const left = `${a.provider_id ?? ''}:${a.service_type ?? ''}:${a.booking_type ?? ''}:${a.pricing_model ?? ''}`
        const right = `${b.provider_id ?? ''}:${b.service_type ?? ''}:${b.booking_type ?? ''}:${b.pricing_model ?? ''}`
        return left.localeCompare(right)
      }),
  )
}

function getNowPlus15LocalInput(): string {
  return toLocalDatetimeInputValue(new Date(Date.now() + 15 * 60 * 1000))
}

function resolveProviderServiceLabel(params: {
  requestedServiceType?: string | null
  serviceType?: string | null
  serviceTypes?: unknown
  primaryService?: string | null
  isHebrew: boolean
}): string | null {
  const normalizedRequested = normalizeProfileServiceType(params.requestedServiceType)
  if (normalizedRequested) return getProfileServiceTypeLabel(normalizedRequested, params.isHebrew)

  const normalizedPrimary = normalizeProfileServiceType(params.serviceType)
  if (normalizedPrimary) return getProfileServiceTypeLabel(normalizedPrimary, params.isHebrew)

  const normalizedServiceTypes = normalizeProfileServiceTypes(params.serviceTypes)
  if (normalizedServiceTypes.length > 0) {
    return getProfileServiceTypeLabel(normalizedServiceTypes[0], params.isHebrew)
  }

  const primaryService = typeof params.primaryService === 'string' ? params.primaryService.trim() : ''
  return primaryService || null
}

function clampScheduledDraft(value: string | null | undefined, minValue?: string): string {
  const nextValue = value || getNowPlus15LocalInput()
  const parsedValue = parseLocalDateTime(nextValue)
  const parsedMin = parseLocalDateTime(minValue || getNowPlus15LocalInput())
  if (!parsedValue || !parsedMin) return nextValue
  return parsedValue.getTime() < parsedMin.getTime() ? (minValue || getNowPlus15LocalInput()) : nextValue
}

function splitScheduledDraft(value: string): { date: string; time: string } {
  const parsed = parseLocalDateTime(value) || new Date()
  return {
    date: `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`,
    time: `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`,
  }
}

function mergeScheduledDraft(datePart: string, timePart: string): string {
  if (!datePart || !timePart) return ''
  return `${datePart}T${timePart}`
}

type ClientBookingBudgetDraft = {
  babysitterBudgetFixed?: string
  dogWalkerBudgetFixed?: string
}

function clientBookingDraftStorageKey(profileId: string): string {
  return `regli_client_last_booking_${profileId}`
}

function readClientBookingBudgetDraft(profileId: string): ClientBookingBudgetDraft | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(clientBookingDraftStorageKey(profileId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as ClientBookingBudgetDraft
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function mergeClientBookingBudgetDraft(profileId: string, patch: ClientBookingBudgetDraft): void {
  if (typeof window === 'undefined') return
  try {
    const key = clientBookingDraftStorageKey(profileId)
    const current = readClientBookingBudgetDraft(profileId) ?? {}
    window.localStorage.setItem(
      key,
      JSON.stringify({
        ...current,
        ...patch,
      }),
    )
  } catch {
    // noop
  }
}

function safeScrollTo(el: HTMLElement | null, options: ScrollToOptions): void {
  if (!el || typeof el.scrollTo !== 'function') return
  el.scrollTo(options)
}

function bookingSubjectStorageKey(profileId: string, requestServiceType: string | null): string {
  const normalizedServiceType = (requestServiceType ?? 'default').trim().toLowerCase() || 'default'
  return `regli_client_recent_subjects_${profileId}_${normalizedServiceType}`
}

function bookingSubjectSelectedStorageKey(profileId: string, requestServiceType: string | null): string {
  const normalizedServiceType = (requestServiceType ?? 'default').trim().toLowerCase() || 'default'
  return `regli_client_selected_subject_${profileId}_${normalizedServiceType}`
}

function readRecentBookingSubjects(profileId: string, requestServiceType: string | null): string[] {
  try {
    const raw = window.localStorage.getItem(bookingSubjectStorageKey(profileId, requestServiceType))
    if (!raw) return []
    const parsed = JSON.parse(raw) as string[]
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((name) => normalizeDogName(String(name ?? '')))
      .filter(Boolean)
      .slice(0, 8)
  } catch {
    return []
  }
}

function writeRecentBookingSubjects(profileId: string, requestServiceType: string | null, names: string[]): void {
  try {
    window.localStorage.setItem(
      bookingSubjectStorageKey(profileId, requestServiceType),
      JSON.stringify(names),
    )
  } catch {
    // noop
  }
}

function normalizeDogName(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

function capitalize(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value
}

type AppRole = 'client' | 'walker' | 'admin'
type SheetSnap = 'collapsed' | 'default'
type MenuPage = 'main' | 'settings' | 'history' | 'futureOrders'
type ClientSettingsSectionKey =
  | 'language'
  | 'preferredProviders'
  | 'legal'
  | 'account'
type WheelOption = {
  value: string
  label: string
}

const SHEET_DRAG_HANDLE_SELECTOR = '[data-sheet-drag-handle="true"]'
const SHEET_DRAG_SURFACE_SELECTOR = '[data-sheet-drag-surface="true"]'
const SHEET_DRAG_INTERACTIVE_SELECTOR = [
  'button',
  'input',
  'textarea',
  'select',
  'option',
  'a',
  'label',
  '[role="button"]',
  '[role="link"]',
  '[data-control]',
  '[data-no-sheet-drag="true"]',
].join(', ')

const BABYSITTER_DURATION_MIN = 0
const BABYSITTER_DURATION_MAX = 24
const BABYSITTER_DURATION_STEP = 0.5
const BABYSITTER_DEFAULT_DURATION_HOURS = 1
const BABYSITTER_BUDGET_MIN_ILS = 0
const BABYSITTER_BUDGET_MAX_ILS = 500
const BABYSITTER_BUDGET_STEP_ILS = 5
const BABYSITTER_DEFAULT_FIXED_BUDGET_ILS = getInitialSuggestedBudgetILS({
  serviceType: 'baby_sitter',
  durationMinutes: BABYSITTER_DEFAULT_DURATION_HOURS * 60,
})
const DOG_WALKER_DURATION_MIN = 0
const DOG_WALKER_DURATION_MAX = 24
const DOG_WALKER_DURATION_STEP = 0.5
const DOG_WALKER_DEFAULT_DURATION_HOURS = 1
const DOG_WALKER_BUDGET_MIN_ILS = 0
const DOG_WALKER_BUDGET_MAX_ILS = 500
const DOG_WALKER_BUDGET_STEP_ILS = 5
const DOG_WALKER_DEFAULT_BUDGET_ILS = getInitialSuggestedBudgetILS({
  serviceType: 'dog_walker',
  durationMinutes: DOG_WALKER_DEFAULT_DURATION_HOURS * 60,
  dogCount: 1,
})

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function parseNumberOrFallback(value: string, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function formatHoursValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function durationTypeFromMinutes(minutes: number): DurationType {
  if (minutes <= 120) return '20min'
  if (minutes <= 240) return '40min'
  return '60min'
}

interface ClientDashboardProps {
  profile: {
    id: string
    email: string | null
    full_name: string | null
    role: AppRole
    preferred_language?: SupportedLanguage | null
    service_type?: string | null
    service_types?: string[] | null
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
  findingProviderAt: string | null
}

type ClientPetRow = {
  id: string
  client_id: string
  name: string
  pet_type: string
  dog_size: DogSize | null
  is_active: boolean
  created_at: string
  updated_at: string
}

type DogSize = 'S' | 'M' | 'L'

type RepeatType = 'one_time' | 'weekly'
type RecurringStatus = 'active' | 'paused' | 'cancelled'
type ScheduleMode = 'later' | 'repeat'
type TimePickerTarget = 'repeat' | 'edit'
type Meridiem = 'AM' | 'PM'
type ProviderHeroMeta = {
  fullName: string | null
  avatarUrl: string | null
  rating: number | null
  completedCount: number
  serviceLabel: string | null
  experienceRange: string | null
  experienceYears: number | null
  languages: string[]
  specialties: string[]
  servicePreferences: string[]
  shortBio: string | null
  preferredCustomerCount: number
  repeatClientIndicator: boolean
  whatsappNumber: string | null
  whatsappNumberRaw: string | null
}

type ProviderProfileSheetState = {
  providerId: string
  fallbackName: string
  requestedServiceType: string | null
}

const DOG_SIZE_OPTIONS: DogSize[] = ['S', 'M', 'L']

function normalizeDogSize(value: unknown): DogSize | null {
  if (value === 'S' || value === 'M' || value === 'L') return value
  if (value === 'XL') return 'L'
  return null
}

function getDogSizeLabel(dogSize: DogSize | null | undefined, isHebrew: boolean): string | null {
  if (!dogSize) return null
  if (isHebrew) {
    if (dogSize === 'S') return 'קטן'
    if (dogSize === 'M') return 'בינוני'
    return 'גדול'
  }
  if (dogSize === 'S') return 'Small'
  if (dogSize === 'M') return 'Medium'
  return 'Large'
}

function formatDogDisplayLabel(
  name: string,
  dogSize: DogSize | null | undefined,
  options?: { includeEmoji?: boolean; isHebrew?: boolean },
): string {
  const normalizedName = normalizeDogName(name)
  if (!normalizedName) return ''
  const prefix = options?.includeEmoji ? '🐶 ' : ''
  const localizedSize = getDogSizeLabel(dogSize, options?.isHebrew ?? false)
  const sizeSuffix = localizedSize ? ` • ${localizedSize}` : ''
  return `${prefix}${normalizedName}${sizeSuffix}`
}

function truncateCodePoints(value: string | null | undefined, maxChars: number): string | null {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return null
  const chars = Array.from(trimmed)
  if (chars.length <= maxChars) return trimmed
  return `${chars.slice(0, maxChars).join('').trimEnd()}…`
}

interface RecurringBookingRow {
  id: string
  client_id: string
  provider_id: string | null
  service_type: string
  dog_name: string | null
  dog_count: number | null
  location: string
  address: string | null
  notes: string | null
  duration_minutes: number
  price_per_visit: number | string
  repeat_type: RepeatType
  repeat_days: number[] | null
  repeat_starts_on: string
  repeat_ends_on: string | null
  start_time: string
  recurring_status: RecurringStatus
  created_at: string
  updated_at: string
}

interface RecurringBookingItem {
  id: string
  serviceLabel: string
  title: string
  weekdaysLabel: string
  timeLabel: string
  durationLabel: string
  pricePerVisit: number | null
  nextOccurrenceLabel: string | null
  nextOccurrenceAt: Date | null
  status: RecurringStatus
  repeatDays: number[]
  startsOn: string
  startTime: string
}

const REPEAT_WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const

function normalizeTime24(value: string | null | undefined): string {
  const match = String(value ?? '').match(/^(\d{2}):(\d{2})/)
  if (!match) return '18:00'
  return `${match[1]}:${match[2]}`
}

function time24ToPickerParts(value: string | null | undefined): {
  hour12: string
  minute: string
  meridiem: Meridiem
} {
  const normalized = normalizeTime24(value)
  const [hourRaw, minuteRaw] = normalized.split(':')
  const hour24 = Number(hourRaw)
  const meridiem: Meridiem = hour24 >= 12 ? 'PM' : 'AM'
  const hour12Number = hour24 % 12 === 0 ? 12 : hour24 % 12
  return {
    hour12: String(hour12Number),
    minute: minuteRaw,
    meridiem,
  }
}

function pickerPartsToTime24(hour12: string, minute: string, meridiem: Meridiem): string {
  const normalizedHour = Math.min(12, Math.max(1, Number(hour12) || 12))
  const normalizedMinute = Math.min(59, Math.max(0, Number(minute) || 0))
  let hour24 = normalizedHour % 12
  if (meridiem === 'PM') hour24 += 12
  return `${pad(hour24)}:${pad(normalizedMinute)}`
}

function formatRecurringDisplayTime(value: string | null | undefined, language: string): string {
  const normalized = normalizeTime24(value)
  const [hourRaw, minuteRaw] = normalized.split(':')
  const date = new Date(2024, 0, 1, Number(hourRaw), Number(minuteRaw), 0, 0)
  return date.toLocaleTimeString(language === 'he' ? 'he-IL' : 'en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

function normalizePhoneForLink(value: string | null | undefined): string | null {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const normalized = raw.replace(/[^\d+]/g, '')
  if (!normalized) return null
  if (normalized.startsWith('+')) return normalized
  if (normalized.startsWith('00')) return `+${normalized.slice(2)}`
  return normalized
}

function normalizePhoneForWhatsApp(value: string | null | undefined): string | null {
  const normalized = normalizePhoneForLink(value)
  if (!normalized) return null
  return normalized.replace(/[^\d]/g, '')
}

function buildDateWheelOptions(
  minValue: string,
  language: string,
  t: (key: string) => string,
): WheelOption[] {
  const baseDate = parseLocalDateTime(minValue) ?? new Date()
  const start = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate())

  return Array.from({ length: 14 }, (_, index) => {
    const nextDate = new Date(start)
    nextDate.setDate(start.getDate() + index)
    const value = `${nextDate.getFullYear()}-${pad(nextDate.getMonth() + 1)}-${pad(nextDate.getDate())}`

    let label = nextDate.toLocaleDateString(language === 'he' ? 'he-IL' : 'en-US', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    })

    if (index === 0) {
      label = `${t('common.today')} · ${label}`
    } else if (index === 1) {
      label = `${t('common.tomorrow')} · ${label}`
    }

    return { value, label }
  })
}

function normalizeRepeatDays(days: number[] | null | undefined): number[] {
  return Array.from(
    new Set(
      (days ?? [])
        .filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6),
    ),
  ).sort((a, b) => REPEAT_WEEKDAY_ORDER.indexOf(a as (typeof REPEAT_WEEKDAY_ORDER)[number]) - REPEAT_WEEKDAY_ORDER.indexOf(b as (typeof REPEAT_WEEKDAY_ORDER)[number]))
}

function dateAndTimeToLocalDate(dateValue: string | null | undefined, timeValue: string | null | undefined): Date | null {
  if (!dateValue || !timeValue) return null
  const normalizedTime = timeValue.slice(0, 5)
  return parseLocalDateTime(`${dateValue}T${normalizedTime}`)
}

function formatRepeatDaysLabel(days: number[], language: string): string {
  const normalized = normalizeRepeatDays(days)
  if (normalized.length === 0) return ''
  return normalized
    .map((day) =>
      new Intl.DateTimeFormat(language === 'he' ? 'he-IL' : 'en-US', { weekday: 'short' }).format(
        new Date(Date.UTC(2024, 0, 7 + day)),
      ),
    )
    .join(' · ')
}

function getNextRecurringOccurrence(
  repeatDays: number[],
  startsOn: string,
  startTime: string,
  endsOn?: string | null,
): Date | null {
  const normalizedDays = normalizeRepeatDays(repeatDays)
  const startDate = dateAndTimeToLocalDate(startsOn, startTime)
  if (!startDate || normalizedDays.length === 0) return null
  const endDate = endsOn ? dateAndTimeToLocalDate(endsOn, startTime) : null
  const now = new Date()
  const searchStart = new Date(
    Math.max(
      now.getTime(),
      new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate(), 0, 0, 0, 0).getTime(),
    ),
  )

  for (let offset = 0; offset < 21; offset += 1) {
    const candidate = new Date(searchStart)
    candidate.setDate(searchStart.getDate() + offset)
    candidate.setHours(startDate.getHours(), startDate.getMinutes(), 0, 0)
    if (candidate < startDate) continue
    if (endDate && candidate > endDate) return null
    if (!normalizedDays.includes(candidate.getDay())) continue
    if (candidate < now) continue
    return candidate
  }

  return null
}

export default function ClientDashboard({
  profile,
  onSignOut,
  showOnboardingWowToken = 0,
}: ClientDashboardProps) {
  const getAppViewportHeight = useCallback(() => {
    if (typeof window === 'undefined') return 844
    return Math.round(window.visualViewport?.height ?? window.innerHeight)
  }, [])

  const { t, i18n } = useTranslation()
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
  }, [i18n, profile.id])

  const isRtl = i18n.resolvedLanguage === 'he'
  const clientName = profile.full_name || profile.email || t('common.client')
  const flow = useClientFlow(profile.id, clientName)
  const photo = useProfilePhoto(profile.id)
  const [burgerOpen, setBurgerOpen] = useState(false)
  const [menuPage, setMenuPage] = useState<MenuPage>('main')
  const [showSchedulePage, setShowSchedulePage] = useState(false)
  const [scheduleDraft, setScheduleDraft] = useState(getNowPlus15LocalInput())
  const [showDogNameSheet, setShowDogNameSheet] = useState(false)
  const [recentDogNames, setRecentDogNames] = useState<string[]>([])
  const [recentBabysitterNames, setRecentBabysitterNames] = useState<string[]>([])
  const [dogNameDraft, setDogNameDraft] = useState('')
  const [dogSizeDraft, setDogSizeDraft] = useState<DogSize | null>(null)
  const [recipientEditorOpen, setRecipientEditorOpen] = useState(false)
  const [dogNameSheetSaving, setDogNameSheetSaving] = useState(false)
  const [dogNameSheetError, setDogNameSheetError] = useState<string | null>(null)
  const [babysitterServiceDetails, setBabysitterServiceDetails] = useState('')
  const [fixedVisitIssueDescription, setFixedVisitIssueDescription] = useState('')
  const [babysitterDurationHours, setBabysitterDurationHours] = useState(
    String(BABYSITTER_DEFAULT_DURATION_HOURS),
  )
  const [babysitterBudgetFixed, setBabysitterBudgetFixed] = useState(
    String(BABYSITTER_DEFAULT_FIXED_BUDGET_ILS),
  )
  const [babysitterBudgetGuidanceFixed, setBabysitterBudgetGuidanceFixed] = useState(
    String(BABYSITTER_DEFAULT_FIXED_BUDGET_ILS),
  )
  const [dogWalkerDurationHours, setDogWalkerDurationHours] = useState(
    String(DOG_WALKER_DEFAULT_DURATION_HOURS),
  )
  const [dogWalkerBudgetFixed, setDogWalkerBudgetFixed] = useState(
    String(DOG_WALKER_DEFAULT_BUDGET_ILS),
  )
  const [dogWalkerBudgetGuidanceFixed, setDogWalkerBudgetGuidanceFixed] = useState(
    String(DOG_WALKER_DEFAULT_BUDGET_ILS),
  )
  const [clientPets, setClientPets] = useState<ClientPetRow[]>([])
  const [selectedDogPetIds, setSelectedDogPetIds] = useState<string[]>([])
  const [repeatType, setRepeatType] = useState<RepeatType>('one_time')
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>('later')
  const [repeatDays, setRepeatDays] = useState<number[]>([])
  const [repeatStartTime, setRepeatStartTime] = useState(() => splitScheduledDraft(getNowPlus15LocalInput()).time)
  const [recurringBookings, setRecurringBookings] = useState<RecurringBookingRow[]>([])
  const [recurringLoading, setRecurringLoading] = useState(false)
  const [, setRecurringSaving] = useState(false)
  const [recurringError, setRecurringError] = useState<string | null>(null)
  const [recurringSuccess, setRecurringSuccess] = useState<string | null>(null)
  const [editingRecurringBooking, setEditingRecurringBooking] = useState<RecurringBookingItem | null>(null)
  const [recurringEditDays, setRecurringEditDays] = useState<number[]>([])
  const [recurringEditTime, setRecurringEditTime] = useState('18:00')
  const [scheduleOverlapWarning, setScheduleOverlapWarning] = useState<string | null>(null)
  const scheduleOverlapWarningRef = useRef<string | null>(null)
  const bookingTimingRef = useRef(flow.bookingTiming)
  const [providerPricingPreferences, setProviderPricingPreferences] = useState<ProviderPricingPreferenceInput[]>([])
  const [budgetDraftHydrated, setBudgetDraftHydrated] = useState(false)
  const [locallyDismissedCompletionIds, setLocallyDismissedCompletionIds] = useState<Set<string>>(() => new Set())
  const [providerHeroMeta, setProviderHeroMeta] = useState<ProviderHeroMeta>({
    fullName: null,
    avatarUrl: null,
    rating: null,
    completedCount: 0,
    serviceLabel: null,
    experienceRange: null,
    experienceYears: null,
    languages: [],
    specialties: [],
    servicePreferences: [],
    shortBio: null,
    preferredCustomerCount: 0,
    repeatClientIndicator: false,
    whatsappNumber: null,
    whatsappNumberRaw: null,
  })
  const [providerProfileSheet, setProviderProfileSheet] = useState<ProviderProfileSheetState | null>(null)
  const [providerProfileLoading, setProviderProfileLoading] = useState(false)
  const [providerProfileError, setProviderProfileError] = useState<string | null>(null)
  const [providerProfileData, setProviderProfileData] = useState<ProviderHeroMeta | null>(null)
  const [timePickerTarget, setTimePickerTarget] = useState<TimePickerTarget | null>(null)
  const [timePickerHour12, setTimePickerHour12] = useState('6')
  const [timePickerMinute, setTimePickerMinute] = useState('00')
  const [timePickerMeridiem, setTimePickerMeridiem] = useState<Meridiem>('PM')
  const [showFirstBookingWow, setShowFirstBookingWow] = useState(false)
  const [resumeFirstBookingWowAfterCardSetup, setResumeFirstBookingWowAfterCardSetup] = useState(false)
  const [guidedBookingField, setGuidedBookingField] = useState<'dogName' | 'duration' | 'payment' | null>(null)
  const [shouldAnimateGuidedField, setShouldAnimateGuidedField] = useState(false)
  const [_matchingUiState, setMatchingUiState] = useState<'matching' | 'empty' | null>(null)
  const [selectedService, setSelectedService] = useState<ServiceType>('dog_walking')
  const [addressPickerOpen, setAddressPickerOpen] = useState(false)
  const [sheetSnap, setSheetSnap] = useState<SheetSnap>('default')
  const [paymentSheetOpen, setPaymentSheetOpen] = useState(false)
  const [paymentActionsCardId, setPaymentActionsCardId] = useState<string | null>(null)
  const [paymentDeleteConfirmCardId, setPaymentDeleteConfirmCardId] = useState<string | null>(null)
  const [paymentActionLoading, setPaymentActionLoading] = useState(false)
  const [settingsSectionsOpen, setSettingsSectionsOpen] = useState<Record<ClientSettingsSectionKey, boolean>>({
    language: false,
    preferredProviders: false,
    legal: false,
    account: false,
  })
  const [openLegalDocument, setOpenLegalDocument] = useState<LegalDocumentType | null>(null)
  const [deleteAccountOpen, setDeleteAccountOpen] = useState(false)
  const [deleteAccountLoading, setDeleteAccountLoading] = useState(false)
  const [deleteAccountError, setDeleteAccountError] = useState<string | null>(null)
  const [deleteAccountSuccess, setDeleteAccountSuccess] = useState(false)
  const [appViewportHeight, setAppViewportHeight] = useState(getAppViewportHeight)
  const appViewportHeightRef = useRef(appViewportHeight)
  const providerPricingPreferencesCacheRef = useRef<Map<string, ProviderPricingPreferenceInput[]>>(new Map())
  const providerPricingPreferencesInFlightRef = useRef<Map<string, Promise<ProviderPricingPreferenceInput[]>>>(new Map())
  const activeProviderPricingQueryKeyRef = useRef<string | null>(null)
  const providerPricingPreferencesSnapshotRef = useRef<string>('[]')
  const clientSettingsPhotoInputRef = useRef<HTMLInputElement | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const lastOnboardingWowTokenRef = useRef(0)
  const suppressDogNameOpenUntilRef = useRef(0)
  const lastCurrentJobIdRef = useRef<string | null>(null)
  const hasUserInteractedRef = useRef(false)
  const arrivalBeepPlayedJobIdRef = useRef<string | null>(null)
  const selectedBookingServiceRef = useRef<ServiceType>('dog_walking')
  const requestServiceTypeRef = useRef<string | null>(null)
  const [mapMounted, setMapMounted] = useState(false)
  const [isDraggingSheet, setIsDraggingSheet] = useState(false)
  const sheetDragRef = useRef<{ startY: number; startSnap: SheetSnap; lastDelta: number } | null>(null)
  const sheetRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!paymentSheetOpen) return
    console.log('[ApplePay] payment sheet visibility decision', {
      showApplePay: flow.showApplePayInPaymentSheet,
      platform: Capacitor.getPlatform(),
      native: Capacitor.isNativePlatform(),
      nativePaymentSheet: flow.nativePaymentSheet,
    })
  }, [flow.nativePaymentSheet, flow.showApplePayInPaymentSheet, paymentSheetOpen])

  const debugFlags = useRef(() => {
    if (typeof window === 'undefined') return { interactionDebug: false, delayMap: false }
    const params = new URLSearchParams(window.location.search)
    return {
      interactionDebug: import.meta.env.DEV && params.get('interactionDebug') === '1',
      delayMap: import.meta.env.DEV && params.get('delayMap') === '1',
    }
  }).current
  const toggleSettingsSection = useCallback((key: ClientSettingsSectionKey) => {
    setSettingsSectionsOpen((prev) => ({ ...prev, [key]: !prev[key] }))
  }, [])
  const paymentActionCard = useMemo(
    () => flow.savedCards.find((card) => card.id === paymentActionsCardId) ?? null,
    [flow.savedCards, paymentActionsCardId],
  )
  const paymentDeleteConfirmCard = useMemo(
    () => flow.savedCards.find((card) => card.id === paymentDeleteConfirmCardId) ?? null,
    [flow.savedCards, paymentDeleteConfirmCardId],
  )
  const availableBookingServices = useMemo(
    () => [...launchEnabledBookingServices] as ServiceType[],
    [],
  )
  const shouldShowProfileServicePicker = availableBookingServices.length > 1
  const resolvedBookingService = availableBookingServices.includes(selectedService)
    ? selectedService
    : availableBookingServices[0] ?? selectedService
  const resolvedBookingPricingModel = getBookingPricingModelForService(resolvedBookingService)
  const requestServiceType = mapBookingServiceTypeToRequestServiceType(resolvedBookingService)
  const effectiveRequestServiceType =
    requestServiceTypeRef.current ?? requestServiceType
  const isBabysitterRequest = effectiveRequestServiceType === 'baby_sitter'
  const isDogWalkerRequest = effectiveRequestServiceType === 'dog_walker'
  const isFixedVisitMode = resolvedBookingPricingModel === 'fixed_visit'
  const activeDogPets = useMemo(
    () =>
      clientPets
        .filter((pet) => pet.is_active && pet.pet_type === 'dog')
        .map((pet) => ({
          ...pet,
          dog_size: normalizeDogSize(pet.dog_size),
          normalizedName: normalizeDogName(pet.name),
        }))
        .filter((pet) => !!pet.normalizedName),
    [clientPets],
  )
  const selectedDogPets = useMemo(
    () => activeDogPets.filter((pet) => selectedDogPetIds.includes(pet.id)),
    [activeDogPets, selectedDogPetIds],
  )
  const selectedDogNames = useMemo(
    () => selectedDogPets.map((pet) => pet.normalizedName),
    [selectedDogPets],
  )
  const selectedKnownDogSizes = useMemo(
    () =>
      selectedDogPets
        .map((pet) => normalizeDogSize(pet.dog_size))
        .filter((size): size is DogSize => size !== null),
    [selectedDogPets],
  )
  const bookingTypeForGuidance: 'asap' | 'scheduled' = flow.bookingTiming === 'scheduled' ? 'scheduled' : 'asap'
  const shouldShowDogCountControl = isDogWalkerRequest && activeDogPets.length >= 2
  const normalizedDogCount = shouldShowDogCountControl
    ? normalizeDogCount(Math.max(1, selectedDogPets.length))
    : 1
  const selectedDogNamesLabel = selectedDogNames.join(', ')
  const effectiveDogBookingName = selectedDogNamesLabel || flow.dogName.trim()
  const selectedSingleDogSize = useMemo(
    () =>
      normalizeDogSize(
        (selectedDogPets.length === 1
          ? selectedDogPets[0]?.dog_size
          : activeDogPets.length === 1
            ? activeDogPets[0]?.dog_size
            : null),
      ),
    [activeDogPets, selectedDogPets],
  )
  const bookingSubjectDisplayValue = isBabysitterRequest
    ? babysitterServiceDetails.trim()
    : selectedDogPets.length > 0
      ? selectedDogPets
          .map((pet) =>
            formatDogDisplayLabel(pet.normalizedName, pet.dog_size, { isHebrew: isRtl }),
          )
          .filter(Boolean)
          .join(', ')
      : formatDogDisplayLabel(flow.dogName.trim(), selectedSingleDogSize, { isHebrew: isRtl })
  const compactBookingSubjectDisplayValue = isBabysitterRequest
    ? bookingSubjectDisplayValue
    : selectedDogPets.length > 1
      ? `${formatDogDisplayLabel(selectedDogPets[0]?.normalizedName ?? '', selectedDogPets[0]?.dog_size, { isHebrew: isRtl })} +${selectedDogPets.length - 1}`
      : bookingSubjectDisplayValue
  const selectedDogNamesNote = selectedDogNames.length > 0
    ? `${isRtl ? 'כלבים' : 'Dogs'}: ${selectedDogNames.join(', ')}`
    : null
  useEffect(() => {
    selectedBookingServiceRef.current = resolvedBookingService
    requestServiceTypeRef.current = requestServiceType
  }, [requestServiceType, resolvedBookingService])

  useEffect(() => {
    if (availableBookingServices.length === 0) return
    if (!availableBookingServices.includes(selectedService)) {
      setSelectedService(availableBookingServices[0])
    }
  }, [availableBookingServices, selectedService])

  useEffect(() => {
    if (!paymentSheetOpen) {
      setPaymentActionsCardId(null)
      setPaymentDeleteConfirmCardId(null)
      setPaymentActionLoading(false)
    }
  }, [paymentSheetOpen])

  const closePaymentActionMenus = useCallback(() => {
    setPaymentActionsCardId(null)
    setPaymentDeleteConfirmCardId(null)
    setPaymentActionLoading(false)
  }, [])

  const handleDeletePaymentMethod = useCallback(async () => {
    if (!paymentDeleteConfirmCard) return
    setPaymentActionLoading(true)
    const { error } = await detachPaymentMethod(paymentDeleteConfirmCard.id)
    setPaymentActionLoading(false)

    if (error) {
      flow.clearError()
      console.warn('[ClientDashboard] failed to detach payment method:', error)
      closePaymentActionMenus()
      return
    }

    closePaymentActionMenus()
    flow.retryLoadCard?.()
  }, [closePaymentActionMenus, flow, paymentDeleteConfirmCard])

  const handleSelectBookingService = useCallback((nextService: ServiceType) => {
    const normalizedNextService = availableBookingServices.includes(nextService)
      ? nextService
      : availableBookingServices[0] ?? nextService

    selectedBookingServiceRef.current = normalizedNextService
    requestServiceTypeRef.current = mapBookingServiceTypeToRequestServiceType(normalizedNextService)

    setMatchingUiState(null)
    flow.clearAvailabilityNotice()
    flow.clearError()
    setSelectedService(normalizedNextService)
  }, [
    availableBookingServices,
    flow,
  ])

  const loadClientPets = useCallback(async () => {
    const { data, error } = await supabase
      .from('client_pets')
      .select('id, client_id, name, pet_type, dog_size, is_active, created_at, updated_at')
      .eq('client_id', profile.id)
      .eq('is_active', true)
      .order('created_at', { ascending: true })

    if (error) {
      console.warn('[ClientDashboard] failed to load client pets:', error.message)
      setClientPets([])
      return
    }

    setClientPets(((data as ClientPetRow[] | null) ?? []).filter((pet) => pet.pet_type === 'dog'))
  }, [profile.id])

  useEffect(() => {
    void loadClientPets()
  }, [loadClientPets])

  useEffect(() => {
    if (!debugFlags().interactionDebug) return
    const t0 = performance.now()
    console.log(`[perf] ClientDashboard mounted at ${Math.round(t0)}ms`)

    if (typeof PerformanceObserver === 'undefined') return
    let observer: PerformanceObserver | null = null
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration < 50) continue
          const since = Math.round(performance.now() - t0)
          if (since > 8000) { observer?.disconnect(); return }
          console.warn(
            `[perf] longtask ${Math.round(entry.duration)}ms at +${since}ms (start ${Math.round(entry.startTime)}ms)`,
          )
        }
      })
      observer.observe({ entryTypes: ['longtask'] })
    } catch { /* unsupported */ }
    return () => observer?.disconnect()
  }, [])

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
        height: var(--regli-client-app-height, 100vh);
        min-height: var(--regli-client-app-height, 100vh);
        max-height: var(--regli-client-app-height, 100vh);
      }

      @supports (height: 100dvh) {
        .regli-client-screen {
          height: 100dvh;
          min-height: 100dvh;
          max-height: 100dvh;
        }

        .regli-client-dashboard-sheet {
          max-height: calc(100dvh - 92px) !important;
        }
      }

      @supports not (height: 100dvh) {
        .regli-client-dashboard-sheet {
          max-height: calc(var(--regli-client-app-height, 100vh) - 92px) !important;
        }
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

      @keyframes regliMenuSlideInLeft {
        0% { opacity: 0; transform: translateX(-28px); }
        100% { opacity: 1; transform: translateX(0); }
      }

      @keyframes regliMenuSlideInRight {
        0% { opacity: 0; transform: translateX(28px); }
        100% { opacity: 1; transform: translateX(0); }
      }

      @keyframes regliScheduleSheetRise {
        0% { opacity: 0; transform: translateY(24px) scale(0.985); }
        100% { opacity: 1; transform: translateY(0) scale(1); }
      }

      @keyframes regliMenuFadeIn {
        0% { opacity: 0; }
        100% { opacity: 1; }
      }

      @keyframes regliBottomSheetEnter {
        0% { opacity: 0; transform: translateY(28px); }
        100% { opacity: 1; transform: translateY(0); }
      }
    `
    document.head.appendChild(style)

    const previousBodyOverflowX = document.body.style.overflowX
    const previousDocumentOverflowX = document.documentElement.style.overflowX
    const previousAppHeightVar = document.documentElement.style.getPropertyValue('--regli-client-app-height')
    document.body.style.overflowX = 'hidden'
    document.documentElement.style.overflowX = 'hidden'
    document.documentElement.style.setProperty('--regli-client-app-height', `${appViewportHeightRef.current}px`)

    return () => {
      document.head.removeChild(style)
      document.body.style.overflowX = previousBodyOverflowX
      document.documentElement.style.overflowX = previousDocumentOverflowX
      if (previousAppHeightVar) {
        document.documentElement.style.setProperty('--regli-client-app-height', previousAppHeightVar)
      } else {
        document.documentElement.style.removeProperty('--regli-client-app-height')
      }
    }
  }, [])

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [flow.screenState, flow.bookingTiming])

  const hasOverlayOpen = addressPickerOpen || paymentSheetOpen
  const hadOverlayRef = useRef(false)

  useEffect(() => {
    const syncAppViewportHeight = (nextHeight: number, force = false) => {
      if (!Number.isFinite(nextHeight) || nextHeight <= 0) return
      if (!force && nextHeight < appViewportHeightRef.current) return
      appViewportHeightRef.current = nextHeight
      setAppViewportHeight((prev) => (prev === nextHeight ? prev : nextHeight))
      document.documentElement.style.setProperty('--regli-client-app-height', `${nextHeight}px`)
    }

    const updateViewportHeight = () => {
      if (hasOverlayOpen) return
      syncAppViewportHeight(getAppViewportHeight())
    }

    updateViewportHeight()
    const visualViewport = window.visualViewport
    window.addEventListener('resize', updateViewportHeight)
    visualViewport?.addEventListener('resize', updateViewportHeight)

    let orientationRaf1 = 0
    let orientationRaf2 = 0
    let orientationTimeout = 0
    const handleOrientationChange = () => {
      const commitOrientationHeight = () => {
        syncAppViewportHeight(getAppViewportHeight(), true)
        window.scrollTo(0, 0)
      }

      cancelAnimationFrame(orientationRaf1)
      cancelAnimationFrame(orientationRaf2)
      clearTimeout(orientationTimeout)

      orientationRaf1 = requestAnimationFrame(() => {
        orientationRaf2 = requestAnimationFrame(commitOrientationHeight)
      })
      orientationTimeout = window.setTimeout(commitOrientationHeight, 240)
    }

    window.addEventListener('orientationchange', handleOrientationChange)
    return () => {
      window.removeEventListener('resize', updateViewportHeight)
      visualViewport?.removeEventListener('resize', updateViewportHeight)
      window.removeEventListener('orientationchange', handleOrientationChange)
      cancelAnimationFrame(orientationRaf1)
      cancelAnimationFrame(orientationRaf2)
      clearTimeout(orientationTimeout)
    }
  }, [getAppViewportHeight, hasOverlayOpen])

  useEffect(() => {
    if (!hadOverlayRef.current || hasOverlayOpen) {
      hadOverlayRef.current = hasOverlayOpen
      return
    }

    const restoreScrollPosition = () => {
      window.scrollTo(0, 0)
    }

    restoreScrollPosition()
    const restoredHeight = getAppViewportHeight()
    if (Number.isFinite(restoredHeight) && restoredHeight > 0) {
      appViewportHeightRef.current = restoredHeight
      setAppViewportHeight(restoredHeight)
    }
    const raf = requestAnimationFrame(restoreScrollPosition)
    const timeout = window.setTimeout(restoreScrollPosition, 120)
    hadOverlayRef.current = hasOverlayOpen

    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(timeout)
    }
  }, [hasOverlayOpen])

  useEffect(() => {
    if (scrollRef.current && flow.completionJob) scrollRef.current.scrollTop = 0
  }, [flow.completionJob?.jobId])

  useEffect(() => {
    const markInteracted = () => {
      if (!hasUserInteractedRef.current) {
        markFirstInteractionHandler('client-dashboard:first-interaction')
      }
      hasUserInteractedRef.current = true
    }

    window.addEventListener('pointerdown', markInteracted, { capture: true, passive: true })
    window.addEventListener('keydown', markInteracted, { capture: true })

    return () => {
      window.removeEventListener('pointerdown', markInteracted, { capture: true } as EventListenerOptions)
      window.removeEventListener('keydown', markInteracted, { capture: true } as EventListenerOptions)
    }
  }, [])

  useEffect(() => {
    if (mapMounted) return
    if (debugFlags().delayMap) {
      const timeout = window.setTimeout(() => {
        console.log('[perf] delayMap: mounting MapView now (8s delay)')
        setMapMounted(true)
      }, 8000)
      return () => clearTimeout(timeout)
    }

    const mount = () => {
      if (debugFlags().interactionDebug) {
        console.log(`[perf] mounting MapView at ${Math.round(performance.now())}ms`)
      }
      setMapMounted(true)
    }

    const win = window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void }
    if (win.requestIdleCallback) {
      const idleId = win.requestIdleCallback(mount, { timeout: 2500 })
      return () => win.cancelIdleCallback?.(idleId)
    }

    const timeout = window.setTimeout(mount, 1400)
    return () => clearTimeout(timeout)
  }, [mapMounted])

  useEffect(() => {
    setRecentDogNames(readRecentBookingSubjects(profile.id, 'dog_walker'))
    setRecentBabysitterNames(readRecentBookingSubjects(profile.id, 'baby_sitter'))
  }, [profile.id])

  useEffect(() => {
    if (requestServiceType === 'dog_walker') {
      setRecentDogNames(readRecentBookingSubjects(profile.id, 'dog_walker'))
      return
    }
    if (requestServiceType === 'baby_sitter') {
      setRecentBabysitterNames(readRecentBookingSubjects(profile.id, 'baby_sitter'))
    }
  }, [profile.id, requestServiceType])

  useEffect(() => {
    if (requestServiceType !== 'baby_sitter') return
    if (babysitterServiceDetails.trim()) return
    try {
      const raw = window.localStorage.getItem(
        bookingSubjectSelectedStorageKey(profile.id, requestServiceType),
      )
      const nextValue = normalizeDogName(String(raw ?? ''))
      if (nextValue) {
        setBabysitterServiceDetails(nextValue)
      }
    } catch {
      // noop
    }
  }, [babysitterServiceDetails, profile.id, requestServiceType])

  useEffect(() => {
    setBudgetDraftHydrated(false)
    const storedDraft = readClientBookingBudgetDraft(profile.id)
    const nextBabysitterBudget = storedDraft?.babysitterBudgetFixed
    const nextDogWalkerBudget = storedDraft?.dogWalkerBudgetFixed

    console.debug('[ClientDashboard] budget hydration', {
      profileId: profile.id,
      storedDraft,
      nextBabysitterBudget,
      nextDogWalkerBudget,
    })

    if (typeof nextBabysitterBudget === 'string' && nextBabysitterBudget.trim()) {
      setBabysitterBudgetFixed(nextBabysitterBudget)
      setBabysitterBudgetGuidanceFixed(nextBabysitterBudget)
    }
    if (typeof nextDogWalkerBudget === 'string' && nextDogWalkerBudget.trim()) {
      setDogWalkerBudgetFixed(nextDogWalkerBudget)
      setDogWalkerBudgetGuidanceFixed(nextDogWalkerBudget)
    }

    setBudgetDraftHydrated(true)
  }, [profile.id])

  useEffect(() => {
    if (!budgetDraftHydrated) return
    const timeoutId = window.setTimeout(() => {
      console.debug('[ClientDashboard] budget draft persist', {
        profileId: profile.id,
        babysitterBudgetFixed,
        dogWalkerBudgetFixed,
      })
      mergeClientBookingBudgetDraft(profile.id, {
        babysitterBudgetFixed,
        dogWalkerBudgetFixed,
      })
    }, 220)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [babysitterBudgetFixed, budgetDraftHydrated, dogWalkerBudgetFixed, profile.id])

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setBabysitterBudgetGuidanceFixed(babysitterBudgetFixed)
      setDogWalkerBudgetGuidanceFixed(dogWalkerBudgetFixed)
    }, 140)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [babysitterBudgetFixed, dogWalkerBudgetFixed])

  useEffect(() => {
    if (!showDogNameSheet) return
  }, [flow.dogName, showDogNameSheet])

  useEffect(() => {
    scheduleOverlapWarningRef.current = scheduleOverlapWarning
  }, [scheduleOverlapWarning])

  useEffect(() => {
    bookingTimingRef.current = flow.bookingTiming
  }, [flow.bookingTiming])

  const clearScheduleConflictWarning = useCallback((reason: string) => {
    if (scheduleOverlapWarningRef.current === null) return
    scheduleOverlapWarningRef.current = null
    setScheduleOverlapWarning(null)
    console.log('[schedule-sheet] conflict warning cleared', {
      reason,
      selectedScheduledFor: scheduleDraft,
      bookingTiming: flow.bookingTiming,
      activeTab: scheduleMode,
      timestamp: Date.now(),
    })
  }, [flow.bookingTiming, scheduleDraft, scheduleMode])

  useEffect(() => {
    if (!showSchedulePage) return
    const sourceScheduledFor = flow.bookingTiming === 'scheduled' ? flow.scheduledFor : null
    const nextDraft = clampScheduledDraft(sourceScheduledFor, getNowPlus15LocalInput())
    setScheduleDraft((current) => (current === nextDraft ? current : nextDraft))
    const nextRepeatTime = splitScheduledDraft(nextDraft).time
    setRepeatStartTime((current) => (current === nextRepeatTime ? current : nextRepeatTime))
    console.log('[schedule-sheet] open', {
      selectedScheduledFor: nextDraft,
      bookingTiming: flow.bookingTiming,
      activeTab: scheduleMode,
      timestamp: Date.now(),
    })
  }, [flow.bookingTiming, flow.scheduledFor, scheduleMode, showSchedulePage])

  const playArrivalBeep = useCallback(() => {
    if (!hasUserInteractedRef.current || typeof window === 'undefined') return

    try {
      const AudioContextCtor =
        window.AudioContext ||
        (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext

      if (!AudioContextCtor) return

      const audioContext = new AudioContextCtor()
      const oscillator = audioContext.createOscillator()
      const gainNode = audioContext.createGain()

      oscillator.type = 'sine'
      oscillator.frequency.value = 988
      gainNode.gain.setValueAtTime(0.0001, audioContext.currentTime)
      gainNode.gain.exponentialRampToValueAtTime(0.08, audioContext.currentTime + 0.01)
      gainNode.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.18)

      oscillator.connect(gainNode)
      gainNode.connect(audioContext.destination)

      oscillator.start()
      oscillator.stop(audioContext.currentTime + 0.2)
      oscillator.onended = () => {
        void audioContext.close().catch(() => undefined)
      }
    } catch {
      // fail silently on unsupported or blocked audio
    }
  }, [])

  useEffect(() => {
    const currentArrivalJobId =
      flow.screenPhase === 'arrived_pending_confirmation'
        ? flow.activeJob?.id ?? flow.currentJob?.id ?? null
        : null

    if (!currentArrivalJobId) return
    if (arrivalBeepPlayedJobIdRef.current === currentArrivalJobId) return

    arrivalBeepPlayedJobIdRef.current = currentArrivalJobId
    playArrivalBeep()
  }, [flow.activeJob?.id, flow.currentJob?.id, flow.screenPhase, playArrivalBeep])

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

  const handleDeleteAccount = useCallback(async () => {
    if (deleteAccountLoading) return
    setDeleteAccountError(null)
    setDeleteAccountLoading(true)

    const result = await requestAccountDeletion()
    if (!result.ok) {
      setDeleteAccountLoading(false)
      setDeleteAccountError(result.error)
      return
    }

    setDeleteAccountSuccess(true)
    window.setTimeout(() => {
      void handleSignOut()
    }, 900)
  }, [deleteAccountLoading, handleSignOut])

  const babysitterDurationValue = clampNumber(
    parseNumberOrFallback(babysitterDurationHours, BABYSITTER_DEFAULT_DURATION_HOURS),
    BABYSITTER_DURATION_MIN,
    BABYSITTER_DURATION_MAX,
  )
  const babysitterFixedBudgetValue = clampNumber(
    parseNumberOrFallback(babysitterBudgetFixed, BABYSITTER_DEFAULT_FIXED_BUDGET_ILS),
    BABYSITTER_BUDGET_MIN_ILS,
    BABYSITTER_BUDGET_MAX_ILS,
  )
  const babysitterGuidanceBudgetValue = clampNumber(
    parseNumberOrFallback(babysitterBudgetGuidanceFixed, BABYSITTER_DEFAULT_FIXED_BUDGET_ILS),
    BABYSITTER_BUDGET_MIN_ILS,
    BABYSITTER_BUDGET_MAX_ILS,
  )
  const babysitterDurationMinutes =
    Number.isFinite(babysitterDurationValue) && babysitterDurationValue > 0
      ? Math.round(babysitterDurationValue * 60)
      : null
  const dogWalkerDurationValue = clampNumber(
    parseNumberOrFallback(dogWalkerDurationHours, DOG_WALKER_DEFAULT_DURATION_HOURS),
    DOG_WALKER_DURATION_MIN,
    DOG_WALKER_DURATION_MAX,
  )
  const dogWalkerBudgetValue = clampNumber(
    parseNumberOrFallback(dogWalkerBudgetFixed, DOG_WALKER_DEFAULT_BUDGET_ILS),
    DOG_WALKER_BUDGET_MIN_ILS,
    DOG_WALKER_BUDGET_MAX_ILS,
  )
  const dogWalkerGuidanceBudgetValue = clampNumber(
    parseNumberOrFallback(dogWalkerBudgetGuidanceFixed, DOG_WALKER_DEFAULT_BUDGET_ILS),
    DOG_WALKER_BUDGET_MIN_ILS,
    DOG_WALKER_BUDGET_MAX_ILS,
  )
  const dogWalkerDurationMinutes =
    Number.isFinite(dogWalkerDurationValue) && dogWalkerDurationValue > 0
      ? Math.round(dogWalkerDurationValue * 60)
      : null
  const handleBabysitterDurationStep = (direction: 'down' | 'up') => {
    const delta = direction === 'up' ? BABYSITTER_DURATION_STEP : -BABYSITTER_DURATION_STEP
    const nextValue = clampNumber(
      Math.round((babysitterDurationValue + delta) * 2) / 2,
      BABYSITTER_DURATION_MIN,
      BABYSITTER_DURATION_MAX,
    )
    setBabysitterDurationHours(formatHoursValue(nextValue))
  }
  const handleBabysitterFixedBudgetChange = (nextValue: number) => {
    setBabysitterBudgetFixed(String(clampNumber(nextValue, BABYSITTER_BUDGET_MIN_ILS, BABYSITTER_BUDGET_MAX_ILS)))
  }

  function openRecurringTimePicker(initialTime: string, target: TimePickerTarget) {
    const parts = time24ToPickerParts(initialTime)
    setTimePickerHour12(parts.hour12)
    setTimePickerMinute(parts.minute)
    setTimePickerMeridiem(parts.meridiem)
    setTimePickerTarget(target)
  }

  function handleRecurringTimePickerDone() {
    const nextTime = pickerPartsToTime24(timePickerHour12, timePickerMinute, timePickerMeridiem)
    if (timePickerTarget === 'repeat') {
      setRepeatStartTime(nextTime)
      updateScheduledDraftFromWheel(
        repeatScheduleParts.date,
        nextTime.slice(0, 2),
        nextTime.slice(3, 5),
      )
    } else if (timePickerTarget === 'edit') {
      setRecurringEditTime(nextTime)
    }
    setTimePickerTarget(null)
  }

  function toggleRepeatDay(day: number) {
    setRepeatDays((current) => {
      const normalized = normalizeRepeatDays(current)
      return normalized.includes(day)
        ? normalizeRepeatDays(normalized.filter((value) => value !== day))
        : normalizeRepeatDays([...normalized, day])
    })
  }

  async function handleRecurringStatusUpdate(id: string, status: RecurringStatus) {
    setRecurringSaving(true)
    setRecurringError(null)
    const { error } = await supabase
      .from('recurring_bookings')
      .update({ recurring_status: status })
      .eq('id', id)
      .eq('client_id', profile.id)

    if (error) {
      setRecurringSaving(false)
      setRecurringError(error.message)
      return
    }

    await loadRecurringBookings()
    setRecurringSaving(false)
    setRecurringSuccess(
      status === 'paused'
        ? t('recurring.pausedSeries')
        : status === 'active'
          ? t('recurring.resumedSeries')
          : t('recurring.cancelledSeries'),
    )
    if (editingRecurringBooking?.id === id && status === 'cancelled') {
      setEditingRecurringBooking(null)
    }
  }

  async function handleSaveRecurringEdit() {
    if (!editingRecurringBooking) return
    const nextDays = normalizeRepeatDays(recurringEditDays)
    if (nextDays.length === 0) {
      setRecurringError(t('recurring.selectAtLeastOneDay'))
      return
    }

    setRecurringSaving(true)
    setRecurringError(null)
    const { error } = await supabase
      .from('recurring_bookings')
      .update({ repeat_days: nextDays, start_time: recurringEditTime })
      .eq('id', editingRecurringBooking.id)
      .eq('client_id', profile.id)

    if (error) {
      setRecurringSaving(false)
      setRecurringError(error.message)
      return
    }

    await loadRecurringBookings()
    setRecurringSaving(false)
    setRecurringSuccess(t('recurring.updatedSeries'))
    setEditingRecurringBooking(null)
  }

  async function handleCreateRecurringBooking() {
    if (!canSubmitRecurringBooking) return

    const effectiveBookingService = availableBookingServices.includes(selectedBookingServiceRef.current)
      ? selectedBookingServiceRef.current
      : resolvedBookingService
    const effectiveBookingPricingModel = getBookingPricingModelForService(effectiveBookingService)
    const effectiveServiceType =
      mapBookingServiceTypeToRequestServiceType(effectiveBookingService) ??
      requestServiceTypeRef.current ??
      requestServiceType

    if (!effectiveServiceType) {
      setRecurringError(t('recurring.missingServiceType'))
      return
    }

    const durationMinutes = isBabysitterRequest
      ? babysitterDurationMinutes
      : isDogWalkerRequest
        ? dogWalkerDurationMinutes
        : effectiveBookingPricingModel === 'fixed_visit'
          ? null
        : flow.duration ? Math.round((flow.duration === '20min' ? 20 : flow.duration === '40min' ? 40 : 60)) : null

    if (effectiveBookingPricingModel !== 'fixed_visit' && !durationMinutes) {
      setRecurringError(t('recurring.missingDuration'))
      return
    }

    const nextDogCount = normalizedDogCount
    const notes = [flow.currentJob?.notes ?? null, selectedDogNamesNote].filter(Boolean).join('\n') || null
    const dogNameValue = bookingSubjectValue
    const recurringStartDraft = clampScheduledDraft(
      mergeScheduledDraft(repeatScheduleParts.date, repeatStartTime),
      scheduleMinValue,
    )
    const recurringStartParts = splitScheduledDraft(recurringStartDraft)

    setRecurringSaving(true)
    setRecurringError(null)
    setRecurringSuccess(null)

    const payload = {
      client_id: profile.id,
      provider_id: null,
      service_type: effectiveServiceType,
      dog_name: dogNameValue || null,
      dog_count: nextDogCount,
      location: flow.location.trim(),
      address: flow.location.trim(),
      notes,
      duration_minutes: durationMinutes,
      price_per_visit: currentBookingPriceILS,
      repeat_type: 'weekly' as const,
      repeat_days: effectiveRepeatDays,
      repeat_starts_on: recurringStartParts.date,
      repeat_ends_on: null,
      start_time: repeatStartTime,
      recurring_status: 'active' as const,
    }

    const { error } = await supabase.from('recurring_bookings').insert(payload)
    if (error) {
      setRecurringSaving(false)
      setRecurringError(error.message)
      return
    }

    await loadRecurringBookings()
    setRecurringSaving(false)
    setRecurringSuccess(t('recurring.createdSeries'))
    setRepeatDays([])
    setRepeatType('one_time')
    closeScheduleSheet()
    setMenuPage('futureOrders')
    setBurgerOpen(true)
  }

  const handleFindWalker = useCallback(() => {
    const effectiveBookingService = availableBookingServices.includes(selectedBookingServiceRef.current)
      ? selectedBookingServiceRef.current
      : resolvedBookingService
    const effectiveBookingPricingModel = getBookingPricingModelForService(effectiveBookingService)
    const effectiveServiceType =
      mapBookingServiceTypeToRequestServiceType(effectiveBookingService) ??
      requestServiceTypeRef.current ??
      requestServiceType
    const babysitterBudgetValue = babysitterFixedBudgetValue > 0 ? babysitterFixedBudgetValue : null
    const effectiveDogCount = normalizedDogCount
    const dogWalkerBudgetRequestValue =
      dogWalkerBudgetValue > 0
        ? applyDogCountPricing(dogWalkerBudgetValue, {
            serviceType: effectiveServiceType,
            dogCount: effectiveDogCount,
          })
        : null

    if (effectiveServiceType === 'baby_sitter') {
      if (
        !babysitterServiceDetails.trim() ||
        !flow.location.trim() ||
        !flow.savedCard ||
        !babysitterDurationMinutes ||
        !babysitterBudgetValue
      ) {
        return
      }
    } else if (effectiveServiceType === 'dog_walker') {
      if (
        !flow.dogName.trim() ||
        !flow.location.trim() ||
        !flow.savedCard ||
        !dogWalkerDurationMinutes ||
        !dogWalkerBudgetRequestValue
      ) {
        return
      }
    } else if (effectiveBookingPricingModel === 'fixed_visit') {
      if (!flow.location.trim() || !flow.savedCard || !(dogWalkerBudgetValue > 0)) {
        return
      }
    } else if (!flow.dogName.trim() || !flow.location.trim() || !flow.duration || !flow.savedCard) {
      return
    }
    if (import.meta.env.DEV) {
      const localBookingBlockedReasons: string[] = []
      if (!effectiveServiceType) localBookingBlockedReasons.push('missing_request_service_type')
      if (!(effectiveServiceType === 'baby_sitter' ? babysitterServiceDetails.trim() : flow.dogName.trim())) {
        if (effectiveBookingPricingModel !== 'fixed_visit') {
          localBookingBlockedReasons.push('missing_service_name')
        }
      }
      if (!flow.location.trim()) localBookingBlockedReasons.push('missing_location')
      if (
        !(
          effectiveServiceType === 'baby_sitter'
            ? babysitterDurationMinutes
            : effectiveServiceType === 'dog_walker'
              ? dogWalkerDurationMinutes
              : effectiveBookingPricingModel === 'fixed_visit'
                ? true
              : flow.duration
        )
      ) {
        localBookingBlockedReasons.push('missing_duration')
      }
      if (
        !(
          effectiveServiceType === 'baby_sitter'
            ? babysitterFixedBudgetValue > 0
            : effectiveServiceType === 'dog_walker'
              ? dogWalkerBudgetValue > 0
              : effectiveBookingPricingModel === 'fixed_visit'
                ? dogWalkerBudgetValue > 0
              : flow.adjustedPriceILS > 0
        )
      ) {
        localBookingBlockedReasons.push('missing_price')
      }
      if (!flow.savedCard) localBookingBlockedReasons.push('missing_saved_card')
      if (flow.bookingTiming === 'scheduled' && !flow.scheduledFor) {
        localBookingBlockedReasons.push('missing_scheduled_for')
      }
      const pricingPackage = durationTypeFromMinutes(
        effectiveServiceType === 'baby_sitter'
          ? (babysitterDurationMinutes ?? 0)
          : effectiveServiceType === 'dog_walker'
            ? (dogWalkerDurationMinutes ?? 0)
            : effectiveBookingPricingModel === 'fixed_visit'
              ? 60
            : flow.duration === '20min'
              ? 20
              : flow.duration === '40min'
                ? 40
                : 60,
      )
      console.log('[ClientDashboard] submit booking', {
        selectedBookingService: effectiveBookingService,
        profileServiceTypes: profile.service_types ?? null,
        legacyProfileServiceType: profile.service_type ?? null,
        pricingPackage,
        requestServiceType: effectiveServiceType,
        canSubmitBooking: localBookingBlockedReasons.length === 0,
        bookingBlockedReasons: localBookingBlockedReasons,
      })
    }
    markFirstInteractionHandler('client-dashboard:find-walker')
    flow.clearAvailabilityNotice()
    flow.clearError()
    setMatchingUiState(null)
    markFirstInteractionVisual('client-dashboard:find-walker')
    if (effectiveServiceType === 'baby_sitter') {
      const budgetLabel =
        `₪${babysitterFixedBudgetValue}`
      const notes = [
        `Service details: ${babysitterServiceDetails.trim()}`,
        `Start time: ${formatScheduledTime(flow.scheduledFor)}`,
        `Requested duration: ${formatHoursValue(babysitterDurationValue)} hour${babysitterDurationValue === 1 ? '' : 's'}`,
        `Client budget: ${budgetLabel}`,
      ].join('\n')

      const pricingDuration = durationTypeFromMinutes(babysitterDurationMinutes ?? 0)

      flow.requestWalk({
        requestServiceType: effectiveServiceType ?? undefined,
        selectedBookingService: effectiveBookingService,
        profileServiceTypes: profile.service_types ?? null,
        legacyProfileServiceType: profile.service_type ?? null,
        dogNameOverride: babysitterServiceDetails.trim(),
        notesOverride: notes,
        durationOverride: pricingDuration,
        durationMinutesOverride: babysitterDurationMinutes,
        priceOverrideILS: babysitterBudgetValue,
        bookingTimingOverride: flow.bookingTiming,
        scheduledForOverride: flow.bookingTiming === 'scheduled' ? flow.scheduledFor : null,
      })
    } else if (effectiveServiceType === 'dog_walker') {
      const pricingDuration = durationTypeFromMinutes(dogWalkerDurationMinutes ?? 0)
      flow.requestWalk({
        requestServiceType: effectiveServiceType ?? undefined,
        selectedBookingService: effectiveBookingService,
        profileServiceTypes: profile.service_types ?? null,
        legacyProfileServiceType: profile.service_type ?? null,
        dogNameOverride: effectiveDogBookingName,
        notesOverride: selectedDogNamesNote,
        durationOverride: pricingDuration,
        durationMinutesOverride: dogWalkerDurationMinutes,
        priceOverrideILS: dogWalkerBudgetRequestValue,
        dogCountOverride: effectiveDogCount,
        clientServiceAttributesOverride: selectedKnownDogSizes.length > 0
          ? {
              dog_walker: {
                selectedDogSizes: selectedKnownDogSizes,
              },
            }
          : null,
        bookingTimingOverride: flow.bookingTiming,
        scheduledForOverride: flow.bookingTiming === 'scheduled' ? flow.scheduledFor : null,
      })
    } else if (effectiveBookingPricingModel === 'fixed_visit') {
      flow.requestWalk({
        requestServiceType: effectiveServiceType ?? undefined,
        selectedBookingService: effectiveBookingService,
        profileServiceTypes: profile.service_types ?? null,
        legacyProfileServiceType: profile.service_type ?? null,
        dogNameOverride: null,
        notesOverride: fixedVisitIssueDescription.trim() || null,
        durationOverride: null,
        durationMinutesOverride: null,
        priceOverrideILS: dogWalkerBudgetValue > 0 ? dogWalkerBudgetValue : null,
        dogCountOverride: null,
        issueTypeOverride: effectiveServiceType ?? effectiveBookingService,
        issueDescriptionOverride: fixedVisitIssueDescription.trim() || null,
        bookingTimingOverride: flow.bookingTiming,
        scheduledForOverride: flow.bookingTiming === 'scheduled' ? flow.scheduledFor : null,
      })
    } else {
      flow.requestWalk({
        requestServiceType: effectiveServiceType ?? undefined,
        selectedBookingService: effectiveBookingService,
        profileServiceTypes: profile.service_types ?? null,
        legacyProfileServiceType: profile.service_type ?? null,
      })
    }
    void hapticMedium()
  }, [
    dogWalkerBudgetValue,
    dogWalkerDurationMinutes,
    dogWalkerDurationValue,
    babysitterBudgetFixed,
    babysitterServiceDetails,
    babysitterDurationValue,
    babysitterFixedBudgetValue,
    availableBookingServices,
    effectiveDogBookingName,
    selectedKnownDogSizes,
    flow,
    flow.dogName,
    flow.duration,
    flow.location,
    flow.requestWalk,
    flow.savedCard,
    flow.scheduledFor,
    fixedVisitIssueDescription,
    profile.service_type,
    profile.service_types,
    resolvedBookingService,
    selectedDogNamesNote,
    normalizedDogCount,
  ])

  const handleFirstBookingAddPayment = useCallback(() => {
    setShowFirstBookingWow(false)
    setResumeFirstBookingWowAfterCardSetup(true)
    flow.requestCardSetup()
  }, [flow.requestCardSetup])

  const persistRecentDogNames = useCallback(
    (names: string[], targetServiceType: string | null = requestServiceType) => {
      if (targetServiceType === 'dog_walker') {
        setRecentDogNames(names)
      } else if (targetServiceType === 'baby_sitter') {
        setRecentBabysitterNames(names)
      }
      writeRecentBookingSubjects(profile.id, targetServiceType, names)
    },
    [profile.id, requestServiceType],
  )

  const persistSelectedBookingSubject = useCallback(
    (value: string) => {
      const nextValue = normalizeDogName(value)
      try {
        if (nextValue) {
          window.localStorage.setItem(
            bookingSubjectSelectedStorageKey(profile.id, requestServiceType),
            nextValue,
          )
        } else {
          window.localStorage.removeItem(
            bookingSubjectSelectedStorageKey(profile.id, requestServiceType),
          )
        }
      } catch {
        // noop
      }
    },
    [profile.id, requestServiceType],
  )

  useEffect(() => {
    if (!isDogWalkerRequest) return
    if (activeDogPets.length === 0) return
    const mergedNames = [
      ...activeDogPets.map((pet) => pet.normalizedName),
      ...recentDogNames,
    ]
      .map((name) => normalizeDogName(name))
      .filter(Boolean)
      .filter((name, index, arr) => arr.indexOf(name) === index)
      .slice(0, 8)

    const same =
      mergedNames.length === recentDogNames.length &&
      mergedNames.every((name, index) => name === recentDogNames[index])
    if (!same) {
      persistRecentDogNames(mergedNames)
    }
  }, [activeDogPets, isDogWalkerRequest, persistRecentDogNames, recentDogNames])

  useEffect(() => {
    if (!isDogWalkerRequest) return

    if (activeDogPets.length === 1) {
      const onlyPet = activeDogPets[0]
      setSelectedDogPetIds((prev) => (prev.length === 1 && prev[0] === onlyPet.id ? prev : [onlyPet.id]))
      if (flow.dogName !== onlyPet.normalizedName) {
        flow.setDogName(onlyPet.normalizedName)
        persistSelectedBookingSubject(onlyPet.normalizedName)
      }
      return
    }

    if (activeDogPets.length >= 2) {
      setSelectedDogPetIds((prev) => {
        const valid = prev.filter((id) => activeDogPets.some((pet) => pet.id === id))
        if (valid.length > 0) return valid
        return [activeDogPets[0].id]
      })
      return
    }

    setSelectedDogPetIds((prev) => (prev.length === 0 ? prev : []))
    if (flow.dogName) {
      flow.setDogName('')
      persistSelectedBookingSubject('')
    }
  }, [activeDogPets, flow, isDogWalkerRequest, persistSelectedBookingSubject])

  useEffect(() => {
    if (!isDogWalkerRequest || !shouldShowDogCountControl) return
    const nextDogName = selectedDogNames.join(', ')
    if (!nextDogName || flow.dogName === nextDogName) return
    flow.setDogName(nextDogName)
    persistSelectedBookingSubject(nextDogName)
  }, [flow, isDogWalkerRequest, persistSelectedBookingSubject, selectedDogNames, shouldShowDogCountControl])

  const commitDogName = useCallback(
    (rawValue: string) => {
      const nextName = normalizeDogName(rawValue)
      flow.setDogName(nextName)
      persistSelectedBookingSubject(nextName)
      if (!nextName) return
      const currentNames = readRecentBookingSubjects(profile.id, 'dog_walker')
      const nextNames = [nextName, ...currentNames.filter((name) => name !== nextName)].slice(0, 8)
      persistRecentDogNames(nextNames)
    },
    [flow, persistRecentDogNames, persistSelectedBookingSubject, profile.id],
  )

  const commitBabysitterSubject = useCallback(
    (rawValue: string) => {
      const nextName = normalizeDogName(rawValue)
      setBabysitterServiceDetails(nextName)
      persistSelectedBookingSubject(nextName)
      if (!nextName) return
      const currentNames = readRecentBookingSubjects(profile.id, 'baby_sitter')
      const nextNames = [nextName, ...currentNames.filter((name) => name !== nextName)].slice(0, 8)
      persistRecentDogNames(nextNames, 'baby_sitter')
    },
    [persistRecentDogNames, persistSelectedBookingSubject, profile.id],
  )

  const findDogPetByName = useCallback(
    (rawValue: string) => {
      const normalizedValue = normalizeDogName(rawValue).toLocaleLowerCase()
      if (!normalizedValue) return null
      return (
        activeDogPets.find(
          (pet) => pet.normalizedName.toLocaleLowerCase() === normalizedValue,
        ) ?? null
      )
    },
    [activeDogPets],
  )

  const selectSingleDogForBooking = useCallback(
    (pet: { id: string; normalizedName: string }) => {
      setSelectedDogPetIds([pet.id])
      flow.setDogName(pet.normalizedName)
      persistSelectedBookingSubject(pet.normalizedName)
    },
    [flow, persistSelectedBookingSubject],
  )

  const toggleDogSelection = useCallback(
    (pet: { id: string; normalizedName: string }) => {
      setSelectedDogPetIds((current) => {
        const alreadySelected = current.includes(pet.id)
        const next = alreadySelected
          ? current.filter((id) => id !== pet.id)
          : [...current, pet.id]
        const nextNames = activeDogPets
          .filter((activePet) => next.includes(activePet.id))
          .map((activePet) => activePet.normalizedName)

        flow.setDogName(nextNames.join(', '))
        persistSelectedBookingSubject(nextNames.join(', '))
        return next
      })
      setDogNameSheetError(null)
    },
    [activeDogPets, flow, persistSelectedBookingSubject],
  )

  const persistClientDog = useCallback(
    async (rawName: string, rawSize: DogSize | null, existingPetId?: string | null) => {
      const nextName = normalizeDogName(rawName)
      const nextDogSize = normalizeDogSize(rawSize)
      if (!nextName) return null
      if (!nextDogSize) return null

      const duplicatePet =
        existingPetId == null
          ? findDogPetByName(nextName)
          : null
      const targetPetId = existingPetId ?? duplicatePet?.id ?? null
      const payload = {
        client_id: profile.id,
        name: nextName,
        pet_type: 'dog',
        dog_size: nextDogSize,
        is_active: true,
      }

      if (targetPetId) {
        const { data, error } = await supabase
          .from('client_pets')
          .update(payload)
          .eq('id', targetPetId)
          .eq('client_id', profile.id)
          .select('id, client_id, name, pet_type, dog_size, is_active, created_at, updated_at')
          .single()

        if (error) {
          console.warn('[ClientDashboard] failed to update client pet:', error.message)
          return null
        }

        return (data as ClientPetRow | null) ?? null
      }

      const { data, error } = await supabase
        .from('client_pets')
        .insert(payload)
        .select('id, client_id, name, pet_type, dog_size, is_active, created_at, updated_at')
        .single()

      if (error) {
        console.warn('[ClientDashboard] failed to create client pet:', error.message)
        return null
      }

      return (data as ClientPetRow | null) ?? null
    },
    [findDogPetByName, profile.id],
  )

  const deleteClientDog = useCallback(
    async (pet: { id: string; normalizedName: string }) => {
      setDogNameSheetError(null)
      setDogNameSheetSaving(true)

      const { error } = await supabase
        .from('client_pets')
        .delete()
        .eq('id', pet.id)
        .eq('client_id', profile.id)

      setDogNameSheetSaving(false)

      if (error) {
        console.warn('[ClientDashboard] failed to delete client pet:', error.message)
        setDogNameSheetError(
          isRtl ? 'לא הצלחנו למחוק את הכלב. נסו שוב.' : 'We could not delete this dog right now. Please try again.',
        )
        return
      }

      setClientPets((current) => current.filter((currentPet) => currentPet.id !== pet.id))
      setSelectedDogPetIds((current) => current.filter((id) => id !== pet.id))
      setDogNameDraft((current) =>
        normalizeDogName(current).toLocaleLowerCase() === pet.normalizedName.toLocaleLowerCase()
          ? ''
          : current,
      )
      setDogSizeDraft(null)

      const nextRecentNames = recentDogNames.filter(
        (name) => normalizeDogName(name).toLocaleLowerCase() !== pet.normalizedName.toLocaleLowerCase(),
      )
      persistRecentDogNames(nextRecentNames)

      if (normalizeDogName(flow.dogName).toLocaleLowerCase() === pet.normalizedName.toLocaleLowerCase()) {
        flow.setDogName('')
        persistSelectedBookingSubject('')
      }
    },
    [flow, isRtl, persistRecentDogNames, persistSelectedBookingSubject, profile.id, recentDogNames],
  )

  const deleteRecentBookingSubject = useCallback(
    (rawName: string, targetServiceType: 'dog_walker' | 'baby_sitter') => {
      const nextName = normalizeDogName(rawName)
      if (!nextName) return
      const currentNames = readRecentBookingSubjects(profile.id, targetServiceType)
      const nextNames = currentNames.filter((name) => name !== nextName)
      persistRecentDogNames(nextNames, targetServiceType)

      if (targetServiceType === 'baby_sitter' && normalizeDogName(babysitterServiceDetails) === nextName) {
        setBabysitterServiceDetails('')
        try {
          window.localStorage.removeItem(
            bookingSubjectSelectedStorageKey(profile.id, targetServiceType),
          )
        } catch {
          // noop
        }
      }
    },
    [babysitterServiceDetails, persistRecentDogNames, profile.id],
  )

  const openDogNameSheet = useCallback(() => {
    const isBabysitterRequest = requestServiceType === 'baby_sitter'
    setDogNameSheetError(null)
    setShowDogNameSheet(true)
    setDogNameDraft(isBabysitterRequest ? babysitterServiceDetails : '')
    setDogSizeDraft(null)
    setRecipientEditorOpen(false)
  }, [babysitterServiceDetails, requestServiceType])

  const closeDogNameSheet = useCallback(() => {
    if (dogNameSheetSaving) return
    setDogNameSheetError(null)
    setShowDogNameSheet(false)
    setRecipientEditorOpen(false)
  }, [dogNameSheetSaving])

  const submitDogNameSheet = useCallback(async () => {
    const nextName = normalizeDogName(dogNameDraft)
    setDogNameSheetError(null)

    if (requestServiceType === 'baby_sitter') {
      if (!nextName) return
      commitBabysitterSubject(nextName)
      setShowDogNameSheet(false)
      return
    }

    if (!nextName) {
      if (selectedDogPetIds.length > 0) {
        setShowDogNameSheet(false)
      }
      return
    }

    if (!dogSizeDraft) {
      setDogNameSheetError(
        isRtl ? 'בחרו גודל כלב לפני השמירה.' : 'Choose a dog size before saving.',
      )
      return
    }

    const existingPet = findDogPetByName(nextName)

    setDogNameSheetSaving(true)
    const persistedPet = await persistClientDog(nextName, dogSizeDraft, existingPet?.id ?? null)
    setDogNameSheetSaving(false)

    if (!persistedPet) {
      setDogNameSheetError(
        isRtl ? 'לא הצלחנו לשמור את פרטי הכלב. נסו שוב.' : 'We could not save this dog right now. Please try again.',
      )
      return
    }

    setClientPets((current) => {
      const nextPets = current.some((pet) => pet.id === persistedPet.id)
        ? current.map((pet) => (pet.id === persistedPet.id ? persistedPet : pet))
        : [...current, persistedPet]
      return nextPets
        .filter((pet) => pet.pet_type === 'dog')
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
    })
    selectSingleDogForBooking({
      id: persistedPet.id,
      normalizedName: nextName,
    })
    commitDogName(nextName)
    setShowDogNameSheet(false)
  }, [
    activeDogPets,
    selectSingleDogForBooking,
    commitBabysitterSubject,
    commitDogName,
    dogNameDraft,
    dogSizeDraft,
    findDogPetByName,
    isRtl,
    persistClientDog,
    requestServiceType,
    selectedDogPetIds.length,
  ])

  const handleFirstBookingStart = useCallback(() => {
    setShowFirstBookingWow(false)
    setResumeFirstBookingWowAfterCardSetup(false)
    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }, [])

  const upcomingScheduledItems = useMemo<UpcomingBookingItem[]>(
    () =>
      flow.upcomingJobs.map((j) => ({
        id: j.id,
        dogName: j.dog_name || t('booking.walkFallback'),
        dog_count: j.dog_count ?? 1,
        location: formatShortAddress(j.address || j.location),
        scheduledFor: j.scheduled_for,
        startsInMin: flow.startsInMinutes(j.scheduled_for),
        price: j.scheduled_fee_snapshot ?? j.price,
        findingProviderAt: getScheduledDispatchWindowLabel(j.scheduled_for),
      })),
    [flow.upcomingJobs, flow.startsInMinutes, t],
  )

  const loadRecurringBookings = useCallback(async () => {
    setRecurringLoading(true)
    setRecurringError(null)
    const { data, error } = await supabase
      .from('recurring_bookings')
      .select('*')
      .eq('client_id', profile.id)
      .neq('recurring_status', 'cancelled')
      .order('created_at', { ascending: false })

    if (error) {
      console.warn('[ClientDashboard] recurring bookings unavailable:', error.message)
      setRecurringError(error.message)
      setRecurringBookings([])
      setRecurringLoading(false)
      return
    }

    setRecurringBookings(((data as RecurringBookingRow[] | null) ?? []).map((row) => ({
      ...row,
      repeat_days: normalizeRepeatDays(row.repeat_days),
    })))
    setRecurringLoading(false)
  }, [profile.id])

  useEffect(() => {
    void loadRecurringBookings()
  }, [loadRecurringBookings])

  const recurringItems = useMemo<RecurringBookingItem[]>(
    () =>
      recurringBookings.map((row) => {
        const repeatDays = normalizeRepeatDays(row.repeat_days)
        const nextOccurrenceAt = getNextRecurringOccurrence(
          repeatDays,
          row.repeat_starts_on,
          row.start_time,
          row.repeat_ends_on,
        )
        const language = i18n.resolvedLanguage || 'en'
        const serviceLabel =
          getProfileServiceTypeLabel(
            normalizeProfileServiceType(row.service_type) ?? 'dog_walker',
            language === 'he',
          ) || row.service_type
        const titleParts = [serviceLabel]
        if (isDogServiceType(row.service_type)) {
          titleParts.push(formatDogCountLabel(row.dog_count ?? 1, { isHebrew: language === 'he' }))
        }
        return {
          id: row.id,
          serviceLabel,
          title: titleParts.join(' · '),
          weekdaysLabel: formatRepeatDaysLabel(repeatDays, language),
          timeLabel: formatRecurringDisplayTime(row.start_time, language),
          durationLabel: formatDurationFromMinutes(row.duration_minutes) ?? `${row.duration_minutes} min`,
          pricePerVisit: Number(row.price_per_visit),
          nextOccurrenceLabel: nextOccurrenceAt
            ? nextOccurrenceAt.toLocaleDateString(language === 'he' ? 'he-IL' : 'en-US', {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
              })
            : null,
          nextOccurrenceAt,
          status: row.recurring_status,
          repeatDays,
          startsOn: row.repeat_starts_on,
          startTime: row.start_time,
        }
      }),
    [i18n.resolvedLanguage, recurringBookings, t],
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
                ? flow.walkerNameById.get(item.walker_id) || t('common.provider')
                : t('common.provider')

        const dogName =
          typeof item.dog_name === 'string'
            ? item.dog_name
            : typeof item.dogName === 'string'
              ? item.dogName
              : t('booking.walkFallback')

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
          dog_count:
            typeof item.dog_count === 'number'
              ? item.dog_count
              : typeof item.dogCount === 'number'
                ? item.dogCount
                : 1,
          service_type:
            typeof item.service_type === 'string'
              ? item.service_type
              : typeof item.serviceType === 'string'
                ? item.serviceType
                : typeof item.request_service_type === 'string'
                  ? item.request_service_type
                  : null,
          address: formatShortAddress(location),
          created_at: createdAt,
          completed_at: createdAt,
          duration_minutes: durationMinutes,
          tip_amount: tipAmount,
          price,
          walker_id: typeof item.walker_id === 'string' ? item.walker_id : null,
          walker_name: walkerName,
          hidden_by_client: item.hidden_by_client === true,
          payment_status: typeof item.payment_status === 'string' ? item.payment_status : null,
          notes: typeof item.notes === 'string' ? item.notes : null,
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
    t,
  ])

  const menuHistoryPreviewItems = useMemo(
    () => allHistoryItems.filter((item) => item.hidden_by_client !== true).slice(0, 3),
    [allHistoryItems],
  )

  const hasCompletionPrompt =
    !!flow.completionJob && !locallyDismissedCompletionIds.has(flow.completionJob.jobId)
  const preferredWalkers = flow.favoriteWalkers
  const favoriteIndicatorLabel =
    preferredWalkers.length === 1
      ? t('menu.favoriteWalker', {
          name:
            preferredWalkers[0]?.walker?.full_name ||
            preferredWalkers[0]?.walker?.email ||
            flow.walkerNameById.get(preferredWalkers[0]?.walker_id ?? '') ||
            t('common.provider'),
        })
      : t('menu.favoriteWalkersCount', { count: preferredWalkers.length })
  const isSearching = flow.screenState === 'searching'
  const isTrackingState = flow.screenState === 'tracking' || flow.screenState === 'active'
  const hasFutureOrders = upcomingScheduledItems.length > 0
  const isActivelyMatchingJob = (
    job:
      | {
          smart_dispatch_state?: string | null
          booking_timing?: string | null
          scheduled_for?: string | null
          dispatch_state?: string | null
          smart_dispatch_last_error?: string | null
        }
      | null
      | undefined,
  ) =>
    !!job &&
    (job.scheduled_for == null ||
      job.booking_timing !== 'scheduled' ||
      job.dispatch_state === 'dispatched')
  const isActivelyMatchingExhaustedJob = (
    job:
      | {
          smart_dispatch_state?: string | null
          booking_timing?: string | null
          scheduled_for?: string | null
          dispatch_state?: string | null
        }
      | null
      | undefined,
  ) =>
    !!job &&
    isActivelyMatchingJob(job) &&
    job.smart_dispatch_state === 'exhausted'
  const isDispatchExhausted =
    isActivelyMatchingExhaustedJob(flow.currentJob) ||
    isActivelyMatchingExhaustedJob(flow.activeJob)
  const hasExplicitNoProviderState = [flow.currentJob, flow.activeJob].some((job) => {
    if (!job || !isActivelyMatchingJob(job)) return false
    if (job.smart_dispatch_state === 'exhausted') return true
    const lastError = typeof job.smart_dispatch_last_error === 'string'
      ? job.smart_dispatch_last_error.toLowerCase()
      : ''
    return (
      lastError.includes('all candidates exhausted') ||
      lastError.includes('no matching providers for service_type') ||
      lastError.includes('no matching providers for service type') ||
      lastError.includes('no providers available')
    )
  })
  const shouldShowNoProvidersEmptyState =
    hasExplicitNoProviderState ||
    (
      !hasFutureOrders &&
      flow.screenState !== 'searching' &&
      (
        flow.availabilityNotice?.title === 'No providers available right now' ||
        flow.availabilityNotice?.title === t('booking.noProvidersForService') ||
        flow.availabilityNotice?.title === t('booking.noProvidersAvailable')
      )
    )
  const isIdleState =
    flow.screenState === 'idle' &&
    !hasCompletionPrompt &&
    !isDispatchExhausted &&
    !shouldShowNoProvidersEmptyState
  const shouldRenderIdleSheet =
    flow.screenState === 'idle' &&
    !hasCompletionPrompt &&
    !flow.tipJob &&
    !isDispatchExhausted &&
    !shouldShowNoProvidersEmptyState
  const shouldRenderSearchingSheet =
    flow.screenState === 'searching' || isDispatchExhausted || shouldShowNoProvidersEmptyState
  const isSheetCollapsed = sheetSnap === 'collapsed'
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
  const isBabysitterGuidanceMode = requestServiceType === 'baby_sitter'
  const isDogWalkerGuidanceMode = requestServiceType === 'dog_walker'
  const nextGuidedBookingField: 'dogName' | 'duration' | 'payment' | null = !shouldUseSteplessGuidance
    ? null
    : !(isBabysitterGuidanceMode ? babysitterServiceDetails.trim() : flow.dogName.trim())
      ? 'dogName'
      : !(
          isBabysitterGuidanceMode
            ? babysitterDurationValue > 0
            : isDogWalkerGuidanceMode
              ? dogWalkerDurationValue > 0
              : flow.duration
        )
        ? 'duration'
        : !flow.savedCard
          ? 'payment'
          : null
  const isDogNameGuided = guidedBookingField === 'dogName'
  const isDurationGuided = guidedBookingField === 'duration'
  const isPaymentGuided = guidedBookingField === 'payment'
  const shouldShowGuidanceCtaHelper =
    guidedBookingField !== null &&
    guidedBookingField !== 'payment' &&
    !flow.loading &&
    !flow.cardLoading
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

  useEffect(() => {
    if (isDispatchExhausted) {
      setMatchingUiState('empty')
      return
    }

    if (shouldShowNoProvidersEmptyState) {
      setMatchingUiState('empty')
      return
    }

    if (isSearching) {
      setMatchingUiState('matching')
      return
    }

    if (isTrackingState || flow.completionJob) {
      setMatchingUiState(null)
      return
    }

    setMatchingUiState((current) => {
      if (current !== 'matching') return current
      if (flow.error) return 'empty'
      if (flow.screenState === 'idle') return null
      return current
    })
  }, [
    flow.completionJob,
    flow.error,
    flow.screenState,
    isDispatchExhausted,
    isSearching,
    isTrackingState,
    shouldShowNoProvidersEmptyState,
  ])

  useEffect(() => {
    const currentJobId = flow.currentJob?.id ?? null

    if (currentJobId !== lastCurrentJobIdRef.current) {
      lastCurrentJobIdRef.current = currentJobId
      if (currentJobId && !isDispatchExhausted && !shouldShowNoProvidersEmptyState) {
        setMatchingUiState(null)
      }
    }
  }, [flow.currentJob?.id, isDispatchExhausted, shouldShowNoProvidersEmptyState])

  const nearbyWalkers = useNearbyWalkers(
    flow.hasUserLocation ? flow.userLocation : null,
    flow.hasUserLocation && showNearbyWalkers,
    requestServiceType,
    flow.bookingTiming === 'scheduled' ? flow.scheduledFor : null,
    flow.bookingTiming === 'scheduled' ? 'scheduled' : 'asap',
  )
  const nearbyProviderIdsForGuidance = useMemo(
    () => Array.from(new Set(nearbyWalkers.map((walker) => walker.id).filter((value) => value.length > 0))).sort(),
    [nearbyWalkers],
  )
  const nearbyProviderIdsForGuidanceKey = useMemo(
    () => nearbyProviderIdsForGuidance.join(','),
    [nearbyProviderIdsForGuidance],
  )
  const providerPricingQueryKey = useMemo(() => {
    const serviceType = effectiveRequestServiceType ?? resolvedBookingService ?? ''
    return JSON.stringify({
      serviceType,
      bookingType: bookingTypeForGuidance,
      dogCount: normalizedDogCount,
      nearbyProviderIdsForGuidanceKey,
    })
  }, [
    bookingTypeForGuidance,
    effectiveRequestServiceType,
    nearbyProviderIdsForGuidanceKey,
    normalizedDogCount,
    resolvedBookingService,
  ])

  const mapUserLocation: [number, number] =
    flow.userLocation ?? flow.walkerLocation ?? ([32.0853, 34.7818] as [number, number])

  const trackingGpsQuality: GpsQuality =
    flow.gpsQuality === 'last_known' ? 'delayed' : flow.gpsQuality
  const activeProviderId = flow.activeJob?.walker_id ?? null
  const activeProviderWhatsAppPhone = useMemo(
    () => normalizePhoneForWhatsApp(providerHeroMeta.whatsappNumber),
    [providerHeroMeta.whatsappNumber],
  )
  const activeProviderName =
    (flow.activeJob?.walker_id ? flow.walkerNameById.get(flow.activeJob.walker_id) : null) || t('common.provider')

  useEffect(() => {
    if (!activeProviderId) return
    console.debug('[ClientDashboard] provider communication meta', {
      providerId: activeProviderId,
      providerPhoneRaw: providerHeroMeta.whatsappNumberRaw,
      normalizedProviderPhone: activeProviderWhatsAppPhone,
      provider_phone_available: !!activeProviderWhatsAppPhone,
    })
  }, [activeProviderId, activeProviderWhatsAppPhone, providerHeroMeta.whatsappNumberRaw])

  const handleWhatsAppProvider = useCallback(() => {
    console.debug('[ClientDashboard] whatsapp_clicked', {
      provider_phone_available: !!activeProviderWhatsAppPhone,
      providerId: activeProviderId,
    })
    if (!activeProviderWhatsAppPhone || typeof window === 'undefined') return
    const message = `Hi ${activeProviderName}, regarding the current Regli booking 😊`
    window.location.href = `https://wa.me/${activeProviderWhatsAppPhone}?text=${encodeURIComponent(message)}`
  }, [activeProviderId, activeProviderName, activeProviderWhatsAppPhone])

  useEffect(() => {
    let cancelled = false

    async function loadProviderHeroMeta() {
        if (!activeProviderId) {
          if (!cancelled) {
            setProviderHeroMeta({
              fullName: null,
              avatarUrl: null,
              rating: null,
              completedCount: 0,
              serviceLabel: null,
              experienceRange: null,
              experienceYears: null,
              languages: [],
              specialties: [],
              servicePreferences: [],
              shortBio: null,
              preferredCustomerCount: 0,
              repeatClientIndicator: false,
              whatsappNumber: null,
              whatsappNumberRaw: null,
            })
          }
          return
        }

      try {
        const [profileResult, ratingsResult, completedResult, providerCapabilitiesResult, preferredCustomersResult] = await Promise.all([
          supabase
            .from('profiles')
            .select('*')
            .eq('id', activeProviderId)
            .maybeSingle(),
          supabase
            .from('ratings')
            .select('rating')
            .eq('to_user_id', activeProviderId),
          supabase
            .from('walk_requests')
            .select('id', { count: 'exact', head: true })
            .eq('walker_id', activeProviderId)
            .eq('status', 'completed'),
          supabase
            .from('provider_capabilities')
            .select('provider_id, capability_scope, capabilities, updated_at')
            .eq('provider_id', activeProviderId),
          supabase
            .from('favorite_customers')
            .select('client_id', { count: 'exact', head: true })
            .eq('walker_id', activeProviderId),
        ])

        if (cancelled) return

        const ratingRows = (ratingsResult.data as Array<{ rating: number | null }> | null) ?? []
        const validRatings = ratingRows
          .map((row) => row.rating)
          .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
        const averageRating =
          validRatings.length > 0
            ? Math.round((validRatings.reduce((sum, value) => sum + value, 0) / validRatings.length) * 10) / 10
            : null

        const providerWhatsAppRaw =
          profileResult.error == null && profileResult.data
            ? (('whatsapp_number' in profileResult.data
                ? (profileResult.data.whatsapp_number as string | null)
                : 'phone' in profileResult.data
                  ? (profileResult.data.phone as string | null)
                : 'phone_number' in profileResult.data
                  ? (profileResult.data.phone_number as string | null)
                  : 'mobile' in profileResult.data
                    ? (profileResult.data.mobile as string | null)
                    : null) ?? null)
            : null
        const providerServiceAttributes =
          profileResult.error == null && profileResult.data && 'service_attributes' in profileResult.data
            ? (profileResult.data.service_attributes as Record<string, unknown> | null) ?? null
            : null
        const mergedProviderCapabilities = mergeProviderCapabilitiesSources({
          rows: (providerCapabilitiesResult.data as ProviderCapabilityRow[] | null) ?? null,
          fallbackServiceAttributes: providerServiceAttributes,
          shortBio:
            profileResult.error == null && profileResult.data && 'short_bio' in profileResult.data
              ? (profileResult.data.short_bio as string | null) ?? null
              : null,
        })
        const providerFullName =
          profileResult.error == null && profileResult.data && 'full_name' in profileResult.data
            ? (profileResult.data.full_name as string | null) ?? null
            : null
        const providerServiceLabel = resolveProviderServiceLabel({
          requestedServiceType: flow.activeJob?.service_type ?? null,
          serviceType:
            profileResult.error == null && profileResult.data && 'service_type' in profileResult.data
              ? (profileResult.data.service_type as string | null) ?? null
              : null,
          serviceTypes:
            profileResult.error == null && profileResult.data && 'service_types' in profileResult.data
              ? (profileResult.data.service_types as unknown) ?? null
              : null,
          primaryService:
            profileResult.error == null && profileResult.data && 'primary_service' in profileResult.data
              ? (profileResult.data.primary_service as string | null) ?? null
              : null,
          isHebrew: isRtl,
        })
        const capabilitySummary = getProviderCapabilitySummary({
          capabilities: mergedProviderCapabilities,
          serviceType: flow.activeJob?.service_type ?? null,
          fallbackShortBio:
            profileResult.error == null && profileResult.data && 'short_bio' in profileResult.data
              ? (profileResult.data.short_bio as string | null) ?? null
              : null,
        })

        setProviderHeroMeta({
          fullName: providerFullName,
          avatarUrl:
            profileResult.error == null && profileResult.data && 'avatar_url' in profileResult.data
              ? (profileResult.data.avatar_url as string | null) ?? null
              : null,
          rating: averageRating,
          completedCount: completedResult.count ?? 0,
          serviceLabel: providerServiceLabel,
          experienceRange: capabilitySummary.experienceRange,
          experienceYears: capabilitySummary.experienceYears,
          languages: capabilitySummary.languages,
          specialties: capabilitySummary.specialties,
          servicePreferences: capabilitySummary.servicePreferences,
          shortBio: capabilitySummary.shortBio,
          preferredCustomerCount: preferredCustomersResult.count ?? 0,
          repeatClientIndicator: (preferredCustomersResult.count ?? 0) > 0,
          whatsappNumber: providerWhatsAppRaw,
          whatsappNumberRaw: providerWhatsAppRaw,
        })
      } catch (error) {
        console.warn('[ClientDashboard] failed to load provider hero meta', {
          providerId: activeProviderId,
          error,
        })
        if (!cancelled) {
          setProviderHeroMeta({
            fullName: null,
            avatarUrl: null,
            rating: null,
            completedCount: 0,
            serviceLabel: null,
            experienceRange: null,
            experienceYears: null,
            languages: [],
            specialties: [],
            servicePreferences: [],
            shortBio: null,
            preferredCustomerCount: 0,
            repeatClientIndicator: false,
            whatsappNumber: null,
            whatsappNumberRaw: null,
          })
        }
      }
    }

    void loadProviderHeroMeta()

    return () => {
      cancelled = true
    }
  }, [activeProviderId, flow.activeJob?.service_type, isRtl])

  const openProviderProfile = useCallback((providerId: string, fallbackName: string, requestedServiceType?: string | null) => {
    if (!providerId) return
    setProviderProfileError(null)
    setProviderProfileLoading(false)
    if (providerId === activeProviderId) {
      setProviderProfileData({
        ...providerHeroMeta,
        fullName: providerHeroMeta.fullName || fallbackName,
      })
    } else {
      setProviderProfileData(null)
    }
    setProviderProfileSheet({
      providerId,
      fallbackName,
      requestedServiceType: requestedServiceType ?? null,
    })
  }, [activeProviderId, providerHeroMeta])

  useEffect(() => {
    let cancelled = false

    async function loadProviderProfileSheet() {
      if (!providerProfileSheet) return

      setProviderProfileLoading(true)
      setProviderProfileError(null)

      try {
        const [profileResult, ratingsResult, completedResult, providerCapabilitiesResult, preferredCustomersResult] = await Promise.all([
          supabase
            .from('profiles')
            .select('*')
            .eq('id', providerProfileSheet.providerId)
            .maybeSingle(),
          supabase
            .from('ratings')
            .select('rating')
            .eq('to_user_id', providerProfileSheet.providerId),
          supabase
            .from('walk_requests')
            .select('id', { count: 'exact', head: true })
            .eq('walker_id', providerProfileSheet.providerId)
            .eq('status', 'completed'),
          supabase
            .from('provider_capabilities')
            .select('provider_id, capability_scope, capabilities, updated_at')
            .eq('provider_id', providerProfileSheet.providerId),
          supabase
            .from('favorite_customers')
            .select('client_id', { count: 'exact', head: true })
            .eq('walker_id', providerProfileSheet.providerId),
        ])

        if (cancelled) return

        const ratingRows = (ratingsResult.data as Array<{ rating: number | null }> | null) ?? []
        const validRatings = ratingRows
          .map((row) => row.rating)
          .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
        const averageRating =
          validRatings.length > 0
            ? Math.round((validRatings.reduce((sum, value) => sum + value, 0) / validRatings.length) * 10) / 10
            : null

        const rawProfile = profileResult.error == null ? profileResult.data : null
        const serviceAttributes = rawProfile && 'service_attributes' in rawProfile
          ? (rawProfile.service_attributes as Record<string, unknown> | null) ?? null
          : null
        const mergedProviderCapabilities = mergeProviderCapabilitiesSources({
          rows: (providerCapabilitiesResult.data as ProviderCapabilityRow[] | null) ?? null,
          fallbackServiceAttributes: serviceAttributes,
          shortBio:
            rawProfile && 'short_bio' in rawProfile
              ? (rawProfile.short_bio as string | null) ?? null
              : null,
        })
        const capabilitySummary = getProviderCapabilitySummary({
          capabilities: mergedProviderCapabilities,
          serviceType: providerProfileSheet.requestedServiceType,
          fallbackShortBio:
            rawProfile && 'short_bio' in rawProfile
              ? (rawProfile.short_bio as string | null) ?? null
              : null,
        })

        setProviderProfileData({
          fullName:
            rawProfile && 'full_name' in rawProfile && typeof rawProfile.full_name === 'string' && rawProfile.full_name.trim()
              ? rawProfile.full_name
              : providerProfileSheet.fallbackName,
          avatarUrl:
            rawProfile && 'avatar_url' in rawProfile
              ? (rawProfile.avatar_url as string | null) ?? null
              : null,
          rating: averageRating,
          completedCount: completedResult.count ?? 0,
          serviceLabel: resolveProviderServiceLabel({
            requestedServiceType: providerProfileSheet.requestedServiceType,
            serviceType:
              rawProfile && 'service_type' in rawProfile
                ? (rawProfile.service_type as string | null) ?? null
                : null,
            serviceTypes:
              rawProfile && 'service_types' in rawProfile
                ? (rawProfile.service_types as unknown) ?? null
                : null,
            primaryService:
              rawProfile && 'primary_service' in rawProfile
                ? (rawProfile.primary_service as string | null) ?? null
                : null,
            isHebrew: isRtl,
          }),
          experienceRange: capabilitySummary.experienceRange,
          experienceYears: capabilitySummary.experienceYears,
          languages: capabilitySummary.languages,
          specialties: capabilitySummary.specialties,
          servicePreferences: capabilitySummary.servicePreferences,
          shortBio: capabilitySummary.shortBio,
          preferredCustomerCount: preferredCustomersResult.count ?? 0,
          repeatClientIndicator: (preferredCustomersResult.count ?? 0) > 0,
          whatsappNumber:
            rawProfile && 'whatsapp_number' in rawProfile
              ? (rawProfile.whatsapp_number as string | null) ?? null
              : null,
          whatsappNumberRaw:
            rawProfile && 'whatsapp_number' in rawProfile
              ? (rawProfile.whatsapp_number as string | null) ?? null
              : null,
        })
      } catch (error) {
        if (cancelled) return
        console.warn('[ClientDashboard] failed to load provider public profile', {
          providerId: providerProfileSheet.providerId,
          error,
        })
        setProviderProfileError(t('providerPublicProfile.unavailable'))
      } finally {
        if (!cancelled) setProviderProfileLoading(false)
      }
    }

    void loadProviderProfileSheet()

    return () => {
      cancelled = true
    }
  }, [providerProfileSheet, isRtl, t])

  const flexibleRequestDurationMinutes =
    requestServiceType === 'baby_sitter'
      ? babysitterDurationMinutes
      : requestServiceType === 'dog_walker'
        ? dogWalkerDurationMinutes
        : null
  const currentRequestPricingModel = getBookingPricingModelForService(
    flow.currentJob?.service_type ?? effectiveRequestServiceType ?? resolvedBookingService,
  )
  const activeRequestPricingModel = getBookingPricingModelForService(
    flow.activeJob?.service_type ?? effectiveRequestServiceType ?? resolvedBookingService,
  )
  const requestDurationLabel =
    currentRequestPricingModel === 'fixed_visit'
      ? t('tracking.visitFee')
      : localizeMinuteUnitLabel(
          formatDurationFromMinutes(flow.currentJob?.duration_minutes ?? flexibleRequestDurationMinutes),
        ) ||
        (requestServiceType === 'baby_sitter' || requestServiceType === 'dog_walker'
          ? ''
          : localizeMinuteUnitLabel(flow.selectedDuration.label) || t('booking.walkFallback'))
  const requestPriceLabel =
    flow.currentJob?.price != null && flow.currentJob.price > 0
      ? `₪${flow.currentJob.price}`
      : flow.adjustedPriceILS > 0
        ? `₪${flow.adjustedPriceILS}`
        : '₪0'
  const activeRequestPriceLabel =
    flow.activeJob?.price != null && flow.activeJob.price > 0
      ? `₪${flow.activeJob.price}`
      : requestPriceLabel
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
    () => {
      if (!flow.completionJob) return null
      const completedJob =
        flow.completedJobs.find((job) => job.id === flow.completionJob?.jobId) ?? null

      if (completedJob) return completedJob

      return {
        id: flow.completionJob.jobId,
        dog_count: flow.completionJob.dogCount ?? null,
        duration_minutes: flow.completionJob.durationMinutes ?? null,
        service_started_at: flow.completionJob.serviceStartedAt ?? null,
        service_completed_at: flow.completionJob.serviceCompletedAt ?? null,
        price: flow.completionJob.price ?? null,
        payment_status: flow.completionJob.paymentStatus ?? null,
        service_type: flow.completionJob.serviceType ?? null,
      }
    },
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

  useEffect(() => {
    if (!flow.completionJob) return
    const startedTs = completionJobDetails?.service_started_at ? new Date(completionJobDetails.service_started_at).getTime() : null
    const completedTs = completionJobDetails?.service_completed_at ? new Date(completionJobDetails.service_completed_at).getTime() : null
    const diffSeconds =
      startedTs != null && completedTs != null && !Number.isNaN(startedTs) && !Number.isNaN(completedTs)
        ? Math.max(0, Math.floor((completedTs - startedTs) / 1000))
        : null
    console.debug('[ClientDashboard] completion card duration', {
      service_started_at: completionJobDetails?.service_started_at ?? null,
      service_completed_at: completionJobDetails?.service_completed_at ?? null,
      computedDiffSeconds: diffSeconds,
      computedActualDurationLabel: completionDurationSummary.actualLabel ?? '—',
    })
  }, [
    completionDurationSummary.actualLabel,
    completionJobDetails?.service_completed_at,
    completionJobDetails?.service_started_at,
    flow.completionJob,
  ])

  const completionMetaRows = useMemo(() => {
    const rows: Array<{ label: string; value: string }> = []
    if (completionJobDetails?.payment_status === 'paid') {
      rows.push({
        label: t('completion.paymentCompleted'),
        value: t('completion.paymentCompleted'),
      })
      if (completionJobDetails.price != null && completionJobDetails.price > 0) {
        rows.push({
          label: t('completion.amountCharged'),
          value: `₪${completionJobDetails.price}`,
        })
      }
      rows.push({
        label: t('completion.paymentMethod'),
        value: flow.savedCard
          ? `${capitalize(flow.savedCard.brand)} ${flow.savedCard.last4}`
          : t('completion.cardOnFile'),
      })
    }
    if (completionDurationSummary.plannedLabel) {
      rows.push({
        label: t('tracking.planned'),
        value: localizeMinuteUnitLabel(completionDurationSummary.plannedLabel) || completionDurationSummary.plannedLabel,
      })
    }
    rows.push({
      label: t('completion.actualDuration'),
      value:
        localizeMinuteUnitLabel(completionDurationSummary.actualLabel) ||
        completionDurationSummary.actualLabel ||
        '—',
    })
    if (isDogServiceType(completionJobDetails?.service_type) && completionJobDetails) {
      rows.push({
        label: isRtl ? 'כלבים' : 'Dogs',
        value: formatDogCountLabel(completionJobDetails.dog_count ?? 1, { isHebrew: isRtl }),
      })
    }
    return rows
  }, [
    completionDurationSummary.actualLabel,
    completionDurationSummary.plannedLabel,
    completionJobDetails?.dog_count,
    completionJobDetails?.payment_status,
    completionJobDetails?.price,
    completionJobDetails?.service_type,
    flow.savedCard,
    i18n.resolvedLanguage,
    isRtl,
    t,
  ])

  const handleDismissCompletionCard = useCallback(() => {
    const completionJobId = flow.completionJob?.jobId
    if (completionJobId) {
      setLocallyDismissedCompletionIds((current) => {
        const next = new Set(current)
        next.add(completionJobId)
        return next
      })
      console.debug('[ClientDashboard] completion card dismissed locally', {
        completionJobId,
      })
    }
    flow.dismissCompletion()
  }, [flow])

  const activeJobHasProviderIssue = hasProviderIssue(flow.activeJob?.notes)

  const closeAll = useCallback(() => {
    setBurgerOpen(false)
    setMenuPage('main')
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
    markFirstInteractionHandler('client-dashboard:open-schedule')
    const nextDraft = clampScheduledDraft(getNowPlus15LocalInput(), getNowPlus15LocalInput())
    setScheduleDraft(nextDraft)
    setRepeatStartTime(splitScheduledDraft(nextDraft).time)
    setScheduleMode('later')
    clearScheduleConflictWarning('sheet_open')
    setShowSchedulePage(true)
    markFirstInteractionVisual('client-dashboard:open-schedule')
    void hapticLight()
  }, [clearScheduleConflictWarning])

  const closeScheduleSheet = useCallback(() => {
    clearScheduleConflictWarning('sheet_closed')
    setShowSchedulePage(false)
  }, [clearScheduleConflictWarning])

  const handleScheduleTabChange = useCallback((nextMode: ScheduleMode) => {
    console.log('[schedule-sheet] tab changed', {
      selectedScheduledFor: scheduleDraft,
      bookingTiming: flow.bookingTiming,
      activeTab: nextMode,
      timestamp: Date.now(),
    })
    clearScheduleConflictWarning(`tab_changed:${nextMode}`)
    setScheduleMode(nextMode)
    setRepeatType(nextMode === 'repeat' ? 'weekly' : 'one_time')
  }, [clearScheduleConflictWarning, flow.bookingTiming, scheduleDraft])

  const openAddressPicker = useCallback(() => {
    markFirstInteractionHandler('client-dashboard:open-address-picker')
    setAddressPickerOpen(true)
    markFirstInteractionVisual('client-dashboard:open-address-picker')
  }, [])

  const handleAddressConfirm = useCallback((address: string) => {
    flow.setLocation(address)
  }, [flow])

  const handleAddressUseCurrentLocation = useCallback(async () => {
    return await flow.refreshLocation()
  }, [flow])

  const handleMatchingTryAgain = useCallback(() => {
    flow.clearAvailabilityNotice()
    flow.clearError()
    flow.clearExhaustedRequestForRetry?.()
    setMatchingUiState(null)
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
    })
  }, [flow])

  const handleDogWalkerDurationStep = useCallback((direction: 'down' | 'up') => {
    const delta = direction === 'up' ? DOG_WALKER_DURATION_STEP : -DOG_WALKER_DURATION_STEP
    const nextValue = clampNumber(
      Math.round((dogWalkerDurationValue + delta) * 2) / 2,
      DOG_WALKER_DURATION_MIN,
      DOG_WALKER_DURATION_MAX,
    )
    setDogWalkerDurationHours(formatHoursValue(nextValue))
    markFirstInteractionHandler('client-dashboard:duration-select', {
      value: nextValue,
      currentUi: dogWalkerDurationValue,
    })
    markFirstInteractionVisual('client-dashboard:duration-ui', { value: nextValue })
    setSheetSnap('default')
    void hapticLight()
  }, [dogWalkerDurationValue])

  const openFavoritesMenu = useCallback(() => {
    setBurgerOpen(true)
    setMenuPage('settings')
  }, [])

  const currentMapStyle: React.CSSProperties = isTrackingState
    ? trackingMapContainerStyle
    : isSearching
      ? searchingMapContainerStyle
      : idleMapContainerStyle

  const scheduleMinValue = getNowPlus15LocalInput()
  const scheduleDraftParts = splitScheduledDraft(clampScheduledDraft(scheduleDraft, scheduleMinValue))
  const dateWheelOptions = useMemo(
    () => buildDateWheelOptions(scheduleMinValue, i18n.resolvedLanguage || 'en', t),
    [i18n.resolvedLanguage, scheduleMinValue, t],
  )
  const hourWheelOptions = useMemo<WheelOption[]>(
    () =>
      Array.from({ length: 24 }, (_, hour) => ({
        value: pad(hour),
        label: pad(hour),
      })),
    [],
  )
  const minuteWheelOptions = useMemo<WheelOption[]>(
    () =>
      Array.from({ length: 60 }, (_, minute) => ({
        value: pad(minute),
        label: pad(minute),
      })),
    [],
  )
  const timePickerHourOptions = useMemo<WheelOption[]>(
    () =>
      Array.from({ length: 12 }, (_, index) => {
        const value = String(index + 1)
        return { value, label: value }
      }),
    [],
  )

  const updateScheduledDraftFromWheel = useCallback(
    (nextDate: string, nextHour: string, nextMinute: string) => {
      setScheduleDraft(
        clampScheduledDraft(mergeScheduledDraft(nextDate, `${nextHour}:${nextMinute}`), scheduleMinValue),
      )
    },
    [scheduleMinValue],
  )
  const selectedScheduleDateLabel = useMemo(
    () => dateWheelOptions.find((option) => option.value === scheduleDraftParts.date)?.label ?? scheduleDraftParts.date,
    [dateWheelOptions, scheduleDraftParts.date],
  )
  const selectedScheduledFor = useMemo(
    () => clampScheduledDraft(scheduleDraft, scheduleMinValue),
    [scheduleDraft, scheduleMinValue],
  )

  const currentSheetStyle: React.CSSProperties = isTrackingState
    ? trackingSheetStyle
    : isIdleState
      ? idleSheetStyle
      : searchingSheetStyle

  const currentSheetScrollStyle: React.CSSProperties = isIdleState
    ? idleSheetScrollStyle
    : isTrackingState
      ? trackingSheetScrollStyle
      : searchingSheetScrollStyle
  const sheetMaxHeights = useMemo(() => {
    const vh = Math.max(appViewportHeight, 500)
    return {
      collapsed: 340,
      default: vh - 92,
    } satisfies Record<SheetSnap, number>
  }, [appViewportHeight])

  const mapBottomViewportPadding = useMemo(() => {
    const vh = Math.max(appViewportHeight, appViewportHeightRef.current)
    const collapsedPadding = Math.round(Math.min(220, Math.max(140, vh * 0.2)))
    const defaultPadding = Math.round(Math.min(320, Math.max(220, vh * 0.3)))

    if (sheetSnap === 'collapsed') return collapsedPadding
    return defaultPadding
  }, [appViewportHeight, sheetSnap])


  const resetSheetDragState = useCallback(() => {
    sheetDragRef.current = null
    const el = sheetRef.current
    if (el) {
      el.style.transition = ''
      el.style.maxHeight = ''
    }
    setIsDraggingSheet(false)
  }, [])

  const canStartSheetDrag = useCallback(
    (target: EventTarget | null) => {
      if (!isIdleState || !(target instanceof Element)) return false
      if (target.closest(SHEET_DRAG_HANDLE_SELECTOR)) return true
      if (!target.closest(SHEET_DRAG_SURFACE_SELECTOR)) return false
      if (target.closest(SHEET_DRAG_INTERACTIVE_SELECTOR)) return false
      return (scrollRef.current?.scrollTop ?? 0) <= 2
    },
    [isIdleState],
  )

  const handleSheetDragStart = useCallback(
    (clientY: number, target?: EventTarget | null) => {
      if (!isIdleState || sheetDragRef.current) return
      if (target !== undefined && !canStartSheetDrag(target)) return
      sheetDragRef.current = { startY: clientY, startSnap: sheetSnap, lastDelta: 0 }
      setIsDraggingSheet(true)
      const el = sheetRef.current
      if (el) el.style.transition = 'none'
    },
    [canStartSheetDrag, isIdleState, sheetSnap],
  )

  const handleSheetDragMove = useCallback(
    (clientY: number) => {
      const drag = sheetDragRef.current
      if (!drag) return
      const delta = clientY - drag.startY
      drag.lastDelta = delta
      const el = sheetRef.current
      if (!el) return
      const startH = sheetMaxHeights[drag.startSnap]
      // Dragging up (negative delta) = expand, dragging down (positive delta) = collapse
      const raw = startH - delta
      const clamped = Math.max(sheetMaxHeights.collapsed - 30, Math.min(raw, sheetMaxHeights.default + 30))
      el.style.maxHeight = `${clamped}px`
    },
    [sheetMaxHeights],
  )

  const handleSheetDragEnd = useCallback(() => {
    const drag = sheetDragRef.current
    if (!drag) return
    const delta = drag.lastDelta
    sheetDragRef.current = null
    const el = sheetRef.current
    if (el) {
      el.style.transition = 'max-height 280ms cubic-bezier(0.22, 1, 0.36, 1)'
      el.style.maxHeight = ''
    }

    if (drag.startSnap === 'default' && delta > 40) {
      setSheetSnap('collapsed')
    } else if (drag.startSnap === 'collapsed' && delta < -30) {
      setSheetSnap('default')
    }
    setIsDraggingSheet(false)
  }, [])

  const handleSheetTouchStart = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      const touch = event.touches[0]
      if (!touch) return
      handleSheetDragStart(touch.clientY, event.target)
    },
    [handleSheetDragStart],
  )

  const handleSheetTouchMove = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      if (!sheetDragRef.current) return
      if (event.cancelable) event.preventDefault()
      const touch = event.touches[0]
      if (!touch) return
      handleSheetDragMove(touch.clientY)
    },
    [handleSheetDragMove],
  )

  const handleSheetMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!canStartSheetDrag(event.target)) return
      event.preventDefault()
      handleSheetDragStart(event.clientY)
      const onMove = (moveEvent: MouseEvent) => handleSheetDragMove(moveEvent.clientY)
      const onUp = () => {
        handleSheetDragEnd()
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [canStartSheetDrag, handleSheetDragEnd, handleSheetDragMove, handleSheetDragStart],
  )

  useEffect(() => {
    if (isIdleState) return
    resetSheetDragState()
  }, [isIdleState, resetSheetDragState])

  useEffect(() => resetSheetDragState, [resetSheetDragState])

  const serviceKeys = SERVICE_I18N_KEYS[resolvedBookingService]
  const isSelectedServiceAvailable = checkServiceAvailable(resolvedBookingService)
  const isBabySitterMode = requestServiceType === 'baby_sitter'
  const currentRecentSubjectNames = isBabySitterMode ? recentBabysitterNames : recentDogNames
  const isFixedVisitBookingMode = isFixedVisitMode
  const selectedFixedVisitServiceLabel = t(serviceKeys.label)
  const bookingSubjectValue = isBabysitterRequest
    ? babysitterServiceDetails.trim()
    : isFixedVisitBookingMode
      ? selectedFixedVisitServiceLabel
      : effectiveDogBookingName
  const hasValidDurationForSelectedService = isBabysitterRequest
    ? !!babysitterDurationMinutes
    : isDogWalkerRequest
      ? !!dogWalkerDurationMinutes
      : isFixedVisitBookingMode
        ? true
        : !!flow.duration
  const currentBookingPriceILS = isBabysitterRequest
    ? babysitterFixedBudgetValue
    : isDogWalkerRequest
      ? applyDogCountPricing(dogWalkerBudgetValue, {
          serviceType: effectiveRequestServiceType,
          dogCount: normalizedDogCount,
        })
      : isFixedVisitBookingMode
        ? dogWalkerBudgetValue
        : flow.adjustedPriceILS
  const currentBudgetForGuidanceILS = isBabysitterRequest
    ? babysitterGuidanceBudgetValue
    : isDogWalkerRequest
      ? dogWalkerGuidanceBudgetValue
      : isFixedVisitBookingMode
        ? dogWalkerGuidanceBudgetValue
        : flow.adjustedPriceILS
  const currentBookingDurationMinutes = isBabysitterRequest
    ? babysitterDurationMinutes
    : isDogWalkerRequest
      ? dogWalkerDurationMinutes
      : isFixedVisitBookingMode
        ? null
      : flow.duration
        ? Math.round((flow.duration === '20min' ? 20 : flow.duration === '40min' ? 40 : 60))
        : null
  useEffect(() => {
    let cancelled = false

    async function loadProviderPricingPreferences() {
      const serviceType = effectiveRequestServiceType ?? null
      activeProviderPricingQueryKeyRef.current = providerPricingQueryKey
      if (!serviceType || nearbyProviderIdsForGuidance.length === 0) {
        if (!cancelled && providerPricingPreferencesSnapshotRef.current !== '[]') {
          providerPricingPreferencesSnapshotRef.current = '[]'
          setProviderPricingPreferences([])
        }
        return
      }

      const serviceTypeAliases = getGuidanceServiceTypeAliases(serviceType)
      const cachedRows = providerPricingPreferencesCacheRef.current.get(providerPricingQueryKey)
      if (cachedRows) {
        console.debug('[ClientDashboard] provider pricing preferences cache reused', {
          service_type: serviceType,
          booking_type: bookingTypeForGuidance,
          dog_count: normalizedDogCount,
          nearbyProviderCount: nearbyProviderIdsForGuidance.length,
          queryKey: providerPricingQueryKey,
        })
        const cachedSnapshot = serializeProviderPricingPreferenceRows(cachedRows)
        if (!cancelled && activeProviderPricingQueryKeyRef.current === providerPricingQueryKey) {
          if (providerPricingPreferencesSnapshotRef.current !== cachedSnapshot) {
            providerPricingPreferencesSnapshotRef.current = cachedSnapshot
            setProviderPricingPreferences(cachedRows)
          }
        }
        return
      }

      let request = providerPricingPreferencesInFlightRef.current.get(providerPricingQueryKey)
      if (!request) {
        request = (async () => {
          let query = supabase
            .from('provider_service_preferences')
            .select('provider_id, service_type, pricing_model, booking_type, is_enabled, hourly_rate_min, hourly_rate_preferred, visit_fee_min, visit_fee_preferred, accepts_multi_item, max_item_count')
            .in('provider_id', nearbyProviderIdsForGuidance)
            .eq('booking_type', bookingTypeForGuidance)

          if (serviceTypeAliases.length > 1) {
            query = query.in('service_type', serviceTypeAliases)
          } else {
            query = query.eq('service_type', serviceTypeAliases[0] ?? serviceType)
          }

          const { data, error } = await query
          if (error) throw error
          return (data as ProviderPricingPreferenceInput[] | null) ?? []
        })().finally(() => {
          providerPricingPreferencesInFlightRef.current.delete(providerPricingQueryKey)
        })
        providerPricingPreferencesInFlightRef.current.set(providerPricingQueryKey, request)
      } else {
        console.debug('[ClientDashboard] provider pricing preferences in-flight reused', {
          service_type: serviceType,
          booking_type: bookingTypeForGuidance,
          dog_count: normalizedDogCount,
          nearbyProviderCount: nearbyProviderIdsForGuidance.length,
          queryKey: providerPricingQueryKey,
        })
      }

      let nextRows: ProviderPricingPreferenceInput[] = []
      try {
        nextRows = await request
      } catch (error) {
        if (cancelled) return
        console.warn(
          '[ClientDashboard] provider pricing preferences unavailable:',
          error instanceof Error ? error.message : String(error),
        )
        if (activeProviderPricingQueryKeyRef.current === providerPricingQueryKey) {
          providerPricingPreferencesSnapshotRef.current = '[]'
          setProviderPricingPreferences([])
        }
        return
      }

      if (cancelled) return
      if (activeProviderPricingQueryKeyRef.current !== providerPricingQueryKey) {
        console.debug('[ClientDashboard] stale provider pricing preferences ignored', {
          service_type: serviceType,
          booking_type: bookingTypeForGuidance,
          dog_count: normalizedDogCount,
          nearbyProviderCount: nearbyProviderIdsForGuidance.length,
          queryKey: providerPricingQueryKey,
          activeQueryKey: activeProviderPricingQueryKeyRef.current,
        })
        return
      }

      providerPricingPreferencesCacheRef.current.set(providerPricingQueryKey, nextRows)
      console.debug('[ClientDashboard] provider pricing preferences fetched', {
        service_type: serviceType,
        service_type_aliases: serviceTypeAliases,
        booking_type: bookingTypeForGuidance,
        dog_count: normalizedDogCount,
        nearbyProviderCount: nearbyProviderIdsForGuidance.length,
        fetchedRowsCount: nextRows.length,
        providerPrefsUsed: nextRows.map((row) => ({
          provider_id: row.provider_id ?? null,
          service_type: row.service_type,
          pricing_model: row.pricing_model,
          booking_type: row.booking_type,
          hourly_rate_min: row.hourly_rate_min,
          hourly_rate_preferred: row.hourly_rate_preferred,
          visit_fee_min: row.visit_fee_min,
          visit_fee_preferred: row.visit_fee_preferred,
        })),
      })
      const nextSnapshot = serializeProviderPricingPreferenceRows(nextRows)
      if (providerPricingPreferencesSnapshotRef.current !== nextSnapshot) {
        providerPricingPreferencesSnapshotRef.current = nextSnapshot
        setProviderPricingPreferences(nextRows)
      }
    }

    void loadProviderPricingPreferences()

    return () => {
      cancelled = true
    }
  }, [
    bookingTypeForGuidance,
    effectiveRequestServiceType,
    nearbyProviderIdsForGuidance,
    nearbyProviderIdsForGuidanceKey,
    normalizedDogCount,
    providerPricingQueryKey,
  ])

  const budgetGuidance = useMemo(() => {
    const marketGuidance = getBudgetGuidanceFromProviderPreferences({
      serviceType: effectiveRequestServiceType ?? resolvedBookingService,
      bookingType: bookingTypeForGuidance,
      durationMinutes: currentBookingDurationMinutes,
      selectedPriceILS: currentBudgetForGuidanceILS,
      dogCount: normalizedDogCount,
      preferences: providerPricingPreferences,
    })

    if (marketGuidance) return marketGuidance

    return getBudgetGuidance({
      serviceType: effectiveRequestServiceType ?? resolvedBookingService,
      durationMinutes: currentBookingDurationMinutes,
      selectedPriceILS: currentBudgetForGuidanceILS,
      dogCount: normalizedDogCount,
    })
  }, [
    bookingTypeForGuidance,
    currentBookingDurationMinutes,
    currentBudgetForGuidanceILS,
    effectiveRequestServiceType,
    normalizedDogCount,
    providerPricingPreferences,
    resolvedBookingService,
  ])

  const budgetGuidanceDebugSnapshotRef = useRef<string>('')
  const budgetLikelihoodLabel = t(`booking.budgetLikelihood.${budgetGuidance.likelihood}` as never)
  const compactPaymentAuthorizationNotice = isRtl
    ? 'נאמת עכשיו · חיוב בסיום השירות!'
    : 'Verified now · Charged after service completion!'
  const shouldShowBudgetRetryHint = isDispatchExhausted || shouldShowNoProvidersEmptyState
  const budgetBelowMinimumHint =
    parseBudgetBelowMinimumError(flow.currentJob?.smart_dispatch_last_error) ??
    parseBudgetBelowMinimumError(flow.activeJob?.smart_dispatch_last_error)
  const isBudgetMinimumExhausted = !!budgetBelowMinimumHint
  const budgetGuidanceText = shouldShowBudgetRetryHint
    ? budgetBelowMinimumHint
      ? t('booking.budgetMinimumRetryHint', {
          min: budgetBelowMinimumHint.min,
          max: budgetBelowMinimumHint.max,
        })
      : t('booking.budgetRetryHint')
    : budgetGuidance.likelihood === 'low'
      ? t('booking.budgetLowAvailabilityHint')
      : !budgetGuidance.fallback
        ? (isFixedVisitBookingMode || budgetGuidance.pricingModel === 'fixed_visit')
          ? t('booking.budgetTypicalVisitFee', {
              min: budgetGuidance.suggestedLow,
              max: budgetGuidance.suggestedHigh,
            })
          : t('booking.budgetTypicalRange', {
              min: budgetGuidance.suggestedLow,
              max: budgetGuidance.suggestedHigh,
            })
        : null
  const fixedVisitCompactGuidanceText = t('booking.fixedVisit.compactGuidance', {
    min: budgetGuidance.suggestedLow,
    max: budgetGuidance.suggestedHigh,
  })
  const matchingEmptyTitle = isDispatchExhausted
    ? isBudgetMinimumExhausted
      ? t('booking.budgetMinimumEmptyTitle')
      : currentRequestPricingModel === 'fixed_visit'
        ? t('booking.noProvidersForService')
        : t('booking.noProvidersAvailable')
    : shouldShowNoProvidersEmptyState
      ? currentRequestPricingModel === 'fixed_visit'
        ? t('booking.noProvidersForService')
        : t('booking.noProvidersAvailable')
      : flow.availabilityNotice?.title ||
        (currentRequestPricingModel === 'fixed_visit'
          ? t('booking.noProvidersForService')
          : t('booking.noProvidersAvailable'))
  const matchingEmptySubtitle = isDispatchExhausted
    ? isBudgetMinimumExhausted && budgetBelowMinimumHint
      ? t('booking.budgetMinimumEmptySubtitle', {
          min: budgetBelowMinimumHint.min,
          max: budgetBelowMinimumHint.max,
        })
      : t('booking.providersBusyRetryLater')
    : shouldShowNoProvidersEmptyState
      ? t('booking.tryAgainSoon')
      : flow.error || t('booking.tryAgainSoon')

  useEffect(() => {
    const debugSnapshot = JSON.stringify({
      service_type: effectiveRequestServiceType ?? resolvedBookingService,
      booking_type: bookingTypeForGuidance,
      duration_minutes: currentBookingDurationMinutes,
      dogCount: normalizedDogCount,
      nearbyProviderCount: nearbyProviderIdsForGuidance.length,
      fetchedProviderRowsCount: providerPricingPreferences.length,
      selectedBudget: currentBudgetForGuidanceILS,
      aggregatedMinimumHourly: budgetGuidance.aggregatedMinHourly,
      aggregatedPreferredHourly: budgetGuidance.aggregatedPreferredHourly,
      recommendedMin: budgetGuidance.recommendedMin,
      recommendedGood: budgetGuidance.recommendedGood,
      pricingModel: budgetGuidance.pricingModel,
      coveredProviderCount: budgetGuidance.coveredProviderCount,
      eligibleProviderCount: budgetGuidance.eligibleProviderCount,
      coverageRatio: budgetGuidance.coverageRatio,
      likelihood: budgetGuidance.likelihood,
      fallbackUsed: budgetGuidance.fallback,
    })

    if (debugSnapshot === budgetGuidanceDebugSnapshotRef.current) return
    budgetGuidanceDebugSnapshotRef.current = debugSnapshot

    console.debug('[ClientDashboard] budget guidance', {
      service_type: effectiveRequestServiceType ?? resolvedBookingService,
      booking_type: bookingTypeForGuidance,
      duration_minutes: currentBookingDurationMinutes,
      dogCount: normalizedDogCount,
      nearbyProviderCount: nearbyProviderIdsForGuidance.length,
      fetchedProviderRowsCount: providerPricingPreferences.length,
      providerPrefsUsed: providerPricingPreferences.map((row) => ({
        provider_id: row.provider_id ?? null,
        service_type: row.service_type,
        pricing_model: row.pricing_model,
        booking_type: row.booking_type,
        hourly_rate_min: row.hourly_rate_min,
        hourly_rate_preferred: row.hourly_rate_preferred,
        visit_fee_min: row.visit_fee_min,
        visit_fee_preferred: row.visit_fee_preferred,
      })),
      selectedBudget: currentBudgetForGuidanceILS,
      aggregatedMinimumHourly: budgetGuidance.aggregatedMinHourly,
      aggregatedPreferredHourly: budgetGuidance.aggregatedPreferredHourly,
      calculatedRecommendedMinBudget: budgetGuidance.recommendedMin,
      calculatedRecommendedPreferredBudget: budgetGuidance.recommendedGood,
      recommendedMin: budgetGuidance.recommendedMin,
      recommendedGood: budgetGuidance.recommendedGood,
      pricingModel: budgetGuidance.pricingModel,
      coveredProviderCount: budgetGuidance.coveredProviderCount,
      eligibleProviderCount: budgetGuidance.eligibleProviderCount,
      coverageRatio: budgetGuidance.coverageRatio,
      likelihood: budgetGuidance.likelihood,
      fallbackUsed: budgetGuidance.fallback,
    })
  }, [
    bookingTypeForGuidance,
    budgetGuidance.aggregatedMinHourly,
    budgetGuidance.aggregatedPreferredHourly,
    budgetGuidance.fallback,
    budgetGuidance.likelihood,
    budgetGuidance.pricingModel,
    budgetGuidance.recommendedGood,
    budgetGuidance.recommendedMin,
    budgetGuidance.coverageRatio,
    budgetGuidance.coveredProviderCount,
    budgetGuidance.eligibleProviderCount,
    currentBookingDurationMinutes,
    currentBudgetForGuidanceILS,
    effectiveRequestServiceType,
    nearbyProviderIdsForGuidance.length,
    normalizedDogCount,
    providerPricingPreferences,
    resolvedBookingService,
  ])
  const hasValidPriceForSelectedService = Number.isFinite(currentBookingPriceILS) && currentBookingPriceILS > 0
  const requiresScheduledFor = flow.bookingTiming === 'scheduled'
  const repeatScheduleSource = clampScheduledDraft(scheduleDraft, getNowPlus15LocalInput())
  const repeatScheduleParts = splitScheduledDraft(repeatScheduleSource)
  const effectiveRepeatDays = repeatType === 'weekly'
    ? normalizeRepeatDays(
        repeatDays.length > 0
          ? repeatDays
          : [parseLocalDateTime(repeatScheduleSource)?.getDay() ?? new Date().getDay()],
      )
    : []
  const repeatWeekdaysLabel = useMemo(
    () =>
      normalizeRepeatDays(repeatDays)
        .map((day) =>
          new Intl.DateTimeFormat(isRtl ? 'he-IL' : 'en-US', { weekday: 'short' }).format(
            new Date(Date.UTC(2024, 0, 7 + day)),
          ),
        )
        .join(', '),
    [isRtl, repeatDays],
  )
  const repeatScheduleSummary = useMemo(() => {
    if (!repeatWeekdaysLabel) {
      return isRtl ? 'בחרו ימים ושעה קבועה' : 'Choose weekdays and a recurring time'
    }
    return isRtl
      ? `כל ${repeatWeekdaysLabel} בשעה ${repeatStartTime}`
      : `Every ${repeatWeekdaysLabel} at ${repeatStartTime}`
  }, [isRtl, repeatStartTime, repeatWeekdaysLabel])
  const canSubmitBooking =
    isSelectedServiceAvailable &&
    !!bookingSubjectValue &&
    !!flow.location.trim() &&
    hasValidDurationForSelectedService &&
    hasValidPriceForSelectedService &&
    !!flow.savedCard &&
    (!requiresScheduledFor || !!flow.scheduledFor)
  const canSubmitRecurringBooking =
    !isFixedVisitBookingMode &&
    isSelectedServiceAvailable &&
    !!bookingSubjectValue &&
    !!flow.location.trim() &&
    hasValidDurationForSelectedService &&
    hasValidPriceForSelectedService &&
    !!flow.savedCard &&
    !!repeatScheduleParts.date &&
    !!repeatScheduleParts.time &&
    effectiveRepeatDays.length > 0

  useEffect(() => {
    if (!showSchedulePage || scheduleMode !== 'later') return
    console.log('[schedule-sheet] selected time changed', {
      selectedScheduledFor,
      bookingTiming: flow.bookingTiming,
      activeTab: scheduleMode,
      timestamp: Date.now(),
    })
    clearScheduleConflictWarning('selected_time_changed')
  }, [clearScheduleConflictWarning, flow.bookingTiming, scheduleMode, selectedScheduledFor, showSchedulePage])

  useEffect(() => {
    if (!showSchedulePage || scheduleMode !== 'later' || !profile.id) {
      clearScheduleConflictWarning('validation_inactive')
      return
    }

    if (flow.bookingTiming !== 'scheduled') {
      clearScheduleConflictWarning('not_scheduled_mode')
      return
    }

    const parsed = parseLocalDateTime(selectedScheduledFor)
    const occurrenceIso = parsed ? parsed.toISOString() : null
    if (!occurrenceIso) {
      clearScheduleConflictWarning('invalid_selected_time')
      return
    }

    let cancelled = false
    const timeoutId = window.setTimeout(async () => {
      if (bookingTimingRef.current !== 'scheduled') {
        clearScheduleConflictWarning('not_scheduled_mode')
        return
      }

      console.log('[schedule-sheet] conflict validation start', {
        selectedScheduledFor,
        bookingTiming: bookingTimingRef.current,
        activeTab: scheduleMode,
        timestamp: Date.now(),
      })

      const { data, error } = await supabase.rpc('find_client_booking_overlaps', {
        p_client_id: profile.id,
        p_scheduled_for: occurrenceIso,
        p_window_minutes: 60,
      })

      if (cancelled) return
      if (bookingTimingRef.current !== 'scheduled') {
        console.log('[schedule-sheet] conflict validation result', {
          selectedScheduledFor,
          bookingTiming: bookingTimingRef.current,
          activeTab: scheduleMode,
          hasConflict: false,
          ignored: true,
          timestamp: Date.now(),
        })
        clearScheduleConflictWarning('not_scheduled_mode')
        return
      }

      if (error) {
        console.warn('[ClientDashboard] overlap warning query failed', error)
        clearScheduleConflictWarning('validation_error')
        return
      }

      const nextWarning =
        Array.isArray(data) && data.length > 0
          ? (isRtl ? 'כבר קיימת אצלך הזמנה סביב השעה הזאת' : 'You already have a booking around this time')
          : null

      console.log('[schedule-sheet] conflict validation result', {
        selectedScheduledFor,
        bookingTiming: bookingTimingRef.current,
        activeTab: scheduleMode,
        hasConflict: !!nextWarning,
        timestamp: Date.now(),
      })

      if (nextWarning === null) {
        clearScheduleConflictWarning('validation_ok')
        return
      }

      scheduleOverlapWarningRef.current = nextWarning
      setScheduleOverlapWarning((current) => (current === nextWarning ? current : nextWarning))
    }, 180)

    return () => {
      cancelled = true
      window.clearTimeout(timeoutId)
    }
  }, [
    clearScheduleConflictWarning,
    isRtl,
    profile.id,
    scheduleMode,
    selectedScheduledFor,
    showSchedulePage,
  ])
  const bookingBlockedReasons = useMemo(() => {
    const reasons: string[] = []
    if (!isSelectedServiceAvailable) reasons.push('selected_service_unavailable')
    if (!bookingSubjectValue) reasons.push('missing_service_name')
    if (!flow.location.trim()) reasons.push('missing_location')
    if (!hasValidDurationForSelectedService && !isFixedVisitBookingMode) reasons.push('missing_duration')
    if (!hasValidPriceForSelectedService) reasons.push('missing_price')
    if (!flow.savedCard) reasons.push('missing_saved_card')
    if (requiresScheduledFor && !flow.scheduledFor) reasons.push('missing_scheduled_for')
    if (repeatType === 'weekly' && effectiveRepeatDays.length === 0) reasons.push('missing_repeat_days')
    return reasons
  }, [
    bookingSubjectValue,
    effectiveRepeatDays.length,
    flow.location,
    flow.savedCard,
    flow.scheduledFor,
    hasValidDurationForSelectedService,
    hasValidPriceForSelectedService,
    isFixedVisitBookingMode,
    isSelectedServiceAvailable,
    requiresScheduledFor,
    repeatType,
  ])
  const lastBookingCanSubmitLogRef = useRef<string>('')

  useEffect(() => {
    const snapshot = JSON.stringify({
      canSubmitBooking,
      bookingBlockedReasons,
      bookingTiming: flow.bookingTiming,
      scheduledFor: flow.scheduledFor,
      requestServiceType: effectiveRequestServiceType,
    })
    if (snapshot === lastBookingCanSubmitLogRef.current) return
    lastBookingCanSubmitLogRef.current = snapshot
    console.log('[ClientDashboard] booking canSubmit changed', {
      canSubmitBooking,
      bookingBlockedReasons,
      bookingTiming: flow.bookingTiming,
      scheduledFor: flow.scheduledFor,
      requestServiceType: effectiveRequestServiceType,
    })
  }, [
    bookingBlockedReasons,
    canSubmitBooking,
    effectiveRequestServiceType,
    flow.bookingTiming,
    flow.scheduledFor,
  ])

  useEffect(() => {
    if (!flow.bookingComposerResetKey) return
    const shouldClearPricing =
      flow.bookingComposerResetReason === 'request_created_asap' ||
      flow.bookingComposerResetReason === 'request_created_scheduled' ||
      flow.bookingComposerResetReason === 'completion'

    setBabysitterDurationHours(String(BABYSITTER_DEFAULT_DURATION_HOURS))
    setBabysitterBudgetFixed(shouldClearPricing ? '0' : String(BABYSITTER_DEFAULT_FIXED_BUDGET_ILS))
    setDogWalkerDurationHours(String(DOG_WALKER_DEFAULT_DURATION_HOURS))
    setDogWalkerBudgetFixed(shouldClearPricing ? '0' : String(DOG_WALKER_DEFAULT_BUDGET_ILS))
    setFixedVisitIssueDescription('')
    if (shouldClearPricing) {
      mergeClientBookingBudgetDraft(profile.id, {
        babysitterBudgetFixed: '0',
        dogWalkerBudgetFixed: '0',
      })
    }
    const nextDraft = clampScheduledDraft(getNowPlus15LocalInput(), getNowPlus15LocalInput())
    setScheduleDraft(nextDraft)
    setRepeatStartTime(splitScheduledDraft(nextDraft).time)
    setMatchingUiState(null)
    console.log('[ClientDashboard] booking composer reset applied', {
      bookingComposerResetKey: flow.bookingComposerResetKey,
      bookingComposerResetReason: flow.bookingComposerResetReason,
      pricingCleared: shouldClearPricing,
      requestServiceType: effectiveRequestServiceType,
    })
    if (shouldClearPricing && flow.bookingComposerResetReason === 'completion') {
      console.debug('[ClientDashboard] budget reset after completion', {
        babysitterBudgetFixed: 0,
        dogWalkerBudgetFixed: 0,
        requestServiceType: effectiveRequestServiceType,
      })
    }
  }, [effectiveRequestServiceType, flow.bookingComposerResetKey, flow.bookingComposerResetReason, profile.id, resolvedBookingService])
  const bookingSubjectLabel = isBabySitterMode
    ? isRtl ? 'שם מקבל השירות' : 'Service recipient name'
    : t(serviceKeys.inputLabel)
  const bookingSubjectPlaceholder = isBabySitterMode
    ? isRtl ? 'הוסף שם מקבל שירות' : 'Add recipient name'
    : t(serviceKeys.inputLabel)
  const bookingSubjectSheetTitle = isBabySitterMode
    ? isRtl ? '👶 נמענים' : '👶 Recipients'
    : isRtl ? '🐾 הכלבים שלי' : '🐾 My Dogs'
  const bookingSubjectSheetSubtitle = isBabySitterMode
    ? isRtl
      ? 'בחרו נמען קיים או הוסיפו חדש.'
      : 'Choose a saved recipient or add a new one.'
    : isRtl
      ? 'בחרו כלבים שממשיכים להזמנה או הוסיפו כלב חדש.'
      : 'Choose dogs for this booking or add a new one.'
  const bookingSubjectInputLabel = isBabySitterMode
    ? (isRtl ? 'שם הנמען' : 'Recipient name')
    : (isRtl ? 'שם הכלב' : 'Dog name')
  const bookingSubjectInputPlaceholder = isBabySitterMode
    ? isRtl ? 'לדוגמה: נועה, גיל 4' : 'For example: Maya, age 4'
    : t('dogNameSheet.typePlaceholder')
  const dogSizeSectionLabel = isRtl ? 'גודל הכלב' : 'Dog size'
  const existingDogsLabel = isRtl ? 'הכלבים שלי' : 'My dogs'
  const recentSubjectsLabel = isRtl ? 'אחרונים' : 'Recent'
  const addRecipientLabel = isBabySitterMode
    ? (isRtl ? '+ הוסף נמען' : '+ Add recipient')
    : (isRtl ? '+ הוסף כלב' : '+ Add dog')
  const canSaveDogNameSheet = isBabySitterMode
    ? !!normalizeDogName(dogNameDraft)
    : (!!normalizeDogName(dogNameDraft) && !!dogSizeDraft) || selectedDogPetIds.length > 0
  const showBookingSubjectSuggestions = true
  const shouldShowBookingSubjectCaption = false
  const dogSelectorBlock = (
    <div style={{ ...compactFieldStyle, ...(isBabySitterMode ? babysitterServiceFieldWrapStyle : null) }}>
      <button
        type="button"
        onClick={() => {
          if (Date.now() < suppressDogNameOpenUntilRef.current) return
          openDogNameSheet()
        }}
        style={{
          ...dogInputButtonStyle,
          ...(isDogNameGuided ? guidedFieldButtonStyle : null),
          ...(isDogNameGuided && shouldAnimateGuidedField ? guidedFieldAnimationStyle : null),
        }}
        >
          <div
          style={{
            ...dogInputShellStyle,
            ...(isBabySitterMode ? dogInputShellCompactStyle : null),
            ...(isDogNameGuided ? guidedFieldShellStyle : null),
          }}
        >
          <div style={{ ...dogThumbStyle, ...(isBabySitterMode ? dogThumbCompactStyle : null) }}>
            {SERVICE_ICONS[resolvedBookingService]}
          </div>
          <div style={dogInputButtonContentStyle}>
            {shouldShowBookingSubjectCaption && (
              <div style={compactFieldLabelMutedStyle}>{bookingSubjectLabel}</div>
            )}
            <div
              style={
                compactBookingSubjectDisplayValue
                  ? dogInputValueTextStyle
                  : dogInputPlaceholderTextStyle
              }
            >
              <span>{compactBookingSubjectDisplayValue || bookingSubjectPlaceholder}</span>
            </div>
          </div>
          <div style={dogInputChevronStyle}>›</div>
        </div>
      </button>
      {isDogNameGuided && (
        <div style={guidedFieldHelperStyle}>Start here</div>
      )}
    </div>
  )

  const pickupSelectorBlock = (
    <div style={{ ...compactFieldStyle, ...(isBabySitterMode ? babysitterAddressFieldWrapStyle : dogWalkerAddressFieldWrapStyle) }}>
      <div
        style={{
          ...pickupSelectorShellStyle,
          ...(isBabySitterMode ? pickupSelectorShellCompactStyle : null),
        }}
        onClick={openAddressPicker}
        data-control="address-row"
      >
        <span style={pickupSelectorInlineIconStyle} aria-hidden="true">
          📍
        </span>
        <span
          style={
            flow.location.trim()
              ? {
                  ...pickupSelectorValueStyle,
                  ...(isBabySitterMode ? pickupSelectorValueCompactStyle : null),
                }
              : {
                  ...pickupSelectorPlaceholderStyle,
                  ...(isBabySitterMode ? pickupSelectorValueCompactStyle : null),
                }
          }
        >
          {flow.locationLoading
            ? t('booking.findingLocation')
            : flow.location.trim() || t('booking.pickupLocation')}
        </span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </div>
    </div>
  )

  const fixedVisitDescriptionBlock = isFixedVisitBookingMode ? (
    <div style={fixedVisitSectionStyle}>
      <input
        type="text"
        value={fixedVisitIssueDescription}
        onChange={(event) => setFixedVisitIssueDescription(event.target.value)}
        placeholder={t('booking.fixedVisit.issueDescriptionPlaceholder')}
        style={fixedVisitTextareaStyle}
      />
    </div>
  ) : null

  const mapCalloutItems = useMemo(() => {
    const items: Array<{ key: 'pickup' | 'eta'; icon: string; label: string; value: string }> = []

    const etaValue = formatEta(flow.etaMinutes, flow.displayEtaSeconds, flow.isArrived)
    if (etaValue !== '—' && !isIdleState) {
      items.push({
        key: 'eta',
        icon: '⏱',
        label: isRtl ? 'הגעה' : 'ETA',
        value: etaValue,
      })
    }

    return items
  }, [flow.displayEtaSeconds, flow.etaMinutes, flow.isArrived, isIdleState, isRtl])

  const repeatSelectorBlock = (
    <div style={repeatSectionStyle}>
      <div style={repeatHeaderRowStyle}>
        <span style={repeatLabelStyle}>{isRtl ? 'הזמנה חוזרת' : 'Recurring booking'}</span>
        <span style={repeatSummaryStyle}>{repeatScheduleSummary}</span>
      </div>
      <div style={repeatExpandedStyle}>
        <div style={repeatWeekdayRowStyle}>
          {REPEAT_WEEKDAY_ORDER.map((day) => {
            const selected = effectiveRepeatDays.includes(day)
            const label = new Intl.DateTimeFormat(isRtl ? 'he-IL' : 'en-US', { weekday: 'short' }).format(
              new Date(Date.UTC(2024, 0, 7 + day)),
            )
            return (
              <button
                key={day}
                type="button"
                onClick={() => toggleRepeatDay(day)}
                style={{
                  ...repeatDayChipStyle,
                  ...(selected ? repeatDayChipActiveStyle : null),
                }}
              >
                {label}
              </button>
            )
          })}
        </div>
        <div style={repeatTimeInlineWrapStyle}>
          <div style={repeatWheelHeaderRowStyle}>
            <div style={scheduleWheelHeaderLabelStyle}>{isRtl ? 'שעה' : 'Hour'}</div>
            <div style={scheduleWheelHeaderLabelStyle}>{isRtl ? 'דקות' : 'Minute'}</div>
          </div>
          <div style={scheduleWheelWrapStyle}>
            <div style={scheduleWheelHighlightStyle} />
            <div style={repeatWheelColumnsStyle}>
              <WheelPickerColumn
                options={hourWheelOptions}
                value={repeatStartTime.slice(0, 2)}
                onChange={(nextHour) => {
                  const nextTime = `${nextHour}:${repeatStartTime.slice(3, 5)}`
                  setRepeatStartTime(nextTime)
                  updateScheduledDraftFromWheel(
                    repeatScheduleParts.date,
                    nextHour,
                    repeatStartTime.slice(3, 5),
                  )
                }}
                variant="schedule"
              />
              <WheelPickerColumn
                options={minuteWheelOptions}
                value={repeatStartTime.slice(3, 5)}
                onChange={(nextMinute) => {
                  const nextTime = `${repeatStartTime.slice(0, 2)}:${nextMinute}`
                  setRepeatStartTime(nextTime)
                  updateScheduledDraftFromWheel(
                    repeatScheduleParts.date,
                    repeatStartTime.slice(0, 2),
                    nextMinute,
                  )
                }}
                variant="schedule"
              />
            </div>
          </div>
          <div style={repeatTimeInlineSummaryStyle}>
            {repeatScheduleSummary}
          </div>
        </div>
      </div>
    </div>
  )

  const durationPickerBlock = (
    <div style={{ ...compactFieldStyle, ...dogWalkerPlannerFieldWrapStyle }}>
      {isDurationGuided && (
        <div style={guidedFieldHintAboveStyle}>{t('booking.chooseDuration')}</div>
      )}
      <div style={dogWalkerPlannerCardStyle}>
        <div style={dogWalkerDurationOnlyRowStyle}>
          <div style={dogWalkerFieldGroupStyle}>
            <label style={dogWalkerPlannerLabelStyle}>{isRtl ? 'משך (ש׳)' : 'Duration (H)'}</label>
            <div
              style={{
                ...babysitterDurationStepperStyle,
                ...(isDurationGuided ? durationGuidedFieldShellStyle : null),
                ...(isDurationGuided && shouldAnimateGuidedField ? guidedFieldAnimationStyle : null),
              }}
            >
              <div style={babysitterDurationValueStyle}>
                {formatHoursValue(dogWalkerDurationValue)}
              </div>
              <div style={babysitterDurationStepperButtonsStyle}>
                <button
                  type="button"
                  onClick={() => handleDogWalkerDurationStep('up')}
                  style={babysitterStepButtonStyle}
                  aria-label={isRtl ? 'הגדל משך' : 'Increase duration'}
                >
                  ▲
                </button>
                <button
                  type="button"
                  onClick={() => handleDogWalkerDurationStep('down')}
                  style={babysitterStepButtonStyle}
                  aria-label={isRtl ? 'הקטן משך' : 'Decrease duration'}
                >
                  ▼
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )

  const babysitterPlannerBlock = (
    <div style={{ ...compactFieldStyle, ...(isBabySitterMode ? babysitterPlannerFieldWrapStyle : null) }}>
      <div style={babysitterPlannerCardStyle}>
        <div style={dogWalkerDurationOnlyRowStyle}>
          <div style={babysitterFieldGroupStyle}>
            <label style={babysitterFieldLabelStyle}>{isRtl ? 'משך (ש׳)' : 'Duration (H)'}</label>
            <div style={babysitterDurationStepperStyle}>
              <div style={babysitterDurationValueStyle}>{formatHoursValue(babysitterDurationValue)}</div>
              <div style={babysitterDurationStepperButtonsStyle}>
                <button
                  type="button"
                  onClick={() => handleBabysitterDurationStep('up')}
                  style={babysitterStepButtonStyle}
                  aria-label={isRtl ? 'הגדל משך' : 'Increase duration'}
                >
                  ▲
                </button>
                <button
                  type="button"
                  onClick={() => handleBabysitterDurationStep('down')}
                  style={babysitterStepButtonStyle}
                  aria-label={isRtl ? 'הקטן משך' : 'Decrease duration'}
                >
                  ▼
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )

  const activeBudgetValue = isBabySitterMode ? babysitterFixedBudgetValue : dogWalkerBudgetValue
  const activeBudgetMin = isBabySitterMode ? BABYSITTER_BUDGET_MIN_ILS : DOG_WALKER_BUDGET_MIN_ILS
  const activeBudgetMax = isBabySitterMode ? BABYSITTER_BUDGET_MAX_ILS : DOG_WALKER_BUDGET_MAX_ILS
  const activeBudgetStep = isBabySitterMode ? BABYSITTER_BUDGET_STEP_ILS : DOG_WALKER_BUDGET_STEP_ILS
  const activeDurationValue = isBabySitterMode ? babysitterDurationValue : dogWalkerDurationValue
  const activeDurationGuidedStyle = !isBabySitterMode && isDurationGuided ? durationGuidedFieldShellStyle : null
  const activeDurationAnimationStyle =
    !isBabySitterMode && isDurationGuided && shouldAnimateGuidedField ? guidedFieldAnimationStyle : null
  const handleActiveBudgetChange = (nextValue: number) => {
    if (isBabySitterMode) {
      handleBabysitterFixedBudgetChange(nextValue)
      return
    }
    setDogWalkerBudgetFixed(String(nextValue))
  }
  const handleActiveDurationStep = (direction: 'up' | 'down') => {
    if (isBabySitterMode) {
      handleBabysitterDurationStep(direction)
      return
    }
    handleDogWalkerDurationStep(direction)
  }
  const guidanceChipToneStyle =
    budgetGuidance.likelihood === 'high'
      ? budgetGuidanceChipHighStyle
      : budgetGuidance.likelihood === 'medium'
        ? budgetGuidanceChipMediumStyle
        : budgetGuidanceChipLowStyle
  const budgetSliderSemanticColor =
    budgetGuidance.likelihood === 'high'
      ? '#10B981'
      : budgetGuidance.likelihood === 'medium'
        ? '#2563EB'
        : '#F59E0B'
  const activeBudgetRange = Math.max(activeBudgetMax - activeBudgetMin, 1)
  const activeBudgetFillPercent = Math.min(
    100,
    Math.max(0, ((activeBudgetValue - activeBudgetMin) / activeBudgetRange) * 100),
  )
  const activeBudgetSliderStyle: React.CSSProperties = {
    ...unifiedBudgetSliderStyle,
    accentColor: budgetSliderSemanticColor,
    background: `linear-gradient(to right, ${budgetSliderSemanticColor} 0%, ${budgetSliderSemanticColor} ${activeBudgetFillPercent}%, #E2E8F0 ${activeBudgetFillPercent}%, #E2E8F0 100%)`,
  }

  const compactSavedCardSummary =
    flow.activePaymentMethod && !flow.setupClientSecret ? (
      <button
        type="button"
        data-control="payment-row"
        onClick={() => {
          markFirstInteractionHandler('client-dashboard:open-payment-row')
          setPaymentSheetOpen(true)
          markFirstInteractionVisual('client-dashboard:open-payment-row')
        }}
        style={compactSavedCardRowStyle}
      >
        <div style={compactSavedCardMainStyle}>
          <span style={compactSavedCardBrandStyle}>
            {getPaymentMethodLabel(flow.activePaymentMethod).replace(/\s+(\d{4})$/, ' •••• $1')}
          </span>
          <span style={compactPaymentMethodIconWrapStyle} aria-hidden="true">
            {flow.activePaymentMethod.type === 'apple_pay' ? (
              <span style={compactPaymentMethodApplePayStyle}></span>
            ) : (
              <CreditCard size={12} color="#2563EB" style={{ flexShrink: 0, opacity: 0.9 }} />
            )}
          </span>
        </div>
      </button>
    ) : null
  const missingPaymentMethodTitle = flow.cardLoading
    ? (isRtl ? 'טוען אמצעי תשלום...' : 'Loading payment method...')
    : flow.cardError && !flow.savedCard
      ? (isRtl ? 'נסה שוב להוסיף אמצעי תשלום' : 'Try adding a payment method again')
      : (isRtl ? 'הוסף אמצעי תשלום' : 'Add payment method')
  const missingPaymentMethodSubtitle = flow.cardLoading
    ? (isRtl ? 'נא להמתין רגע' : 'Please wait a moment')
    : flow.cardError && !flow.savedCard
      ? (isRtl ? 'לא הצלחנו לטעון את פרטי התשלום. הקש כדי לנסות שוב.' : 'We could not load payment details. Tap to try again.')
      : (isRtl ? 'הוסף כרטיס כדי להמשיך' : 'Add card to continue')

  const sharedPricingRows = (
    <div style={dogWalkerPricingStackStyle}>
      <div style={dogWalkerDurationSliderRowStyle}>
        <div style={dogWalkerDurationInlineStyle}>
          <div style={pricingMetaRowStyle}>
            <label style={dogWalkerPlannerLabelStyle}>{isRtl ? 'משך (ש׳)' : 'Duration (H)'}</label>
          </div>
          <div
            style={{
              ...babysitterDurationStepperStyle,
              ...(activeDurationGuidedStyle ?? null),
              ...(activeDurationAnimationStyle ?? null),
            }}
          >
            <div style={babysitterDurationValueStyle}>
              {formatHoursValue(activeDurationValue)}
            </div>
            <div style={babysitterDurationStepperButtonsStyle}>
              <button
                type="button"
                onClick={() => handleActiveDurationStep('up')}
                style={babysitterStepButtonStyle}
                aria-label={isRtl ? 'הגדל משך' : 'Increase duration'}
              >
                ▲
              </button>
              <button
                type="button"
                onClick={() => handleActiveDurationStep('down')}
                style={babysitterStepButtonStyle}
                aria-label={isRtl ? 'הקטן משך' : 'Decrease duration'}
              >
                ▼
              </button>
            </div>
          </div>
        </div>
        <div style={dogWalkerSliderInlineStyle}>
          <input
            type="range"
            min={activeBudgetMin}
            max={activeBudgetMax}
            step={activeBudgetStep}
            value={activeBudgetValue}
            onChange={(e) => handleActiveBudgetChange(Number(e.target.value))}
            style={activeBudgetSliderStyle}
            aria-label={isRtl ? 'תקציב' : 'Budget'}
          />
          <div style={unifiedBudgetScaleRowStyle}>
            <span style={unifiedBudgetScaleLabelStyle}>₪0</span>
            <span style={unifiedBudgetScaleValueStyle}>₪{activeBudgetValue}</span>
          </div>
        </div>
      </div>
      <div style={budgetGuidanceInlineRowStyle}>
        <span
          style={{
            ...budgetGuidanceChipStyle,
            ...guidanceChipToneStyle,
          }}
        >
          {budgetLikelihoodLabel}
        </span>
        {budgetGuidanceText && <span style={budgetGuidanceInlineTextStyle}>{budgetGuidanceText}</span>}
      </div>
    </div>
  )

  const fixedVisitPricingRows = (
    <div style={dogWalkerPricingStackStyle}>
      <div style={pricingMetaRowStyle}>
        <span style={dogWalkerPlannerLabelStyle}>{isRtl ? 'מחיר' : 'Price'}</span>
      </div>
      <div style={fixedVisitSliderWrapStyle}>
        <div style={dogWalkerSliderOnlyRowStyle}>
          <input
            type="range"
            min={activeBudgetMin}
            max={activeBudgetMax}
            step={activeBudgetStep}
            value={activeBudgetValue}
            onChange={(e) => handleActiveBudgetChange(Number(e.target.value))}
            style={activeBudgetSliderStyle}
            aria-label={isRtl ? 'תקציב ביקור' : 'Visit fee'}
          />
        </div>
        <div style={unifiedBudgetScaleRowStyle}>
          <span style={unifiedBudgetScaleLabelStyle}>₪0</span>
          <span style={unifiedBudgetScaleValueStyle}>₪{activeBudgetValue}</span>
        </div>
      </div>
      <div style={fixedVisitGuidanceStackStyle}>
        <span
          style={{
            ...budgetGuidanceChipStyle,
            ...guidanceChipToneStyle,
          }}
        >
          {budgetLikelihoodLabel}
        </span>
        <span style={fixedVisitGuidanceTextStyle}>
          {shouldShowBudgetRetryHint ? budgetGuidanceText : fixedVisitCompactGuidanceText}
        </span>
      </div>
    </div>
  )

  const compactPaymentCardContent = compactSavedCardSummary ?? (
    <button
      type="button"
      data-control="payment-row"
      onClick={() => {
        markFirstInteractionHandler('client-dashboard:open-payment-row')
        if (flow.cardLoading) return
        if (flow.cardError && !flow.savedCard) {
          flow.retryLoadCard?.()
        }
        setPaymentSheetOpen(true)
        markFirstInteractionVisual('client-dashboard:open-payment-row')
      }}
      style={{
        ...compactSavedCardRowStyle,
        ...compactAddPaymentMethodCtaRowStyle,
      }}
      disabled={flow.cardLoading}
    >
      <div style={compactAddPaymentMethodCtaMainStyle}>
        <div style={compactAddPaymentMethodTextWrapStyle}>
          <span style={compactAddPaymentMethodTitleStyle}>{missingPaymentMethodTitle}</span>
          <span style={compactAddPaymentMethodSubtitleStyle}>{missingPaymentMethodSubtitle}</span>
        </div>
        <span style={compactPaymentMethodIconWrapStyle} aria-hidden="true">
          {flow.showApplePayInPaymentSheet && !flow.savedCard ? (
            <span style={compactPaymentMethodApplePayStyle}></span>
          ) : (
            <span style={compactAddPaymentMethodIconShellStyle}>
              <CreditCard size={16} color="#1D4ED8" style={{ flexShrink: 0 }} />
            </span>
          )}
        </span>
      </div>
    </button>
  )

  const unifiedPricingPaymentCard = (
    <div style={unifiedPricingPaymentCardInnerStyle}>
      {isFixedVisitBookingMode ? fixedVisitPricingRows : sharedPricingRows}
    </div>
  )

  return (
    <div className="regli-client-screen" style={screenStyle}>
      <div aria-hidden="true" style={dashboardBrandBackdropStyle}>
        <div style={dashboardBrandGlowTopStyle} />
        <div style={dashboardBrandGlowCenterStyle} />
        <div style={dashboardBrandGlowBottomStyle} />
        <div style={dashboardBrandDiagonalPrimaryStyle} />
        <div style={dashboardBrandDiagonalSecondaryStyle} />
        <div style={dashboardBrandDiagonalTertiaryStyle} />
        <div style={dashboardBrandRouteUpperStyle} />
        <div style={dashboardBrandRouteLowerStyle} />
        <div style={dashboardBrandDotsUpperLeftStyle} />
        <div style={dashboardBrandDotsTopStyle} />
        <div style={dashboardBrandDotsLowerRightStyle} />
        <div style={dashboardBrandDotsBottomStyle} />
      </div>
      {debugFlags().interactionDebug && (
        <div
          style={{
            position: 'fixed',
            top: 60,
            left: 8,
            zIndex: 99999,
            pointerEvents: 'auto',
          }}
        >
          <button
            type="button"
            onPointerDown={(e) => {
              const t = performance.now()
              console.log(`[perf] debug-btn pointerdown at ${Math.round(t)}ms`)
              const buttonEl = e.currentTarget as HTMLButtonElement | null
              if (buttonEl) {
                buttonEl.style.background = '#22C55E'
              }
            }}
            onClick={(e) => {
              const t = performance.now()
              console.log(`[perf] debug-btn click at ${Math.round(t)}ms`)
              const buttonEl = e.currentTarget as HTMLButtonElement | null
              if (buttonEl) {
                buttonEl.style.background = '#EF4444'
              }
              setTimeout(() => {
                if (buttonEl) {
                  buttonEl.style.background = '#3B82F6'
                }
              }, 400)
            }}
            style={{
              width: 48,
              height: 48,
              borderRadius: 12,
              border: '2px solid #1E40AF',
              background: '#3B82F6',
              color: '#FFF',
              fontSize: 10,
              fontWeight: 900,
              cursor: 'pointer',
              WebkitTapHighlightColor: 'transparent',
              touchAction: 'manipulation',
            }}
          >
            TAP
          </button>
        </div>
      )}
      <div style={topUiLayerStyle}>
        <div style={floatingTopBarStyle}>
          <div style={menuButtonWrapStyle}>
            <button
              type="button"
              data-control="menu-button"
              onClick={() => {
                markFirstInteractionHandler('client-dashboard:menu-button')
                setMenuPage('main')
                setBurgerOpen((v) => !v)
                markFirstInteractionVisual('client-dashboard:menu-button')
                void hapticLight()
              }}
              style={controlBtnStyle}
              aria-label={t('menu.menu')}
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
            {/* Old floating calendar icon removed — red dot moved to bottom CTA calendar */}
          </div>

          <div style={topRightGroupStyle}>
            <div style={bellWrapStyle}>
              <NotificationsBell />
            </div>
          </div>
        </div>

      </div>

      <div style={{ ...mapContainerBaseStyle, ...currentMapStyle }}>
        {mapMounted ? (
          <MapView
            userLocation={mapUserLocation}
            showUserMarker={true}
            isSearching={isSearching}
            nearbyWalkers={showNearbyWalkers ? nearbyWalkers : []}
            bottomViewportPadding={mapBottomViewportPadding}
            onRecenter={flow.refreshLocation}
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
        ) : (
          <div style={deferredMapPlaceholderStyle} />
        )}
        {mapCalloutItems.length > 0 ? (
          <div style={{ ...mapCalloutsWrapStyle, flexDirection: isRtl ? 'row-reverse' : 'row' }}>
            {mapCalloutItems.map((item) => (
              <div key={item.key} style={mapCalloutPillStyle}>
                <span style={mapCalloutIconStyle} aria-hidden="true">{item.icon}</span>
                <div style={mapCalloutTextWrapStyle}>
                  <span style={mapCalloutLabelStyle}>{item.label}</span>
                  <span style={mapCalloutValueStyle}>{item.value}</span>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {burgerOpen && (
        <>
          <div style={menuOverlayStyle} onClick={closeAll} />
          <div
            style={{
              ...menuPanelStyle,
              ...(isRtl ? menuPanelRtlStyle : menuPanelLtrStyle),
              animation: isRtl
                ? 'regliMenuSlideInRight 220ms cubic-bezier(0.22, 1, 0.36, 1)'
                : 'regliMenuSlideInLeft 220ms cubic-bezier(0.22, 1, 0.36, 1)',
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

            <div style={menuScrollAreaStyle}>
              <input
                ref={clientSettingsPhotoInputRef}
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) photo.uploadAvatar(file)
                  e.target.value = ''
                }}
              />
              {menuPage === 'history' ? (
                <BurgerSection title={t('menu.tripHistory')} subtitle={t('menu.allHistorySubtitle')}>
                  <GroupedHistory
                    items={allHistoryItems}
                    role="client"
                    compact
                    onBookAgain={handleBookAgain}
                    onSecondaryAction={(item) => {
                      const itemId = typeof item.id === 'string' ? item.id : String(item.id ?? '')
                      if (!itemId) return
                      void flow.reportHistoryIssue(itemId)
                    }}
                    secondaryActionLabel={t('completion.rejectCompletion')}
                    shouldShowSecondaryAction={(item) =>
                      item.status === 'completed' &&
                      item.payment_status === 'paid' &&
                      !isCompletionReviewRequired(
                        typeof item.notes === 'string' ? item.notes : null,
                      )
                    }
                    onHide={anyFlow.hideHistoryItem}
                    favoriteWalkerIds={flow.favoriteWalkerIds}
                    onToggleFavoriteWalker={flow.toggleFavoriteWalker}
                    emptyTitle={t('menu.noWalkHistory')}
                    emptySubtitle={t('menu.noWalkHistorySubtitle')}
                  />
                </BurgerSection>
              ) : menuPage === 'settings' ? (
                <div style={settingsPageContentStyle}>
                  <SettingsCollapsibleSection
                    title={t('common.language')}
                    open={settingsSectionsOpen.language}
                    onToggle={() => toggleSettingsSection('language')}
                  >
                    <div style={clientSettingsLanguageSelectorRowStyle}>
                      <button
                        type="button"
                        onClick={() => {
                          handleLanguageChange('he')
                        }}
                        style={{
                          ...clientSettingsLanguageButtonStyle,
                          ...(i18n.resolvedLanguage === 'he' ? clientSettingsLanguageButtonActiveStyle : null),
                        }}
                      >
                        עברית
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          handleLanguageChange('en')
                        }}
                        style={{
                          ...clientSettingsLanguageButtonStyle,
                          ...(i18n.resolvedLanguage === 'en' ? clientSettingsLanguageButtonActiveStyle : null),
                        }}
                      >
                        EN
                      </button>
                    </div>
                  </SettingsCollapsibleSection>

                  <SettingsCollapsibleSection
                    id="client-favorites-section"
                    title={t('menu.preferredWalkers')}
                    subtitle={t('menu.preferredWalkersSubtitle')}
                    open={settingsSectionsOpen.preferredProviders}
                    onToggle={() => toggleSettingsSection('preferredProviders')}
                  >
                    <FavoriteWalkerMenuList
                      favorites={flow.favoriteWalkers}
                      fallbackNames={flow.walkerNameById}
                      onToggleFavorite={flow.toggleFavoriteWalker}
                      onOpenProfile={openProviderProfile}
                    />
                  </SettingsCollapsibleSection>
                  <SettingsCollapsibleSection
                    title={isRtl ? 'משפטי' : 'Legal'}
                    subtitle={isRtl ? 'תנאי שימוש ופרטיות' : 'Terms and privacy'}
                    open={settingsSectionsOpen.legal}
                    onToggle={() => toggleSettingsSection('legal')}
                  >
                    <div style={settingsSectionBodyStyle}>
                      <MenuNavRow
                        icon="📄"
                        label={isRtl ? 'תנאי השימוש' : 'Terms of Service'}
                        onClick={() => setOpenLegalDocument('terms_of_service')}
                      />
                      <MenuNavRow
                        icon="🔒"
                        label={isRtl ? 'מדיניות הפרטיות' : 'Privacy Policy'}
                        onClick={() => setOpenLegalDocument('privacy_policy')}
                      />
                    </div>
                  </SettingsCollapsibleSection>
                  <SettingsCollapsibleSection
                    title={isRtl ? 'חשבון' : 'Account'}
                    subtitle={isRtl ? 'פעולות קבועות ורגישות' : 'Permanent account actions'}
                    open={settingsSectionsOpen.account}
                    onToggle={() => toggleSettingsSection('account')}
                  >
                    <div style={settingsSectionBodyStyle}>
                      <MenuNavRow
                        icon="🗑"
                        label={isRtl ? 'מחיקת חשבון' : 'Delete Account'}
                        destructive
                        onClick={() => {
                          setDeleteAccountError(null)
                          setDeleteAccountSuccess(false)
                          setDeleteAccountLoading(false)
                          setDeleteAccountOpen(true)
                        }}
                      />
                    </div>
                  </SettingsCollapsibleSection>
                  <div style={menuFooterActionWrapStyle}>
                    <MenuNavRow
                      icon="↪"
                      label={t('menu.signOut')}
                      destructive
                      onClick={() => {
                        closeAll()
                        void handleSignOut()
                      }}
                    />
                  </div>
                </div>
              ) : menuPage === 'futureOrders' ? (
                <BurgerSection
                  id="future-orders-section"
                  title={t('menu.futureOrders')}
                  subtitle={t('menu.futureOrdersSubtitle')}
                >
                  <div style={futureOrdersSectionsStyle}>
                    <div>
                      <div style={futureOrdersSectionLabelStyle}>{t('recurring.upcoming')}</div>
                      <BurgerUpcomingList
                        items={upcomingScheduledItems}
                        onCancel={flow.cancelScheduledJob}
                        limit={null}
                      />
                    </div>
                    <div>
                      <div style={futureOrdersSectionLabelStyle}>{t('recurring.recurring')}</div>
                      <BurgerRecurringList
                        items={recurringItems}
                        loading={recurringLoading}
                        onEdit={(item) => {
                          setRecurringEditDays(item.repeatDays)
                          setRecurringEditTime(normalizeTime24(item.startTime))
                          setEditingRecurringBooking(item)
                        }}
                        onCancel={(id) => void handleRecurringStatusUpdate(id, 'cancelled')}
                      />
                    </div>
                  </div>
                </BurgerSection>
              ) : (
                <>
                  <div style={menuProfileButtonStyle}>
                    <div style={{ position: 'relative', flexShrink: 0 }}>
                      <ProfileAvatar
                        url={photo.avatarUrl}
                        name={clientName}
                        size={48}
                        borderRadius={16}
                        onClick={() => clientSettingsPhotoInputRef.current?.click()}
                      />
                    </div>
                    <div style={menuProfileTextStyle}>
                      <div style={profileNameStyle}>{clientName}</div>
                      {profile.email && <div style={profileEmailStyle}>{profile.email}</div>}
                      {flow.avgRating !== null && (
                        <div style={profileRatingStyle}>
                          <span style={{ color: '#F59E0B' }}>★</span> {flow.avgRating} · {t('menu.reviewScore')}
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() => clientSettingsPhotoInputRef.current?.click()}
                        style={menuProfilePhotoButtonStyle}
                      >
                        {t('common.changePhoto')}
                      </button>
                      {photo.uploading && <div style={uploadStatusStyle}>{isRtl ? 'מעלה תמונה...' : 'Uploading photo...'}</div>}
                      {photo.error && <div style={uploadErrorStyle}>{photo.error}</div>}
                    </div>
                  </div>

                  <div style={menuRowListStyle}>
                    <MenuNavRow
                      icon="⚙️"
                      label={t('menu.settings')}
                      onClick={() => setMenuPage('settings')}
                    />
                    <MenuNavRow
                      icon="🕘"
                      label={t('menu.tripHistory')}
                      onClick={() => setMenuPage('history')}
                    />
                    <MenuNavRow
                      icon="📅"
                      label={t('menu.futureOrders')}
                      onClick={() => setMenuPage('futureOrders')}
                    />
                  </div>

                  <BurgerSection title={t('menu.latestTrips')} subtitle={t('menu.walkHistorySubtitle')}>
                    <GroupedHistory
                      items={menuHistoryPreviewItems}
                      role="client"
                      compact
                      onBookAgain={handleBookAgain}
                      onHide={anyFlow.hideHistoryItem}
                      favoriteWalkerIds={flow.favoriteWalkerIds}
                      onToggleFavoriteWalker={flow.toggleFavoriteWalker}
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

      {showSchedulePage && (
        <>
          <div style={menuOverlayStyle} onClick={closeScheduleSheet} />
          <div
            style={{
              ...scheduleSheetStyle,
              direction: isRtl ? 'rtl' : 'ltr',
              animation: 'regliScheduleSheetRise 240ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}
          >
            <div style={scheduleSheetHandleStyle} />
            <div style={scheduleSheetHeaderStyle}>
              <div style={scheduleSheetHeaderCopyStyle}>
                <div style={scheduleSheetTitleStyle}>
                  {isRtl ? 'קביעת הזמנה עתידית' : 'Schedule future order'}
                </div>
              </div>
              <button
                type="button"
                onClick={closeScheduleSheet}
                style={scheduleSheetCloseButtonStyle}
                aria-label={t('common.close')}
              >
                ˅
              </button>
            </div>

            <div style={scheduleSheetScrollStyle}>
              <div style={schedulePageContentStyle}>
                <div style={schedulePresetRowStyle}>
                  <button
                    type="button"
                    onClick={() => handleScheduleTabChange('later')}
                    style={{
                      ...schedulePresetButtonStyle,
                      ...(scheduleMode === 'later' ? schedulePresetButtonActiveStyle : null),
                    }}
                  >
                    {isRtl ? 'מאוחר יותר' : 'Later'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleScheduleTabChange('repeat')}
                    style={{
                      ...schedulePresetButtonStyle,
                      ...(scheduleMode === 'repeat' ? schedulePresetButtonActiveStyle : null),
                    }}
                  >
                    {isRtl ? 'הזמנה חוזרת' : 'Recurring'}
                  </button>
                </div>

                {scheduleMode === 'later' && (
                  <div style={scheduleModeBodyStyle}>
                    <div style={scheduleCompactCardStyle}>
                      <div style={scheduleSharedInnerCardStyle}>
                        <div style={scheduleLaterSummaryStyle}>
                          <div style={scheduleLaterSummaryValueStyle}>
                            {selectedScheduleDateLabel}
                          </div>
                          <div style={scheduleLaterSummaryHelperStyle}>
                            {isRtl
                              ? `בשעה ${scheduleDraftParts.time.slice(0, 2)}:${scheduleDraftParts.time.slice(3, 5)}`
                              : `at ${scheduleDraftParts.time.slice(0, 2)}:${scheduleDraftParts.time.slice(3, 5)}`}
                          </div>
                        </div>
                        <div style={scheduleWheelHeaderRowStyle}>
                          <div style={scheduleWheelHeaderLabelStyle}>{isRtl ? 'תאריך' : 'Date'}</div>
                          <div style={scheduleWheelHeaderLabelStyle}>{isRtl ? 'שעה' : 'Hour'}</div>
                          <div style={scheduleWheelHeaderLabelStyle}>{isRtl ? 'דקות' : 'Minute'}</div>
                        </div>
                        <div style={scheduleWheelWrapStyle}>
                          <div style={scheduleWheelHighlightStyle} />
                          <div style={scheduleWheelColumnsStyle}>
                            <WheelPickerColumn
                              options={dateWheelOptions}
                              value={scheduleDraftParts.date}
                              onChange={(nextDate) =>
                                updateScheduledDraftFromWheel(
                                  nextDate,
                                  scheduleDraftParts.time.slice(0, 2),
                                  scheduleDraftParts.time.slice(3, 5),
                                )
                              }
                              isWide
                              variant="schedule"
                            />
                            <WheelPickerColumn
                              options={hourWheelOptions}
                              value={scheduleDraftParts.time.slice(0, 2)}
                              onChange={(nextHour) =>
                                updateScheduledDraftFromWheel(
                                  scheduleDraftParts.date,
                                  nextHour,
                                  scheduleDraftParts.time.slice(3, 5),
                                )
                              }
                              variant="schedule"
                            />
                            <WheelPickerColumn
                              options={minuteWheelOptions}
                              value={scheduleDraftParts.time.slice(3, 5)}
                              onChange={(nextMinute) =>
                                updateScheduledDraftFromWheel(
                                  scheduleDraftParts.date,
                                  scheduleDraftParts.time.slice(0, 2),
                                  nextMinute,
                                )
                              }
                              variant="schedule"
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {scheduleMode === 'repeat' && (
                  <div style={scheduleModeBodyStyle}>
                    <div style={scheduleCompactCardStyle}>
                      {repeatSelectorBlock}
                    </div>
                  </div>
                )}

                {scheduleMode === 'later' && scheduleOverlapWarning && (
                  <div style={scheduleInlineWarningStyle}>{scheduleOverlapWarning}</div>
                )}
              </div>
            </div>

            <div style={scheduleSheetFooterStyle}>
              <div style={scheduleInlineCaptionStyle}>
                {isRtl ? 'החיפוש מתחיל 15 דקות לפני' : 'Search starts 15 min before'}
              </div>
              <ActionButton
                label={
                  scheduleMode === 'repeat'
                    ? t('recurring.createWeeklyBooking')
                    : (isRtl ? 'יצירת הזמנה עתידית' : 'Schedule future order')
                }
                disabled={
                  scheduleMode === 'repeat'
                    ? !canSubmitRecurringBooking
                    : !canSubmitBooking
                }
                onClick={() => {
                  const canSubmitCurrentMode = scheduleMode === 'repeat' ? canSubmitRecurringBooking : canSubmitBooking
                  if (!canSubmitCurrentMode) {
                    console.log('[ClientDashboard] schedule CTA blocked by validation', {
                      scheduleMode,
                      canSubmitCurrentMode,
                      canSubmitRecurringBooking,
                      canSubmitBooking,
                      bookingBlockedReasons,
                      requestServiceType: effectiveRequestServiceType,
                      scheduleDraft,
                    })
                    return
                  }
                  if (scheduleMode === 'repeat') {
                    setRepeatType('weekly')
                    void handleCreateRecurringBooking()
                    return
                  }
                  const nextValue = clampScheduledDraft(scheduleDraft, scheduleMinValue)
                  flow.setScheduledFor(nextValue)
                  setScheduleDraft(nextValue)
                  setRepeatType('one_time')
                  clearScheduleConflictWarning('scheduled_submit_success')
                  flow.setBookingTiming('scheduled')
                  setShowSchedulePage(false)
                  void hapticSuccess()
                }}
              />
              {scheduleMode === 'repeat' && recurringError && <div style={recurringInlineErrorStyle}>{recurringError}</div>}
              {scheduleMode === 'repeat' && recurringSuccess && <div style={recurringInlineSuccessStyle}>{recurringSuccess}</div>}
            </div>
          </div>
        </>
      )}

      {editingRecurringBooking && (
        <>
          <div style={menuOverlayStyle} onClick={() => setEditingRecurringBooking(null)} />
          <div style={recurringEditSheetStyle}>
            <div style={scheduleSheetHandleStyle} />
            <div style={scheduleSheetHeaderStyle}>
              <div style={scheduleSheetHeaderCopyStyle}>
                <div style={scheduleSheetTitleStyle}>{t('recurring.editSchedule')}</div>
                <div style={scheduleSheetSubtitleStyle}>{editingRecurringBooking.title}</div>
              </div>
              <button
                type="button"
                onClick={() => setEditingRecurringBooking(null)}
                style={scheduleSheetCloseButtonStyle}
                aria-label={t('common.close')}
              >
                ✕
              </button>
            </div>
            <div style={recurringEditContentStyle}>
              <div style={repeatWeekdayRowStyle}>
                {REPEAT_WEEKDAY_ORDER.map((day) => {
                  const selected = recurringEditDays.includes(day)
                  const label = new Intl.DateTimeFormat(isRtl ? 'he-IL' : 'en-US', { weekday: 'short' }).format(
                    new Date(Date.UTC(2024, 0, 7 + day)),
                  )
                  return (
                    <button
                      key={day}
                      type="button"
                      onClick={() =>
                        setRecurringEditDays((current) =>
                          current.includes(day)
                            ? normalizeRepeatDays(current.filter((value) => value !== day))
                            : normalizeRepeatDays([...current, day]),
                        )
                      }
                      style={{
                        ...repeatDayChipStyle,
                        ...(selected ? repeatDayChipActiveStyle : null),
                      }}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
              <div style={repeatTimeRowStyle}>
                <span style={repeatTimeLabelStyle}>{isRtl ? 'שעה' : 'Time'}</span>
                <button
                  type="button"
                  onClick={() => openRecurringTimePicker(recurringEditTime, 'edit')}
                  style={repeatTimeInputStyle}
                >
                  <span>{formatRecurringDisplayTime(recurringEditTime, isRtl ? 'he' : 'en')}</span>
                  <span style={repeatTimeChevronStyle}>›</span>
                </button>
              </div>
              <div style={recurringActionStackStyle}>
                <button type="button" onClick={() => void handleSaveRecurringEdit()} style={recurringPrimaryActionStyle}>
                  {t('recurring.saveChanges')}
                </button>
                <button
                  type="button"
                  onClick={() => void handleRecurringStatusUpdate(editingRecurringBooking.id, 'cancelled')}
                  style={recurringDangerWideActionStyle}
                >
                  {t('recurring.cancelSeries')}
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {timePickerTarget && (
        <>
          <div style={timePickerOverlayStyle} onClick={() => setTimePickerTarget(null)} />
          <div style={timePickerModalStyle}>
            <div style={timePickerHeaderStyle}>
              <div style={timePickerTitleStyle}>{isRtl ? 'בחירת שעה' : 'Select time'}</div>
              <div style={timePickerSubtitleStyle}>
                {timePickerTarget === 'edit'
                  ? (isRtl ? 'עדכון שעת ההזמנה החוזרת' : 'Update recurring booking time')
                  : (isRtl ? 'בחרו שעה להזמנה החוזרת' : 'Choose a time for this recurring booking')}
              </div>
            </div>
              <div style={timePickerWheelShellStyle}>
                <div style={timePickerWheelHighlightStyle} />
                <div style={timePickerWheelColumnsStyle}>
                  <WheelPickerColumn
                    options={timePickerHourOptions}
                  value={timePickerHour12}
                  onChange={setTimePickerHour12}
                />
                  <WheelPickerColumn
                    options={minuteWheelOptions}
                    value={timePickerMinute}
                    onChange={setTimePickerMinute}
                  />
                </div>
              </div>
            <div style={timePickerMeridiemRowStyle}>
              {(['AM', 'PM'] as const).map((value) => {
                const selected = timePickerMeridiem === value
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setTimePickerMeridiem(value)}
                    style={{
                      ...timePickerMeridiemButtonStyle,
                      ...(selected ? timePickerMeridiemButtonActiveStyle : null),
                    }}
                  >
                    {value}
                  </button>
                )
              })}
            </div>
            <div style={timePickerActionsStyle}>
              <button
                type="button"
                onClick={() => setTimePickerTarget(null)}
                style={timePickerSecondaryButtonStyle}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={handleRecurringTimePickerDone}
                style={timePickerPrimaryButtonStyle}
              >
                {isRtl ? 'סיום' : 'Done'}
              </button>
            </div>
          </div>
        </>
      )}

      <LegalDocumentModal
        documentType={openLegalDocument}
        isHebrew={isRtl}
        onClose={() => setOpenLegalDocument(null)}
      />

      <DeleteAccountModal
        open={deleteAccountOpen}
        isHebrew={isRtl}
        loading={deleteAccountLoading}
        error={deleteAccountError}
        success={deleteAccountSuccess}
        onCancel={() => {
          if (deleteAccountLoading) return
          setDeleteAccountOpen(false)
          setDeleteAccountError(null)
          setDeleteAccountSuccess(false)
        }}
        onConfirm={() => {
          void handleDeleteAccount()
        }}
      />

      <div
        ref={sheetRef}
        className="regli-client-dashboard-sheet"
        style={{
          ...currentSheetStyle,
          ...(isIdleState ? { maxHeight: `${sheetMaxHeights[sheetSnap]}px`, overflow: 'hidden' } : {}),
          transition: isDraggingSheet ? 'none' : 'max-height 280ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
        onTouchStart={handleSheetTouchStart}
        onTouchMove={handleSheetTouchMove}
        onTouchEnd={handleSheetDragEnd}
        onTouchCancel={resetSheetDragState}
        onMouseDown={handleSheetMouseDown}
      >
        {isIdleState ? (
          <div
            style={dragHandleZoneStyle}
            data-sheet-drag-handle="true"
            onClick={() => {
              if (isDraggingSheet) return
              if (isSheetCollapsed) setSheetSnap('default')
            }}
          >
            <div style={dragHandleBarStyle} />
          </div>
        ) : isTrackingState ? (
          <div style={{ ...sheetTopPadStyle, height: 8 }} />
        ) : null
        }

        <div ref={scrollRef} style={currentSheetScrollStyle}>
          {shouldRenderIdleSheet && (
            <div
              data-sheet-drag-surface="true"
              style={{
                ...idleSheetContentStyle,
              }}
            >
              <div data-sheet-drag-surface="true" style={bookingCardStyle}>
                {shouldShowProfileServicePicker && (
                  <div style={launchServicesSelectorWrapStyle}>
                    <ServiceSelectorPanel
                      selected={resolvedBookingService}
                      onSelect={handleSelectBookingService}
                      onMorePress={() => undefined}
                      services={availableBookingServices}
                    />
                  </div>
                )}

                {!isSelectedServiceAvailable ? (
                  <div style={comingSoonOverlayStyle}>
                    <span style={{ fontSize: 28 }}>
                      {SERVICE_ICONS[selectedService]}
                    </span>
                    <span style={comingSoonTextStyle}>{t('services.comingSoon')}</span>
                  </div>
                ) : (
                <>
                <div style={compactFormGridStyle}>
                  {isFixedVisitBookingMode ? (
                    <>
                      {fixedVisitDescriptionBlock}
                      {pickupSelectorBlock}
                    </>
                  ) : (
                    <>
                      {dogSelectorBlock}
                      {pickupSelectorBlock}
                    </>
                  )}

                  {!isSheetCollapsed && preferredWalkers.length > 0 && (
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

                  {isSelectedServiceAvailable && !isSheetCollapsed ? (
                    <div
                      style={{
                        ...compactPaymentWrapStyle,
                        ...(isPaymentGuided ? paymentGuidedFieldShellStyle : null),
                        ...(isPaymentGuided && shouldAnimateGuidedField ? guidedFieldAnimationStyle : null),
                      }}
                    >
                      {isPaymentGuided && (
                        <div style={guidedFieldHintAboveStyle}>{t('booking.addPaymentMethod')}</div>
                      )}
                      {unifiedPricingPaymentCard}
                    </div>
                  ) : (
                    <>
                      {isSelectedServiceAvailable && (isBabySitterMode ? babysitterPlannerBlock : durationPickerBlock)}
                    </>
                  )}
                </div>

                </>
                )}
              </div>
            </div>
          )}

          {shouldRenderSearchingSheet && (
            <div style={searchingSheetContentStyle}>
              <div style={clientBottomSheetShellStyle}>
                <SearchingSheet
                  searchStartedAt={flow.searchStartTime}
                  elapsedSeconds={flow.elapsedSeconds}
                  durationLabel={requestDurationLabel}
                  priceLabel={requestPriceLabel}
                  isFixedVisit={currentRequestPricingModel === 'fixed_visit'}
                  mode={isDispatchExhausted || shouldShowNoProvidersEmptyState ? 'empty' : 'matching'}
                  serviceType={flow.currentJob?.service_type ?? effectiveRequestServiceType ?? resolvedBookingService}
                  emptyTitle={matchingEmptyTitle}
                  emptySubtitle={matchingEmptySubtitle}
                  emptyPrimaryLabel={isBudgetMinimumExhausted ? t('booking.raiseBudget') : undefined}
                  emptySecondaryLabel={isBudgetMinimumExhausted ? t('booking.scheduleForLater') : undefined}
                  onCancel={
                    isDispatchExhausted || shouldShowNoProvidersEmptyState
                      ? handleMatchingTryAgain
                      : flow.cancelSearch
                  }
                  onTryAgain={handleMatchingTryAgain}
                  onSecondaryAction={isBudgetMinimumExhausted ? openScheduleSheet : undefined}
                />
              </div>
            </div>
          )}

          {(flow.screenState === 'tracking' || flow.screenState === 'active') && flow.activeJob && (
            <div style={sheetContentStyle}>
              <div style={clientBottomSheetShellStyle}>
                {activeJobHasProviderIssue ? (
                  <div style={providerIssueClientCardStyle}>
                    <div style={providerIssueClientBadgeStyle}>
                      {isRtl ? 'בהמתנה לבדיקת התמיכה' : 'Waiting for support review'}
                    </div>
                    <div style={providerIssueClientTitleStyle}>
                      {isRtl
                        ? 'הספק דיווח על בעיה'
                        : 'Provider reported an issue'}
                    </div>
                    <div style={providerIssueClientBodyStyle}>
                      {isRtl
                        ? 'הספק דיווח על בעיה. צוות התמיכה בודק את הבקשה לפני שהשירות יוכל להתחיל.'
                        : 'Provider reported an issue. Support is reviewing the request before the service can begin.'}
                    </div>
                  </div>
                ) : (
                  <TrackingCard
                    walkerName={
                      flow.activeJob.walker_id
                        ? flow.walkerNameById.get(flow.activeJob.walker_id) || t('common.provider')
                        : t('common.provider')
                    }
                    walkerAvatarUrl={providerHeroMeta.avatarUrl}
                    walkerRating={providerHeroMeta.rating}
                    completedCount={providerHeroMeta.completedCount}
                    walkerBio={truncateCodePoints(providerHeroMeta.shortBio, 56)}
                    whatsappAvailable={!!activeProviderWhatsAppPhone}
                    onOpenProfile={
                      flow.activeJob?.walker_id
                        ? () => openProviderProfile(
                            flow.activeJob?.walker_id as string,
                            flow.walkerNameById.get(flow.activeJob?.walker_id as string) || t('common.provider'),
                            flow.activeJob?.service_type ?? null,
                          )
                        : undefined
                    }
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
                    activeTitle={t('tracking.walkInProgress')}
                    isFixedVisit={activeRequestPricingModel === 'fixed_visit'}
                    fixedVisitPriceLabel={activeRequestPricingModel === 'fixed_visit' ? activeRequestPriceLabel : null}
                    onWhatsApp={handleWhatsAppProvider}
                    onConfirmArrival={flow.screenPhase === 'arrived_pending_confirmation' ? flow.confirmArrival : undefined}
                    confirmingArrival={flow.arrivalConfirming}
                    elapsedLabel={localizeMinuteUnitLabel(trackingDurationSummary.elapsedLabel)}
                    plannedLabel={localizeMinuteUnitLabel(trackingDurationSummary.plannedLabel)}
                    actualLabel={localizeMinuteUnitLabel(trackingDurationSummary.actualLabel)}
                  />
                )}
              </div>
            </div>
          )}

        </div>

        {shouldRenderIdleSheet && !isSheetCollapsed && (
          <div
            style={{
              ...stickyCtaWrapStyle,
              ...(isBabySitterMode ? stickyCtaWrapBabysitterStyle : stickyCtaWrapDogWalkerStyle),
            }}
          >
            <div style={stickyActionZoneStyle}>
              <div style={unifiedPaymentRowWrapStyle}>{compactPaymentCardContent}</div>
              {shouldShowGuidanceCtaHelper && (
                <div style={guidedCtaHelperStyle}>{t('booking.completeHighlightedField')}</div>
              )}
              <div
                style={{
                  ...stickyActionRowStyle,
                  flexDirection: isRtl ? 'row-reverse' : 'row',
                }}
              >
                <div style={stickyMainActionStyle}>
                  <button
                    type="button"
                    onClick={handleFindWalker}
                    disabled={!canSubmitBooking || flow.loading || (flow.cardLoading && !flow.savedCard)}
                    style={{
                      ...bookingPrimaryButtonStyle,
                      ...(!canSubmitBooking ? bookingPrimaryButtonDisabledStyle : null),
                      ...(flow.loading || (flow.cardLoading && !flow.savedCard) ? bookingPrimaryButtonLoadingStyle : null),
                    }}
                  >
                    {flow.loading || (flow.cardLoading && !flow.savedCard) ? (
                      <>
                        <span style={bookingPrimarySpinnerStyle} />
                        {flow.loading
                          ? flow.bookingTiming === 'scheduled'
                            ? t('booking.scheduling')
                            : t('booking.ordering')
                          : t('booking.loadingPayment')}
                      </>
                    ) : (
                      t('booking.orderNow')
                    )}
                  </button>
                  <div style={stickyPaymentNoticeStyle}>
                    <span style={paymentInfoIconStyle} aria-hidden="true">i</span>
                    <span>{compactPaymentAuthorizationNotice}</span>
                  </div>
                  {!flow.location.trim() && !flow.locationLoading ? (
                    <div
                      onClick={openAddressPicker}
                      style={{
                        marginTop: 10,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '10px 12px',
                        borderRadius: 16,
                        background: 'rgba(255,255,255,0.96)',
                        border: '1px solid rgba(59,130,246,0.25)',
                        color: '#1E40AF',
                        fontSize: 13,
                        lineHeight: 1.45,
                        cursor: 'pointer',
                      }}
                    >
                      <span>📍</span>
                      <span>{t('booking.addPickupToContinue')}</span>
                    </div>
                  ) : null}
                </div>
                <button
                  type="button"
                  data-control="calendar-button"
                  disabled={!canSubmitBooking}
                  onClick={() => {
                    if (!canSubmitBooking) {
                      console.log('[ClientDashboard] schedule entry CTA blocked by shared validation', {
                        canSubmitBooking,
                        bookingBlockedReasons,
                        requestServiceType: effectiveRequestServiceType,
                        currentBookingPriceILS,
                      })
                      return
                    }
                    markFirstInteractionHandler('client-dashboard:calendar-button')
                    openScheduleSheet()
                  }}
                  style={{
                    ...stickyCalendarButtonStyle,
                    ...(flow.bookingTiming === 'scheduled' || hasFutureOrders || showSchedulePage ? stickyCalendarButtonActiveStyle : null),
                    ...(!canSubmitBooking ? stickyCalendarButtonDisabledStyle : null),
                    position: 'relative' as const,
                  }}
                  aria-label={t('booking.schedule')}
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.9"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect x="3.5" y="5" width="17" height="15.5" rx="3" />
                    <line x1="8" y1="3.75" x2="8" y2="7.25" />
                    <line x1="16" y1="3.75" x2="16" y2="7.25" />
                    <line x1="3.5" y1="9" x2="20.5" y2="9" />
                  </svg>
                  {hasFutureOrders && (
                    <span style={stickyCalendarDotStyle} aria-hidden="true" />
                  )}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {flow.pendingCompletionConfirmation && (
        <div style={completionOverlayStyle}>
          <div style={completionOverlayBackdropStyle} />
          <div style={completionOverlayCardStyle}>
            <div style={pendingConfirmCardStyle}>
              <div style={pendingConfirmIconStyle}>⏳</div>
              <div style={pendingConfirmTitleStyle}>
                {t('completion.pendingTitle')}
              </div>
              <div style={pendingConfirmSubtitleStyle}>
                {t('completion.pendingSubtitle', { name: flow.pendingCompletionConfirmation.walkerName })}
              </div>
              {flow.completionConfirmError && (
                <div style={pendingConfirmErrorStyle}>
                  {flow.completionConfirmError}
                </div>
              )}
              <button
                type="button"
                onClick={() => void flow.confirmCompletion()}
                disabled={flow.completionConfirming}
                aria-busy={flow.completionConfirming}
                style={{
                  ...pendingConfirmBtnStyle,
                  opacity: flow.completionConfirming ? 0.72 : 1,
                  cursor: flow.completionConfirming ? 'wait' : 'pointer',
                }}
              >
                {flow.completionConfirming
                  ? t('completion.confirming')
                  : t('completion.confirmCompletion')}
              </button>
              <button
                type="button"
                onClick={() => void flow.rejectCompletion()}
                disabled={flow.completionConfirming}
                style={{
                  ...pendingRejectBtnStyle,
                  opacity: flow.completionConfirming ? 0.72 : 1,
                  cursor: flow.completionConfirming ? 'wait' : 'pointer',
                }}
              >
                {t('completion.rejectCompletion')}
              </button>
            </div>
          </div>
        </div>
      )}

      {!flow.pendingCompletionConfirmation && flow.completionReviewJob && (
        <div style={completionOverlayStyle}>
          <div style={completionOverlayBackdropStyle} />
          <div style={completionOverlayCardStyle}>
            <div style={pendingConfirmCardStyle}>
              <div style={pendingConfirmIconStyle}>⚠️</div>
              <div style={pendingConfirmTitleStyle}>{t('completion.issueReported')}</div>
              <div style={pendingConfirmSubtitleStyle}>{t('completion.reviewPendingSubtitle')}</div>
              <button
                type="button"
                onClick={flow.dismissCompletionReview}
                style={pendingConfirmBtnStyle}
              >
                {t('completion.closeReviewNotice')}
              </button>
            </div>
          </div>
        </div>
      )}

      {hasCompletionPrompt && flow.completionJob && (
        <div style={completionOverlayStyle}>
          <div style={completionOverlayBackdropStyle} />
          <div style={completionOverlayCardStyle}>
            <CompletionCard
              promptKey={flow.completionJob.jobId}
              title={t('completion.completed')}
              subtitle={t('completion.rateProvider', { name: flow.completionJob.walkerName })}
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
              onDismiss={handleDismissCompletionCard}
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
                ? t('firstBooking.checkingPaymentSetup')
                : hasSavedPaymentMethod
                  ? t('firstBooking.readyToBook')
                  : t('firstBooking.almostReady')}
            </div>

            <div style={firstBookingWowBodyStyle}>
              {flow.cardLoading
                ? t('firstBooking.thisOnlyTakesMoment')
                : hasSavedPaymentMethod
                  ? t('firstBooking.addServiceDetails')
                  : t('firstBooking.addPaymentBeforeFirstBooking')}
            </div>

            {!flow.cardLoading && !hasSavedPaymentMethod && (
              <div style={firstBookingWowHelperStyle}>
                {t('firstBooking.chargeAfterCompleted')}
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
                ? t('firstBooking.checking')
                : hasSavedPaymentMethod
                  ? t('firstBooking.startBooking')
                  : t('firstBooking.addPaymentMethod')}
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
              <div style={dogNameSheetTitleStyle}>{bookingSubjectSheetTitle}</div>
              <div style={dogNameSheetSubtitleStyle}>
                {bookingSubjectSheetSubtitle}
              </div>
            </div>

            {!isBabySitterMode && activeDogPets.length > 0 && (
              <div style={recipientSectionStyle}>
                <div style={recipientSectionLabelStyle}>{existingDogsLabel}</div>
                <div style={dogNameSuggestionsWrapStyle}>
                  {activeDogPets.map((pet) => {
                    const isSelected = selectedDogPetIds.includes(pet.id)
                    return (
                      <div key={pet.id} style={dogNameChipWrapStyle}>
                        <button
                          type="button"
                          onClick={() => {
                            toggleDogSelection(pet)
                          }}
                          style={{
                            ...dogNameChipStyle,
                            ...(isSelected ? dogNameChipActiveStyle : null),
                          }}
                        >
                          <span>{formatDogDisplayLabel(pet.normalizedName, pet.dog_size, { includeEmoji: true, isHebrew: isRtl })}</span>
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            void deleteClientDog(pet)
                          }}
                          style={dogNameChipDeleteStyle}
                          disabled={dogNameSheetSaving}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {isBabySitterMode && (
              <div style={recipientSectionStyle}>
                <div style={recipientSectionLabelStyle}>{bookingSubjectSheetTitle}</div>
                {currentRecentSubjectNames.length > 0 ? (
                  <div style={dogNameSuggestionsWrapStyle}>
                    {currentRecentSubjectNames.map((name) => {
                      const isSelected = normalizeDogName(babysitterServiceDetails) === normalizeDogName(name)
                      return (
                        <div key={name} style={dogNameChipWrapStyle}>
                          <button
                            type="button"
                            onClick={() => {
                              setDogNameDraft(name)
                              setRecipientEditorOpen(true)
                              setDogSizeDraft(null)
                              setDogNameSheetError(null)
                            }}
                            style={{
                              ...dogNameChipStyle,
                              ...(isSelected ? dogNameChipActiveStyle : null),
                            }}
                          >
                            <span>👶</span>
                            <span>{name}</span>
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              deleteRecentBookingSubject(name, 'baby_sitter')
                            }}
                            style={dogNameChipDeleteStyle}
                            disabled={dogNameSheetSaving}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                              <line x1="18" y1="6" x2="6" y2="18" />
                              <line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                          </button>
                        </div>
                      )
                    })}
                  </div>
                ) : null}
              </div>
            )}

            <div style={recipientSectionStyle}>
              {!recipientEditorOpen ? (
                <button
                  type="button"
                  onClick={() => {
                    setRecipientEditorOpen(true)
                    setDogNameSheetError(null)
                  }}
                  style={recipientExpandButtonStyle}
                >
                  {addRecipientLabel}
                </button>
              ) : (
                <div style={recipientInlineEditorStyle}>
                  <div style={recipientSectionLabelStyle}>{bookingSubjectInputLabel}</div>
                  <input
                    value={dogNameDraft}
                    onChange={(e) => {
                      setDogNameDraft(e.target.value)
                      setDogNameSheetError(null)
                    }}
                    placeholder={bookingSubjectInputPlaceholder}
                    style={dogNameSheetInputStyle}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        void submitDogNameSheet()
                      }
                    }}
                  />

                  {!isBabySitterMode && (
                    <div style={recipientInlineEditorStyle}>
                      <div style={recipientSectionLabelStyle}>{dogSizeSectionLabel}</div>
                      <div style={dogSizeSelectorStyle}>
                        {DOG_SIZE_OPTIONS.map((size) => {
                          const selected = dogSizeDraft === size
                          return (
                            <button
                              key={size}
                              type="button"
                              onClick={() => {
                                setDogSizeDraft(size)
                                setDogNameSheetError(null)
                              }}
                              style={{
                                ...dogSizeOptionStyle,
                                ...(selected ? dogSizeOptionActiveStyle : null),
                              }}
                              aria-pressed={selected}
                            >
                              {getDogSizeLabel(size, isRtl)}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )}

                </div>
              )}
            </div>

            {!isBabySitterMode && showBookingSubjectSuggestions && !!currentRecentSubjectNames.length && (
              <div style={recipientSectionStyle}>
                <div style={recipientSectionLabelMutedStyle}>{recentSubjectsLabel}</div>
                <div style={dogNameSuggestionsWrapStyle}>
                  {currentRecentSubjectNames.map((name) => {
                    const matchingPet = findDogPetByName(name)
                    const isSelected = !!matchingPet && selectedDogPetIds.includes(matchingPet.id)
                    return (
                      <button
                        key={name}
                        type="button"
                        onClick={() => {
                          if (matchingPet) {
                            toggleDogSelection(matchingPet)
                            return
                          }
                          setDogNameDraft(name)
                          setRecipientEditorOpen(true)
                          setDogSizeDraft(null)
                          setDogNameSheetError(null)
                        }}
                        style={{
                          ...dogNameChipStyle,
                          ...dogNameChipMutedStyle,
                          ...(isSelected ? dogNameChipActiveStyle : null),
                        }}
                      >
                        <span>🐶</span>
                        <span>
                          {formatDogDisplayLabel(name, matchingPet?.dog_size ?? null, { isHebrew: isRtl })}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {dogNameSheetError ? (
              <div style={dogNameSheetErrorStyle}>{dogNameSheetError}</div>
            ) : null}

            <div style={dogNameSheetActionsStyle}>
              <button
                type="button"
                onClick={closeDogNameSheet}
                style={dogNameSecondaryBtnStyle}
                disabled={dogNameSheetSaving}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={() => {
                  void submitDogNameSheet()
                }}
                style={dogNamePrimaryBtnStyle}
                disabled={!canSaveDogNameSheet || dogNameSheetSaving}
              >
                {dogNameSheetSaving ? (isRtl ? 'שומר...' : 'Saving...') : t('common.save')}
              </button>
            </div>
          </div>
        </>
      )}

      {paymentSheetOpen && (
        <>
          <div
            style={paymentSheetOverlayStyle}
            onClick={() => {
              setPaymentSheetOpen(false)
              if (flow.setupClientSecret) flow.cancelCardSetup()
            }}
          />
          <div style={paymentSheetStyle}>
            <div style={paymentSheetHeaderStyle}>
              <span style={paymentSheetTitleStyle}>{t('paymentMethods.title')}</span>
              <button
                type="button"
                onClick={() => {
                  setPaymentSheetOpen(false)
                  if (flow.setupClientSecret) flow.cancelCardSetup()
                }}
                style={paymentSheetCloseStyle}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            <div style={paymentSheetTrustRowStyle}>
              <span style={paymentSheetInfoIconStyle} aria-hidden="true">i</span>
              <span style={paymentSheetTrustTextStyle}>{t('paymentMethods.securityMessage')}</span>
            </div>
            <div style={paymentSheetTrustBodyStyle}>{compactPaymentAuthorizationNotice}</div>

            {flow.setupClientSecret ? (
              <div style={paymentSheetSetupWrapStyle}>
                <CardSetupForm
                  savedCard={flow.savedCard}
                  setupClientSecret={flow.setupClientSecret}
                  loadingCard={flow.cardLoading}
                  loadError={flow.cardError}
                  onRequestSetup={flow.requestCardSetup}
                  onChangeCard={flow.changeCard}
                  onSetupComplete={() => {
                    setPaymentSheetOpen(false)
                    flow.onCardSetupComplete()
                  }}
                  onCancelSetup={flow.cancelCardSetup}
                  onRetry={flow.retryLoadCard}
                />
              </div>
            ) : (
              <div style={paymentSheetActionsStyle}>
                {flow.savedCards.length > 0 ? (
                  <div style={paymentSheetCardsListStyle}>
                    {flow.savedCards.map((card) => {
                      const selected =
                        flow.selectedPaymentMethodType === 'saved_card' &&
                        flow.savedCard?.id === card.id
                      return (
                        <div
                          key={card.id}
                          style={{
                            ...paymentSheetCardOptionStyle,
                            ...(selected ? paymentSheetCardOptionSelectedStyle : null),
                          }}
                        >
                          <button
                            type="button"
                            // TODO(payment-methods): extend this row action surface later with more card-management options if needed.
                            onClick={() => {
                              flow.selectSavedCard(card.id)
                              setPaymentSheetOpen(false)
                            }}
                            style={paymentSheetCardSelectButtonStyle}
                          >
                            <div style={paymentSheetCardLeftStyle}>
                              <div style={paymentSheetRadioWrapStyle}>
                                <span
                                  style={{
                                    ...paymentSheetRadioStyle,
                                    ...(selected ? paymentSheetRadioSelectedStyle : null),
                                  }}
                                />
                              </div>
                              <CreditCard size={20} color={selected ? '#2563EB' : '#64748B'} />
                              <div>
                                <div style={paymentSheetCardBrandStyle}>
                                  {capitalize(card.brand)} •••• {card.last4}
                                </div>
                                {(card.expMonth != null && card.expYear != null) && (
                                  <div style={paymentSheetCardExpStyle}>
                                    {pad(card.expMonth)}/{String(card.expYear).slice(-2)}
                                  </div>
                                )}
                              </div>
                            </div>
                            {selected && (
                              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2563EB" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            )}
                          </button>
                          <button
                            type="button"
                            aria-label="Card actions"
                            onClick={(event) => {
                              event.stopPropagation()
                              setPaymentDeleteConfirmCardId(null)
                              setPaymentActionsCardId((current) => current === card.id ? null : card.id)
                            }}
                            style={paymentSheetCardMoreButtonStyle}
                          >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                              <circle cx="12" cy="5" r="1.8" />
                              <circle cx="12" cy="12" r="1.8" />
                              <circle cx="12" cy="19" r="1.8" />
                            </svg>
                          </button>
                        </div>
                      )
                    })}
                  </div>
                ) : null}

                {flow.showApplePayInPaymentSheet ? (
                  <div style={paymentSheetCardsListStyle}>
                    <button
                      type="button"
                      onClick={() => {
                        flow.selectApplePay()
                        setPaymentSheetOpen(false)
                      }}
                      style={paymentSheetCardSelectButtonStyle}
                    >
                      <div style={paymentSheetCardLeftStyle}>
                        <div style={paymentSheetRadioWrapStyle}>
                          <span
                            style={{
                              ...paymentSheetRadioStyle,
                              ...(flow.selectedPaymentMethodType === 'apple_pay'
                                ? paymentSheetRadioSelectedStyle
                                : null),
                            }}
                          />
                        </div>
                        <div style={{
                          fontSize: 18,
                          lineHeight: 1,
                          color: flow.selectedPaymentMethodType === 'apple_pay' ? '#111827' : '#64748B',
                          fontWeight: 700,
                          width: 20,
                          textAlign: 'center',
                          flexShrink: 0,
                        }}></div>
                        <div>
                          <div style={paymentSheetCardBrandStyle}>Apple Pay</div>
                          <div style={paymentSheetCardExpStyle}>Available on this device</div>
                        </div>
                      </div>
                      {flow.selectedPaymentMethodType === 'apple_pay' && (
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2563EB" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </button>
                  </div>
                ) : null}

                <div style={paymentSheetDividerStyle} />

                <button
                  type="button"
                  onClick={() => {
                    flow.requestCardSetup()
                  }}
                  style={paymentSheetAddRowStyle}
                >
                  <span style={paymentSheetAddIconStyle}>+</span>
                  <div style={paymentSheetAddContentStyle}>
                    <span>{t('paymentMethods.addCard')}</span>
                    <div style={paymentSheetBrandHintsStyle}>
                      <span style={paymentSheetBrandHintPillStyle}>Visa</span>
                      <span style={paymentSheetBrandHintPillStyle}>Mastercard</span>
                      <span style={paymentSheetBrandHintPillStyle}>Amex</span>
                    </div>
                  </div>
                </button>
              </div>
            )}
          </div>

          {paymentActionCard && !flow.setupClientSecret && (
            <>
              <div style={paymentActionsOverlayStyle} onClick={closePaymentActionMenus} />
              <div style={paymentActionsMenuStyle}>
                {!flow.savedCard || flow.savedCard.id !== paymentActionCard.id ? (
                  <button
                    type="button"
                    style={paymentActionsMenuButtonStyle}
                    onClick={() => {
                      flow.selectSavedCard(paymentActionCard.id)
                      closePaymentActionMenus()
                    }}
                  >
                    Set as default
                  </button>
                ) : null}
                <button
                  type="button"
                  style={{ ...paymentActionsMenuButtonStyle, ...paymentActionsMenuDangerStyle }}
                  onClick={() => {
                    setPaymentDeleteConfirmCardId(paymentActionCard.id)
                    setPaymentActionsCardId(null)
                  }}
                >
                  Delete card
                </button>
                <button
                  type="button"
                  style={paymentActionsMenuButtonStyle}
                  onClick={closePaymentActionMenus}
                >
                  Cancel
                </button>
              </div>
            </>
          )}

          {paymentDeleteConfirmCard && !flow.setupClientSecret && (
            <>
              <div style={paymentActionsOverlayStyle} onClick={closePaymentActionMenus} />
              <div style={paymentActionsMenuStyle}>
                <div style={paymentDeleteConfirmTextStyle}>
                  Delete {capitalize(paymentDeleteConfirmCard.brand)} •••• {paymentDeleteConfirmCard.last4}?
                </div>
                <button
                  type="button"
                  style={{ ...paymentActionsMenuButtonStyle, ...paymentActionsMenuDangerStyle }}
                  onClick={() => { void handleDeletePaymentMethod() }}
                  disabled={paymentActionLoading}
                >
                  {paymentActionLoading ? 'Deleting...' : 'Delete card'}
                </button>
                <button
                  type="button"
                  style={paymentActionsMenuButtonStyle}
                  onClick={closePaymentActionMenus}
                  disabled={paymentActionLoading}
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </>
      )}

      {providerProfileSheet && (
        <>
          <div
            style={providerProfileOverlayStyle}
            onClick={() => {
              setProviderProfileSheet(null)
              setProviderProfileError(null)
            }}
          />
          <div style={providerProfileSheetStyle}>
            {providerProfileLoading && !providerProfileData ? (
              <div style={providerProfileStateCardStyle}>{t('providerPublicProfile.loading')}</div>
            ) : providerProfileError && !providerProfileData ? (
              <div style={providerProfileStateCardStyle}>{providerProfileError}</div>
            ) : providerProfileData ? (
              <ProviderProfileCard
                avatarUrl={providerProfileData.avatarUrl}
                fullName={providerProfileData.fullName || providerProfileSheet.fallbackName}
                rating={providerProfileData.rating}
                serviceLabel={providerProfileData.serviceLabel}
                priceLabel={
                  providerProfileSheet.requestedServiceType &&
                  getBookingPricingModelForService(providerProfileSheet.requestedServiceType) === 'fixed_visit'
                    ? flow.activeJob?.service_type === providerProfileSheet.requestedServiceType
                      ? activeRequestPriceLabel
                      : flow.currentJob?.service_type === providerProfileSheet.requestedServiceType
                        ? requestPriceLabel
                        : null
                    : null
                }
                experienceRange={providerProfileData.experienceRange}
                experienceYears={providerProfileData.experienceYears}
                languages={providerProfileData.languages}
                specialties={providerProfileData.specialties}
                servicePreferences={providerProfileData.servicePreferences}
                shortBio={providerProfileData.shortBio}
                completedCount={providerProfileData.completedCount}
                preferredCustomerCount={providerProfileData.preferredCustomerCount}
                repeatClientIndicator={providerProfileData.repeatClientIndicator}
                whatsappAvailable={!!providerProfileData.whatsappNumber}
                onClose={() => {
                  setProviderProfileSheet(null)
                  setProviderProfileError(null)
                }}
              />
            ) : null}
          </div>
        </>
      )}

      {addressPickerOpen && (
        <AddressPickerSheet
          currentAddress={flow.location}
          onConfirm={handleAddressConfirm}
          onUseCurrentLocation={handleAddressUseCurrentLocation}
          onClose={() => setAddressPickerOpen(false)}
          locationLoading={flow.locationRefreshing || flow.locationLoading}
          locationError={flow.locationError}
        />
      )}

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

function SettingsCollapsibleSection({
  id,
  title,
  subtitle,
  open,
  onToggle,
  children,
}: {
  id?: string
  title: string
  subtitle?: string
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <section id={id} style={burgerSectionStyle}>
      <button type="button" onClick={onToggle} style={settingsCollapseButtonStyle} aria-expanded={open}>
        <div style={settingsCollapseButtonTextStyle}>
          <div style={burgerSectionTitleStyle}>{title}</div>
          {subtitle ? <div style={burgerSectionSubtitleStyle}>{subtitle}</div> : null}
        </div>
        <span style={settingsCollapseIconStyle}>{open ? '−' : '+'}</span>
      </button>
      {open ? <div style={settingsSectionBodyStyle}>{children}</div> : null}
    </section>
  )
}

function WheelPickerColumn({
  options,
  value,
  onChange,
  isWide = false,
  variant = 'default',
}: {
  options: WheelOption[]
  value: string
  onChange: (value: string) => void
  isWide?: boolean
  variant?: 'default' | 'schedule'
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const rowHeight = variant === 'schedule' ? SCHEDULE_WHEEL_ROW_HEIGHT : WHEEL_ROW_HEIGHT
  const scrollTimeoutRef = useRef<number | null>(null)
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  )

  useEffect(() => {
    const node = scrollRef.current
    if (!node) return
    const targetTop = selectedIndex * rowHeight
    if (Math.abs(node.scrollTop - targetTop) > 2) {
      safeScrollTo(node, { top: targetTop, behavior: 'smooth' })
    }
  }, [rowHeight, selectedIndex])

  useEffect(() => {
    return () => {
      if (scrollTimeoutRef.current != null) {
        window.clearTimeout(scrollTimeoutRef.current)
      }
    }
  }, [])

  return (
    <div
      ref={scrollRef}
      style={{
        ...wheelPickerColumnStyle,
        ...(isWide ? wheelPickerColumnWideStyle : null),
      }}
      onScroll={() => {
        if (scrollTimeoutRef.current != null) {
          window.clearTimeout(scrollTimeoutRef.current)
        }

        const scrollEl = scrollRef.current
        if (!scrollEl) return
        const nextTop = scrollEl.scrollTop
        scrollTimeoutRef.current = window.setTimeout(() => {
          const nextIndex = Math.max(
            0,
            Math.min(options.length - 1, Math.round(nextTop / rowHeight)),
          )
          const nextValue = options[nextIndex]?.value
          if (nextValue && nextValue !== value) {
            onChange(nextValue)
          }
          safeScrollTo(scrollRef.current, {
            top: nextIndex * rowHeight,
            behavior: 'smooth',
          })
        }, 70)
      }}
    >
      <div style={{ ...wheelPickerSpacerStyle, height: rowHeight * 2 }} />
      {options.map((option, index) => {
        const distance = Math.abs(index - selectedIndex)
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            style={{
              ...wheelPickerOptionStyle,
              ...(variant === 'schedule' ? scheduleWheelPickerOptionStyle : null),
              height: rowHeight,
              opacity: distance === 0 ? 1 : distance === 1 ? 0.72 : distance === 2 ? 0.42 : 0.22,
              transform: distance === 0 ? 'scale(1)' : variant === 'schedule' ? 'scale(0.94)' : 'scale(0.96)',
              fontWeight: distance === 0 ? 900 : 700,
              color: distance === 0 ? '#0F172A' : '#64748B',
            }}
          >
            {option.label}
          </button>
        )
      })}
      <div style={{ ...wheelPickerSpacerStyle, height: rowHeight * 2 }} />
    </div>
  )
}

function MenuNavRow({
  icon,
  label,
  onClick,
  destructive = false,
}: {
  icon: string
  label: string
  onClick: () => void
  destructive?: boolean
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
      <div style={menuNavLeadingStyle}>
        <span style={menuNavIconStyle} aria-hidden="true">
          {icon}
        </span>
        <span
          style={{
            ...menuNavLabelStyle,
            ...(destructive ? menuNavLabelDestructiveStyle : null),
          }}
        >
          {label}
        </span>
      </div>
      <span
        style={{
          ...menuNavChevronStyle,
          ...(destructive ? menuNavChevronDestructiveStyle : null),
        }}
        aria-hidden="true"
      >
        ›
      </span>
    </button>
  )
}

function FavoriteWalkerMenuList({
  favorites,
  fallbackNames,
  onToggleFavorite,
  onOpenProfile,
}: {
  favorites: ReturnType<typeof useClientFlow>['favoriteWalkers']
  fallbackNames: Map<string, string>
  onToggleFavorite: (walkerId: string) => Promise<void>
  onOpenProfile: (providerId: string, fallbackName: string, requestedServiceType?: string | null) => void
}) {
  const { t } = useTranslation()
  if (favorites.length === 0) {
    return <div style={burgerEmptyStateStyle}>{t('menu.noPreferredWalkers')}</div>
  }

  return (
    <div style={favoriteMenuListStyle}>
      {favorites.map((favorite) => {
        const walkerName =
          favorite.walker?.full_name ||
          favorite.walker?.email ||
          fallbackNames.get(favorite.walker_id) ||
          t('common.provider')

        return (
          <div key={favorite.walker_id} style={favoriteMenuItemStyle}>
            <button
              type="button"
              onClick={() => onOpenProfile(favorite.walker_id, walkerName)}
              style={favoriteMenuProfileButtonStyle}
            >
              <ProfileAvatar
                url={favorite.walker?.avatar_url ?? null}
                name={walkerName}
                size={34}
                borderRadius={12}
              />
              <div style={favoriteMenuTextStyle}>
                <div style={favoriteMenuNameStyle}>{walkerName}</div>
                <div style={favoriteMenuSubStyle}>{t('providerPublicProfile.viewProfile')}</div>
              </div>
            </button>
            <button
              type="button"
              onClick={() => {
                void onToggleFavorite(favorite.walker_id)
              }}
              style={favoriteMenuRemoveStyle}
            >
              {t('menu.remove')}
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
  const { t } = useTranslation()
  const [customOpen, setCustomOpen] = useState(false)
  const [customAmount, setCustomAmount] = useState('')

  const parsedCustomAmount = Math.max(0, Math.round(Number(customAmount)))

  return (
    <div style={tipCardStyle}>
      <div style={tipIconStyle}>₪</div>
      <h3 style={tipTitleStyle}>{t('tip.addTip', { walkerName })}</h3>
      <p style={tipSubtitleStyle}>{t('tip.optionalSeparate')}</p>

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
            placeholder={t('tip.customPlaceholder')}
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
            {t('tip.send')}
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setCustomOpen(true)} style={tipCustomToggleStyle}>
          {t('tip.customAmount')}
        </button>
      )}

      <button type="button" onClick={onDismiss} disabled={submitting} style={tipSkipButtonStyle}>
        {t('tip.noTip')}
      </button>
    </div>
  )
}

function BurgerUpcomingList({
  items,
  onCancel,
  limit = 3,
}: {
  items: UpcomingBookingItem[]
  onCancel?: (id: string) => void
  limit?: number | null
}) {
  const { t } = useTranslation()
  if (items.length === 0) {
    return <div style={burgerEmptyStateStyle}>{t('menu.noFutureOrders')}</div>
  }

  const visibleItems = limit == null ? items : items.slice(0, limit)

  return (
    <div style={burgerListStyle}>
      {visibleItems.map((item) => (
        <div key={item.id} style={burgerListCardStyle}>
          <div style={burgerListCardHeaderStyle}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={burgerListTitleStyle}>{item.dogName}</div>
              <div style={burgerListSubtitleStyle}>
                {formatShortAddress(item.location) || t('menu.scheduledWalk')}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              {item.price != null && <div style={burgerListPriceStyle}>₪{item.price}</div>}
              {onCancel && (
                <button
                  type="button"
                  onClick={() => onCancel(item.id)}
                  style={clientUpcomingCancelBtnStyle}
                >
                  {t('common.cancel')}
                </button>
              )}
            </div>
          </div>
          <div style={burgerListMetaColumnStyle}>
            <div style={burgerListMetaStyle}>
              {t('menu.scheduledFor', { time: formatScheduledTime(item.scheduledFor) })}
            </div>
            <div style={burgerListMetaStyle}>
              {t('menu.findingProviderAround', { time: item.findingProviderAt || t('booking.fifteenMinutesBefore') })}
            </div>
            <div style={burgerListMetaStyle}>
              {t('menu.estimatedArrivalAround', { time: formatScheduledTime(item.scheduledFor) })}
            </div>
          </div>
          <div style={burgerListMetaRowStyle}>
            <div style={burgerListMetaSubtleStyle}>{formatScheduledDate(item.scheduledFor)}</div>
            {item.startsInMin != null && item.startsInMin >= 0 && item.startsInMin <= 60 && (
              <div style={clientUpcomingBadgeStyle}>
                {t('menu.startsInMinutes', { count: item.startsInMin })}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

function BurgerRecurringList({
  items,
  loading,
  onEdit,
  onCancel,
}: {
  items: RecurringBookingItem[]
  loading: boolean
  onEdit: (item: RecurringBookingItem) => void
  onCancel: (id: string) => void
}) {
  const { t } = useTranslation()
  const isRtl = i18n.resolvedLanguage === 'he'
  if (loading) {
    return <div style={burgerEmptyStateStyle}>{t('recurring.loading')}</div>
  }
  if (items.length === 0) {
    return <div style={burgerEmptyStateStyle}>{t('recurring.noRecurring')}</div>
  }

  return (
    <div style={burgerListStyle}>
      {items.map((item) => (
        <div key={item.id} style={recurringListCardStyle}>
          <div style={burgerListCardHeaderStyle}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={recurringCardTitleStyle}>{item.title}</div>
              <div style={recurringCardSubtitleStyle}>{item.weekdaysLabel}</div>
            </div>
            <div style={recurringStatusBadgeStyle(item.status)}>{t(`recurring.status.${item.status}` as never)}</div>
          </div>
          <div style={recurringCardMetaGridStyle}>
            <div style={recurringCardMetaItemStyle}>
              <div style={recurringCardMetaLabelStyle}>{isRtl ? 'שעה' : 'Time'}</div>
              <div style={recurringCardMetaValueStyle}>{item.timeLabel}</div>
            </div>
            <div style={recurringCardMetaItemStyle}>
              <div style={recurringCardMetaLabelStyle}>{isRtl ? 'משך' : 'Duration'}</div>
              <div style={recurringCardMetaValueStyle}>{item.durationLabel}</div>
            </div>
            {item.pricePerVisit != null && (
              <div style={recurringCardMetaItemStyle}>
                <div style={recurringCardMetaLabelStyle}>{isRtl ? 'מחיר' : 'Price'}</div>
                <div style={recurringCardMetaValueStyle}>{t('recurring.pricePerVisit', { price: item.pricePerVisit })}</div>
              </div>
            )}
            <div style={recurringCardMetaItemStyle}>
              <div style={recurringCardMetaLabelStyle}>{isRtl ? 'הביקור הבא' : 'Next visit'}</div>
              <div style={recurringCardMetaValueStyle}>
              {item.nextOccurrenceLabel ?? t('recurring.noNextOccurrence')}
              </div>
            </div>
          </div>
          <div style={recurringActionRowStyle}>
            <button type="button" onClick={() => onEdit(item)} style={recurringSecondaryActionStyle}>
              {t('recurring.edit')}
            </button>
            <button type="button" onClick={() => onCancel(item.id)} style={recurringDangerActionStyle}>
              {t('recurring.cancelSeries')}
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

function TrackingCard({
  walkerName,
  walkerAvatarUrl,
  walkerRating,
  completedCount,
  walkerBio,
  whatsappAvailable,
  onOpenProfile,
  phase,
  isArrived,
  etaMinutes,
  displayEtaSeconds,
  distanceMeters,
  gpsQuality,
  activeTitle,
  isFixedVisit,
  fixedVisitPriceLabel,
  onWhatsApp,
  onConfirmArrival,
  confirmingArrival,
  elapsedLabel,
  plannedLabel,
  actualLabel,
}: {
  walkerName: string
  walkerAvatarUrl: string | null
  walkerRating: number | null
  completedCount: number
  walkerBio: string | null
  whatsappAvailable: boolean
  onOpenProfile?: () => void
  phase: 'on_the_way' | 'arrived_pending_confirmation' | 'arrival_confirmed' | 'in_progress'
  isArrived: boolean
  etaMinutes: number | null
  displayEtaSeconds: number | null
  distanceMeters: number | null
  gpsQuality: GpsQuality
  activeTitle: string
  isFixedVisit?: boolean
  fixedVisitPriceLabel?: string | null
  onWhatsApp?: () => void
  onConfirmArrival?: () => void
  confirmingArrival?: boolean
  elapsedLabel: string | null
  plannedLabel: string | null
  actualLabel: string | null
}) {
  const { t } = useTranslation()
  const isServiceActive = phase === 'in_progress'
  const isArrivalPending = phase === 'arrived_pending_confirmation'
  const isArrivalConfirmed = phase === 'arrival_confirmed'
  const isOnTheWay = !isServiceActive && !isArrivalPending && !isArrivalConfirmed
  const resolvedTrackingCardStyle = isServiceActive
    ? { ...trackingCardStyle, ...trackingActiveCardCompactStyle }
    : isArrivalPending
      ? { ...trackingCardStyle, ...trackingArrivedCardCompactStyle }
      : trackingCardStyle
  const statusToneStyle = isServiceActive
    ? trackingTopBadgeActiveStyle
    : isArrivalPending
      ? trackingTopBadgeArrivedStyle
      : isArrivalConfirmed
        ? trackingTopBadgeReadyStyle
        : trackingTopBadgeTravelStyle
  const topBadge = isServiceActive
    ? activeTitle
    : isArrivalPending
      ? t('tracking.providerArrived')
      : isArrivalConfirmed
        ? t('tracking.readyToStart')
        : t('tracking.onTheWay')
  const title = isOnTheWay
    ? t('tracking.headingToYou', { walkerName })
    : isServiceActive
    ? t('tracking.providerWithYou', { walkerName })
    : isArrivalPending
      ? t('tracking.arrivedTitle', { walkerName })
      : isArrivalConfirmed
        ? t('tracking.readyToBeginTitle', { walkerName })
        : t('tracking.onTheWay')
  const subtitle = isOnTheWay
    ? t('tracking.liveRouteSubtitle', { walkerName })
    : isServiceActive
    ? null
    : isArrivalPending
      ? t('tracking.arrivalConfirmationSubtitle')
      : isArrivalConfirmed
        ? t('tracking.readySubtitle')
        : t('tracking.headingToYou', { walkerName })
  const completedTasksLabel = i18n.resolvedLanguage === 'he' ? 'משימות הושלמו' : 'completed tasks'
  const serviceStartedLabel = i18n.resolvedLanguage === 'he' ? 'השירות התחיל' : 'Service started'
  const visitFeeLabel = t('tracking.visitFee')
  const ratingValue = walkerRating != null ? walkerRating.toFixed(1) : '—'
  const etaHeroValue = formatEta(etaMinutes, displayEtaSeconds, isArrived || isArrivalPending || isArrivalConfirmed)
  const shouldShowWalkerBio = isOnTheWay && !!walkerBio?.trim()
  return (
    <div style={resolvedTrackingCardStyle}>
      <div style={trackingTopUtilityRowStyle}>
        <div style={{ ...trackingTopBadgeStyle, ...statusToneStyle }}>{topBadge}</div>
        {whatsappAvailable ? (
          <button
            type="button"
            onClick={onWhatsApp}
            style={{
              ...trackingTopActionChipStyle,
              ...trackingTopActionChipWhatsAppStyle,
            }}
            aria-label={t('tracking.whatsapp')}
          >
            <span style={trackingTopActionChipInnerStyle}>
              <span style={trackingCommunicationWhatsAppDotStyle} aria-hidden="true" />
              <span style={trackingTopActionChipTextStyle}>{t('tracking.whatsapp')}</span>
            </span>
          </button>
        ) : null}
        {onOpenProfile ? (
          <button
            type="button"
            onClick={onOpenProfile}
            style={trackingTopActionChipStyle}
          >
            <span style={trackingTopActionChipTextStyle}>{t('providerPublicProfile.viewProfile')}</span>
          </button>
        ) : null}
      </div>
      <div style={trackingHeroRowStyle}>
        <div style={trackingHeroLeadStyle}>
          <div style={trackingHeroAvatarWrapStyle}>
            <ProfileAvatar
              url={walkerAvatarUrl}
              name={walkerName}
              size={72}
              borderRadius={999}
            />
            <span style={trackingHeroOnlineDotStyle} aria-hidden="true" />
          </div>
          <div style={trackingHeroCopyStyle}>
            <div style={trackingHeroNameStyle}>{walkerName}</div>
            <div style={trackingHeroMetaStyle}>
              <span style={trackingHeroStarStyle}>★</span>
              <span>{ratingValue}</span>
              <span style={trackingHeroDotStyle}>•</span>
              <span>
                {completedCount} {completedTasksLabel}
              </span>
            </div>
          </div>
        </div>
        <div style={trackingHeroEtaBadgeStyle}>
          <div style={trackingHeroEtaLabelStyle}>{t('tracking.eta')}</div>
          <div style={trackingHeroEtaValueStyle}>{etaHeroValue}</div>
        </div>
      </div>
      {isServiceActive ? (
        <div style={trackingServiceStartedRowStyle}>
          <span style={trackingServiceStartedPillStyle}>{serviceStartedLabel}</span>
        </div>
      ) : null}
      {shouldShowWalkerBio ? (
        <div style={trackingBioCardStyle}>
          <div style={trackingBioTextStyle}>{walkerBio?.trim()}</div>
        </div>
      ) : null}
      <div style={trackingTitleStyle}>{title}</div>
      {subtitle ? <div style={trackingSubtitleStyle}>{subtitle}</div> : null}

      <div style={trackingStatsGridStyle}>
        <div style={{ ...trackingStatCardStyle, ...trackingEtaStatCardStyle }}>
          <div style={trackingStatLabelStyle}>{t('tracking.eta')}</div>
          <div style={trackingStatValueStyle}>
            {formatEta(etaMinutes, displayEtaSeconds, isArrived || isArrivalPending || isArrivalConfirmed)}
          </div>
        </div>
        <div style={trackingStatCardStyle}>
          <div style={trackingStatLabelStyle}>{t('tracking.distance')}</div>
          <div style={trackingStatValueStyle}>
            {formatDistance(distanceMeters, isArrived || isArrivalPending || isArrivalConfirmed)}
          </div>
        </div>
        <div style={trackingStatCardStyle}>
          <div style={trackingStatLabelStyle}>{t('tracking.gps')}</div>
          <div style={trackingStatValueStyle}>{formatGpsQuality(gpsQuality)}</div>
        </div>
      </div>

      {isFixedVisit ? (
        <div style={trackingTimerPanelStyle}>
          <div style={trackingTimerPrimaryRowStyle}>
            <span style={trackingTimerLabelStyle}>{visitFeeLabel}</span>
            <span style={trackingTimerValueStyle}>{fixedVisitPriceLabel || '—'}</span>
          </div>
          {(elapsedLabel || actualLabel) && (
            <div style={trackingTimerMetaRowStyle}>
              {elapsedLabel && <span style={trackingTimerMetaStyle}>{t('tracking.elapsed')}: {elapsedLabel}</span>}
              {actualLabel && <span style={trackingTimerMetaStyle}>{t('tracking.actual')}: {actualLabel}</span>}
            </div>
          )}
        </div>
      ) : (elapsedLabel || plannedLabel || actualLabel) && (
        <div style={trackingTimerPanelStyle}>
          {elapsedLabel && (
            <div style={trackingTimerPrimaryRowStyle}>
              <span style={trackingTimerLabelStyle}>{t('tracking.elapsed')}</span>
              <span style={trackingTimerValueStyle}>{elapsedLabel}</span>
            </div>
          )}
          {(plannedLabel || actualLabel) && (
            <div style={trackingTimerMetaRowStyle}>
              {plannedLabel && <span style={trackingTimerMetaStyle}>{t('tracking.planned')}: {plannedLabel}</span>}
              {actualLabel && <span style={trackingTimerMetaStyle}>{t('tracking.actual')}: {actualLabel}</span>}
            </div>
          )}
        </div>
      )}

      {isArrivalPending && onConfirmArrival && (
        <div style={trackingArrivalActionWrapStyle}>
          <button
            type="button"
            onClick={onConfirmArrival}
            disabled={!!confirmingArrival}
            aria-busy={!!confirmingArrival}
            style={{
              ...trackingArrivalActionButtonStyle,
              ...(confirmingArrival ? trackingArrivalActionButtonBusyStyle : null),
            }}
          >
            {confirmingArrival ? t('tracking.confirmingArrival') : t('tracking.confirmArrival')}
          </button>
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
  if (!dt) return i18n.t('menu.scheduledWalk')
  return dt.toLocaleString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function formatScheduledTime(value: string | null | undefined): string {
  const dt = parseDateTimeFlexible(value)
  if (!dt) return '—'
  return dt.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function getScheduledDispatchWindowLabel(value: string | null | undefined): string | null {
  const dt = parseDateTimeFlexible(value)
  if (!dt) return null
  const matchingTime = new Date(dt.getTime() - 15 * 60 * 1000)
  return formatScheduledTime(matchingTime.toISOString())
}

function localizeMinuteUnitLabel(value: string | null | undefined): string | null {
  if (!value) return value ?? null
  if (i18n.resolvedLanguage !== 'he') return value

  return value
    .replace(/\bsec\b/gi, 'שנ׳')
    .replace(/\bsecs\b/gi, 'שנ׳')
    .replace(/\bseconds\b/gi, 'שנ׳')
    .replace(/\bsecond\b/gi, 'שנ׳')
    .replace(/\bmin\b/gi, 'דק׳')
    .replace(/\bmins\b/gi, 'דק׳')
    .replace(/\bminutes\b/gi, 'דק׳')
    .replace(/\bminute\b/gi, 'דק׳')
    .replace(/\bh\b/gi, 'ש׳')
}

function formatEta(
  etaMinutes: number | null,
  displayEtaSeconds: number | null,
  isArrived: boolean,
): string {
  const isHebrew = i18n.resolvedLanguage === 'he'
  if (isArrived) return i18n.t('tracking.arrived')
  if (displayEtaSeconds != null && displayEtaSeconds >= 0 && displayEtaSeconds < 60) {
    return isHebrew ? `${displayEtaSeconds} שנ׳` : `${displayEtaSeconds}s`
  }
  if (etaMinutes != null && etaMinutes >= 0) return isHebrew ? `${etaMinutes} דק׳` : `${etaMinutes} min`
  return '—'
}

function formatDistance(distanceMeters: number | null, isArrived: boolean): string {
  if (isArrived) return i18n.t('tracking.here')
  if (distanceMeters == null || Number.isNaN(distanceMeters)) return '—'
  if (distanceMeters < 1000) return `${Math.round(distanceMeters)} m`
  return `${(distanceMeters / 1000).toFixed(1)} km`
}

function formatGpsQuality(gpsQuality: GpsQuality): string {
  switch (gpsQuality) {
    case 'live':
      return i18n.t('tracking.live')
    case 'delayed':
      return i18n.t('tracking.delayed')
    case 'offline':
      return i18n.t('tracking.offline')
    default:
      return i18n.t('tracking.live')
  }
}

const screenStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  left: 0,
  right: 0,
  background: '#F6F9FD',
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

const dashboardBrandBackdropStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  overflow: 'hidden',
  pointerEvents: 'none',
  zIndex: 0,
}

const dashboardBrandGlowTopStyle: React.CSSProperties = {
  position: 'absolute',
  top: -110,
  right: -74,
  width: 250,
  height: 250,
  borderRadius: '50%',
  background: 'radial-gradient(circle, rgba(91,124,250,0.22) 0%, rgba(91,124,250,0.08) 46%, rgba(91,124,250,0) 74%)',
}

const dashboardBrandGlowCenterStyle: React.CSSProperties = {
  position: 'absolute',
  top: '40%',
  right: '8%',
  width: 190,
  height: 190,
  borderRadius: '50%',
  background: 'radial-gradient(circle, rgba(182,171,255,0.16) 0%, rgba(182,171,255,0.06) 44%, rgba(182,171,255,0) 74%)',
}

const dashboardBrandGlowBottomStyle: React.CSSProperties = {
  position: 'absolute',
  left: -116,
  bottom: -96,
  width: 280,
  height: 280,
  borderRadius: '50%',
  background: 'radial-gradient(circle, rgba(91,124,250,0.18) 0%, rgba(91,124,250,0.06) 44%, rgba(91,124,250,0) 74%)',
}

const dashboardBrandDiagonalPrimaryStyle: React.CSSProperties = {
  position: 'absolute',
  top: '16%',
  left: '-10%',
  width: '122%',
  height: 2,
  background: 'rgba(118, 148, 184, 0.28)',
  transform: 'rotate(11deg)',
}

const dashboardBrandDiagonalSecondaryStyle: React.CSSProperties = {
  position: 'absolute',
  top: '36%',
  right: '-10%',
  width: '120%',
  height: 2,
  background: 'rgba(118, 148, 184, 0.2)',
  transform: 'rotate(-14deg)',
}

const dashboardBrandDiagonalTertiaryStyle: React.CSSProperties = {
  position: 'absolute',
  top: '67%',
  left: '-8%',
  width: '114%',
  height: 1,
  background: 'rgba(118, 148, 184, 0.24)',
  transform: 'rotate(8deg)',
}

const dashboardBrandRouteUpperStyle: React.CSSProperties = {
  position: 'absolute',
  top: '18%',
  left: '59%',
  width: 104,
  height: 174,
  borderLeft: '3px dotted rgba(91, 124, 250, 0.42)',
  transform: 'rotate(18deg)',
}

const dashboardBrandRouteLowerStyle: React.CSSProperties = {
  position: 'absolute',
  left: '18%',
  bottom: '12%',
  width: 118,
  height: 142,
  borderRight: '3px dotted rgba(91, 124, 250, 0.34)',
  transform: 'rotate(16deg)',
}

const dashboardBrandDotsUpperLeftStyle: React.CSSProperties = {
  position: 'absolute',
  top: '9%',
  left: '7%',
  width: 92,
  height: 92,
  borderRadius: 28,
  backgroundImage: 'radial-gradient(circle, rgba(120, 140, 176, 0.2) 1.2px, transparent 1.2px)',
  backgroundSize: '13px 13px',
  opacity: 0.78,
}

const dashboardBrandDotsTopStyle: React.CSSProperties = {
  position: 'absolute',
  top: '8%',
  right: '8%',
  width: 118,
  height: 118,
  borderRadius: 28,
  backgroundImage: 'radial-gradient(circle, rgba(120, 140, 176, 0.22) 1.2px, transparent 1.2px)',
  backgroundSize: '13px 13px',
  opacity: 0.82,
}

const dashboardBrandDotsLowerRightStyle: React.CSSProperties = {
  position: 'absolute',
  right: '10%',
  bottom: '22%',
  width: 86,
  height: 86,
  borderRadius: 24,
  backgroundImage: 'radial-gradient(circle, rgba(120, 140, 176, 0.18) 1.15px, transparent 1.15px)',
  backgroundSize: '12px 12px',
  opacity: 0.72,
}

const dashboardBrandDotsBottomStyle: React.CSSProperties = {
  position: 'absolute',
  left: '8%',
  bottom: '8%',
  width: 104,
  height: 104,
  borderRadius: 28,
  backgroundImage: 'radial-gradient(circle, rgba(120, 140, 176, 0.2) 1.15px, transparent 1.15px)',
  backgroundSize: '12px 12px',
  opacity: 0.78,
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
  position: 'absolute',
  inset: 0,
  overflow: 'hidden',
  width: '100%',
  maxWidth: '100%',
  boxSizing: 'border-box',
}

const idleMapContainerStyle: React.CSSProperties = {
  height: '100%',
}

const searchingMapContainerStyle: React.CSSProperties = {
  height: '100%',
}

const trackingMapContainerStyle: React.CSSProperties = {
  height: '100%',
}

const deferredMapPlaceholderStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  background:
    'radial-gradient(circle at 84% 14%, rgba(173,191,255,0.12) 0%, rgba(173,191,255,0) 26%), radial-gradient(circle at 14% 78%, rgba(255,209,102,0.08) 0%, rgba(255,209,102,0) 24%), linear-gradient(180deg, #F3F7FD 0%, #F8FAFD 48%, #FBFCFE 100%)',
  backgroundImage:
    'radial-gradient(circle at 84% 14%, rgba(173,191,255,0.12) 0%, rgba(173,191,255,0) 26%), radial-gradient(circle at 14% 78%, rgba(255,209,102,0.08) 0%, rgba(255,209,102,0) 24%), linear-gradient(180deg, #F3F7FD 0%, #F8FAFD 48%, #FBFCFE 100%), linear-gradient(11deg, rgba(120,140,176,0.08) 0%, rgba(120,140,176,0.08) 0.12%, transparent 0.12%, transparent 100%), radial-gradient(circle, rgba(120,140,176,0.08) 1.1px, transparent 1.1px)',
  backgroundSize: 'auto, auto, auto, auto, 14px 14px',
  backgroundPosition: 'center, center, center, center, calc(100% - 42px) 56px',
}

const floatingTopBarStyle: React.CSSProperties = {
  position: 'fixed',
  top: 'calc(12px + env(safe-area-inset-top))',
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
  background: 'rgba(218, 229, 255, 0.98)',
  boxShadow: '0 8px 24px rgba(15, 23, 42, 0.18)',
  pointerEvents: 'auto',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
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
  borderRadius: 10,
  background: 'rgba(218, 229, 255, 0.98)',
  display: 'grid',
  placeItems: 'center',
}


const sheetStyle: React.CSSProperties = {
  position: 'absolute',
  left: 0,
  right: 0,
  bottom: 0,
  top: 'calc(36dvh - 18px)',
  borderTopLeftRadius: 32,
  borderTopRightRadius: 32,
  background: 'rgba(255,255,255,0.82)',
  boxShadow: '0 -16px 42px rgba(15, 23, 42, 0.12)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  zIndex: 1,
  boxSizing: 'border-box',
  willChange: 'transform',
  backdropFilter: 'blur(24px)',
  WebkitBackdropFilter: 'blur(24px)',
  borderTop: '1px solid rgba(255,255,255,0.72)',
}

const idleSheetStyle: React.CSSProperties = {
  ...sheetStyle,
  top: 'auto',
  height: 'auto',
}

const searchingSheetStyle: React.CSSProperties = {
  ...sheetStyle,
  top: 'auto',
  height: 'auto',
  maxHeight: 'calc(100dvh - 92px)',
  background: 'transparent',
  boxShadow: 'none',
  borderTopLeftRadius: 0,
  borderTopRightRadius: 0,
  border: 'none',
  overflow: 'visible',
  pointerEvents: 'none',
  zIndex: 3,
}

const trackingSheetStyle: React.CSSProperties = {
  ...sheetStyle,
  top: 'auto',
  height: 'auto',
  maxHeight: 'calc(100dvh - 92px)',
  background: 'transparent',
  boxShadow: 'none',
  borderTopLeftRadius: 0,
  borderTopRightRadius: 0,
  border: 'none',
  overflow: 'visible',
  pointerEvents: 'none',
  zIndex: 3,
}

const sheetTopPadStyle: React.CSSProperties = {
  height: 12,
  flexShrink: 0,
  borderTopLeftRadius: 32,
  borderTopRightRadius: 32,
  background: 'linear-gradient(180deg, rgba(255,255,255,0.84) 0%, rgba(255,255,255,0.72) 100%)',
}

const dragHandleZoneStyle: React.CSSProperties = {
  flexShrink: 0,
  padding: '16px 0 8px',
  display: 'flex',
  justifyContent: 'center',
  cursor: 'grab',
  touchAction: 'none',
  WebkitTapHighlightColor: 'transparent',
  userSelect: 'none',
  WebkitUserSelect: 'none',
}

const dragHandleBarStyle: React.CSSProperties = {
  width: 42,
  height: 5,
  borderRadius: 999,
  background: 'rgba(148, 163, 184, 0.42)',
}

const searchingSheetScrollStyle: React.CSSProperties = {
  flex: '0 0 auto',
  minHeight: 0,
  overflowY: 'visible',
  overflowX: 'hidden',
  paddingTop: 0,
  paddingRight: 0,
  paddingBottom: 0,
  paddingLeft: 0,
  width: '100%',
  maxWidth: '100%',
  boxSizing: 'border-box',
  pointerEvents: 'none',
}

const trackingSheetScrollStyle: React.CSSProperties = {
  flex: '0 0 auto',
  minHeight: 0,
  overflowY: 'visible',
  overflowX: 'hidden',
  paddingTop: 0,
  paddingRight: 0,
  paddingBottom: 0,
  paddingLeft: 0,
  width: '100%',
  maxWidth: '100%',
  boxSizing: 'border-box',
}

const idleSheetScrollStyle: React.CSSProperties = {
  overflowY: 'auto',
  flex: '0 1 auto',
  minHeight: 0,
  overflowX: 'hidden',
  paddingTop: 0,
  paddingRight: 16,
  paddingBottom: 6,
  paddingLeft: 16,
  WebkitOverflowScrolling: 'touch',
  width: '100%',
  maxWidth: '100%',
  boxSizing: 'border-box',
}

const sheetContentStyle: React.CSSProperties = {
  paddingBottom: 0,
  width: '100%',
  maxWidth: '100%',
  boxSizing: 'border-box',
}

const searchingSheetContentStyle: React.CSSProperties = {
  ...sheetContentStyle,
  display: 'flex',
  justifyContent: 'center',
  pointerEvents: 'auto',
  paddingBottom: 0,
}

const clientBottomSheetShellStyle: React.CSSProperties = {
  width: '100%',
  maxWidth: '100%',
  overflow: 'hidden',
  borderTopLeftRadius: 30,
  borderTopRightRadius: 30,
  borderBottomLeftRadius: 0,
  borderBottomRightRadius: 0,
  boxSizing: 'border-box',
}

const idleSheetContentStyle: React.CSSProperties = {
  paddingBottom: 4,
}


const bookingCardStyle: React.CSSProperties = {
  display: 'grid',
  gap: 5,
  borderRadius: 28,
  padding: '4px 4px 2px',
  background: 'linear-gradient(180deg, rgba(255,255,255,0.44) 0%, rgba(248,250,252,0.24) 100%)',
}

const launchServicesSelectorWrapStyle: React.CSSProperties = {
  display: 'grid',
  gap: 0,
}


const compactFormGridStyle: React.CSSProperties = {
  display: 'grid',
  gap: 6,
}

const scheduleSharedInnerCardStyle: React.CSSProperties = {
  display: 'grid',
  gap: 10,
  minHeight: 284,
  padding: '14px 14px 12px',
  borderRadius: 22,
  border: '1px solid rgba(96, 165, 250, 0.26)',
  background: 'linear-gradient(180deg, rgba(239, 246, 255, 0.96) 0%, rgba(248, 250, 252, 0.98) 100%)',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.8)',
  boxSizing: 'border-box',
}

const repeatSectionStyle: React.CSSProperties = {
  ...scheduleSharedInnerCardStyle,
}

const repeatHeaderRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
}

const repeatLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 800,
  color: '#1E3A8A',
}

const repeatSummaryStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: '#2563EB',
  whiteSpace: 'nowrap',
}

const repeatExpandedStyle: React.CSSProperties = {
  display: 'grid',
  gap: 10,
}

const repeatWeekdayRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 5,
  flexWrap: 'wrap',
}

const repeatDayChipStyle: React.CSSProperties = {
  minWidth: 36,
  height: 30,
  borderRadius: 999,
  border: '1px solid rgba(203, 213, 225, 0.9)',
  background: 'rgba(255,255,255,0.92)',
  color: '#475569',
  fontSize: 11,
  fontWeight: 700,
  cursor: 'pointer',
  fontFamily: 'inherit',
}

const repeatDayChipActiveStyle: React.CSSProperties = {
  background: 'linear-gradient(180deg, rgba(220, 252, 231, 0.98) 0%, rgba(187, 247, 208, 0.98) 100%)',
  borderColor: 'rgba(34, 197, 94, 0.42)',
  color: '#166534',
  boxShadow: '0 6px 14px rgba(34, 197, 94, 0.14)',
}

const repeatTimeRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  minHeight: 36,
}

const repeatTimeLabelStyle: React.CSSProperties = {
  fontSize: 11.5,
  fontWeight: 800,
  color: '#475569',
}

const repeatTimeInputStyle: React.CSSProperties = {
  minHeight: 36,
  minWidth: 112,
  borderRadius: 12,
  border: '1px solid rgba(203, 213, 225, 0.9)',
  background: 'rgba(255,255,255,0.96)',
  color: '#0F172A',
  fontSize: 14,
  fontWeight: 800,
  padding: '0 10px',
  fontFamily: 'inherit',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  cursor: 'pointer',
}

const repeatTimeChevronStyle: React.CSSProperties = {
  fontSize: 16,
  lineHeight: 1,
  color: '#94A3B8',
}

const recurringInlineErrorStyle: React.CSSProperties = {
  marginTop: 8,
  fontSize: 12,
  fontWeight: 600,
  color: '#B91C1C',
}

const recurringInlineSuccessStyle: React.CSSProperties = {
  marginTop: 8,
  fontSize: 12,
  fontWeight: 600,
  color: '#166534',
}

const futureOrdersSectionsStyle: React.CSSProperties = {
  display: 'grid',
  gap: 18,
}

const futureOrdersSectionLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 800,
  color: '#64748B',
  marginBottom: 8,
}

const recurringActionRowStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
  marginTop: 10,
}

const recurringSecondaryActionStyle: React.CSSProperties = {
  border: '1px solid rgba(148, 163, 184, 0.18)',
  background: 'rgba(248,250,252,0.92)',
  color: '#1D4ED8',
  borderRadius: 999,
  padding: '8px 12px',
  fontSize: 12,
  fontWeight: 700,
  cursor: 'pointer',
}

const recurringDangerActionStyle: React.CSSProperties = {
  ...recurringSecondaryActionStyle,
  color: '#B91C1C',
}

const recurringPrimaryActionStyle: React.CSSProperties = {
  height: 46,
  borderRadius: 16,
  border: 'none',
  background: 'linear-gradient(180deg, #172554 0%, #0F172A 100%)',
  color: '#FFFFFF',
  fontSize: 14,
  fontWeight: 800,
  cursor: 'pointer',
}

const recurringSecondaryWideActionStyle: React.CSSProperties = {
  height: 44,
  borderRadius: 16,
  border: '1px solid rgba(148, 163, 184, 0.18)',
  background: 'rgba(248,250,252,0.92)',
  color: '#1D4ED8',
  fontSize: 14,
  fontWeight: 700,
  cursor: 'pointer',
}

const recurringDangerWideActionStyle: React.CSSProperties = {
  ...recurringSecondaryWideActionStyle,
  color: '#B91C1C',
}

const recurringActionStackStyle: React.CSSProperties = {
  display: 'grid',
  gap: 10,
}

const recurringEditSheetStyle: React.CSSProperties = {
  position: 'fixed',
  left: 0,
  right: 0,
  bottom: 0,
  zIndex: 40002,
  background: 'linear-gradient(180deg, rgba(255,255,255,0.98) 0%, #FFFFFF 100%)',
  borderTopLeftRadius: 30,
  borderTopRightRadius: 30,
  boxShadow: '0 -20px 50px rgba(15, 23, 42, 0.16)',
  display: 'flex',
  flexDirection: 'column',
  boxSizing: 'border-box',
  padding: '10px 10px calc(16px + env(safe-area-inset-bottom))',
  backdropFilter: 'blur(18px)',
  WebkitBackdropFilter: 'blur(18px)',
  animation: 'regliScheduleSheetRise 240ms cubic-bezier(0.22, 1, 0.36, 1)',
}

const recurringEditContentStyle: React.CSSProperties = {
  display: 'grid',
  gap: 12,
  padding: '0 0 4px',
}

const recurringStatusBadgeStyle = (status: RecurringStatus): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: 28,
  padding: '0 10px',
  borderRadius: 999,
  fontSize: 11.5,
  fontWeight: 800,
  color: status === 'active' ? '#166534' : status === 'paused' ? '#92400E' : '#64748B',
  background: status === 'active' ? 'rgba(34,197,94,0.12)' : status === 'paused' ? 'rgba(245,158,11,0.12)' : 'rgba(148,163,184,0.16)',
})

const recurringListCardStyle: React.CSSProperties = {
  borderRadius: 24,
  border: '1px solid rgba(226, 232, 240, 0.95)',
  background: 'linear-gradient(180deg, rgba(255,255,255,0.98) 0%, #F8FAFC 100%)',
  padding: '14px 14px 12px',
  boxShadow: '0 14px 28px rgba(15, 23, 42, 0.06)',
}

const recurringCardTitleStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 900,
  color: '#0F172A',
  letterSpacing: '-0.01em',
}

const recurringCardSubtitleStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#64748B',
  lineHeight: 1.35,
  marginTop: 3,
}

const recurringCardMetaGridStyle: React.CSSProperties = {
  display: 'grid',
  gap: 8,
  marginTop: 12,
}

const recurringCardMetaItemStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 12,
  paddingBottom: 6,
  borderBottom: '1px solid rgba(226, 232, 240, 0.78)',
}

const recurringCardMetaLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  color: '#94A3B8',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
}

const recurringCardMetaValueStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: '#0F172A',
  textAlign: 'right',
}

const timePickerOverlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 40030,
  background: 'rgba(15, 23, 42, 0.34)',
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
}

const timePickerModalStyle: React.CSSProperties = {
  position: 'fixed',
  left: '50%',
  top: '50%',
  transform: 'translate(-50%, -50%)',
  width: 'min(92vw, 360px)',
  zIndex: 40031,
  borderRadius: 28,
  background: 'linear-gradient(180deg, rgba(255,255,255,0.98) 0%, #FFFFFF 100%)',
  boxShadow: '0 28px 60px rgba(15, 23, 42, 0.22)',
  border: '1px solid rgba(226, 232, 240, 0.95)',
  padding: '18px 16px 16px',
  display: 'grid',
  gap: 14,
}

const providerProfileOverlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 40040,
  background: 'rgba(2, 6, 23, 0.58)',
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
  animation: 'regliMenuFadeIn 180ms ease',
}

const providerProfileSheetStyle: React.CSSProperties = {
  position: 'fixed',
  left: 0,
  right: 0,
  bottom: 0,
  width: '100%',
  maxWidth: 520,
  margin: '0 auto',
  maxHeight: 'calc(100dvh - 20px)',
  overflowY: 'auto',
  zIndex: 40041,
  animation: 'regliBottomSheetEnter 220ms cubic-bezier(0.22, 1, 0.36, 1)',
}

const providerProfileStateCardStyle: React.CSSProperties = {
  borderRadius: '30px 30px 0 0',
  background: 'linear-gradient(180deg, rgba(15,23,42,0.98) 0%, rgba(17,24,39,0.98) 100%)',
  border: '1px solid rgba(148, 163, 184, 0.18)',
  borderBottom: 'none',
  boxShadow: '0 -18px 48px rgba(2, 6, 23, 0.32)',
  padding: '22px 18px calc(22px + env(safe-area-inset-bottom, 0px))',
  color: '#CBD5E1',
  fontSize: 14,
  fontWeight: 700,
  textAlign: 'center',
}

const timePickerHeaderStyle: React.CSSProperties = {
  display: 'grid',
  gap: 4,
  textAlign: 'center',
}

const timePickerTitleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 900,
  color: '#0F172A',
}

const timePickerSubtitleStyle: React.CSSProperties = {
  fontSize: 12.5,
  lineHeight: 1.4,
  color: '#64748B',
}

const timePickerWheelShellStyle: React.CSSProperties = {
  position: 'relative',
  borderRadius: 22,
  border: '1px solid rgba(226, 232, 240, 0.95)',
  background: 'linear-gradient(180deg, #FFFFFF 0%, #F8FAFC 100%)',
  padding: 10,
}

const timePickerWheelColumnsStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 8,
  height: 156,
}

const timePickerWheelHighlightStyle: React.CSSProperties = {
  position: 'absolute',
  left: 10,
  right: 10,
  top: '50%',
  height: 28,
  transform: 'translateY(-50%)',
  borderRadius: 14,
  background: 'rgba(248, 250, 252, 0.98)',
  border: '1px solid rgba(203, 213, 225, 0.92)',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.94), 0 6px 16px rgba(148, 163, 184, 0.10)',
  pointerEvents: 'none',
}

const timePickerActionsStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 10,
}

const timePickerMeridiemRowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 4,
  minHeight: 54,
  padding: 4,
  borderRadius: 18,
  border: '1px solid rgba(203, 213, 225, 0.92)',
  background: 'linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(248,250,252,0.94) 100%)',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.9)',
}

const timePickerMeridiemButtonStyle: React.CSSProperties = {
  height: 46,
  borderRadius: 14,
  border: 'none',
  background: 'transparent',
  color: '#0F172A',
  fontSize: 13,
  fontWeight: 800,
  cursor: 'pointer',
  boxShadow: 'none',
}

const timePickerMeridiemButtonActiveStyle: React.CSSProperties = {
  background: 'linear-gradient(180deg, #172554 0%, #0F172A 100%)',
  color: '#FFFFFF',
  boxShadow: '0 8px 18px rgba(15, 23, 42, 0.12)',
}

const timePickerSecondaryButtonStyle: React.CSSProperties = {
  height: 46,
  borderRadius: 16,
  border: '1px solid rgba(203, 213, 225, 0.92)',
  background: 'rgba(248,250,252,0.92)',
  color: '#475569',
  fontSize: 14,
  fontWeight: 800,
  cursor: 'pointer',
}

const timePickerPrimaryButtonStyle: React.CSSProperties = {
  height: 46,
  borderRadius: 16,
  border: 'none',
  background: 'linear-gradient(180deg, #172554 0%, #0F172A 100%)',
  color: '#FFFFFF',
  fontSize: 14,
  fontWeight: 800,
  cursor: 'pointer',
}

const comingSoonOverlayStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  padding: '32px 16px',
}

const comingSoonTextStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 700,
  color: '#94A3B8',
}

const preferredWalkerIndicatorStyle: React.CSSProperties = {
  justifySelf: 'flex-start',
  maxWidth: '100%',
  border: '1px solid rgba(96, 165, 250, 0.18)',
  background: 'rgba(248, 250, 252, 0.9)',
  color: '#1E3A8A',
  borderRadius: 999,
  padding: '5px 10px',
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
  gap: 4,
}

const fixedVisitSectionStyle: React.CSSProperties = {
  display: 'grid',
  gap: 0,
}

const fixedVisitTextareaStyle: React.CSSProperties = {
  width: '100%',
  height: 42,
  borderRadius: 14,
  border: '1px solid rgba(226, 232, 240, 0.72)',
  background: 'rgba(248,250,252,0.78)',
  padding: '0 12px',
  boxSizing: 'border-box',
  outline: 'none',
  fontFamily: 'inherit',
  fontSize: 12.5,
  lineHeight: '42px',
  color: '#0F172A',
}

const babysitterServiceFieldWrapStyle: React.CSSProperties = {
  marginBottom: 2,
}

const babysitterAddressFieldWrapStyle: React.CSSProperties = {
  marginBottom: 2,
}

const dogWalkerAddressFieldWrapStyle: React.CSSProperties = {
  marginBottom: 2,
  marginTop: 4,
  minWidth: 0,
}

const babysitterPlannerFieldWrapStyle: React.CSSProperties = {
  marginBottom: 1,
}

const dogWalkerPlannerFieldWrapStyle: React.CSSProperties = {
  marginBottom: 1,
}

const guidedFieldButtonStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: 2,
  borderRadius: 16,
  transformOrigin: 'center top',
  willChange: 'transform, box-shadow, opacity',
  boxSizing: 'border-box',
}

const guidedFieldShellStyle: React.CSSProperties = {
  border: '1px solid rgba(96, 165, 250, 0.55)',
  borderRadius: 16,
  boxShadow: '0 0 0 2px rgba(96, 165, 250, 0.12)',
  background: 'rgba(248, 251, 255, 0.98)',
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
  marginBottom: 4,
}

const compactFieldLabelMutedStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.1,
  color: '#64748B',
}

const pickupSelectorShellStyle: React.CSSProperties = {
  minHeight: 42,
  borderRadius: 14,
  border: '1px solid rgba(226, 232, 240, 0.72)',
  background: 'rgba(248,250,252,0.78)',
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  width: '100%',
  boxSizing: 'border-box',
  minWidth: 0,
  padding: '0 9px 0 7px',
  cursor: 'pointer',
}

const pickupSelectorShellCompactStyle: React.CSSProperties = {
  minHeight: 40,
  padding: '0 8px',
}

const pickupSelectorInlineIconStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  width: 18,
  height: 18,
  borderRadius: 8,
  background: 'rgba(59,130,246,0.08)',
  color: '#2563EB',
  fontSize: 10.5,
  lineHeight: 1,
}

const pickupSelectorValueStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 12,
  color: '#0F172A',
  fontWeight: 700,
  lineHeight: 'normal',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const pickupSelectorValueCompactStyle: React.CSSProperties = {
  fontSize: 11.5,
  fontWeight: 700,
  lineHeight: 'normal',
}

const pickupSelectorPlaceholderStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 12,
  color: '#94A3B8',
  fontWeight: 600,
  lineHeight: 'normal',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}



const dogInputShellStyle: React.CSSProperties = {
  minHeight: 40,
  borderRadius: 14,
  border: '1px solid rgba(226, 232, 240, 0.72)',
  background: 'rgba(248,250,252,0.78)',
  display: 'flex',
  alignItems: 'center',
  overflow: 'hidden',
}

const dogInputShellCompactStyle: React.CSSProperties = {
  minHeight: 40,
}

const dogThumbStyle: React.CSSProperties = {
  width: 22,
  height: 22,
  borderRadius: 10,
  marginLeft: 7,
  marginRight: 4,
  background: 'linear-gradient(180deg, rgba(59,130,246,0.08) 0%, rgba(96,165,250,0.12) 100%)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 12,
  flexShrink: 0,
}

const dogThumbCompactStyle: React.CSSProperties = {
  width: 20,
  height: 20,
  fontSize: 11,
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
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 12,
  color: '#0F172A',
  fontWeight: 800,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const dogInputPlaceholderTextStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 12,
  color: '#94A3B8',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const dogInputChevronStyle: React.CSSProperties = {
  paddingRight: 9,
  color: '#94A3B8',
  fontSize: 16,
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
  borderTopLeftRadius: 24,
  borderTopRightRadius: 24,
  background: '#FFFFFF',
  boxShadow: '0 -8px 32px rgba(15, 23, 42, 0.12)',
  padding: '8px 16px calc(12px + env(safe-area-inset-bottom))',
  display: 'grid',
  gap: 10,
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
  fontSize: 12,
  lineHeight: 1.35,
  color: '#64748B',
}

const recipientSectionStyle: React.CSSProperties = {
  display: 'grid',
  gap: 6,
}

const recipientSectionLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 800,
  color: '#475569',
}

const recipientSectionLabelMutedStyle: React.CSSProperties = {
  fontSize: 11.5,
  fontWeight: 800,
  color: '#94A3B8',
}

const dogNameSuggestionsWrapStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
}

const dogNameChipWrapStyle: React.CSSProperties = {
  position: 'relative',
  display: 'inline-flex',
}

const dogNameChipStyle: React.CSSProperties = {
  minHeight: 32,
  borderRadius: 999,
  border: '1px solid #DBEAFE',
  background: '#EFF6FF',
  color: '#1D4ED8',
  fontSize: 12.5,
  fontWeight: 800,
  padding: '0 26px 0 10px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  cursor: 'pointer',
}

const dogNameChipActiveStyle: React.CSSProperties = {
  borderColor: '#0F172A',
  background: 'linear-gradient(180deg, #172554 0%, #0F172A 100%)',
  color: '#FFFFFF',
  boxShadow: '0 10px 18px rgba(15, 23, 42, 0.14)',
}

const dogNameChipDeleteStyle: React.CSSProperties = {
  position: 'absolute',
  top: -4,
  right: -4,
  width: 18,
  height: 18,
  borderRadius: 999,
  border: '1.5px solid #DBEAFE',
  background: '#FFFFFF',
  color: '#94A3B8',
  display: 'grid',
  placeItems: 'center',
  cursor: 'pointer',
  padding: 0,
}

const dogNameChipMutedStyle: React.CSSProperties = {
  borderColor: 'rgba(203, 213, 225, 0.9)',
  background: 'rgba(248,250,252,0.9)',
  color: '#475569',
}

const recipientExpandButtonStyle: React.CSSProperties = {
  minHeight: 34,
  borderRadius: 999,
  border: '1px solid rgba(203, 213, 225, 0.9)',
  background: 'rgba(248,250,252,0.92)',
  color: '#2563EB',
  fontSize: 12.5,
  fontWeight: 800,
  textAlign: 'start',
  padding: '0 12px',
  cursor: 'pointer',
  fontFamily: 'inherit',
}

const recipientInlineEditorStyle: React.CSSProperties = {
  display: 'grid',
  gap: 6,
}

const dogNameSheetInputStyle: React.CSSProperties = {
  width: '100%',
  height: 40,
  borderRadius: 12,
  border: '1px solid #E2E8F0',
  background: '#FFFFFF',
  outline: 'none',
  padding: '0 12px',
  fontSize: 14,
  color: '#0F172A',
  boxSizing: 'border-box',
}

const dogSizeSelectorStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
}

const dogSizeOptionStyle: React.CSSProperties = {
  minWidth: 44,
  height: 34,
  padding: '0 12px',
  borderRadius: 999,
  border: '1px solid rgba(148, 163, 184, 0.24)',
  background: '#F8FAFC',
  color: '#334155',
  fontSize: 12,
  fontWeight: 900,
  cursor: 'pointer',
  fontFamily: 'inherit',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.92)',
}

const dogSizeOptionActiveStyle: React.CSSProperties = {
  borderColor: '#0F172A',
  background: 'linear-gradient(180deg, #172554 0%, #0F172A 100%)',
  color: '#FFFFFF',
  boxShadow: '0 10px 18px rgba(15, 23, 42, 0.14)',
}

const dogNameSheetErrorStyle: React.CSSProperties = {
  borderRadius: 12,
  background: 'rgba(254, 242, 242, 0.92)',
  color: '#B91C1C',
  fontSize: 12,
  fontWeight: 700,
  lineHeight: 1.35,
  padding: '8px 10px',
}

const dogNameSheetActionsStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 10,
}

const dogNameSecondaryBtnStyle: React.CSSProperties = {
  height: 44,
  borderRadius: 14,
  border: '1px solid #E2E8F0',
  background: '#FFFFFF',
  color: '#0F172A',
  fontSize: 15,
  fontWeight: 800,
  cursor: 'pointer',
}

const dogNamePrimaryBtnStyle: React.CSSProperties = {
  height: 44,
  borderRadius: 14,
  border: 'none',
  background: '#2563EB',
  color: '#FFFFFF',
  fontSize: 15,
  fontWeight: 800,
  cursor: 'pointer',
}

const durationGuidedFieldShellStyle: React.CSSProperties = {
  border: '2px solid #3B82F6',
  borderRadius: 15,
  background: 'rgba(59,130,246,0.06)',
  boxShadow: '0 0 0 2px rgba(59,130,246,0.12)',
}

const guidedFieldAnimationStyle: React.CSSProperties = {
  animation: 'regliGuidedFieldPulse 420ms cubic-bezier(0.22, 1, 0.36, 1) 1',
}

const compactPaymentWrapStyle: React.CSSProperties = {
  marginTop: 0,
  marginBottom: 0,
  border: 'none',
  borderRadius: 22,
  padding: 2,
  boxSizing: 'border-box',
  transition: 'border-color 180ms ease, background-color 180ms ease, box-shadow 220ms ease',
  transformOrigin: 'center top',
  willChange: 'transform, box-shadow, opacity',
  background: 'transparent',
  boxShadow: 'none',
}

const compactSavedCardRowStyle: React.CSSProperties = {
  appearance: 'none',
  border: 'none',
  background: 'transparent',
  borderRadius: 0,
  padding: 0,
  width: '100%',
  display: 'grid',
  gap: 0,
  cursor: 'pointer',
  fontFamily: 'inherit',
  boxShadow: 'none',
  overflow: 'hidden',
}

const compactSavedCardMainStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  minWidth: 0,
  minHeight: 32,
  padding: '2px 0',
}

const compactAddPaymentMethodCtaRowStyle: React.CSSProperties = {
  borderRadius: 18,
  padding: '10px 12px',
  border: '1px solid rgba(96, 165, 250, 0.28)',
  background: 'linear-gradient(180deg, rgba(239,246,255,0.96) 0%, rgba(248,250,252,0.98) 100%)',
  boxShadow: '0 10px 22px rgba(37, 99, 235, 0.08), inset 0 1px 0 rgba(255,255,255,0.72)',
}

const compactAddPaymentMethodCtaMainStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  minWidth: 0,
  minHeight: 42,
}

const compactAddPaymentMethodTextWrapStyle: React.CSSProperties = {
  display: 'grid',
  gap: 2,
  minWidth: 0,
  flex: 1,
}

const compactAddPaymentMethodTitleStyle: React.CSSProperties = {
  fontSize: 13.5,
  fontWeight: 900,
  color: '#1D4ED8',
  lineHeight: 1.2,
  minWidth: 0,
}

const compactAddPaymentMethodSubtitleStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: '#64748B',
  lineHeight: 1.25,
  minWidth: 0,
}

const compactSavedCardBrandStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 800,
  color: '#2563EB',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  minWidth: 0,
}

const compactPaymentMethodIconWrapStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 14,
  marginInlineStart: 'auto',
  paddingInlineStart: 6,
  flexShrink: 0,
}

const compactAddPaymentMethodIconShellStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 999,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(219, 234, 254, 0.96)',
  border: '1px solid rgba(96, 165, 250, 0.2)',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.72)',
}

const compactPaymentMethodApplePayStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: 14,
  padding: '0 4px',
  borderRadius: 999,
  color: '#2563EB',
  fontSize: 9.5,
  fontWeight: 900,
  lineHeight: 1,
  whiteSpace: 'nowrap',
}

const babysitterPlannerCardStyle: React.CSSProperties = {
  display: 'grid',
  gap: 3,
  padding: 0,
  borderRadius: 0,
  border: 'none',
  background: 'transparent',
  boxShadow: 'none',
}

const dogWalkerPlannerCardStyle: React.CSSProperties = {
  display: 'grid',
  gap: 3,
  padding: 0,
  borderRadius: 0,
  border: 'none',
  background: 'transparent',
  boxShadow: 'none',
}

const dogWalkerDurationOnlyRowStyle: React.CSSProperties = {
  display: 'grid',
  gap: 2,
  alignItems: 'start',
  paddingTop: 3,
}

const dogWalkerPlannerLabelStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  color: '#64748B',
  lineHeight: 1.2,
  minHeight: 12,
  display: 'inline-flex',
  alignItems: 'center',
  whiteSpace: 'nowrap',
}

const dogWalkerFieldGroupStyle: React.CSSProperties = {
  display: 'grid',
  gap: 2,
  minWidth: 0,
  alignContent: 'start',
}

const babysitterFieldGroupStyle: React.CSSProperties = {
  display: 'grid',
  gap: 2,
  minWidth: 0,
  alignContent: 'start',
}

const babysitterFieldLabelStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  color: '#64748B',
  lineHeight: 1.2,
  minHeight: 12,
  display: 'inline-flex',
  alignItems: 'center',
}

const babysitterDurationStepperStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) 24px',
  alignItems: 'stretch',
  borderRadius: 13,
  border: '1px solid rgba(203, 213, 225, 0.88)',
  background: 'rgba(255,255,255,0.94)',
  minHeight: 30,
  overflow: 'hidden',
}

const babysitterDurationValueStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '0 8px',
  fontSize: 11.5,
  fontWeight: 800,
  color: '#0F172A',
}

const babysitterDurationStepperButtonsStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateRows: '1fr 1fr',
  borderInlineStart: '1px solid rgba(226, 232, 240, 0.95)',
}

const babysitterStepButtonStyle: React.CSSProperties = {
  border: 'none',
  background: 'rgba(248,250,252,0.94)',
  color: '#475569',
  padding: 0,
  margin: 0,
  fontSize: 9,
  fontWeight: 800,
  cursor: 'pointer',
  lineHeight: 1,
}


const unifiedPricingPaymentCardInnerStyle: React.CSSProperties = {
  display: 'grid',
  gap: 0,
  minHeight: '100%',
}

const unifiedBudgetSliderStyle: React.CSSProperties = {
  width: '100%',
  margin: 0,
  accentColor: '#2563EB',
  minWidth: 0,
  maxWidth: '100%',
  height: 46,
  minHeight: 46,
  padding: '13px 0',
  cursor: 'pointer',
  touchAction: 'pan-x',
  WebkitTapHighlightColor: 'transparent',
  boxSizing: 'border-box',
  position: 'relative',
  zIndex: 2,
}

const unifiedBudgetScaleRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  marginTop: 2,
  paddingInline: 12,
  pointerEvents: 'none',
  userSelect: 'none',
}

const unifiedBudgetScaleLabelStyle: React.CSSProperties = {
  fontSize: 9.5,
  fontWeight: 700,
  color: '#94A3B8',
  lineHeight: 1,
}

const unifiedBudgetScaleValueStyle: React.CSSProperties = {
  fontSize: 12.5,
  fontWeight: 900,
  color: '#1D4ED8',
  lineHeight: 1,
  whiteSpace: 'nowrap',
  fontVariantNumeric: 'tabular-nums',
  minWidth: 46,
  textAlign: 'end',
}

const budgetGuidanceChipStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: 20,
  padding: '0 8px',
  borderRadius: 999,
  fontSize: 10.5,
  fontWeight: 800,
  lineHeight: 1,
  border: '1px solid transparent',
  whiteSpace: 'nowrap',
}

const budgetGuidanceChipLowStyle: React.CSSProperties = {
  background: 'rgba(254, 243, 199, 0.82)',
  borderColor: 'rgba(245, 158, 11, 0.22)',
  color: '#B45309',
}

const budgetGuidanceChipMediumStyle: React.CSSProperties = {
  background: 'rgba(219, 234, 254, 0.78)',
  borderColor: 'rgba(59, 130, 246, 0.18)',
  color: '#1D4ED8',
}

const budgetGuidanceChipHighStyle: React.CSSProperties = {
  background: 'rgba(220, 252, 231, 0.78)',
  borderColor: 'rgba(16, 185, 129, 0.18)',
  color: '#047857',
}

const dogWalkerPricingStackStyle: React.CSSProperties = {
  display: 'grid',
  gap: 6,
}

const pricingMetaRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  minWidth: 0,
}

const dogWalkerDurationSliderRowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(88px, auto) minmax(0, 1fr)',
  gap: 12,
  alignItems: 'start',
}

const dogWalkerDurationInlineStyle: React.CSSProperties = {
  display: 'grid',
  gap: 6,
  minWidth: 0,
  alignContent: 'start',
}

const dogWalkerSliderInlineStyle: React.CSSProperties = {
  display: 'grid',
  gap: 4,
  minWidth: 0,
  position: 'relative',
  zIndex: 1,
  paddingBlock: 4,
}

const dogWalkerSliderOnlyRowStyle: React.CSSProperties = {
  display: 'grid',
  gap: 2,
  minWidth: 0,
}

const fixedVisitSliderWrapStyle: React.CSSProperties = {
  display: 'grid',
  gap: 5,
  minWidth: 0,
  width: '100%',
  maxWidth: '100%',
  paddingInline: 2,
  paddingBlock: 4,
  boxSizing: 'border-box',
}

const budgetGuidanceInlineRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 10,
  minWidth: 0,
  paddingTop: 2,
  pointerEvents: 'none',
}

const budgetGuidanceInlineTextStyle: React.CSSProperties = {
  minWidth: 0,
  flex: 1,
  textAlign: 'start',
  fontSize: 10,
  lineHeight: 1.3,
  fontWeight: 600,
  color: '#64748B',
  overflow: 'hidden',
  whiteSpace: 'normal',
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
}

const fixedVisitGuidanceStackStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr)',
  justifyItems: 'start',
  alignItems: 'start',
  gap: 4,
  minWidth: 0,
  paddingTop: 4,
}

const fixedVisitGuidanceTextStyle: React.CSSProperties = {
  minWidth: 0,
  width: '100%',
  fontSize: 10.5,
  lineHeight: 1.35,
  fontWeight: 700,
  color: '#64748B',
  whiteSpace: 'normal',
  overflow: 'hidden',
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflowWrap: 'anywhere',
  wordBreak: 'break-word',
}

const unifiedPaymentRowWrapStyle: React.CSSProperties = {
  borderTop: '1px solid rgba(191, 219, 254, 0.52)',
  paddingTop: 8,
  marginTop: 2,
}

const stickyCtaWrapBabysitterStyle: React.CSSProperties = {
  paddingTop: 6,
}

const stickyCtaWrapDogWalkerStyle: React.CSSProperties = {
  paddingTop: 6,
}

const paymentGuidedFieldShellStyle: React.CSSProperties = {
  border: '1px solid rgba(59,130,246,0.55)',
  borderRadius: 20,
  padding: '6px 8px',
  background: 'rgba(239,246,255,0.9)',
  boxShadow: '0 0 0 2px rgba(59,130,246,0.10)',
}

const stickyCtaWrapStyle: React.CSSProperties = {
  padding: '0 16px calc(2px + env(safe-area-inset-bottom, 0px))',
  borderTop: '1px solid rgba(255,255,255,0.72)',
  background: 'rgba(255,255,255,0.82)',
  flexShrink: 0,
  backdropFilter: 'blur(24px)',
  WebkitBackdropFilter: 'blur(24px)',
}

const stickyActionZoneStyle: React.CSSProperties = {
  display: 'grid',
  gap: 10,
  marginInlineStart: 'calc(-16px - env(safe-area-inset-left, 0px))',
  marginInlineEnd: 'calc(-16px - env(safe-area-inset-right, 0px))',
  padding: '10px calc(26px + env(safe-area-inset-right, 0px)) 8px calc(26px + env(safe-area-inset-left, 0px))',
  borderRadius: 24,
  background: 'linear-gradient(180deg, rgba(239,246,255,0.98) 0%, rgba(248,250,252,0.94) 100%)',
  border: '1px solid rgba(147, 197, 253, 0.26)',
  boxShadow: '0 12px 26px rgba(37, 99, 235, 0.08), inset 0 1px 0 rgba(255,255,255,0.72)',
}

const guidedCtaHelperStyle: React.CSSProperties = {
  marginBottom: 0,
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

const stickyPaymentNoticeStyle: React.CSSProperties = {
  marginTop: 7,
  width: '100%',
  boxSizing: 'border-box',
  padding: '2px 2px 0',
  borderRadius: 0,
  background: 'transparent',
  border: 'none',
  boxShadow: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 4,
  fontSize: 10.5,
  fontWeight: 600,
  lineHeight: 1.2,
  color: '#1D4ED8',
  textAlign: 'center',
  minWidth: 0,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
}

const paymentInfoIconStyle: React.CSSProperties = {
  width: 14,
  height: 14,
  minWidth: 14,
  borderRadius: 999,
  background: 'rgba(59, 130, 246, 0.14)',
  color: '#2563EB',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 9,
  fontWeight: 900,
  lineHeight: 1,
  marginTop: 0,
  flexShrink: 0,
}

const stickyActionRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
}

const mapCalloutsWrapStyle: React.CSSProperties = {
  position: 'absolute',
  left: 14,
  right: 14,
  top: 'calc(72px + env(safe-area-inset-top, 0px))',
  zIndex: 2,
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
  pointerEvents: 'none',
  alignItems: 'flex-start',
}

const mapCalloutPillStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  minWidth: 0,
  maxWidth: 'min(100%, 240px)',
  padding: '8px 10px',
  borderRadius: 16,
  background: 'rgba(255,255,255,0.94)',
  border: '1px solid rgba(226, 232, 240, 0.86)',
  boxShadow: '0 10px 24px rgba(15, 23, 42, 0.10)',
  backdropFilter: 'blur(18px)',
  WebkitBackdropFilter: 'blur(18px)',
}

const mapCalloutIconStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 22,
  height: 22,
  minWidth: 22,
  borderRadius: 999,
  background: 'rgba(219, 234, 254, 0.92)',
  fontSize: 11,
  lineHeight: 1,
}

const mapCalloutTextWrapStyle: React.CSSProperties = {
  display: 'grid',
  gap: 1,
  minWidth: 0,
}

const mapCalloutLabelStyle: React.CSSProperties = {
  fontSize: 9.5,
  fontWeight: 800,
  lineHeight: 1.1,
  color: '#2563EB',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
}

const mapCalloutValueStyle: React.CSSProperties = {
  fontSize: 11.5,
  fontWeight: 800,
  lineHeight: 1.2,
  color: '#0F172A',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const stickyCalendarButtonStyle: React.CSSProperties = {
  width: 58,
  minWidth: 58,
  height: 58,
  minHeight: 58,
  alignSelf: 'flex-start',
  borderRadius: 20,
  border: '1px solid rgba(148, 163, 184, 0.18)',
  background: 'rgba(248,250,252,0.92)',
  color: '#0F172A',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  boxShadow: '0 8px 20px rgba(15, 23, 42, 0.08), inset 0 1px 0 rgba(255,255,255,0.72)',
  WebkitTapHighlightColor: 'transparent',
}

const stickyCalendarButtonActiveStyle: React.CSSProperties = {
  borderColor: 'rgba(96, 165, 250, 0.34)',
  background: 'rgba(239,246,255,0.96)',
  color: '#1D4ED8',
}

const stickyCalendarButtonDisabledStyle: React.CSSProperties = {
  opacity: 0.48,
  cursor: 'not-allowed',
  boxShadow: 'none',
}

const bookingPrimaryButtonStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 58,
  borderRadius: 20,
  border: '1px solid rgba(15, 23, 42, 0.04)',
  background: 'linear-gradient(180deg, #172554 0%, #0F172A 100%)',
  color: '#FFFFFF',
  fontSize: 16,
  fontWeight: 800,
  letterSpacing: -0.2,
  cursor: 'pointer',
  boxShadow: '0 14px 28px rgba(15, 23, 42, 0.18), inset 0 1px 0 rgba(255,255,255,0.10)',
  fontFamily: 'inherit',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  transition: 'opacity 140ms ease, transform 140ms ease, box-shadow 140ms ease',
  WebkitTapHighlightColor: 'transparent',
}

const bookingPrimaryButtonDisabledStyle: React.CSSProperties = {
  background: 'linear-gradient(180deg, #CBD5E1 0%, #E2E8F0 100%)',
  color: '#64748B',
  boxShadow: 'none',
  cursor: 'not-allowed',
}

const bookingPrimaryButtonLoadingStyle: React.CSSProperties = {
  opacity: 0.92,
}

const bookingPrimarySpinnerStyle: React.CSSProperties = {
  display: 'inline-block',
  width: 16,
  height: 16,
  border: '2px solid rgba(255,255,255,0.28)',
  borderTopColor: '#FFFFFF',
  borderRadius: '50%',
  animation: 'completionSpin 0.6s linear infinite',
  flexShrink: 0,
}

const stickyCalendarDotStyle: React.CSSProperties = {
  position: 'absolute',
  right: 8,
  top: 8,
  width: 8,
  height: 8,
  borderRadius: 999,
  background: '#EF4444',
  border: '2px solid #FFFFFF',
  boxShadow: '0 2px 6px rgba(239, 68, 68, 0.3)',
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
  padding: 0,
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
  background: 'rgba(2, 6, 23, 0.58)',
}

const completionOverlayCardStyle: React.CSSProperties = {
  position: 'relative',
  width: '100%',
  maxWidth: '100%',
  boxSizing: 'border-box',
  overflow: 'hidden',
  borderTopLeftRadius: 30,
  borderTopRightRadius: 30,
  borderBottomLeftRadius: 0,
  borderBottomRightRadius: 0,
}

const pendingConfirmCardStyle: React.CSSProperties = {
  background: 'linear-gradient(180deg, rgba(14,17,22,0.94) 0%, rgba(20,24,31,0.96) 100%)',
  border: '1px solid rgba(148, 163, 184, 0.12)',
  borderRadius: '30px 30px 0 0',
  minHeight: 392,
  padding: '22px 16px calc(20px + env(safe-area-inset-bottom, 0px))',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 14,
  boxShadow: '0 20px 40px rgba(2, 6, 23, 0.30), inset 0 1px 0 rgba(255,255,255,0.04)',
  backdropFilter: 'blur(24px)',
  WebkitBackdropFilter: 'blur(24px)',
  textAlign: 'center',
}

const pendingConfirmIconStyle: React.CSSProperties = {
  fontSize: 40,
  lineHeight: 1,
}

const pendingConfirmTitleStyle: React.CSSProperties = {
  fontSize: 20,
  fontWeight: 900,
  color: '#F8FAFC',
}

const pendingConfirmSubtitleStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  color: 'rgba(203, 213, 225, 0.86)',
  lineHeight: 1.4,
}

const pendingConfirmErrorStyle: React.CSSProperties = {
  width: '100%',
  borderRadius: 16,
  border: '1px solid rgba(220, 38, 38, 0.16)',
  background: 'rgba(254, 242, 242, 0.96)',
  color: '#B91C1C',
  padding: '12px 14px',
  fontSize: 14,
  lineHeight: 1.5,
  textAlign: 'center',
}

const pendingConfirmBtnStyle: React.CSSProperties = {
  appearance: 'none',
  border: 'none',
  width: '100%',
  minHeight: 50,
  borderRadius: 16,
  background: 'linear-gradient(180deg, #16A34A 0%, #15803D 100%)',
  color: '#FFFFFF',
  fontSize: 16,
  fontWeight: 900,
  cursor: 'pointer',
  marginTop: 4,
  boxShadow: '0 12px 28px rgba(21,128,61,0.20)',
}

const pendingRejectBtnStyle: React.CSSProperties = {
  appearance: 'none',
  border: '1.5px solid rgba(96, 165, 250, 0.16)',
  width: '100%',
  minHeight: 46,
  borderRadius: 16,
  background: 'rgba(17, 24, 39, 0.78)',
  color: '#60A5FA',
  fontSize: 15,
  fontWeight: 800,
  cursor: 'pointer',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.03)',
}

const tipCardStyle: React.CSSProperties = {
  position: 'relative',
  width: '100%',
  minHeight: 326,
  borderRadius: '30px 30px 0 0',
  background: 'linear-gradient(180deg, rgba(14,17,22,0.94) 0%, rgba(20,24,31,0.96) 100%)',
  border: '1px solid rgba(148, 163, 184, 0.12)',
  boxShadow: '0 20px 40px rgba(2, 6, 23, 0.30), inset 0 1px 0 rgba(255,255,255,0.04)',
  backdropFilter: 'blur(24px)',
  WebkitBackdropFilter: 'blur(24px)',
  padding: '16px 14px calc(16px + env(safe-area-inset-bottom, 0px))',
  display: 'grid',
  gap: 12,
  textAlign: 'center',
  boxSizing: 'border-box',
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
  color: '#F8FAFC',
  lineHeight: 1.18,
}

const tipSubtitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  color: 'rgba(203, 213, 225, 0.86)',
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
  border: '1px solid rgba(96, 165, 250, 0.16)',
  background: 'rgba(17, 24, 39, 0.78)',
  color: '#60A5FA',
  fontSize: 16,
  fontWeight: 900,
  cursor: 'pointer',
  fontFamily: 'inherit',
}

const tipCustomToggleStyle: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: '#60A5FA',
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
  border: '1px solid rgba(148, 163, 184, 0.16)',
  padding: '0 12px',
  fontSize: 15,
  fontWeight: 800,
  color: '#F8FAFC',
  background: 'rgba(15, 23, 42, 0.92)',
  outline: 'none',
  boxSizing: 'border-box',
}

const tipCustomSubmitStyle: React.CSSProperties = {
  height: 44,
  borderRadius: 14,
  border: 'none',
  background: 'linear-gradient(180deg, #38BDF8 0%, #2563EB 100%)',
  color: '#FFFFFF',
  padding: '0 16px',
  fontSize: 14,
  fontWeight: 900,
  cursor: 'pointer',
  fontFamily: 'inherit',
  boxShadow: '0 12px 28px rgba(37,99,235,0.18)',
}

const tipSkipButtonStyle: React.CSSProperties = {
  height: 44,
  borderRadius: 14,
  border: '1px solid rgba(96, 165, 250, 0.16)',
  background: 'rgba(17, 24, 39, 0.78)',
  color: '#60A5FA',
  fontSize: 14,
  fontWeight: 800,
  cursor: 'pointer',
  fontFamily: 'inherit',
}

const trackingCardStyle: React.CSSProperties = {
  width: '100%',
  maxWidth: '100%',
  minHeight: 300,
  borderRadius: '30px 30px 0 0',
  border: '1px solid rgba(148, 163, 184, 0.12)',
  background: 'linear-gradient(180deg, rgba(14,17,22,0.94) 0%, rgba(20,24,31,0.96) 100%)',
  padding: '14px 14px calc(14px + env(safe-area-inset-bottom, 0px))',
  display: 'grid',
  gap: 10,
  boxSizing: 'border-box',
  overflow: 'hidden',
  pointerEvents: 'auto',
  boxShadow: '0 20px 40px rgba(2, 6, 23, 0.30), inset 0 1px 0 rgba(255,255,255,0.04)',
  backdropFilter: 'blur(24px)',
  WebkitBackdropFilter: 'blur(24px)',
}

const trackingArrivedCardCompactStyle: React.CSSProperties = {
  padding: '13px 14px calc(13px + env(safe-area-inset-bottom, 0px))',
  gap: 9,
}

const trackingActiveCardCompactStyle: React.CSSProperties = {
  minHeight: 264,
  padding: '13px 14px calc(13px + env(safe-area-inset-bottom, 0px))',
  gap: 8,
}

const trackingTopUtilityRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  minWidth: 0,
}

const trackingTopBadgeStyle: React.CSSProperties = {
  justifySelf: 'start',
  flexShrink: 0,
  padding: '6px 10px',
  borderRadius: 999,
  fontSize: 12,
  fontWeight: 800,
  letterSpacing: 0.2,
}

const trackingTopBadgeTravelStyle: React.CSSProperties = {
  background: 'rgba(59, 130, 246, 0.14)',
  color: '#93C5FD',
}

const trackingTopBadgeArrivedStyle: React.CSSProperties = {
  background: 'rgba(59, 130, 246, 0.14)',
  color: '#93C5FD',
}

const trackingTopBadgeReadyStyle: React.CSSProperties = {
  background: 'rgba(59, 130, 246, 0.14)',
  color: '#93C5FD',
}

const trackingTopBadgeActiveStyle: React.CSSProperties = {
  background: 'rgba(59, 130, 246, 0.14)',
  color: '#93C5FD',
}

const trackingHeroRowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  alignItems: 'center',
  gap: 12,
}

const trackingHeroLeadStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  minWidth: 0,
}

const trackingHeroAvatarWrapStyle: React.CSSProperties = {
  position: 'relative',
  flexShrink: 0,
  filter: 'drop-shadow(0 10px 18px rgba(2, 6, 23, 0.18))',
}

const trackingHeroOnlineDotStyle: React.CSSProperties = {
  position: 'absolute',
  right: 2,
  bottom: 2,
  width: 13,
  height: 13,
  borderRadius: '50%',
  background: '#22C55E',
  border: '2px solid rgba(15, 23, 42, 0.92)',
  boxSizing: 'border-box',
}

const trackingHeroCopyStyle: React.CSSProperties = {
  display: 'grid',
  gap: 5,
  minWidth: 0,
}

const trackingHeroNameStyle: React.CSSProperties = {
  fontSize: 23,
  fontWeight: 900,
  color: '#F8FAFC',
  lineHeight: 1.02,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const trackingHeroMetaStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  minWidth: 0,
  fontSize: 12.5,
  fontWeight: 700,
  color: 'rgba(203, 213, 225, 0.88)',
  flexWrap: 'wrap',
}

const trackingHeroStarStyle: React.CSSProperties = {
  color: '#FBBF24',
  fontSize: 14,
  lineHeight: 1,
}

const trackingHeroDotStyle: React.CSSProperties = {
  color: 'rgba(148, 163, 184, 0.64)',
}

const trackingHeroEtaBadgeStyle: React.CSSProperties = {
  minWidth: 116,
  width: 116,
  minHeight: 88,
  padding: '10px 12px',
  borderRadius: 26,
  border: '1px solid rgba(125, 211, 252, 0.28)',
  background: 'linear-gradient(180deg, rgba(224,242,254,0.16) 0%, rgba(186,230,253,0.10) 100%)',
  display: 'grid',
  gap: 3,
  justifyItems: 'center',
  textAlign: 'center',
  alignContent: 'center',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08)',
}

const trackingHeroEtaLabelStyle: React.CSSProperties = {
  fontSize: 10.5,
  fontWeight: 800,
  color: 'rgba(186, 230, 253, 0.88)',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
}

const trackingHeroEtaValueStyle: React.CSSProperties = {
  fontSize: 20,
  fontWeight: 900,
  color: '#F8FAFC',
  lineHeight: 1.02,
  fontVariantNumeric: 'tabular-nums',
}

const trackingServiceStartedRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 0,
  flexWrap: 'wrap',
}

const trackingServiceStartedPillStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: 28,
  padding: '0 10px',
  borderRadius: 999,
  background: 'rgba(34, 197, 94, 0.14)',
  border: '1px solid rgba(74, 222, 128, 0.16)',
  color: '#86EFAC',
  fontSize: 11.5,
  fontWeight: 800,
}

const trackingBioCardStyle: React.CSSProperties = {
  borderRadius: 18,
  border: '1px solid rgba(148, 163, 184, 0.10)',
  background: 'rgba(255,255,255,0.04)',
  padding: '12px 14px',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.03)',
}

const trackingBioTextStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.5,
  color: 'rgba(226, 232, 240, 0.90)',
}

const trackingTopActionChipStyle: React.CSSProperties = {
  minWidth: 116,
  width: 116,
  maxWidth: 116,
  minHeight: 30,
  padding: '0 12px',
  borderRadius: 999,
  border: '1px solid rgba(191, 219, 254, 0.22)',
  background: 'rgba(255,255,255,0.10)',
  color: '#F8FAFC',
  fontSize: 11.5,
  fontWeight: 800,
  cursor: 'pointer',
  fontFamily: 'inherit',
  flexShrink: 0,
  transition: 'transform 120ms ease, opacity 120ms ease, background 120ms ease, border-color 120ms ease',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08)',
}

const trackingTopActionChipWhatsAppStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.12)',
  borderColor: 'rgba(74, 222, 128, 0.16)',
}

const trackingTopActionChipInnerStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 7,
  width: '100%',
  minWidth: 0,
}

const trackingTopActionChipTextStyle: React.CSSProperties = {
  display: 'block',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  textAlign: 'center',
  lineHeight: 1,
}

const trackingCommunicationWhatsAppDotStyle: React.CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: 999,
  background: '#22C55E',
  boxShadow: '0 0 0 4px rgba(34, 197, 94, 0.16)',
  flexShrink: 0,
}

const trackingTitleStyle: React.CSSProperties = {
  fontSize: 20,
  fontWeight: 900,
  color: '#F8FAFC',
  lineHeight: 1.08,
  minWidth: 0,
  overflowWrap: 'anywhere',
}

const trackingSubtitleStyle: React.CSSProperties = {
  fontSize: 13,
  color: 'rgba(203, 213, 225, 0.84)',
  lineHeight: 1.38,
  minWidth: 0,
  overflowWrap: 'anywhere',
}

const trackingStatsGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  gap: 8,
  minWidth: 0,
}

const trackingStatCardStyle: React.CSSProperties = {
  minWidth: 0,
  borderRadius: 16,
  background: 'transparent',
  border: '1px solid rgba(148, 163, 184, 0.10)',
  padding: '12px 10px',
  display: 'grid',
  gap: 6,
  justifyItems: 'center',
  boxSizing: 'border-box',
}

const trackingEtaStatCardStyle: React.CSSProperties = {
  background: 'transparent',
  borderColor: 'rgba(96, 165, 250, 0.14)',
}

const trackingStatLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  color: 'rgba(148, 163, 184, 0.82)',
  textTransform: 'uppercase',
  letterSpacing: 0.6,
}

const trackingStatValueStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 900,
  color: '#F8FAFC',
  textAlign: 'center',
  minWidth: 0,
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const trackingTimerPanelStyle: React.CSSProperties = {
  marginTop: 8,
  borderRadius: 18,
  background: 'transparent',
  border: '1px solid rgba(148, 163, 184, 0.10)',
  padding: '13px 14px',
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
  color: 'rgba(148, 163, 184, 0.82)',
}

const trackingTimerValueStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 800,
  color: '#F8FAFC',
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
  color: 'rgba(203, 213, 225, 0.84)',
}

const trackingArrivalActionWrapStyle: React.CSSProperties = {
  marginTop: 10,
}

const trackingArrivalActionButtonStyle: React.CSSProperties = {
  appearance: 'none',
  width: '100%',
  minHeight: 46,
  borderRadius: 16,
  border: '1px solid rgba(96, 165, 250, 0.16)',
  background: 'transparent',
  color: '#60A5FA',
  fontSize: 15,
  fontWeight: 800,
  cursor: 'pointer',
  WebkitTapHighlightColor: 'transparent',
}

const trackingArrivalActionButtonBusyStyle: React.CSSProperties = {
  opacity: 0.68,
  cursor: 'wait',
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
  top: 0,
  bottom: 0,
  width: 'min(380px, calc(100% - 44px))',
  maxWidth: 'calc(100% - 44px)',
  background: '#FFFFFF',
  boxShadow: '0 24px 60px rgba(15, 23, 42, 0.22)',
  zIndex: 40001,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  boxSizing: 'border-box',
  paddingTop: 'calc(22px + env(safe-area-inset-top))',
  paddingBottom: 'calc(18px + env(safe-area-inset-bottom))',
}

const menuPanelLtrStyle: React.CSSProperties = {
  left: 0,
  borderTopRightRadius: 28,
  borderBottomRightRadius: 28,
}

const menuPanelRtlStyle: React.CSSProperties = {
  right: 0,
  borderTopLeftRadius: 28,
  borderBottomLeftRadius: 28,
}

const menuHeaderRowStyle: React.CSSProperties = {
  padding: '0 16px 10px',
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
  padding: '0 16px 12px',
  display: 'flex',
  flexDirection: 'column',
}

const menuButtonWrapStyle: React.CSSProperties = {
  position: 'relative',
  display: 'inline-flex',
  alignItems: 'flex-start',
  pointerEvents: 'auto',
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

const menuProfilePhotoButtonStyle: React.CSSProperties = {
  appearance: 'none',
  marginTop: 8,
  border: '1px solid #E2E8F0',
  background: '#FFFFFF',
  color: '#334155',
  borderRadius: 999,
  padding: '6px 10px',
  fontSize: 11,
  fontWeight: 800,
  cursor: 'pointer',
  fontFamily: 'inherit',
}

const uploadStatusStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#64748B',
}

const uploadErrorStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#DC2626',
}

const menuRowListStyle: React.CSSProperties = {
  display: 'grid',
  gap: 10,
  marginBottom: 16,
}

const menuNavRowStyle: React.CSSProperties = {
  width: '100%',
  border: '1px solid #E2E8F0',
  background: '#FFFFFF',
  borderRadius: 18,
  padding: '14px 16px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  cursor: 'pointer',
  textAlign: 'left',
  fontFamily: 'inherit',
}

const menuNavRowDestructiveStyle: React.CSSProperties = {
  borderColor: 'rgba(239, 68, 68, 0.16)',
  background: '#FFF7F7',
}

const menuNavLeadingStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  minWidth: 0,
}

const menuNavIconStyle: React.CSSProperties = {
  fontSize: 18,
  lineHeight: 1,
  flexShrink: 0,
}

const menuNavLabelStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 800,
  color: '#0F172A',
}

const menuNavLabelDestructiveStyle: React.CSSProperties = {
  color: '#DC2626',
}

const menuNavChevronStyle: React.CSSProperties = {
  color: '#94A3B8',
  fontSize: 22,
  lineHeight: 1,
  flexShrink: 0,
}

const menuNavChevronDestructiveStyle: React.CSSProperties = {
  color: '#F87171',
}

const burgerSectionStyle: React.CSSProperties = {
  display: 'grid',
  gap: 2,
  paddingBottom: 14,
}

const settingsPageContentStyle: React.CSSProperties = {
  paddingTop: 16,
  display: 'flex',
  flexDirection: 'column',
  minHeight: '100%',
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

const settingsSectionBodyStyle: React.CSSProperties = {
  marginTop: 10,
}

const clientSettingsLanguageSelectorRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 6,
  maxWidth: 116,
}

const clientSettingsLanguageButtonStyle: React.CSSProperties = {
  minWidth: 54,
  height: 28,
  borderRadius: 10,
  border: '1px solid #E2E8F0',
  background: '#FFFFFF',
  color: '#0F172A',
  fontSize: 11,
  fontWeight: 800,
  cursor: 'pointer',
  fontFamily: 'inherit',
  padding: '0 8px',
}

const clientSettingsLanguageButtonActiveStyle: React.CSSProperties = {
  borderColor: '#5B7CFA',
  background: '#EEF4FF',
  color: '#3152C8',
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

const menuFooterActionWrapStyle: React.CSSProperties = {
  marginTop: 'auto',
  paddingTop: 18,
}

const scheduleSheetStyle: React.CSSProperties = {
  position: 'fixed',
  left: 0,
  right: 0,
  bottom: 0,
  zIndex: 40002,
  background: '#FFFFFF',
  borderTopLeftRadius: 30,
  borderTopRightRadius: 30,
  boxShadow: '0 -20px 56px rgba(15, 23, 42, 0.18)',
  display: 'flex',
  flexDirection: 'column',
  boxSizing: 'border-box',
  padding: '12px 16px calc(18px + env(safe-area-inset-bottom))',
}

const scheduleSheetHandleStyle: React.CSSProperties = {
  width: 42,
  height: 5,
  borderRadius: 999,
  background: 'rgba(148, 163, 184, 0.45)',
  margin: '0 auto 8px',
  flexShrink: 0,
}

const scheduleSheetHeaderStyle: React.CSSProperties = {
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 10,
  marginBottom: 14,
}

const scheduleSheetHeaderCopyStyle: React.CSSProperties = {
  width: '100%',
  minWidth: 0,
  display: 'grid',
  gap: 2,
  textAlign: 'center',
  paddingTop: 2,
}

const scheduleSheetTitleStyle: React.CSSProperties = {
  fontSize: 22,
  lineHeight: 1.2,
  fontWeight: 900,
  color: '#0F172A',
  letterSpacing: '-0.03em',
}

const scheduleSheetSubtitleStyle: React.CSSProperties = {
  fontSize: 11.5,
  lineHeight: 1.3,
  color: '#64748B',
}

const scheduleSheetCloseButtonStyle: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  right: 0,
  width: 36,
  height: 36,
  borderRadius: 14,
  border: '1px solid rgba(203, 213, 225, 0.9)',
  background: '#F8FAFC',
  color: '#0F172A',
  fontSize: 16,
  fontWeight: 800,
  cursor: 'pointer',
  flexShrink: 0,
  display: 'grid',
  placeItems: 'center',
}

const scheduleSheetScrollStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  maxHeight: 'min(78vh, 620px)',
  minHeight: 332,
  overflowY: 'auto',
  scrollbarWidth: 'none',
  msOverflowStyle: 'none',
  WebkitOverflowScrolling: 'touch',
}

const schedulePageContentStyle: React.CSSProperties = {
  width: '100%',
  maxWidth: 'none',
  margin: '0 auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
}

const scheduleModeBodyStyle: React.CSSProperties = {
  minHeight: 312,
  display: 'flex',
  alignItems: 'stretch',
}

const schedulePresetRowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 8,
}

const schedulePresetButtonStyle: React.CSSProperties = {
  borderRadius: 999,
  border: '1px solid rgba(203, 213, 225, 0.95)',
  background: 'rgba(248, 250, 252, 0.96)',
  color: '#0F172A',
  minHeight: 46,
  padding: '10px 14px',
  fontSize: 13.5,
  fontWeight: 800,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  whiteSpace: 'nowrap',
}

const schedulePresetButtonActiveStyle: React.CSSProperties = {
  background: 'linear-gradient(180deg, #172554 0%, #0F172A 100%)',
  borderColor: '#0F172A',
  color: '#FFFFFF',
  boxShadow: '0 8px 18px rgba(15, 23, 42, 0.12)',
}

const schedulePickerCardStyle: React.CSSProperties = {
  borderRadius: 22,
  border: '1px solid rgba(226, 232, 240, 0.95)',
  background: 'linear-gradient(180deg, #FFFFFF 0%, #F8FAFC 100%)',
  padding: 10,
  boxShadow: '0 10px 20px rgba(15, 23, 42, 0.05)',
}

const scheduleCompactCardStyle: React.CSSProperties = {
  ...schedulePickerCardStyle,
  width: '100%',
  padding: 14,
  borderRadius: 26,
  boxShadow: '0 14px 28px rgba(15, 23, 42, 0.06)',
}

const WHEEL_ROW_HEIGHT = 24
const SCHEDULE_WHEEL_ROW_HEIGHT = 44

const scheduleLaterSummaryStyle: React.CSSProperties = {
  display: 'grid',
  gap: 6,
  marginBottom: 16,
  padding: '6px 2px 2px',
  textAlign: 'center',
}

const scheduleLaterSummaryValueStyle: React.CSSProperties = {
  fontSize: 24,
  lineHeight: 1.15,
  fontWeight: 900,
  color: '#2563EB',
  letterSpacing: '-0.04em',
}

const scheduleLaterSummaryHelperStyle: React.CSSProperties = {
  fontSize: 13.5,
  lineHeight: 1.35,
  fontWeight: 800,
  color: '#2563EB',
}

const scheduleWheelHeaderRowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1.8fr 0.8fr 0.8fr',
  gap: 10,
  marginBottom: 10,
  paddingInline: 8,
}

const scheduleWheelHeaderLabelStyle: React.CSSProperties = {
  fontSize: 11.5,
  lineHeight: 1.2,
  fontWeight: 800,
  color: '#64748B',
  textAlign: 'center',
}

const scheduleWheelWrapStyle: React.CSSProperties = {
  position: 'relative',
  height: SCHEDULE_WHEEL_ROW_HEIGHT * 5,
  borderRadius: 24,
  background: 'linear-gradient(180deg, #F8FAFC 0%, #FFFFFF 100%)',
  border: '1px solid rgba(226, 232, 240, 0.95)',
  overflow: 'hidden',
}

const scheduleWheelColumnsStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1.8fr 0.8fr 0.8fr',
  gap: 10,
  height: '100%',
  padding: '0 8px',
}

const repeatWheelHeaderRowStyle: React.CSSProperties = {
  ...scheduleWheelHeaderRowStyle,
  gridTemplateColumns: '1fr 1fr',
}

const repeatWheelColumnsStyle: React.CSSProperties = {
  ...scheduleWheelColumnsStyle,
  gridTemplateColumns: '1fr 1fr',
}

const scheduleWheelHighlightStyle: React.CSSProperties = {
  position: 'absolute',
  left: 8,
  right: 8,
  top: '50%',
  height: SCHEDULE_WHEEL_ROW_HEIGHT,
  transform: 'translateY(-50%)',
  borderRadius: 18,
  background: 'linear-gradient(180deg, rgba(37, 99, 235, 0.1) 0%, rgba(59, 130, 246, 0.14) 100%)',
  border: '1px solid rgba(96, 165, 250, 0.34)',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.9), 0 10px 24px rgba(59, 130, 246, 0.12)',
  pointerEvents: 'none',
}

const scheduleInlineCaptionStyle: React.CSSProperties = {
  fontSize: 12,
  lineHeight: 1.2,
  fontWeight: 700,
  color: '#2563EB',
  textAlign: 'center',
  marginBottom: 8,
}

const scheduleInlineWarningStyle: React.CSSProperties = {
  fontSize: 11,
  lineHeight: 1.3,
  fontWeight: 700,
  color: '#B45309',
  textAlign: 'center',
}

const scheduleSheetFooterStyle: React.CSSProperties = {
  paddingTop: 2,
}

const wheelPickerColumnStyle: React.CSSProperties = {
  position: 'relative',
  height: '100%',
  overflowY: 'auto',
  scrollbarWidth: 'none',
  msOverflowStyle: 'none',
  WebkitOverflowScrolling: 'touch',
  scrollSnapType: 'y mandatory',
}

const wheelPickerColumnWideStyle: React.CSSProperties = {
  paddingInline: 4,
}

const wheelPickerSpacerStyle: React.CSSProperties = {
  height: WHEEL_ROW_HEIGHT * 2,
  flexShrink: 0,
}

const wheelPickerOptionStyle: React.CSSProperties = {
  width: '100%',
  height: WHEEL_ROW_HEIGHT,
  border: 'none',
  background: 'transparent',
  padding: '0 8px',
  fontSize: 14,
  lineHeight: 1,
  cursor: 'pointer',
  fontFamily: 'inherit',
  transition: 'opacity 120ms ease, transform 120ms ease, color 120ms ease',
  scrollSnapAlign: 'center',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const scheduleWheelPickerOptionStyle: React.CSSProperties = {
  padding: '0 12px',
  fontSize: 17,
  letterSpacing: '-0.02em',
}

const repeatTimeInlineWrapStyle: React.CSSProperties = {
  display: 'grid',
  gap: 10,
  marginTop: 12,
}

const repeatTimeInlineSummaryStyle: React.CSSProperties = {
  fontSize: 12.5,
  lineHeight: 1.35,
  fontWeight: 700,
  color: '#334155',
  textAlign: 'center',
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

const favoriteMenuProfileButtonStyle: React.CSSProperties = {
  appearance: 'none',
  border: 'none',
  background: 'transparent',
  padding: 0,
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  minWidth: 0,
  flex: 1,
  textAlign: 'start',
  cursor: 'pointer',
  fontFamily: 'inherit',
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

const burgerListMetaColumnStyle: React.CSSProperties = {
  display: 'grid',
  gap: 4,
  marginTop: 8,
}

const burgerListMetaStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#475569',
}

const burgerListMetaSubtleStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#94A3B8',
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

const paymentSheetOverlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(15,23,42,0.4)',
  zIndex: 9998,
  animation: 'regliMenuFadeIn 180ms ease',
}

const paymentSheetStyle: React.CSSProperties = {
  position: 'fixed',
  bottom: 0,
  left: 0,
  right: 0,
  zIndex: 9999,
  background: '#FFFFFF',
  borderTopLeftRadius: 24,
  borderTopRightRadius: 24,
  boxShadow: '0 -8px 32px rgba(15,23,42,0.12)',
  padding: '20px 20px calc(20px + env(safe-area-inset-bottom, 0px))',
  animation: 'regliMenuSlideInLeft 220ms cubic-bezier(0.22, 1, 0.36, 1)',
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  maxHeight: '72vh',
  overflowY: 'auto',
}

const paymentSheetHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
}

const paymentSheetTitleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 900,
  color: '#0F172A',
}

const paymentSheetTrustRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  marginTop: -8,
  marginBottom: 3,
}

const paymentSheetTrustTextStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: '#1D4ED8',
  lineHeight: 1.35,
  textAlign: 'center',
}

const paymentSheetTrustBodyStyle: React.CSSProperties = {
  marginBottom: 10,
  padding: '6px 8px 0 8px',
  fontSize: 12,
  lineHeight: 1.4,
  color: '#1E40AF',
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
  textAlign: 'center',
}

const paymentSheetInfoIconStyle: React.CSSProperties = {
  width: 16,
  height: 16,
  minWidth: 16,
  borderRadius: 999,
  background: 'rgba(59, 130, 246, 0.14)',
  color: '#2563EB',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 10,
  fontWeight: 900,
  lineHeight: 1,
}

const paymentSheetCloseStyle: React.CSSProperties = {
  appearance: 'none',
  border: 'none',
  background: 'rgba(241,245,249,0.9)',
  borderRadius: 999,
  width: 32,
  height: 32,
  display: 'grid',
  placeItems: 'center',
  cursor: 'pointer',
  color: '#64748B',
  padding: 0,
}

const paymentSheetCardLeftStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  minWidth: 0,
  flex: 1,
}

const paymentSheetCardBrandStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 800,
  color: '#0F172A',
}

const paymentSheetCardExpStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#94A3B8',
  fontWeight: 600,
  marginTop: 2,
}

const paymentSheetActionsStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
}

const paymentSheetCardsListStyle: React.CSSProperties = {
  display: 'grid',
  gap: 2,
}

const paymentSheetCardOptionStyle: React.CSSProperties = {
  border: 'none',
  borderBottom: '1px solid rgba(226, 232, 240, 0.82)',
  background: 'transparent',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: '0 0 0 2px',
  borderRadius: 0,
  boxShadow: 'none',
}

const paymentSheetCardOptionSelectedStyle: React.CSSProperties = {
  background: 'rgba(239,246,255,0.52)',
}

const paymentSheetCardSelectButtonStyle: React.CSSProperties = {
  appearance: 'none',
  border: 'none',
  background: 'transparent',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: '14px 0',
  cursor: 'pointer',
  textAlign: 'start',
  flex: 1,
  minWidth: 0,
}

const paymentSheetRadioWrapStyle: React.CSSProperties = {
  width: 20,
  height: 20,
  display: 'grid',
  placeItems: 'center',
  flexShrink: 0,
}

const paymentSheetRadioStyle: React.CSSProperties = {
  width: 16,
  height: 16,
  borderRadius: 999,
  border: '1.8px solid #CBD5E1',
  background: '#FFFFFF',
  boxSizing: 'border-box',
}

const paymentSheetRadioSelectedStyle: React.CSSProperties = {
  border: '5px solid #2563EB',
}

const paymentSheetCardMoreButtonStyle: React.CSSProperties = {
  appearance: 'none',
  border: 'none',
  background: 'transparent',
  color: '#94A3B8',
  width: 34,
  height: 34,
  borderRadius: 999,
  display: 'grid',
  placeItems: 'center',
  cursor: 'pointer',
  flexShrink: 0,
  marginInlineStart: 6,
}

const paymentSheetDividerStyle: React.CSSProperties = {
  height: 1,
  background: 'rgba(226, 232, 240, 0.9)',
  marginTop: 4,
  marginBottom: 2,
}

const paymentSheetAddRowStyle: React.CSSProperties = {
  appearance: 'none',
  border: 'none',
  background: 'transparent',
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
  padding: '12px 2px 4px',
  borderRadius: 0,
  fontSize: 14,
  fontWeight: 700,
  color: '#2563EB',
  cursor: 'pointer',
  textAlign: 'start',
}

const paymentSheetAddIconStyle: React.CSSProperties = {
  width: 18,
  height: 18,
  borderRadius: 999,
  background: 'rgba(59,130,246,0.10)',
  color: '#2563EB',
  display: 'grid',
  placeItems: 'center',
  fontSize: 14,
  fontWeight: 900,
  flexShrink: 0,
  marginTop: 1,
}

const paymentSheetAddContentStyle: React.CSSProperties = {
  display: 'grid',
  gap: 6,
  justifyItems: 'start',
}

const paymentSheetBrandHintsStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
}

const paymentSheetBrandHintPillStyle: React.CSSProperties = {
  fontSize: 10.5,
  fontWeight: 700,
  color: '#94A3B8',
  background: 'rgba(248,250,252,0.98)',
  borderRadius: 999,
  padding: '2px 7px',
}

const paymentSheetSetupWrapStyle: React.CSSProperties = {
  paddingTop: 2,
}

const paymentActionsOverlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 10000,
  background: 'transparent',
}

const paymentActionsMenuStyle: React.CSSProperties = {
  position: 'fixed',
  right: 18,
  bottom: 'calc(20px + env(safe-area-inset-bottom, 0px))',
  zIndex: 10001,
  minWidth: 210,
  background: '#FFFFFF',
  border: '1px solid rgba(226, 232, 240, 0.92)',
  borderRadius: 18,
  boxShadow: '0 18px 44px rgba(15, 23, 42, 0.18)',
  padding: 6,
  display: 'grid',
  gap: 2,
}

const paymentActionsMenuButtonStyle: React.CSSProperties = {
  appearance: 'none',
  border: 'none',
  background: 'transparent',
  padding: '12px 14px',
  borderRadius: 12,
  textAlign: 'start',
  fontSize: 14,
  fontWeight: 700,
  color: '#0F172A',
  cursor: 'pointer',
}

const paymentActionsMenuDangerStyle: React.CSSProperties = {
  color: '#DC2626',
}

const paymentDeleteConfirmTextStyle: React.CSSProperties = {
  padding: '10px 14px 4px',
  fontSize: 13,
  lineHeight: 1.45,
  color: '#475569',
  fontWeight: 600,
}

const providerIssueClientCardStyle: React.CSSProperties = {
  borderRadius: '30px 30px 0 0',
  padding: 24,
  background: 'linear-gradient(180deg, rgba(255,251,235,0.98) 0%, rgba(255,255,255,0.98) 100%)',
  border: '1px solid rgba(245, 158, 11, 0.22)',
  boxShadow: '0 18px 44px rgba(15, 23, 42, 0.08)',
  display: 'grid',
  gap: 12,
}

const providerIssueClientBadgeStyle: React.CSSProperties = {
  justifySelf: 'start',
  padding: '6px 12px',
  borderRadius: 999,
  background: 'rgba(245, 158, 11, 0.14)',
  color: '#B45309',
  fontSize: 12,
  fontWeight: 800,
  letterSpacing: '0.01em',
}

const providerIssueClientTitleStyle: React.CSSProperties = {
  color: '#111827',
  fontSize: 24,
  fontWeight: 900,
  lineHeight: 1.05,
}

const providerIssueClientBodyStyle: React.CSSProperties = {
  color: '#6B7280',
  fontSize: 15,
  lineHeight: 1.6,
}
