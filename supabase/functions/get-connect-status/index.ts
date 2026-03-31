import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import Stripe from 'https://esm.sh/stripe@17.5.0?target=denonext'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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

    // User auth client — uses the caller's JWT to verify identity
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

    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('id, role, stripe_connect_account_id, stripe_connect_onboarding_complete, payouts_enabled, charges_enabled')
      .eq('id', user.id)
      .single()

    if (profileError || !profile) {
      return new Response(
        JSON.stringify({ error: 'Profile not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (profile.role !== 'walker') {
      return new Response(
        JSON.stringify({ error: 'Only walkers can access connect status' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const accountId = profile.stripe_connect_account_id as string | null
    if (!accountId) {
      return new Response(
        JSON.stringify({
          connected: false,
          stripe_connect_account_id: null,
          stripe_connect_onboarding_complete: false,
          payouts_enabled: false,
          charges_enabled: false,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const stripe = new Stripe(stripeKey, { apiVersion: '2024-12-18.acacia' })

    // Fetch live status from Stripe
    const account = await stripe.accounts.retrieve(accountId)

    const onboardingComplete = account.details_submitted ?? false
    const payoutsEnabled = account.payouts_enabled ?? false
    const chargesEnabled = account.charges_enabled ?? false

    // Sync back to Supabase
    const { error: updateError } = await supabaseAdmin
      .from('profiles')
      .update({
        stripe_connect_onboarding_complete: onboardingComplete,
        stripe_details_submitted: onboardingComplete,
        payouts_enabled: payoutsEnabled,
        charges_enabled: chargesEnabled,
      })
      .eq('id', user.id)

    if (updateError) {
      console.error('Failed to sync connect status:', updateError)
    }

    return new Response(
      JSON.stringify({
        connected: true,
        stripe_connect_account_id: accountId,
        stripe_connect_onboarding_complete: onboardingComplete,
        payouts_enabled: payoutsEnabled,
        charges_enabled: chargesEnabled,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    console.error('get-connect-status error:', err)
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
