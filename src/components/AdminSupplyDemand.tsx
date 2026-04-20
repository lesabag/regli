import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { supabase } from '../services/supabaseClient'

/* ── Types ──────────────────────────────────────────────────────── */

interface Rates {
  submitted: number
  matched: number
  accepted: number
  rejected: number
  started: number
  completed: number
  cancelled: number
  providers_online: number
  open_requests: number
}

interface HourlyRow {
  h: number
  submitted: number
  matched: number
  completed: number
  cancelled: number
}

interface BreakdownRow {
  category?: string
  platform?: string
  zone?: string
  submitted: number
  matched: number
  completed: number
  cancelled: number
}

interface SupplyDemandData {
  rates: Rates
  hourly: HourlyRow[]
  by_category: BreakdownRow[]
  by_platform: BreakdownRow[]
  by_zone: BreakdownRow[]
}

interface CoverageGap {
  type: 'hour' | 'category' | 'zone'
  label: string
  detail: string
  severity: 'warn' | 'crit'
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

function pct(num: number, den: number): number {
  if (den === 0) return 0
  return Math.round((num / den) * 100)
}

function pctStr(num: number, den: number): string {
  if (den === 0) return '-'
  return `${pct(num, den)}%`
}

function fmtHour(h: number): string {
  return `${h.toString().padStart(2, '0')}:00`
}

function categoryLabel(cat: string): string {
  return cat.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/* ── Component ──────────────────────────────────────────────────── */

export default function AdminSupplyDemand({ timeRange }: Props) {
  const [data, setData] = useState<SupplyDemandData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    const { data: rpc, error: err } = await supabase.rpc('admin_supply_demand', {
      p_since: toSince(timeRange),
    })
    if (err) { setError(err.message); setLoading(false); return }
    setData(rpc as unknown as SupplyDemandData)
    setError(null)
    setLoading(false)
  }, [timeRange])

  useEffect(() => {
    setLoading(true)
    fetchData()
    const id = setInterval(fetchData, 30_000)
    return () => clearInterval(id)
  }, [fetchData])

  /* ── Hourly: fill in all 24 hours ──────────────────────── */

  const hourly24 = useMemo(() => {
    if (!data) return []
    const map = new Map<number, HourlyRow>()
    data.hourly.forEach((r) => map.set(r.h, r))
    return Array.from({ length: 24 }, (_, i) =>
      map.get(i) || { h: i, submitted: 0, matched: 0, completed: 0, cancelled: 0 }
    )
  }, [data])

  const hourlyMax = useMemo(
    () => Math.max(1, ...hourly24.map((r) => r.submitted)),
    [hourly24]
  )

  /* ── Coverage gaps ─────────────────────────────────────── */

  const gaps = useMemo<CoverageGap[]>(() => {
    if (!data) return []
    const out: CoverageGap[] = []

    // Hours with demand but poor match rate
    hourly24.forEach((r) => {
      if (r.submitted >= 3 && r.matched === 0) {
        out.push({
          type: 'hour',
          label: fmtHour(r.h),
          detail: `${r.submitted} requests, 0 matched`,
          severity: 'crit',
        })
      } else if (r.submitted >= 3 && pct(r.matched, r.submitted) < 50) {
        out.push({
          type: 'hour',
          label: fmtHour(r.h),
          detail: `${r.submitted} requests, ${pctStr(r.matched, r.submitted)} match rate`,
          severity: 'warn',
        })
      }
    })

    // Categories with weak match rate
    data.by_category.forEach((r) => {
      if (r.submitted >= 2 && pct(r.matched, r.submitted) < 50) {
        out.push({
          type: 'category',
          label: categoryLabel(r.category || 'unknown'),
          detail: `${pctStr(r.matched, r.submitted)} match rate (${r.submitted} requests)`,
          severity: pct(r.matched, r.submitted) === 0 ? 'crit' : 'warn',
        })
      }
    })

    // Zones with high cancellation
    data.by_zone.forEach((r) => {
      if (r.submitted >= 2 && pct(r.cancelled, r.submitted) > 40) {
        out.push({
          type: 'zone',
          label: r.zone || 'Unknown zone',
          detail: `${pctStr(r.cancelled, r.submitted)} cancellation rate (${r.submitted} requests)`,
          severity: pct(r.cancelled, r.submitted) > 60 ? 'crit' : 'warn',
        })
      }
    })

    return out
  }, [data, hourly24])

  /* ── Loading / error / empty ───────────────────────────── */

  if (loading && !data) {
    return (
      <div style={st.shell}>
        <div style={st.loadingText}>Loading supply / demand data...</div>
      </div>
    )
  }

  if (error && !data) {
    return (
      <div style={st.shell}>
        <div style={st.headerRow}>
          <h3 style={st.title}>Supply / Demand</h3>
          <span style={st.errorBadge}>Error</span>
        </div>
        <div style={{ fontSize: 12, color: '#94A3B8', textAlign: 'center' as const, padding: '8px 0' }}>{error}</div>
      </div>
    )
  }

  if (!data) return null

  const r = data.rates

  /* ── Rate cards ────────────────────────────────────────── */

  const rateCards: { label: string; value: string; sub?: string; color: string; bg: string }[] = [
    { label: 'Requests',         value: String(r.submitted),                                                  color: '#3B82F6', bg: '#DBEAFE' },
    { label: 'Providers Online', value: String(r.providers_online),                                           color: '#7C3AED', bg: '#EDE9FE' },
    { label: 'Match Rate',       value: pctStr(r.matched, r.submitted),      sub: `${r.matched} matched`,    color: r.submitted > 0 && pct(r.matched, r.submitted) < 50 ? '#DC2626' : '#16A34A', bg: r.submitted > 0 && pct(r.matched, r.submitted) < 50 ? '#FEE2E2' : '#DCFCE7' },
    { label: 'Accept Rate',      value: pctStr(r.accepted, r.matched),       sub: `${r.accepted} accepted`,  color: '#8B5CF6', bg: '#EDE9FE' },
    { label: 'Completion Rate',  value: pctStr(r.completed, r.accepted),     sub: `${r.completed} done`,     color: '#059669', bg: '#D1FAE5' },
    { label: 'No-Match Rate',    value: pctStr(r.submitted - r.matched, r.submitted), sub: `${r.submitted - r.matched} unmatched`, color: '#D97706', bg: '#FFFBEB' },
    { label: 'Cancel Rate',      value: pctStr(r.cancelled, r.submitted),    sub: `${r.cancelled} cancelled`, color: '#DC2626', bg: '#FEE2E2' },
  ]

  /* ── Render ────────────────────────────────────────────── */

  return (
    <div style={st.shell}>
      <div style={st.headerRow}>
        <h3 style={st.title}>Supply / Demand Intelligence</h3>
        {error && <span style={st.staleBadge}>Stale</span>}
      </div>

      {/* ── Rate cards ──────────────────────────────────────── */}
      <SectionLabel>Marketplace Rates</SectionLabel>
      <div style={st.cardGrid}>
        {rateCards.map((c) => (
          <div key={c.label} style={st.rateCard}>
            <div style={{ ...st.rateDot, background: c.bg }}>
              <div style={{ width: 6, height: 6, borderRadius: 3, background: c.color }} />
            </div>
            <div style={{ fontSize: 22, fontWeight: 900, color: c.color, lineHeight: 1, letterSpacing: -0.5 }}>
              {c.value}
            </div>
            <div style={st.rateLabel}>{c.label}</div>
            {c.sub && <div style={st.rateSub}>{c.sub}</div>}
          </div>
        ))}
      </div>

      {/* ── Hourly demand ───────────────────────────────────── */}
      <SectionLabel style={{ marginTop: 24 }}>Demand by Hour</SectionLabel>
      <div style={st.hourlyWrap}>
        {hourly24.map((hr) => {
          const barH = hr.submitted > 0 ? Math.max((hr.submitted / hourlyMax) * 100, 6) : 0
          const matchRate = pct(hr.matched, hr.submitted)
          const barColor = hr.submitted === 0 ? '#E2E8F0'
            : matchRate >= 70 ? '#16A34A'
            : matchRate >= 40 ? '#D97706'
            : '#DC2626'
          return (
            <div key={hr.h} style={st.hourCol} title={`${fmtHour(hr.h)}: ${hr.submitted} req, ${hr.matched} matched, ${hr.completed} done`}>
              <div style={st.hourBarTrack}>
                <div style={{
                  position: 'absolute' as const,
                  bottom: 0,
                  left: 0,
                  right: 0,
                  height: `${barH}%`,
                  background: barColor,
                  borderRadius: 2,
                  opacity: 0.75,
                  transition: 'height 0.3s ease',
                }} />
              </div>
              <div style={st.hourLabel}>{hr.h}</div>
            </div>
          )
        })}
      </div>
      <div style={st.hourlyLegend}>
        <span><span style={{ ...st.legendDot, background: '#16A34A' }} /> Match &ge;70%</span>
        <span><span style={{ ...st.legendDot, background: '#D97706' }} /> Match 40-69%</span>
        <span><span style={{ ...st.legendDot, background: '#DC2626' }} /> Match &lt;40%</span>
        <span><span style={{ ...st.legendDot, background: '#E2E8F0' }} /> No requests</span>
      </div>

      {/* ── Category breakdown ──────────────────────────────── */}
      {data.by_category.length > 0 && (
        <>
          <SectionLabel style={{ marginTop: 24 }}>By Service Category</SectionLabel>
          <BreakdownTable
            rows={data.by_category}
            labelKey="category"
            labelFmt={categoryLabel}
          />
        </>
      )}

      {/* ── Platform breakdown ──────────────────────────────── */}
      {data.by_platform.length > 0 && (
        <>
          <SectionLabel style={{ marginTop: 24 }}>By Platform</SectionLabel>
          <BreakdownTable
            rows={data.by_platform}
            labelKey="platform"
            labelFmt={(s) => s.charAt(0).toUpperCase() + s.slice(1)}
          />
        </>
      )}

      {/* ── Zone breakdown ──────────────────────────────────── */}
      {data.by_zone.length > 0 && (
        <>
          <SectionLabel style={{ marginTop: 24 }}>By City / Zone</SectionLabel>
          <BreakdownTable
            rows={data.by_zone}
            labelKey="zone"
            labelFmt={categoryLabel}
          />
        </>
      )}

      {/* ── Coverage gaps ───────────────────────────────────── */}
      {gaps.length > 0 && (
        <>
          <SectionLabel style={{ marginTop: 24 }}>Coverage Gaps</SectionLabel>
          <div style={st.gapList}>
            {gaps.map((g, i) => (
              <div
                key={i}
                style={{
                  ...st.gapCard,
                  borderColor: g.severity === 'crit' ? '#FECACA' : '#FDE68A',
                  background: g.severity === 'crit' ? '#FEF2F2' : '#FFFBEB',
                }}
              >
                <div style={st.gapHeader}>
                  <span style={{
                    ...st.gapTypeBadge,
                    background: g.type === 'hour' ? '#DBEAFE' : g.type === 'category' ? '#EDE9FE' : '#FFF7ED',
                    color: g.type === 'hour' ? '#1D4ED8' : g.type === 'category' ? '#6D28D9' : '#C2410C',
                  }}>
                    {g.type}
                  </span>
                  <span style={{ fontWeight: 700, color: '#0F172A', fontSize: 14 }}>{g.label}</span>
                </div>
                <div style={{ fontSize: 12, color: '#64748B', marginTop: 4 }}>{g.detail}</div>
              </div>
            ))}
          </div>
        </>
      )}

      {gaps.length === 0 && r.submitted > 0 && (
        <>
          <SectionLabel style={{ marginTop: 24 }}>Coverage Gaps</SectionLabel>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0' }}>
            <span style={st.okBadge}>No gaps detected</span>
            <span style={{ fontSize: 12, color: '#94A3B8' }}>Match rates look healthy across all dimensions</span>
          </div>
        </>
      )}
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

function BreakdownTable({ rows, labelKey, labelFmt }: {
  rows: BreakdownRow[]
  labelKey: 'category' | 'platform' | 'zone'
  labelFmt: (s: string) => string
}) {
  return (
    <div style={st.tableWrap}>
      <table style={st.table}>
        <thead>
          <tr>
            <th style={st.th}>{labelKey === 'zone' ? 'City / Zone' : labelKey === 'category' ? 'Category' : 'Platform'}</th>
            <th style={st.th}>Requests</th>
            <th style={st.th}>Match %</th>
            <th style={st.th}>Complete %</th>
            <th style={st.th}>Cancel %</th>
            <th style={st.th}>Funnel</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const label = (row as unknown as Record<string, unknown>)[labelKey] as string || 'unknown'
            const matchPct = pct(row.matched, row.submitted)
            const cancelPct = pct(row.cancelled, row.submitted)
            return (
              <tr key={i} style={st.row}>
                <td style={st.td}>
                  <span style={{ fontWeight: 600, color: '#0F172A' }}>{labelFmt(label)}</span>
                </td>
                <td style={st.td}>{row.submitted}</td>
                <td style={st.td}>
                  <span style={{ color: matchPct >= 70 ? '#16A34A' : matchPct >= 40 ? '#D97706' : '#DC2626', fontWeight: 700 }}>
                    {pctStr(row.matched, row.submitted)}
                  </span>
                </td>
                <td style={st.td}>
                  <span style={{ color: '#059669', fontWeight: 600 }}>
                    {pctStr(row.completed, row.submitted)}
                  </span>
                </td>
                <td style={st.td}>
                  <span style={{ color: cancelPct > 30 ? '#DC2626' : '#94A3B8', fontWeight: 600 }}>
                    {pctStr(row.cancelled, row.submitted)}
                  </span>
                </td>
                <td style={st.td}>
                  <MiniBar values={[row.submitted, row.matched, row.completed]} />
                </td>
              </tr>
            )
          })}
          {rows.length === 0 && (
            <tr>
              <td style={{ ...st.td, textAlign: 'center', color: '#94A3B8', padding: 24 }} colSpan={6}>
                No data in this time range.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

/** Tiny inline funnel bar: submitted → matched → completed */
function MiniBar({ values }: { values: [number, number, number] }) {
  const max = Math.max(1, values[0])
  const colors = ['#93C5FD', '#8B5CF6', '#16A34A']
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, height: 14 }}>
      {values.map((v, i) => (
        <div
          key={i}
          style={{
            height: 10,
            width: Math.max(Math.round((v / max) * 48), v > 0 ? 4 : 0),
            background: colors[i],
            borderRadius: 2,
            opacity: 0.8,
          }}
        />
      ))}
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
  okBadge: {
    fontSize: 11,
    fontWeight: 700,
    color: '#166534',
    background: '#DCFCE7',
    padding: '3px 8px',
    borderRadius: 6,
  },

  /* Rate cards */
  cardGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
    gap: 8,
  },
  rateCard: {
    padding: '14px 10px',
    borderRadius: 12,
    background: '#FAFAFA',
    border: '1px solid #F1F5F9',
    textAlign: 'center',
  },
  rateDot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    display: 'grid',
    placeItems: 'center',
    margin: '0 auto 8px',
  },
  rateLabel: {
    fontSize: 10,
    fontWeight: 600,
    color: '#94A3B8',
    marginTop: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  rateSub: {
    fontSize: 10,
    color: '#CBD5E1',
    marginTop: 2,
  },

  /* Hourly */
  hourlyWrap: {
    display: 'flex',
    gap: 2,
    alignItems: 'flex-end',
    height: 100,
    padding: '0 2px',
  },
  hourCol: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 4,
    minWidth: 0,
  },
  hourBarTrack: {
    width: '100%',
    height: 80,
    position: 'relative',
    borderRadius: 2,
    background: '#F8FAFC',
  },
  hourLabel: {
    fontSize: 9,
    color: '#CBD5E1',
    fontWeight: 600,
    lineHeight: 1,
  },
  hourlyLegend: {
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

  /* Breakdown table */
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
    padding: '8px 10px',
    borderBottom: '1px solid #F4F5F7',
    fontSize: 13,
    verticalAlign: 'middle',
  },
  row: {
    transition: 'background 0.1s',
  },

  /* Coverage gaps */
  gapList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  gapCard: {
    padding: '10px 14px',
    borderRadius: 10,
    border: '1px solid',
  },
  gapHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  gapTypeBadge: {
    display: 'inline-block',
    padding: '2px 7px',
    borderRadius: 6,
    fontSize: 10,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
}
