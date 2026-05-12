import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import Stripe from 'https://esm.sh/stripe@17.5.0?target=denonext'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const PROVIDER_ISSUE_MARKER = '[SYSTEM:PROVIDER_REPORTED_ISSUE]'

type ReviewProviderIssueBody = {
  jobId?: string
  action?: 'resume' | 'cancel'
}

function hasProviderIssue(notes: string | null | undefined): boolean {
  return typeof notes === 'string'
    ? notes.split('\n').some((line) => line.trim().startsWith(PROVIDER_ISSUE_MARKER))
    : false
}

function removeProviderIssueMarker(notes: string | null | undefined): string | null {
  if (typeof notes !== 'string') return null
  const nextNotes = notes
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => !line.trim().startsWith(PROVIDER_ISSUE_MARKER))
    .join('\n')
    .trim()

  return nextNotes || null
}

async function createNotification(
  supabaseAdmin: ReturnType<typeof createClient>,
  params: { userId: string | null | undefined; type: string; title: string; message: string; relatedJobId: string },
) {
  if (!params.userId) return
  const { error } = await supabaseAdmin.from('notifications').insert({
    user_id: params.userId,
    type: params.type,
    title: params.title,
    message: params.message,
    related_job_id: params.relatedJobId,
  })

  if (error && error.code !== '23505') {
    console.error('[review-provider-issue] notification insert failed', {
      request_id: params.relatedJobId,
      user_id: params.userId,
      type: params.type,
      error: error.message,
    })
  }
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

    if (!stripeKey || !supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
      console.error('[review-provider-issue] misconfigured env', { action: 'bootstrap', result: 'error' })
      return new Response(
        JSON.stringify({ error: 'Server misconfigured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Missing authorization' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    })

    const {
      data: { user },
      error: authError,
    } = await supabaseUser.auth.getUser()

    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Invalid token' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey)
    const { data: callerProfile } = await supabaseAdmin
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single()

    if (!callerProfile || callerProfile.role !== 'admin') {
      return new Response(
        JSON.stringify({ error: 'Admin only' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    let body: ReviewProviderIssueBody
    try {
      body = await req.json()
    } catch {
      return new Response(
        JSON.stringify({ error: 'Invalid request body' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const jobId = typeof body.jobId === 'string' ? body.jobId.trim() : ''
    const action = body.action === 'resume' || body.action === 'cancel' ? body.action : null

    if (!jobId || !action) {
      return new Response(
        JSON.stringify({ error: 'Missing jobId or action' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const { data: job, error: jobError } = await supabaseAdmin
      .from('walk_requests')
      .select('id, client_id, walker_id, status, payment_status, stripe_payment_intent_id, notes, service_started_at, service_completed_at, dispatch_state, smart_dispatch_state')
      .eq('id', jobId)
      .maybeSingle()

    if (jobError) {
      console.error('[review-provider-issue] job lookup failed', {
        request_id: jobId,
        action,
        result: 'error',
        error: jobError.message,
      })
      return new Response(
        JSON.stringify({ error: 'Job lookup failed', details: jobError.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    if (!job) {
      return new Response(
        JSON.stringify({ error: 'Job not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    if (!hasProviderIssue(job.notes)) {
      return new Response(
        JSON.stringify({ error: 'Job does not have an open provider issue' }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    if (job.service_started_at || job.service_completed_at) {
      return new Response(
        JSON.stringify({ error: 'Provider issue can only be reviewed before service starts' }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    if (action === 'resume') {
      const nextNotes = removeProviderIssueMarker(job.notes)
      const { error: resumeError } = await supabaseAdmin
        .from('walk_requests')
        .update({ notes: nextNotes })
        .eq('id', jobId)

      if (resumeError) {
        console.error('[review-provider-issue] resume failed', {
          request_id: jobId,
          action,
          result: 'error',
          error: resumeError.message,
        })
        return new Response(
          JSON.stringify({ error: 'Failed to resume service', details: resumeError.message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        )
      }

      await Promise.all([
        createNotification(supabaseAdmin, {
          userId: job.walker_id,
          type: 'provider_issue_resolved',
          title: 'Support resumed service',
          message: 'Support reviewed the issue. You can start the service again.',
          relatedJobId: jobId,
        }),
        createNotification(supabaseAdmin, {
          userId: job.client_id,
          type: 'provider_issue_resolved',
          title: 'Service resumed',
          message: 'Support reviewed the provider issue. The service can continue.',
          relatedJobId: jobId,
        }),
      ])

      console.log('[review-provider-issue] success', {
        request_id: jobId,
        action,
        result: 'resumed',
      })

      return new Response(
        JSON.stringify({ success: true, jobId, action, status: job.status, paymentStatus: job.payment_status }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const stripe = new Stripe(stripeKey, { apiVersion: '2024-12-18.acacia' })
    if (job.stripe_payment_intent_id) {
      const pi = await stripe.paymentIntents.retrieve(job.stripe_payment_intent_id)
      if (
        pi.status === 'requires_capture' ||
        pi.status === 'requires_confirmation' ||
        pi.status === 'requires_payment_method'
      ) {
        await stripe.paymentIntents.cancel(job.stripe_payment_intent_id)
      } else if (pi.status !== 'canceled') {
        return new Response(
          JSON.stringify({
            error: 'PaymentIntent cannot be safely canceled',
            details: `PaymentIntent status is '${pi.status}'.`,
          }),
          { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        )
      }
    }

    const { error: cancelError } = await supabaseAdmin
      .from('walk_requests')
      .update({
        status: 'cancelled',
        payment_status: 'failed',
        dispatch_state: 'cancelled',
        smart_dispatch_state: 'cancelled',
        notes: removeProviderIssueMarker(job.notes),
      })
      .eq('id', jobId)

    if (cancelError) {
      console.error('[review-provider-issue] cancel failed', {
        request_id: jobId,
        action,
        result: 'error',
        error: cancelError.message,
      })
      return new Response(
        JSON.stringify({ error: 'Failed to cancel request', details: cancelError.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    await Promise.all([
      createNotification(supabaseAdmin, {
        userId: job.walker_id,
        type: 'provider_issue_cancelled',
        title: 'Request cancelled',
        message: 'Support cancelled this request after reviewing the reported issue.',
        relatedJobId: jobId,
      }),
      createNotification(supabaseAdmin, {
        userId: job.client_id,
        type: 'provider_issue_cancelled',
        title: 'Request cancelled',
        message: 'Support cancelled the request after reviewing the provider issue.',
        relatedJobId: jobId,
      }),
    ])

    console.log('[review-provider-issue] success', {
      request_id: jobId,
      action,
      result: 'cancelled',
    })

    return new Response(
      JSON.stringify({ success: true, jobId, action, status: 'cancelled', paymentStatus: 'failed' }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  } catch (err) {
    console.error('[review-provider-issue] unhandled', {
      action: 'unknown',
      result: 'error',
      error: err instanceof Error ? err.message : 'Unknown',
    })
    return new Response(
      JSON.stringify({
        error: 'Internal server error',
        details: err instanceof Error ? err.message : 'Unknown',
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }
})
