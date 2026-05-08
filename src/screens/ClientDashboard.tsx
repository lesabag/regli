import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import NotificationsBell from '../components/NotificationsBell'
import MapView from '../components/MapView'
import ActionButton from '../components/ActionButton'
import SearchingSheet from '../components/SearchingSheet'
import CompletionCard from '../components/CompletionCard'
import CardSetupForm from '../components/CardSetupForm'
import ProfileAvatar from '../components/ProfileAvatar'
import GroupedHistory from '../components/GroupedHistory'
import type { HistoryItem } from '../components/GroupedHistory'
import type { GpsQuality } from '../hooks/useJobTracking'
import { useClientFlow } from '../hooks/useClientFlow'
import { useProfilePhoto } from '../hooks/useProfilePhoto'
import { useNearbyWalkers } from '../hooks/useNearbyWalkers'
import { usePushNotifications } from '../hooks/usePushNotifications'
import type { DurationType } from '../lib/payments'
import {
  type ServiceType,
  SERVICE_ICONS,
  SERVICE_I18N_KEYS,
  isServiceAvailable as checkServiceAvailable,
} from '../lib/serviceTypes'
import ServiceSelectorPanel from '../components/ServiceSelectorPanel'
import MoreServicesSheet from '../components/MoreServicesSheet'
import { formatShortAddress } from '../utils/addressFormat'
import { formatDurationFromMinutes, getDurationSummary } from '../utils/serviceTiming'
import i18n from '../i18n'
import { hapticLight, hapticMedium, hapticSuccess } from '../utils/haptics'
import { CreditCard } from 'lucide-react'
import AddressPickerSheet from '../components/AddressPickerSheet'
import {
  markFirstInteractionHandler,
  markFirstInteractionVisual,
} from '../utils/firstInteractionPerf'
import {
  getProfileServiceOptions,
  mapBookingServiceTypeToProfileServiceType,
  mapProfileServiceTypeToBookingServiceType,
  normalizeProfileServiceType,
  normalizeProfileServiceTypes,
  type ProfileServiceType,
} from '../lib/profileServiceTypes'
import { supabase } from '../services/supabaseClient'

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

function normalizeDogName(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

function capitalize(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value
}

type AppRole = 'client' | 'walker' | 'admin'
type SheetSnap = 'collapsed' | 'default'
type MenuPage = 'main' | 'settings' | 'history' | 'futureOrders'
type WheelOption = {
  value: string
  label: string
}

const BABYSITTER_DURATION_MIN = 0
const BABYSITTER_DURATION_MAX = 24
const BABYSITTER_DURATION_STEP = 0.5
const BABYSITTER_DEFAULT_DURATION_HOURS = 0.5
const BABYSITTER_BUDGET_MIN_ILS = 0
const BABYSITTER_BUDGET_MAX_ILS = 500
const BABYSITTER_BUDGET_STEP_ILS = 5
const BABYSITTER_DEFAULT_FIXED_BUDGET_ILS = 0
const DOG_WALKER_DURATION_MIN = 0
const DOG_WALKER_DURATION_MAX = 24
const DOG_WALKER_DURATION_STEP = 0.5
const DOG_WALKER_DEFAULT_DURATION_HOURS = 0.5
const DOG_WALKER_BUDGET_MIN_ILS = 0
const DOG_WALKER_BUDGET_MAX_ILS = 500
const DOG_WALKER_BUDGET_STEP_ILS = 5
const DOG_WALKER_DEFAULT_BUDGET_ILS = 0

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
  const isRtl = i18n.resolvedLanguage === 'he'
  const clientName = profile.full_name || profile.email || t('common.client')
  const flow = useClientFlow(profile.id, clientName)
  const photo = useProfilePhoto(profile.id)
  usePushNotifications(profile.id)

  const [burgerOpen, setBurgerOpen] = useState(false)
  const [menuPage, setMenuPage] = useState<MenuPage>('main')
  const [showSchedulePage, setShowSchedulePage] = useState(false)
  const [scheduleDraft, setScheduleDraft] = useState(getNowPlus15LocalInput())
  const [showDogNameSheet, setShowDogNameSheet] = useState(false)
  const [recentDogNames, setRecentDogNames] = useState<string[]>([])
  const [dogNameDraft, setDogNameDraft] = useState('')
  const [babysitterServiceDetails, setBabysitterServiceDetails] = useState('')
  const [babysitterDurationHours, setBabysitterDurationHours] = useState(
    String(BABYSITTER_DEFAULT_DURATION_HOURS),
  )
  const [babysitterBudgetFixed, setBabysitterBudgetFixed] = useState(
    String(BABYSITTER_DEFAULT_FIXED_BUDGET_ILS),
  )
  const [dogWalkerDurationHours, setDogWalkerDurationHours] = useState(
    String(DOG_WALKER_DEFAULT_DURATION_HOURS),
  )
  const [dogWalkerBudgetFixed, setDogWalkerBudgetFixed] = useState(
    String(DOG_WALKER_DEFAULT_BUDGET_ILS),
  )
  const [showFirstBookingWow, setShowFirstBookingWow] = useState(false)
  const [resumeFirstBookingWowAfterCardSetup, setResumeFirstBookingWowAfterCardSetup] = useState(false)
  const [guidedBookingField, setGuidedBookingField] = useState<'dogName' | 'duration' | 'payment' | null>(null)
  const [shouldAnimateGuidedField, setShouldAnimateGuidedField] = useState(false)
  const [_matchingUiState, setMatchingUiState] = useState<'matching' | 'empty' | null>(null)
  const [selectedService, setSelectedService] = useState<ServiceType>('dog_walking')
  const [moreServicesOpen, setMoreServicesOpen] = useState(false)
  const [addressPickerOpen, setAddressPickerOpen] = useState(false)
  const [sheetSnap, setSheetSnap] = useState<SheetSnap>('default')
  const [paymentSheetOpen, setPaymentSheetOpen] = useState(false)
  const [profileServiceTypes, setProfileServiceTypes] = useState<ProfileServiceType[]>(
    normalizeProfileServiceTypes(profile.service_types ?? profile.service_type),
  )
  const [serviceTypeSaving, setServiceTypeSaving] = useState(false)
  const [serviceTypeSaveError, setServiceTypeSaveError] = useState<string | null>(null)
  const [serviceTypeSavedAt, setServiceTypeSavedAt] = useState(0)
  const [appViewportHeight, setAppViewportHeight] = useState(getAppViewportHeight)
  const appViewportHeightRef = useRef(appViewportHeight)
  const scrollRef = useRef<HTMLDivElement>(null)
  const lastOnboardingWowTokenRef = useRef(0)
  const suppressDogNameOpenUntilRef = useRef(0)
  const lastCurrentJobIdRef = useRef<string | null>(null)
  const hasUserInteractedRef = useRef(false)
  const arrivalBeepPlayedJobIdRef = useRef<string | null>(null)
  const selectedBookingServiceRef = useRef<ServiceType>('dog_walking')
  const requestServiceTypeRef = useRef<ProfileServiceType | null>(null)
  const [mapMounted, setMapMounted] = useState(false)
  const [isDraggingSheet, setIsDraggingSheet] = useState(false)
  const sheetDragRef = useRef<{ startY: number; startSnap: SheetSnap; lastDelta: number } | null>(null)
  const sheetRef = useRef<HTMLDivElement>(null)

  const debugFlags = useRef(() => {
    if (typeof window === 'undefined') return { interactionDebug: false, delayMap: false }
    const params = new URLSearchParams(window.location.search)
    return {
      interactionDebug: import.meta.env.DEV && params.get('interactionDebug') === '1',
      delayMap: import.meta.env.DEV && params.get('delayMap') === '1',
    }
  }).current

  const profileServiceOptions = useMemo(() => getProfileServiceOptions(isRtl), [isRtl])
  const serviceTypeSectionTitle = isRtl ? 'סוג שירות' : 'Service type'
  const serviceTypeSectionSubtitle = isRtl
    ? 'בחר את סוג השירות הראשי לחשבון שלך.'
    : 'Choose the main service for this account.'
  const serviceTypeSavedLabel = isRtl ? 'סוג השירות נשמר.' : 'Service type saved.'
  const serviceTypeSavingLabel = isRtl ? 'שומר...' : 'Saving...'
  const serviceTypeErrorLabel = isRtl
    ? 'לא הצלחנו לשמור את סוג השירות.'
    : 'We could not save the service type.'
  const serviceSelectionRequiredLabel = isRtl
    ? 'יש לבחור לפחות שירות אחד בהגדרות לפני הזמנה.'
    : 'Please choose at least one service in Settings before booking.'
  const openSettingsLabel = isRtl ? 'פתח הגדרות' : 'Open Settings'
  const availableProfileServiceTypes = profileServiceTypes.length > 0
    ? profileServiceTypes
    : normalizeProfileServiceTypes(profile.service_types ?? profile.service_type)
  const hasSelectedProfileService = availableProfileServiceTypes.length > 0
  const availableBookingServices = useMemo(
    () => availableProfileServiceTypes.map((serviceType) => mapProfileServiceTypeToBookingServiceType(serviceType)),
    [availableProfileServiceTypes],
  )
  const shouldShowProfileServicePicker = availableBookingServices.length > 1
  const resolvedBookingService = availableBookingServices.includes(selectedService)
    ? selectedService
    : availableBookingServices[0] ?? selectedService
  const requestServiceType =
    mapBookingServiceTypeToProfileServiceType(resolvedBookingService) ??
    availableProfileServiceTypes[0] ??
    normalizeProfileServiceType(profile.service_type)

  useEffect(() => {
    selectedBookingServiceRef.current = resolvedBookingService
    requestServiceTypeRef.current = requestServiceType
  }, [requestServiceType, resolvedBookingService])

  useEffect(() => {
    setProfileServiceTypes(normalizeProfileServiceTypes(profile.service_types ?? profile.service_type))
  }, [profile.service_type, profile.service_types])

  useEffect(() => {
    if (availableBookingServices.length === 0) return
    if (!availableBookingServices.includes(selectedService)) {
      setSelectedService(availableBookingServices[0])
    }
  }, [availableBookingServices, selectedService])

  const handleSelectBookingService = useCallback((nextService: ServiceType) => {
    const normalizedNextService = availableBookingServices.includes(nextService)
      ? nextService
      : availableBookingServices[0] ?? nextService

    selectedBookingServiceRef.current = normalizedNextService
    requestServiceTypeRef.current =
      mapBookingServiceTypeToProfileServiceType(normalizedNextService) ??
      normalizeProfileServiceType(profile.service_type)

    setMatchingUiState(null)
    flow.clearAvailabilityNotice()
    flow.clearError()
    setSelectedService(normalizedNextService)
  }, [
    availableBookingServices,
    flow,
    profile.service_type,
  ])

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
      console.warn('[ClientDashboard] failed to update service_type:', error.message)
      setProfileServiceTypes(previousServiceTypes)
      setServiceTypeSaveError(serviceTypeErrorLabel)
      setServiceTypeSaving(false)
      return
    }

    setServiceTypeSaving(false)
    setServiceTypeSavedAt(Date.now())
  }, [profile.id, profileServiceTypes, serviceTypeErrorLabel, serviceTypeSaving])

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
    try {
      const raw = window.localStorage.getItem(bookingSubjectStorageKey(profile.id, requestServiceType))
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
    if (!showDogNameSheet) return
  }, [flow.dogName, showDogNameSheet])

  useEffect(() => {
    if (!showSchedulePage) return
    setScheduleDraft(clampScheduledDraft(flow.scheduledFor, getNowPlus15LocalInput()))
  }, [flow.scheduledFor, showSchedulePage])

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

  const handleFindWalker = useCallback(() => {
    const effectiveBookingService = availableBookingServices.includes(selectedBookingServiceRef.current)
      ? selectedBookingServiceRef.current
      : resolvedBookingService
    const effectiveRequestServiceType =
      mapBookingServiceTypeToProfileServiceType(effectiveBookingService) ??
      requestServiceTypeRef.current ??
      requestServiceType
    const isBabysitterRequest = effectiveRequestServiceType === 'baby_sitter'
    const isDogWalkerRequest = effectiveRequestServiceType === 'dog_walker'
    if (!hasSelectedProfileService) {
      setServiceTypeSaveError(serviceSelectionRequiredLabel)
      setBurgerOpen(true)
      setMenuPage('settings')
      return
    }
    const babysitterBudgetValue = babysitterFixedBudgetValue > 0 ? babysitterFixedBudgetValue : null
    const dogWalkerBudgetRequestValue = dogWalkerBudgetValue > 0 ? dogWalkerBudgetValue : null

    if (isBabysitterRequest) {
      if (
        !babysitterServiceDetails.trim() ||
        !flow.location.trim() ||
        !flow.savedCard ||
        !babysitterDurationMinutes ||
        !babysitterBudgetValue
      ) {
        return
      }
    } else if (isDogWalkerRequest) {
      if (
        !flow.dogName.trim() ||
        !flow.location.trim() ||
        !flow.savedCard ||
        !dogWalkerDurationMinutes ||
        !dogWalkerBudgetRequestValue
      ) {
        return
      }
    } else if (!flow.dogName.trim() || !flow.location.trim() || !flow.duration || !flow.savedCard) {
      return
    }
    if (import.meta.env.DEV) {
      const pricingPackage = durationTypeFromMinutes(
        isBabysitterRequest
          ? (babysitterDurationMinutes ?? 0)
          : isDogWalkerRequest
            ? (dogWalkerDurationMinutes ?? 0)
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
        requestServiceType: effectiveRequestServiceType,
      })
    }
    markFirstInteractionHandler('client-dashboard:find-walker')
    flow.clearAvailabilityNotice()
    flow.clearError()
    setMatchingUiState(null)
    markFirstInteractionVisual('client-dashboard:find-walker')
    if (isBabysitterRequest) {
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
        requestServiceType: effectiveRequestServiceType ?? undefined,
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
    } else if (isDogWalkerRequest) {
      const pricingDuration = durationTypeFromMinutes(dogWalkerDurationMinutes ?? 0)
      flow.requestWalk({
        requestServiceType: effectiveRequestServiceType ?? undefined,
        selectedBookingService: effectiveBookingService,
        profileServiceTypes: profile.service_types ?? null,
        legacyProfileServiceType: profile.service_type ?? null,
        dogNameOverride: flow.dogName.trim(),
        durationOverride: pricingDuration,
        durationMinutesOverride: dogWalkerDurationMinutes,
        priceOverrideILS: dogWalkerBudgetRequestValue,
      })
    } else {
      flow.requestWalk({
        requestServiceType: effectiveRequestServiceType ?? undefined,
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
    flow,
    flow.dogName,
    flow.duration,
    flow.location,
    flow.requestWalk,
    flow.savedCard,
    flow.scheduledFor,
    hasSelectedProfileService,
    profile.service_type,
    profile.service_types,
    resolvedBookingService,
    serviceSelectionRequiredLabel,
  ])

  const handleFirstBookingAddPayment = useCallback(() => {
    setShowFirstBookingWow(false)
    setResumeFirstBookingWowAfterCardSetup(true)
    flow.requestCardSetup()
  }, [flow.requestCardSetup])

  const persistRecentDogNames = useCallback(
    (names: string[]) => {
      setRecentDogNames(names)
      try {
        window.localStorage.setItem(
          bookingSubjectStorageKey(profile.id, requestServiceType),
          JSON.stringify(names),
        )
      } catch {
        // noop
      }
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

  const commitDogName = useCallback(
    (rawValue: string) => {
      const nextName = normalizeDogName(rawValue)
      flow.setDogName(nextName)
      persistSelectedBookingSubject(nextName)
      if (!nextName) return
      const nextNames = [nextName, ...recentDogNames.filter((name) => name !== nextName)].slice(0, 8)
      persistRecentDogNames(nextNames)
    },
    [flow, persistRecentDogNames, persistSelectedBookingSubject, recentDogNames],
  )

  const commitBabysitterSubject = useCallback(
    (rawValue: string) => {
      const nextName = normalizeDogName(rawValue)
      setBabysitterServiceDetails(nextName)
      persistSelectedBookingSubject(nextName)
      if (!nextName) return
      const nextNames = [nextName, ...recentDogNames.filter((name) => name !== nextName)].slice(0, 8)
      persistRecentDogNames(nextNames)
    },
    [persistRecentDogNames, persistSelectedBookingSubject, recentDogNames],
  )

  const openDogNameSheet = useCallback(() => {
    const isBabysitterRequest = requestServiceType === 'baby_sitter'
    setShowDogNameSheet(true)
    requestAnimationFrame(() => {
      setDogNameDraft(isBabysitterRequest ? babysitterServiceDetails : (flow.dogName || ''))
    })
  }, [babysitterServiceDetails, flow.dogName, requestServiceType])

  const closeDogNameSheet = useCallback(() => {
    setShowDogNameSheet(false)
  }, [])

  const submitDogNameSheet = useCallback(() => {
    if (requestServiceType === 'baby_sitter') {
      commitBabysitterSubject(dogNameDraft)
    } else {
      commitDogName(dogNameDraft)
    }
    setShowDogNameSheet(false)
  }, [commitBabysitterSubject, commitDogName, dogNameDraft, requestServiceType])

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
        location: formatShortAddress(j.address || j.location),
        scheduledFor: j.scheduled_for,
        startsInMin: flow.startsInMinutes(j.scheduled_for),
        price: j.scheduled_fee_snapshot ?? j.price,
        findingProviderAt: getScheduledDispatchWindowLabel(j.scheduled_for),
      })),
    [flow.upcomingJobs, flow.startsInMinutes, t],
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
    t,
  ])

  const menuHistoryPreviewItems = useMemo(
    () => allHistoryItems.filter((item) => item.hidden_by_client !== true).slice(0, 3),
    [allHistoryItems],
  )

  const hasCompletionPrompt = !!flow.completionJob
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
  const shouldShowGuidanceCtaHelper = guidedBookingField !== null && !flow.loading && !flow.cardLoading
  const showNearbyWalkers = flow.screenState === 'idle' || flow.screenState === 'searching'
  const matchingEmptyTitle = isDispatchExhausted
    ? t('booking.noProvidersAvailable')
    : shouldShowNoProvidersEmptyState
      ? t('booking.noProvidersAvailable')
      : flow.availabilityNotice?.title || t('booking.noProvidersAvailable')
  const matchingEmptySubtitle = isDispatchExhausted
    ? t('booking.providersBusyRetryLater')
    : shouldShowNoProvidersEmptyState
      ? t('booking.tryAgainSoon')
      : flow.error || t('booking.tryAgainSoon')

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
  )

  const mapUserLocation: [number, number] =
    flow.userLocation ?? flow.walkerLocation ?? ([32.0853, 34.7818] as [number, number])

  const trackingGpsQuality: GpsQuality =
    flow.gpsQuality === 'last_known' ? 'delayed' : flow.gpsQuality

  const flexibleRequestDurationMinutes =
    requestServiceType === 'baby_sitter'
      ? babysitterDurationMinutes
      : requestServiceType === 'dog_walker'
        ? dogWalkerDurationMinutes
        : null
  const requestDurationLabel =
    localizeMinuteUnitLabel(
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
    if (completionDurationSummary.actualLabel) {
      rows.push({
        label: t('tracking.actual'),
        value: localizeMinuteUnitLabel(completionDurationSummary.actualLabel) || completionDurationSummary.actualLabel,
      })
    }
    return rows
  }, [
    completionDurationSummary.actualLabel,
    completionDurationSummary.plannedLabel,
    completionJobDetails?.payment_status,
    completionJobDetails?.price,
    flow.savedCard,
    i18n.resolvedLanguage,
    t,
  ])

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
    setScheduleDraft(clampScheduledDraft(flow.scheduledFor, getNowPlus15LocalInput()))
    setShowSchedulePage(true)
    markFirstInteractionVisual('client-dashboard:open-schedule')
    void hapticLight()
  }, [flow.scheduledFor])

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

  const openFutureOrdersMenu = useCallback(() => {
    setBurgerOpen(true)
    setMenuPage('futureOrders')
  }, [])

  const currentMapStyle: React.CSSProperties = isTrackingState
    ? trackingMapContainerStyle
    : isSearching
      ? searchingMapContainerStyle
      : idleMapContainerStyle

  const scheduleMinValue = getNowPlus15LocalInput()
  const scheduleDraftParts = splitScheduledDraft(clampScheduledDraft(scheduleDraft, scheduleMinValue))
  const todayDateValue = splitScheduledDraft(scheduleMinValue).date
  const tomorrowDateValue = (() => {
    const todayDate = parseLocalDateTime(scheduleMinValue) ?? new Date()
    const nextDate = new Date(todayDate.getFullYear(), todayDate.getMonth(), todayDate.getDate() + 1)
    return `${nextDate.getFullYear()}-${pad(nextDate.getMonth() + 1)}-${pad(nextDate.getDate())}`
  })()
  const scheduleDatePreset: 'today' | 'tomorrow' | 'custom' =
    scheduleDraftParts.date === todayDateValue
      ? 'today'
      : scheduleDraftParts.date === tomorrowDateValue
        ? 'tomorrow'
        : 'custom'
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

  const updateScheduledDraftFromWheel = useCallback(
    (nextDate: string, nextHour: string, nextMinute: string) => {
      setScheduleDraft(
        clampScheduledDraft(mergeScheduledDraft(nextDate, `${nextHour}:${nextMinute}`), scheduleMinValue),
      )
    },
    [scheduleMinValue],
  )
  const handleSchedulePresetSelect = useCallback((preset: 'today' | 'tomorrow') => {
    const nextDate =
      preset === 'today'
        ? todayDateValue
        : tomorrowDateValue

    updateScheduledDraftFromWheel(
      nextDate,
      scheduleDraftParts.time.slice(0, 2),
      scheduleDraftParts.time.slice(3, 5),
    )
  }, [
    scheduleDraftParts.date,
    scheduleDraftParts.time,
    todayDateValue,
    tomorrowDateValue,
    updateScheduledDraftFromWheel,
  ])
  const scheduleDispatchRelativeLabel = useMemo(
    () => getScheduledRelativeLabel(scheduleDraft),
    [scheduleDraft],
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


  const handleSheetDragStart = useCallback(
    (clientY: number) => {
      if (!isIdleState) return
      sheetDragRef.current = { startY: clientY, startSnap: sheetSnap, lastDelta: 0 }
      setIsDraggingSheet(true)
      const el = sheetRef.current
      if (el) el.style.transition = 'none'
    },
    [isIdleState, sheetSnap],
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
    sheetDragRef.current = null
    const delta = drag.lastDelta
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

  const serviceKeys = SERVICE_I18N_KEYS[resolvedBookingService]
  const isSelectedServiceAvailable = checkServiceAvailable(resolvedBookingService)
  const isBabySitterMode = requestServiceType === 'baby_sitter'
  const bookingSubjectLabel = isBabySitterMode
    ? isRtl ? 'שם מקבל השירות' : 'Service recipient name'
    : t(serviceKeys.inputLabel)
  const bookingSubjectPlaceholder = isBabySitterMode
    ? isRtl ? 'הוסף שם מקבל שירות' : 'Add recipient name'
    : t(serviceKeys.inputLabel)
  const bookingSubjectSheetTitle = isBabySitterMode
    ? isRtl ? 'שם מקבל השירות' : 'Service recipient name'
    : t(serviceKeys.sheetTitle)
  const bookingSubjectSheetSubtitle = isBabySitterMode
    ? isRtl
      ? 'בחר שם אחרון או הקלד שם חדש.'
      : 'Pick a recent name or type a new one.'
    : t(serviceKeys.sheetSubtitle)
  const bookingSubjectInputLabel = isBabySitterMode
    ? 'ADD NEW'
    : t('dogNameSheet.addNew')
  const bookingSubjectInputPlaceholder = isBabySitterMode
    ? isRtl ? 'לדוגמה: נועה, גיל 4' : 'For example: Maya, age 4'
    : t('dogNameSheet.typePlaceholder')
  const showBookingSubjectSuggestions = true
  const shouldShowBookingSubjectCaption = false
  const babysitterBudgetSummary = useMemo(() => {
    return `₪${babysitterFixedBudgetValue}`
  }, [babysitterFixedBudgetValue])
  const dogWalkerBudgetSummary = useMemo(() => `₪${dogWalkerBudgetValue}`, [dogWalkerBudgetValue])

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
                (isBabySitterMode ? babysitterServiceDetails.trim() : flow.dogName.trim())
                  ? dogInputValueTextStyle
                  : dogInputPlaceholderTextStyle
              }
            >
              {(isBabySitterMode ? babysitterServiceDetails.trim() : flow.dogName.trim()) || bookingSubjectPlaceholder}
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
      <div style={isBabySitterMode ? babysitterAddressLabelStyle : dogWalkerAddressLabelStyle}>
        {isRtl ? 'כתובת' : 'Address'}
      </div>
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

  const durationPickerBlock = (
    <div style={{ ...compactFieldStyle, ...dogWalkerPlannerFieldWrapStyle }}>
      {isDurationGuided && (
        <div style={guidedFieldHintAboveStyle}>{t('booking.chooseDuration')}</div>
      )}
      <div style={dogWalkerPlannerCardStyle}>
        <div style={dogWalkerPlannerTopRowStyle}>
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
          <div style={dogWalkerPriceGroupStyle}>
            <div style={dogWalkerPriceValueRowStyle}>
              <span style={babysitterBudgetValueDisplayStyle}>₪{dogWalkerBudgetValue}</span>
            </div>
            <div style={babysitterBudgetSliderWrapStyle}>
              <input
                type="range"
                min={DOG_WALKER_BUDGET_MIN_ILS}
                max={DOG_WALKER_BUDGET_MAX_ILS}
                step={DOG_WALKER_BUDGET_STEP_ILS}
                value={dogWalkerBudgetValue}
                onChange={(e) => setDogWalkerBudgetFixed(String(Number(e.target.value)))}
                style={babysitterBudgetSliderStyle}
                aria-label={isRtl ? 'תקציב' : 'Budget'}
              />
              <div style={babysitterBudgetScaleRowStyle}>
                <span style={babysitterBudgetScaleLabelStyle}>₪0</span>
                <span style={babysitterBudgetScaleLabelStyle}>₪500</span>
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
        <div style={babysitterPlannerTopRowStyle}>
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
          <div style={babysitterBudgetGroupStyle}>
            <div style={babysitterBudgetSummaryRowStyle}>
              <span style={babysitterBudgetValueDisplayStyle}>₪{babysitterFixedBudgetValue}</span>
            </div>
            <div style={babysitterBudgetSliderWrapStyle}>
              <input
                type="range"
                min={BABYSITTER_BUDGET_MIN_ILS}
                max={BABYSITTER_BUDGET_MAX_ILS}
                step={BABYSITTER_BUDGET_STEP_ILS}
                value={babysitterFixedBudgetValue}
                onChange={(e) => handleBabysitterFixedBudgetChange(Number(e.target.value))}
                style={babysitterBudgetSliderStyle}
                aria-label={isRtl ? 'תקציב' : 'Budget'}
              />
              <div style={babysitterBudgetScaleRowStyle}>
                <span style={babysitterBudgetScaleLabelStyle}>₪0</span>
                <span style={babysitterBudgetScaleLabelStyle}>₪500</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )

  const compactDisplayPrice = useMemo(() => {
    if (isBabySitterMode) {
      return babysitterBudgetSummary ? { price: babysitterBudgetSummary, original: null } : null
    }
    return dogWalkerBudgetSummary ? { price: dogWalkerBudgetSummary, original: null } : null
  }, [babysitterBudgetSummary, dogWalkerBudgetSummary, isBabySitterMode])

  const compactSavedCardSummary =
    flow.savedCard && !flow.setupClientSecret ? (
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
          <CreditCard size={16} color="#3B82F6" style={{ flexShrink: 0 }} />
          <span style={compactSavedCardBrandStyle}>
            {capitalize(flow.savedCard.brand)} {flow.savedCard.last4}
          </span>
        </div>
        <div style={compactPriceEndStyle}>
              {compactDisplayPrice && (
            <>
              <span style={compactPriceValueStyle}>
                {typeof compactDisplayPrice.price === 'number' ? `₪${compactDisplayPrice.price}` : compactDisplayPrice.price}
              </span>
              {typeof compactDisplayPrice.original === 'number' && (
                <span style={compactPriceOriginalStyle}>₪{compactDisplayPrice.original}</span>
              )}
            </>
          )}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </div>
      </button>
    ) : null

  return (
    <div className="regli-client-screen" style={screenStyle}>
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
              {menuPage === 'history' ? (
                <BurgerSection title={t('menu.tripHistory')} subtitle={t('menu.allHistorySubtitle')}>
                  <GroupedHistory
                    items={allHistoryItems}
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
              ) : menuPage === 'settings' ? (
                <>
                  <section style={burgerSectionStyle}>
                    <div style={burgerSectionHeaderStyle}>
                      <div style={burgerSectionTitleStyle}>{t('common.language')}</div>
                    </div>
                    <div style={languageSelectorRowStyle}>
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
                        🇮🇱 עברית
                      </button>
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
                        🇺🇸 EN
                      </button>
                    </div>
                  </section>

                  <section style={burgerSectionStyle}>
                    <div style={burgerSectionHeaderStyle}>
                      <div style={burgerSectionTitleStyle}>{serviceTypeSectionTitle}</div>
                      <div style={burgerSectionSubtitleStyle}>{serviceTypeSectionSubtitle}</div>
                    </div>
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
                  </section>

                  <BurgerSection
                    id="client-favorites-section"
                    title={t('menu.preferredWalkers')}
                    subtitle={t('menu.preferredWalkersSubtitle')}
                  >
                    <FavoriteWalkerMenuList
                      favorites={flow.favoriteWalkers}
                      fallbackNames={flow.walkerNameById}
                      onToggleFavorite={flow.toggleFavoriteWalker}
                    />
                  </BurgerSection>
                </>
              ) : menuPage === 'futureOrders' ? (
                <BurgerSection
                  id="future-orders-section"
                  title={t('menu.futureOrders')}
                  subtitle={t('menu.futureOrdersSubtitle')}
                >
                  <BurgerUpcomingList
                    items={upcomingScheduledItems}
                    onCancel={flow.cancelScheduledJob}
                    limit={null}
                  />
                </BurgerSection>
              ) : (
                <>
                  <div style={menuProfileButtonStyle}>
                    <div style={{ position: 'relative', flexShrink: 0 }}>
                      <ProfileAvatar url={photo.avatarUrl} name={clientName} size={48} borderRadius={16} />
                    </div>
                    <div style={menuProfileTextStyle}>
                      <div style={profileNameStyle}>{clientName}</div>
                      {profile.email && <div style={profileEmailStyle}>{profile.email}</div>}
                      {flow.avgRating !== null && (
                        <div style={profileRatingStyle}>
                          <span style={{ color: '#F59E0B' }}>★</span> {flow.avgRating} · {t('menu.reviewScore')}
                        </div>
                      )}
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
                </>
              )}
            </div>
          </div>
        </>
      )}

      {showSchedulePage && (
        <>
          <div style={menuOverlayStyle} onClick={() => setShowSchedulePage(false)} />
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
                  {isRtl ? 'קביעת זמן לשירות' : 'Schedule Order'}
                </div>
                <div style={scheduleSheetSubtitleStyle}>
                  {isRtl ? 'בחרו תאריך ושעה שמתאימים לכם.' : 'Choose the best day and time for your order.'}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowSchedulePage(false)}
                style={scheduleSheetCloseButtonStyle}
                aria-label={t('common.close')}
              >
                ✕
              </button>
            </div>

            <div style={scheduleSheetScrollStyle}>
              <div style={schedulePageContentStyle}>
                <div style={schedulePresetRowStyle}>
                  <button
                    type="button"
                    onClick={() => handleSchedulePresetSelect('today')}
                    style={{
                      ...schedulePresetButtonStyle,
                      ...(scheduleDatePreset === 'today' ? schedulePresetButtonActiveStyle : null),
                    }}
                  >
                    {t('common.today')}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSchedulePresetSelect('tomorrow')}
                    style={{
                      ...schedulePresetButtonStyle,
                      ...(scheduleDatePreset === 'tomorrow' ? schedulePresetButtonActiveStyle : null),
                    }}
                  >
                    {t('common.tomorrow')}
                  </button>
                </div>

                <div style={schedulePickerCardStyle}>
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
                      />
                    </div>
                  </div>
                </div>

                <div style={scheduleDispatchNoticeStyle}>
                  <div style={scheduleInfoRowStyle}>
                    <span style={scheduleInfoIconStyle} aria-hidden="true">⏰</span>
                    <div style={scheduleInfoCopyStyle}>
                      <div style={scheduleInfoTitleStyle}>
                        {isRtl
                          ? 'החיפוש יתחיל אוטומטית 15 דקות לפני הזמן שבחרת.'
                          : 'The search will start automatically 15 minutes before the selected time.'}
                      </div>
                      {scheduleDispatchRelativeLabel && (
                        <div style={scheduleInfoSubtitleStyle}>{scheduleDispatchRelativeLabel}</div>
                      )}
                    </div>
                  </div>
                </div>

                <div style={scheduleSummaryCardStyle}>
                  <div style={scheduleSummaryPrimaryStyle}>
                    {isRtl
                      ? `נקבע ל: ${formatScheduledSummaryDate(scheduleDraft)} בשעה ${formatScheduledTime(scheduleDraft)}`
                      : `Scheduled for: ${formatScheduledSummaryDate(scheduleDraft)} at ${formatScheduledTime(scheduleDraft)}`}
                  </div>
                </div>
              </div>
            </div>

            <div style={scheduleSheetFooterStyle}>
              <ActionButton
                label={isRtl ? 'אישור הזמנה עתידית' : 'Confirm schedule'}
                onClick={() => {
                  const nextValue = clampScheduledDraft(scheduleDraft, scheduleMinValue)
                  flow.setBookingTiming('scheduled')
                  flow.setScheduledFor(nextValue)
                  setScheduleDraft(nextValue)
                  setShowSchedulePage(false)
                  void hapticSuccess()
                }}
              />
            </div>
          </div>
        </>
      )}

      <div
        ref={sheetRef}
        className="regli-client-dashboard-sheet"
        style={{
          ...currentSheetStyle,
          ...(isIdleState ? { maxHeight: `${sheetMaxHeights[sheetSnap]}px`, overflow: 'hidden' } : {}),
          transition: isDraggingSheet ? 'none' : 'max-height 280ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      >
        {isIdleState ? (
          <div
            style={dragHandleZoneStyle}
            onTouchStart={(e) => {
              handleSheetDragStart(e.touches[0].clientY)
            }}
            onTouchMove={(e) => {
              e.preventDefault()
              handleSheetDragMove(e.touches[0].clientY)
            }}
            onTouchEnd={handleSheetDragEnd}
            onMouseDown={(e) => {
              e.preventDefault()
              handleSheetDragStart(e.clientY)
              const onMove = (ev: MouseEvent) => handleSheetDragMove(ev.clientY)
              const onUp = () => {
                handleSheetDragEnd()
                window.removeEventListener('mousemove', onMove)
                window.removeEventListener('mouseup', onUp)
              }
              window.addEventListener('mousemove', onMove)
              window.addEventListener('mouseup', onUp)
            }}
            onClick={() => {
              if (isDraggingSheet) return
              if (isSheetCollapsed) setSheetSnap('default')
            }}
          >
            <div style={dragHandleBarStyle} />
          </div>
        ) : (
          <div style={{ ...sheetTopPadStyle, height: 8 }} />
        )}

        <div ref={scrollRef} style={currentSheetScrollStyle}>
          {shouldRenderIdleSheet && (
            <div
              style={{
                ...idleSheetContentStyle,
              }}
            >
              <div style={bookingCardStyle}>
                {shouldShowProfileServicePicker && (
                  <ServiceSelectorPanel
                    selected={resolvedBookingService}
                    onSelect={handleSelectBookingService}
                    onMorePress={() => setMoreServicesOpen(true)}
                    services={availableBookingServices}
                  />
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
                  {dogSelectorBlock}

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

                  {pickupSelectorBlock}

                  {isSelectedServiceAvailable && (isBabySitterMode ? babysitterPlannerBlock : durationPickerBlock)}

                  {!isSheetCollapsed && isSelectedServiceAvailable && (
                      <div style={compactFieldStyle}>
                        {isPaymentGuided && (
                          <div style={guidedFieldHintAboveStyle}>{t('booking.addPaymentMethod')}</div>
                        )}
                        <div
                          style={{
                            ...compactPaymentWrapStyle,
                            ...(isBabySitterMode ? compactPaymentWrapBabysitterStyle : compactPaymentWrapDogWalkerStyle),
                            ...(isPaymentGuided ? paymentGuidedFieldShellStyle : null),
                            ...(isPaymentGuided && shouldAnimateGuidedField ? guidedFieldAnimationStyle : null),
                          }}
                        >
                          {compactSavedCardSummary ?? (
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
                          )}
                        </div>
                      </div>
                  )}
                </div>

                </>
                )}
              </div>
            </div>
          )}

          {shouldRenderSearchingSheet && (
            <div style={sheetContentStyle}>
              <SearchingSheet
                searchStartedAt={flow.searchStartTime}
                elapsedSeconds={flow.elapsedSeconds}
                durationLabel={requestDurationLabel}
                priceLabel={requestPriceLabel}
                mode={isDispatchExhausted || shouldShowNoProvidersEmptyState ? 'empty' : 'matching'}
                serviceType={flow.currentJob?.service_type}
                emptyTitle={matchingEmptyTitle}
                emptySubtitle={matchingEmptySubtitle}
                onCancel={
                  isDispatchExhausted || shouldShowNoProvidersEmptyState
                    ? handleMatchingTryAgain
                    : flow.cancelSearch
                }
                onTryAgain={handleMatchingTryAgain}
              />
            </div>
          )}

          {(flow.screenState === 'tracking' || flow.screenState === 'active') && flow.activeJob && (
            <div style={sheetContentStyle}>
              <TrackingCard
                walkerName={
                  flow.activeJob.walker_id
                    ? flow.walkerNameById.get(flow.activeJob.walker_id) || t('common.provider')
                    : t('common.provider')
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
                onConfirmArrival={flow.screenPhase === 'arrived_pending_confirmation' ? flow.confirmArrival : undefined}
                confirmingArrival={flow.arrivalConfirming}
                elapsedLabel={localizeMinuteUnitLabel(trackingDurationSummary.elapsedLabel)}
                plannedLabel={localizeMinuteUnitLabel(trackingDurationSummary.plannedLabel)}
                actualLabel={localizeMinuteUnitLabel(trackingDurationSummary.actualLabel)}
              />
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
                <ActionButton
                  label={
                    flow.loading
                      ? flow.bookingTiming === 'scheduled'
                        ? t('booking.scheduling')
                        : t('booking.ordering')
                      : flow.cardLoading && !flow.savedCard
                        ? t('booking.loadingPayment')
                        : !flow.savedCard
                          ? t('booking.addCard')
                          : t('booking.orderNow')
                  }
                  onClick={handleFindWalker}
                  loading={flow.loading || (flow.cardLoading && !flow.savedCard)}
                  disabled={
                    !hasSelectedProfileService ||
                    !isSelectedServiceAvailable ||
                    !(isBabySitterMode ? babysitterServiceDetails.trim() : flow.dogName.trim()) ||
                    !flow.location.trim() ||
                    (
                      isBabySitterMode
                        ? babysitterDurationValue <= 0 || babysitterFixedBudgetValue <= 0
                        : dogWalkerDurationValue <= 0 || dogWalkerBudgetValue <= 0
                    ) ||
                    !flow.savedCard ||
                    (isBabySitterMode
                      ? !flow.scheduledFor
                      : flow.bookingTiming === 'scheduled' && !flow.scheduledFor)
                  }
                />
                {!hasSelectedProfileService ? (
                  <div
                    style={{
                      marginTop: 10,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 12,
                      padding: '10px 12px',
                      borderRadius: 16,
                      background: 'rgba(255,255,255,0.96)',
                      border: '1px solid rgba(251, 191, 36, 0.28)',
                      color: '#92400E',
                      fontSize: 13,
                      lineHeight: 1.45,
                    }}
                  >
                    <span>{serviceSelectionRequiredLabel}</span>
                    <button
                      type="button"
                      onClick={() => {
                        setServiceTypeSaveError(serviceSelectionRequiredLabel)
                        setBurgerOpen(true)
                        setMenuPage('settings')
                      }}
                      style={{
                        border: 'none',
                        background: '#FFF7ED',
                        color: '#B45309',
                        borderRadius: 999,
                        padding: '8px 12px',
                        fontSize: 12,
                        fontWeight: 700,
                        cursor: 'pointer',
                        flexShrink: 0,
                      }}
                    >
                      {openSettingsLabel}
                    </button>
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                data-control="calendar-button"
                onClick={() => {
                  markFirstInteractionHandler('client-dashboard:calendar-button')
                  if (hasFutureOrders) {
                    openFutureOrdersMenu()
                  } else if (!isBabySitterMode && dogWalkerDurationValue <= 0) {
                    setGuidedBookingField('duration')
                    markFirstInteractionVisual('client-dashboard:calendar-button')
                    void hapticLight()
                  } else {
                    openScheduleSheet()
                  }
                }}
                style={{
                  ...stickyCalendarButtonStyle,
                  ...(flow.bookingTiming === 'scheduled' || hasFutureOrders ? stickyCalendarButtonActiveStyle : null),
                  position: 'relative' as const,
                }}
                aria-label={hasFutureOrders ? t('menu.openFutureOrders') : t('booking.schedule')}
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

      {moreServicesOpen && (
        <MoreServicesSheet
          onSelect={handleSelectBookingService}
          services={availableBookingServices}
          onClose={() => setMoreServicesOpen(false)}
        />
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

            {showBookingSubjectSuggestions && !!recentDogNames.length && (
              <div style={dogNameSuggestionsWrapStyle}>
                {recentDogNames.map((name) => (
                  <div key={name} style={dogNameChipWrapStyle}>
                    <button
                      type="button"
                      onClick={() => {
                        setDogNameDraft(name)
                        if (isBabySitterMode) {
                          commitBabysitterSubject(name)
                        } else {
                          commitDogName(name)
                        }
                        setShowDogNameSheet(false)
                      }}
                      style={dogNameChipStyle}
                    >
                      <span>{isBabySitterMode ? '🧸' : '🐶'}</span>
                      <span>{name}</span>
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        const next = recentDogNames.filter((n) => n !== name)
                        persistRecentDogNames(next)
                        const currentValue = isBabySitterMode ? babysitterServiceDetails : flow.dogName
                        if (normalizeDogName(currentValue) === name) {
                          if (isBabySitterMode) {
                            setBabysitterServiceDetails('')
                          } else {
                            flow.setDogName('')
                          }
                          persistSelectedBookingSubject('')
                        }
                      }}
                      style={dogNameChipDeleteStyle}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}

              <div style={dogNameInputCardStyle}>
              <div style={dogNameInputLabelStyle}>{bookingSubjectInputLabel}</div>
              <input
                value={dogNameDraft}
                onChange={(e) => setDogNameDraft(e.target.value)}
                placeholder={bookingSubjectInputPlaceholder}
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
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={submitDogNameSheet}
                style={dogNamePrimaryBtnStyle}
                disabled={!normalizeDogName(dogNameDraft)}
              >
                {t('common.save')}
              </button>
            </div>
          </div>
        </>
      )}

      {paymentSheetOpen && (
        <>
          <div style={paymentSheetOverlayStyle} onClick={() => setPaymentSheetOpen(false)} />
          <div style={paymentSheetStyle}>
            <div style={paymentSheetHeaderStyle}>
              <span style={paymentSheetTitleStyle}>{t('paymentMethods.title')}</span>
              <button type="button" onClick={() => setPaymentSheetOpen(false)} style={paymentSheetCloseStyle}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            {flow.savedCard && (
              <div style={paymentSheetCardRowStyle}>
                <div style={paymentSheetCardLeftStyle}>
                  <CreditCard size={20} color="#3B82F6" />
                  <div>
                    <div style={paymentSheetCardBrandStyle}>
                      {capitalize(flow.savedCard.brand)} {flow.savedCard.last4}
                    </div>
                    {flow.savedCard.expMonth != null && flow.savedCard.expYear != null && (
                      <div style={paymentSheetCardExpStyle}>
                        {pad(flow.savedCard.expMonth)}/{String(flow.savedCard.expYear).slice(-2)}
                      </div>
                    )}
                  </div>
                </div>
                <span style={paymentSheetDefaultBadgeStyle}>{t('paymentMethods.defaultCard')}</span>
              </div>
            )}

            <div style={paymentSheetActionsStyle}>
              <button
                type="button"
                onClick={() => { setPaymentSheetOpen(false); flow.changeCard() }}
                style={paymentSheetActionBtnStyle}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#3B82F6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="1" y="4" width="22" height="16" rx="2" ry="2" />
                  <line x1="1" y1="10" x2="23" y2="10" />
                </svg>
                <span>{t('paymentMethods.addCard')}</span>
              </button>

              <button
                type="button"
                onClick={() => { setPaymentSheetOpen(false); flow.changeCard() }}
                style={paymentSheetActionBtnStyle}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#3B82F6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
                <span>{t('paymentMethods.manageCards')}</span>
              </button>

              <div style={paymentSheetActionDisabledStyle}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#CBD5E1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="1" x2="12" y2="23" />
                  <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                </svg>
                <span>{t('paymentMethods.cashPayment')}</span>
                <span style={paymentSheetComingSoonStyle}>{t('paymentMethods.comingSoon')}</span>
              </div>
            </div>
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

function WheelPickerColumn({
  options,
  value,
  onChange,
  isWide = false,
}: {
  options: WheelOption[]
  value: string
  onChange: (value: string) => void
  isWide?: boolean
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollTimeoutRef = useRef<number | null>(null)
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  )

  useEffect(() => {
    const node = scrollRef.current
    if (!node) return
    const targetTop = selectedIndex * WHEEL_ROW_HEIGHT
    if (Math.abs(node.scrollTop - targetTop) > 2) {
      safeScrollTo(node, { top: targetTop, behavior: 'smooth' })
    }
  }, [selectedIndex])

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
            Math.min(options.length - 1, Math.round(nextTop / WHEEL_ROW_HEIGHT)),
          )
          const nextValue = options[nextIndex]?.value
          if (nextValue && nextValue !== value) {
            onChange(nextValue)
          }
          safeScrollTo(scrollRef.current, {
            top: nextIndex * WHEEL_ROW_HEIGHT,
            behavior: 'smooth',
          })
        }, 70)
      }}
    >
      <div style={wheelPickerSpacerStyle} />
      {options.map((option, index) => {
        const distance = Math.abs(index - selectedIndex)
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            style={{
              ...wheelPickerOptionStyle,
              opacity: distance === 0 ? 1 : distance === 1 ? 0.72 : distance === 2 ? 0.42 : 0.22,
              transform: distance === 0 ? 'scale(1)' : 'scale(0.96)',
              fontWeight: distance === 0 ? 900 : 700,
              color: distance === 0 ? '#0F172A' : '#64748B',
            }}
          >
            {option.label}
          </button>
        )
      })}
      <div style={wheelPickerSpacerStyle} />
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
}: {
  favorites: ReturnType<typeof useClientFlow>['favoriteWalkers']
  fallbackNames: Map<string, string>
  onToggleFavorite: (walkerId: string) => Promise<void>
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
            <ProfileAvatar
              url={favorite.walker?.avatar_url ?? null}
              name={walkerName}
              size={34}
              borderRadius={12}
            />
            <div style={favoriteMenuTextStyle}>
              <div style={favoriteMenuNameStyle}>{walkerName}</div>
              <div style={favoriteMenuSubStyle}>{t('menu.preferredWalkers')}</div>
            </div>
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

function TrackingCard({
  walkerName,
  phase,
  isArrived,
  etaMinutes,
  displayEtaSeconds,
  distanceMeters,
  gpsQuality,
  activeTitle,
  onConfirmArrival,
  confirmingArrival,
  elapsedLabel,
  plannedLabel,
  actualLabel,
}: {
  walkerName: string
  phase: 'on_the_way' | 'arrived_pending_confirmation' | 'arrival_confirmed' | 'in_progress'
  isArrived: boolean
  etaMinutes: number | null
  displayEtaSeconds: number | null
  distanceMeters: number | null
  gpsQuality: GpsQuality
  activeTitle: string
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
    ? t('tracking.startedSubtitle')
    : isArrivalPending
      ? t('tracking.arrivalConfirmationSubtitle')
      : isArrivalConfirmed
        ? t('tracking.readySubtitle')
        : t('tracking.headingToYou', { walkerName })

  return (
    <div style={trackingCardStyle}>
      <div style={{ ...trackingTopBadgeStyle, ...statusToneStyle }}>{topBadge}</div>
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

      {(elapsedLabel || plannedLabel || actualLabel) && (
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
        <div style={{ marginTop: 16 }}>
          <ActionButton
            label={confirmingArrival ? t('tracking.confirmingArrival') : t('tracking.confirmArrival')}
            onClick={onConfirmArrival}
            loading={!!confirmingArrival}
            disabled={!!confirmingArrival}
            touchSafe
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

function formatScheduledSummaryDate(value: string | null | undefined): string {
  const dt = parseDateTimeFlexible(value)
  if (!dt) return i18n.t('menu.scheduledWalk')
  return dt.toLocaleDateString([], {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
}

function getScheduledRelativeLabel(value: string | null | undefined): string | null {
  const dt = parseLocalDateTime(value) ?? parseDateTimeFlexible(value)
  if (!dt) return null

  const diffMs = dt.getTime() - Date.now()
  if (diffMs <= 0) return null

  const totalMinutes = Math.round(diffMs / 60000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  const isHebrew = i18n.resolvedLanguage === 'he'

  if (isHebrew) {
    if (hours > 0 && minutes > 0) {
      return `(בעוד ${hours} שעות ו-${minutes} דקות)`
    }
    if (hours > 0) {
      return hours === 1 ? '(בעוד שעה)' : `(בעוד ${hours} שעות)`
    }
    return minutes === 1 ? '(בעוד דקה)' : `(בעוד ${minutes} דקות)`
  }

  if (hours > 0 && minutes > 0) {
    return `(In ${hours} hour${hours === 1 ? '' : 's'} and ${minutes} minute${minutes === 1 ? '' : 's'})`
  }
  if (hours > 0) {
    return `(In ${hours} hour${hours === 1 ? '' : 's'})`
  }
  return `(In ${minutes} minute${minutes === 1 ? '' : 's'})`
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
    'radial-gradient(circle at 50% 38%, rgba(59,130,246,0.12) 0%, rgba(59,130,246,0.05) 18%, rgba(248,250,252,0) 42%), linear-gradient(180deg, #EEF4FF 0%, #F8FAFC 46%, #F1F5F9 100%)',
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
  background: 'rgba(255,255,255,0.97)',
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
  display: 'grid',
  placeItems: 'center',
}


const sheetStyle: React.CSSProperties = {
  position: 'absolute',
  left: 0,
  right: 0,
  bottom: 0,
  top: 'calc(36dvh - 18px)',
  borderTopLeftRadius: 28,
  borderTopRightRadius: 28,
  background: '#FFFFFF',
  boxShadow: '0 -10px 30px rgba(15, 23, 42, 0.10)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  zIndex: 1,
  boxSizing: 'border-box',
  willChange: 'transform',
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
}

const trackingSheetStyle: React.CSSProperties = {
  ...sheetStyle,
  top: 'auto',
  height: 'auto',
  maxHeight: 'calc(100dvh - 92px)',
}

const sheetTopPadStyle: React.CSSProperties = {
  height: 12,
  flexShrink: 0,
  borderTopLeftRadius: 28,
  borderTopRightRadius: 28,
  background: 'linear-gradient(180deg, rgba(248,250,252,0.96) 0%, rgba(255,255,255,1) 100%)',
}

const dragHandleZoneStyle: React.CSSProperties = {
  flexShrink: 0,
  padding: '18px 0 10px',
  display: 'flex',
  justifyContent: 'center',
  cursor: 'grab',
  touchAction: 'none',
  WebkitTapHighlightColor: 'transparent',
  userSelect: 'none',
  WebkitUserSelect: 'none',
}

const dragHandleBarStyle: React.CSSProperties = {
  width: 36,
  height: 4,
  borderRadius: 999,
  background: '#CBD5E1',
}

const searchingSheetScrollStyle: React.CSSProperties = {
  flex: '0 1 auto',
  minHeight: 0,
  overflowY: 'visible',
  overflowX: 'hidden',
  padding: '0 14px 8px',
  width: '100%',
  maxWidth: '100%',
  boxSizing: 'border-box',
}

const trackingSheetScrollStyle: React.CSSProperties = {
  flex: '0 0 auto',
  minHeight: 0,
  overflowY: 'visible',
  overflowX: 'hidden',
  paddingTop: 0,
  paddingRight: 14,
  paddingBottom: 8,
  paddingLeft: 14,
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
  paddingRight: 14,
  paddingBottom: 2,
  paddingLeft: 14,
  WebkitOverflowScrolling: 'touch',
  width: '100%',
  maxWidth: '100%',
  boxSizing: 'border-box',
}

const sheetContentStyle: React.CSSProperties = {
  paddingBottom: 'env(safe-area-inset-bottom, 0px)',
  width: '100%',
  maxWidth: '100%',
  boxSizing: 'border-box',
}

const idleSheetContentStyle: React.CSSProperties = {
  paddingBottom: 1,
}


const bookingCardStyle: React.CSSProperties = {
  display: 'grid',
  gap: 4,
}


const compactFormGridStyle: React.CSSProperties = {
  display: 'grid',
  gap: 4,
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
  gap: 2,
}

const babysitterServiceFieldWrapStyle: React.CSSProperties = {
  marginBottom: 2,
}

const babysitterAddressFieldWrapStyle: React.CSSProperties = {
  marginBottom: 8,
}

const dogWalkerAddressFieldWrapStyle: React.CSSProperties = {
  marginBottom: 8,
}

const babysitterPlannerFieldWrapStyle: React.CSSProperties = {
  marginBottom: 4,
}

const dogWalkerPlannerFieldWrapStyle: React.CSSProperties = {
  marginBottom: 4,
}

const guidedFieldButtonStyle: React.CSSProperties = {
  borderRadius: 18,
  transformOrigin: 'center top',
  willChange: 'transform, box-shadow, opacity',
}

const guidedFieldShellStyle: React.CSSProperties = {
  border: '1px solid #60A5FA',
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
  marginBottom: 2,
}

const compactFieldLabelMutedStyle: React.CSSProperties = {
  fontSize: 10.5,
  fontWeight: 800,
  letterSpacing: 0.4,
  textTransform: 'uppercase',
  color: '#94A3B8',
}

const pickupSelectorShellStyle: React.CSSProperties = {
  minHeight: 52,
  borderRadius: 15,
  border: '1px solid #E2E8F0',
  background: '#FFFFFF',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  boxSizing: 'border-box',
  padding: '0 12px',
  cursor: 'pointer',
}

const pickupSelectorShellCompactStyle: React.CSSProperties = {
  minHeight: 44,
  padding: '0 11px',
}

const pickupSelectorInlineIconStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  fontSize: 16,
  lineHeight: 1,
}

const pickupSelectorValueStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 16,
  color: '#0F172A',
  fontWeight: 700,
  lineHeight: 'normal',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const pickupSelectorValueCompactStyle: React.CSSProperties = {
  fontSize: 14,
}

const dogWalkerAddressLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: '#64748B',
  lineHeight: 1.2,
}

const pickupSelectorPlaceholderStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 16,
  color: '#94A3B8',
  fontWeight: 600,
  lineHeight: 'normal',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
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

const dogInputShellCompactStyle: React.CSSProperties = {
  height: 43,
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

const dogThumbCompactStyle: React.CSSProperties = {
  width: 34,
  height: 34,
  fontSize: 16,
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
  fontSize: 13,
  lineHeight: 1.45,
  color: '#64748B',
}

const dogNameSuggestionsWrapStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 10,
}

const dogNameChipWrapStyle: React.CSSProperties = {
  position: 'relative',
  display: 'inline-flex',
}

const dogNameChipStyle: React.CSSProperties = {
  height: 36,
  borderRadius: 999,
  border: '1px solid #DBEAFE',
  background: '#EFF6FF',
  color: '#1D4ED8',
  fontSize: 14,
  fontWeight: 800,
  padding: '0 28px 0 12px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  cursor: 'pointer',
}

const dogNameChipDeleteStyle: React.CSSProperties = {
  position: 'absolute',
  top: -4,
  right: -4,
  width: 20,
  height: 20,
  borderRadius: 999,
  border: '1.5px solid #DBEAFE',
  background: '#FFFFFF',
  color: '#94A3B8',
  display: 'grid',
  placeItems: 'center',
  cursor: 'pointer',
  padding: 0,
}

const dogNameInputCardStyle: React.CSSProperties = {
  borderRadius: 14,
  border: '1px solid #E2E8F0',
  background: '#FFFFFF',
  padding: '8px 12px',
  display: 'grid',
  gap: 6,
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
  height: 44,
  borderRadius: 12,
  border: '1px solid #E2E8F0',
  background: '#FFFFFF',
  outline: 'none',
  padding: '0 12px',
  fontSize: 16,
  color: '#0F172A',
  boxSizing: 'border-box',
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
  background: 'rgba(59,130,246,0.06)',
  boxShadow: '0 0 0 3px rgba(59,130,246,0.12)',
}

const guidedFieldAnimationStyle: React.CSSProperties = {
  animation: 'regliGuidedFieldPulse 420ms cubic-bezier(0.22, 1, 0.36, 1) 1',
}

const compactPaymentWrapStyle: React.CSSProperties = {
  marginTop: 0,
  marginBottom: -1,
  border: '2px solid transparent',
  borderRadius: 24,
  padding: 2,
  boxSizing: 'border-box',
  transition: 'border-color 180ms ease, background-color 180ms ease, box-shadow 220ms ease',
  transformOrigin: 'center top',
  willChange: 'transform, box-shadow, opacity',
}

const compactSavedCardRowStyle: React.CSSProperties = {
  appearance: 'none',
  border: 'none',
  background: 'transparent',
  padding: 0,
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  cursor: 'pointer',
  fontFamily: 'inherit',
}

const compactSavedCardMainStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minWidth: 0,
  flex: 1,
}



const compactSavedCardBrandStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 800,
  color: '#0F172A',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const compactPriceEndStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexShrink: 0,
}

const compactPriceValueStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 900,
  color: '#0F172A',
}

const compactPriceOriginalStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: '#94A3B8',
  textDecoration: 'line-through',
}

const babysitterPlannerCardStyle: React.CSSProperties = {
  display: 'grid',
  gap: 6,
  padding: '7px 9px 5px',
  borderRadius: 16,
  border: '1px solid rgba(226, 232, 240, 0.9)',
  background: 'rgba(255,255,255,0.36)',
}

const dogWalkerPlannerCardStyle: React.CSSProperties = {
  display: 'grid',
  gap: 6,
  padding: '7px 9px 5px',
  borderRadius: 16,
  border: '1px solid rgba(226, 232, 240, 0.9)',
  background: 'rgba(255,255,255,0.36)',
}

const dogWalkerPlannerTopRowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(104px, 116px) minmax(0, 1fr)',
  columnGap: 18,
  rowGap: 0,
  alignItems: 'start',
}

const dogWalkerPlannerLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: '#475569',
  lineHeight: 1.2,
  minHeight: 14,
  display: 'inline-flex',
  alignItems: 'center',
  whiteSpace: 'nowrap',
}

const dogWalkerFieldGroupStyle: React.CSSProperties = {
  display: 'grid',
  gap: 4,
  minWidth: 0,
  alignContent: 'start',
}

const dogWalkerPriceGroupStyle: React.CSSProperties = {
  display: 'grid',
  gap: 4,
  minWidth: 0,
  alignContent: 'start',
}

const dogWalkerPriceValueRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  minHeight: 18,
  minWidth: 0,
  flexWrap: 'nowrap',
}

const babysitterPlannerTopRowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(104px, 116px) minmax(0, 1fr)',
  columnGap: 18,
  rowGap: 0,
  alignItems: 'start',
}

const babysitterFieldGroupStyle: React.CSSProperties = {
  display: 'grid',
  gap: 4,
  minWidth: 0,
  alignContent: 'start',
}

const babysitterBudgetGroupStyle: React.CSSProperties = {
  display: 'grid',
  gap: 4,
  minWidth: 0,
  alignContent: 'start',
}

const babysitterFieldLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: '#475569',
  lineHeight: 1.2,
  minHeight: 14,
  display: 'inline-flex',
  alignItems: 'center',
}

const babysitterDurationStepperStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) 24px',
  alignItems: 'stretch',
  borderRadius: 12,
  border: '1px solid rgba(203, 213, 225, 0.95)',
  background: '#FFF',
  minHeight: 34,
  overflow: 'hidden',
}

const babysitterDurationValueStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '0 10px',
  fontSize: 12,
  fontWeight: 700,
  color: '#0F172A',
}

const babysitterDurationStepperButtonsStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateRows: '1fr 1fr',
  borderInlineStart: '1px solid rgba(226, 232, 240, 0.95)',
}

const babysitterStepButtonStyle: React.CSSProperties = {
  border: 'none',
  background: '#F8FAFC',
  color: '#475569',
  padding: 0,
  margin: 0,
  fontSize: 9,
  fontWeight: 800,
  cursor: 'pointer',
  lineHeight: 1,
}

const babysitterBudgetSliderWrapStyle: React.CSSProperties = {
  display: 'grid',
  gap: 4,
  paddingTop: 5,
  paddingBottom: 4,
}

const babysitterBudgetSummaryRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  justifyContent: 'center',
  minHeight: 18,
  minWidth: 0,
  flexWrap: 'nowrap',
}

const babysitterAddressLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: '#64748B',
  lineHeight: 1.2,
}

const babysitterBudgetValueDisplayStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: '#0F172A',
  fontSize: 15,
  fontWeight: 900,
  whiteSpace: 'nowrap',
}

const babysitterBudgetSliderStyle: React.CSSProperties = {
  width: '100%',
  margin: 0,
  accentColor: '#0F172A',
  height: 22,
}

const babysitterBudgetScaleRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  marginTop: -1,
}

const babysitterBudgetScaleLabelStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  color: '#94A3B8',
  lineHeight: 1,
}

const compactPaymentWrapBabysitterStyle: React.CSSProperties = {
  marginTop: 8,
}

const compactPaymentWrapDogWalkerStyle: React.CSSProperties = {
  marginTop: 8,
}

const stickyCtaWrapBabysitterStyle: React.CSSProperties = {
  paddingTop: 10,
}

const stickyCtaWrapDogWalkerStyle: React.CSSProperties = {
  paddingTop: 10,
}

const paymentGuidedFieldShellStyle: React.CSSProperties = {
  border: '2px solid #3B82F6',
  background: 'rgba(59,130,246,0.06)',
  boxShadow: '0 0 0 3px rgba(59,130,246,0.12)',
}

const stickyCtaWrapStyle: React.CSSProperties = {
  padding: '2px 14px env(safe-area-inset-bottom, 0px)',
  borderTop: '1px solid rgba(226, 232, 240, 0.9)',
  background: '#FFFFFF',
  flexShrink: 0,
}

const guidedCtaHelperStyle: React.CSSProperties = {
  marginBottom: 5,
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

const stickyActionRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'stretch',
  gap: 10,
}

const stickyCalendarButtonStyle: React.CSSProperties = {
  width: 56,
  minWidth: 56,
  borderRadius: 16,
  border: '1px solid #E2E8F0',
  background: '#FFFFFF',
  color: '#0F172A',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  boxShadow: '0 4px 14px rgba(15, 23, 42, 0.08)',
  WebkitTapHighlightColor: 'transparent',
}

const stickyCalendarButtonActiveStyle: React.CSSProperties = {
  borderColor: '#BFDBFE',
  background: '#EFF6FF',
  color: '#1D4ED8',
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

const pendingConfirmCardStyle: React.CSSProperties = {
  background: '#FFFFFF',
  borderRadius: 24,
  padding: '28px 24px 24px',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 12,
  boxShadow: '0 16px 48px rgba(15, 23, 42, 0.18)',
  textAlign: 'center',
}

const pendingConfirmIconStyle: React.CSSProperties = {
  fontSize: 40,
  lineHeight: 1,
}

const pendingConfirmTitleStyle: React.CSSProperties = {
  fontSize: 20,
  fontWeight: 900,
  color: '#0F172A',
}

const pendingConfirmSubtitleStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  color: '#64748B',
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
}

const pendingRejectBtnStyle: React.CSSProperties = {
  appearance: 'none',
  border: '1.5px solid #E2E8F0',
  width: '100%',
  minHeight: 46,
  borderRadius: 16,
  background: '#FFFFFF',
  color: '#64748B',
  fontSize: 15,
  fontWeight: 700,
  cursor: 'pointer',
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
  pointerEvents: 'auto',
}

const trackingTopBadgeStyle: React.CSSProperties = {
  justifySelf: 'start',
  padding: '6px 10px',
  borderRadius: 999,
  fontSize: 12,
  fontWeight: 800,
  letterSpacing: 0.2,
}

const trackingTopBadgeTravelStyle: React.CSSProperties = {
  background: 'rgba(37, 99, 235, 0.10)',
  color: '#1D4ED8',
}

const trackingTopBadgeArrivedStyle: React.CSSProperties = {
  background: 'rgba(217, 119, 6, 0.12)',
  color: '#B45309',
}

const trackingTopBadgeReadyStyle: React.CSSProperties = {
  background: 'rgba(14, 165, 233, 0.10)',
  color: '#0369A1',
}

const trackingTopBadgeActiveStyle: React.CSSProperties = {
  background: 'rgba(22, 163, 74, 0.12)',
  color: '#15803D',
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

const trackingEtaStatCardStyle: React.CSSProperties = {
  background: '#EFF6FF',
  borderColor: '#BFDBFE',
  boxShadow: '0 6px 18px rgba(37, 99, 235, 0.08)',
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

const languageSelectorRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  marginTop: 10,
}

const languageButtonStyle: React.CSSProperties = {
  minWidth: 92,
  height: 36,
  borderRadius: 12,
  border: '1px solid #E2E8F0',
  background: '#FFFFFF',
  color: '#0F172A',
  fontSize: 13,
  fontWeight: 800,
  cursor: 'pointer',
  fontFamily: 'inherit',
}

const languageButtonActiveStyle: React.CSSProperties = {
  borderColor: '#5B7CFA',
  background: '#EEF4FF',
  color: '#3152C8',
}

const serviceTypeSelectorRowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 10,
  marginTop: 10,
}

const serviceTypeButtonStyle: React.CSSProperties = {
  minHeight: 116,
  borderRadius: 18,
  border: '1px solid #E2E8F0',
  background: '#FFFFFF',
  color: '#0F172A',
  display: 'grid',
  justifyItems: 'start',
  alignContent: 'start',
  gap: 6,
  padding: '14px 12px',
  textAlign: 'left',
  cursor: 'pointer',
  fontFamily: 'inherit',
}

const serviceTypeButtonActiveStyle: React.CSSProperties = {
  borderColor: '#5B7CFA',
  background: '#EEF4FF',
  boxShadow: '0 10px 24px rgba(91, 124, 250, 0.16)',
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
  color: '#3152C8',
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
  paddingTop: 6,
}

const scheduleSheetStyle: React.CSSProperties = {
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
  padding: '10px 16px calc(16px + env(safe-area-inset-bottom))',
  backdropFilter: 'blur(18px)',
  WebkitBackdropFilter: 'blur(18px)',
}

const scheduleSheetHandleStyle: React.CSSProperties = {
  width: 44,
  height: 5,
  borderRadius: 999,
  background: 'rgba(148, 163, 184, 0.45)',
  margin: '0 auto 12px',
  flexShrink: 0,
}

const scheduleSheetHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 12,
  marginBottom: 12,
}

const scheduleSheetHeaderCopyStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'grid',
  gap: 4,
  textAlign: 'center',
}

const scheduleSheetTitleStyle: React.CSSProperties = {
  fontSize: 21,
  lineHeight: 1.2,
  fontWeight: 900,
  color: '#0F172A',
  letterSpacing: '-0.02em',
}

const scheduleSheetSubtitleStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.45,
  color: '#64748B',
}

const scheduleSheetCloseButtonStyle: React.CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: 12,
  border: '1px solid rgba(203, 213, 225, 0.9)',
  background: 'rgba(255,255,255,0.9)',
  color: '#0F172A',
  fontSize: 17,
  fontWeight: 800,
  cursor: 'pointer',
  flexShrink: 0,
  display: 'grid',
  placeItems: 'center',
}

const scheduleSheetScrollStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  maxHeight: 'min(72vh, 560px)',
  overflowY: 'auto',
  scrollbarWidth: 'none',
  msOverflowStyle: 'none',
  WebkitOverflowScrolling: 'touch',
}

const schedulePageContentStyle: React.CSSProperties = {
  width: '100%',
  maxWidth: 388,
  margin: '0 auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
}

const schedulePresetRowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 8,
}

const schedulePresetButtonStyle: React.CSSProperties = {
  borderRadius: 16,
  border: '1px solid rgba(203, 213, 225, 0.95)',
  background: 'rgba(248, 250, 252, 0.96)',
  color: '#0F172A',
  minHeight: 44,
  padding: '10px 12px',
  fontSize: 13,
  fontWeight: 800,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  whiteSpace: 'nowrap',
}

const schedulePresetButtonActiveStyle: React.CSSProperties = {
  background: 'linear-gradient(180deg, #12B3A6 0%, #0F8E85 100%)',
  borderColor: '#0F8E85',
  color: '#FFFFFF',
  boxShadow: '0 10px 22px rgba(15, 142, 133, 0.24)',
}

const schedulePickerCardStyle: React.CSSProperties = {
  borderRadius: 24,
  border: '1px solid rgba(226, 232, 240, 0.95)',
  background: 'linear-gradient(180deg, #FFFFFF 0%, #F8FAFC 100%)',
  padding: 14,
  boxShadow: '0 18px 38px rgba(15, 23, 42, 0.08)',
}

const WHEEL_ROW_HEIGHT = 44

const scheduleWheelHeaderRowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1.7fr 0.65fr 0.65fr',
  gap: 10,
  marginBottom: 10,
}

const scheduleWheelHeaderLabelStyle: React.CSSProperties = {
  fontSize: 12,
  lineHeight: 1.2,
  fontWeight: 800,
  color: '#64748B',
  textAlign: 'center',
}

const scheduleWheelWrapStyle: React.CSSProperties = {
  position: 'relative',
  height: 204,
}

const scheduleWheelColumnsStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1.7fr 0.65fr 0.65fr',
  gap: 10,
  height: '100%',
}

const scheduleWheelHighlightStyle: React.CSSProperties = {
  position: 'absolute',
  left: 0,
  right: 0,
  top: '50%',
  height: WHEEL_ROW_HEIGHT,
  transform: 'translateY(-50%)',
  borderRadius: 16,
  background: 'rgba(248, 250, 252, 0.98)',
  border: '1px solid rgba(203, 213, 225, 0.92)',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.92), 0 6px 18px rgba(148, 163, 184, 0.12)',
  pointerEvents: 'none',
}

const scheduleDispatchNoticeStyle: React.CSSProperties = {
  borderRadius: 18,
  background: 'linear-gradient(180deg, #F3F7FB 0%, #EDF4FB 100%)',
  border: '1px solid rgba(191, 219, 254, 0.95)',
  padding: '12px 14px',
  boxShadow: '0 10px 24px rgba(59, 130, 246, 0.08)',
}

const scheduleInfoRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
}

const scheduleInfoIconStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 999,
  background: 'rgba(59, 130, 246, 0.12)',
  color: '#2563EB',
  display: 'grid',
  placeItems: 'center',
  flexShrink: 0,
  fontSize: 15,
}

const scheduleInfoCopyStyle: React.CSSProperties = {
  display: 'grid',
  gap: 2,
  minWidth: 0,
}

const scheduleInfoTitleStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.45,
  fontWeight: 800,
  color: '#1E3A8A',
}

const scheduleInfoSubtitleStyle: React.CSSProperties = {
  fontSize: 12,
  lineHeight: 1.4,
  color: '#64748B',
}

const scheduleSummaryCardStyle: React.CSSProperties = {
  borderRadius: 20,
  background: 'linear-gradient(180deg, rgba(255,255,255,0.98) 0%, #F8FAFC 100%)',
  border: '1px solid rgba(226, 232, 240, 0.95)',
  padding: '14px 16px',
  display: 'grid',
  gap: 6,
  textAlign: 'center',
  boxShadow: '0 14px 30px rgba(15, 23, 42, 0.06)',
}

const scheduleSummaryPrimaryStyle: React.CSSProperties = {
  fontSize: 16,
  lineHeight: 1.45,
  fontWeight: 900,
  color: '#0F172A',
}

const scheduleSheetFooterStyle: React.CSSProperties = {
  paddingTop: 4,
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
  fontSize: 17,
  lineHeight: 1,
  cursor: 'pointer',
  fontFamily: 'inherit',
  transition: 'opacity 120ms ease, transform 120ms ease, color 120ms ease',
  scrollSnapAlign: 'center',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
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

const paymentSheetCardRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: '14px 16px',
  borderRadius: 16,
  border: '1.5px solid rgba(59,130,246,0.25)',
  background: 'rgba(239,246,255,0.5)',
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

const paymentSheetDefaultBadgeStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  color: '#2563EB',
  background: 'rgba(59,130,246,0.1)',
  borderRadius: 999,
  padding: '4px 10px',
  whiteSpace: 'nowrap',
  flexShrink: 0,
}

const paymentSheetActionsStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
}

const paymentSheetActionBtnStyle: React.CSSProperties = {
  appearance: 'none',
  border: 'none',
  background: 'transparent',
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '12px 16px',
  borderRadius: 12,
  fontSize: 15,
  fontWeight: 700,
  color: '#0F172A',
  cursor: 'pointer',
  textAlign: 'start',
}

const paymentSheetActionDisabledStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '12px 16px',
  borderRadius: 12,
  fontSize: 15,
  fontWeight: 700,
  color: '#CBD5E1',
  opacity: 0.7,
}

const paymentSheetComingSoonStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  color: '#94A3B8',
  background: 'rgba(241,245,249,0.9)',
  borderRadius: 999,
  padding: '3px 8px',
  marginInlineStart: 'auto',
}
