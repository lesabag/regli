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
}

interface UpcomingBookingItem {
  id: string
  dogName: string
  location: string
  scheduledFor: string | null
  startsInMin: number | null
  price: number | null
}

export default function ClientDashboard({ profile, onSignOut }: ClientDashboardProps) {
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
  const fileInputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const defaultDurationAppliedRef = useRef(false)

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [flow.screenState, flow.bookingTiming])


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
    if (defaultDurationAppliedRef.current) return
    defaultDurationAppliedRef.current = true
    flow.setDuration(20 as unknown as DurationType)
  }, [flow])

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

  const handleSignOut = useCallback(async () => {
    try {
      await onSignOut()
    } catch {
      window.location.reload()
    }
  }, [onSignOut])

  const handleFindWalker = useCallback(() => {
    if (!flow.dogName.trim() || !flow.location.trim() || !flow.savedCard) return
    flow.requestWalk()
  }, [flow.dogName, flow.location, flow.savedCard, flow.requestWalk])


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

  const upcomingScheduledItems = useMemo<UpcomingBookingItem[]>(
    () =>
      flow.upcomingJobs.map((j) => ({
        id: j.id,
        dogName: j.dog_name || 'Walk',
        location: j.location || '',
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
    recentRatings?: Array<Record<string, unknown>>
    setDogName?: (value: string) => void
    setLocation?: (value: string) => void
    setDuration?: (value: DurationType) => void
    setBookingTiming?: (value: 'asap' | 'scheduled') => void
    hideHistoryItem?: (id: string) => Promise<void>
  }

  const ratingsSource = (anyFlow.recentRatings ?? anyFlow.ratings ?? []) as Array<Record<string, unknown>>

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
            : typeof r.review_text === 'string'
              ? r.review_text
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

  const historyItems = useMemo<HistoryItem[]>(() => {
    const source = (
      anyFlow.completedJobs ??
      anyFlow.recentActivity ??
      anyFlow.recentJobs ??
      anyFlow.requests ??
      []
    ) as Array<Record<string, unknown>>

    return source
      .filter((item) => item.hidden_by_client !== true)
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
          address: location,
          created_at: createdAt,
          completed_at: createdAt,
          duration_minutes: durationMinutes,
          price,
          walker_name: walkerName,
          review_text: ratingInfo?.review ?? null,
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

  const isSearching = flow.screenState === 'searching'
  const isTrackingState = flow.screenState === 'tracking'
  const isIdleState = flow.screenState === 'idle'
  const showBanners = flow.screenState === 'idle' || flow.screenState === 'searching'
  const showNearbyWalkers = flow.screenState === 'idle' || flow.screenState === 'searching'

  const nearbyWalkers = useNearbyWalkers(
    flow.hasUserLocation ? flow.userLocation : null,
    flow.hasUserLocation && showNearbyWalkers,
  )

  const mapUserLocation: [number, number] =
    flow.userLocation ?? flow.walkerLocation ?? ([32.0853, 34.7818] as [number, number])

  const trackingGpsQuality: GpsQuality =
    flow.gpsQuality === 'last_known' ? 'delayed' : flow.gpsQuality

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
        anyFlow.setLocation(location)
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

  const currentMapStyle: React.CSSProperties = isTrackingState
    ? trackingMapContainerStyle
    : isSearching
      ? searchingMapContainerStyle
      : idleMapContainerStyle

  const currentSheetScrollStyle: React.CSSProperties = isIdleState
    ? idleSheetScrollStyle
    : sheetScrollStyle

  return (
    <div style={screenStyle}>
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
            <div style={{ position: 'relative' }}>
              <ProfileAvatar
                url={photo.avatarUrl}
                name={clientName}
                size={44}
                borderRadius={14}
                onClick={() => {
                  setBurgerOpen(false)
                  setProfileOpen((v) => !v)
                }}
              />
              {flow.avgRating !== null && (
                <div style={avatarRatingBadgeStyle}>
                  <span style={{ color: '#F59E0B', fontSize: 8 }}>★</span> {flow.avgRating}
                </div>
              )}
            </div>
          </div>
        </div>

        {showBanners && (flow.error || flow.successMessage) && (
          <div style={floatingMessagesStyle}>
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
                    items={historyItems}
                    role="client"
                    onBookAgain={handleBookAgain}
                    onHide={anyFlow.hideHistoryItem}
                    emptyTitle="No walk history yet"
                    emptySubtitle="Your completed walks and reviews will appear here."
                    maxMonths={12}
                  />
                </BurgerSection>
              ) : (
                <>
                  <BurgerSection
                    title="Future orders"
                    subtitle="Scheduled walks waiting to be dispatched."
                  >
                    <BurgerUpcomingList
                      items={upcomingScheduledItems}
                      onCancel={flow.cancelScheduledJob}
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
                          items={historyItems}
                          role="client"
                          onBookAgain={handleBookAgain}
                          onHide={anyFlow.hideHistoryItem}
                          emptyTitle="No walk history yet"
                          emptySubtitle="Your completed walks and reviews will appear here."
                          maxMonths={3}
                        />
                        {historyItems.length > 6 && (
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
                      style={dogInputButtonStyle}
                    >
                      <div style={dogInputShellStyle}>
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
                  </div>

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
                    <div style={compactDurationWrapStyle}>
                      <DurationPicker
                        options={DURATION_OPTIONS}
                        selected={flow.duration}
                        onSelect={(v) => flow.setDuration(v as DurationType)}
                        surgeMultiplier={flow.surgeMultiplier}
                        surgeLevel={flow.surgeLevel}
                      />
                    </div>
                  </div>

                  <div style={compactFieldStyle}>
                    <div style={compactPaymentWrapStyle}>
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
                durationLabel={flow.selectedDuration.label}
                priceLabel={`₪${flow.adjustedPriceILS}`}
                onCancel={flow.cancelSearch}
              />
            </div>
          )}

          {flow.screenState === 'tracking' && flow.activeJob && (
            <div style={sheetContentStyle}>
              <TrackingCard
                walkerName={
                  flow.activeJob.walker_id
                    ? flow.walkerNameById.get(flow.activeJob.walker_id) || 'Walker'
                    : 'Walker'
                }
                dogName={flow.activeJob.dog_name}
                isArrived={flow.isArrived}
                etaMinutes={flow.etaMinutes}
                displayEtaSeconds={flow.displayEtaSeconds}
                distanceMeters={flow.distanceMeters}
                gpsQuality={trackingGpsQuality}
              />
            </div>
          )}

          {flow.completionJob && (
            <div style={sheetContentStyle}>
              <CompletionCard
                title="Walk completed"
                subtitle={`${flow.completionJob.walkerName} walked your dog`}
                onRate={flow.submitCompletionRating}
                ratingSubmitting={flow.completionRatingSubmitting}
                alreadyRated={flow.ratedJobIds.has(flow.completionJob.jobId)}
                onDismiss={flow.dismissCompletion}
              />
            </div>
          )}
        </div>

        {isIdleState && (
          <div style={stickyCtaWrapStyle}>
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
                          : 'Find walker'
                }
                onClick={handleFindWalker}
                loading={flow.loading || flow.cardLoading}
                disabled={
                  !flow.dogName.trim() ||
                  !flow.location.trim() ||
                  !flow.savedCard ||
                  (flow.bookingTiming === 'scheduled' && !flow.scheduledFor)
                }
              />
            </div>
          </div>
        )}
      </div>

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

function BurgerSection({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <section style={burgerSectionStyle}>
      <div style={burgerSectionHeaderStyle}>
        <div style={burgerSectionTitleStyle}>{title}</div>
      </div>
      {subtitle && <div style={burgerSectionSubtitleStyle}>{subtitle}</div>}
      <div style={{ marginTop: 10 }}>{children}</div>
    </section>
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
              <div style={burgerListSubtitleStyle}>{item.location || 'Scheduled walk'}</div>
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
  isArrived,
  etaMinutes,
  displayEtaSeconds,
  distanceMeters,
  gpsQuality,
}: {
  walkerName: string
  dogName: string | null
  isArrived: boolean
  etaMinutes: number | null
  displayEtaSeconds: number | null
  distanceMeters: number | null
  gpsQuality: GpsQuality
}) {
  return (
    <div style={trackingCardStyle}>
      <div style={trackingTopBadgeStyle}>{isArrived ? 'Walker arrived' : 'Walker on the way'}</div>
      <div style={trackingTitleStyle}>{walkerName}</div>
      <div style={trackingSubtitleStyle}>
        {dogName ? `${walkerName} is heading to ${dogName}` : `${walkerName} is heading to you`}
      </div>

      <div style={trackingStatsGridStyle}>
        <div style={trackingStatCardStyle}>
          <div style={trackingStatLabelStyle}>ETA</div>
          <div style={trackingStatValueStyle}>
            {formatEta(etaMinutes, displayEtaSeconds, isArrived)}
          </div>
        </div>
        <div style={trackingStatCardStyle}>
          <div style={trackingStatLabelStyle}>Distance</div>
          <div style={trackingStatValueStyle}>{formatDistance(distanceMeters, isArrived)}</div>
        </div>
        <div style={trackingStatCardStyle}>
          <div style={trackingStatLabelStyle}>GPS</div>
          <div style={trackingStatValueStyle}>{formatGpsQuality(gpsQuality)}</div>
        </div>
      </div>
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
  background: '#F8FAFC',
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
  isolation: 'isolate',
}

const topUiLayerStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  pointerEvents: 'none',
  zIndex: 5000,
}

const mapContainerBaseStyle: React.CSSProperties = {
  position: 'relative',
  flexShrink: 0,
  minHeight: 220,
  overflow: 'hidden',
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
  left: 14,
  right: 14,
  zIndex: 3001,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  pointerEvents: 'none',
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
  transform: 'scale(0.96)',
  transformOrigin: 'center',
}

const avatarRatingBadgeStyle: React.CSSProperties = {
  position: 'absolute',
  right: -6,
  bottom: -6,
  padding: '2px 7px',
  borderRadius: 999,
  background: '#FFFFFF',
  color: '#0F172A',
  fontSize: 10,
  fontWeight: 800,
  boxShadow: '0 6px 18px rgba(15, 23, 42, 0.16)',
  border: '1px solid rgba(255,255,255,0.95)',
  whiteSpace: 'nowrap',
}

const floatingMessagesStyle: React.CSSProperties = {
  position: 'fixed',
  left: 14,
  right: 14,
  top: 'calc(74px + env(safe-area-inset-top))',
  zIndex: 3000,
  display: 'grid',
  gap: 8,
  pointerEvents: 'none',
}

const sheetStyle: React.CSSProperties = {
  position: 'relative',
  marginTop: -18,
  flex: 1,
  minHeight: 0,
  borderTopLeftRadius: 28,
  borderTopRightRadius: 28,
  background: '#FFFFFF',
  boxShadow: '0 -10px 30px rgba(15, 23, 42, 0.10)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  zIndex: 1,
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
  padding: '0 14px 12px',
  WebkitOverflowScrolling: 'touch',
}

const idleSheetScrollStyle: React.CSSProperties = {
  ...sheetScrollStyle,
  overflowY: 'auto',
  paddingBottom: 6,
}

const sheetContentStyle: React.CSSProperties = {
  paddingBottom: 12,
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

const compactFieldStyle: React.CSSProperties = {
  display: 'grid',
  gap: 4,
}

const compactFieldLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  letterSpacing: 0.6,
  textTransform: 'uppercase',
  color: '#64748B',
}

const dogInputShellStyle: React.CSSProperties = {
  height: 48,
  borderRadius: 16,
  border: '1px solid #E2E8F0',
  background: '#FFFFFF',
  display: 'flex',
  alignItems: 'center',
  overflow: 'hidden',
}

const dogThumbStyle: React.CSSProperties = {
  width: 42,
  height: 42,
  borderRadius: 12,
  marginLeft: 4,
  marginRight: 2,
  background: 'linear-gradient(180deg, #FEF3C7 0%, #FDE68A 100%)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 20,
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
  fontSize: 17,
  color: '#0F172A',
  fontWeight: 700,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const dogInputPlaceholderTextStyle: React.CSSProperties = {
  fontSize: 17,
  color: '#94A3B8',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const dogInputChevronStyle: React.CSSProperties = {
  paddingRight: 14,
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
  left: 0,
  right: 0,
  bottom: 0,
  zIndex: 121,
  borderTopLeftRadius: 28,
  borderTopRightRadius: 28,
  background: '#FFFFFF',
  boxShadow: '0 -16px 44px rgba(15, 23, 42, 0.20)',
  padding: '10px 16px calc(18px + env(safe-area-inset-bottom))',
  display: 'grid',
  gap: 14,
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
  height: 48,
  borderRadius: 16,
  border: '1px solid #E2E8F0',
  background: '#FFFFFF',
  outline: 'none',
  padding: '0 14px',
  fontSize: 17,
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
  padding: '10px 12px',
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
}

const compactPaymentWrapStyle: React.CSSProperties = {
  marginTop: 0,
}

const feeLabelStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#64748B',
  lineHeight: 1.3,
  textAlign: 'center',
  paddingTop: 0,
}

const stickyCtaWrapStyle: React.CSSProperties = {
  padding: '8px 14px calc(10px + env(safe-area-inset-bottom))',
  borderTop: '1px solid rgba(226, 232, 240, 0.9)',
  background: 'rgba(255,255,255,0.96)',
  backdropFilter: 'blur(10px)',
  flexShrink: 0,
}

const stickyMainActionStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
}

const trackingCardStyle: React.CSSProperties = {
  borderRadius: 22,
  border: '1px solid #E2E8F0',
  background: 'linear-gradient(180deg, #FFFFFF 0%, #F8FAFC 100%)',
  padding: 16,
  display: 'grid',
  gap: 12,
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
}

const trackingSubtitleStyle: React.CSSProperties = {
  fontSize: 14,
  color: '#475569',
  lineHeight: 1.45,
}

const trackingStatsGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  gap: 10,
}

const trackingStatCardStyle: React.CSSProperties = {
  borderRadius: 16,
  background: '#FFFFFF',
  border: '1px solid #E2E8F0',
  padding: '12px 10px',
  display: 'grid',
  gap: 6,
  justifyItems: 'center',
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
}

const menuOverlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(15, 23, 42, 0.26)',
  zIndex: 40000,
}

const menuPanelStyle: React.CSSProperties = {
  position: 'fixed',
  top: 'calc(16px + env(safe-area-inset-top))',
  left: 12,
  bottom: 'calc(16px + env(safe-area-inset-bottom))',
  width: 'min(360px, calc(100vw - 24px))',
  borderRadius: 28,
  background: '#FFFFFF',
  boxShadow: '0 24px 60px rgba(15, 23, 42, 0.22)',
  zIndex: 40001,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
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
  gap: 4,
  paddingBottom: 18,
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
  right: 14,
  width: 'min(320px, calc(100vw - 28px))',
  borderRadius: 24,
  background: '#FFFFFF',
  boxShadow: '0 24px 60px rgba(15, 23, 42, 0.18)',
  zIndex: 40001,
  overflow: 'hidden',
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
