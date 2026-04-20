import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import { supabase } from '../services/supabaseClient'

/* ── Types ──────────────────────────────────────────────────────── */

interface DailyRow {
  day: string
  total_users: number
  new_users: number
  returning_users: number
}

interface CohortRow {
  cohort_day: string
  cohort_size: number
  d1: number
  d3: number
  d7: number
}

interface RepeatMetrics {
  total_requestors: number
  repeat_requestors: number
  avg_requests: number
  max_requests: number
  power_users: number
}

interface RetentionData {
  daily: DailyRow[]
  cohorts: CohortRow[]
  repeat: RepeatMetrics
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
  return new Date(now.getTime() - 30 * 86400_000).toISOString()
}

function pct(n: number, d: number): number {
  return d > 0 ? Math.round((n / d) * 100) : 0
}

function fmtDay(iso: string): string {
  const d = new Date(iso + 'T00:00:00')
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
}

function retentionColor(p: number): string {
  if (p >= 40) return '#166534'
  if (p >= 20) return '#16A34A'
  if (p >= 10) return '#D97706'
  if (p > 0) return '#DC2626'
  return '#CBD5E1'
}

function retentionBg(p: number): string {
  if (p >= 40) return '#DCFCE7'
  if (p >= 20) return '#F0FDF4'
  if (p >= 10) return '#FFFBEB'
  if (p > 0) return '#FEF2F2'
  return '#F8FAFC'
}

/* ── Component ──────────────────────────────────────────────────── */

export default function AdminRetention({ timeRange }: Props) {
  const [data, setData] = useState<RetentionData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    const { data: rpc, error: err } = await supabase.rpc('admin_retention_cohorts', {
      p_since: toSince(timeRange),
    })
    if (err) { setError(err.message); setLoading(false); return }
    setData(rpc as unknown as RetentionData)
    setError(null)
    setLoading(false)
  }, [timeRange])

  useEffect(() => {
    setLoading(true)
    fetchData()
    const id = setInterval(fetchData, 60_000)
    return () => clearInterval(id)
  }, [fetchData])

  /* ── Loading / error ───────────────────────────────────── */

  if (loading && !data) {
    return (
      <div style={st.shell}>
        <div style={st.loadingText}>Loading retention data...</div>
      </div>
    )
  }

  if (error && !data) {
    return (
      <div style={st.shell}>
        <div style={st.headerRow}>
          <h3 style={st.title}>Retention &amp; Cohorts</h3>
          <span style={st.errorBadge}>Error</span>
        </div>
        <div style={{ fontSize: 12, color: '#94A3B8', textAlign: 'center' as const, padding: '8px 0' }}>{error}</div>
      </div>
    )
  }

  if (!data) return null

  const rep = data.repeat
  const repeatRate = pct(rep.repeat_requestors, rep.total_requestors)

  /* ── Daily chart data ──────────────────────────────────── */

  const dailyMax = Math.max(1, ...data.daily.map((d) => d.total_users))

  /* ── Render ────────────────────────────────────────────── */

  return (
    <div style={st.shell}>
      <div style={st.headerRow}>
        <h3 style={st.title}>Retention &amp; Cohorts</h3>
        {error && <span style={st.staleBadge}>Stale</span>}
      </div>

      {/* ── Repeat usage cards ──────────────────────────────── */}
      <SectionLabel>Repeat Usage</SectionLabel>
      <div style={st.repeatGrid}>
        <RepeatCard
          label="Repeat Rate"
          value={rep.total_requestors > 0 ? `${repeatRate}%` : '-'}
          sub={`${rep.repeat_requestors} of ${rep.total_requestors} users`}
          color={repeatRate >= 30 ? '#16A34A' : repeatRate >= 15 ? '#D97706' : '#DC2626'}
        />
        <RepeatCard
          label="Avg Requests / User"
          value={rep.total_requestors > 0 ? String(rep.avg_requests) : '-'}
          sub={`max ${rep.max_requests}`}
          color="#3B82F6"
        />
        <RepeatCard
          label="Power Users"
          value={String(rep.power_users)}
          sub="5+ requests"
          color="#7C3AED"
        />
      </div>

      {/* ── Daily new vs returning ──────────────────────────── */}
      {data.daily.length > 0 && (
        <>
          <SectionLabel style={{ marginTop: 24 }}>Daily Active Users</SectionLabel>
          <div style={st.dailyWrap}>
            {data.daily.slice(-14).map((d) => {
              const totalH = Math.max((d.total_users / dailyMax) * 100, d.total_users > 0 ? 8 : 0)
              const newH = d.total_users > 0 ? (d.new_users / d.total_users) * totalH : 0
              const retH = totalH - newH
              return (
                <div
                  key={d.day}
                  style={st.dailyCol}
                  title={`${fmtDay(d.day)}: ${d.new_users} new, ${d.returning_users} returning`}
                >
                  <div style={st.dailyBarTrack}>
                    {/* returning (bottom) */}
                    <div style={{
                      position: 'absolute' as const, bottom: 0, left: 0, right: 0,
                      height: `${retH}%`, background: '#3B82F6', borderRadius: '0 0 2px 2px',
                      opacity: 0.7, transition: 'height 0.3s',
                    }} />
                    {/* new (top) */}
                    <div style={{
                      position: 'absolute' as const, bottom: `${retH}%`, left: 0, right: 0,
                      height: `${newH}%`, background: '#16A34A', borderRadius: '2px 2px 0 0',
                      opacity: 0.7, transition: 'height 0.3s, bottom 0.3s',
                    }} />
                  </div>
                  <div style={st.dailyLabel}>{fmtDay(d.day).slice(0, 2)}</div>
                </div>
              )
            })}
          </div>
          <div style={st.dailyLegend}>
            <span><span style={{ ...st.legendDot, background: '#16A34A' }} /> New</span>
            <span><span style={{ ...st.legendDot, background: '#3B82F6' }} /> Returning</span>
          </div>
        </>
      )}

      {/* ── Cohort retention table ──────────────────────────── */}
      {data.cohorts.length > 0 && (
        <>
          <SectionLabel style={{ marginTop: 24 }}>Cohort Retention</SectionLabel>
          <div style={{ fontSize: 11, color: '#94A3B8', marginBottom: 8 }}>
            % of cohort that submitted a new service request on that day
          </div>
          <div style={st.tableWrap}>
            <table style={st.table}>
              <thead>
                <tr>
                  <th style={st.th}>Cohort</th>
                  <th style={st.th}>Size</th>
                  <th style={{ ...st.th, textAlign: 'center' as const }}>D1</th>
                  <th style={{ ...st.th, textAlign: 'center' as const }}>D3</th>
                  <th style={{ ...st.th, textAlign: 'center' as const }}>D7</th>
                </tr>
              </thead>
              <tbody>
                {data.cohorts.map((c) => {
                  const d1p = pct(c.d1, c.cohort_size)
                  const d3p = pct(c.d3, c.cohort_size)
                  const d7p = pct(c.d7, c.cohort_size)
                  return (
                    <tr key={c.cohort_day} style={st.row}>
                      <td style={st.td}>
                        <span style={{ fontWeight: 600, color: '#0F172A' }}>{fmtDay(c.cohort_day)}</span>
                      </td>
                      <td style={st.td}>
                        <span style={{ fontWeight: 700, color: '#334155' }}>{c.cohort_size}</span>
                      </td>
                      <td style={st.td}>
                        <RetentionCell count={c.d1} rate={d1p} />
                      </td>
                      <td style={st.td}>
                        <RetentionCell count={c.d3} rate={d3p} />
                      </td>
                      <td style={st.td}>
                        <RetentionCell count={c.d7} rate={d7p} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ── Empty state ─────────────────────────────────────── */}
      {data.daily.length === 0 && data.cohorts.length === 0 && (
        <div style={{ textAlign: 'center' as const, color: '#94A3B8', fontSize: 13, padding: '16px 0' }}>
          Not enough data yet — retention metrics will appear once users start submitting requests.
        </div>
      )}
    </div>
  )
}

/* ── Sub-components ─────────────────────────────────────────────── */

function SectionLabel({ children, style }: { children: string; style?: CSSProperties }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 700, color: '#94A3B8',
      textTransform: 'uppercase' as const, letterSpacing: 0.6, marginBottom: 10,
      ...style,
    }}>
      {children}
    </div>
  )
}

function RepeatCard({ label, value, sub, color }: {
  label: string; value: string; sub: string; color: string
}) {
  return (
    <div style={st.repeatCard}>
      <div style={{ fontSize: 28, fontWeight: 900, color, lineHeight: 1, letterSpacing: -0.5 }}>
        {value}
      </div>
      <div style={st.repeatLabel}>{label}</div>
      <div style={st.repeatSub}>{sub}</div>
    </div>
  )
}

function RetentionCell({ count, rate }: { count: number; rate: number }) {
  return (
    <div style={{
      textAlign: 'center' as const,
      padding: '4px 8px',
      borderRadius: 6,
      background: retentionBg(rate),
      minWidth: 48,
    }}>
      <div style={{ fontSize: 14, fontWeight: 800, color: retentionColor(rate), lineHeight: 1 }}>
        {rate > 0 ? `${rate}%` : '-'}
      </div>
      {count > 0 && (
        <div style={{ fontSize: 9, color: '#94A3B8', marginTop: 2 }}>{count} user{count !== 1 ? 's' : ''}</div>
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
    marginBottom: 16,
  },
  title: {
    margin: 0,
    fontSize: 16,
    fontWeight: 800,
    color: '#0F172A',
    letterSpacing: -0.3,
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

  /* Repeat cards */
  repeatGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
    gap: 10,
  },
  repeatCard: {
    padding: '16px 14px',
    borderRadius: 12,
    background: '#FAFAFA',
    border: '1px solid #F1F5F9',
    textAlign: 'center',
  },
  repeatLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: '#94A3B8',
    marginTop: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  repeatSub: {
    fontSize: 10,
    color: '#CBD5E1',
    marginTop: 2,
  },

  /* Daily bars */
  dailyWrap: {
    display: 'flex',
    gap: 3,
    alignItems: 'flex-end',
    height: 90,
    padding: '0 2px',
  },
  dailyCol: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 4,
    minWidth: 0,
  },
  dailyBarTrack: {
    width: '100%',
    height: 70,
    position: 'relative',
    borderRadius: 2,
    background: '#F8FAFC',
  },
  dailyLabel: {
    fontSize: 9,
    color: '#CBD5E1',
    fontWeight: 600,
    lineHeight: 1,
  },
  dailyLegend: {
    display: 'flex',
    gap: 14,
    marginTop: 8,
    fontSize: 10,
    color: '#94A3B8',
    fontWeight: 500,
  },
  legendDot: {
    display: 'inline-block',
    width: 8,
    height: 8,
    borderRadius: 2,
    marginRight: 4,
    verticalAlign: 'middle',
  },

  /* Cohort table */
  tableWrap: {
    overflowX: 'auto',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
  },
  th: {
    textAlign: 'left',
    padding: '6px 10px',
    borderBottom: '1px solid #E8ECF0',
    fontSize: 10,
    fontWeight: 700,
    color: '#94A3B8',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    whiteSpace: 'nowrap',
  },
  td: {
    padding: '6px 10px',
    borderBottom: '1px solid #F4F5F7',
    fontSize: 13,
    verticalAlign: 'middle',
  },
  row: {
    transition: 'background 0.1s',
  },
}
