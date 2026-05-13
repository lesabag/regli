import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { supabase, invokeEdgeFunction } from '../services/supabaseClient'
import {
  cleanCompletionReviewNotes,
  COMPLETION_REVIEW_MARKER,
  PROVIDER_ISSUE_MARKER,
  isProviderIssueReported,
} from '../utils/completionReview'

interface ProfileRow {
  id: string
  full_name: string | null
  email: string | null
}

interface DisputeRow {
  id: string
  client_id: string | null
  walker_id: string | null
  created_at: string | null
  service_completed_at: string | null
  payment_status: string | null
  refunded_amount: number | null
  refund_currency: string | null
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

type ActionType = 'approve_payout' | 'reject_payout' | 'resume_service' | 'reassign_provider' | 'cancel_request'
  | 'refund'

type ActionState = {
  jobId: string
  type: ActionType
} | null

type ResolvedCaseType = 'provider_issue' | 'completion_dispute'

interface ReviewProviderIssueResponse {
  success?: boolean
  error?: string
  details?: string
  jobId?: string
  action?: 'resume' | 'reassign' | 'cancel'
  status?: string
  paymentStatus?: string
}

interface RefundPaymentResponse {
  success?: boolean
  error?: string
  details?: string
  jobId?: string
  refundId?: string
  refundStatus?: 'refunded' | 'partially_refunded' | 'already_refunded'
  refundedAmount?: number
  currency?: string
  reversalStatus?: 'not_needed' | 'pending' | 'reversed' | 'partial' | 'failed'
  alreadyRefunded?: boolean
}

function normalizeProfile(profile: DisputeRow['client'] | DisputeRow['walker']): ProfileRow | null {
  if (!profile) return null
  return Array.isArray(profile) ? profile[0] ?? null : profile
}

function profileName(profile: ProfileRow | null, fallbackId?: string | null): string {
  if (profile) return profile.full_name || profile.email || profile.id.slice(0, 8)
  if (fallbackId) return fallbackId.slice(0, 8)
  return '-'
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '-'
  const dt = new Date(value)
  if (Number.isNaN(dt.getTime())) return '-'
  return dt.toLocaleDateString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }) + ' • ' + dt.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatRelativeTime(value: string | null | undefined, nowMs: number): string {
  if (!value) return '-'
  const ts = new Date(value).getTime()
  if (Number.isNaN(ts)) return '-'
  const diffMs = Math.max(0, nowMs - ts)
  const diffMin = Math.floor(diffMs / 60_000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin} min ago`
  const diffHours = Math.floor(diffMin / 60)
  if (diffHours < 24) return diffHours === 1 ? '1 hour ago' : `${diffHours} hours ago`
  const diffDays = Math.floor(diffHours / 24)
  return diffDays === 1 ? '1 day ago' : `${diffDays} days ago`
}

function renderTimestampCell(value: string | null | undefined, nowMs: number) {
  return (
    <div style={timestampWrapStyle}>
      <div style={timestampPrimaryStyle}>{formatDateTime(value)}</div>
      {value && value !== '-' && (
        <div style={timestampSecondaryStyle}>{formatRelativeTime(value, nowMs)}</div>
      )}
    </div>
  )
}

function paymentPill(status: string | null, refundedAmount: number | null): CSSProperties {
  const base: CSSProperties = {
    display: 'inline-block',
    padding: '4px 10px',
    borderRadius: 999,
    fontSize: 11,
    fontWeight: 700,
    whiteSpace: 'nowrap',
  }
  if ((refundedAmount ?? 0) > 0 && status !== 'refunded') {
    return { ...base, background: '#FEF3C7', color: '#92400E' }
  }
  if (status === 'authorized' || status === 'requires_capture') {
    return { ...base, background: '#EDE9FE', color: '#6D28D9' }
  }
  if (status === 'paid') return { ...base, background: '#DCFCE7', color: '#166534' }
  if (status === 'refunded') return { ...base, background: '#E2E8F0', color: '#475569' }
  if (status === 'failed') return { ...base, background: '#FEE2E2', color: '#B91C1C' }
  return { ...base, background: '#E2E8F0', color: '#475569' }
}

function paymentLabel(status: string | null, refundedAmount: number | null): string {
  if ((refundedAmount ?? 0) > 0 && status !== 'refunded') return 'partially refunded'
  return status || 'unpaid'
}

export default function AdminDisputes() {
  const [rows, setRows] = useState<DisputeRow[]>([])
  const [loading, setLoading] = useState(true)
  const [actionState, setActionState] = useState<ActionState>(null)
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())

  const fetchDisputes = useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase
      .from('walk_requests')
      .select(`
        id,
        client_id,
        walker_id,
        created_at,
        service_completed_at,
        payment_status,
        refunded_amount,
        refund_currency,
        notes,
        client:profiles!walk_requests_client_id_fkey ( id, full_name, email ),
        walker:profiles!walk_requests_walker_id_fkey ( id, full_name, email )
      `)
      .or(`notes.ilike.%${COMPLETION_REVIEW_MARKER}%,notes.ilike.%${PROVIDER_ISSUE_MARKER}%`)
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

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [])

  const disputes = useMemo(
    () =>
      rows.map((row) => ({
        ...row,
        clientProfile: normalizeProfile(row.client),
        walkerProfile: normalizeProfile(row.walker),
        cleanedNotes: cleanCompletionReviewNotes(row.notes),
        caseType: (isProviderIssueReported(row.notes) ? 'provider_issue' : 'completion_dispute') as ResolvedCaseType,
      })),
    [rows],
  )

  const runAction = useCallback(
    async (
      jobId: string,
      type: ActionType,
      successMessage: string,
      task: () => Promise<string | null>,
    ) => {
      setActionState({ jobId, type })
      setFeedback(null)
      try {
        const error = await task()
        if (error) {
          setFeedback({ ok: false, message: error })
        } else {
          setFeedback({ ok: true, message: successMessage })
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

  const handleApprovePayout = useCallback(
    (jobId: string) => {
      void runAction(jobId, 'approve_payout', 'Payout approved and payment captured.', async () => {
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

  const handleRejectPayout = useCallback(
    (jobId: string) => {
      void runAction(jobId, 'reject_payout', 'Payout rejected and payment authorization canceled.', async () => {
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

  const handleResumeService = useCallback(
    (jobId: string) => {
      void runAction(jobId, 'resume_service', 'Service resumed. Provider and client were notified.', async () => {
        const { data, error } = await invokeEdgeFunction<ReviewProviderIssueResponse>('review-provider-issue', {
          body: { jobId, action: 'resume' },
        })
        if (error) return error
        if (data && !data.success) {
          return data.details || data.error || 'Resume failed.'
        }
        return null
      })
    },
    [runAction],
  )

  const handleReassignProvider = useCallback(
    (jobId: string) => {
      void runAction(jobId, 'reassign_provider', 'Provider reassignment started. The client was moved back to searching.', async () => {
        const { data, error } = await invokeEdgeFunction<ReviewProviderIssueResponse>('review-provider-issue', {
          body: { jobId, action: 'reassign' },
        })
        if (error) return error
        if (data && !data.success) {
          return data.details || data.error || 'Reassign failed.'
        }
        return null
      })
    },
    [runAction],
  )

  const handleCancelRequest = useCallback(
    (jobId: string) => {
      void runAction(jobId, 'cancel_request', 'Request cancelled. Provider and client were notified.', async () => {
        const { data, error } = await invokeEdgeFunction<ReviewProviderIssueResponse>('review-provider-issue', {
          body: { jobId, action: 'cancel' },
        })
        if (error) return error
        if (data && !data.success) {
          return data.details || data.error || 'Cancel failed.'
        }
        return null
      })
    },
    [runAction],
  )

  const handleRefund = useCallback(
    (jobId: string) => {
      void runAction(jobId, 'refund', 'Refund issued. Status will refresh after Stripe reconciliation.', async () => {
        const { data, error } = await invokeEdgeFunction<RefundPaymentResponse>('refund-payment', {
          body: { jobId },
        })
        if (error) return error
        if (!data?.success) {
          return data?.details || data?.error || 'Refund failed.'
        }
        if (data.alreadyRefunded || data.refundStatus === 'already_refunded') {
          setFeedback({ ok: true, message: 'This request is already fully refunded.' })
          await fetchDisputes()
          return null
        }
        const reversalLabel =
          data.reversalStatus === 'failed'
            ? ' Reversal sync needs manual review.'
            : data.reversalStatus === 'partial'
              ? ' Transfer reversal was partially applied.'
              : data.reversalStatus === 'reversed'
                ? ' Transfer reversal completed.'
                : ''
        const refundLabel =
          data.refundStatus === 'partially_refunded'
            ? 'Partial refund issued.'
            : 'Refund issued.'
        setFeedback({ ok: true, message: `${refundLabel}${reversalLabel}`.trim() })
        await fetchDisputes()
        return null
      })
    },
    [fetchDisputes, runAction],
  )

  return (
    <div style={shellStyle}>
      <div style={headerStyle}>
        <div>
          <h3 style={titleStyle}>Disputes</h3>
          <p style={subtitleStyle}>Reported issues waiting for review.</p>
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
                <th style={thStyle}>Type</th>
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
                const resuming = busy && actionState?.type === 'resume_service'
                const reassigning = busy && actionState?.type === 'reassign_provider'
                const cancelling = busy && actionState?.type === 'cancel_request'
                const approving = busy && actionState?.type === 'approve_payout'
                const rejecting = busy && actionState?.type === 'reject_payout'
                const refunding = busy && actionState?.type === 'refund'
                const isProviderIssue = row.caseType === 'provider_issue'
                const refundedAmount = row.refunded_amount ?? 0
                const canRefund = row.payment_status === 'paid' || (refundedAmount > 0 && row.payment_status !== 'refunded')
                const alreadyRefunded = row.payment_status === 'refunded'

                return (
                  <tr key={row.id} style={rowStyle}>
                    <td style={tdStyle}>
                      <div style={monoStyle}>{row.id}</div>
                    </td>
                    <td style={tdStyle}>
                      <span style={{
                        fontSize: 11,
                        fontWeight: 700,
                        padding: '2px 8px',
                        borderRadius: 8,
                        background: isProviderIssue ? '#FEF3C7' : '#FEE2E2',
                        color: isProviderIssue ? '#92400E' : '#991B1B',
                      }}>
                        {isProviderIssue ? 'Provider issue' : 'Client payout dispute'}
                      </span>
                    </td>
                    <td style={tdStyle}>{profileName(row.clientProfile, row.client_id)}</td>
                    <td style={tdStyle}>{profileName(row.walkerProfile, row.walker_id)}</td>
                    <td style={tdStyle}>{renderTimestampCell(row.created_at, nowMs)}</td>
                    <td style={tdStyle}>{renderTimestampCell(row.service_completed_at, nowMs)}</td>
                    <td style={tdStyle}>
                      <span style={paymentPill(row.payment_status, row.refunded_amount)}>
                        {paymentLabel(row.payment_status, row.refunded_amount)}
                      </span>
                    </td>
                    <td style={tdStyle}>
                      <div style={notesStyle}>{row.cleanedNotes || '—'}</div>
                    </td>
                    <td style={tdStyle}>
                      <div style={actionsStyle}>
                        {isProviderIssue ? (
                          <>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => handleResumeService(row.id)}
                              style={{
                                ...approveButtonStyle,
                                opacity: busy ? 0.65 : 1,
                                cursor: busy ? 'not-allowed' : 'pointer',
                              }}
                            >
                              {resuming ? 'Resuming...' : 'Resume service'}
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => handleReassignProvider(row.id)}
                              style={{
                                ...secondaryButtonStyle,
                                opacity: busy ? 0.65 : 1,
                                cursor: busy ? 'not-allowed' : 'pointer',
                              }}
                            >
                              {reassigning ? 'Reassigning...' : 'Reassign provider'}
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => handleCancelRequest(row.id)}
                              style={{
                                ...rejectButtonStyle,
                                opacity: busy ? 0.65 : 1,
                                cursor: busy ? 'not-allowed' : 'pointer',
                              }}
                            >
                              {cancelling ? 'Cancelling...' : 'Cancel request'}
                            </button>
                            {canRefund || alreadyRefunded ? (
                              <button
                                type="button"
                                disabled={busy || alreadyRefunded}
                                onClick={() => handleRefund(row.id)}
                                style={{
                                  ...secondaryButtonStyle,
                                  opacity: busy || alreadyRefunded ? 0.65 : 1,
                                  cursor: busy || alreadyRefunded ? 'not-allowed' : 'pointer',
                                }}
                              >
                                {alreadyRefunded ? 'Already refunded' : refunding ? 'Refunding...' : 'Refund'}
                              </button>
                            ) : null}
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => handleApprovePayout(row.id)}
                              style={{
                                ...approveButtonStyle,
                                opacity: busy ? 0.65 : 1,
                                cursor: busy ? 'not-allowed' : 'pointer',
                              }}
                            >
                              {approving ? 'Approving...' : 'Approve payout'}
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => handleRejectPayout(row.id)}
                              style={{
                                ...rejectButtonStyle,
                                opacity: busy ? 0.65 : 1,
                                cursor: busy ? 'not-allowed' : 'pointer',
                              }}
                            >
                              {rejecting ? 'Rejecting...' : 'Reject payout'}
                            </button>
                            {canRefund || alreadyRefunded ? (
                              <button
                                type="button"
                                disabled={busy || alreadyRefunded}
                                onClick={() => handleRefund(row.id)}
                                style={{
                                  ...secondaryButtonStyle,
                                  opacity: busy || alreadyRefunded ? 0.65 : 1,
                                  cursor: busy || alreadyRefunded ? 'not-allowed' : 'pointer',
                                }}
                              >
                                {alreadyRefunded ? 'Already refunded' : refunding ? 'Refunding...' : 'Refund'}
                              </button>
                            ) : null}
                          </>
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

const shellStyle: CSSProperties = {
  background: '#FFFFFF',
  border: '1px solid #E2E8F0',
  borderRadius: 20,
  padding: 20,
  boxShadow: '0 16px 40px rgba(15,23,42,0.05)',
}

const timestampWrapStyle: CSSProperties = {
  display: 'grid',
  gap: 4,
}

const timestampPrimaryStyle: CSSProperties = {
  color: '#0F172A',
  fontSize: 13,
  fontWeight: 700,
  whiteSpace: 'nowrap',
}

const timestampSecondaryStyle: CSSProperties = {
  color: '#94A3B8',
  fontSize: 11,
  fontWeight: 500,
  whiteSpace: 'nowrap',
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

const secondaryButtonStyle: CSSProperties = {
  border: '1px solid #BFDBFE',
  background: '#EFF6FF',
  color: '#1D4ED8',
  borderRadius: 12,
  padding: '10px 14px',
  fontSize: 13,
  fontWeight: 800,
}
