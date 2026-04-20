import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import { supabase } from '../services/supabaseClient'

/* ── Types ──────────────────────────────────────────────────────── */

interface KpiMetrics {
  event_counts: Record<string, number>
  time_metrics: {
    avg_request_to_match_sec: number | null
    avg_match_to_accept_sec: number | null
    avg_accept_to_complete_sec: number | null
    sample_count: number
  }
  gmv: number
  operational: {
    open_requests: number
    available_providers: number
    stuck_requests: number
    failed_payments_recent: number
    failed_payouts_recent: number
  }
}

interface Props {
  timeRange: 'today' | 'week' | 'all'
}

/* ── Helpers ────────────────────────────────────────────────────── */

function toSince(range: 'today' | 'week' | 'all'): string {
  const now = new Date()
  if (range === 'today') {
    const d = new Date(now); d.setHours(0, 0, 0, 0); return d.toISOString()
  }
  if (range === 'week') {
    const d = new Date(now); d.setDate(d.getDate() - 7); d.setHours(0, 0, 0, 0); return d.toISOString()
  }
  return '2020-01-01T00:00:00Z'
}

/** Sum counts for one or more event names */
function ec(counts: Record<string, number>, ...events: string[]): number {
  return events.reduce((sum, e) => sum + (counts[e] ?? 0), 0)
}

function fmtDur(sec: number | null): string {
  if (sec == null || sec <= 0) return '-'
  if (sec < 60) return `${Math.round(sec)}s`
  if (sec < 3600) return `${Math.round(sec / 60)}m`
  const h = Math.floor(sec / 3600)
  const m = Math.round((sec % 3600) / 60)
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

function fmtILS(amount: number): string {
  if (amount >= 10_000) return `${(amount / 1000).toFixed(1)}K`
  if (amount >= 1_000) return `${(amount / 1000).toFixed(1)}K`
  return amount.toFixed(0)
}

/* ── Component ──────────────────────────────────────────────────── */

export default function AdminKpiPanel({ timeRange }: Props) {
  const [kpi, setKpi] = useState<KpiMetrics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [serviceCategory, setServiceCategory] = useState<string | null>(null)
  const [platform, setPlatform] = useState<string | null>(null)

  const fetchKpi = useCallback(async () => {
    const { data, error: err } = await supabase.rpc('admin_kpi_metrics', {
      p_since: toSince(timeRange),
      p_service_category: serviceCategory,
      p_platform: platform,
    })
    if (err) { setError(err.message); setLoading(false); return }
    setKpi(data as unknown as KpiMetrics)
    setError(null)
    setLoading(false)
  }, [timeRange, serviceCategory, platform])

  useEffect(() => {
    setLoading(true)
    fetchKpi()
    const id = setInterval(fetchKpi, 30_000)
    return () => clearInterval(id)
  }, [fetchKpi])

  /* ── Loading / error states ───────────────────────────────── */

  if (loading && !kpi) {
    return (
      <div style={st.shell}>
        <div style={st.loading}>Loading analytics...</div>
      </div>
    )
  }

  if (error && !kpi) {
    return (
      <div style={st.shell}>
        <div style={st.errorBox}>
          <span style={{ fontWeight: 700, color: '#64748B' }}>Analytics unavailable</span>
          <span style={{ fontSize: 11, color: '#94A3B8' }}>{error}</span>
        </div>
      </div>
    )
  }

  if (!kpi) return null

  const c = kpi.event_counts
  const tm = kpi.time_metrics
  const op = kpi.operational

  /* ── A. Summary cards data ─────────────────────────────────── */

  const cards: { label: string; value: number | string; color: string; bg: string }[] = [
    { label: 'Requests',      value: ec(c, 'service_request_submitted'), color: '#3B82F6', bg: '#DBEAFE' },
    { label: 'Accepted',      value: ec(c, 'provider_accepted'),        color: '#8B5CF6', bg: '#EDE9FE' },
    { label: 'Completed',     value: ec(c, 'service_completed'),        color: '#16A34A', bg: '#DCFCE7' },
    { label: 'Captured',      value: ec(c, 'payment_captured'),         color: '#059669', bg: '#D1FAE5' },
    { label: 'Pay Failed',    value: ec(c, 'payment_failed'),           color: '#DC2626', bg: '#FEE2E2' },
    { label: 'Payout Failed', value: ec(c, 'payout_failed'),            color: '#9F1239', bg: '#FFE4E6' },
    { label: 'GMV',           value: `${fmtILS(kpi.gmv)} ILS`,         color: '#16A34A', bg: '#DCFCE7' },
  ]

  /* ── B. Funnel data ────────────────────────────────────────── */

  const funnel = [
    { label: 'Submitted',  count: ec(c, 'service_request_submitted'), color: '#3B82F6' },
    { label: 'Matched',    count: ec(c, 'provider_matched'),          color: '#7C3AED' },
    { label: 'Accepted',   count: ec(c, 'provider_accepted'),         color: '#8B5CF6' },
    { label: 'Started',    count: ec(c, 'service_started'),           color: '#6366F1' },
    { label: 'Completed',  count: ec(c, 'service_completed'),         color: '#16A34A' },
    { label: 'Captured',   count: ec(c, 'payment_captured'),          color: '#059669' },
  ]
  const funnelMax = Math.max(1, ...funnel.map((f) => f.count))

  /* ── Render ────────────────────────────────────────────────── */

  return (
    <div style={st.shell}>
      {/* Header + filters */}
      <div style={st.panelHeader}>
        <h3 style={st.panelTitle}>Analytics</h3>
        <div style={st.filterRow}>
          <select
            style={st.filterSelect}
            value={serviceCategory ?? ''}
            onChange={(e) => setServiceCategory(e.target.value || null)}
          >
            <option value="">All categories</option>
            <option value="dog_walking">Dog Walking</option>
          </select>
          <select
            style={st.filterSelect}
            value={platform ?? ''}
            onChange={(e) => setPlatform(e.target.value || null)}
          >
            <option value="">All platforms</option>
            <option value="web">Web</option>
            <option value="ios">iOS</option>
            <option value="android">Android</option>
          </select>
          {error && <span style={st.staleBadge}>Stale</span>}
        </div>
      </div>

      {/* ── A: Summary cards ─────────────────────────────────── */}
      <SectionLabel>Event Summary</SectionLabel>
      <div style={st.cardGrid}>
        {cards.map((card) => (
          <div key={card.label} style={st.card}>
            <div style={{ ...st.cardDot, background: card.bg }}>
              <div style={{ width: 6, height: 6, borderRadius: 3, background: card.color }} />
            </div>
            <div style={{ fontSize: 22, fontWeight: 900, color: card.color, lineHeight: 1, letterSpacing: -0.5 }}>
              {card.value}
            </div>
            <div style={st.cardLabel}>{card.label}</div>
          </div>
        ))}
      </div>

      {/* ── B: Fulfillment funnel ────────────────────────────── */}
      <SectionLabel style={{ marginTop: 24 }}>Fulfillment Funnel</SectionLabel>
      <div style={st.funnelList}>
        {funnel.map((step, i) => {
          const pct = (step.count / funnelMax) * 100
          const prev = i > 0 ? funnel[i - 1].count : 0
          const conv = i > 0 && prev > 0 ? Math.round((step.count / prev) * 100) : null
          return (
            <div key={step.label} style={st.funnelRow}>
              <div style={st.funnelMeta}>
                <span style={{ fontWeight: 600, color: '#334155', fontSize: 13 }}>{step.label}</span>
                {conv !== null && <span style={st.convBadge}>{conv}%</span>}
              </div>
              <div style={st.barTrack}>
                <div
                  style={{
                    height: '100%',
                    borderRadius: 4,
                    background: step.color,
                    opacity: 0.75,
                    width: `${Math.max(pct, 3)}%`,
                    transition: 'width 0.3s ease',
                  }}
                />
              </div>
              <div style={st.funnelNum}>{step.count}</div>
            </div>
          )
        })}
      </div>

      {/* ── C: Response times ────────────────────────────────── */}
      <SectionLabel style={{ marginTop: 24 }}>Response Times</SectionLabel>
      <div style={st.timeRow}>
        <TimeCard label="Request → Match" value={fmtDur(tm.avg_request_to_match_sec)} />
        <TimeCard label="Match → Accept" value={fmtDur(tm.avg_match_to_accept_sec)} />
        <TimeCard label="Accept → Complete" value={fmtDur(tm.avg_accept_to_complete_sec)} />
      </div>
      {tm.sample_count > 0 && (
        <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 6, textAlign: 'right' as const }}>
          Based on {tm.sample_count} request{tm.sample_count !== 1 ? 's' : ''}
        </div>
      )}

      {/* ── D: Operational health ────────────────────────────── */}
      <SectionLabel style={{ marginTop: 24 }}>Operational Health</SectionLabel>
      <div style={st.healthRow}>
        <HealthPill label="Open Requests" value={op.open_requests} sev={op.open_requests > 10 ? 'warn' : 'ok'} />
        <HealthPill label="Providers Online" value={op.available_providers} sev={op.available_providers === 0 ? 'crit' : 'ok'} />
        <HealthPill label="Stuck Requests" value={op.stuck_requests} sev={op.stuck_requests > 0 ? 'crit' : 'ok'} />
        <HealthPill label="Failed Payments" value={op.failed_payments_recent} sev={op.failed_payments_recent > 0 ? 'warn' : 'ok'} />
        <HealthPill label="Failed Payouts" value={op.failed_payouts_recent} sev={op.failed_payouts_recent > 0 ? 'warn' : 'ok'} />
      </div>
    </div>
  )
}

/* ── Sub-components ─────────────────────────────────────────────── */

function SectionLabel({ children, style }: { children: string; style?: CSSProperties }) {
  return (
    <div style={{
      fontSize: 11,
      fontWeight: 700,
      color: '#94A3B8',
      textTransform: 'uppercase' as const,
      letterSpacing: 0.6,
      marginBottom: 10,
      ...style,
    }}>
      {children}
    </div>
  )
}

function TimeCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={st.timeCard}>
      <div style={{ fontSize: 20, fontWeight: 900, color: '#0F172A', lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#94A3B8', marginTop: 6 }}>{label}</div>
    </div>
  )
}

function HealthPill({ label, value, sev }: { label: string; value: number; sev: 'ok' | 'warn' | 'crit' }) {
  const palette = {
    ok:   { bg: '#F0FDF4', fg: '#16A34A', border: '#BBF7D0' },
    warn: { bg: '#FFFBEB', fg: '#D97706', border: '#FDE68A' },
    crit: { bg: '#FEF2F2', fg: '#DC2626', border: '#FECACA' },
  }[sev]
  return (
    <div style={{ ...st.healthPill, background: palette.bg, borderColor: palette.border }}>
      <span style={{ fontSize: 20, fontWeight: 900, color: palette.fg, lineHeight: 1 }}>{value}</span>
      <span style={{ fontSize: 10, fontWeight: 600, color: palette.fg, opacity: 0.85 }}>{label}</span>
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
  loading: {
    textAlign: 'center',
    color: '#94A3B8',
    fontSize: 13,
    padding: '20px 0',
  },
  errorBox: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 4,
    padding: '16px 0',
    textAlign: 'center',
  },

  /* Header */
  panelHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
    flexWrap: 'wrap',
    gap: 8,
  },
  panelTitle: {
    margin: 0,
    fontSize: 16,
    fontWeight: 800,
    color: '#0F172A',
    letterSpacing: -0.3,
  },
  filterRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
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
  staleBadge: {
    fontSize: 10,
    fontWeight: 700,
    color: '#D97706',
    background: '#FFFBEB',
    padding: '2px 8px',
    borderRadius: 6,
  },

  /* Summary cards */
  cardGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))',
    gap: 8,
  },
  card: {
    padding: '14px 10px',
    borderRadius: 12,
    background: '#FAFAFA',
    border: '1px solid #F1F5F9',
    textAlign: 'center',
  },
  cardDot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    display: 'grid',
    placeItems: 'center',
    margin: '0 auto 8px',
  },
  cardLabel: {
    fontSize: 10,
    fontWeight: 600,
    color: '#94A3B8',
    marginTop: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },

  /* Funnel */
  funnelList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  funnelRow: {
    display: 'grid',
    gridTemplateColumns: '120px 1fr 44px',
    alignItems: 'center',
    gap: 10,
  },
  funnelMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  convBadge: {
    fontSize: 10,
    fontWeight: 700,
    color: '#94A3B8',
    background: '#F1F5F9',
    padding: '1px 5px',
    borderRadius: 4,
  },
  barTrack: {
    height: 22,
    borderRadius: 4,
    background: '#F8FAFC',
    overflow: 'hidden',
  },
  funnelNum: {
    fontSize: 14,
    fontWeight: 800,
    color: '#0F172A',
    textAlign: 'right',
  },

  /* Time metrics */
  timeRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: 8,
  },
  timeCard: {
    padding: 14,
    borderRadius: 12,
    background: '#F8FAFC',
    border: '1px solid #F1F5F9',
    textAlign: 'center',
  },

  /* Health */
  healthRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))',
    gap: 8,
  },
  healthPill: {
    padding: '12px 10px',
    borderRadius: 12,
    border: '1px solid',
    textAlign: 'center',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 4,
  },
}
