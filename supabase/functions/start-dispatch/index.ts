import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { corsHeaders } from '../_shared/cors.ts'
import {
  createAdminClient,
  jsonResponse,
  normalizeTimeoutSeconds,
  sanitizeCandidates,
  type RankedCandidate,
} from '../_shared/dispatch.ts'

type StartDispatchBody = {
  requestId?: string
  timeoutSeconds?: number
  rankedCandidates?: RankedCandidate[]
  resetExisting?: boolean
}

const SCHEDULED_DISPATCH_LEAD_MINUTES = 15
const START_DISPATCH_VERSION = '2026-04-22-payment-gate-01'

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    if (req.method !== 'POST') {
      return jsonResponse(405, { ok: false, error: 'Method not allowed' }, corsHeaders)
    }

    const body = (await req.json()) as StartDispatchBody
    const requestId = String(body.requestId ?? '').trim()
    const timeoutSeconds = normalizeTimeoutSeconds(body.timeoutSeconds, 12)
    const rankedCandidates = sanitizeCandidates(body.rankedCandidates)
    const resetExisting = body.resetExisting === true

    console.log('[start-dispatch] enter', {
      version: START_DISPATCH_VERSION,
      requestId,
      timeoutSeconds,
      rankedCandidateCount: rankedCandidates.length,
      resetExisting,
    })

    if (!requestId) {
      console.error('[start-dispatch] missing requestId', {
        version: START_DISPATCH_VERSION,
      })
      return jsonResponse(400, { ok: false, error: 'requestId is required' }, corsHeaders)
    }

    if (rankedCandidates.length === 0) {
      console.error('[start-dispatch] no ranked candidates', {
        version: START_DISPATCH_VERSION,
        requestId,
      })
      return jsonResponse(
        400,
        {
          ok: false,
          error: 'rankedCandidates is required and must contain at least one valid candidate',
        },
        corsHeaders,
      )
    }

    const supabase = createAdminClient()

    const { data: requestRow, error: requestError } = await supabase
      .from('walk_requests')
      .select('id, status, walker_id, booking_timing, scheduled_for, dispatch_state, smart_dispatch_state, payment_status, stripe_payment_intent_id')
      .eq('id', requestId)
      .single()

    console.log('[start-dispatch] request fetched', {
      version: START_DISPATCH_VERSION,
      requestId,
      requestError: requestError?.message ?? null,
      requestRow,
    })

    if (requestError || !requestRow) {
      return jsonResponse(404, { ok: false, error: 'walk_request not found' }, corsHeaders)
    }

    if (requestRow.status !== 'open') {
      console.warn('[start-dispatch] request is not open', {
        version: START_DISPATCH_VERSION,
        requestId,
        status: requestRow.status,
      })
      return jsonResponse(409, { ok: false, error: 'request is not open' }, corsHeaders)
    }

    if (
      requestRow.payment_status !== 'authorized' ||
      !requestRow.stripe_payment_intent_id
    ) {
      console.warn('[start-dispatch] request payment is not authorized', {
        version: START_DISPATCH_VERSION,
        requestId,
        paymentStatus: requestRow.payment_status,
        hasPaymentIntent: !!requestRow.stripe_payment_intent_id,
      })

      await supabase
        .from('walk_requests')
        .update({
          status: 'cancelled',
          dispatch_state: 'cancelled',
          smart_dispatch_state: 'cancelled',
          smart_dispatch_last_error: 'payment authorization missing',
        })
        .eq('id', requestId)
        .eq('status', 'open')
        .neq('payment_status', 'authorized')

      return jsonResponse(
        409,
        {
          ok: false,
          error: 'payment authorization required before dispatch',
          paymentStatus: requestRow.payment_status,
        },
        corsHeaders,
      )
    }

    if (requestRow.walker_id) {
      console.warn('[start-dispatch] request already assigned', {
        version: START_DISPATCH_VERSION,
        requestId,
        walkerId: requestRow.walker_id,
      })
      return jsonResponse(409, { ok: false, error: 'request already assigned' }, corsHeaders)
    }

    if (!resetExisting && requestRow.smart_dispatch_state === 'dispatching') {
      console.warn('[start-dispatch] dispatch already active', {
        version: START_DISPATCH_VERSION,
        requestId,
        smartDispatchState: requestRow.smart_dispatch_state,
      })
      return jsonResponse(409, { ok: false, error: 'dispatch already active' }, corsHeaders)
    }

    if (requestRow.booking_timing === 'scheduled') {
      if (!requestRow.scheduled_for) {
        console.error('[start-dispatch] scheduled request missing scheduled_for', {
          version: START_DISPATCH_VERSION,
          requestId,
        })
        return jsonResponse(409, { ok: false, error: 'scheduled request is missing scheduled_for' }, corsHeaders)
      }

      const scheduledAt = new Date(requestRow.scheduled_for).getTime()
      if (Number.isNaN(scheduledAt)) {
        console.error('[start-dispatch] scheduled_for invalid', {
          version: START_DISPATCH_VERSION,
          requestId,
          scheduledFor: requestRow.scheduled_for,
        })
        return jsonResponse(409, { ok: false, error: 'scheduled_for is invalid' }, corsHeaders)
      }

      const dispatchWindowOpensAt = scheduledAt - SCHEDULED_DISPATCH_LEAD_MINUTES * 60 * 1000
      const nowMs = Date.now()

      console.log('[start-dispatch] scheduled timing check', {
        version: START_DISPATCH_VERSION,
        requestId,
        scheduledFor: requestRow.scheduled_for,
        scheduledAtIso: new Date(scheduledAt).toISOString(),
        dispatchWindowOpensAtIso: new Date(dispatchWindowOpensAt).toISOString(),
        nowIso: new Date(nowMs).toISOString(),
        millisecondsUntilWindow: dispatchWindowOpensAt - nowMs,
      })

      if (nowMs < dispatchWindowOpensAt) {
        console.warn('[start-dispatch] scheduled dispatch window not started', {
          version: START_DISPATCH_VERSION,
          requestId,
          scheduledFor: requestRow.scheduled_for,
        })
        return jsonResponse(
          409,
          {
            ok: false,
            error: 'scheduled dispatch window has not started',
            scheduledFor: requestRow.scheduled_for,
          },
          corsHeaders,
        )
      }
    }

    if (resetExisting) {
      console.log('[start-dispatch] clearing existing attempts', {
        version: START_DISPATCH_VERSION,
        requestId,
      })

      const { error: deleteAttemptsError } = await supabase
        .from('dispatch_attempts')
        .delete()
        .eq('request_id', requestId)

      if (deleteAttemptsError) {
        console.error('[start-dispatch] failed clearing existing attempts', {
          version: START_DISPATCH_VERSION,
          requestId,
          error: deleteAttemptsError.message,
        })

        if (requestRow.booking_timing === 'scheduled') {
          const { error: resetError } = await supabase
            .from('walk_requests')
            .update({
              dispatch_state: 'queued',
              smart_dispatch_state: 'idle',
              smart_dispatch_last_error: deleteAttemptsError.message,
              smart_dispatch_expires_at: null,
            })
            .eq('id', requestId)
            .eq('status', 'open')
            .is('walker_id', null)

          if (resetError) {
            console.error('[start-dispatch] failed to reset scheduled request after deleteAttemptsError', {
              version: START_DISPATCH_VERSION,
              requestId,
              error: resetError.message,
            })
          }
        }

        return jsonResponse(
          500,
          {
            ok: false,
            error: 'failed to clear existing attempts',
            details: deleteAttemptsError.message,
          },
          corsHeaders,
        )
      }
    }

    console.log('[start-dispatch] clearing previous candidates', {
      version: START_DISPATCH_VERSION,
      requestId,
    })

    const { error: deleteCandidatesError } = await supabase
      .from('dispatch_candidates')
      .delete()
      .eq('request_id', requestId)

    if (deleteCandidatesError) {
      console.error('[start-dispatch] failed clearing previous candidates', {
        version: START_DISPATCH_VERSION,
        requestId,
        error: deleteCandidatesError.message,
      })

      if (requestRow.booking_timing === 'scheduled') {
        const { error: resetError } = await supabase
          .from('walk_requests')
          .update({
            dispatch_state: 'queued',
            smart_dispatch_state: 'idle',
            smart_dispatch_last_error: deleteCandidatesError.message,
            smart_dispatch_expires_at: null,
          })
          .eq('id', requestId)
          .eq('status', 'open')
          .is('walker_id', null)

        if (resetError) {
          console.error('[start-dispatch] failed to reset scheduled request after deleteCandidatesError', {
            version: START_DISPATCH_VERSION,
            requestId,
            error: resetError.message,
          })
        }
      }

      return jsonResponse(
        500,
        {
          ok: false,
          error: 'failed to clear previous candidates',
          details: deleteCandidatesError.message,
        },
        corsHeaders,
      )
    }

    const candidateRows = rankedCandidates.map((candidate, index) => ({
      request_id: requestId,
      walker_id: candidate.walkerId,
      rank: index + 1,
      score: candidate.score,
      meta: candidate.meta ?? {},
    }))

    console.log('[start-dispatch] inserting candidates', {
      version: START_DISPATCH_VERSION,
      requestId,
      candidateCount: candidateRows.length,
      candidateWalkerIds: candidateRows.map((row) => row.walker_id),
    })

    const { error: insertCandidatesError } = await supabase
      .from('dispatch_candidates')
      .insert(candidateRows)

    if (insertCandidatesError) {
      console.error('[start-dispatch] failed inserting candidates', {
        version: START_DISPATCH_VERSION,
        requestId,
        error: insertCandidatesError.message,
      })

      if (requestRow.booking_timing === 'scheduled') {
        const { error: resetError } = await supabase
          .from('walk_requests')
          .update({
            dispatch_state: 'queued',
            smart_dispatch_state: 'idle',
            smart_dispatch_last_error: insertCandidatesError.message,
            smart_dispatch_expires_at: null,
          })
          .eq('id', requestId)
          .eq('status', 'open')
          .is('walker_id', null)

        if (resetError) {
          console.error('[start-dispatch] failed to reset scheduled request after insertCandidatesError', {
            version: START_DISPATCH_VERSION,
            requestId,
            error: resetError.message,
          })
        }
      }

      return jsonResponse(
        500,
        {
          ok: false,
          error: 'failed to insert dispatch candidates',
          details: insertCandidatesError.message,
        },
        corsHeaders,
      )
    }

    console.log('[start-dispatch] initializing request dispatch state', {
      version: START_DISPATCH_VERSION,
      requestId,
    })

    const { error: initRequestError } = await supabase
      .from('walk_requests')
      .update({
        smart_dispatch_state: 'dispatching',
        smart_dispatch_cursor: 0,
        smart_dispatch_started_at: new Date().toISOString(),
        smart_dispatch_expires_at: null,
        smart_dispatch_completed_at: null,
        smart_assigned_attempt_id: null,
        smart_dispatch_last_error: null,
      })
      .eq('id', requestId)

    if (initRequestError) {
      console.error('[start-dispatch] failed initializing dispatch state', {
        version: START_DISPATCH_VERSION,
        requestId,
        error: initRequestError.message,
      })

      if (requestRow.booking_timing === 'scheduled') {
        const { error: resetError } = await supabase
          .from('walk_requests')
          .update({
            dispatch_state: 'queued',
            smart_dispatch_state: 'idle',
            smart_dispatch_last_error: initRequestError.message,
            smart_dispatch_expires_at: null,
          })
          .eq('id', requestId)
          .eq('status', 'open')
          .is('walker_id', null)

        if (resetError) {
          console.error('[start-dispatch] failed to reset scheduled request after initRequestError', {
            version: START_DISPATCH_VERSION,
            requestId,
            error: resetError.message,
          })
        }
      }

      return jsonResponse(
        500,
        {
          ok: false,
          error: 'failed to initialize dispatch state',
          details: initRequestError.message,
        },
        corsHeaders,
      )
    }

    console.log('[start-dispatch] logging dispatch_started event', {
      version: START_DISPATCH_VERSION,
      requestId,
      candidateCount: rankedCandidates.length,
      timeoutSeconds,
    })

    const { error: logError } = await supabase.rpc('log_dispatch_event', {
      p_request_id: requestId,
      p_attempt_id: null,
      p_event_type: 'dispatch_started',
      p_payload: {
        candidateCount: rankedCandidates.length,
        timeoutSeconds,
        version: START_DISPATCH_VERSION,
      },
    })

    if (logError) {
      console.error('[start-dispatch] failed logging dispatch_started', {
        version: START_DISPATCH_VERSION,
        requestId,
        error: logError.message,
      })

      if (requestRow.booking_timing === 'scheduled') {
        const { error: resetError } = await supabase
          .from('walk_requests')
          .update({
            dispatch_state: 'queued',
            smart_dispatch_state: 'idle',
            smart_dispatch_last_error: logError.message,
            smart_dispatch_expires_at: null,
          })
          .eq('id', requestId)
          .eq('status', 'open')
          .is('walker_id', null)

        if (resetError) {
          console.error('[start-dispatch] failed to reset scheduled request after logError', {
            version: START_DISPATCH_VERSION,
            requestId,
            error: resetError.message,
          })
        }
      }

      return jsonResponse(
        500,
        {
          ok: false,
          error: 'failed to log dispatch start',
          details: logError.message,
        },
        corsHeaders,
      )
    }

    console.log('[start-dispatch] advancing dispatch request', {
      version: START_DISPATCH_VERSION,
      requestId,
      timeoutSeconds,
    })

    const { data: advanceResult, error: advanceError } = await supabase.rpc(
      'advance_dispatch_request',
      {
        p_request_id: requestId,
        p_timeout_seconds: timeoutSeconds,
      },
    )

    console.log('[start-dispatch] advance result', {
      version: START_DISPATCH_VERSION,
      requestId,
      advanceError: advanceError?.message ?? null,
      advanceResult,
    })

    if (advanceError) {
      console.error('[start-dispatch] failed opening first attempt', {
        version: START_DISPATCH_VERSION,
        requestId,
        error: advanceError.message,
      })

      if (requestRow.booking_timing === 'scheduled') {
        const { error: resetError } = await supabase
          .from('walk_requests')
          .update({
            dispatch_state: 'queued',
            smart_dispatch_state: 'idle',
            smart_dispatch_last_error: advanceError.message,
            smart_dispatch_expires_at: null,
          })
          .eq('id', requestId)
          .eq('status', 'open')
          .is('walker_id', null)

        if (resetError) {
          console.error('[start-dispatch] failed to reset scheduled request after advanceError', {
            version: START_DISPATCH_VERSION,
            requestId,
            error: resetError.message,
          })
        }
      }

      return jsonResponse(
        500,
        {
          ok: false,
          error: 'failed to open first attempt',
          details: advanceError.message,
        },
        corsHeaders,
      )
    }

    const firstAdvanceRow = Array.isArray(advanceResult) ? advanceResult[0] : advanceResult

    if (!firstAdvanceRow?.ok || !firstAdvanceRow?.attempt_id) {
      const message =
        typeof firstAdvanceRow?.message === 'string'
          ? firstAdvanceRow.message
          : 'dispatch did not open an attempt'

      console.warn('[start-dispatch] advance returned no live attempt', {
        version: START_DISPATCH_VERSION,
        requestId,
        message,
        firstAdvanceRow,
      })

      const { error: resetStateError } = await supabase
        .from('walk_requests')
        .update({
          ...(requestRow.booking_timing === 'scheduled'
            ? { dispatch_state: 'queued' }
            : {}),
          smart_dispatch_state: 'idle',
          smart_dispatch_last_error: message,
          smart_dispatch_expires_at: null,
        })
        .eq('id', requestId)

      if (resetStateError) {
        console.error('[start-dispatch] failed to reset dispatch state after empty advance', {
          version: START_DISPATCH_VERSION,
          requestId,
          error: resetStateError.message,
        })
      }

      return jsonResponse(
        409,
        {
          ok: false,
          error: message,
          requestId,
          timeoutSeconds,
          candidateCount: rankedCandidates.length,
          advanceResult,
        },
        corsHeaders,
      )
    }

    if (requestRow.booking_timing === 'scheduled') {
      const attemptId = String(firstAdvanceRow.attempt_id)

      console.log('[start-dispatch] verifying scheduled dispatch rows before markDispatched', {
        version: START_DISPATCH_VERSION,
        requestId,
        attemptId,
      })

      const [
        { count: candidateCountAfterAdvance, error: candidateCheckError },
        { data: attemptAfterAdvance, error: attemptCheckError },
      ] = await Promise.all([
        supabase
          .from('dispatch_candidates')
          .select('id', { count: 'exact', head: true })
          .eq('request_id', requestId),
        supabase
          .from('dispatch_attempts')
          .select('id, status, expires_at')
          .eq('id', attemptId)
          .eq('request_id', requestId)
          .eq('status', 'pending')
          .gt('expires_at', new Date().toISOString())
          .maybeSingle(),
      ])

      console.log('[start-dispatch] scheduled verification result', {
        version: START_DISPATCH_VERSION,
        requestId,
        attemptId,
        candidateCountAfterAdvance,
        candidateCheckError: candidateCheckError?.message ?? null,
        attemptAfterAdvance,
        attemptCheckError: attemptCheckError?.message ?? null,
      })

      if (candidateCheckError || attemptCheckError || !candidateCountAfterAdvance || !attemptAfterAdvance) {
        const message =
          candidateCheckError?.message ??
          attemptCheckError?.message ??
          'dispatch rows missing after opening scheduled attempt'

        console.error('[start-dispatch] scheduled verification failed before markDispatched', {
          version: START_DISPATCH_VERSION,
          requestId,
          attemptId,
          message,
        })

        const { error: resetStateError } = await supabase
          .from('walk_requests')
          .update({
            dispatch_state: 'queued',
            smart_dispatch_state: 'idle',
            smart_dispatch_last_error: message,
            smart_dispatch_expires_at: null,
          })
          .eq('id', requestId)
          .eq('status', 'open')
          .is('walker_id', null)

        if (resetStateError) {
          console.error('[start-dispatch] failed to reset missing scheduled dispatch rows', {
            version: START_DISPATCH_VERSION,
            requestId,
            error: resetStateError.message,
          })
        }

        return jsonResponse(
          409,
          {
            ok: false,
            error: message,
            requestId,
            timeoutSeconds,
            candidateCount: rankedCandidates.length,
            advanceResult,
          },
          corsHeaders,
        )
      }

      console.warn('[start-dispatch] MARKING REQUEST DISPATCHED', {
        version: START_DISPATCH_VERSION,
        requestId,
        attemptId,
        candidateCountAfterAdvance,
      })

      const { error: markDispatchedError } = await supabase
        .from('walk_requests')
        .update({
          dispatch_state: 'dispatched',
          smart_dispatch_state: 'dispatching',
          smart_dispatch_last_error: null,
        })
        .eq('id', requestId)
        .eq('status', 'open')
        .is('walker_id', null)

      if (markDispatchedError) {
        console.error('[start-dispatch] failed to mark scheduled request dispatched', {
          version: START_DISPATCH_VERSION,
          requestId,
          attemptId,
          error: markDispatchedError.message,
        })
        return jsonResponse(
          500,
          {
            ok: false,
            error: 'failed to mark scheduled request dispatched',
            details: markDispatchedError.message,
          },
          corsHeaders,
        )
      }

      const { data: liveAttemptAfterMark, error: liveAttemptAfterMarkError } = await supabase
        .from('dispatch_attempts')
        .select('id, status, expires_at')
        .eq('id', attemptId)
        .eq('request_id', requestId)
        .eq('status', 'pending')
        .gt('expires_at', new Date().toISOString())
        .maybeSingle()

      console.log('[start-dispatch] live attempt check after markDispatched', {
        version: START_DISPATCH_VERSION,
        requestId,
        attemptId,
        liveAttemptAfterMark,
        liveAttemptAfterMarkError: liveAttemptAfterMarkError?.message ?? null,
      })

      if (liveAttemptAfterMarkError || !liveAttemptAfterMark) {
        const message =
          liveAttemptAfterMarkError?.message ??
          'scheduled dispatch attempt missing after marking request dispatched'

        console.error('[start-dispatch] live attempt missing after markDispatched', {
          version: START_DISPATCH_VERSION,
          requestId,
          attemptId,
          message,
        })

        const { error: resetStateError } = await supabase
          .from('walk_requests')
          .update({
            dispatch_state: 'queued',
            smart_dispatch_state: 'idle',
            smart_dispatch_last_error: message,
            smart_dispatch_expires_at: null,
          })
          .eq('id', requestId)
          .eq('status', 'open')
          .is('walker_id', null)

        if (resetStateError) {
          console.error('[start-dispatch] failed to reset missing live scheduled attempt', {
            version: START_DISPATCH_VERSION,
            requestId,
            error: resetStateError.message,
          })
        }

        return jsonResponse(
          409,
          {
            ok: false,
            error: message,
            requestId,
            timeoutSeconds,
            candidateCount: rankedCandidates.length,
            advanceResult,
          },
          corsHeaders,
        )
      }
    }

    console.log('[start-dispatch] success', {
      version: START_DISPATCH_VERSION,
      requestId,
      timeoutSeconds,
      candidateCount: rankedCandidates.length,
    })

    return jsonResponse(
      200,
      {
        ok: true,
        requestId,
        timeoutSeconds,
        candidateCount: rankedCandidates.length,
        advanceResult,
        version: START_DISPATCH_VERSION,
      },
      corsHeaders,
    )
  } catch (error) {
    console.error('[start-dispatch] unexpected error', {
      version: START_DISPATCH_VERSION,
      error: error instanceof Error ? error.message : String(error),
    })

    return jsonResponse(
      500,
      {
        ok: false,
        error: 'Unexpected start-dispatch error',
        details: error instanceof Error ? error.message : String(error),
        version: START_DISPATCH_VERSION,
      },
      corsHeaders,
    )
  }
})
