import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { corsHeaders } from '../_shared/cors.ts'
import {
  createAdminClient,
  jsonResponse,
  normalizeTimeoutSeconds,
} from '../_shared/dispatch.ts'

type AdvanceDispatchBody = {
  requestId?: string
  timeoutSeconds?: number
  limit?: number
}

type PendingAttemptRow = {
  request_id: string
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    if (req.method !== 'POST') {
      return jsonResponse(405, { ok: false, error: 'Method not allowed' }, corsHeaders)
    }

    const body = (await req.json().catch(() => ({}))) as AdvanceDispatchBody
    const requestId = String(body.requestId ?? '').trim()
    const timeoutSeconds = normalizeTimeoutSeconds(body.timeoutSeconds, 20)
    const limit =
      typeof body.limit === 'number' && Number.isFinite(body.limit)
        ? Math.max(1, Math.min(200, Math.floor(body.limit)))
        : 50

    const supabase = createAdminClient()

    if (requestId) {
      console.log('[advance-dispatch] single request advance', {
        requestId,
        timeoutSeconds,
      })

      const { data, error } = await supabase.rpc('advance_dispatch_request', {
        p_request_id: requestId,
        p_timeout_seconds: timeoutSeconds,
      })

      if (error) {
        console.error('[advance-dispatch] failed single request advance', {
          requestId,
          timeoutSeconds,
          error: error.message,
        })
        return jsonResponse(
          500,
          {
            ok: false,
            error: 'failed to advance dispatch request',
            details: error.message,
          },
          corsHeaders,
        )
      }

      return jsonResponse(
        200,
        {
          ok: true,
          mode: 'single',
          requestId,
          result: data,
        },
        corsHeaders,
      )
    }

    const nowIso = new Date().toISOString()

    const { data: expiredRows, error: expiredQueryError } = await supabase
      .from('active_dispatch_offers')
      .select('request_id, expires_at, request_status')
      .eq('status', 'pending')
      .eq('request_status', 'open')
      .lte('expires_at', nowIso)
      .order('expires_at', { ascending: true })
      .limit(limit)

    if (expiredQueryError) {
      return jsonResponse(
        500,
        {
          ok: false,
          error: 'failed to fetch expired attempts',
          details: expiredQueryError.message,
        },
        corsHeaders,
      )
    }

    const uniqueRequestIds = [
      ...new Set((expiredRows ?? []).map((row: PendingAttemptRow) => row.request_id)),
    ]

    const results: Array<Record<string, unknown>> = []

    for (const expiredRequestId of uniqueRequestIds) {
      console.log('[advance-dispatch] batch request advance', {
        requestId: expiredRequestId,
        timeoutSeconds,
      })

      const { data, error } = await supabase.rpc('advance_dispatch_request', {
        p_request_id: expiredRequestId,
        p_timeout_seconds: timeoutSeconds,
      })

      if (error) {
        console.error('[advance-dispatch] failed batch request advance', {
          requestId: expiredRequestId,
          timeoutSeconds,
          error: error.message,
        })
      } else {
        console.log('[advance-dispatch] batch request advance result', {
          requestId: expiredRequestId,
          timeoutSeconds,
          result: data,
        })
      }

      results.push({
        requestId: expiredRequestId,
        ok: !error,
        result: error ? null : data,
        error: error?.message ?? null,
      })
    }

    return jsonResponse(
      200,
      {
        ok: true,
        mode: 'batch',
        timeoutSeconds,
        scannedCount: uniqueRequestIds.length,
        results,
      },
      corsHeaders,
    )
  } catch (error) {
    return jsonResponse(
      500,
      {
        ok: false,
        error: 'Unexpected advance-dispatch error',
        details: error instanceof Error ? error.message : String(error),
      },
      corsHeaders,
    )
  }
})
