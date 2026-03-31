import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../services/supabaseClient'

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
  createdAt: number
}

const TOAST_DURATION = 4000

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

  const unreadCount = notifications.filter((n) => !n.is_read).length

  const addToast = useCallback((title: string, message: string) => {
    const id = crypto.randomUUID()
    setToasts((prev) => [...prev, { id, title, message, createdAt: Date.now() }])
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, TOAST_DURATION)
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
      .limit(50)

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
            addToast(row.title, row.message)
          }
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [authUserId, fetchNotifications, addToast])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

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
      <button
        type="button"
        onClick={() => setOpen(!open)}
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
          <span
            style={{
              position: 'absolute',
              top: 2,
              right: 2,
              background: '#EF4444',
              color: '#FFFFFF',
              fontSize: 10,
              fontWeight: 800,
              borderRadius: 999,
              minWidth: 18,
              height: 18,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '0 4px',
              lineHeight: 1,
            }}
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 8,
            width: 360,
            maxHeight: 440,
            background: '#FFFFFF',
            borderRadius: 16,
            boxShadow: '0 12px 32px rgba(15, 23, 42, 0.14)',
            border: '1px solid #E2E8F0',
            zIndex: 9999,
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div
            style={{
              padding: '14px 18px',
              borderBottom: '1px solid #F1F5F9',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span style={{ fontWeight: 700, fontSize: 15, color: '#0F172A' }}>
              Notifications
            </span>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={markAllAsRead}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#3B82F6',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                  padding: 0,
                }}
              >
                Mark all read
              </button>
            )}
          </div>

          <div style={{ overflowY: 'auto', flex: 1 }}>
            {notifications.length === 0 ? (
              <div
                style={{
                  padding: 32,
                  textAlign: 'center',
                  color: '#94A3B8',
                  fontSize: 14,
                }}
              >
                No notifications yet
              </div>
            ) : (
              notifications.map((n) => (
                <div
                  key={n.id}
                  onClick={() => !n.is_read && markAsRead(n.id)}
                  style={{
                    padding: '14px 18px',
                    borderBottom: '1px solid #F8FAFC',
                    background: n.is_read ? 'transparent' : '#F0F7FF',
                    cursor: n.is_read ? 'default' : 'pointer',
                    transition: 'background 0.15s',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'flex-start',
                      gap: 8,
                    }}
                  >
                    <div
                      style={{
                        fontWeight: n.is_read ? 500 : 700,
                        fontSize: 14,
                        color: '#0F172A',
                      }}
                    >
                      {n.title}
                    </div>
                    {!n.is_read && (
                      <div
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: 999,
                          background: '#3B82F6',
                          flexShrink: 0,
                          marginTop: 5,
                        }}
                      />
                    )}
                  </div>
                  <div
                    style={{
                      fontSize: 13,
                      color: '#64748B',
                      marginTop: 4,
                      lineHeight: 1.4,
                    }}
                  >
                    {n.message}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: '#94A3B8',
                      marginTop: 6,
                    }}
                  >
                    {formatRelativeDate(n.created_at)}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Toast popups — fixed to top-right of viewport */}
      {toasts.length > 0 && (
        <div
          style={{
            position: 'fixed',
            top: 16,
            right: 16,
            zIndex: 99999,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            pointerEvents: 'none',
          }}
        >
          {toasts.map((t) => (
            <div
              key={t.id}
              style={{
                pointerEvents: 'auto',
                background: '#0F172A',
                color: '#FFFFFF',
                borderRadius: 12,
                padding: '14px 18px',
                boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
                maxWidth: 340,
                animation: 'toast-slide-in 0.3s ease-out',
                cursor: 'pointer',
              }}
              onClick={() => dismissToast(t.id)}
            >
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>
                {t.title}
              </div>
              <div style={{ fontSize: 13, color: '#CBD5E1', lineHeight: 1.4 }}>
                {t.message}
              </div>
            </div>
          ))}
        </div>
      )}

      <style>{`
        @keyframes toast-slide-in {
          from { opacity: 0; transform: translateX(40px); }
          to { opacity: 1; transform: translateX(0); }
        }
      `}</style>
    </div>
  )
}

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
  if (error) {
    console.error('createNotification: insert error', error.message)
  }
}

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
  return new Date(value).toLocaleDateString()
}
