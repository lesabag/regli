import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { corsHeaders } from '../_shared/cors.ts'
import {
  createAdminClient,
  jsonResponse,
  normalizeTimeoutSeconds,
  requireAuthUser,
} from '../_shared/dispatch.ts'

type DeclineDispatchBody = {
  requestId?: string
  attemptId?: string
  timeoutSeconds?: number
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    if (req.method !== 'POST') {
      return jsonResponse(405, { ok: false, error: 'Method not allowed' }, corsHeaders)
    }

    const { userId } = await requireAuthUser(req)
    if (!userId) {
      return jsonResponse(401, { ok: false, error: 'Unauthorized' }, corsHeaders)
    }

    const body = (await req.json()) as DeclineDispatchBody
    const requestId = String(body.requestId ?? '').trim()
    const attemptId = String(body.attemptId ?? '').trim()
    const timeoutSeconds = normalizeTimeoutSeconds(body.timeoutSeconds, 20)

    if (!requestId || !attemptId) {
      return jsonResponse(
        400,
        {
          ok: false,
          error: 'requestId and attemptId are required',
        },
        corsHeaders,
      )
    }

    const supabase = createAdminClient()

    const { data, error } = await supabase.rpc('decline_dispatch_attempt', {
      p_request_id: requestId,
      p_attempt_id: attemptId,
      p_walker_id: userId,
      p_timeout_seconds: timeoutSeconds,
    })

    if (error) {
      return jsonResponse(
        500,
        {
          ok: false,
          error: 'failed to decline dispatch attempt',
          details: error.message,
        },
        corsHeaders,
      )
    }

    return jsonResponse(
      200,
      {
        ok: true,
        result: data,
      },
      corsHeaders,
    )
  } catch (error) {
    return jsonResponse(
      500,
      {
        ok: false,
        error: 'Unexpected decline-dispatch error',
        details: error instanceof Error ? error.message : String(error),
      },
      corsHeaders,
    )
  }
})
