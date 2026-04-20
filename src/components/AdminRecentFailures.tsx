import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import { supabase } from '../services/supabaseClient'

/* ── Types ──────────────────────────────────────────────────────── */

interface FailureEvent {
  id: string
  event_name: string
  created_at: string
  user_id: string | null
  payload: {
    request_id?: string
    client_id?: string
    provider_id?: string
    error_code?: string
    reason_code?: string
    price?: number
    payment_intent_id?: string
    retry_count?: number
    source_screen?: string
    [key: string]: unknown
  }
}

const FAILURE_EVENTS = [
  'payment_failed',
  'payout_failed',
  'recovery_attempt_failed',
] as const

const EVENT_LABELS: Record<string, { label: string; color: string; bg: string }> = {
  payment_failed:           { label: 'Payment Failed',  color: '#DC2626', bg: '#FEE2E2' },
  payout_failed:            { label: 'Payout Failed',   color: '#9F1239', bg: '#FFE4E6' },
  recovery_attempt_failed:  { label: 'Recovery Failed', color: '#C2410C', bg: '#FFF7ED' },
}

/* ── Helpers ────────────────────────────────────────────────────── */

function fmtRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(ms / 60_000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

/* ── Component ──────────────────────────────────────────────────── */

export default function AdminRecentFailures() {
  const [events, setEvents] = useState<FailureEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<string>('all')

  const fetchFailures = useCallback(async () => {
    const since = new Date()
    since.setDate(since.getDate() - 7)

    const { data, error } = await supabase
      .from('analytics_events')
      .select('id, event_name, created_at, user_id, payload')
      .in('event_name', [...FAILURE_EVENTS])
      .gte('created_at', since.toISOString())
      .order('created_at', { ascending: false })
      .limit(50)

    if (error) {
      console.error('[AdminRecentFailures] fetch error:', error.message)
      setLoading(false)
      return
    }

    setEvents((data as FailureEvent[]) || [])
    setLoading(false)
  }, [])

  useEffect(() => {
    fetchFailures()
    const id = setInterval(fetchFailures, 30_000)
    return () => clearInterval(id)
  }, [fetchFailures])

  const filtered = filter === 'all'
    ? events
    : events.filter((e) => e.event_name === filter)

  /* ── Empty / loading states ─────────────────────────────── */

  if (!loading && events.length === 0) {
    return (
      <div style={st.shell}>
        <div style={st.headerRow}>
          <h3 style={st.title}>Recent Failures</h3>
          <span style={st.okBadge}>None</span>
        </div>
        <div style={st.emptyText}>No failures in the last 7 days.</div>
      </div>
    )
  }

  return (
    <div style={st.shell}>
      <div style={st.headerRow}>
        <h3 style={st.title}>Recent Failures</h3>
        <span style={st.countBadge}>{loading ? '...' : events.length}</span>
        <div style={{ marginLeft: 'auto' }}>
          <select
            style={st.filterSelect}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="all">All types</option>
            <option value="payment_failed">Payment failed</option>
            <option value="payout_failed">Payout failed</option>
            <option value="recovery_attempt_failed">Recovery failed</option>
          </select>
        </div>
      </div>

      {loading ? (
        <div style={st.emptyText}>Loading...</div>
      ) : (
        <div style={st.tableWrap}>
          <table style={st.table}>
            <thead>
              <tr>
                <th style={st.th}>Type</th>
                <th style={st.th}>Request</th>
                <th style={st.th}>Error</th>
                <th style={st.th}>Price</th>
                <th style={st.th}>Retries</th>
                <th style={st.th}>When</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((ev) => {
                const meta = EVENT_LABELS[ev.event_name] || { label: ev.event_name, color: '#64748B', bg: '#F1F5F9' }
                const p = ev.payload
                return (
                  <tr key={ev.id} style={st.row}>
                    <td style={st.td}>
                      <span style={{ ...st.pill, background: meta.bg, color: meta.color }}>{meta.label}</span>
                    </td>
                    <td style={st.td}>
                      {p.request_id ? (
                        <span style={st.mono}>{p.request_id.slice(0, 8)}</span>
                      ) : (
                        <span style={{ color: '#CBD5E1' }}>-</span>
                      )}
                    </td>
                    <td style={st.td}>
                      <span style={{ color: '#64748B', fontSize: 12 }}>
                        {p.error_code || p.reason_code || '-'}
                      </span>
                    </td>
                    <td style={st.td}>
                      {p.price != null ? `${p.price} ILS` : '-'}
                    </td>
                    <td style={st.td}>
                      {p.retry_count != null ? (
                        <span style={{ fontWeight: 700, color: p.retry_count >= 3 ? '#DC2626' : '#64748B' }}>
                          {p.retry_count}
                        </span>
                      ) : '-'}
                    </td>
                    <td style={st.td}>
                      <div style={{ fontSize: 13, color: '#334155' }}>{fmtRelative(ev.created_at)}</div>
                      <div style={{ fontSize: 11, color: '#94A3B8' }}>{fmtTime(ev.created_at)}</div>
                    </td>
                  </tr>
                )
              })}
              {filtered.length === 0 && (
                <tr>
                  <td style={{ ...st.td, textAlign: 'center', color: '#94A3B8', padding: 32 }} colSpan={6}>
                    No matching failures.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/* ── Styles ──────────────────────────────────────────────────────── */

const st: Record<string, CSSProperties> = {
  shell: {
    borderRadius: 16,
    background: '#FFFFFF',
    border: '1px solid #E8ECF0',
    boxShadow: '0 1px 3px rgba(0,0,0,0.03)',
    padding: 20,
    marginBottom: 16,
  },
  headerRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    marginBottom: 14,
  },
  title: {
    margin: 0,
    fontSize: 16,
    fontWeight: 800,
    color: '#0F172A',
    letterSpacing: -0.3,
  },
  countBadge: {
    fontSize: 11,
    fontWeight: 700,
    color: '#991B1B',
    background: '#FEE2E2',
    padding: '3px 8px',
    borderRadius: 6,
  },
  okBadge: {
    fontSize: 11,
    fontWeight: 700,
    color: '#166534',
    background: '#DCFCE7',
    padding: '3px 8px',
    borderRadius: 6,
  },
  emptyText: {
    textAlign: 'center',
    color: '#94A3B8',
    fontSize: 13,
    padding: '12px 0',
  },
  filterSelect: {
    padding: '5px 10px',
    borderRadius: 8,
    border: '1px solid #E2E8F0',
    fontSize: 12,
    outline: 'none',
    background: '#F8FAFC',
    color: '#334155',
    fontWeight: 500,
  },
  tableWrap: {
    overflowX: 'auto',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
  },
  th: {
    textAlign: 'left',
    padding: '8px 12px',
    borderBottom: '1px solid #E8ECF0',
    fontSize: 11,
    fontWeight: 700,
    color: '#94A3B8',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    whiteSpace: 'nowrap',
  },
  td: {
    padding: '10px 12px',
    borderBottom: '1px solid #F4F5F7',
    verticalAlign: 'top',
    fontSize: 13,
  },
  row: {
    transition: 'background 0.1s',
  },
  pill: {
    display: 'inline-block',
    padding: '3px 10px',
    borderRadius: 999,
    fontSize: 11,
    fontWeight: 700,
    whiteSpace: 'nowrap',
    letterSpacing: 0.2,
  },
  mono: {
    fontFamily: 'monospace',
    fontSize: 11,
    color: '#64748B',
  },
}
