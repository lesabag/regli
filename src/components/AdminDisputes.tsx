import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { supabase, invokeEdgeFunction } from '../services/supabaseClient'
import {
  cleanCompletionReviewNotes,
  COMPLETION_REVIEW_MARKER,
} from '../utils/completionReview'

interface ProfileRow {
  id: string
  full_name: string | null
  email: string | null
}

interface DisputeRow {
  id: string
  created_at: string | null
  service_completed_at: string | null
  payment_status: string | null
  notes: string | null
  client?: ProfileRow | ProfileRow[] | null
  walker?: ProfileRow | ProfileRow[] | null
}

interface CapturePaymentResponse {
  success?: boolean
  error?: string
  details?: string
  jobId?: string
  paymentStatus?: string
  alreadyCompleted?: boolean
  alreadyCaptured?: boolean
}

interface RejectDisputeResponse {
  success?: boolean
  error?: string
  details?: string
  jobId?: string
  status?: string
  paymentStatus?: string
}

type ActionState = {
  jobId: string
  type: 'approve' | 'reject'
} | null

function normalizeProfile(profile: DisputeRow['client']): ProfileRow | null {
  if (!profile) return null
  return Array.isArray(profile) ? profile[0] ?? null : profile
}

function profileName(profile: ProfileRow | null): string {
  if (!profile) return '-'
  return profile.full_name || profile.email || profile.id.slice(0, 8)
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '-'
  const dt = new Date(value)
  if (Number.isNaN(dt.getTime())) return '-'
  return dt.toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function paymentPill(status: string | null): CSSProperties {
  const base: CSSProperties = {
    display: 'inline-block',
    padding: '4px 10px',
    borderRadius: 999,
    fontSize: 11,
    fontWeight: 700,
    whiteSpace: 'nowrap',
  }
  if (status === 'authorized' || status === 'requires_capture') {
    return { ...base, background: '#EDE9FE', color: '#6D28D9' }
  }
  if (status === 'paid') return { ...base, background: '#DCFCE7', color: '#166534' }
  if (status === 'failed') return { ...base, background: '#FEE2E2', color: '#B91C1C' }
  return { ...base, background: '#E2E8F0', color: '#475569' }
}

export default function AdminDisputes() {
  const [rows, setRows] = useState<DisputeRow[]>([])
  const [loading, setLoading] = useState(true)
  const [actionState, setActionState] = useState<ActionState>(null)
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null)

  const fetchDisputes = useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase
      .from('walk_requests')
      .select(`
        id,
        created_at,
        service_completed_at,
        payment_status,
        notes,
        client:profiles!walk_requests_client_id_fkey ( id, full_name, email ),
        walker:profiles!walk_requests_walker_id_fkey ( id, full_name, email )
      `)
      .ilike('notes', `%${COMPLETION_REVIEW_MARKER}%`)
      .order('service_completed_at', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: false })

    if (error) {
      console.error('[AdminDisputes] fetch error:', error.message)
      setFeedback({ ok: false, message: error.message })
      setLoading(false)
      return
    }

    setRows((data as DisputeRow[] | null) ?? [])
    setLoading(false)
  }, [])

  useEffect(() => {
    void fetchDisputes()
    const channel = supabase
      .channel('admin-disputes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'walk_requests' }, () => {
        void fetchDisputes()
      })
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [fetchDisputes])

  useEffect(() => {
    if (!feedback) return
    const timer = window.setTimeout(() => setFeedback(null), 4000)
    return () => window.clearTimeout(timer)
  }, [feedback])

  const disputes = useMemo(
    () =>
      rows.map((row) => ({
        ...row,
        clientProfile: normalizeProfile(row.client),
        walkerProfile: normalizeProfile(row.walker),
        cleanedNotes: cleanCompletionReviewNotes(row.notes),
      })),
    [rows],
  )

  const runAction = useCallback(
    async (jobId: string, type: 'approve' | 'reject', task: () => Promise<string | null>) => {
      setActionState({ jobId, type })
      setFeedback(null)
      try {
        const error = await task()
        if (error) {
          setFeedback({ ok: false, message: error })
        } else {
          setFeedback({
            ok: true,
            message: type === 'approve' ? 'Dispute approved and payment captured.' : 'Dispute rejected and payment canceled.',
          })
          await fetchDisputes()
        }
      } catch (err) {
        setFeedback({
          ok: false,
          message: err instanceof Error ? err.message : 'Unknown error',
        })
      } finally {
        setActionState(null)
      }
    },
    [fetchDisputes],
  )

  const handleApprove = useCallback(
    (jobId: string) => {
      void runAction(jobId, 'approve', async () => {
        const { data, error } = await invokeEdgeFunction<CapturePaymentResponse>('capture-payment', {
          body: {
            requestId: jobId,
            adminDisputeApproval: true,
          },
        })
        if (error) return error
        if (data && !data.success && !data.alreadyCaptured && !data.alreadyCompleted) {
          return data.details || data.error || 'Capture failed.'
        }
        return null
      })
    },
    [runAction],
  )

  const handleReject = useCallback(
    (jobId: string) => {
      void runAction(jobId, 'reject', async () => {
        const { data, error } = await invokeEdgeFunction<RejectDisputeResponse>(
          'reject-completion-dispute',
          { body: { jobId } },
        )
        if (error) return error
        if (data && !data.success) {
          return data.details || data.error || 'Reject failed.'
        }
        return null
      })
    },
    [runAction],
  )

  return (
    <div style={shellStyle}>
      <div style={headerStyle}>
        <div>
          <h3 style={titleStyle}>Disputes</h3>
          <p style={subtitleStyle}>Client-reported completion issues waiting for review.</p>
        </div>
        <div style={countBadgeStyle}>{loading ? '...' : disputes.length}</div>
      </div>

      {feedback && (
        <div
          style={{
            ...feedbackStyle,
            background: feedback.ok ? '#F0FDF4' : '#FEF2F2',
            borderColor: feedback.ok ? '#BBF7D0' : '#FECACA',
            color: feedback.ok ? '#166534' : '#991B1B',
          }}
        >
          {feedback.message}
        </div>
      )}

      {loading ? (
        <div style={emptyStyle}>Loading disputes...</div>
      ) : disputes.length === 0 ? (
        <div style={emptyStyle}>No disputed jobs right now.</div>
      ) : (
        <div style={tableWrapStyle}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Job</th>
                <th style={thStyle}>Client</th>
                <th style={thStyle}>Provider</th>
                <th style={thStyle}>Created</th>
                <th style={thStyle}>Marked complete</th>
                <th style={thStyle}>Payment</th>
                <th style={thStyle}>Notes</th>
                <th style={thStyle}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {disputes.map((row) => {
                const busy = actionState?.jobId === row.id
                const approving = busy && actionState?.type === 'approve'
                const rejecting = busy && actionState?.type === 'reject'

                return (
                  <tr key={row.id} style={rowStyle}>
                    <td style={tdStyle}>
                      <div style={monoStyle}>{row.id}</div>
                    </td>
                    <td style={tdStyle}>{profileName(row.clientProfile)}</td>
                    <td style={tdStyle}>{profileName(row.walkerProfile)}</td>
                    <td style={tdStyle}>{formatDateTime(row.created_at)}</td>
                    <td style={tdStyle}>{formatDateTime(row.service_completed_at)}</td>
                    <td style={tdStyle}>
                      <span style={paymentPill(row.payment_status)}>{row.payment_status || 'unpaid'}</span>
                    </td>
                    <td style={tdStyle}>
                      <div style={notesStyle}>{row.cleanedNotes || '—'}</div>
                    </td>
                    <td style={tdStyle}>
                      <div style={actionsStyle}>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => handleApprove(row.id)}
                          style={{
                            ...approveButtonStyle,
                            opacity: busy ? 0.65 : 1,
                            cursor: busy ? 'not-allowed' : 'pointer',
                          }}
                        >
                          {approving ? 'Approving...' : 'Approve'}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => handleReject(row.id)}
                          style={{
                            ...rejectButtonStyle,
                            opacity: busy ? 0.65 : 1,
                            cursor: busy ? 'not-allowed' : 'pointer',
                          }}
                        >
                          {rejecting ? 'Rejecting...' : 'Reject'}
                        </button>
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

const shellStyle: CSSProperties = {
  background: '#FFFFFF',
  border: '1px solid #E2E8F0',
  borderRadius: 20,
  padding: 20,
  boxShadow: '0 16px 40px rgba(15,23,42,0.05)',
}

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 16,
  marginBottom: 16,
}

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 22,
  fontWeight: 800,
  color: '#0F172A',
}

const subtitleStyle: CSSProperties = {
  margin: '6px 0 0',
  color: '#64748B',
  fontSize: 14,
}

const countBadgeStyle: CSSProperties = {
  minWidth: 40,
  height: 40,
  borderRadius: 999,
  display: 'grid',
  placeItems: 'center',
  background: '#FEF3C7',
  color: '#92400E',
  fontWeight: 800,
}

const feedbackStyle: CSSProperties = {
  marginBottom: 16,
  padding: '12px 14px',
  borderRadius: 14,
  border: '1px solid transparent',
  fontSize: 14,
  fontWeight: 700,
}

const emptyStyle: CSSProperties = {
  padding: '28px 10px',
  textAlign: 'center',
  color: '#64748B',
  fontWeight: 600,
}

const tableWrapStyle: CSSProperties = {
  overflowX: 'auto',
}

const tableStyle: CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  minWidth: 1080,
}

const thStyle: CSSProperties = {
  textAlign: 'left',
  padding: '12px 10px',
  fontSize: 12,
  fontWeight: 800,
  color: '#475569',
  borderBottom: '1px solid #E2E8F0',
  letterSpacing: 0.2,
}

const tdStyle: CSSProperties = {
  padding: '14px 10px',
  borderBottom: '1px solid #F1F5F9',
  verticalAlign: 'top',
  color: '#0F172A',
  fontSize: 14,
}

const rowStyle: CSSProperties = {
  background: '#FFFFFF',
}

const monoStyle: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12,
  color: '#334155',
  wordBreak: 'break-all',
}

const notesStyle: CSSProperties = {
  maxWidth: 300,
  whiteSpace: 'pre-wrap',
  color: '#334155',
  lineHeight: 1.45,
}

const actionsStyle: CSSProperties = {
  display: 'flex',
  gap: 10,
}

const approveButtonStyle: CSSProperties = {
  border: 'none',
  background: '#0F766E',
  color: '#FFFFFF',
  borderRadius: 12,
  padding: '10px 14px',
  fontSize: 13,
  fontWeight: 800,
}

const rejectButtonStyle: CSSProperties = {
  border: '1px solid #FCA5A5',
  background: '#FFF1F2',
  color: '#BE123C',
  borderRadius: 12,
  padding: '10px 14px',
  fontSize: 13,
  fontWeight: 800,
}
