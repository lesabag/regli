import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../services/supabaseClient'

// ─── Types ──────────────────────────────────────────────────────

interface Notification {
  id: string
  user_id: string
  type: string
  title: string
  message: string
  related_job_id: string | null
  is_read: boolean
  created_at: string
}

interface Toast {
  id: string
  title: string
  message: string
  type: string
  createdAt: number
}

const TOAST_DURATION = 4000

// ─── Notification type config ───────────────────────────────────

interface TypeConfig {
  bg: string
  color: string
  border: string
  iconPath: string
  iconViewBox?: string
}

const TYPE_CONFIG: Record<string, TypeConfig> = {
  job_accepted: {
    bg: '#DCFCE7', color: '#15803D', border: '#BBF7D0',
    iconPath: 'M20 6L9 17l-5-5',
  },
  walker_arrived: {
    bg: '#DBEAFE', color: '#1D4ED8', border: '#BFDBFE',
    iconPath: 'M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z M12 7a3 3 0 100 6 3 3 0 000-6z',
  },
  job_completed: {
    bg: '#DCFCE7', color: '#15803D', border: '#BBF7D0',
    iconPath: 'M22 11.08V12a10 10 0 11-5.93-9.14 M22 4L12 14.01l-3-3',
  },
  new_rating: {
    bg: '#FEF9C3', color: '#A16207', border: '#FDE68A',
    iconPath: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z',
  },
  payment_success: {
    bg: '#EDE9FE', color: '#6D28D9', border: '#DDD6FE',
    iconPath: 'M1 4h22v16H1z M1 10h22',
    iconViewBox: '0 0 24 24',
  },
  payment_received: {
    bg: '#DCFCE7', color: '#15803D', border: '#BBF7D0',
    iconPath: 'M12 1v22 M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6',
  },
  new_request: {
    bg: '#FFF7ED', color: '#C2410C', border: '#FED7AA',
    iconPath: 'M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9 M13.73 21a2 2 0 01-3.46 0',
  },
  job_accepted_self: {
    bg: '#DCFCE7', color: '#15803D', border: '#BBF7D0',
    iconPath: 'M20 6L9 17l-5-5',
  },
}

const DEFAULT_CONFIG: TypeConfig = {
  bg: '#F1F5F9', color: '#475569', border: '#E2E8F0',
  iconPath: 'M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9 M13.73 21a2 2 0 01-3.46 0',
}

function getTypeConfig(type: string): TypeConfig {
  return TYPE_CONFIG[type] || DEFAULT_CONFIG
}

// ─── Time grouping ──────────────────────────────────────────────

type TimeGroup = 'Today' | 'Yesterday' | 'This week' | 'Earlier'

function getTimeGroup(dateStr: string): TimeGroup {
  const d = new Date(dateStr)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const weekAgo = new Date(today)
  weekAgo.setDate(weekAgo.getDate() - 7)

  if (d >= today) return 'Today'
  if (d >= yesterday) return 'Yesterday'
  if (d >= weekAgo) return 'This week'
  return 'Earlier'
}

// ─── Component ──────────────────────────────────────────────────

interface NotificationsBellProps {
  variant?: 'light' | 'dark'
}

export default function NotificationsBell({
  variant = 'dark',
}: NotificationsBellProps) {
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [open, setOpen] = useState(false)
  const [authUserId, setAuthUserId] = useState<string | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const ref = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [dropdownPos, setDropdownPos] = useState<{ top: number; right: number } | null>(null)

  const unreadCount = notifications.filter((n) => !n.is_read).length

  // Group notifications by time
  const grouped = useMemo(() => {
    const groups: { label: TimeGroup; items: Notification[] }[] = []
    const groupMap = new Map<TimeGroup, Notification[]>()

    for (const n of notifications) {
      const group = getTimeGroup(n.created_at)
      if (!groupMap.has(group)) groupMap.set(group, [])
      groupMap.get(group)!.push(n)
    }

    const order: TimeGroup[] = ['Today', 'Yesterday', 'This week', 'Earlier']
    for (const label of order) {
      const items = groupMap.get(label)
      if (items && items.length > 0) groups.push({ label, items })
    }

    return groups
  }, [notifications])

  const addToast = useCallback((title: string, message: string, type: string) => {
    // Deduplicate: don't show toast if similar one exists in last 2 seconds
    setToasts((prev) => {
      const key = `${type}:${title}:${message}`.toLowerCase()
      const recentDupe = prev.find(t => {
        const tKey = `${t.type}:${t.title}:${t.message}`.toLowerCase()
        return tKey === key && (Date.now() - t.createdAt) < 2000
      })
      if (recentDupe) return prev // Don't add duplicate

      const id = crypto.randomUUID()
      const newToasts = [...prev, { id, title, message, type, createdAt: Date.now() }]
      setTimeout(() => {
        setToasts((current) => current.filter((t) => t.id !== id))
      }, TOAST_DURATION)
      return newToasts
    })
  }, [])

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const fetchNotifications = useCallback(async (uid: string) => {
    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', uid)
      .order('created_at', { ascending: false })
      .limit(30)

    if (error) {
      console.error('NotificationsBell: fetch error', error.message)
      return
    }
    if (data) setNotifications(data as Notification[])
  }, [])

  useEffect(() => {
    let cancelled = false

    async function init() {
      const { data: { user }, error } = await supabase.auth.getUser()
      if (error || !user) {
        console.error('NotificationsBell: auth error', error?.message ?? 'no user')
        return
      }
      if (cancelled) return

      setAuthUserId(user.id)
      fetchNotifications(user.id)
    }

    init()
    return () => { cancelled = true }
  }, [fetchNotifications])

  useEffect(() => {
    if (!authUserId) return

    const channel = supabase
      .channel(`notifications-${authUserId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${authUserId}`,
        },
        (payload) => {
          fetchNotifications(authUserId)
          const row = payload.new as Notification | undefined
          if (row) {
            addToast(row.title, row.message, row.type)
          }
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [authUserId, fetchNotifications, addToast])

  useEffect(() => {
    if (!open) return
    const handler = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', handler)
    return () => document.removeEventListener('pointerdown', handler)
  }, [open])

  const handleToggle = useCallback(() => {
    if (!open && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect()
      setDropdownPos({
        top: rect.bottom + 8,
        right: Math.max(8, window.innerWidth - rect.right),
      })
    }
    setOpen((prev) => !prev)
  }, [open])

  const markAsRead = async (id: string) => {
    const { error } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('id', id)
    if (error) {
      console.error('NotificationsBell: markAsRead error', error.message)
      return
    }
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, is_read: true } : n))
    )
  }

  const markAllAsRead = async () => {
    const unreadIds = notifications.filter((n) => !n.is_read).map((n) => n.id)
    if (unreadIds.length === 0) return
    const { error } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .in('id', unreadIds)
    if (error) {
      console.error('NotificationsBell: markAllAsRead error', error.message)
      return
    }
    setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })))
  }

  const isLight = variant === 'light'

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      {/* Bell button */}
      <button
        ref={buttonRef}
        type="button"
        onClick={handleToggle}
        style={{
          position: 'relative',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          padding: 8,
          borderRadius: 10,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: isLight ? '#FFFFFF' : '#0F172A',
          WebkitTapHighlightColor: 'rgba(0,0,0,0.1)',
        }}
      >
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unreadCount > 0 && (
          <span className="notif-badge-bounce" style={badgeStyle}>
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown panel */}
      {open && dropdownPos && (
        <div
          className="notif-panel-enter"
          style={{
            position: 'fixed',
            top: dropdownPos.top,
            right: dropdownPos.right,
            width: 'min(340px, calc(100vw - 24px))',
            maxHeight: 440,
            background: '#FFFFFF',
            borderRadius: 18,
            boxShadow: '0 16px 48px rgba(15, 23, 42, 0.14), 0 0 0 1px rgba(15, 23, 42, 0.04)',
            zIndex: 9999,
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {/* Header */}
          <div style={panelHeaderStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={panelTitleStyle}>Notifications</span>
              {unreadCount > 0 && (
                <span style={headerBadgeStyle}>{unreadCount}</span>
              )}
            </div>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={markAllAsRead}
                style={markAllStyle}
              >
                Mark all read
              </button>
            )}
          </div>

          {/* Items */}
          <div style={scrollAreaStyle}>
            {notifications.length === 0 ? (
              <div style={emptyStateStyle}>
                <div style={emptyIconWrapStyle}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#CBD5E1" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                  </svg>
                </div>
                <p style={emptyTitleStyle}>No notifications yet</p>
                <p style={emptySubStyle}>You'll see updates about your walks here</p>
              </div>
            ) : (
              grouped.map((group) => (
                <div key={group.label}>
                  {/* Time group header */}
                  <div style={groupHeaderStyle}>{group.label}</div>

                  {group.items.map((n, i) => {
                    const cfg = getTypeConfig(n.type)
                    return (
                      <div
                        key={n.id}
                        className="notif-item-enter"
                        onClick={() => !n.is_read && markAsRead(n.id)}
                        style={{
                          ...itemStyle,
                          background: n.is_read ? 'transparent' : '#F8FAFF',
                          cursor: n.is_read ? 'default' : 'pointer',
                          animationDelay: `${Math.min(i, 6) * 25}ms`,
                        }}
                      >
                        {/* Type icon */}
                        <div style={{
                          ...iconCircleStyle,
                          background: cfg.bg,
                          border: `1.5px solid ${cfg.border}`,
                        }}>
                          <svg
                            width="14"
                            height="14"
                            viewBox={cfg.iconViewBox || '0 0 24 24'}
                            fill="none"
                            stroke={cfg.color}
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            {cfg.iconPath.split(' M').map((seg, idx) => (
                              <path key={idx} d={idx === 0 ? seg : `M${seg}`} />
                            ))}
                          </svg>
                        </div>

                        {/* Content */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{
                              fontWeight: n.is_read ? 500 : 700,
                              fontSize: 13,
                              color: '#0F172A',
                              lineHeight: 1.3,
                              flex: 1,
                              minWidth: 0,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              letterSpacing: -0.1,
                            }}>
                              {n.title}
                            </span>
                            {!n.is_read && <div style={unreadDotStyle} />}
                          </div>
                          <div style={messageStyle}>{n.message}</div>
                          <div style={timeStyle}>{formatRelativeDate(n.created_at)}</div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Toast popups */}
      {toasts.length > 0 && (
        <div style={toastContainerStyle}>
          {toasts.map((t) => {
            const cfg = getTypeConfig(t.type)
            return (
              <div
                key={t.id}
                className="notif-toast-enter"
                style={toastStyle}
                onClick={() => dismissToast(t.id)}
              >
                <div style={{
                  ...toastIconStyle,
                  background: cfg.bg,
                  border: `1.5px solid ${cfg.border}`,
                }}>
                  <svg
                    width="12"
                    height="12"
                    viewBox={cfg.iconViewBox || '0 0 24 24'}
                    fill="none"
                    stroke={cfg.color}
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    {cfg.iconPath.split(' M').map((seg, idx) => (
                      <path key={idx} d={idx === 0 ? seg : `M${seg}`} />
                    ))}
                  </svg>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={toastTitleStyle}>{t.title}</div>
                  <div style={toastMessageStyle}>{t.message}</div>
                </div>
                {/* Progress bar */}
                <div style={toastProgressTrackStyle}>
                  <div className="notif-toast-progress" style={{
                    ...toastProgressBarStyle,
                    animationDuration: `${TOAST_DURATION}ms`,
                  }} />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Exported helper ────────────────────────────────────────────

export async function createNotification(params: {
  userId: string
  type: string
  title: string
  message: string
  relatedJobId?: string
}): Promise<void> {
  const { error } = await supabase.from('notifications').insert({
    user_id: params.userId,
    type: params.type,
    title: params.title,
    message: params.message,
    related_job_id: params.relatedJobId || null,
  })

  // Silently ignore duplicate constraint errors - means notification already exists
  if (error) {
    if (error.code === '23505') {
      // Unique constraint violation - this notification already exists
      return
    }
    console.error('createNotification: insert error', error.message)
  }
}

// ─── Helpers ────────────────────────────────────────────────────

function formatRelativeDate(value: string): string {
  const now = Date.now()
  const then = new Date(value).getTime()
  const diffMs = now - then
  const diffMin = Math.floor(diffMs / 60000)
  const diffHrs = Math.floor(diffMin / 60)
  const diffDays = Math.floor(diffHrs / 24)

  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  if (diffHrs < 24) return `${diffHrs}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  return new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
}

// ─── Styles ─────────────────────────────────────────────────────

const badgeStyle: React.CSSProperties = {
  position: 'absolute',
  top: 2,
  right: 2,
  background: '#EF4444',
  color: '#FFFFFF',
  fontSize: 9,
  fontWeight: 800,
  borderRadius: 999,
  minWidth: 16,
  height: 16,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '0 3px',
  lineHeight: 1,
}

const panelHeaderStyle: React.CSSProperties = {
  padding: '16px 18px 14px',
  borderBottom: '1px solid #F1F5F9',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  flexShrink: 0,
}

const panelTitleStyle: React.CSSProperties = {
  fontWeight: 800,
  fontSize: 16,
  color: '#0F172A',
  letterSpacing: -0.3,
}

const headerBadgeStyle: React.CSSProperties = {
  background: '#EF4444',
  color: '#FFFFFF',
  fontSize: 10,
  fontWeight: 800,
  borderRadius: 999,
  minWidth: 18,
  height: 18,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '0 5px',
  lineHeight: 1,
}

const markAllStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: '#3B82F6',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  padding: 0,
  WebkitTapHighlightColor: 'transparent',
}

const scrollAreaStyle: React.CSSProperties = {
  overflowY: 'auto',
  flex: 1,
  WebkitOverflowScrolling: 'touch',
}

const emptyStateStyle: React.CSSProperties = {
  padding: '40px 20px',
  textAlign: 'center',
}

const emptyIconWrapStyle: React.CSSProperties = {
  width: 48,
  height: 48,
  borderRadius: 14,
  background: '#F8FAFC',
  border: '1px solid #F1F5F9',
  display: 'grid',
  placeItems: 'center',
  margin: '0 auto',
}

const emptyTitleStyle: React.CSSProperties = {
  margin: '12px 0 0',
  fontSize: 14,
  color: '#64748B',
  fontWeight: 600,
}

const emptySubStyle: React.CSSProperties = {
  margin: '4px 0 0',
  fontSize: 12,
  color: '#CBD5E1',
  lineHeight: 1.4,
}

const groupHeaderStyle: React.CSSProperties = {
  padding: '10px 18px 6px',
  fontSize: 11,
  fontWeight: 700,
  color: '#94A3B8',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  background: '#FAFBFC',
  borderBottom: '1px solid #F4F5F7',
}

const itemStyle: React.CSSProperties = {
  padding: '12px 18px',
  display: 'flex',
  gap: 12,
  alignItems: 'flex-start',
  transition: 'background 0.12s ease',
  borderBottom: '1px solid #F8FAFC',
}

const iconCircleStyle: React.CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: 10,
  display: 'grid',
  placeItems: 'center',
  flexShrink: 0,
}

const unreadDotStyle: React.CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: 999,
  background: '#3B82F6',
  flexShrink: 0,
}

const messageStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#64748B',
  marginTop: 2,
  lineHeight: 1.45,
}

const timeStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#CBD5E1',
  marginTop: 4,
  fontWeight: 500,
}

const toastContainerStyle: React.CSSProperties = {
  position: 'fixed',
  top: 'calc(env(safe-area-inset-top, 0px) + 12px)',
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 99999,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  pointerEvents: 'none',
  width: 'min(360px, calc(100vw - 24px))',
}

const toastStyle: React.CSSProperties = {
  pointerEvents: 'auto',
  background: '#FFFFFF',
  borderRadius: 16,
  padding: '13px 16px',
  boxShadow: '0 8px 32px rgba(15, 23, 42, 0.12), 0 0 0 1px rgba(15, 23, 42, 0.05)',
  cursor: 'pointer',
  display: 'flex',
  gap: 12,
  alignItems: 'flex-start',
  position: 'relative',
  overflow: 'hidden',
}

const toastIconStyle: React.CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 9,
  display: 'grid',
  placeItems: 'center',
  flexShrink: 0,
}

const toastTitleStyle: React.CSSProperties = {
  fontWeight: 700,
  fontSize: 13,
  color: '#0F172A',
  lineHeight: 1.3,
  letterSpacing: -0.1,
}

const toastMessageStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#64748B',
  lineHeight: 1.4,
  marginTop: 2,
}

const toastProgressTrackStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 0,
  left: 0,
  right: 0,
  height: 3,
  background: '#F1F5F9',
}

const toastProgressBarStyle: React.CSSProperties = {
  height: '100%',
  background: '#3B82F6',
  borderRadius: '0 2px 2px 0',
}
