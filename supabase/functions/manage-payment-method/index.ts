import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import Stripe from 'https://esm.sh/stripe@17.5.0?target=denonext'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

/**
 * Manages Stripe customers and payment methods for clients.
 *
 * Actions:
 *   get-or-create-customer — ensures a Stripe customer exists, returns saved payment methods
 *   create-setup-intent    — creates a SetupIntent for adding a new card
 *   detach-payment-method  — removes a saved payment method
 */
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

    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    })

    const { data: { user }, error: authError } = await supabaseUser.auth.getUser()
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Invalid token' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey)
    const stripe = new Stripe(stripeKey, { apiVersion: '2024-12-18.acacia' })

    let body: { action?: string; paymentMethodId?: string }
    try {
      body = await req.json()
    } catch {
      return new Response(
        JSON.stringify({ error: 'Invalid request body' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const { action } = body

    // ── Helper: get or create Stripe customer ────────────────
    async function ensureCustomer(): Promise<{ customerId: string; isNew: boolean }> {
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('stripe_customer_id, email, full_name')
        .eq('id', user!.id)
        .single()

      if (profile?.stripe_customer_id) {
        return { customerId: profile.stripe_customer_id, isNew: false }
      }

      const customer = await stripe.customers.create({
        email: user!.email ?? profile?.email ?? undefined,
        name: profile?.full_name ?? undefined,
        metadata: { supabase_user_id: user!.id },
      })

      await supabaseAdmin
        .from('profiles')
        .update({ stripe_customer_id: customer.id })
        .eq('id', user!.id)

      return { customerId: customer.id, isNew: true }
    }

    // ── Action: get-or-create-customer ───────────────────────
    if (action === 'get-or-create-customer') {
      const { customerId } = await ensureCustomer()

      const methods = await stripe.paymentMethods.list({
        customer: customerId,
        type: 'card',
      })

      const cards = methods.data.map((pm) => ({
        id: pm.id,
        brand: pm.card?.brand ?? 'unknown',
        last4: pm.card?.last4 ?? '****',
        expMonth: pm.card?.exp_month,
        expYear: pm.card?.exp_year,
      }))

      return new Response(
        JSON.stringify({ customerId, cards }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── Action: create-setup-intent ──────────────────────────
    if (action === 'create-setup-intent') {
      const { customerId } = await ensureCustomer()

      const setupIntent = await stripe.setupIntents.create({
        customer: customerId,
        payment_method_types: ['card'],
        metadata: { supabase_user_id: user.id },
      })

      return new Response(
        JSON.stringify({ clientSecret: setupIntent.client_secret }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── Action: detach-payment-method ────────────────────────
    if (action === 'detach-payment-method') {
      const { paymentMethodId } = body
      if (!paymentMethodId) {
        return new Response(
          JSON.stringify({ error: 'Missing paymentMethodId' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      // Verify the payment method belongs to the user's customer
      const { customerId } = await ensureCustomer()
      const pm = await stripe.paymentMethods.retrieve(paymentMethodId)
      if (pm.customer !== customerId) {
        return new Response(
          JSON.stringify({ error: 'Payment method not found' }),
          { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      await stripe.paymentMethods.detach(paymentMethodId)

      return new Response(
        JSON.stringify({ success: true }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    return new Response(
      JSON.stringify({ error: 'Unknown action. Use: get-or-create-customer, create-setup-intent, detach-payment-method' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    console.error('manage-payment-method error:', err)
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
