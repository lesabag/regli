import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import Stripe from 'https://esm.sh/stripe@17.5.0?target=denonext'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const SERVICE_PRICES: Record<string, number> = {
  quick: 3000,
  standard: 5000,
  energy: 7000,
}

const PLATFORM_FEE_PERCENT = 20
const CURRENCY = 'usd'

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
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Missing authorization' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // User auth client — verifies the caller's JWT
    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: {
          Authorization: authHeader,
        },
      },
    })

    const { data: { user }, error: authError } = await supabaseUser.auth.getUser()
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Invalid token' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Service role client — for DB reads/writes that bypass RLS
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey)

    // Parse request body
    let body: {
      dogName?: string
      location?: string
      notes?: string
      serviceType?: string
      walkerId?: string
    }
    try {
      body = await req.json()
    } catch {
      return new Response(
        JSON.stringify({ error: 'Invalid request body' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const { dogName, location, notes, serviceType, walkerId } = body

    if (!serviceType || !SERVICE_PRICES[serviceType]) {
      return new Response(
        JSON.stringify({ error: 'Invalid service type. Must be: quick, standard, or energy' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!walkerId) {
      return new Response(
        JSON.stringify({ error: 'Missing walkerId' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!dogName?.trim()) {
      return new Response(
        JSON.stringify({ error: 'Missing dog name' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!location?.trim()) {
      return new Response(
        JSON.stringify({ error: 'Missing location' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Verify the client profile exists
    const { data: clientProfile, error: clientError } = await supabaseAdmin
      .from('profiles')
      .select('id, role')
      .eq('id', user.id)
      .single()

    if (clientError || !clientProfile) {
      return new Response(
        JSON.stringify({ error: 'Client profile not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (clientProfile.role !== 'client') {
      return new Response(
        JSON.stringify({ error: 'Only clients can create payment intents' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Verify the selected walker is payout-ready
    const { data: walkerProfile, error: walkerError } = await supabaseAdmin
      .from('profiles')
      .select('id, role, stripe_connect_account_id, charges_enabled, payouts_enabled')
      .eq('id', walkerId)
      .single()

    if (walkerError || !walkerProfile) {
      return new Response(
        JSON.stringify({ error: 'Walker not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (walkerProfile.role !== 'walker') {
      return new Response(
        JSON.stringify({ error: 'Selected user is not a walker' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!walkerProfile.stripe_connect_account_id) {
      return new Response(
        JSON.stringify({ error: 'Walker has not connected a payout account' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!walkerProfile.charges_enabled) {
      return new Response(
        JSON.stringify({ error: 'Walker account is not ready to accept charges' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!walkerProfile.payouts_enabled) {
      return new Response(
        JSON.stringify({ error: 'Walker account is not ready to receive payouts' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Calculate amounts (all in agorot — smallest ILS unit)
    const amount = SERVICE_PRICES[serviceType] // already in agorot
    const platformFee = Math.round(amount * PLATFORM_FEE_PERCENT / 100)
    const walkerAmount = amount - platformFee

    // Idempotency guard: check for duplicate job created in last 60 seconds
    const sixtySecondsAgo = new Date(Date.now() - 60_000).toISOString()
    const { data: existingJob } = await supabaseAdmin
      .from('walk_requests')
      .select('id, stripe_payment_intent_id, stripe_client_secret')
      .eq('client_id', user.id)
      .eq('selected_walker_id', walkerId)
      .eq('dog_name', dogName.trim())
      .eq('status', 'awaiting_payment')
      .gte('created_at', sixtySecondsAgo)
      .limit(1)
      .maybeSingle()

    if (existingJob) {
      return new Response(
        JSON.stringify({
          jobId: existingJob.id,
          paymentIntentId: existingJob.stripe_payment_intent_id,
          clientSecret: existingJob.stripe_client_secret,
          amount,
          platformFee,
          walkerAmount,
          paymentStatus: 'requires_payment_method',
          duplicate: true,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Create the Stripe PaymentIntent (Separate Charges and Transfers model)
    // Platform owns the charge; transfer to walker happens after capture
    const stripe = new Stripe(stripeKey, { apiVersion: '2024-12-18.acacia' })

    let paymentIntent: Stripe.PaymentIntent
    try {
      paymentIntent = await stripe.paymentIntents.create({
        amount,
        currency: CURRENCY,
        capture_method: 'manual',
        transfer_group: `job_${Date.now()}`, // will be updated to job ID after insert
        metadata: {
          client_id: user.id,
          walker_id: walkerId,
          service_type: serviceType,
          dog_name: dogName.trim(),
        },
      })
    } catch (stripeErr: unknown) {
      console.error('Stripe PaymentIntent creation failed:', stripeErr)
      return new Response(
        JSON.stringify({ error: 'Failed to create payment' }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Create the job in walk_requests
    const { data: job, error: jobError } = await supabaseAdmin
      .from('walk_requests')
      .insert({
        client_id: user.id,
        selected_walker_id: walkerId,
        dog_name: dogName.trim(),
        location: location.trim(),
        notes: notes?.trim() || null,
        status: 'awaiting_payment',
        payment_status: 'unpaid',
        amount,
        currency: CURRENCY,
        platform_fee_percent: PLATFORM_FEE_PERCENT,
        platform_fee: platformFee / 100, // store as ILS (decimal)
        walker_amount: walkerAmount / 100, // store as ILS (decimal)
        walker_earnings: walkerAmount / 100, // keep backwards compat
        price: amount / 100, // store as ILS (decimal) for backwards compat
        stripe_payment_intent_id: paymentIntent.id,
        stripe_client_secret: paymentIntent.client_secret,
      })
      .select('id')
      .single()

    if (jobError || !job) {
      console.error('Failed to create job:', jobError)
      // Attempt to cancel the PaymentIntent since we couldn't save the job
      try {
        await stripe.paymentIntents.cancel(paymentIntent.id)
      } catch (cancelErr) {
        console.error('Failed to cancel orphaned PaymentIntent:', cancelErr)
      }
      return new Response(
        JSON.stringify({ error: 'Failed to create job' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Update PaymentIntent transfer_group and metadata with real job ID
    try {
      await stripe.paymentIntents.update(paymentIntent.id, {
        transfer_group: job.id,
        metadata: {
          ...paymentIntent.metadata,
          job_id: job.id,
        },
      })
    } catch (updateErr) {
      console.error('Failed to update PI with job ID (non-blocking):', updateErr)
    }

    return new Response(
      JSON.stringify({
        jobId: job.id,
        paymentIntentId: paymentIntent.id,
        clientSecret: paymentIntent.client_secret,
        amount,
        platformFee,
        walkerAmount,
        paymentStatus: paymentIntent.status,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    console.error('create-payment-intent error:', err)
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
