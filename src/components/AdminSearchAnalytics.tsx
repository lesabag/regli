import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { supabase } from '../services/supabaseClient'

type TimeRange = 'today' | 'week' | 'all'

type Summary = {
  searches_started: number
  successful_matches: number
  searches_exhausted: number
  client_cancelled_while_searching: number
  match_conversion_rate: number
  exhaustion_rate: number
  avg_time_to_match_sec: number | null
  sample_matched_count: number
}

type ServiceBreakdown = {
  service_type: string
  searches_started: number
  successful_matches: number
  searches_exhausted: number
  client_cancelled_while_searching: number
  match_conversion_rate: number
  exhaustion_rate: number
  avg_time_to_match_sec: number | null
}

type FailureReason = {
  reason: string
  total: number
}

type SearchAnalyticsResponse = {
  summary: Summary
  by_service_type: ServiceBreakdown[]
  failure_reasons: FailureReason[]
}

interface Props {
  timeRange: TimeRange
}

function toSince(range: TimeRange): string {
  const now = new Date()
  if (range === 'today') {
    const d = new Date(now)
    d.setHours(0, 0, 0, 0)
    return d.toISOString()
  }
  if (range === 'week') {
    const d = new Date(now)
    d.setDate(d.getDate() - 7)
    d.setHours(0, 0, 0, 0)
    return d.toISOString()
  }
  return '2020-01-01T00:00:00Z'
}

function fmtInt(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '0'
  return Math.round(value).toLocaleString()
}

function fmtPct(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '0%'
  return `${Number(value).toFixed(1)}%`
}

function fmtDuration(value: number | null | undefined): string {
  if (value == null || value <= 0 || Number.isNaN(value)) return '-'
  if (value < 60) return `${Math.round(value)}s`
  if (value < 3600) return `${Math.round(value / 60)}m`
  const hours = Math.floor(value / 3600)
  const minutes = Math.round((value % 3600) / 60)
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
}

function serviceLabel(value: string): string {
  if (value === 'dog_walker') return 'Dog walking'
  if (value === 'baby_sitter') return 'Babysitting'
  return value === 'unknown' ? 'Unknown' : value.replace(/_/g, ' ')
}

export default function AdminSearchAnalytics({ timeRange }: Props) {
  const [data, setData] = useState<SearchAnalyticsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchAnalytics = useCallback(async () => {
    const { data: rpc, error: err } = await supabase.rpc('admin_search_analytics', {
      p_since: toSince(timeRange),
    })

    if (err) {
      setError(err.message)
      setLoading(false)
      return
    }

    setData(rpc as SearchAnalyticsResponse)
    setError(null)
    setLoading(false)
  }, [timeRange])

  useEffect(() => {
    setLoading(true)
    void fetchAnalytics()
    const id = window.setInterval(() => {
      void fetchAnalytics()
    }, 30_000)
    return () => window.clearInterval(id)
  }, [fetchAnalytics])

  const cards = useMemo(() => {
    const summary = data?.summary
    if (!summary) return []

    return [
      {
        label: 'Searches started',
        value: fmtInt(summary.searches_started),
        sub: 'Requests that actually entered matching',
        tone: '#2563EB',
        bg: '#DBEAFE',
      },
      {
        label: 'Matched successfully',
        value: fmtInt(summary.successful_matches),
        sub: 'Assigned or accepted by a provider',
        tone: '#16A34A',
        bg: '#DCFCE7',
      },
      {
        label: 'Exhausted / no provider found',
        value: fmtInt(summary.searches_exhausted),
        sub: 'Searches that ended with no supply',
        tone: '#EA580C',
        bg: '#FFEDD5',
      },
      {
        label: 'Cancelled while searching',
        value: fmtInt(summary.client_cancelled_while_searching),
        sub: 'Client cancelled before match',
        tone: '#7C3AED',
        bg: '#EDE9FE',
      },
      {
        label: 'Match conversion %',
        value: fmtPct(summary.match_conversion_rate),
        sub: 'Successful matches / searches started',
        tone: '#0F766E',
        bg: '#CCFBF1',
      },
      {
        label: 'Avg time to match',
        value: fmtDuration(summary.avg_time_to_match_sec),
        sub:
          summary.sample_matched_count > 0
            ? `Based on ${fmtInt(summary.sample_matched_count)} matched searches`
            : 'No matched sample in this range',
        tone: '#1D4ED8',
        bg: '#DBEAFE',
      },
    ]
  }, [data])

  if (loading && !data) {
    return (
      <div style={shellStyle}>
        <div style={loadingStyle}>Loading search analytics...</div>
      </div>
    )
  }

  if (error && !data) {
    return (
      <div style={shellStyle}>
        <div style={errorBoxStyle}>
          <div style={errorTitleStyle}>Search analytics unavailable</div>
          <div style={errorTextStyle}>{error}</div>
        </div>
      </div>
    )
  }

  if (!data) return null

  return (
    <div style={shellStyle}>
      <div style={headerRowStyle}>
        <div>
          <h3 style={titleStyle}>Search Analytics</h3>
          <div style={subtitleStyle}>Matching funnel, exhaustion, and search outcomes</div>
        </div>
        {error ? <span style={staleBadgeStyle}>Stale</span> : null}
      </div>

      <div style={cardGridStyle}>
        {cards.map((card) => (
          <div key={card.label} style={cardStyle}>
            <div style={{ ...dotWrapStyle, background: card.bg }}>
              <div style={{ ...dotStyle, background: card.tone }} />
            </div>
            <div style={{ ...cardValueStyle, color: card.tone }}>{card.value}</div>
            <div style={cardLabelStyle}>{card.label}</div>
            <div style={cardSubStyle}>{card.sub}</div>
          </div>
        ))}
      </div>

      <div style={splitGridStyle}>
        <div style={panelStyle}>
          <div style={sectionLabelStyle}>Matching Funnel</div>
          <div style={funnelListStyle}>
            <FunnelRow
              label="Started"
              value={data.summary.searches_started}
              max={Math.max(1, data.summary.searches_started)}
              color="#2563EB"
            />
            <FunnelRow
              label="Matched"
              value={data.summary.successful_matches}
              max={Math.max(1, data.summary.searches_started)}
              color="#16A34A"
              badge={fmtPct(data.summary.match_conversion_rate)}
            />
            <FunnelRow
              label="Exhausted"
              value={data.summary.searches_exhausted}
              max={Math.max(1, data.summary.searches_started)}
              color="#EA580C"
              badge={fmtPct(data.summary.exhaustion_rate)}
            />
            <FunnelRow
              label="Cancelled"
              value={data.summary.client_cancelled_while_searching}
              max={Math.max(1, data.summary.searches_started)}
              color="#7C3AED"
            />
          </div>
        </div>

        <div style={panelStyle}>
          <div style={sectionLabelStyle}>Top Failure Reasons</div>
          {data.failure_reasons.length === 0 ? (
            <div style={emptyTextStyle}>No exhaustion reasons in this range.</div>
          ) : (
            <div style={reasonListStyle}>
              {data.failure_reasons.map((reason) => (
                <div key={reason.reason} style={reasonRowStyle}>
                  <div style={reasonLabelStyle}>{reason.reason}</div>
                  <div style={reasonCountStyle}>{fmtInt(reason.total)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div style={panelStyle}>
        <div style={sectionLabelStyle}>By Service Type</div>
        <div style={tableWrapStyle}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Service</th>
                <th style={thStyle}>Started</th>
                <th style={thStyle}>Matched</th>
                <th style={thStyle}>Exhausted</th>
                <th style={thStyle}>Cancelled</th>
                <th style={thStyle}>Conversion</th>
                <th style={thStyle}>Avg match</th>
              </tr>
            </thead>
            <tbody>
              {data.by_service_type.length === 0 ? (
                <tr>
                  <td colSpan={7} style={emptyCellStyle}>No search data in this range.</td>
                </tr>
              ) : (
                data.by_service_type.map((row) => (
                  <tr key={row.service_type}>
                    <td style={tdPrimaryStyle}>{serviceLabel(row.service_type)}</td>
                    <td style={tdStyle}>{fmtInt(row.searches_started)}</td>
                    <td style={tdStyle}>{fmtInt(row.successful_matches)}</td>
                    <td style={tdStyle}>{fmtInt(row.searches_exhausted)}</td>
                    <td style={tdStyle}>{fmtInt(row.client_cancelled_while_searching)}</td>
                    <td style={tdStyle}>{fmtPct(row.match_conversion_rate)}</td>
                    <td style={tdStyle}>{fmtDuration(row.avg_time_to_match_sec)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function FunnelRow({
  label,
  value,
  max,
  color,
  badge,
}: {
  label: string
  value: number
  max: number
  color: string
  badge?: string
}) {
  const pct = max > 0 ? Math.max(4, (value / max) * 100) : 4
  return (
    <div style={funnelRowStyle}>
      <div style={funnelMetaStyle}>
        <span style={funnelLabelStyle}>{label}</span>
        {badge ? <span style={funnelBadgeStyle}>{badge}</span> : null}
      </div>
      <div style={funnelTrackStyle}>
        <div style={{ ...funnelBarStyle, width: `${pct}%`, background: color }} />
      </div>
      <div style={funnelValueStyle}>{fmtInt(value)}</div>
    </div>
  )
}

const shellStyle: CSSProperties = {
  background: '#FFFFFF',
  border: '1px solid #E2E8F0',
  borderRadius: 18,
  padding: 18,
  boxShadow: '0 8px 24px rgba(15, 23, 42, 0.04)',
  display: 'grid',
  gap: 18,
}

const headerRowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  gap: 12,
  flexWrap: 'wrap',
}

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 18,
  fontWeight: 800,
  color: '#0F172A',
}

const subtitleStyle: CSSProperties = {
  marginTop: 4,
  fontSize: 13,
  color: '#64748B',
}

const staleBadgeStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '6px 10px',
  borderRadius: 999,
  background: '#FEF3C7',
  color: '#92400E',
  fontSize: 11,
  fontWeight: 700,
}

const cardGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
  gap: 12,
}

const cardStyle: CSSProperties = {
  border: '1px solid #E2E8F0',
  borderRadius: 16,
  padding: 14,
  display: 'grid',
  gap: 8,
  background: '#FFFFFF',
}

const dotWrapStyle: CSSProperties = {
  width: 26,
  height: 26,
  borderRadius: 999,
  display: 'grid',
  placeItems: 'center',
}

const dotStyle: CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: 999,
}

const cardValueStyle: CSSProperties = {
  fontSize: 24,
  fontWeight: 900,
  lineHeight: 1,
  letterSpacing: -0.5,
}

const cardLabelStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: '#0F172A',
}

const cardSubStyle: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.5,
  color: '#64748B',
}

const splitGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
  gap: 12,
}

const panelStyle: CSSProperties = {
  border: '1px solid #E2E8F0',
  borderRadius: 16,
  padding: 14,
  display: 'grid',
  gap: 12,
}

const sectionLabelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: '#94A3B8',
  textTransform: 'uppercase',
  letterSpacing: 0.6,
}

const funnelListStyle: CSSProperties = {
  display: 'grid',
  gap: 10,
}

const funnelRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '100px 1fr 56px',
  gap: 10,
  alignItems: 'center',
}

const funnelMetaStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
}

const funnelLabelStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: '#334155',
}

const funnelBadgeStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  width: 'fit-content',
  padding: '2px 8px',
  borderRadius: 999,
  background: '#F1F5F9',
  color: '#475569',
  fontSize: 10,
  fontWeight: 700,
}

const funnelTrackStyle: CSSProperties = {
  height: 10,
  borderRadius: 999,
  background: '#E2E8F0',
  overflow: 'hidden',
}

const funnelBarStyle: CSSProperties = {
  height: '100%',
  borderRadius: 999,
  transition: 'width 0.25s ease',
}

const funnelValueStyle: CSSProperties = {
  textAlign: 'right',
  fontSize: 13,
  fontWeight: 800,
  color: '#0F172A',
}

const reasonListStyle: CSSProperties = {
  display: 'grid',
  gap: 10,
}

const reasonRowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 10,
  paddingBottom: 10,
  borderBottom: '1px solid #F1F5F9',
}

const reasonLabelStyle: CSSProperties = {
  fontSize: 13,
  lineHeight: 1.45,
  color: '#334155',
}

const reasonCountStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 800,
  color: '#0F172A',
  whiteSpace: 'nowrap',
}

const emptyTextStyle: CSSProperties = {
  fontSize: 13,
  color: '#94A3B8',
}

const tableWrapStyle: CSSProperties = {
  overflowX: 'auto',
}

const tableStyle: CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  minWidth: 680,
}

const thStyle: CSSProperties = {
  textAlign: 'left',
  padding: '0 0 10px',
  fontSize: 11,
  fontWeight: 800,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: '#94A3B8',
  borderBottom: '1px solid #E2E8F0',
}

const tdStyle: CSSProperties = {
  padding: '12px 0',
  fontSize: 13,
  color: '#334155',
  borderBottom: '1px solid #F8FAFC',
}

const tdPrimaryStyle: CSSProperties = {
  ...tdStyle,
  fontWeight: 700,
  color: '#0F172A',
}

const emptyCellStyle: CSSProperties = {
  padding: '16px 0',
  fontSize: 13,
  color: '#94A3B8',
  textAlign: 'center',
}

const loadingStyle: CSSProperties = {
  fontSize: 14,
  color: '#64748B',
}

const errorBoxStyle: CSSProperties = {
  border: '1px solid #FECACA',
  background: '#FEF2F2',
  borderRadius: 14,
  padding: 14,
  display: 'grid',
  gap: 6,
}

const errorTitleStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 800,
  color: '#991B1B',
}

const errorTextStyle: CSSProperties = {
  fontSize: 12,
  color: '#B91C1C',
}
