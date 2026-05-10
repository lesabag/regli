import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { supabase } from '../services/supabaseClient'
import { resolveJobFinancials, logPayoutSummary, type JobFinancials } from '../lib/payoutTruth'

type TimeRange = 'today' | 'week' | 'all'

interface JobRow {
  id: string
  dog_name: string | null
  status: string
  payment_status: string | null
  price: number | null
  platform_fee: number | null
  walker_earnings: number | null
  walker_amount: number | null
  duration_minutes: number | null
  service_type: string | null
  created_at: string | null
  paid_at: string | null
  walker_id: string | null
}

interface FinanceSummary {
  totalRevenue: number
  totalPlatformFees: number
  totalProviderEarnings: number
  jobCount: number
  paidCount: number
  authorizedCount: number
  failedCount: number
  storedCount: number
  estimatedCount: number
  inconsistentCount: number
}

interface ServiceBreakdown {
  serviceType: string
  jobCount: number
  totalRevenue: number
  totalPlatformFees: number
  totalProviderEarnings: number
  inconsistentCount: number
}

const TOLERANCE = 0.02

function isInconsistentRow(job: JobRow): boolean {
  if (job.price == null || job.price === 0) return false
  if (job.platform_fee == null && job.walker_earnings == null) return false

  const price = job.price

  if (job.platform_fee != null && job.walker_earnings != null) {
    const sumParts = job.platform_fee + job.walker_earnings
    if (Math.abs(sumParts - price) > price * TOLERANCE + 0.01) return true
  }

  if (job.platform_fee != null) {
    const expectedFee = Math.round(price * 0.20 * 100) / 100
    if (Math.abs(job.platform_fee - expectedFee) > price * TOLERANCE + 0.01) return true
  }

  if (job.walker_earnings != null) {
    const expectedEarnings = Math.round(price * 0.80 * 100) / 100
    if (Math.abs(job.walker_earnings - expectedEarnings) > price * TOLERANCE + 0.01) return true
  }

  return false
}

function getTimeRangeFilter(range: TimeRange): string | null {
  if (range === 'all') return null
  const now = new Date()
  if (range === 'today') {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    return start.toISOString()
  }
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  return weekAgo.toISOString()
}

function formatCurrency(amount: number): string {
  return `₪${Number.isInteger(amount) ? amount : amount.toFixed(2)}`
}

function formatServiceType(value: string | null): string {
  if (!value) return 'Unknown'
  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function paymentStatusBadge(status: string | null): { label: string; bg: string; color: string } {
  if (status === 'paid') return { label: 'Paid', bg: '#DCFCE7', color: '#166534' }
  if (status === 'authorized') return { label: 'Authorized', bg: '#DBEAFE', color: '#1E40AF' }
  if (status === 'failed' || status === 'refunded') return { label: status === 'failed' ? 'Failed' : 'Refunded', bg: '#FEE2E2', color: '#991B1B' }
  return { label: status ?? 'Unknown', bg: '#F1F5F9', color: '#64748B' }
}

export default function AdminFinance({ timeRange }: { timeRange: TimeRange }) {
  const [jobs, setJobs] = useState<JobRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchJobs = useCallback(async () => {
    const since = getTimeRangeFilter(timeRange)
    let query = supabase
      .from('walk_requests')
      .select('id, dog_name, status, payment_status, price, platform_fee, walker_earnings, walker_amount, duration_minutes, service_type, created_at, paid_at, walker_id')
      .in('status', ['completed', 'accepted', 'open'])
      .order('created_at', { ascending: false })
      .limit(200)

    if (since) {
      query = query.gte('created_at', since)
    }

    const { data, error: err } = await query
    if (err) {
      setError(err.message)
      setLoading(false)
      return
    }

    const rows = (data ?? []) as JobRow[]
    setJobs(rows)
    setError(null)
    setLoading(false)

    logPayoutSummary(`AdminFinance [${timeRange}]`, rows.filter((j) => j.status === 'completed'))
  }, [timeRange])

  useEffect(() => {
    setLoading(true)
    fetchJobs()
    const id = setInterval(fetchJobs, 30_000)
    return () => clearInterval(id)
  }, [fetchJobs])

  const summary = useMemo<FinanceSummary>(() => {
    let totalRevenue = 0
    let totalPlatformFees = 0
    let totalProviderEarnings = 0
    let paidCount = 0
    let authorizedCount = 0
    let failedCount = 0
    let storedCount = 0
    let estimatedCount = 0
    let inconsistentCount = 0

    for (const job of jobs) {
      const fin = resolveJobFinancials(job)
      totalRevenue += fin.customerPaidAmount
      totalPlatformFees += fin.platformFeeAmount
      totalProviderEarnings += fin.providerEarningsAmount

      if (job.payment_status === 'paid') paidCount++
      else if (job.payment_status === 'authorized') authorizedCount++
      else if (job.payment_status === 'failed' || job.payment_status === 'refunded') failedCount++

      if (fin.source === 'stored') storedCount++
      else estimatedCount++

      if (isInconsistentRow(job)) inconsistentCount++
    }

    return {
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      totalPlatformFees: Math.round(totalPlatformFees * 100) / 100,
      totalProviderEarnings: Math.round(totalProviderEarnings * 100) / 100,
      jobCount: jobs.length,
      paidCount,
      authorizedCount,
      failedCount,
      storedCount,
      estimatedCount,
      inconsistentCount,
    }
  }, [jobs])

  const serviceBreakdowns = useMemo<ServiceBreakdown[]>(() => {
    const map = new Map<string, ServiceBreakdown>()

    for (const job of jobs) {
      const key = job.service_type ?? '_unknown'
      let entry = map.get(key)
      if (!entry) {
        entry = {
          serviceType: key,
          jobCount: 0,
          totalRevenue: 0,
          totalPlatformFees: 0,
          totalProviderEarnings: 0,
          inconsistentCount: 0,
        }
        map.set(key, entry)
      }

      const fin = resolveJobFinancials(job)
      entry.jobCount++
      entry.totalRevenue += fin.customerPaidAmount
      entry.totalPlatformFees += fin.platformFeeAmount
      entry.totalProviderEarnings += fin.providerEarningsAmount
      if (isInconsistentRow(job)) entry.inconsistentCount++
    }

    return [...map.values()]
      .map((e) => ({
        ...e,
        totalRevenue: Math.round(e.totalRevenue * 100) / 100,
        totalPlatformFees: Math.round(e.totalPlatformFees * 100) / 100,
        totalProviderEarnings: Math.round(e.totalProviderEarnings * 100) / 100,
      }))
      .sort((a, b) => b.totalRevenue - a.totalRevenue)
  }, [jobs])

  const completedJobs = useMemo(() => jobs.filter((j) => j.status === 'completed'), [jobs])

  if (loading && jobs.length === 0) {
    return (
      <div style={st.shell}>
        <div style={st.loadingText}>Loading financial data...</div>
      </div>
    )
  }

  if (error && jobs.length === 0) {
    return (
      <div style={st.shell}>
        <div style={st.headerRow}>
          <h3 style={st.title}>Finance</h3>
          <span style={st.errorBadge}>Error</span>
        </div>
        <div style={{ fontSize: 12, color: '#94A3B8', textAlign: 'center' as const, padding: '8px 0' }}>{error}</div>
      </div>
    )
  }

  return (
    <>
      {/* Summary cards */}
      <div style={st.shell}>
        <div style={st.headerRow}>
          <h3 style={st.title}>Revenue Overview</h3>
          <span style={st.rangeBadge}>{timeRange === 'today' ? 'Today' : timeRange === 'week' ? 'This week' : 'All time'}</span>
          {error && <span style={st.staleBadge}>Stale</span>}
        </div>

        <div style={st.kpiGrid}>
          <KpiCard label="Total Revenue" value={formatCurrency(summary.totalRevenue)} color="#0F172A" />
          <KpiCard label="Platform Fees (20%)" value={formatCurrency(summary.totalPlatformFees)} color="#7C3AED" />
          <KpiCard label="Provider Earnings (80%)" value={formatCurrency(summary.totalProviderEarnings)} color="#059669" />
          <KpiCard label="Jobs" value={String(summary.jobCount)} color="#334155" />
        </div>

        <div style={st.statusRow}>
          <StatusPill label="Paid" count={summary.paidCount} bg="#DCFCE7" color="#166534" />
          <StatusPill label="Authorized" count={summary.authorizedCount} bg="#DBEAFE" color="#1E40AF" />
          <StatusPill label="Failed" count={summary.failedCount} bg="#FEE2E2" color="#991B1B" />
          <StatusPill label="Stored" count={summary.storedCount} bg="#F0FDF4" color="#166534" />
          {summary.inconsistentCount > 0 && (
            <StatusPill label="Legacy" count={summary.inconsistentCount} bg="#FEF3C7" color="#92400E" />
          )}
        </div>

        {summary.estimatedCount > 0 && (
          <div style={st.warningBar}>
            {summary.estimatedCount} job{summary.estimatedCount !== 1 ? 's' : ''} using estimated earnings (no stored walker_earnings).
            {' '}{summary.storedCount} with stored values.
          </div>
        )}

        {summary.inconsistentCount > 0 && (
          <div style={st.legacyBar}>
            {summary.inconsistentCount} row{summary.inconsistentCount !== 1 ? 's' : ''} with
            inconsistent financials (fee + earnings does not match price, or split is not 20/80).
            These are legacy rows from before the payout truth fix.
          </div>
        )}
      </div>

      {/* Service type breakdown */}
      {serviceBreakdowns.length > 0 && (
        <div style={st.shell}>
          <div style={st.headerRow}>
            <h3 style={st.title}>Revenue by Service Type</h3>
            <span style={st.countBadge}>{serviceBreakdowns.length} type{serviceBreakdowns.length !== 1 ? 's' : ''}</span>
          </div>

          <div style={st.tableWrap}>
            <table style={st.table}>
              <thead>
                <tr>
                  <th style={st.th}>Service Type</th>
                  <th style={{ ...st.th, textAlign: 'right' }}>Jobs</th>
                  <th style={{ ...st.th, textAlign: 'right' }}>Customer Paid</th>
                  <th style={{ ...st.th, textAlign: 'right' }}>Platform Fees</th>
                  <th style={{ ...st.th, textAlign: 'right' }}>Provider Earnings</th>
                  <th style={{ ...st.th, textAlign: 'right' }}>Avg Order</th>
                  <th style={{ ...st.th, textAlign: 'right' }}>Legacy</th>
                </tr>
              </thead>
              <tbody>
                {serviceBreakdowns.map((b) => (
                  <tr key={b.serviceType} style={st.tr}>
                    <td style={{ ...st.td, fontWeight: 700 }}>{formatServiceType(b.serviceType === '_unknown' ? null : b.serviceType)}</td>
                    <td style={{ ...st.td, textAlign: 'right' }}>{b.jobCount}</td>
                    <td style={{ ...st.td, textAlign: 'right', fontWeight: 700 }}>{formatCurrency(b.totalRevenue)}</td>
                    <td style={{ ...st.td, textAlign: 'right', color: '#7C3AED' }}>{formatCurrency(b.totalPlatformFees)}</td>
                    <td style={{ ...st.td, textAlign: 'right', color: '#059669', fontWeight: 700 }}>{formatCurrency(b.totalProviderEarnings)}</td>
                    <td style={{ ...st.td, textAlign: 'right', color: '#64748B' }}>
                      {b.jobCount > 0 ? formatCurrency(Math.round(b.totalRevenue / b.jobCount * 100) / 100) : '-'}
                    </td>
                    <td style={{ ...st.td, textAlign: 'right' }}>
                      {b.inconsistentCount > 0 ? (
                        <span style={st.legacyBadgeInline}>{b.inconsistentCount}</span>
                      ) : (
                        <span style={st.cleanBadgeInline}>0</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Completed jobs table */}
      <div style={st.shell}>
        <div style={st.headerRow}>
          <h3 style={st.title}>Completed Jobs</h3>
          <span style={st.countBadge}>{completedJobs.length}</span>
        </div>

        {completedJobs.length === 0 ? (
          <div style={st.emptyText}>No completed jobs in this period</div>
        ) : (
          <div style={st.tableWrap}>
            <table style={st.table}>
              <thead>
                <tr>
                  <th style={st.th}>Service</th>
                  <th style={st.th}>Duration</th>
                  <th style={{ ...st.th, textAlign: 'right' }}>Price</th>
                  <th style={{ ...st.th, textAlign: 'right' }}>Platform Fee</th>
                  <th style={{ ...st.th, textAlign: 'right' }}>Provider Earnings</th>
                  <th style={st.th}>Source</th>
                  <th style={st.th}>Payment</th>
                  <th style={st.th}>Integrity</th>
                  <th style={st.th}>Date</th>
                </tr>
              </thead>
              <tbody>
                {completedJobs.map((job) => {
                  const fin = resolveJobFinancials(job)
                  const inconsistent = isInconsistentRow(job)
                  return <JobFinanceRow key={job.id} job={job} fin={fin} inconsistent={inconsistent} />
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}

function JobFinanceRow({ job, fin, inconsistent }: { job: JobRow; fin: JobFinancials; inconsistent: boolean }) {
  const badge = paymentStatusBadge(job.payment_status)
  const dateStr = job.paid_at ?? job.created_at
  const date = dateStr ? new Date(dateStr) : null

  const rowStyle: CSSProperties = inconsistent
    ? { ...st.tr, background: '#FFFBEB' }
    : st.tr

  return (
    <tr style={rowStyle}>
      <td style={st.td}>{job.dog_name || '-'}</td>
      <td style={st.td}>{job.duration_minutes != null ? `${job.duration_minutes} min` : '-'}</td>
      <td style={{ ...st.td, textAlign: 'right', fontWeight: 700 }}>{formatCurrency(fin.customerPaidAmount)}</td>
      <td style={{ ...st.td, textAlign: 'right', color: '#7C3AED' }}>
        {formatCurrency(fin.platformFeeAmount)}
        {inconsistent && job.platform_fee != null && (
          <span style={st.rawValue}> (raw: {formatCurrency(job.platform_fee)})</span>
        )}
      </td>
      <td style={{ ...st.td, textAlign: 'right', color: '#059669', fontWeight: 700 }}>
        {formatCurrency(fin.providerEarningsAmount)}
        {inconsistent && job.walker_earnings != null && (
          <span style={st.rawValue}> (raw: {formatCurrency(job.walker_earnings)})</span>
        )}
      </td>
      <td style={st.td}>
        <span style={{
          fontSize: 10,
          fontWeight: 600,
          padding: '2px 6px',
          borderRadius: 4,
          background: fin.source === 'stored' ? '#DCFCE7' : '#FEF3C7',
          color: fin.source === 'stored' ? '#166534' : '#92400E',
        }}>
          {fin.source}
        </span>
      </td>
      <td style={st.td}>
        <span style={{
          fontSize: 10,
          fontWeight: 600,
          padding: '2px 6px',
          borderRadius: 4,
          background: badge.bg,
          color: badge.color,
        }}>
          {badge.label}
        </span>
      </td>
      <td style={st.td}>
        {inconsistent ? (
          <span style={st.legacyBadge}>Legacy</span>
        ) : (
          <span style={st.cleanBadge}>OK</span>
        )}
      </td>
      <td style={{ ...st.td, fontSize: 11, color: '#64748B' }}>
        {date ? `${date.getDate()}/${date.getMonth() + 1} ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}` : '-'}
      </td>
    </tr>
  )
}

function KpiCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={st.kpiCard}>
      <span style={{ fontSize: 10, fontWeight: 600, color: '#94A3B8', textTransform: 'uppercase' as const, letterSpacing: 0.4 }}>
        {label}
      </span>
      <span style={{ fontSize: 22, fontWeight: 900, color, lineHeight: 1.1 }}>
        {value}
      </span>
    </div>
  )
}

function StatusPill({ label, count, bg, color }: { label: string; count: number; bg: string; color: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 8, background: bg }}>
      <span style={{ fontSize: 14, fontWeight: 800, color }}>{count}</span>
      <span style={{ fontSize: 11, fontWeight: 600, color }}>{label}</span>
    </div>
  )
}

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
  rangeBadge: {
    fontSize: 10,
    fontWeight: 700,
    color: '#1E40AF',
    background: '#DBEAFE',
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
  countBadge: {
    fontSize: 10,
    fontWeight: 700,
    color: '#334155',
    background: '#F1F5F9',
    padding: '2px 8px',
    borderRadius: 6,
  },
  kpiGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
    gap: 10,
    marginBottom: 14,
  },
  kpiCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: '12px 14px',
    borderRadius: 12,
    background: '#F8FAFC',
    border: '1px solid #F1F5F9',
  },
  statusRow: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
  },
  warningBar: {
    marginTop: 12,
    padding: '8px 12px',
    borderRadius: 8,
    background: '#FFFBEB',
    border: '1px solid #FDE68A',
    fontSize: 11,
    color: '#92400E',
    fontWeight: 600,
  },
  legacyBar: {
    marginTop: 8,
    padding: '8px 12px',
    borderRadius: 8,
    background: '#FEF2F2',
    border: '1px solid #FECACA',
    fontSize: 11,
    color: '#991B1B',
    fontWeight: 600,
    lineHeight: 1.5,
  },
  emptyText: {
    textAlign: 'center',
    color: '#94A3B8',
    fontSize: 13,
    padding: '20px 0',
  },
  tableWrap: {
    overflowX: 'auto',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 12,
  },
  th: {
    textAlign: 'left',
    padding: '8px 10px',
    fontSize: 10,
    fontWeight: 700,
    color: '#94A3B8',
    textTransform: 'uppercase' as const,
    letterSpacing: 0.4,
    borderBottom: '1px solid #F1F5F9',
    whiteSpace: 'nowrap',
  },
  tr: {
    borderBottom: '1px solid #F8FAFC',
  },
  td: {
    padding: '8px 10px',
    fontSize: 12,
    color: '#334155',
    whiteSpace: 'nowrap',
  },
  rawValue: {
    fontSize: 9,
    color: '#B45309',
    fontWeight: 400,
  },
  legacyBadge: {
    fontSize: 10,
    fontWeight: 700,
    padding: '2px 6px',
    borderRadius: 4,
    background: '#FEF3C7',
    color: '#92400E',
  },
  cleanBadge: {
    fontSize: 10,
    fontWeight: 600,
    padding: '2px 6px',
    borderRadius: 4,
    background: '#F0FDF4',
    color: '#166534',
  },
  legacyBadgeInline: {
    fontSize: 10,
    fontWeight: 700,
    padding: '2px 6px',
    borderRadius: 4,
    background: '#FEF3C7',
    color: '#92400E',
  },
  cleanBadgeInline: {
    fontSize: 10,
    fontWeight: 600,
    padding: '2px 6px',
    borderRadius: 4,
    background: '#F0FDF4',
    color: '#166534',
  },
}
