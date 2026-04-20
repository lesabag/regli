import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { corsHeaders } from '../_shared/cors.ts'
import {
  createAdminClient,
  jsonResponse,
  requireAuthUser,
} from '../_shared/dispatch.ts'

type AcceptDispatchBody = {
  requestId?: string
  attemptId?: string
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

    const body = (await req.json()) as AcceptDispatchBody
    const requestId = String(body.requestId ?? '').trim()
    const attemptId = String(body.attemptId ?? '').trim()

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

    const { data, error } = await supabase.rpc('accept_dispatch_attempt', {
      p_request_id: requestId,
      p_attempt_id: attemptId,
      p_walker_id: userId,
    })

    if (error) {
      return jsonResponse(
        500,
        {
          ok: false,
          error: 'failed to accept dispatch attempt',
          details: error.message,
        },
        corsHeaders,
      )
    }

    const result = Array.isArray(data) ? data[0] : (data as { ok?: boolean } | null)

    if (!result?.ok) {
      return jsonResponse(
        409,
        {
          ok: false,
          result,
        },
        corsHeaders,
      )
    }

    return jsonResponse(
      200,
      {
        ok: true,
        result,
      },
      corsHeaders,
    )
  } catch (error) {
    return jsonResponse(
      500,
      {
        ok: false,
        error: 'Unexpected accept-dispatch error',
        details: error instanceof Error ? error.message : String(error),
      },
      corsHeaders,
    )
  }
})
