import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import Stripe from 'https://esm.sh/stripe@17.5.0?target=denonext'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const COMPLETION_REVIEW_MARKER = '[SYSTEM:COMPLETION_DISPUTED]'

function isCompletionReviewRequired(notes: string | null | undefined): boolean {
  return typeof notes === 'string'
    ? notes
        .split('\n')
        .some((line) => line.trim().startsWith(COMPLETION_REVIEW_MARKER))
    : false
}

function removeCompletionReviewMarker(notes: string | null | undefined): string | null {
  if (typeof notes !== 'string') return null
  const nextNotes = notes
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => !line.trim().startsWith(COMPLETION_REVIEW_MARKER))
    .join('\n')
    .trim()

  return nextNotes || null
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

    let body: { jobId?: string }
    try {
      body = await req.json()
    } catch {
      return new Response(
        JSON.stringify({ error: 'Invalid request body' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const jobId = typeof body.jobId === 'string' ? body.jobId.trim() : ''
    if (!jobId) {
      return new Response(
        JSON.stringify({ error: 'Missing jobId' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const { data: job, error: jobError } = await supabaseAdmin
      .from('walk_requests')
      .select('id, status, payment_status, stripe_payment_intent_id, booking_timing, dispatch_state, smart_dispatch_state, notes')
      .eq('id', jobId)
      .maybeSingle()

    if (jobError) {
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

    if (!isCompletionReviewRequired(job.notes)) {
      return new Response(
        JSON.stringify({ error: 'Job is not currently disputed' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    if (job.payment_status === 'paid' || job.status === 'completed') {
      return new Response(
        JSON.stringify({
          error: 'Job was already completed and paid',
          details: 'Use refunds/manual remediation for already captured disputes.',
        }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const stripe = new Stripe(stripeKey, { apiVersion: '2024-12-18.acacia' })

    if (job.stripe_payment_intent_id) {
      const pi = await stripe.paymentIntents.retrieve(job.stripe_payment_intent_id)
      if (pi.status === 'requires_capture' || pi.status === 'requires_confirmation' || pi.status === 'requires_payment_method') {
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

    const { error: updateError } = await supabaseAdmin
      .from('walk_requests')
      .update({
        status: 'cancelled',
        payment_status: 'failed',
        dispatch_state: 'cancelled',
        smart_dispatch_state: 'cancelled',
        notes: removeCompletionReviewMarker(job.notes),
      })
      .eq('id', jobId)

    if (updateError) {
      return new Response(
        JSON.stringify({ error: 'Failed to update job', details: updateError.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    return new Response(
      JSON.stringify({
        success: true,
        jobId,
        status: 'cancelled',
        paymentStatus: 'failed',
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: 'Internal server error',
        details: err instanceof Error ? err.message : 'Unknown',
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }
})
