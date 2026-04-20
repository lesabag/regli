import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { supabase, invokeEdgeFunction } from '../services/supabaseClient'

/* ── Types ──────────────────────────────────────────────────────── */

interface StuckProfile {
  id: string
  full_name: string | null
  email: string | null
}

interface StuckRequest {
  id: string
  created_at: string | null
  status: string
  dog_name: string | null
  location: string | null
  price: number | null
  payment_status: string | null
  stripe_payment_intent_id: string | null
  client_id: string | null
  walker_id: string | null
  client?: StuckProfile | null
  walker?: StuckProfile | null
}

/* ── Thresholds (ms) ─────────────────────────────────────────────── */

const THRESHOLDS: Record<string, number> = {
  awaiting_payment: 15 * 60_000,   // 15 min
  open:             30 * 60_000,   // 30 min
  accepted:         2 * 3600_000,  // 2 h
}

/* ── Helpers ────────────────────────────────────────────────────── */

function ageLabel(createdAt: string | null): string {
  if (!createdAt) return '-'
  const ms = Date.now() - new Date(createdAt).getTime()
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  const rem = mins % 60
  if (hrs < 24) return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`
  return `${Math.floor(hrs / 24)}d ${hrs % 24}h`
}

function nameOf(p: StuckProfile | null | undefined): string {
  if (!p) return '-'
  return p.full_name || p.email || p.id.slice(0, 8)
}

/* ── Component ──────────────────────────────────────────────────── */

export default function AdminStuckRequests() {
  const [rows, setRows] = useState<StuckRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [actionId, setActionId] = useState<string | null>(null)
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null)

  /* ── Fetch ──────────────────────────────────────────────── */

  const fetchStuck = useCallback(async () => {
    const { data, error } = await supabase
      .from('walk_requests')
      .select(`
        id, created_at, status, dog_name, location, price,
        payment_status, stripe_payment_intent_id, client_id, walker_id,
        client:profiles!walk_requests_client_id_fkey ( id, full_name, email ),
        walker:profiles!walk_requests_walker_id_fkey ( id, full_name, email )
      `)
      .in('status', ['awaiting_payment', 'open', 'accepted'])
      .order('created_at', { ascending: true })

    if (error) { console.error('[AdminStuck] fetch error:', error.message); setLoading(false); return }

    const normalized = (data || []).map((r: Record<string, unknown>) => ({
      ...r,
      client: Array.isArray(r.client) ? (r.client as StuckProfile[])[0] || null : r.client,
      walker: Array.isArray(r.walker) ? (r.walker as StuckProfile[])[0] || null : r.walker,
    })) as StuckRequest[]

    setRows(normalized)
    setLoading(false)
  }, [])

  useEffect(() => {
    fetchStuck()
    const ch = supabase
      .channel('admin-stuck-requests')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'walk_requests' }, () => fetchStuck())
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [fetchStuck])

  /* ── Filter to actually stuck rows ──────────────────────── */

  const stuckRows = useMemo(() => {
    const now = Date.now()
    return rows.filter((r) => {
      if (!r.created_at) return false
      const age = now - new Date(r.created_at).getTime()
      const threshold = THRESHOLDS[r.status]
      return threshold != null && age > threshold
    })
  }, [rows])

  /* ── Toast auto-dismiss ─────────────────────────────────── */

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(t)
  }, [toast])

  /* ── Actions ────────────────────────────────────────────── */

  const doAction = useCallback(async (
    id: string,
    label: string,
    fn: () => Promise<string | null>,
  ) => {
    if (!window.confirm(`${label} this service request?`)) return
    setActionId(id)
    try {
      const err = await fn()
      if (err) { setToast({ msg: err, ok: false }) }
      else { setToast({ msg: `${label} succeeded`, ok: true }); fetchStuck() }
    } catch (e) {
      setToast({ msg: e instanceof Error ? e.message : 'Unknown error', ok: false })
    } finally {
      setActionId(null)
    }
  }, [fetchStuck])

  const handleCancel = useCallback((r: StuckRequest) => {
    doAction(r.id, 'Cancel', async () => {
      const { error } = await supabase.from('walk_requests')
        .update({ status: 'cancelled' })
        .eq('id', r.id)
      return error?.message ?? null
    })
  }, [doAction])

  const handleComplete = useCallback((r: StuckRequest) => {
    doAction(r.id, 'Complete', async () => {
      if (r.stripe_payment_intent_id) {
        const { data, error: fnErr } = await invokeEdgeFunction<{
          success?: boolean; error?: string; details?: string
        }>('capture-payment', { body: { jobId: r.id } })
        if (fnErr) return fnErr
        if (data && !data.success) return data.details || data.error || 'Capture failed'
      } else {
        const { error } = await supabase.from('walk_requests')
          .update({ status: 'completed' })
          .eq('id', r.id)
        if (error) return error.message
      }
      return null
    })
  }, [doAction])

  const handleRetryCapture = useCallback((r: StuckRequest) => {
    doAction(r.id, 'Retry payment capture', async () => {
      const { data, error: fnErr } = await invokeEdgeFunction<{
        success?: boolean; error?: string; details?: string
      }>('capture-payment', { body: { jobId: r.id } })
      if (fnErr) return fnErr
      if (data && !data.success) return data.details || data.error || 'Capture failed'
      return null
    })
  }, [doAction])

  const handleRetryPayout = useCallback((r: StuckRequest) => {
    doAction(r.id, 'Retry payout', async () => {
      const { data, error: fnErr } = await invokeEdgeFunction<{
        success?: boolean; error?: string
      }>('create-transfer', { body: { jobId: r.id } })
      if (fnErr) return fnErr
      if (data && !data.success) return data.error || 'Transfer failed'
      return null
    })
  }, [doAction])

  /* ── Empty state ────────────────────────────────────────── */

  if (!loading && stuckRows.length === 0) {
    return (
      <div style={st.shell}>
        <div style={st.headerRow}>
          <h3 style={st.title}>Stuck Requests</h3>
          <span style={st.okBadge}>All clear</span>
        </div>
        <div style={st.emptyText}>No service requests are stuck right now.</div>
      </div>
    )
  }

  /* ── Render ─────────────────────────────────────────────── */

  return (
    <div style={st.shell}>
      <div style={st.headerRow}>
        <h3 style={st.title}>Stuck Requests</h3>
        <span style={st.countBadge}>{loading ? '...' : stuckRows.length}</span>
      </div>

      {/* Toast */}
      {toast && (
        <div style={{
          ...st.toast,
          background: toast.ok ? '#F0FDF4' : '#FEF2F2',
          borderColor: toast.ok ? '#BBF7D0' : '#FECACA',
          color: toast.ok ? '#166534' : '#991B1B',
        }}>
          {toast.msg}
        </div>
      )}

      {loading ? (
        <div style={st.emptyText}>Loading...</div>
      ) : (
        <div style={st.tableWrap}>
          <table style={st.table}>
            <thead>
              <tr>
                <th style={st.th}>Request</th>
                <th style={st.th}>Client</th>
                <th style={st.th}>Provider</th>
                <th style={st.th}>Status</th>
                <th style={st.th}>Payment</th>
                <th style={st.th}>Price</th>
                <th style={st.th}>Stuck</th>
                <th style={st.th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {stuckRows.map((r) => {
                const busy = actionId === r.id
                const canComplete = r.status === 'accepted'
                const canRetryCapture = r.payment_status === 'failed' && !!r.stripe_payment_intent_id
                const canRetryPayout = r.status === 'accepted' && r.payment_status === 'paid'
                return (
                  <tr key={r.id} style={st.row}>
                    <td style={st.td}>
                      <div style={st.mono}>{r.id.slice(0, 8)}</div>
                      {r.dog_name && <div style={st.sub}>{r.dog_name}</div>}
                    </td>
                    <td style={st.td}>{nameOf(r.client as StuckProfile | null)}</td>
                    <td style={st.td}>{nameOf(r.walker as StuckProfile | null)}</td>
                    <td style={st.td}><span style={statusPill(r.status)}>{r.status}</span></td>
                    <td style={st.td}><span style={payPill(r.payment_status || 'unpaid')}>{r.payment_status || 'unpaid'}</span></td>
                    <td style={st.td}>{r.price != null ? `${r.price} ILS` : '-'}</td>
                    <td style={st.td}>
                      <span style={st.ageBadge}>{ageLabel(r.created_at)}</span>
                    </td>
                    <td style={st.td}>
                      <div style={st.actionsRow}>
                        <button
                          style={{ ...st.btnRed, opacity: busy ? 0.5 : 1 }}
                          disabled={busy}
                          onClick={() => handleCancel(r)}
                        >Cancel</button>
                        {canComplete && (
                          <button
                            style={{ ...st.btnGreen, opacity: busy ? 0.5 : 1 }}
                            disabled={busy}
                            onClick={() => handleComplete(r)}
                          >Complete</button>
                        )}
                        {canRetryCapture && (
                          <button
                            style={{ ...st.btnOutline, opacity: busy ? 0.5 : 1 }}
                            disabled={busy}
                            onClick={() => handleRetryCapture(r)}
                          >Retry capture</button>
                        )}
                        {canRetryPayout && (
                          <button
                            style={{ ...st.btnOutline, opacity: busy ? 0.5 : 1 }}
                            disabled={busy}
                            onClick={() => handleRetryPayout(r)}
                          >Retry payout</button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/* ── Badge helpers ─────────────────────────────────────────────── */

const pill: CSSProperties = {
  display: 'inline-block',
  padding: '3px 10px',
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 700,
  whiteSpace: 'nowrap',
  letterSpacing: 0.2,
}

function statusPill(s: string): CSSProperties {
  if (s === 'awaiting_payment') return { ...pill, background: '#FFF7ED', color: '#C2410C' }
  if (s === 'open') return { ...pill, background: '#DBEAFE', color: '#1D4ED8' }
  if (s === 'accepted') return { ...pill, background: '#FEF3C7', color: '#92400E' }
  return pill
}

function payPill(s: string): CSSProperties {
  if (s === 'unpaid') return { ...pill, background: '#F1F5F9', color: '#64748B' }
  if (s === 'authorized') return { ...pill, background: '#EDE9FE', color: '#6D28D9' }
  if (s === 'paid') return { ...pill, background: '#DCFCE7', color: '#166534' }
  if (s === 'failed') return { ...pill, background: '#FEE2E2', color: '#991B1B' }
  return pill
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
  toast: {
    padding: '8px 14px',
    borderRadius: 10,
    border: '1px solid',
    fontSize: 13,
    fontWeight: 600,
    marginBottom: 12,
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
  mono: {
    fontFamily: 'monospace',
    fontSize: 11,
    color: '#64748B',
  },
  sub: {
    fontSize: 12,
    color: '#94A3B8',
    marginTop: 2,
  },
  ageBadge: {
    fontWeight: 800,
    color: '#DC2626',
    fontSize: 13,
  },
  actionsRow: {
    display: 'flex',
    gap: 4,
    flexWrap: 'wrap',
  },
  btnRed: {
    padding: '5px 10px',
    borderRadius: 8,
    border: 'none',
    background: '#FEF2F2',
    color: '#DC2626',
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 700,
  },
  btnGreen: {
    padding: '5px 10px',
    borderRadius: 8,
    border: 'none',
    background: '#DCFCE7',
    color: '#166534',
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 700,
  },
  btnOutline: {
    padding: '5px 10px',
    borderRadius: 8,
    border: '1px solid #E2E8F0',
    background: '#FFFFFF',
    color: '#334155',
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 600,
  },
}
