// src/components/MatchingDebugV2.tsx

import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { supabase } from '../services/supabaseClient'

type MatchingRow = {
  id: string
  job_id: string
  walker_id: string
  rank_index: number
  distance_meters: number | null
  avg_rating: number
  acceptance_rate: number
  distance_score: number
  rating_score: number
  acceptance_score: number
  matching_score: number
  selected: boolean
  created_at: string
}

type JobRow = {
  id: string
  status: string
  walker_id: string | null
}

type ProfileRow = {
  id: string
  full_name: string | null
  email: string | null
}

type MatchingRowView = MatchingRow & {
  walker_name: string | null
}

export default function MatchingDebugV2() {
  const [logs, setLogs] = useState<MatchingRowView[]>([])
  const [jobs, setJobs] = useState<Record<string, JobRow>>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void load()
    const i = setInterval(() => {
      void load()
    }, 5000)
    return () => clearInterval(i)
  }, [])

  async function load() {
    setLoading(true)

    const { data, error } = await supabase
      .from('matching_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200)

    if (error) {
      console.error('[MatchingDebugV2] matching_logs load error:', error)
      setLogs([])
      setJobs({})
      setLoading(false)
      return
    }

    const rows = (data || []) as MatchingRow[]
    const jobIds = [...new Set(rows.map((r) => r.job_id))]
    const walkerIds = [...new Set(rows.map((r) => r.walker_id))]

    const [{ data: jobsData, error: jobsError }, { data: profilesData, error: profilesError }] =
      await Promise.all([
        jobIds.length
          ? supabase.from('walk_requests').select('id,status,walker_id').in('id', jobIds)
          : Promise.resolve({ data: [], error: null }),
        walkerIds.length
          ? supabase.from('profiles').select('id,full_name,email').in('id', walkerIds)
          : Promise.resolve({ data: [], error: null }),
      ])

    if (jobsError) {
      console.error('[MatchingDebugV2] walk_requests load error:', jobsError)
    }

    if (profilesError) {
      console.error('[MatchingDebugV2] profiles load error:', profilesError)
    }

    const jobsMap: Record<string, JobRow> = {}
    ;((jobsData || []) as JobRow[]).forEach((j) => {
      jobsMap[j.id] = j
    })

    const profileMap = new Map<string, string>()
    ;((profilesData || []) as ProfileRow[]).forEach((p) => {
      profileMap.set(p.id, p.full_name || p.email || p.id.slice(0, 6))
    })

    const viewRows: MatchingRowView[] = rows.map((r) => ({
      ...r,
      walker_name: profileMap.get(r.walker_id) ?? null,
    }))

    setLogs(viewRows)
    setJobs(jobsMap)
    setLoading(false)
  }

  const grouped = useMemo(() => {
    const g: Record<string, MatchingRowView[]> = {}
    logs.forEach((r) => {
      if (!g[r.job_id]) g[r.job_id] = []
      g[r.job_id].push(r)
    })
    return g
  }, [logs])

  return (
    <div style={wrap}>
      <h2 style={title}>Matching Debug V2 🚀</h2>

      {loading && <div style={loadingText}>Loading...</div>}

      {!loading && Object.keys(grouped).length === 0 && (
        <div style={loadingText}>No matching logs yet.</div>
      )}

      {Object.entries(grouped).map(([jobId, rows]) => {
        const job = jobs[jobId]

        return (
          <div key={jobId} style={jobCard}>
            <div style={jobHeader}>
              <div>
                <b>Job:</b> {jobId}
              </div>

              <div>
                status: <b>{job?.status || '-'}</b>
              </div>
            </div>

            {rows
              .slice()
              .sort((a, b) => a.rank_index - b.rank_index)
              .map((r) => {
                const accepted = job?.walker_id === r.walker_id

                return (
                  <div
                    key={r.id}
                    style={{
                      ...row,
                      ...(r.selected ? selectedRow : {}),
                      ...(accepted ? acceptedRow : {}),
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={nameRow}>
                        <span style={rankText}>#{r.rank_index}</span>
                        <span style={walkerNameText}>
                          {r.walker_name || r.walker_id.slice(0, 6)}
                        </span>
                      </div>

                      <div style={meta}>
                        {r.distance_meters != null
                          ? `${Math.round(r.distance_meters)}m`
                          : 'no gps'}{' '}
                        · ⭐ {r.avg_rating.toFixed(3)} · accept{' '}
                        {(r.acceptance_rate * 100).toFixed(0)}%
                      </div>

                      <div style={breakdown}>
                        dist: {r.distance_score.toFixed(2)} | rate:{' '}
                        {r.rating_score.toFixed(2)} | acc:{' '}
                        {r.acceptance_score.toFixed(2)}
                      </div>
                    </div>

                    <div style={rightSide}>
                      <div style={score}>{r.matching_score.toFixed(3)}</div>
                      <div style={badgesRow}>
                        {r.selected && <div style={badgeGreen}>SELECTED</div>}
                        {accepted && <div style={badgeBlue}>ACCEPTED</div>}
                      </div>
                    </div>
                  </div>
                )
              })}
          </div>
        )
      })}
    </div>
  )
}

const wrap: CSSProperties = {
  padding: 20,
}

const title: CSSProperties = {
  margin: 0,
  fontSize: 16,
  fontWeight: 800,
  color: '#0F172A',
}

const loadingText: CSSProperties = {
  marginTop: 12,
  fontSize: 14,
  color: '#64748B',
}

const jobCard: CSSProperties = {
  marginTop: 20,
  padding: 16,
  borderRadius: 12,
  background: '#FFFFFF',
  border: '1px solid #E2E8F0',
}

const jobHeader: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 12,
  marginBottom: 10,
  color: '#0F172A',
  fontSize: 14,
}

const row: CSSProperties = {
  display: 'flex',
  gap: 12,
  padding: 10,
  borderRadius: 8,
  marginBottom: 6,
  background: '#F1F5F9',
  alignItems: 'center',
}

const selectedRow: CSSProperties = {
  background: '#DCFCE7',
}

const acceptedRow: CSSProperties = {
  border: '2px solid #3B82F6',
}

const nameRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minWidth: 0,
}

const rankText: CSSProperties = {
  fontSize: 16,
  fontWeight: 700,
  color: '#0F172A',
  flexShrink: 0,
}

const walkerNameText: CSSProperties = {
  fontSize: 16,
  fontWeight: 700,
  color: '#0F172A',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const meta: CSSProperties = {
  fontSize: 12,
  color: '#64748B',
  marginTop: 4,
}

const breakdown: CSSProperties = {
  fontSize: 11,
  color: '#94A3B8',
}

const rightSide: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  flexShrink: 0,
}

const score: CSSProperties = {
  fontWeight: 700,
  fontSize: 18,
  color: '#0F172A',
  minWidth: 64,
  textAlign: 'right',
}

const badgesRow: CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'center',
}

const badgeGreen: CSSProperties = {
  fontSize: 10,
  background: '#16A34A',
  color: '#FFFFFF',
  padding: '2px 6px',
  borderRadius: 6,
  fontWeight: 700,
}

const badgeBlue: CSSProperties = {
  fontSize: 10,
  background: '#2563EB',
  color: '#FFFFFF',
  padding: '2px 6px',
  borderRadius: 6,
  fontWeight: 700,
}
