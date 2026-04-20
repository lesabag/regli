import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../services/supabaseClient'

type RequestRow = {
  id: string
  dog_name: string | null
  status: string
  smart_dispatch_state: string | null
  smart_dispatch_expires_at: string | null
  created_at: string | null
  client_id: string | null
  walker_id: string | null
}

type AttemptRow = {
  id: string
  request_id: string
  walker_id: string
  attempt_no: number
  rank: number | null
  score: number | null
  status: 'pending' | 'accepted' | 'expired' | 'rejected' | 'skipped' | 'cancelled'
  expires_at: string
  offered_at: string | null
  responded_at: string | null
  created_at: string
}

type CandidateRow = {
  id: string
  request_id: string
  walker_id: string
  rank: number
  score: number
}

type ProfileRow = {
  id: string
  full_name: string | null
  email: string | null
}

export default function AdminDispatchLive() {
  const [requests, setRequests] = useState<RequestRow[]>([])
  const [attempts, setAttempts] = useState<AttemptRow[]>([])
  const [candidates, setCandidates] = useState<CandidateRow[]>([])
  const [profiles, setProfiles] = useState<ProfileRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [, forceTick] = useState(0)

  useEffect(() => {
    void fetchAll()

    const refreshInterval = setInterval(() => {
      void fetchAll()
    }, 4000)

    const tickInterval = setInterval(() => {
      forceTick((x) => x + 1)
    }, 1000)

    return () => {
      clearInterval(refreshInterval)
      clearInterval(tickInterval)
    }
  }, [])

  async function fetchAll() {
    try {
      setLoading(true)
      setError(null)

      const [reqRes, attRes, candRes, profRes] = await Promise.all([
        supabase
          .from('walk_requests')
          .select(
            'id, dog_name, status, smart_dispatch_state, smart_dispatch_expires_at, created_at, client_id, walker_id',
          )
          .order('created_at', { ascending: false })
          .limit(30),

        supabase
          .from('dispatch_attempts')
          .select(
            'id, request_id, walker_id, attempt_no, rank, score, status, expires_at, offered_at, responded_at, created_at',
          )
          .order('created_at', { ascending: false })
          .limit(200),

        supabase
          .from('dispatch_candidates')
          .select('id, request_id, walker_id, rank, score')
          .order('rank', { ascending: true })
          .limit(200),

        supabase
          .from('profiles')
          .select('id, full_name, email')
          .limit(500),
      ])

      if (reqRes.error) throw new Error(`walk_requests: ${reqRes.error.message}`)
      if (attRes.error) throw new Error(`dispatch_attempts: ${attRes.error.message}`)
      if (candRes.error) throw new Error(`dispatch_candidates: ${candRes.error.message}`)
      if (profRes.error) throw new Error(`profiles: ${profRes.error.message}`)

      setRequests((reqRes.data as RequestRow[] | null) ?? [])
      setAttempts((attRes.data as AttemptRow[] | null) ?? [])
      setCandidates((candRes.data as CandidateRow[] | null) ?? [])
      setProfiles((profRes.data as ProfileRow[] | null) ?? [])
    } catch (err) {
      console.error('[AdminDispatchLive] fetchAll failed:', err)
      setError(err instanceof Error ? err.message : 'Failed to load dispatch data')
    } finally {
      setLoading(false)
    }
  }

  const profileMap = useMemo(() => {
    const map = new Map<string, string>()
    profiles.forEach((p) => {
      map.set(p.id, p.full_name || p.email || `User ${p.id.slice(0, 6)}`)
    })
    return map
  }, [profiles])

  const requestsWithContext = useMemo(() => {
    return requests.filter((r) => {
      if (r.smart_dispatch_state) return true
      if (r.walker_id) return true
      return attempts.some((a) => a.request_id === r.id)
    })
  }, [requests, attempts])

  const liveRequests = useMemo(
    () =>
      requestsWithContext.filter(
        (r) => r.smart_dispatch_state === 'dispatching' || r.smart_dispatch_state === 'assigned',
      ),
    [requestsWithContext],
  )

  const recentRequests = useMemo(
    () =>
      requestsWithContext.filter(
        (r) => r.smart_dispatch_state !== 'dispatching' && r.smart_dispatch_state !== 'assigned',
      ),
    [requestsWithContext],
  )

  function getAttemptsForRequest(requestId: string) {
    return attempts
      .filter((a) => a.request_id === requestId)
      .sort((a, b) => a.attempt_no - b.attempt_no)
  }

  function getCandidatesForRequest(requestId: string) {
    return candidates
      .filter((c) => c.request_id === requestId)
      .sort((a, b) => a.rank - b.rank)
  }

  function getRemainingSeconds(expiresAt: string | null) {
    if (!expiresAt) return null
    const diff = new Date(expiresAt).getTime() - Date.now()
    return Math.max(0, Math.floor(diff / 1000))
  }

  function formatAgo(value: string | null | undefined) {
    if (!value) return '—'
    const diffMs = Date.now() - new Date(value).getTime()
    if (Number.isNaN(diffMs)) return '—'
    const sec = Math.floor(diffMs / 1000)
    if (sec < 60) return `${sec}s ago`
    const min = Math.floor(sec / 60)
    if (min < 60) return `${min}m ago`
    const hrs = Math.floor(min / 60)
    if (hrs < 24) return `${hrs}h ago`
    const days = Math.floor(hrs / 24)
    return `${days}d ago`
  }

  function formatCountdown(seconds: number | null) {
    if (seconds == null) return '—'
    const s = Math.max(0, seconds)
    const mins = Math.floor(s / 60)
    const secs = s % 60
    return `${mins}:${String(secs).padStart(2, '0')}`
  }

  function statusTone(status: string | null) {
    switch (status) {
      case 'dispatching':
      case 'pending':
        return { bg: '#EFF6FF', fg: '#1D4ED8', border: '#BFDBFE' }
      case 'assigned':
      case 'accepted':
        return { bg: '#ECFDF5', fg: '#047857', border: '#A7F3D0' }
      case 'expired':
      case 'exhausted':
        return { bg: '#FFF7ED', fg: '#C2410C', border: '#FED7AA' }
      case 'rejected':
      case 'cancelled':
        return { bg: '#FEF2F2', fg: '#B91C1C', border: '#FECACA' }
      case 'idle':
        return { bg: '#F8FAFC', fg: '#475569', border: '#E2E8F0' }
      default:
        return { bg: '#F8FAFC', fg: '#475569', border: '#E2E8F0' }
    }
  }

  function renderPill(label: string) {
    const tone = statusTone(label)
    return (
      <span
        style={{
          ...pillStyle,
          background: tone.bg,
          color: tone.fg,
          border: `1px solid ${tone.border}`,
        }}
      >
        {label}
      </span>
    )
  }

  if (loading) {
    return <div style={emptyStateStyle}>Loading dispatch data...</div>
  }

  if (error) {
    return (
      <div style={errorCardStyle}>
        <div style={errorTitleStyle}>Failed to load dispatch data</div>
        <div style={errorTextStyle}>{error}</div>
        <button type="button" onClick={() => void fetchAll()} style={retryBtnStyle}>
          Retry
        </button>
      </div>
    )
  }

  return (
    <div style={wrapStyle}>
      <div style={statsRowStyle}>
        <StatCard label="Live" value={String(liveRequests.length)} />
        <StatCard label="Recent" value={String(recentRequests.length)} />
        <StatCard label="Attempts" value={String(attempts.length)} />
      </div>

      <div style={sectionStyle}>
        <div style={sectionHeaderStyle}>
          <div style={sectionTitleStyle}>Live dispatch</div>
          <div style={sectionSubStyle}>
            {liveRequests.length === 0
              ? 'No jobs are actively dispatching right now'
              : `${liveRequests.length} active jobs`}
          </div>
        </div>

        {liveRequests.length === 0 ? (
          <div style={emptyStateStyle}>No active dispatch jobs</div>
        ) : (
          <div style={listStyle}>
            {liveRequests.map((req) => (
              <DispatchCard
                key={req.id}
                req={req}
                attempts={getAttemptsForRequest(req.id)}
                candidates={getCandidatesForRequest(req.id)}
                profileMap={profileMap}
                formatAgo={formatAgo}
                formatCountdown={formatCountdown}
                renderPill={renderPill}
                getRemainingSeconds={getRemainingSeconds}
                live
              />
            ))}
          </div>
        )}
      </div>

      <div style={sectionStyle}>
        <div style={sectionHeaderStyle}>
          <div style={sectionTitleStyle}>Recent jobs</div>
          <div style={sectionSubStyle}>Latest jobs with dispatch context or assignment</div>
        </div>

        {recentRequests.length === 0 ? (
          <div style={emptyStateStyle}>No recent jobs yet</div>
        ) : (
          <div style={listStyle}>
            {recentRequests.map((req) => (
              <DispatchCard
                key={req.id}
                req={req}
                attempts={getAttemptsForRequest(req.id)}
                candidates={getCandidatesForRequest(req.id)}
                profileMap={profileMap}
                formatAgo={formatAgo}
                formatCountdown={formatCountdown}
                renderPill={renderPill}
                getRemainingSeconds={getRemainingSeconds}
                live={false}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={statCardStyle}>
      <div style={statLabelStyle}>{label}</div>
      <div style={statValueStyle}>{value}</div>
    </div>
  )
}

function DispatchCard({
  req,
  attempts,
  candidates,
  profileMap,
  formatAgo,
  formatCountdown,
  renderPill,
  getRemainingSeconds,
  live,
}: {
  req: RequestRow
  attempts: AttemptRow[]
  candidates: CandidateRow[]
  profileMap: Map<string, string>
  formatAgo: (value: string | null | undefined) => string
  formatCountdown: (seconds: number | null) => string
  renderPill: (label: string) => React.ReactNode
  getRemainingSeconds: (value: string | null) => number | null
  live: boolean
}) {
  const current = attempts.find((a) => a.status === 'pending') ?? null
  const accepted = attempts.find((a) => a.status === 'accepted') ?? null
  const attemptedWalkerIds = new Set(attempts.map((a) => a.walker_id))
  const nextCandidate = candidates.find((c) => !attemptedWalkerIds.has(c.walker_id)) ?? null

  const remaining = getRemainingSeconds(req.smart_dispatch_expires_at)
  const progressPercent =
    remaining == null ? 0 : Math.max(0, Math.min(100, (remaining / 12) * 100))

  return (
    <div style={cardStyle}>
      <div style={topRowStyle}>
        <div style={{ minWidth: 0 }}>
          <div style={titleRowStyle}>
            <div style={dogTitleStyle}>{req.dog_name || 'Dog'}</div>
            {renderPill(req.smart_dispatch_state || 'unknown')}
            {renderPill(req.status)}
          </div>

          <div style={subTextStyle}>
            Job {req.id.slice(0, 8)} · created {formatAgo(req.created_at)}
            {req.walker_id
              ? ` · walker ${profileMap.get(req.walker_id) || req.walker_id.slice(0, 6)}`
              : ''}
          </div>
        </div>

        <div style={attemptsBadgeStyle}>
          {attempts.length} {attempts.length === 1 ? 'attempt' : 'attempts'}
        </div>
      </div>

      {live && current && (
        <div style={livePanelStyle}>
          <div style={livePanelHeaderStyle}>
            <div style={liveHeadingStyle}>Live dispatch</div>
            <div style={countdownWrapStyle}>
              <span style={countdownLabelStyle}>timeout</span>
              <span style={countdownValueStyle}>{formatCountdown(remaining)}</span>
            </div>
          </div>

          <div style={progressTrackStyle}>
            <div style={{ ...progressFillStyle, width: `${progressPercent}%` }} />
          </div>

          <div style={liveGridStyle}>
            <div style={liveBoxStyle}>
              <div style={liveLabelStyle}>Current walker</div>
              <div style={liveValueStyle}>
                {profileMap.get(current.walker_id) || current.walker_id.slice(0, 6)}
              </div>
              <div style={liveMetaStyle}>
                Attempt #{current.attempt_no}
                {current.rank != null ? ` · Rank ${current.rank}` : ''}
                {current.score != null ? ` · Score ${current.score.toFixed(3)}` : ''}
              </div>
            </div>

            <div style={liveBoxStyle}>
              <div style={liveLabelStyle}>Next in line</div>
              <div style={liveValueStyle}>
                {nextCandidate
                  ? profileMap.get(nextCandidate.walker_id) || nextCandidate.walker_id.slice(0, 6)
                  : 'No next walker'}
              </div>
              <div style={liveMetaStyle}>
                {nextCandidate
                  ? `Rank ${nextCandidate.rank} · Score ${nextCandidate.score.toFixed(3)}`
                  : 'Candidate list exhausted'}
              </div>
            </div>
          </div>
        </div>
      )}

      {!current && accepted && (
        <div style={successPanelStyle}>
          <div style={successTitleStyle}>Accepted</div>
          <div style={successSubStyle}>
            {profileMap.get(accepted.walker_id) || accepted.walker_id.slice(0, 6)} accepted on
            attempt #{accepted.attempt_no}
          </div>
        </div>
      )}

      {!current && !accepted && req.smart_dispatch_state === 'exhausted' && (
        <div style={warningPanelStyle}>
          <div style={warningTitleStyle}>Dispatch exhausted</div>
          <div style={warningSubStyle}>No available walker accepted this request.</div>
        </div>
      )}

      {!live && req.smart_dispatch_state === 'idle' && attempts.length === 0 && (
        <div style={idlePanelStyle}>
          <div style={idleTitleStyle}>Idle dispatch state</div>
          <div style={idleSubStyle}>This job has not started dispatch attempts yet.</div>
        </div>
      )}

      <div style={timelineWrapStyle}>
        <div style={sectionTitleInnerStyle}>Dispatch timeline</div>

        {attempts.length === 0 ? (
          <div style={emptyTimelineStyle}>No attempts logged yet</div>
        ) : (
          <div style={timelineListStyle}>
            {attempts.map((attempt) => {
              const walkerName =
                profileMap.get(attempt.walker_id) || attempt.walker_id.slice(0, 6)

              return (
                <div key={attempt.id} style={attemptCardStyle}>
                  <div style={attemptTopStyle}>
                    <div style={attemptTitleStyle}>
                      #{attempt.attempt_no} · {walkerName}
                    </div>
                    {renderPill(attempt.status)}
                  </div>

                  <div style={attemptMetaRowStyle}>
                    <span>Rank {attempt.rank ?? '—'}</span>
                    <span>Score {attempt.score != null ? attempt.score.toFixed(3) : '—'}</span>
                    <span>Offered {formatAgo(attempt.offered_at || attempt.created_at)}</span>
                    <span>Expires {formatAgo(attempt.expires_at)}</span>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

const wrapStyle: React.CSSProperties = {
  display: 'grid',
  gap: 18,
}

const statsRowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  gap: 10,
}

const statCardStyle: React.CSSProperties = {
  background: '#FFFFFF',
  border: '1px solid #E2E8F0',
  borderRadius: 14,
  padding: 14,
}

const statLabelStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#64748B',
  fontWeight: 700,
}

const statValueStyle: React.CSSProperties = {
  marginTop: 6,
  fontSize: 22,
  fontWeight: 800,
  color: '#0F172A',
}

const sectionStyle: React.CSSProperties = {
  display: 'grid',
  gap: 12,
}

const sectionHeaderStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-end',
  gap: 12,
  flexWrap: 'wrap',
}

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 800,
  color: '#0F172A',
}

const sectionSubStyle: React.CSSProperties = {
  fontSize: 13,
  color: '#64748B',
}

const listStyle: React.CSSProperties = {
  display: 'grid',
  gap: 14,
}

const emptyStateStyle: React.CSSProperties = {
  background: '#FFFFFF',
  border: '1px solid #E2E8F0',
  borderRadius: 16,
  padding: 18,
  color: '#64748B',
  fontSize: 14,
}

const errorCardStyle: React.CSSProperties = {
  background: '#FFFFFF',
  border: '1px solid #FECACA',
  borderRadius: 16,
  padding: 18,
}

const errorTitleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 800,
  color: '#B91C1C',
}

const errorTextStyle: React.CSSProperties = {
  marginTop: 8,
  fontSize: 13,
  color: '#7F1D1D',
  lineHeight: 1.5,
}

const retryBtnStyle: React.CSSProperties = {
  marginTop: 14,
  border: 'none',
  borderRadius: 10,
  background: '#0F172A',
  color: '#FFFFFF',
  padding: '10px 14px',
  fontWeight: 700,
  cursor: 'pointer',
}

const cardStyle: React.CSSProperties = {
  background: '#FFFFFF',
  border: '1px solid #E2E8F0',
  borderRadius: 18,
  padding: 16,
  boxShadow: '0 6px 22px rgba(15, 23, 42, 0.04)',
}

const topRowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  gap: 12,
  marginBottom: 12,
}

const titleRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flexWrap: 'wrap',
}

const dogTitleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 800,
  color: '#0F172A',
}

const subTextStyle: React.CSSProperties = {
  marginTop: 6,
  fontSize: 12,
  color: '#64748B',
}

const attemptsBadgeStyle: React.CSSProperties = {
  background: '#F8FAFC',
  border: '1px solid #E2E8F0',
  borderRadius: 999,
  padding: '6px 10px',
  fontSize: 12,
  fontWeight: 700,
  color: '#334155',
  whiteSpace: 'nowrap',
}

const pillStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  borderRadius: 999,
  padding: '4px 9px',
  fontSize: 11,
  fontWeight: 800,
  textTransform: 'capitalize',
}

const livePanelStyle: React.CSSProperties = {
  border: '1px solid #DBEAFE',
  background: '#F8FBFF',
  borderRadius: 16,
  padding: 14,
  marginBottom: 14,
}

const livePanelHeaderStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 10,
  marginBottom: 10,
  flexWrap: 'wrap',
}

const liveHeadingStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 800,
  color: '#0F172A',
}

const countdownWrapStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 8,
}

const countdownLabelStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#64748B',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
}

const countdownValueStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 800,
  color: '#1D4ED8',
  fontVariantNumeric: 'tabular-nums',
}

const progressTrackStyle: React.CSSProperties = {
  width: '100%',
  height: 6,
  borderRadius: 999,
  background: '#DBEAFE',
  overflow: 'hidden',
  marginBottom: 12,
}

const progressFillStyle: React.CSSProperties = {
  height: '100%',
  borderRadius: 999,
  background: 'linear-gradient(90deg, #3B82F6, #60A5FA)',
  transition: 'width 1s linear',
}

const liveGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  gap: 10,
}

const liveBoxStyle: React.CSSProperties = {
  border: '1px solid #BFDBFE',
  borderRadius: 12,
  padding: 12,
  background: '#EFF6FF',
}

const liveLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: '#64748B',
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  marginBottom: 6,
}

const liveValueStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 800,
  color: '#0F172A',
}

const liveMetaStyle: React.CSSProperties = {
  marginTop: 6,
  fontSize: 12,
  color: '#475569',
}

const successPanelStyle: React.CSSProperties = {
  border: '1px solid #A7F3D0',
  background: '#ECFDF5',
  borderRadius: 14,
  padding: 12,
  marginBottom: 14,
}

const successTitleStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 800,
  color: '#047857',
}

const successSubStyle: React.CSSProperties = {
  marginTop: 4,
  fontSize: 13,
  color: '#065F46',
}

const warningPanelStyle: React.CSSProperties = {
  border: '1px solid #FED7AA',
  background: '#FFF7ED',
  borderRadius: 14,
  padding: 12,
  marginBottom: 14,
}

const warningTitleStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 800,
  color: '#C2410C',
}

const warningSubStyle: React.CSSProperties = {
  marginTop: 4,
  fontSize: 13,
  color: '#9A3412',
}

const idlePanelStyle: React.CSSProperties = {
  border: '1px solid #E2E8F0',
  background: '#F8FAFC',
  borderRadius: 14,
  padding: 12,
  marginBottom: 14,
}

const idleTitleStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 800,
  color: '#475569',
}

const idleSubStyle: React.CSSProperties = {
  marginTop: 4,
  fontSize: 13,
  color: '#64748B',
}

const timelineWrapStyle: React.CSSProperties = {
  marginTop: 2,
}

const sectionTitleInnerStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 800,
  color: '#0F172A',
  marginBottom: 10,
}

const timelineListStyle: React.CSSProperties = {
  display: 'grid',
  gap: 8,
}

const emptyTimelineStyle: React.CSSProperties = {
  fontSize: 13,
  color: '#64748B',
  background: '#F8FAFC',
  border: '1px dashed #CBD5E1',
  borderRadius: 12,
  padding: 12,
}

const attemptCardStyle: React.CSSProperties = {
  border: '1px solid #E2E8F0',
  background: '#FFFFFF',
  borderRadius: 12,
  padding: 12,
}

const attemptTopStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 10,
  flexWrap: 'wrap',
}

const attemptTitleStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 700,
  color: '#0F172A',
}

const attemptMetaRowStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 12,
  marginTop: 8,
  fontSize: 12,
  color: '#64748B',
}
