import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { corsHeaders } from '../_shared/cors.ts'
import {
  createAdminClient,
  getEnv,
  jsonResponse,
} from '../_shared/dispatch.ts'

const LEAD_MINUTES = 15
const DISPATCH_TIMEOUT_SECONDS = 60

type ActiveAttemptRow = {
  id: string
}

type WalkerRow = {
  id: string
}

type StartDispatchResponse = {
  ok?: boolean
  error?: string
  details?: string
  requestId?: string
  candidateCount?: number
  advanceResult?: unknown
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabase = createAdminClient()

    const now = new Date()
    const leadTime = new Date(now.getTime() + LEAD_MINUTES * 60 * 1000)

    // 🔍 fetch ONLY relevant jobs
    const { data: jobs, error } = await supabase
      .from('walk_requests')
      .select(`
        id,
        status,
        scheduled_for,
        dispatch_state,
        smart_dispatch_state,
        smart_dispatch_expires_at,
        walker_id
      `)
      .eq('booking_timing', 'scheduled')
      .eq('status', 'open')
      .is('walker_id', null)
      .not('scheduled_for', 'is', null)
      .lte('scheduled_for', leadTime.toISOString())

    if (error) {
      return jsonResponse(500, {
        ok: false,
        error: 'failed to fetch scheduled jobs',
        details: error.message,
      }, corsHeaders)
    }

    if (!jobs || jobs.length === 0) {
      return jsonResponse(200, {
        ok: true,
        scanned: 0,
        started: 0,
        noCandidates: 0,
      }, corsHeaders)
    }

    let started = 0
    let noCandidates = 0

    for (const job of jobs) {
      try {
        const { data: activeAttempts, error: activeAttemptsError } = await supabase
          .from('dispatch_attempts')
          .select('id')
          .eq('request_id', job.id)
          .eq('status', 'pending')
          .gt('expires_at', now.toISOString())
          .limit(1)

        if (activeAttemptsError) {
          await supabase.rpc('log_dispatch_event', {
            p_request_id: job.id,
            p_attempt_id: null,
            p_event_type: 'scheduled_active_attempt_lookup_failed',
            p_payload: { error: activeAttemptsError.message, retry_later: true },
          })
          continue
        }

        const activeAttemptRows = (activeAttempts as ActiveAttemptRow[] | null) ?? []
        const hasActiveAttempt = activeAttemptRows.length > 0

        if (hasActiveAttempt) {
          continue
        }

        if (job.smart_dispatch_state === 'assigned') {
          continue
        }

        const wasMarkedDispatchedWithoutLiveAttempt =
          job.dispatch_state === 'dispatched' || job.smart_dispatch_state === 'dispatching'

        const [{ count: attemptCount, error: attemptCountError }, { count: candidateCount, error: candidateCountError }] =
          await Promise.all([
            supabase
              .from('dispatch_attempts')
              .select('id', { count: 'exact', head: true })
              .eq('request_id', job.id),
            supabase
              .from('dispatch_candidates')
              .select('id', { count: 'exact', head: true })
              .eq('request_id', job.id),
          ])

        if (attemptCountError || candidateCountError) {
          await supabase.rpc('log_dispatch_event', {
            p_request_id: job.id,
            p_attempt_id: null,
            p_event_type: 'scheduled_dispatch_state_lookup_failed',
            p_payload: {
              attempts_error: attemptCountError?.message ?? null,
              candidates_error: candidateCountError?.message ?? null,
              retry_later: true,
            },
          })
          continue
        }

        if (wasMarkedDispatchedWithoutLiveAttempt) {
          await supabase
            .from('walk_requests')
            .update({
              dispatch_state: 'queued',
              smart_dispatch_state: 'idle',
              smart_dispatch_last_error: null,
              smart_dispatch_expires_at: null,
            })
            .eq('id', job.id)
            .eq('status', 'open')
            .is('walker_id', null)

          await supabase.rpc('log_dispatch_event', {
            p_request_id: job.id,
            p_attempt_id: null,
            p_event_type: 'scheduled_dead_dispatch_recovered',
            p_payload: {
              previous_dispatch_state: job.dispatch_state,
              previous_smart_dispatch_state: job.smart_dispatch_state,
              existing_attempt_count: attemptCount ?? 0,
              existing_candidate_count: candidateCount ?? 0,
              retrying_start_dispatch: true,
            },
          })
        }

        // 🔍 fetch online walkers
        const { data: walkers, error: walkersError } = await supabase
          .from('profiles')
          .select('id')
          .eq('role', 'walker')
          .eq('is_online', true)

        if (walkersError) {
          await supabase.rpc('log_dispatch_event', {
            p_request_id: job.id,
            p_attempt_id: null,
            p_event_type: 'scheduled_walker_lookup_failed',
            p_payload: { error: walkersError.message, retry_later: true },
          })
          continue
        }

        if (!walkers || walkers.length === 0) {
          // CRITICAL FIX: Don't cancel scheduled jobs when supply is unavailable
          // Instead, keep job alive and mark smart_dispatch_state as 'idle'
          // This allows cron to retry later when walkers come online
          const { error: updateError } = await supabase
            .from('walk_requests')
            .update({
              dispatch_state: 'queued',
              smart_dispatch_state: 'idle',
            })
            .eq('id', job.id)

          if (!updateError) {
            await supabase.rpc('log_dispatch_event', {
              p_request_id: job.id,
              p_attempt_id: null,
              p_event_type: 'scheduled_no_walkers_waiting',
              p_payload: { retry_later: true },
            })
            noCandidates++
          }
          continue
        }

        const ranked = (walkers as WalkerRow[]).map((w, i) => ({
          walkerId: w.id,
          score: 1 - i * 0.01,
          meta: { source: 'run-scheduled-dispatch' },
        }))

        await supabase.rpc('log_dispatch_event', {
          p_request_id: job.id,
          p_attempt_id: null,
          p_event_type: 'scheduled_dispatch_start_dispatch_invoked',
          p_payload: {
            candidate_count: ranked.length,
            timeout_seconds: DISPATCH_TIMEOUT_SECONDS,
          },
        })

        const startDispatchUrl = `${getEnv('SUPABASE_URL')}/functions/v1/start-dispatch`
        const startDispatchResponse = await fetch(startDispatchUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${getEnv('SUPABASE_SERVICE_ROLE_KEY')}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            requestId: job.id,
            rankedCandidates: ranked,
            timeoutSeconds: DISPATCH_TIMEOUT_SECONDS,
            resetExisting: true,
          }),
        })

        let startDispatchResult: StartDispatchResponse | null = null
        try {
          startDispatchResult = (await startDispatchResponse.json()) as StartDispatchResponse
        } catch {
          startDispatchResult = null
        }

        if (!startDispatchResponse.ok || !startDispatchResult?.ok) {
          const message =
            startDispatchResult?.error ??
            startDispatchResult?.details ??
            `start-dispatch returned ${startDispatchResponse.status}`

          await supabase
            .from('walk_requests')
            .update({
              dispatch_state: 'queued',
              smart_dispatch_state: 'idle',
              smart_dispatch_last_error: message,
              smart_dispatch_expires_at: null,
            })
            .eq('id', job.id)

          await supabase.rpc('log_dispatch_event', {
            p_request_id: job.id,
            p_attempt_id: null,
            p_event_type: 'scheduled_dispatch_failed',
            p_payload: {
              error: message,
              start_dispatch_status: startDispatchResponse.status,
              start_dispatch_result: startDispatchResult,
              retry_later: true,
            },
          })
          continue
        }

        await supabase.rpc('log_dispatch_event', {
          p_request_id: job.id,
          p_attempt_id: null,
          p_event_type: 'scheduled_dispatch_started',
          p_payload: {
            candidate_count: ranked.length,
            timeout_seconds: DISPATCH_TIMEOUT_SECONDS,
            start_dispatch_result: startDispatchResult,
          },
        })

        started++
      } catch (err) {
        console.error('scheduled dispatch error', err)
      }
    }

    return jsonResponse(200, {
      ok: true,
      scanned: jobs.length,
      started,
      noCandidates,
    }, corsHeaders)
  } catch (error) {
    return jsonResponse(500, {
      ok: false,
      error: 'Unexpected scheduled dispatch error',
      details: error instanceof Error ? error.message : String(error),
    }, corsHeaders)
  }
})
