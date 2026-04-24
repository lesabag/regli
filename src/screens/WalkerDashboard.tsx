import { hapticMedium, hapticSuccess } from '../utils/haptics'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import NotificationsBell from '../components/NotificationsBell'
import ProfileAvatar from '../components/ProfileAvatar'
import CompactRatingList from '../components/CompactRatingList'
import CompletionCard from '../components/CompletionCard'
import GroupedHistory from '../components/GroupedHistory'
import type { HistoryItem } from '../components/GroupedHistory'
import { useWalkerFlow } from '../hooks/useWalkerFlow'
import { useProfilePhoto } from '../hooks/useProfilePhoto'
import { usePushNotifications } from '../hooks/usePushNotifications'
import { formatShortAddress } from '../utils/addressFormat'
import { getServiceLabels } from '../utils/serviceLifecycle'
import { getDurationSummary } from '../utils/serviceTiming'

const REQUEST_TIMEOUT_SECONDS = 20

type AppRole = 'client' | 'walker' | 'admin'

interface WalkerDashboardProps {
  profile: {
    id: string
    email: string | null
    full_name: string | null
    role: AppRole
  }
  onSignOut: () => Promise<void>
}

interface ConnectStatus {
  connected: boolean
  stripe_connect_account_id: string | null
  stripe_connect_onboarding_complete: boolean
  payouts_enabled: boolean
  charges_enabled: boolean
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

function durationFromPrice(price: number | null | undefined): string {
  if (price == null) return '—'
  if (price <= 30) return '20 min'
  if (price <= 50) return '40 min'
  return '60 min'
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

export default function WalkerDashboard({ profile, onSignOut }: WalkerDashboardProps) {
  const walkerName = profile.full_name || profile.email || 'Walker'
  const flow = useWalkerFlow(profile.id, walkerName)
  const photo = useProfilePhoto(profile.id)
  usePushNotifications(profile.id)

  const [burgerOpen, setBurgerOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [historyView, setHistoryView] = useState<'menu' | 'all'>('menu')
  const [historyOpen, setHistoryOpen] = useState(true)
  const [compRating, setCompRating] = useState(0)
  const [compHover, setCompHover] = useState(0)
  const [compPressed, setCompPressed] = useState(0)
  const [compReview, setCompReview] = useState('')
  const [compRatingDone, setCompRatingDone] = useState(false)
  const [hiddenHistoryIds, setHiddenHistoryIds] = useState<string[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

  const closeAll = useCallback(() => {
    setBurgerOpen(false)
    setProfileOpen(false)
    setHistoryView('menu')
  }, [])

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(`regli_walker_history_hidden_${profile.id}`)
      if (!raw) return
      const parsed = JSON.parse(raw) as string[]
      setHiddenHistoryIds(Array.isArray(parsed) ? parsed : [])
    } catch {
      // noop
    }
  }, [profile.id])

  const persistHiddenIds = useCallback(
    (ids: string[]) => {
      setHiddenHistoryIds(ids)
      try {
        window.localStorage.setItem(`regli_walker_history_hidden_${profile.id}`, JSON.stringify(ids))
      } catch {
        // noop
      }
    },
    [profile.id],
  )

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
  const onTheWayLabels = getServiceLabels(onTheWayJob?.service_type)
  const activeLabels = getServiceLabels(activeJob?.service_type)
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

  const requestDuration = topRequest?.price ? durationFromPrice(topRequest.price) : '—'
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
        plannedMinutes: activeJob?.price ? (activeJob.price <= 30 ? 20 : activeJob.price <= 50 ? 40 : 60) : null,
        startedAt: activeJob?.service_started_at ?? null,
        completedAt: activeJob?.service_completed_at ?? null,
        now: serviceClockNow,
      }),
    [activeJob?.price, activeJob?.service_started_at, activeJob?.service_completed_at, serviceClockNow],
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
        plannedMinutes: completionJobDetails?.price
          ? completionJobDetails.price <= 30
            ? 20
            : completionJobDetails.price <= 50
              ? 40
              : 60
          : null,
        startedAt: completionJobDetails?.service_started_at ?? null,
        completedAt: completionJobDetails?.service_completed_at ?? null,
      }),
    [
      completionJobDetails?.price,
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
          client_name: j.client?.full_name || j.client?.email || 'Client',
          address: formatShortAddress(j.location),
          rating: ratingInfo?.rating ?? null,
          review: ratingInfo?.review ?? null,
          price: j.walker_earnings ?? (j.price != null ? Math.round(j.price * 0.8) : null),
          tip_amount: j.tip_amount ?? null,
          status: j.status,
          created_at: j.created_at,
          completed_at: j.created_at,
          hidden_by_walker: hiddenHistoryIds.includes(j.id),
        }
      })
  }, [flow.completedJobs, flow.ratingsReceived, hiddenHistoryIds])

  const visibleHistoryItems = useMemo(
    () => allHistoryItems.filter((item) => item.hidden_by_walker !== true).slice(0, 7),
    [allHistoryItems],
  )

  const clientNameById = useMemo(() => {
    const map = new Map<string, string>()
    flow.completedJobs.forEach((j) => {
      if (j.client?.id) {
        map.set(j.client.id, j.client.full_name || j.client.email || 'Client')
      }
    })
    return map
  }, [flow.completedJobs])

  const formattedRatings = useMemo(
    () =>
      flow.ratingsReceived.slice(0, 4).map((r) => ({
        id: r.id,
        rating: r.rating,
        review: r.review,
        authorName: clientNameById.get(r.from_user_id) || 'Client',
        date: formatRelativeDate(r.created_at),
      })),
    [flow.ratingsReceived, clientNameById],
  )

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
      const next = [...hiddenHistoryIds, id]
      persistHiddenIds(next)
    },
    [hiddenHistoryIds, persistHiddenIds],
  )

  return (
    <>
      <div style={screenStyle}>
        <div style={headerStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0, flex: 1 }}>
            <button
              type="button"
              onClick={() => {
                setProfileOpen(false)
                setBurgerOpen((v) => !v)
              }}
              style={headerMenuBtnStyle}
              aria-label="Menu"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0F172A" strokeWidth="2.2" strokeLinecap="round">
                <line x1="4" y1="7" x2="20" y2="7" />
                <line x1="4" y1="12" x2="20" y2="12" />
                <line x1="4" y1="17" x2="20" y2="17" />
              </svg>
            </button>
            <div style={{ minWidth: 0 }}>
              <h1 style={greetingStyle}>Hey, {flow.firstName}</h1>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            {!isActiveOrCompleted && !flow.onlineLoading && (
              <div style={toggleGroupStyle}>
                <div style={statusLabelWrapStyle}>
                  <div
                    style={{
                      ...statusDotStyle,
                      background: flow.isOnline ? '#16A34A' : '#94A3B8',
                    }}
                  />
                  <span style={{ ...statusLabelStyle, color: flow.isOnline ? '#15803D' : '#94A3B8' }}>
                    {flow.isOnline ? 'Online' : 'Offline'}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={flow.toggleOnline}
                  style={{ ...toggleBtnStyle, background: flow.isOnline ? '#16A34A' : '#CBD5E1' }}
                >
                  <div
                    style={{
                      ...toggleKnobStyle,
                      transform: flow.isOnline ? 'translateX(18px)' : 'translateX(0)',
                    }}
                  />
                </button>
              </div>
            )}

            <NotificationsBell />
          </div>
        </div>

        {burgerOpen && (
          <>
            <div style={menuOverlayStyle} onClick={closeAll} />
            <div style={menuPanelStyle}>
              <div style={menuHeaderStyle}>
                <button
                  type="button"
                  onClick={() => {
                    if (historyView === 'all') {
                      setHistoryView('menu')
                    } else {
                      closeAll()
                    }
                  }}
                  style={menuHeaderIconButtonStyle}
                  aria-label={historyView === 'all' ? 'Back' : 'Close'}
                >
                  {historyView === 'all' ? (
                    <span style={menuBackGlyphStyle}>‹</span>
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0F172A" strokeWidth="2.2" strokeLinecap="round">
                      <line x1="4" y1="7" x2="20" y2="7" />
                      <line x1="4" y1="12" x2="20" y2="12" />
                      <line x1="4" y1="17" x2="20" y2="17" />
                    </svg>
                  )}
                </button>
                <span style={menuHeaderTitleStyle}>{historyView === 'all' ? 'All history' : 'Menu'}</span>
              </div>

              <div style={menuDividerStyle} />

              {historyView === 'all' ? (
                <div style={historyContainerStyle}>
                  <GroupedHistory
                    items={allHistoryItems}
                    role="walker"
                    compact
                    onHide={hideHistoryItem}
                    emptyTitle="No walk history yet"
                    emptySubtitle="Completed jobs and client feedback will appear here."
                  />
                </div>
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
                    <ProfileAvatar url={photo.avatarUrl} name={walkerName} size={48} borderRadius={16} />
                    <div style={menuProfileTextStyle}>
                      <div style={profileNameStyle}>{walkerName}</div>
                      {profile.email && <div style={profileEmailStyle}>{profile.email}</div>}
                      {flow.avgRating !== null && (
                        <div style={profileRatingStyle}>
                          <span style={{ color: '#F59E0B' }}>★</span> {flow.avgRating} · {flow.ratingsReceived.length} review
                          {flow.ratingsReceived.length !== 1 ? 's' : ''}
                        </div>
                      )}
                    </div>
                    <div style={menuProfileChevronStyle}>›</div>
                  </button>

                  <div style={menuDividerStyle} />

                  <button type="button" onClick={() => setHistoryOpen((v) => !v)} style={menuItemActionStyle}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <polyline points="12 6 12 12 16 14" />
                    </svg>
                    <span style={{ flex: 1 }}>Walk history</span>
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#94A3B8"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      style={{ transform: historyOpen ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s' }}
                    >
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>

                  {historyOpen && (
                    <div style={historyContainerStyle}>
                      <GroupedHistory
                        items={visibleHistoryItems}
                        role="walker"
                        compact
                        onHide={hideHistoryItem}
                        emptyTitle="No walk history yet"
                        emptySubtitle="Completed jobs and client feedback will appear here."
                      />
                      {allHistoryItems.length > 7 && (
                        <div style={viewAllWrapStyle}>
                          <button type="button" onClick={() => setHistoryView('all')} style={viewAllButtonStyle}>
                            View all
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  <div style={menuDividerStyle} />

                  <button
                    type="button"
                    onClick={() => {
                      closeAll()
                      void onSignOut()
                    }}
                    style={menuSignOutBtnStyle}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#EF4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                      <polyline points="16 17 21 12 16 7" />
                      <line x1="21" y1="12" x2="9" y2="12" />
                    </svg>
                    <span>Sign out</span>
                  </button>
                </>
              )}
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
                    name={walkerName}
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
                  <div style={profileNameStyle}>{walkerName}</div>
                  {profile.email && <div style={profileEmailStyle}>{profile.email}</div>}
                  {flow.avgRating !== null && (
                    <div style={profileRatingStyle}>
                      <span style={{ color: '#F59E0B' }}>★</span> {flow.avgRating} · {flow.ratingsReceived.length} review
                      {flow.ratingsReceived.length !== 1 ? 's' : ''}
                    </div>
                  )}
                </div>
              </div>

              {photo.uploading && <div style={uploadStatusStyle}>Uploading photo...</div>}
              {photo.error && <div style={uploadErrorStyle}>{photo.error}</div>}

              <div style={menuDividerStyle} />

              <button type="button" onClick={() => fileInputRef.current?.click()} style={profileActionBtnStyle}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z" />
                  <path d="M9 2 7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2h-3.17L15 2H9z" />
                </svg>
                <span>Change photo</span>
              </button>
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
              <div style={statusHintStyle}>
                <span>Go online to receive walk requests</span>
              </div>

              <WalletCard balance={flow.wallet.availableBalance} pending={flow.wallet.pendingEarnings} />

              <ConnectOnboardingCard
                status={flow.connectStatus}
                loading={flow.connectLoading}
                error={flow.connectError}
                onConnect={flow.handleConnectAccount}
                onContinue={flow.handleContinueOnboarding}
                onRefresh={flow.fetchConnectStatus}
              />
            </div>
          )}

          {flow.screenState === 'waiting' && (
            <div className="sheet-state-enter">
              <div style={statusHintOnlineStyle}>
                <div style={waitingDotStyle} />
                <span>Waiting for requests</span>
              </div>

              <WalletCard balance={flow.wallet.availableBalance} pending={flow.wallet.pendingEarnings} />

              <ConnectOnboardingCard
                status={flow.connectStatus}
                loading={flow.connectLoading}
                error={flow.connectError}
                onConnect={flow.handleConnectAccount}
                onContinue={flow.handleContinueOnboarding}
                onRefresh={flow.fetchConnectStatus}
              />
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
              <p style={activeClientStyle}>for {onTheWayJob.client?.full_name || onTheWayJob.client?.email || 'Client'}</p>

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
                    ? onTheWayLabels.startAction
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
              <p style={activeClientStyle}>for {activeJob.client?.full_name || activeJob.client?.email || 'Client'}</p>

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
                disabled={flow.completingJobId === activeJob.id || !activeJobCanComplete}
                style={{
                  ...completeBtnStyle,
                  opacity: flow.completingJobId === activeJob.id || !activeJobCanComplete ? 0.7 : 1,
                  cursor: flow.completingJobId === activeJob.id || !activeJobCanComplete ? 'not-allowed' : 'pointer',
                }}
              >
                {flow.completingJobId === activeJob.id
                  ? 'Completing...'
                  : activeJobCanComplete
                    ? activeLabels.completeAction
                    : 'Available at dispatch time'}
              </button>
            </div>
          )}

          {flow.screenState === 'completed' && flow.completionSuccess && (
            <div className="sheet-state-enter" style={completionCardStyle}>
              <div style={checkStyle}>✓</div>
              <h3 style={completionTitleStyle}>{getServiceLabels(null).completedTitle}</h3>
              <p style={completionSubStyle}>{flow.completionSuccess.clientName}'s dog</p>

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
                  <p style={ratingPromptStyle}>How was {flow.completionSuccess.clientName}?</p>
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
              <span style={newRequestLabelStyle}>New request</span>
              <span style={{ ...countdownLabelStyle, color: countdown <= 5 ? '#EF4444' : '#F59E0B' }}>
                {countdown}s
              </span>
            </div>

            <div style={progressTrackStyle}>
              <div style={{ ...progressFillStyle, width: `${(countdown / REQUEST_TIMEOUT_SECONDS) * 100}%` }} />
            </div>

            <div style={dogNameStyle}>{topRequest.dog_name || 'Dog'}</div>

            {topRequest.location && (
              <div style={reqLocationStyle}>
                <span style={ellipsisStyle}>{formatShortAddress(topRequest.address || topRequest.location)}</span>
              </div>
            )}

            <div style={infoPillsRowStyle}>
              <div style={infoPillStyle}><span>{requestDuration}</span></div>
              <div style={infoPillDividerStyle} />
              <div style={{ ...infoPillStyle, color: '#15803D', fontWeight: 800 }}><span>{requestPrice}</span></div>
            </div>

            {flow.openJobs.length > 1 && <div style={queueHintStyle}>+{flow.openJobs.length - 1} more in queue</div>}

            <div style={ctaContainerStyle}>
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

      {flow.completionSuccess && (
        <div style={completionOverlayStyle}>
          <div style={completionOverlayBackdropStyle} />
          <div style={completionOverlayCardStyle}>
            <CompletionCard
              promptKey={flow.completionSuccess.jobId}
              title={getServiceLabels(null).completedTitle}
              subtitle={`Rate ${flow.completionSuccess.clientName}`}
              metaRows={completionMetaRows}
              earnings={
                flow.completionSuccess.earnings != null && flow.completionSuccess.earnings > 0
                  ? `₪${flow.completionSuccess.earnings.toFixed(0)}`
                  : undefined
              }
              onRate={flow.submitCompletionRating}
              ratingSubmitting={flow.completionRatingSubmitting}
              alreadyRated={flow.ratedJobIds.has(flow.completionSuccess.jobId)}
              onDismiss={flow.dismissCompletion}
            />
          </div>
        </div>
      )}
    </>
  )
}

function WalletCard({ balance, pending }: { balance: number; pending: number }) {
  return (
    <div style={walletCardStyle}>
      <div style={walletHeaderStyle}>Wallet</div>
      <div style={walletRowStyle}>
        <div>
          <div style={walletLabelStyle}>Available</div>
          <div style={walletValueStyle}>₪{balance.toFixed(0)}</div>
        </div>
        <div>
          <div style={walletLabelStyle}>Pending</div>
          <div style={walletValueStyle}>₪{pending.toFixed(0)}</div>
        </div>
      </div>
    </div>
  )
}

function ConnectOnboardingCard({
  status,
  loading,
  error,
  onConnect,
  onContinue,
  onRefresh,
}: {
  status: ConnectStatus | null
  loading: boolean
  error: string | null
  onConnect: () => Promise<void> | void
  onContinue: () => Promise<void> | void
  onRefresh: () => Promise<void> | void
}) {
  return (
    <div style={connectCardStyle}>
      <div style={connectTitleStyle}>Payout setup</div>
      {loading ? (
        <div style={connectSubStyle}>Loading payout status...</div>
      ) : error ? (
        <div style={connectErrorStyle}>{error}</div>
      ) : status?.connected && status.stripe_connect_onboarding_complete && status.payouts_enabled ? (
        <div style={connectReadyStyle}>Ready to receive payouts</div>
      ) : status?.connected ? (
        <>
          <div style={connectSubStyle}>Complete your Stripe onboarding to receive payouts.</div>
          <div style={connectActionsStyle}>
            <button type="button" onClick={() => void onContinue()} style={primaryMiniBtnStyle}>
              Continue
            </button>
            <button type="button" onClick={() => void onRefresh()} style={secondaryMiniBtnStyle}>
              Refresh
            </button>
          </div>
        </>
      ) : (
        <>
          <div style={connectSubStyle}>Connect Stripe to receive your earnings.</div>
          <div style={connectActionsStyle}>
            <button type="button" onClick={() => void onConnect()} style={primaryMiniBtnStyle}>
              Connect
            </button>
            <button type="button" onClick={() => void onRefresh()} style={secondaryMiniBtnStyle}>
              Refresh
            </button>
          </div>
        </>
      )}
    </div>
  )
}

const screenStyle: React.CSSProperties = {
  minHeight: '100dvh',
  background: '#F8FAFC',
  color: '#0F172A',
  fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
  overflowY: 'auto',
  WebkitOverflowScrolling: 'touch',
}

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: 'calc(18px + env(safe-area-inset-top)) 18px 12px',
  position: 'sticky',
  top: 0,
  zIndex: 20,
  background: 'rgba(248, 250, 252, 0.92)',
  backdropFilter: 'blur(10px)',
}

const headerMenuBtnStyle: React.CSSProperties = {
  width: 46,
  height: 46,
  borderRadius: 16,
  border: 'none',
  background: '#FFFFFF',
  boxShadow: '0 8px 20px rgba(15, 23, 42, 0.08)',
  display: 'grid',
  placeItems: 'center',
  cursor: 'pointer',
}

const greetingStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 22,
  fontWeight: 800,
  lineHeight: 1.1,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const toggleGroupStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
}

const statusLabelWrapStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
}

const statusDotStyle: React.CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: 999,
}

const statusLabelStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
}

const toggleBtnStyle: React.CSSProperties = {
  width: 50,
  height: 32,
  borderRadius: 999,
  border: 'none',
  padding: 3,
  position: 'relative',
  cursor: 'pointer',
  transition: 'background 0.2s ease',
}

const toggleKnobStyle: React.CSSProperties = {
  width: 26,
  height: 26,
  borderRadius: 999,
  background: '#FFFFFF',
  transition: 'transform 0.2s ease',
}

const menuOverlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(15, 23, 42, 0.26)',
  zIndex: 30,
}

const menuPanelStyle: React.CSSProperties = {
  position: 'fixed',
  top: 'calc(90px + env(safe-area-inset-top))',
  left: 18,
  width: 'min(560px, calc(100vw - 36px))',
  maxHeight: 'calc(100dvh - 130px)',
  overflow: 'hidden',
  background: '#FFFFFF',
  borderRadius: 34,
  boxShadow: '0 30px 80px rgba(15, 23, 42, 0.18)',
  zIndex: 31,
  display: 'flex',
  flexDirection: 'column',
}

const menuHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '26px 26px 18px',
  fontSize: 18,
  fontWeight: 800,
}

const menuHeaderIconButtonStyle: React.CSSProperties = {
  appearance: 'none',
  border: 'none',
  background: 'transparent',
  width: 32,
  height: 32,
  padding: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  color: '#0F172A',
}

const menuBackGlyphStyle: React.CSSProperties = {
  fontSize: 32,
  lineHeight: 1,
  fontWeight: 700,
  marginTop: -2,
}

const menuHeaderTitleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 800,
}

const menuDividerStyle: React.CSSProperties = {
  height: 1,
  background: '#E5E7EB',
  margin: '0 24px',
}

const menuProfileButtonStyle: React.CSSProperties = {
  margin: '18px 24px',
  border: '1px solid #E2E8F0',
  background: '#FFFFFF',
  borderRadius: 20,
  padding: 12,
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  cursor: 'pointer',
  textAlign: 'left',
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

const menuItemActionStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  width: '100%',
  padding: '22px 24px',
  border: 'none',
  background: 'transparent',
  fontSize: 17,
  fontWeight: 800,
  color: '#475569',
  cursor: 'pointer',
  textAlign: 'left',
}

const historyContainerStyle: React.CSSProperties = {
  padding: '0 20px 14px',
  overflowY: 'auto',
}

const viewAllWrapStyle: React.CSSProperties = {
  marginTop: 10,
  textAlign: 'center',
}

const viewAllButtonStyle: React.CSSProperties = {
  appearance: 'none',
  border: '1px solid #E2E8F0',
  background: '#FFFFFF',
  color: '#0F172A',
  borderRadius: 999,
  padding: '9px 16px',
  fontSize: 13,
  fontWeight: 800,
  cursor: 'pointer',
}

const menuSignOutBtnStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  width: '100%',
  padding: '26px 24px',
  border: 'none',
  background: 'transparent',
  color: '#EF4444',
  fontSize: 17,
  fontWeight: 800,
  cursor: 'pointer',
  textAlign: 'left',
}

const profilePanelStyle: React.CSSProperties = {
  position: 'fixed',
  top: 'calc(90px + env(safe-area-inset-top))',
  right: 18,
  width: 'min(320px, calc(100vw - 36px))',
  background: '#FFFFFF',
  borderRadius: 28,
  boxShadow: '0 24px 70px rgba(15, 23, 42, 0.18)',
  zIndex: 31,
  overflow: 'hidden',
}

const profileSectionStyle: React.CSSProperties = {
  display: 'flex',
  gap: 14,
  alignItems: 'center',
  padding: '22px 20px 18px',
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

const cameraIconStyle: React.CSSProperties = {
  position: 'absolute',
  right: -2,
  bottom: -2,
  width: 22,
  height: 22,
  borderRadius: 999,
  background: '#2563EB',
  display: 'grid',
  placeItems: 'center',
  border: '2px solid #FFFFFF',
}

const uploadStatusStyle: React.CSSProperties = {
  padding: '0 20px 12px',
  fontSize: 12,
  color: '#64748B',
}

const uploadErrorStyle: React.CSSProperties = {
  padding: '0 20px 12px',
  fontSize: 12,
  color: '#DC2626',
}

const profileActionBtnStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  width: '100%',
  padding: '16px 20px',
  border: 'none',
  background: 'transparent',
  fontSize: 14,
  fontWeight: 700,
  color: '#475569',
  cursor: 'pointer',
  textAlign: 'left',
}

const contentStyle: React.CSSProperties = {
  padding: '10px 18px calc(32px + env(safe-area-inset-bottom))',
  display: 'grid',
  gap: 14,
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

const statusHintStyle: React.CSSProperties = {
  padding: '14px 16px',
  borderRadius: 18,
  background: '#FFFFFF',
  border: '1px solid #E2E8F0',
  color: '#64748B',
  fontWeight: 700,
}

const statusHintOnlineStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '14px 16px',
  borderRadius: 18,
  background: '#ECFDF5',
  color: '#166534',
  fontWeight: 800,
}

const waitingDotStyle: React.CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: 999,
  background: '#16A34A',
}

const walletCardStyle: React.CSSProperties = {
  padding: '18px 18px',
  borderRadius: 24,
  background: '#FFFFFF',
  border: '1px solid #E2E8F0',
}

const walletHeaderStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 800,
  color: '#0F172A',
}

const walletRowStyle: React.CSSProperties = {
  marginTop: 14,
  display: 'flex',
  justifyContent: 'space-between',
  gap: 14,
}

const walletLabelStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#64748B',
  fontWeight: 700,
}

const walletValueStyle: React.CSSProperties = {
  marginTop: 4,
  fontSize: 24,
  fontWeight: 800,
  color: '#0F172A',
}

const connectCardStyle: React.CSSProperties = {
  padding: '18px',
  borderRadius: 24,
  background: '#FFFFFF',
  border: '1px solid #E2E8F0',
}

const connectTitleStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 800,
}

const connectSubStyle: React.CSSProperties = {
  marginTop: 6,
  fontSize: 13,
  color: '#64748B',
  lineHeight: 1.45,
}

const connectErrorStyle: React.CSSProperties = {
  marginTop: 6,
  fontSize: 13,
  color: '#DC2626',
}

const connectReadyStyle: React.CSSProperties = {
  marginTop: 8,
  fontSize: 13,
  color: '#166534',
  fontWeight: 800,
}

const connectActionsStyle: React.CSSProperties = {
  marginTop: 12,
  display: 'flex',
  gap: 10,
}

const primaryMiniBtnStyle: React.CSSProperties = {
  minHeight: 40,
  padding: '0 16px',
  border: 'none',
  borderRadius: 14,
  background: '#08153B',
  color: '#FFFFFF',
  fontSize: 13,
  fontWeight: 800,
  cursor: 'pointer',
}

const secondaryMiniBtnStyle: React.CSSProperties = {
  minHeight: 40,
  padding: '0 16px',
  border: '1px solid #E2E8F0',
  borderRadius: 14,
  background: '#FFFFFF',
  color: '#334155',
  fontSize: 13,
  fontWeight: 800,
  cursor: 'pointer',
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
  alignItems: 'center',
  justifyContent: 'space-between',
}

const newRequestLabelStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 800,
  color: '#0F172A',
}

const countdownLabelStyle: React.CSSProperties = {
  fontSize: 14,
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
  marginTop: 16,
  fontSize: 28,
  fontWeight: 900,
  color: '#0F172A',
}

const reqLocationStyle: React.CSSProperties = {
  marginTop: 10,
  padding: '14px 16px',
  borderRadius: 18,
  background: '#F8FAFC',
  border: '1px solid #E2E8F0',
}

const infoPillsRowStyle: React.CSSProperties = {
  marginTop: 14,
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '14px 16px',
  borderRadius: 18,
  background: '#F8FAFC',
}

const infoPillStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 14,
  color: '#475569',
  fontWeight: 700,
}

const infoPillDividerStyle: React.CSSProperties = {
  width: 1,
  alignSelf: 'stretch',
  background: '#E2E8F0',
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
