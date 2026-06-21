import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatShortAddress } from '../utils/addressFormat'
import { formatDogCountLabel, isDogServiceType } from '../utils/dogCount'
import { formatDurationFromMinutes } from '../utils/serviceTiming'

type Role = 'client' | 'walker'

type Primitive = string | number | boolean | null | undefined

export type HistoryItem = {
  id?: string | number
  status?: string | null
  dog_name?: string | null
  dogName?: string | null
  dog_count?: number | null
  dogCount?: number | null
  service_type?: string | null
  serviceType?: string | null
  address?: string | null
  location?: string | null
  created_at?: string | null
  completed_at?: string | null
  scheduled_at?: string | null
  updated_at?: string | null
  price?: number | string | null
  duration_minutes?: number | null
  durationMinutes?: number | null
  tip_amount?: number | null
  tipAmount?: number | null
  walker_name?: string | null
  walkerName?: string | null
  walker_id?: string | null
  walkerId?: string | null
  client_name?: string | null
  clientName?: string | null
  review?: string | null
  reviewText?: string | null
  rating?: number | null
  hidden?: boolean | null
  isHidden?: boolean | null
  hidden_by_client?: boolean | null
  hidden_by_walker?: boolean | null
  walker_lat?: number | null
  walker_lng?: number | null
  client_lat?: number | null
  client_lng?: number | null
  lat?: number | null
  lng?: number | null
  latitude?: number | null
  longitude?: number | null
  [key: string]: Primitive | Record<string, unknown> | Array<unknown>
}

type GroupedHistoryProps = {
  items?: HistoryItem[]
  history?: HistoryItem[]
  requests?: HistoryItem[]
  jobs?: HistoryItem[]
  role?: Role
  userType?: Role
  mode?: Role
  maxMonths?: number
  onBookAgain?: (item: HistoryItem) => void
  onRebook?: (item: HistoryItem) => void
  onDetails?: (item: HistoryItem) => void
  onSelect?: (item: HistoryItem) => void
  onSecondaryAction?: (item: HistoryItem) => Promise<void> | void
  secondaryActionLabel?: string
  shouldShowSecondaryAction?: (item: HistoryItem) => boolean
  onHide?: (id: string) => Promise<void> | void
  favoriteWalkerIds?: Set<string>
  onToggleFavoriteWalker?: (walkerId: string) => Promise<void> | void
  favoriteClientIds?: Set<string>
  onToggleFavoriteClient?: (clientId: string, clientName: string) => Promise<void> | void
  emptyTitle?: string
  emptySubtitle?: string
  className?: string
  compact?: boolean
}

type Group = {
  key: string
  label: string
  items: HistoryItem[]
  defaultExpanded: boolean
}

const SWIPE_HIDE_WIDTH = 132
const SWIPE_HIDE_THRESHOLD = 86

export default function GroupedHistory(props: GroupedHistoryProps) {
  const { i18n } = useTranslation()
  const compact = props.compact === true
  const isHebrew = i18n.resolvedLanguage === 'he'
  const rawItems = useMemo(
    () => props.items ?? props.history ?? props.requests ?? props.jobs ?? [],
    [props.items, props.history, props.requests, props.jobs],
  )

  const items = useMemo(() => {
    if (!props.maxMonths || props.maxMonths <= 0) return rawItems

    const cutoff = new Date()
    cutoff.setMonth(cutoff.getMonth() - props.maxMonths)

    return rawItems.filter((item) => {
      const date = getDateValue(item)
      if (!date) return true
      return date >= cutoff
    })
  }, [props.maxMonths, rawItems])

  const role: Role = props.role ?? props.userType ?? props.mode ?? 'client'
  const emptyTitle = props.emptyTitle ?? 'No history yet'
  const emptySubtitle =
    props.emptySubtitle ??
    (role === 'client'
      ? 'Your completed walks and reviews will appear here.'
      : 'Completed jobs and rider feedback will appear here.')

  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({})

  const handleBookAgain = useCallback(
    (item: HistoryItem) => {
      if (props.onBookAgain) {
        props.onBookAgain(item)
        return
      }
      if (props.onRebook) {
        props.onRebook(item)
      }
    },
    [props.onBookAgain, props.onRebook],
  )

  const handleDetails = useCallback(
    (item: HistoryItem) => {
      if (props.onDetails) {
        props.onDetails(item)
        return
      }
      if (props.onSelect) {
        props.onSelect(item)
      }
    },
    [props.onDetails, props.onSelect],
  )

  const handleHide = useCallback(
    async (item: HistoryItem) => {
      if (!props.onHide) return
      await props.onHide(getItemId(item))
    },
    [props.onHide],
  )

  const grouped = useMemo(() => buildGroups(items, isHebrew), [isHebrew, items])
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({})
  const hideLabel = i18n.resolvedLanguage === 'he' ? 'הסתר' : 'Hide'
  const favoriteLabel = i18n.resolvedLanguage === 'he' ? 'מועדף' : 'Favorite'

  useEffect(() => {
    setExpandedGroups((current) => {
      const next: Record<string, boolean> = {}
      grouped.forEach((group) => {
        next[group.key] = current[group.key] ?? group.defaultExpanded
      })
      return next
    })
  }, [grouped])

  return (
    <div className={props.className} style={{ ...styles.root, ...(compact ? compactStyles.root : null) }}>
      {items.length === 0 ? (
        <div style={{ ...styles.emptyCard, ...(compact ? compactStyles.emptyCard : null) }}>
          <div style={styles.emptyTitle}>{emptyTitle}</div>
          <div style={styles.emptySubtitle}>{emptySubtitle}</div>
        </div>
      ) : (
        grouped.map((group) => (
          <section key={group.key} style={{ ...styles.groupSection, ...(compact ? compactStyles.groupSection : null) }}>
            <button
              type="button"
              onClick={() => {
                setExpandedGroups((current) => ({
                  ...current,
                  [group.key]: !(current[group.key] ?? group.defaultExpanded),
                }))
              }}
              style={styles.groupHeaderButton}
            >
              <div style={styles.groupHeaderLabelRow}>
                <span style={styles.groupChevron}>{(expandedGroups[group.key] ?? group.defaultExpanded) ? '▼' : '▶'}</span>
                <span style={styles.groupHeader}>{group.label}</span>
              </div>
              <span style={styles.groupCountBadge}>{group.items.length}</span>
            </button>
            <div
              style={{
                ...styles.groupContentWrap,
                maxHeight: (expandedGroups[group.key] ?? group.defaultExpanded) ? `${Math.max(320, group.items.length * (compact ? 240 : 280))}px` : '0px',
                opacity: (expandedGroups[group.key] ?? group.defaultExpanded) ? 1 : 0,
              }}
            >
            <div style={{ ...styles.groupList, ...(compact ? compactStyles.groupList : null) }}>
              {group.items.map((item) => {
                const id = getItemId(item)
                return (
                  <SwipeHistoryRow
                    key={id}
                    item={item}
                    role={role}
                    compact={compact}
                    canHide={!!props.onHide}
                    onBookAgain={() => handleBookAgain(item)}
                    onHide={() => handleHide(item)}
                    hideLabel={hideLabel}
                    favoriteLabel={favoriteLabel}
                    onDetails={() => handleDetails(item)}
                    onSecondaryAction={props.onSecondaryAction ? () => props.onSecondaryAction?.(item) : undefined}
                    secondaryActionLabel={props.secondaryActionLabel}
                    showSecondaryAction={props.shouldShowSecondaryAction?.(item) === true}
                    favoriteWalkerIds={props.favoriteWalkerIds}
                    onToggleFavoriteWalker={props.onToggleFavoriteWalker}
                    favoriteClientIds={props.favoriteClientIds}
                    onToggleFavoriteClient={props.onToggleFavoriteClient}
                    registerRef={(node) => {
                      rowRefs.current[id] = node
                    }}
                  />
                )
              })}
            </div>
            </div>
          </section>
        ))
      )}
    </div>
  )
}

type SwipeHistoryRowProps = {
  item: HistoryItem
  role: Role
  compact: boolean
  canHide: boolean
  onBookAgain: () => void
  onHide: () => void
  hideLabel: string
  favoriteLabel: string
  onDetails: () => void
  onSecondaryAction?: () => Promise<void> | void
  secondaryActionLabel?: string
  showSecondaryAction: boolean
  favoriteWalkerIds?: Set<string>
  onToggleFavoriteWalker?: (walkerId: string) => Promise<void> | void
  favoriteClientIds?: Set<string>
  onToggleFavoriteClient?: (clientId: string, clientName: string) => Promise<void> | void
  registerRef: (node: HTMLDivElement | null) => void
}

function SwipeHistoryRow({
  item,
  role,
  compact,
  canHide,
  onBookAgain,
  onHide,
  hideLabel,
  favoriteLabel,
  onDetails,
  onSecondaryAction,
  secondaryActionLabel,
  showSecondaryAction,
  favoriteWalkerIds,
  onToggleFavoriteWalker,
  favoriteClientIds,
  onToggleFavoriteClient,
  registerRef,
}: SwipeHistoryRowProps) {
  void onBookAgain
  const isHidden = isHiddenHistoryItem(item)
  const canSwipeHide = canHide && !isHidden
  const walkerId = getWalkerId(item)
  const canFavoriteWalker = role === 'client' && !!walkerId && !!onToggleFavoriteWalker
  const isFavoriteWalker = !!walkerId && favoriteWalkerIds?.has(walkerId)
  const clientFavoriteKey = getClientFavoriteKey(item)
  const canFavoriteClient = role === 'walker' && !!clientFavoriteKey && !!onToggleFavoriteClient
  const isFavoriteClient = !!clientFavoriteKey && favoriteClientIds?.has(clientFavoriteKey)
  const leftActionWidth = canFavoriteClient ? SWIPE_HIDE_WIDTH : 0
  const rightActionWidth = canSwipeHide ? SWIPE_HIDE_WIDTH : 0

  const [dragX, setDragX] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [reviewExpanded, setReviewExpanded] = useState(false)

  const dragStateRef = useRef<{
    startX: number
    startTranslate: number
    moved: boolean
    pointerId: number | null
  }>({
    startX: 0,
    startTranslate: 0,
    moved: false,
    pointerId: null,
  })

  useEffect(() => {
    if (!dragging) {
      setDragX(0)
    }
  }, [dragging])

  const currentTranslate = dragging ? dragX : 0

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (leftActionWidth === 0 && rightActionWidth === 0) return

      dragStateRef.current = {
        startX: event.clientX,
        startTranslate: 0,
        moved: false,
        pointerId: event.pointerId,
      }
      setDragging(true)
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    [leftActionWidth, rightActionWidth],
  )

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging || (leftActionWidth === 0 && rightActionWidth === 0)) return

      const delta = event.clientX - dragStateRef.current.startX
      if (Math.abs(delta) > 4) {
        dragStateRef.current.moved = true
      }

      const raw = dragStateRef.current.startTranslate + delta
      setDragX(applyResistance(raw, leftActionWidth, rightActionWidth))
    },
    [dragging, leftActionWidth, rightActionWidth],
  )

  const handlePointerUp = useCallback(() => {
    if (!dragging || (leftActionWidth === 0 && rightActionWidth === 0)) return

    setDragging(false)
    if (dragX <= -SWIPE_HIDE_THRESHOLD && rightActionWidth > 0) {
      void onHide()
    }
    if (dragX >= SWIPE_HIDE_THRESHOLD && leftActionWidth > 0 && clientFavoriteKey) {
      void onToggleFavoriteClient?.(clientFavoriteKey, counterpartLabel || favoriteLabel)
    }
    setDragX(0)
  }, [clientFavoriteKey, dragX, dragging, leftActionWidth, onHide, onToggleFavoriteClient, rightActionWidth])

  const handlePointerCancel = useCallback(() => {
    if (!dragging || (leftActionWidth === 0 && rightActionWidth === 0)) return
    setDragging(false)
    setDragX(0)
  }, [dragging, leftActionWidth, rightActionWidth])

  const handleCardClick = useCallback(() => {
    if (dragStateRef.current.moved) {
      dragStateRef.current.moved = false
      return
    }

    onDetails()
  }, [onDetails])
  const { i18n } = useTranslation()
  const isHebrew = i18n.resolvedLanguage === 'he'

  const status = formatStatus(item.status)
  const title = getTitle(item)
  const itemId = getItemId(item)
  const dateLabel = getDisplayDate(item, isHebrew)
  const durationLabel = getDuration(item)
  const dogCountLabel = getDogCountMetaLabel(item, isHebrew)
  const priceLabel = getPrice(item)
  const tipLabel = getTipLabel(item)
  const counterpartLabel = getCounterpart(item, role)
  const reviewText = getReviewText(item)
  const rating = getRating(item)
  const locationText = getLocationText(item)
  const coords = getCoordinates(item)
  const hasPreview = Boolean(locationText || coords)
  const isLongReview = reviewText.length > 92
  useEffect(() => {
    setReviewExpanded(false)
  }, [itemId])

  const toggleReview = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    setReviewExpanded((current) => !current)
  }, [])

  return (
    <div
      ref={registerRef}
      style={{ ...styles.rowShell, ...(compact ? compactStyles.rowShell : null) }}
      onPointerDown={leftActionWidth > 0 || rightActionWidth > 0 ? handlePointerDown : undefined}
      onPointerMove={leftActionWidth > 0 || rightActionWidth > 0 ? handlePointerMove : undefined}
      onPointerUp={leftActionWidth > 0 || rightActionWidth > 0 ? handlePointerUp : undefined}
      onPointerCancel={leftActionWidth > 0 || rightActionWidth > 0 ? handlePointerCancel : undefined}
    >
      {leftActionWidth > 0 ? (
        <div style={{ ...styles.actionsRail, ...styles.actionsRailLeft, ...(compact ? compactStyles.actionsRail : null) }}>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              if (clientFavoriteKey) {
                void onToggleFavoriteClient?.(clientFavoriteKey, counterpartLabel || favoriteLabel)
              }
            }}
            onPointerDown={(event) => event.stopPropagation()}
            style={{
              ...styles.swipeFavoriteCue,
              ...(isFavoriteClient ? styles.swipeFavoriteCueActive : null),
            }}
            aria-label={isFavoriteClient ? 'Remove favorite client' : 'Favorite client'}
          >
            <div style={styles.actionIcon}>{isFavoriteClient ? '♥' : '♡'}</div>
            <div style={styles.actionLabel}>{favoriteLabel}</div>
          </button>
        </div>
      ) : null}

      {rightActionWidth > 0 ? (
        <div style={{ ...styles.actionsRail, ...(compact ? compactStyles.actionsRail : null) }}>
          <div style={styles.swipeHideCue}>
            <div style={styles.actionIcon}>✕</div>
            <div style={styles.actionLabel}>{hideLabel}</div>
          </div>
        </div>
      ) : null}

      <div
        style={{
          ...styles.cardTrack,
          transform: `translate3d(${currentTranslate}px, 0, 0)`,
          transition: dragging ? 'none' : 'transform 240ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      >
        <div
          role="button"
          tabIndex={0}
          style={{ ...styles.cardButton, ...(compact ? compactStyles.cardButton : null) }}
          onClick={handleCardClick}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              handleCardClick()
            }
          }}
        >
          <div style={{ ...styles.card, ...(compact ? compactStyles.card : null) }}>
            <div style={{ ...styles.cardTopRow, ...(compact ? compactStyles.cardTopRow : null) }}>
              <div style={styles.titleCluster}>
                <div style={styles.titleRow}>
                  <div style={{ ...styles.titleText, ...(compact ? compactStyles.titleText : null) }}>{title}</div>
                  <div style={statusBadgeStyle(status.tone)}>{status.label}</div>
                  {isHidden ? <div style={styles.hiddenBadge}>Hidden</div> : null}
                </div>

                <div style={{ ...styles.metaRow, ...(compact ? compactStyles.metaRow : null) }}>
                  <span>{dateLabel}</span>
                  {durationLabel ? <Dot /> : null}
                  {durationLabel ? <span>{durationLabel}</span> : null}
                  {dogCountLabel ? <Dot /> : null}
                  {dogCountLabel ? <span>{dogCountLabel}</span> : null}
                  {priceLabel ? <Dot /> : null}
                  {priceLabel ? <span>{priceLabel}</span> : null}
                  {tipLabel ? <Dot /> : null}
                  {tipLabel ? <span style={styles.tipMeta}>{tipLabel}</span> : null}
                </div>
              </div>

              {rating ? (
                <div style={styles.ratingPill}>
                  <span style={styles.star}>★</span>
                  <span>{rating.toFixed(1)}</span>
                </div>
              ) : null}

              {canFavoriteWalker && walkerId ? (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation()
                    void onToggleFavoriteWalker(walkerId)
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                  style={{
                    ...styles.favoriteButton,
                    ...(isFavoriteWalker ? styles.favoriteButtonActive : null),
                  }}
                  aria-label={isFavoriteWalker ? 'Remove favorite walker' : 'Favorite walker'}
                >
                  {isFavoriteWalker ? '♥' : '♡'}
                </button>
              ) : null}

              {canFavoriteClient && clientFavoriteKey ? (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation()
                    void onToggleFavoriteClient?.(clientFavoriteKey, counterpartLabel || favoriteLabel)
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                  style={{
                    ...styles.favoriteButton,
                    ...(isFavoriteClient ? styles.favoriteButtonActive : null),
                  }}
                  aria-label={isFavoriteClient ? 'Remove favorite client' : 'Favorite client'}
                >
                  {isFavoriteClient ? '♥' : '♡'}
                </button>
              ) : null}
            </div>

            {counterpartLabel ? (
              <div style={{ ...styles.counterpartRow, ...(compact ? compactStyles.counterpartRow : null) }}>
                <span style={styles.counterpartLabel}>{role === 'client' ? 'Walker' : 'Client'}</span>
                <span style={{ ...styles.counterpartValue, ...(compact ? compactStyles.counterpartValue : null) }}>{counterpartLabel}</span>
              </div>
            ) : null}

            {hasPreview ? (
              <MiniLocationPreview locationText={locationText} coords={coords} compact={compact} />
            ) : null}

            {reviewText ? (
              <div style={{ ...styles.reviewBlock, ...(compact ? compactStyles.reviewBlock : null) }}>
                <div style={{ ...styles.reviewHeaderRow, ...(compact ? compactStyles.reviewHeaderRow : null) }}>
                  {rating ? (
                    <div style={{ ...styles.reviewRatingInline, ...(compact ? compactStyles.reviewRatingInline : null) }}>
                      <span style={styles.star}>★</span>
                      <span>{rating.toFixed(1)}</span>
                    </div>
                  ) : null}
                  <div style={styles.reviewLabel}>Review</div>
                </div>
                <div
                  style={{
                    ...styles.reviewText,
                    ...(compact ? compactStyles.reviewText : null),
                    ...(reviewExpanded ? styles.reviewTextExpanded : styles.reviewTextCollapsed),
                  }}
                >
                  {reviewText}
                </div>
                {isLongReview ? (
                  <button
                    type="button"
                    onClick={toggleReview}
                    onPointerDown={(event) => event.stopPropagation()}
                    style={styles.reviewToggleButton}
                  >
                    {reviewExpanded ? 'Show less' : 'Read more'}
                  </button>
                ) : null}
              </div>
            ) : null}

            {showSecondaryAction && secondaryActionLabel ? (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  void onSecondaryAction?.()
                }}
                onPointerDown={(event) => event.stopPropagation()}
                style={{ ...styles.issueActionButton, ...(compact ? compactStyles.issueActionButton : null) }}
              >
                {secondaryActionLabel}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

function MiniLocationPreview({
  locationText,
  coords,
  compact,
}: {
  locationText: string
  coords: { lat: number; lng: number } | null
  compact: boolean
}) {
  const coordText = coords != null ? `${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}` : null

  return (
    <div style={{ ...styles.miniMapCard, ...(compact ? compactStyles.miniMapCard : null) }}>
      <div style={{ ...styles.miniMapBackdrop, ...(compact ? compactStyles.miniMapBackdrop : null) }}>
        <div style={styles.mapGridVerticalA} />
        <div style={styles.mapGridVerticalB} />
        <div style={styles.mapGridHorizontalA} />
        <div style={styles.mapGridHorizontalB} />
        <div style={styles.routeStrokeA} />
        <div style={styles.routeStrokeB} />
        <div style={{ ...styles.locationPin, ...(compact ? compactStyles.locationPin : null) }} />
      </div>

      <div style={{ ...styles.miniMapInfo, ...(compact ? compactStyles.miniMapInfo : null) }}>
        <div style={{ ...styles.miniMapTopRow, ...(compact ? compactStyles.miniMapTopRow : null) }}>
          <span style={styles.pinEmoji}>📍</span>
          <span style={styles.miniMapTitle}>Location</span>
        </div>

        <div style={{ ...styles.miniMapLocationText, ...(compact ? compactStyles.miniMapLocationText : null) }}>
          {locationText || 'Saved pickup location'}
        </div>

        {coordText ? <div style={{ ...styles.miniMapCoords, ...(compact ? compactStyles.miniMapCoords : null) }}>{coordText}</div> : null}
      </div>
    </div>
  )
}

function buildGroups(items: HistoryItem[], isHebrew: boolean): Group[] {
  const map = new Map<string, Group>()

  for (const item of items) {
    const date = getDateValue(item)
    const key = getGroupKey(date)
    const label = getGroupLabel(key, isHebrew)
    const defaultExpanded = key === 'today' || key === 'yesterday'

    if (!map.has(key)) {
      map.set(key, { key, label, items: [], defaultExpanded })
    }

    map.get(key)!.items.push(item)
  }

  const order = ['today', 'yesterday', 'this_week', 'earlier']
  return Array.from(map.values()).sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
}

function getItemId(item: HistoryItem): string {
  const raw =
    item.id ??
    `${getDateValue(item)?.getTime() ?? 'na'}-${getTitle(item)}-${getLocationText(item)}`
  return String(raw)
}

function getTitle(item: HistoryItem): string {
  return sanitizeString(item.dog_name) ?? sanitizeString(item.dogName) ?? 'Walk request'
}

function getLocationText(item: HistoryItem): string {
  const address = sanitizeString(item.address) ?? sanitizeString(item.location) ?? ''
  return formatShortAddress(address)
}

function getCounterpart(item: HistoryItem, role: Role): string {
  if (role === 'client') {
    return sanitizeString(item.walker_name) ?? sanitizeString(item.walkerName) ?? ''
  }

  return (
    sanitizeString(item.client_name) ??
    sanitizeString(item.clientName) ??
    sanitizeString(item.dog_name) ??
    sanitizeString(item.dogName) ??
    ''
  )
}

function getWalkerId(item: HistoryItem): string {
  return sanitizeString(item.walker_id) ?? sanitizeString(item.walkerId) ?? ''
}

function getClientId(item: HistoryItem): string {
  return sanitizeString(item.client_id) ?? sanitizeString((item as { clientId?: string | null }).clientId) ?? ''
}

function getClientFavoriteKey(item: HistoryItem): string {
  return (
    getClientId(item) ||
    sanitizeString((item as { client_favorite_key?: string | null }).client_favorite_key) ||
    sanitizeString(item.client_name) ||
    sanitizeString((item as { clientName?: string | null }).clientName) ||
    ''
  )
}

function getReviewText(item: HistoryItem): string {
  return sanitizeString(item.review) ?? sanitizeString(item.reviewText) ?? ''
}

function getRating(item: HistoryItem): number | null {
  return typeof item.rating === 'number' && Number.isFinite(item.rating) ? item.rating : null
}

function isHiddenHistoryItem(item: HistoryItem): boolean {
  return item.hidden === true || item.isHidden === true || item.hidden_by_client === true || item.hidden_by_walker === true
}

function getDuration(item: HistoryItem): string {
  const minutes =
    typeof item.duration_minutes === 'number'
      ? item.duration_minutes
      : typeof item.durationMinutes === 'number'
        ? item.durationMinutes
        : null

  return formatDurationFromMinutes(minutes) ?? ''
}

function getPrice(item: HistoryItem): string {
  const raw =
    typeof item.price === 'number'
      ? item.price
      : typeof item.price === 'string'
        ? Number(item.price)
        : null

  if (raw == null || !Number.isFinite(raw) || raw <= 0) return ''

  return `₪${raw}`
}

function getDogCountMetaLabel(item: HistoryItem, isHebrew: boolean): string {
  const serviceType = sanitizeString(item.service_type) ?? sanitizeString(item.serviceType)
  if (!isDogServiceType(serviceType)) return ''
  const raw =
    typeof item.dog_count === 'number'
      ? item.dog_count
      : typeof item.dogCount === 'number'
        ? item.dogCount
        : 1
  return formatDogCountLabel(raw, { isHebrew })
}

function getTipLabel(item: HistoryItem): string {
  const raw =
    typeof item.tip_amount === 'number'
      ? item.tip_amount
      : typeof item.tipAmount === 'number'
        ? item.tipAmount
        : null

  if (raw == null || !Number.isFinite(raw) || raw <= 0) return ''

  return `Tipped ₪${raw}`
}

function getDisplayDate(item: HistoryItem, isHebrew: boolean): string {
  const date = getDateValue(item)
  if (!date) return isHebrew ? 'לאחרונה' : 'Recently'

  const today = startOfDay(new Date())
  const itemDay = startOfDay(date)
  const diffDays = Math.round((today.getTime() - itemDay.getTime()) / (1000 * 60 * 60 * 24))

  if (diffDays === 0) {
    return `${isHebrew ? 'היום' : 'Today'} · ${formatTime(date, isHebrew)}`
  }

  if (diffDays === 1) {
    return `${isHebrew ? 'אתמול' : 'Yesterday'} · ${formatTime(date, isHebrew)}`
  }

  return `${formatShortDate(date, isHebrew)} · ${formatTime(date, isHebrew)}`
}

function getDateValue(item: HistoryItem): Date | null {
  const raw =
    sanitizeString(item.completed_at) ??
    sanitizeString(item.created_at) ??
    sanitizeString(item.scheduled_at) ??
    sanitizeString(item.updated_at)

  if (!raw) return null
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? null : date
}

function getGroupKey(date: Date | null): string {
  if (!date) return 'earlier'
  const today = startOfDay(new Date())
  const itemDay = startOfDay(date)
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const weekStart = startOfWeek(today)

  if (itemDay.getTime() === today.getTime()) return 'today'
  if (itemDay.getTime() === yesterday.getTime()) return 'yesterday'
  if (itemDay >= weekStart) return 'this_week'
  return 'earlier'
}

function getGroupLabel(key: string, isHebrew: boolean): string {
  if (key === 'today') return isHebrew ? 'היום' : 'Today'
  if (key === 'yesterday') return isHebrew ? 'אתמול' : 'Yesterday'
  if (key === 'this_week') return isHebrew ? 'השבוע' : 'This Week'
  return isHebrew ? 'מוקדם יותר' : 'Earlier'
}

function getCoordinates(item: HistoryItem): { lat: number; lng: number } | null {
  const candidates: Array<[number | null | undefined, number | null | undefined]> = [
    [asNumber(item.lat), asNumber(item.lng)],
    [asNumber(item.latitude), asNumber(item.longitude)],
    [asNumber(item.client_lat), asNumber(item.client_lng)],
    [asNumber(item.walker_lat), asNumber(item.walker_lng)],
  ]

  for (const [lat, lng] of candidates) {
    if (
      typeof lat === 'number' &&
      Number.isFinite(lat) &&
      typeof lng === 'number' &&
      Number.isFinite(lng)
    ) {
      return { lat, lng }
    }
  }

  return null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function sanitizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function formatShortDate(date: Date, isHebrew: boolean): string {
  return new Intl.DateTimeFormat(isHebrew ? 'he-IL' : 'en-US', {
    month: 'short',
    day: 'numeric',
  }).format(date)
}

function formatTime(date: Date, isHebrew: boolean): string {
  return new Intl.DateTimeFormat(isHebrew ? 'he-IL' : 'en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: !isHebrew,
  }).format(date)
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function startOfWeek(date: Date): Date {
  const day = date.getDay()
  const result = startOfDay(date)
  result.setDate(result.getDate() - day)
  return result
}

function applyResistance(raw: number, leftActionWidth: number, rightActionWidth: number): number {
  if (raw > leftActionWidth) {
    return leftActionWidth + (raw - leftActionWidth) * 0.2
  }

  if (raw > 0 && leftActionWidth === 0) {
    return raw * 0.2
  }

  if (raw < -rightActionWidth) {
    return -rightActionWidth + (raw + rightActionWidth) * 0.2
  }

  if (raw < 0 && rightActionWidth === 0) {
    return raw * 0.2
  }

  return raw
}

function formatStatus(status: string | null | undefined): {
  label: string
  tone: 'neutral' | 'success' | 'warning'
} {
  const raw = (status ?? '').trim().toLowerCase()

  if (raw === 'completed') return { label: 'Completed', tone: 'success' }
  if (raw === 'accepted') return { label: 'Accepted', tone: 'neutral' }
  if (raw === 'awaiting_payment') return { label: 'Awaiting payment', tone: 'warning' }
  if (!raw) return { label: 'Completed', tone: 'success' }

  return {
    label: raw.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase()),
    tone: 'neutral',
  }
}

function statusBadgeStyle(
  tone: 'neutral' | 'success' | 'warning',
): React.CSSProperties {
  if (tone === 'success') {
    return {
      ...styles.statusBadge,
      color: '#D6F5E7',
      background:
        'linear-gradient(180deg, rgba(24, 86, 56, 0.68) 0%, rgba(12, 42, 29, 0.82) 100%)',
      border: '1px solid rgba(108, 220, 162, 0.28)',
    }
  }

  if (tone === 'warning') {
    return {
      ...styles.statusBadge,
      color: '#FFF0C2',
      background:
        'linear-gradient(180deg, rgba(92, 66, 17, 0.65) 0%, rgba(45, 32, 9, 0.82) 100%)',
      border: '1px solid rgba(255, 211, 102, 0.24)',
    }
  }

  return {
    ...styles.statusBadge,
    color: '#D9E6FF',
    background:
      'linear-gradient(180deg, rgba(33, 49, 74, 0.72) 0%, rgba(17, 24, 39, 0.82) 100%)',
    border: '1px solid rgba(110, 150, 255, 0.18)',
  }
}

function Dot() {
  return <span style={styles.dot}>•</span>
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: 20,
    width: '100%',
  },
  groupSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  groupHeaderButton: {
    appearance: 'none',
    border: 'none',
    background: 'transparent',
    padding: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    cursor: 'pointer',
    fontFamily: 'inherit',
    width: '100%',
    textAlign: 'left',
  },
  groupHeaderLabelRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
  },
  groupChevron: {
    fontSize: 11,
    lineHeight: 1,
    color: 'rgba(200, 212, 234, 0.72)',
    flexShrink: 0,
  },
  groupHeader: {
    fontSize: 12,
    lineHeight: 1.2,
    letterSpacing: '0.16em',
    textTransform: 'uppercase',
    color: 'rgba(200, 212, 234, 0.64)',
    paddingInline: 4,
    fontWeight: 700,
  },
  groupCountBadge: {
    minWidth: 26,
    height: 22,
    padding: '0 8px',
    borderRadius: 999,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(255,255,255,0.08)',
    color: 'rgba(226, 232, 240, 0.82)',
    fontSize: 11,
    fontWeight: 800,
    lineHeight: 1,
    flexShrink: 0,
  },
  groupContentWrap: {
    overflow: 'hidden',
    transition: 'max-height 220ms ease, opacity 180ms ease',
  },
  groupList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  rowShell: {
    position: 'relative',
    overflow: 'hidden',
    borderRadius: 24,
    minHeight: 1,
    touchAction: 'pan-y',
  },
  actionsRail: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    justifyContent: 'flex-end',
    alignItems: 'stretch',
    gap: 8,
    padding: 8,
    background:
      'linear-gradient(135deg, rgba(9, 14, 24, 0.92) 0%, rgba(11, 18, 32, 0.98) 100%)',
    borderRadius: 24,
  },
  actionsRailLeft: {
    justifyContent: 'flex-start',
  },
  swipeHideCue: {
    width: 108,
    borderRadius: 18,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 6,
    fontWeight: 800,
    color: '#F8FBFF',
    background:
      'linear-gradient(180deg, rgba(30, 38, 54, 0.96) 0%, rgba(18, 25, 37, 0.98) 100%)',
    border: '1px solid rgba(255,255,255,0.06)',
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06)',
  },
  swipeFavoriteCue: {
    width: 108,
    borderRadius: 18,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 6,
    fontWeight: 800,
    color: '#FFF7E6',
    background:
      'linear-gradient(180deg, rgba(61, 48, 18, 0.96) 0%, rgba(34, 25, 8, 0.98) 100%)',
    border: '1px solid rgba(255, 209, 102, 0.16)',
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08)',
    cursor: 'pointer',
    appearance: 'none',
  },
  swipeFavoriteCueActive: {
    color: '#FFF8D4',
    background:
      'linear-gradient(180deg, rgba(110, 79, 15, 0.96) 0%, rgba(63, 43, 8, 0.98) 100%)',
    border: '1px solid rgba(255, 220, 120, 0.22)',
  },
  actionButton: {
    appearance: 'none',
    border: 'none',
    borderRadius: 18,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 6,
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontWeight: 700,
    color: '#F8FBFF',
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06)',
  },
  primaryActionButton: {
    background:
      'linear-gradient(180deg, rgba(255, 210, 58, 0.98) 0%, rgba(233, 177, 14, 0.98) 100%)',
    color: '#151515',
  },
  secondaryActionButton: {
    background:
      'linear-gradient(180deg, rgba(30, 38, 54, 0.96) 0%, rgba(18, 25, 37, 0.98) 100%)',
    color: '#E7EEF9',
    border: '1px solid rgba(255,255,255,0.06)',
  },
  actionIcon: {
    fontSize: 16,
    lineHeight: 1,
  },
  actionLabel: {
    fontSize: 12,
    lineHeight: 1,
  },
  cardTrack: {
    position: 'relative',
    zIndex: 1,
    willChange: 'transform',
  },
  cardButton: {
    display: 'block',
    width: '100%',
    padding: 0,
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    textAlign: 'left',
    borderRadius: 24,
  },
  card: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    padding: 16,
    borderRadius: 24,
    background:
      'linear-gradient(180deg, rgba(17, 24, 39, 0.98) 0%, rgba(10, 16, 28, 0.98) 100%)',
    border: '1px solid rgba(255, 255, 255, 0.06)',
    boxShadow: '0 14px 32px rgba(0,0,0,0.34), inset 0 1px 0 rgba(255,255,255,0.04)',
    overflow: 'hidden',
  },
  cardTopRow: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  titleCluster: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    minWidth: 0,
    flex: 1,
  },
  titleRow: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  titleText: {
    fontSize: 16,
    lineHeight: 1.2,
    fontWeight: 800,
    color: '#F5F8FF',
    letterSpacing: '-0.01em',
  },
  statusBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 26,
    padding: '0 10px',
    borderRadius: 999,
    fontSize: 11,
    lineHeight: 1,
    fontWeight: 800,
    letterSpacing: '0.02em',
    whiteSpace: 'nowrap',
  },
  hiddenBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 24,
    padding: '0 9px',
    borderRadius: 999,
    fontSize: 10,
    lineHeight: 1,
    fontWeight: 800,
    color: '#CBD5E1',
    background: 'rgba(148, 163, 184, 0.14)',
    border: '1px solid rgba(148, 163, 184, 0.24)',
    whiteSpace: 'nowrap',
  },
  metaRow: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    fontSize: 12.5,
    lineHeight: 1.3,
    color: 'rgba(214, 224, 241, 0.72)',
    fontWeight: 600,
  },
  dot: {
    opacity: 0.5,
  },
  tipMeta: {
    color: '#FDE68A',
    fontWeight: 800,
  },
  ratingPill: {
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    minHeight: 32,
    padding: '0 10px',
    borderRadius: 999,
    color: '#FFF5CC',
    fontSize: 13,
    lineHeight: 1,
    fontWeight: 800,
    background:
      'linear-gradient(180deg, rgba(53, 45, 18, 0.78) 0%, rgba(30, 24, 10, 0.88) 100%)',
    border: '1px solid rgba(255, 213, 92, 0.18)',
  },
  favoriteButton: {
    flexShrink: 0,
    width: 32,
    height: 32,
    borderRadius: 999,
    border: '1px solid rgba(255, 213, 92, 0.20)',
    background: 'rgba(255, 213, 92, 0.08)',
    color: '#FDE68A',
    fontSize: 18,
    lineHeight: 1,
    fontWeight: 900,
    cursor: 'pointer',
    display: 'grid',
    placeItems: 'center',
    fontFamily: 'inherit',
  },
  favoriteButtonActive: {
    background: 'rgba(255, 213, 92, 0.18)',
    color: '#F59E0B',
    border: '1px solid rgba(255, 213, 92, 0.34)',
  },
  star: {
    fontSize: 13,
    transform: 'translateY(-0.5px)',
  },
  counterpartRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
  },
  counterpartLabel: {
    fontSize: 11,
    lineHeight: 1,
    textTransform: 'uppercase',
    letterSpacing: '0.12em',
    color: 'rgba(175, 191, 216, 0.56)',
    fontWeight: 800,
    flexShrink: 0,
  },
  counterpartValue: {
    minWidth: 0,
    fontSize: 13.5,
    lineHeight: 1.35,
    color: '#DCE7F8',
    fontWeight: 700,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  miniMapCard: {
    position: 'relative',
    display: 'grid',
    gridTemplateColumns: '104px 1fr',
    gap: 12,
    alignItems: 'stretch',
    minHeight: 88,
    borderRadius: 18,
    background:
      'linear-gradient(180deg, rgba(19, 27, 42, 0.92) 0%, rgba(13, 19, 31, 0.96) 100%)',
    border: '1px solid rgba(255,255,255,0.055)',
    overflow: 'hidden',
  },
  miniMapBackdrop: {
    position: 'relative',
    minHeight: 88,
    background:
      'radial-gradient(circle at 72% 28%, rgba(52, 108, 214, 0.22) 0%, rgba(52, 108, 214, 0.08) 24%, rgba(12, 17, 29, 0) 44%), linear-gradient(180deg, rgba(20, 29, 44, 1) 0%, rgba(14, 21, 33, 1) 100%)',
    overflow: 'hidden',
  },
  mapGridVerticalA: {
    position: 'absolute',
    top: -6,
    bottom: -6,
    left: 28,
    width: 1,
    background: 'rgba(255,255,255,0.06)',
    transform: 'rotate(8deg)',
  },
  mapGridVerticalB: {
    position: 'absolute',
    top: -8,
    bottom: -8,
    left: 68,
    width: 1,
    background: 'rgba(255,255,255,0.05)',
    transform: 'rotate(-10deg)',
  },
  mapGridHorizontalA: {
    position: 'absolute',
    left: -8,
    right: -8,
    top: 24,
    height: 1,
    background: 'rgba(255,255,255,0.06)',
    transform: 'rotate(-8deg)',
  },
  mapGridHorizontalB: {
    position: 'absolute',
    left: -12,
    right: -12,
    top: 56,
    height: 1,
    background: 'rgba(255,255,255,0.05)',
    transform: 'rotate(7deg)',
  },
  routeStrokeA: {
    position: 'absolute',
    width: 64,
    height: 64,
    left: 18,
    top: 18,
    border: '2px solid rgba(84, 145, 255, 0.34)',
    borderColor: 'rgba(84, 145, 255, 0.34) transparent transparent transparent',
    borderRadius: '50%',
    transform: 'rotate(24deg)',
  },
  routeStrokeB: {
    position: 'absolute',
    width: 46,
    height: 46,
    left: 40,
    top: 32,
    border: '2px solid rgba(255, 214, 94, 0.24)',
    borderColor: 'transparent transparent rgba(255, 214, 94, 0.24) transparent',
    borderRadius: '50%',
    transform: 'rotate(-20deg)',
  },
  locationPin: {
    position: 'absolute',
    left: 58,
    top: 34,
    width: 14,
    height: 14,
    borderRadius: '50% 50% 50% 0',
    background: 'linear-gradient(180deg, #FFD24A 0%, #F59E0B 100%)',
    transform: 'rotate(-45deg)',
    boxShadow: '0 0 0 6px rgba(255, 210, 74, 0.12)',
  },
  miniMapInfo: {
    padding: '12px 12px 12px 0',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    gap: 6,
    minWidth: 0,
  },
  miniMapTopRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  pinEmoji: {
    fontSize: 12,
    lineHeight: 1,
  },
  miniMapTitle: {
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: '0.12em',
    color: 'rgba(189, 202, 224, 0.62)',
    fontWeight: 800,
  },
  miniMapLocationText: {
    fontSize: 13,
    lineHeight: 1.35,
    color: '#EAF1FD',
    fontWeight: 700,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
  },
  miniMapCoords: {
    fontSize: 11.5,
    lineHeight: 1.3,
    color: 'rgba(189, 202, 224, 0.62)',
    fontWeight: 600,
  },
  reviewBlock: {
    display: 'grid',
    gap: 7,
    padding: '11px 12px',
    borderRadius: 16,
    background:
      'linear-gradient(180deg, rgba(255,255,255,0.035) 0%, rgba(255,255,255,0.02) 100%)',
    border: '1px solid rgba(255,255,255,0.05)',
  },
  reviewHeaderRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
  },
  reviewRatingInline: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: '5px 8px',
    borderRadius: 999,
    color: '#FFF5CC',
    fontSize: 12,
    lineHeight: 1,
    fontWeight: 800,
    background: 'rgba(255, 213, 92, 0.10)',
    border: '1px solid rgba(255, 213, 92, 0.14)',
    flexShrink: 0,
  },
  reviewLabel: {
    fontSize: 11,
    lineHeight: 1,
    textTransform: 'uppercase',
    letterSpacing: '0.12em',
    color: 'rgba(189, 202, 224, 0.62)',
    fontWeight: 800,
  },
  reviewText: {
    fontSize: 13.5,
    lineHeight: 1.45,
    color: '#E7EEF9',
    fontWeight: 500,
    overflow: 'hidden',
  },
  reviewTextCollapsed: {
    textOverflow: 'ellipsis',
    display: '-webkit-box',
    WebkitLineClamp: 1,
    WebkitBoxOrient: 'vertical',
  },
  reviewTextExpanded: {
    whiteSpace: 'normal',
    overflowWrap: 'anywhere',
  },
  reviewToggleButton: {
    justifySelf: 'flex-start',
    appearance: 'none',
    border: 'none',
    background: 'transparent',
    padding: '2px 0 0',
    color: '#FDE68A',
    fontSize: 12,
    fontWeight: 800,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  issueActionButton: {
    alignSelf: 'flex-start',
    minHeight: 34,
    padding: '0 14px',
    borderRadius: 999,
    border: '1px solid rgba(248, 113, 113, 0.32)',
    background: 'rgba(127, 29, 29, 0.18)',
    color: '#FCA5A5',
    fontSize: 12.5,
    fontWeight: 800,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  emptyCard: {
    borderRadius: 22,
    padding: 18,
    background:
      'linear-gradient(180deg, rgba(17, 24, 39, 0.98) 0%, rgba(10, 16, 28, 0.98) 100%)',
    border: '1px solid rgba(255,255,255,0.06)',
    boxShadow: '0 14px 32px rgba(0,0,0,0.28)',
  },
  emptyTitle: {
    fontSize: 15,
    fontWeight: 800,
    color: '#F5F8FF',
  },
  emptySubtitle: {
    marginTop: 6,
    fontSize: 13,
    lineHeight: 1.45,
    color: 'rgba(214, 224, 241, 0.72)',
  },
}

const compactStyles: Partial<Record<string, React.CSSProperties>> = {
  root: {
    gap: 12,
  },
  groupSection: {
    gap: 7,
  },
  groupList: {
    gap: 7,
  },
  rowShell: {
    borderRadius: 16,
  },
  actionsRail: {
    padding: 5,
  },
  cardButton: {
    borderRadius: 16,
  },
  card: {
    gap: 8,
    padding: '10px 11px',
    borderRadius: 16,
  },
  cardTopRow: {
    gap: 7,
  },
  titleText: {
    fontSize: 14,
  },
  metaRow: {
    fontSize: 11,
    gap: 4,
  },
  counterpartRow: {
    gap: 5,
  },
  counterpartValue: {
    fontSize: 12,
  },
  miniMapCard: {
    gridTemplateColumns: '64px 1fr',
    gap: 8,
    minHeight: 56,
    borderRadius: 13,
  },
  miniMapBackdrop: {
    minHeight: 56,
  },
  locationPin: {
    left: 34,
    top: 22,
    width: 10,
    height: 10,
    boxShadow: '0 0 0 3px rgba(255, 210, 74, 0.10)',
  },
  miniMapInfo: {
    padding: '7px 9px 7px 0',
    gap: 3,
  },
  miniMapTopRow: {
    gap: 4,
  },
  miniMapLocationText: {
    fontSize: 11.5,
    lineHeight: 1.22,
    WebkitLineClamp: 1,
  },
  miniMapCoords: {
    display: 'none',
  },
  reviewBlock: {
    gap: 4,
    padding: '7px 9px',
    borderRadius: 11,
  },
  reviewHeaderRow: {
    gap: 5,
  },
  reviewRatingInline: {
    padding: '4px 6px',
    fontSize: 10.5,
  },
  reviewText: {
    fontSize: 12,
    lineHeight: 1.28,
  },
  issueActionButton: {
    minHeight: 29,
    padding: '0 11px',
    fontSize: 11.5,
  },
  emptyCard: {
    borderRadius: 18,
    padding: 14,
  },
}
