import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { supabase, invokeEdgeFunction } from '../services/supabaseClient'

/* ── Types ──────────────────────────────────────────────────────── */

interface Alert {
  id: string
  severity: 'low' | 'medium' | 'high'
  title: string
  metric: string
  message: string
  current_value: number
  threshold: number
  window_minutes: number | null
  affected_count: number
  auto_action: string | null
  detected_at: string
}

interface RecoveryRow {
  event_name: string
  request_id: string
  reason_code: string
  retry_count: number | null
  ts: string
}

interface HistoryRow {
  hour: string
  payment_failures: number
  payout_failures: number
  cancellations: number
  submissions: number
  matches: number
}

interface Snapshot {
  short_window: number
  long_window: number
  submitted: number
  matched: number
  cancelled: number
  pay_captured: number
  pay_failed: number
  payout_failed: number
  stuck_total: number
  stuck_pay: number
  stuck_open: number
  stuck_accepted: number
  providers_online: number
  open_requests: number
  checked_at: string
}

interface AlertsData {
  alerts: Alert[]
  recovery: RecoveryRow[]
  history: HistoryRow[]
  snapshot: Snapshot
}

/* ── Configurable thresholds (central constants) ───────────────── */

const THRESHOLDS = {
  payment_failed_rate: 10,   // %
  payout_failed_rate:  10,   // %
  cancellation_rate:   20,   // %
  nomatch_rate:        25,   // %
  stuck_requests:      5,    // count
  provider_availability: 2,  // min online
} as const

/** Minimum events in denominator before rate alerts fire. */
const MIN_VOLUME = 5

/* ── Helpers ────────────────────────────────────────────────────── */

const SEV_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 }

function sevColor(s: string): string {
  if (s === 'high') return '#DC2626'
  if (s === 'medium') return '#D97706'
  return '#3B82F6'
}
function sevBg(s: string): string {
  if (s === 'high') return '#FEF2F2'
  if (s === 'medium') return '#FFFBEB'
  return '#EFF6FF'
}
function sevBorder(s: string): string {
  if (s === 'high') return '#FECACA'
  if (s === 'medium') return '#FDE68A'
  return '#BFDBFE'
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '-'
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}
function fmtDateTime(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '-'
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) + ' ' +
    d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}
function fmtRelative(iso: string | undefined): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '-'
  const ms = Date.now() - d.getTime()
  const mins = Math.floor(ms / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  return `${hrs}h ${mins % 60}m ago`
}

function autoActionLabel(action: string): string {
  if (action === 'retry_failed_payments') return 'Retry Failed Payments'
  if (action === 'retry_failed_payouts') return 'Retry Failed Payouts'
  if (action === 'flag_stuck_requests') return 'View Stuck Requests'
  return action.replace(/_/g, ' ')
}

function operatorHint(alert: Alert): string | null {
  switch (alert.metric) {
    case 'cancellation_rate':
      return 'Check Supply/Demand panel for cancellation hotspots by category or zone'
    case 'nomatch_rate':
      return 'Consider reaching out to offline providers or check if demand is concentrated in an unserved area'
    case 'provider_availability':
      return alert.current_value === 0
        ? 'No providers are online — consider sending notifications to encourage availability'
        : 'Open requests outnumber available providers — possible demand spike or provider drop-off'
    default:
      return null
  }
}

function recoveryStatusColor(eventName: string): string {
  if (eventName.includes('succeeded')) return '#16A34A'
  if (eventName.includes('failed')) return '#DC2626'
  return '#D97706'
}
function recoveryStatusLabel(eventName: string): string {
  if (eventName === 'recovery_attempt_started') return 'Started'
  if (eventName === 'recovery_attempt_succeeded') return 'Succeeded'
  if (eventName === 'recovery_attempt_failed') return 'Failed'
  return eventName
}

/* ── Component ──────────────────────────────────────────────────── */

export default function AdminAlerts() {
  const [data, setData] = useState<AlertsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  const [showRecovery, setShowRecovery] = useState(true)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null)
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())

  /* ── Fetch ──────────────────────────────────────────────── */

  const fetchAlerts = useCallback(async () => {
    const { data: rpc, error: err } = await supabase.rpc('admin_alerts_check', {
      p_short_window: 15,
      p_long_window: 30,
    })
    if (err) { setError(err.message); setLoading(false); return }
    setData(rpc as unknown as AlertsData)
    setError(null)
    setLoading(false)
  }, [])

  useEffect(() => {
    setLoading(true)
    fetchAlerts()
    const id = setInterval(fetchAlerts, 20_000)
    return () => clearInterval(id)
  }, [fetchAlerts])

  /* ── Toast auto-dismiss ─────────────────────────────────── */

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(t)
  }, [toast])

  /* ── Auto-actions ───────────────────────────────────────── */

  const runAutoAction = useCallback(async (alert: Alert) => {
    if (!alert.auto_action) return

    setActionLoading(alert.id)

    try {
      if (alert.auto_action === 'retry_failed_payments') {
        // Only retry requests stuck in awaiting_payment for >15 min
        // that have a valid payment intent (eligible for capture retry).
        const cutoff = new Date(Date.now() - 15 * 60_000).toISOString()
        const { data: eligible } = await supabase
          .from('walk_requests')
          .select('id, stripe_payment_intent_id')
          .eq('status', 'awaiting_payment')
          .not('stripe_payment_intent_id', 'is', null)
          .lt('created_at', cutoff)
          .limit(10)

        if (!eligible || eligible.length === 0) {
          setToast({ msg: 'No eligible payment retries found', ok: true })
          return
        }

        if (!window.confirm(
          `Retry payment capture for ${eligible.length} stuck request(s)?\n\nThis will attempt to capture authorized payments that have been stuck for >15 min.`
        )) return

        let ok = 0; let fail = 0
        for (const req of eligible) {
          const { data: r, error: e } = await invokeEdgeFunction<{
            success?: boolean; error?: string
          }>('capture-payment', { body: { jobId: req.id } })
          if (e || (r && !r.success)) fail++; else ok++
        }
        setToast({ msg: `Retried ${eligible.length} payment(s): ${ok} succeeded, ${fail} failed`, ok: fail === 0 })

      } else if (alert.auto_action === 'retry_failed_payouts') {
        // Only retry completed requests where payment was captured >30 min ago
        // but payout hasn't gone through yet (still in 'captured' status).
        const cutoff = new Date(Date.now() - 30 * 60_000).toISOString()
        const { data: eligible } = await supabase
          .from('walk_requests')
          .select('id')
          .eq('status', 'completed')
          .eq('payment_status', 'captured')
          .lt('created_at', cutoff)
          .limit(10)

        if (!eligible || eligible.length === 0) {
          setToast({ msg: 'No eligible payout retries found', ok: true })
          return
        }

        if (!window.confirm(
          `Retry payout for ${eligible.length} completed request(s)?\n\nThis will attempt to transfer earnings for requests completed >30 min ago where payout is still pending.`
        )) return

        let ok = 0; let fail = 0
        for (const req of eligible) {
          const { data: r, error: e } = await invokeEdgeFunction<{
            success?: boolean; error?: string
          }>('create-transfer', { body: { jobId: req.id } })
          if (e || (r && !r.success)) fail++; else ok++
        }
        setToast({ msg: `Retried ${eligible.length} payout(s): ${ok} succeeded, ${fail} failed`, ok: fail === 0 })

      } else if (alert.auto_action === 'flag_stuck_requests') {
        setToast({ msg: 'Scroll to Stuck Requests panel below for details and actions', ok: true })
      }

      fetchAlerts()
    } catch (e) {
      setToast({ msg: e instanceof Error ? e.message : 'Action failed', ok: false })
    } finally {
      setActionLoading(null)
    }
  }, [fetchAlerts])

  /* ── Derived data ───────────────────────────────────────── */

  const activeAlerts = useMemo(() => {
    if (!data) return []
    return data.alerts
      .filter((a) => !dismissed.has(a.id))
      .sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9))
  }, [data, dismissed])

  const dismissedCount = useMemo(() => {
    if (!data) return 0
    return data.alerts.filter((a) => dismissed.has(a.id)).length
  }, [data, dismissed])

  const historyRows = useMemo(() => {
    if (!data) return []
    return data.history.filter((h) =>
      h.payment_failures > 0 || h.payout_failures > 0 || h.cancellations > 0
    )
  }, [data])

  /* ── Loading / error ───────────────────────────────────── */

  if (loading && !data) {
    return (
      <div style={st.shell}>
        <div style={st.loadingText}>Checking alerts...</div>
      </div>
    )
  }

  if (error && !data) {
    return (
      <div style={st.shell}>
        <div style={st.headerRow}>
          <h3 style={st.title}>Alerts</h3>
          <span style={st.errorBadge}>Error</span>
        </div>
        <div style={{ fontSize: 12, color: '#94A3B8', textAlign: 'center' as const, padding: '8px 0' }}>{error}</div>
      </div>
    )
  }

  if (!data) return null

  const snap = data.snapshot
  const hasAlerts = activeAlerts.length > 0
  const highSev = activeAlerts.some((a) => a.severity === 'high')

  /* ── Render ────────────────────────────────────────────── */

  return (
    <div style={{
      ...st.shell,
      borderColor: hasAlerts ? (highSev ? '#FECACA' : '#FDE68A') : '#E8ECF0',
    }}>
      {/* ── Header ──────────────────────────────────────────── */}
      <div style={st.headerRow}>
        <h3 style={st.title}>Alerts &amp; Remediation</h3>
        {hasAlerts ? (
          <span style={{
            ...st.countBadge,
            background: highSev ? '#DC2626' : '#D97706',
          }}>
            {activeAlerts.length}
          </span>
        ) : (
          <span style={st.okBadge}>All clear</span>
        )}
        {error && <span style={st.staleBadge}>Stale</span>}
        <div style={{ flex: 1 }} />
        <span style={st.meta}>
          {fmtRelative(snap.checked_at)}
        </span>
      </div>

      {/* ── Live snapshot pills ─────────────────────────────── */}
      <div style={st.pillRow}>
        <SnapPill label="Submitted" value={snap.submitted ?? 0} sub={`${snap.long_window ?? 30}m`} />
        <SnapPill label="Matched" value={snap.matched ?? 0} sub={`${snap.long_window ?? 30}m`} />
        <SnapPill label="Cancelled" value={snap.cancelled ?? 0} sub={`${snap.long_window ?? 30}m`}
          color={(snap.cancelled ?? 0) > 0 ? '#D97706' : undefined} />
        <SnapPill label="Pay Fail" value={snap.pay_failed ?? 0} sub={`${snap.short_window ?? 15}m`}
          color={(snap.pay_failed ?? 0) > 0 ? '#DC2626' : undefined} />
        <SnapPill label="Payout Fail" value={snap.payout_failed ?? 0} sub={`${snap.short_window ?? 15}m`}
          color={(snap.payout_failed ?? 0) > 0 ? '#DC2626' : undefined} />
        <SnapPill label="Stuck" value={snap.stuck_total ?? 0}
          color={(snap.stuck_total ?? 0) > THRESHOLDS.stuck_requests ? '#DC2626' : undefined} />
        <SnapPill label="Providers" value={snap.providers_online ?? 0}
          color={(snap.providers_online ?? 0) < THRESHOLDS.provider_availability ? '#DC2626' : '#16A34A'} />
      </div>

      {/* ── Active alerts ───────────────────────────────────── */}
      {hasAlerts && (
        <>
          <SectionLabel>Active Alerts</SectionLabel>
          <div style={st.alertList}>
            {activeAlerts.map((a) => {
              const hint = operatorHint(a)
              const isRunning = actionLoading === a.id
              return (
                <div key={a.id} style={{
                  ...st.alertCard,
                  borderColor: sevBorder(a.severity),
                  background: sevBg(a.severity),
                }}>
                  {/* Row 1: severity + title + dismiss */}
                  <div style={st.alertTop}>
                    <span style={{ ...st.sevBadge, background: sevColor(a.severity) }}>
                      {a.severity.toUpperCase()}
                    </span>
                    <span style={st.alertTitle}>{a.title}</span>
                    <div style={{ flex: 1 }} />
                    <button
                      style={st.dismissBtn}
                      onClick={() => setDismissed((prev) => new Set(prev).add(a.id))}
                      title="Dismiss"
                    >&times;</button>
                  </div>

                  {/* Row 2: message */}
                  <div style={st.alertMessage}>{a.message}</div>

                  {/* Row 3: metadata */}
                  <div style={st.alertMeta}>
                    <MetaTag label="Metric" value={a.metric.replace(/_/g, ' ')} />
                    <MetaTag label="Value" value={String(a.current_value) + (a.metric.includes('rate') ? '%' : '')} bold />
                    <MetaTag label="Threshold" value={String(a.threshold) + (a.metric.includes('rate') ? '%' : '')} />
                    {a.window_minutes != null && <MetaTag label="Window" value={`${a.window_minutes}m`} />}
                    <MetaTag label="Affected" value={String(a.affected_count)} />
                    <MetaTag label="Detected" value={fmtTime(a.detected_at)} />
                  </div>

                  {/* Operator hint */}
                  {hint && (
                    <div style={st.hintRow}>
                      <span style={st.hintDot} />
                      <span style={st.hintText}>{hint}</span>
                    </div>
                  )}

                  {/* Auto-action button */}
                  {a.auto_action && (
                    <button
                      style={{ ...st.actionBtn, opacity: isRunning ? 0.6 : 1 }}
                      disabled={isRunning}
                      onClick={() => runAutoAction(a)}
                    >
                      {isRunning ? 'Running...' : autoActionLabel(a.auto_action)}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}

      {/* Dismissed restore link */}
      {dismissedCount > 0 && (
        <button style={st.linkBtn} onClick={() => setDismissed(new Set())}>
          Restore {dismissedCount} dismissed alert{dismissedCount !== 1 ? 's' : ''}
        </button>
      )}

      {/* All clear state */}
      {!hasAlerts && dismissedCount === 0 && (
        <div style={st.allClear}>
          All metrics within healthy thresholds (min {MIN_VOLUME} events required to trigger rate alerts)
        </div>
      )}

      {/* ── Recovery Activity ───────────────────────────────── */}
      <div style={{ marginTop: 20 }}>
        <div style={st.sectionHeader}>
          <SectionLabel>Recovery Activity (24h)</SectionLabel>
          {data.recovery.length > 0 && (
            <button style={st.linkBtn} onClick={() => setShowRecovery(!showRecovery)}>
              {showRecovery ? 'Hide' : `Show (${data.recovery.length})`}
            </button>
          )}
        </div>

        {showRecovery && data.recovery.length > 0 ? (
          <div style={st.tableWrap}>
            <table style={st.table}>
              <thead>
                <tr>
                  <th style={st.th}>Status</th>
                  <th style={st.th}>Request ID</th>
                  <th style={st.th}>Reason</th>
                  <th style={st.th}>Retry #</th>
                  <th style={st.th}>Time</th>
                </tr>
              </thead>
              <tbody>
                {data.recovery.map((r, i) => (
                  <tr key={i} style={st.row}>
                    <td style={st.td}>
                      <span style={{
                        ...st.statusPill,
                        color: recoveryStatusColor(r.event_name),
                        background: r.event_name.includes('succeeded') ? '#DCFCE7'
                          : r.event_name.includes('failed') ? '#FEE2E2' : '#FFFBEB',
                      }}>
                        {recoveryStatusLabel(r.event_name)}
                      </span>
                    </td>
                    <td style={st.td}>
                      <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#475569' }}>
                        {r.request_id ? r.request_id.slice(0, 8) : '-'}
                      </span>
                    </td>
                    <td style={st.td}>
                      <span style={{ fontSize: 12, color: '#64748B' }}>
                        {r.reason_code || '-'}
                      </span>
                    </td>
                    <td style={st.td}>
                      <span style={{ fontWeight: 600, color: '#334155' }}>
                        {r.retry_count != null ? r.retry_count : '-'}
                      </span>
                    </td>
                    <td style={st.td}>
                      <span style={{ fontSize: 11, color: '#94A3B8' }}>
                        {fmtDateTime(r.ts)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : data.recovery.length === 0 ? (
          <div style={st.emptyText}>No recovery attempts in the last 24 hours.</div>
        ) : null}
      </div>

      {/* ── Alert History (24h) ──────────────────────────────── */}
      <div style={{ marginTop: 16 }}>
        <div style={st.sectionHeader}>
          <SectionLabel>Alert History (24h)</SectionLabel>
          <button style={st.linkBtn} onClick={() => setShowHistory(!showHistory)}>
            {showHistory ? 'Hide' : `Show${historyRows.length > 0 ? ` (${historyRows.length})` : ''}`}
          </button>
        </div>

        {showHistory && (
          historyRows.length > 0 ? (
            <div style={st.tableWrap}>
              <table style={st.table}>
                <thead>
                  <tr>
                    <th style={st.th}>Hour</th>
                    <th style={st.th}>Submitted</th>
                    <th style={st.th}>Matched</th>
                    <th style={st.th}>Pay Fail</th>
                    <th style={st.th}>Payout Fail</th>
                    <th style={st.th}>Cancelled</th>
                  </tr>
                </thead>
                <tbody>
                  {historyRows.map((h) => (
                    <tr key={h.hour} style={st.row}>
                      <td style={st.td}>
                        <span style={{ fontWeight: 600, color: '#0F172A' }}>{fmtTime(h.hour)}</span>
                      </td>
                      <td style={st.td}>{h.submissions}</td>
                      <td style={st.td}>{h.matches}</td>
                      <td style={st.td}>
                        <HighlightNum value={h.payment_failures} warn />
                      </td>
                      <td style={st.td}>
                        <HighlightNum value={h.payout_failures} warn />
                      </td>
                      <td style={st.td}>
                        <HighlightNum value={h.cancellations} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={st.emptyText}>No incidents in the last 24 hours.</div>
          )
        )}
      </div>

      {/* ── Threshold reference ──────────────────────────────── */}
      <div style={st.thresholdBar}>
        <span style={st.thresholdLabel}>Thresholds:</span>
        <span>Pay &gt;{THRESHOLDS.payment_failed_rate}%</span>
        <span style={st.thresholdDot} />
        <span>Payout &gt;{THRESHOLDS.payout_failed_rate}%</span>
        <span style={st.thresholdDot} />
        <span>Cancel &gt;{THRESHOLDS.cancellation_rate}%</span>
        <span style={st.thresholdDot} />
        <span>No-Match &gt;{THRESHOLDS.nomatch_rate}%</span>
        <span style={st.thresholdDot} />
        <span>Stuck &gt;{THRESHOLDS.stuck_requests}</span>
        <span style={st.thresholdDot} />
        <span>Providers &lt;{THRESHOLDS.provider_availability}</span>
        <span style={st.thresholdDot} />
        <span>Min vol: {MIN_VOLUME}</span>
      </div>

      {/* ── Toast ───────────────────────────────────────────── */}
      {toast && (
        <div style={{
          ...st.toast,
          background: toast.ok ? '#DCFCE7' : '#FEE2E2',
          color: toast.ok ? '#166534' : '#991B1B',
          borderColor: toast.ok ? '#BBF7D0' : '#FECACA',
        }}>
          {toast.msg}
        </div>
      )}
    </div>
  )
}

/* ── Sub-components ─────────────────────────────────────────────── */

function SectionLabel({ children }: { children: string }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 700, color: '#94A3B8',
      textTransform: 'uppercase' as const, letterSpacing: 0.6, marginBottom: 8,
    }}>
      {children}
    </div>
  )
}

function SnapPill({ label, value, sub, color }: {
  label: string; value: number; sub?: string; color?: string
}) {
  return (
    <div style={st.pill}>
      <span style={{ fontSize: 15, fontWeight: 800, color: color || '#334155', lineHeight: 1 }}>
        {value}
      </span>
      <span style={{ fontSize: 9, color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: 0.3 }}>
        {label}
      </span>
      {sub && <span style={{ fontSize: 8, color: '#CBD5E1' }}>{sub}</span>}
    </div>
  )
}

function MetaTag({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <span style={{ whiteSpace: 'nowrap' as const }}>
      <span style={{ color: '#94A3B8' }}>{label}:</span>{' '}
      <span style={{ fontWeight: bold ? 700 : 600, color: '#334155' }}>{value}</span>
    </span>
  )
}

function HighlightNum({ value, warn }: { value: number; warn?: boolean }) {
  const isNonZero = value > 0
  return (
    <span style={{
      color: isNonZero ? (warn ? '#DC2626' : '#D97706') : '#94A3B8',
      fontWeight: isNonZero ? 700 : 400,
    }}>
      {value}
    </span>
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
    position: 'relative',
  },
  loadingText: {
    textAlign: 'center',
    color: '#94A3B8',
    fontSize: 13,
    padding: '20px 0',
  },
  headerRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    marginBottom: 14,
    flexWrap: 'wrap',
  },
  title: {
    margin: 0,
    fontSize: 16,
    fontWeight: 800,
    color: '#0F172A',
    letterSpacing: -0.3,
  },
  countBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 22,
    height: 22,
    borderRadius: 11,
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: 800,
  },
  okBadge: {
    fontSize: 10,
    fontWeight: 700,
    color: '#166534',
    background: '#DCFCE7',
    padding: '2px 8px',
    borderRadius: 6,
  },
  staleBadge: {
    fontSize: 10,
    fontWeight: 700,
    color: '#D97706',
    background: '#FFFBEB',
    padding: '2px 8px',
    borderRadius: 6,
  },
  errorBadge: {
    fontSize: 10,
    fontWeight: 700,
    color: '#DC2626',
    background: '#FEE2E2',
    padding: '2px 8px',
    borderRadius: 6,
  },
  meta: {
    fontSize: 10,
    color: '#94A3B8',
    fontWeight: 500,
  },

  /* Snapshot pills */
  pillRow: {
    display: 'flex',
    gap: 6,
    flexWrap: 'wrap',
    marginBottom: 16,
  },
  pill: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 1,
    padding: '6px 10px',
    borderRadius: 8,
    background: '#F8FAFC',
    border: '1px solid #F1F5F9',
    minWidth: 56,
  },

  /* Alert cards */
  alertList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    marginBottom: 10,
  },
  alertCard: {
    padding: '12px 14px',
    borderRadius: 10,
    border: '1px solid',
  },
  alertTop: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  sevBadge: {
    display: 'inline-block',
    padding: '2px 7px',
    borderRadius: 4,
    fontSize: 9,
    fontWeight: 800,
    color: '#FFFFFF',
    letterSpacing: 0.5,
    flexShrink: 0,
  },
  alertTitle: {
    fontSize: 13,
    fontWeight: 700,
    color: '#0F172A',
  },
  alertMessage: {
    fontSize: 12,
    color: '#475569',
    marginTop: 4,
    lineHeight: 1.4,
  },
  alertMeta: {
    display: 'flex',
    gap: 14,
    marginTop: 8,
    fontSize: 10,
    color: '#64748B',
    flexWrap: 'wrap',
  },
  dismissBtn: {
    background: 'none',
    border: 'none',
    fontSize: 18,
    color: '#94A3B8',
    cursor: 'pointer',
    padding: '0 4px',
    lineHeight: 1,
  },
  hintRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 6,
    marginTop: 8,
    padding: '5px 8px',
    borderRadius: 6,
    background: 'rgba(255,255,255,0.6)',
  },
  hintDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    background: '#3B82F6',
    flexShrink: 0,
    marginTop: 4,
  },
  hintText: {
    fontSize: 11,
    color: '#475569',
    lineHeight: 1.4,
  },
  actionBtn: {
    marginTop: 8,
    padding: '5px 12px',
    borderRadius: 6,
    border: '1px solid #E2E8F0',
    background: '#FFFFFF',
    color: '#0F172A',
    fontSize: 11,
    fontWeight: 700,
    cursor: 'pointer',
  },
  linkBtn: {
    background: 'none',
    border: 'none',
    color: '#3B82F6',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    padding: 0,
    textDecoration: 'underline',
  },

  /* All clear */
  allClear: {
    fontSize: 12,
    color: '#64748B',
    padding: '4px 0',
  },

  /* Section header with toggle */
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },

  /* Tables */
  tableWrap: { overflowX: 'auto' },
  table: { width: '100%', borderCollapse: 'collapse' },
  th: {
    textAlign: 'left',
    padding: '5px 8px',
    borderBottom: '1px solid #E8ECF0',
    fontSize: 9,
    fontWeight: 700,
    color: '#94A3B8',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    whiteSpace: 'nowrap',
  },
  td: {
    padding: '5px 8px',
    borderBottom: '1px solid #F4F5F7',
    fontSize: 12,
    verticalAlign: 'middle',
  },
  row: { transition: 'background 0.1s' },
  statusPill: {
    display: 'inline-block',
    padding: '1px 6px',
    borderRadius: 4,
    fontSize: 10,
    fontWeight: 700,
  },
  emptyText: {
    fontSize: 11,
    color: '#94A3B8',
    padding: '6px 0',
  },

  /* Threshold bar */
  thresholdBar: {
    marginTop: 16,
    padding: '8px 12px',
    borderRadius: 8,
    background: '#F8FAFC',
    border: '1px solid #F1F5F9',
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
    alignItems: 'center',
    fontSize: 10,
    color: '#64748B',
  },
  thresholdLabel: {
    fontWeight: 700,
    color: '#94A3B8',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginRight: 2,
  },
  thresholdDot: {
    width: 3,
    height: 3,
    borderRadius: 2,
    background: '#CBD5E1',
  },

  /* Toast */
  toast: {
    position: 'absolute',
    bottom: 12,
    left: 20,
    right: 20,
    padding: '8px 14px',
    borderRadius: 10,
    border: '1px solid',
    fontSize: 12,
    fontWeight: 600,
    textAlign: 'center',
    zIndex: 10,
  },
}
