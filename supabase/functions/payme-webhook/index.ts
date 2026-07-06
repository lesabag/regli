import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function jsonResponse(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  })
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' })
  }

  let payload: unknown
  try {
    payload = await req.json()
  } catch (error) {
    console.error('[payme-webhook] invalid_json', {
      error: error instanceof Error ? error.message : String(error),
    })
    return jsonResponse(400, { error: 'Invalid JSON payload' })
  }

  const normalizedPayload = payload && typeof payload === 'object'
    ? (payload as Record<string, unknown>)
    : {}
  const eventType =
    typeof normalizedPayload.type === 'string' ? normalizedPayload.type : null
  const externalEventId =
    typeof normalizedPayload.id === 'string' ? normalizedPayload.id : null

  console.log('[payme-webhook] received', {
    provider: 'payme',
    eventType,
    externalEventId,
  })

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

  if (supabaseUrl && serviceRoleKey) {
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey)
    const { error } = await supabaseAdmin
      .from('payment_events')
      .insert({
        provider: 'payme',
        event_type: eventType,
        external_event_id: externalEventId,
        payload: normalizedPayload,
        processed: false,
      })

    if (error) {
      console.error('[payme-webhook] payment_events_insert_failed', {
        provider: 'payme',
        eventType,
        externalEventId,
        error: error.message,
      })
    }
  } else {
    console.warn('[payme-webhook] missing_service_role_env')
  }

  // TODO(payme): verify webhook signatures once PayMe signs sandbox webhooks.
  // TODO(payme): route events into seller / payment / refund / payout handlers.
  return jsonResponse(200, {
    received: true,
    provider: 'payme',
    eventType,
    externalEventId,
  })
})
