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

    const { data: requestRow, error: requestError } = await supabase
      .from('walk_requests')
      .select('id, status, payment_status, stripe_payment_intent_id')
      .eq('id', requestId)
      .single()

    if (requestError || !requestRow) {
      return jsonResponse(
        404,
        {
          ok: false,
          error: 'walk_request not found',
          details: requestError?.message,
        },
        corsHeaders,
      )
    }

    if (
      requestRow.status !== 'open' ||
      requestRow.payment_status !== 'authorized' ||
      !requestRow.stripe_payment_intent_id
    ) {
      if (requestRow.payment_status === 'failed' || requestRow.payment_status === 'refunded') {
        await supabase
          .from('walk_requests')
          .update({
            status: 'cancelled',
            dispatch_state: 'cancelled',
            smart_dispatch_state: 'cancelled',
            smart_dispatch_last_error: 'payment authorization missing',
          })
          .eq('id', requestId)
          .in('status', ['open', 'accepted'])
      }

      return jsonResponse(
        409,
        {
          ok: false,
          error: 'payment authorization required before accepting',
          result: {
            ok: false,
            code: 'payment_not_authorized',
            status: requestRow.status,
            payment_status: requestRow.payment_status,
          },
        },
        corsHeaders,
      )
    }

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
