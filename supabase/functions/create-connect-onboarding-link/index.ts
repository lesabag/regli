import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import Stripe from 'https://esm.sh/stripe@17.5.0?target=denonext'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function normalizeBaseUrl(
  value: string | null | undefined,
  options?: { allowLocalhost?: boolean },
): string | null {
  const raw = String(value ?? '').trim()
  if (!raw) return null

  const withProtocol =
    raw.startsWith('http://') || raw.startsWith('https://') ? raw : `https://${raw}`

  try {
    const url = new URL(withProtocol)
    const host = url.hostname.toLowerCase()
    if (
      !options?.allowLocalhost &&
      (host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '0.0.0.0' ||
        host.endsWith('.local'))
    ) {
      return null
    }
    return url.toString().replace(/\/+$/, '')
  } catch {
    return null
  }
}

function resolvePublicAppBaseUrl(): { baseUrl: string | null; source: string | null } {
  const allowLocalhost = Deno.env.get('ALLOW_LOCALHOST_STRIPE_CONNECT_URLS') === 'true'

  const envCandidates: Array<{ source: string; value: string | null | undefined }> = [
    { source: 'APP_PUBLIC_URL', value: Deno.env.get('APP_PUBLIC_URL') },
    { source: 'PUBLIC_APP_URL', value: Deno.env.get('PUBLIC_APP_URL') },
    { source: 'SITE_URL', value: Deno.env.get('SITE_URL') },
    { source: 'VITE_APP_URL', value: Deno.env.get('VITE_APP_URL') },
    { source: 'VITE_PUBLIC_APP_URL', value: Deno.env.get('VITE_PUBLIC_APP_URL') },
  ]

  for (const candidate of envCandidates) {
    const normalized = normalizeBaseUrl(candidate.value, { allowLocalhost })
    if (normalized) {
      return { baseUrl: normalized, source: candidate.source }
    }
  }

  return { baseUrl: null, source: null }
}

function buildConnectRouteUrl(baseUrl: string, kind: 'return' | 'refresh'): string {
  const url = new URL('/', baseUrl)
  url.searchParams.set('stripe_connect', kind)
  return url.toString()
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const requestBody = await req.json().catch(() => ({}))
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const { baseUrl, source } = resolvePublicAppBaseUrl()

    if (!stripeKey || !supabaseUrl || !serviceRoleKey) {
      return new Response(
        JSON.stringify({
          error: 'Server misconfigured',
        }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!baseUrl) {
      return new Response(
        JSON.stringify({
          error: 'Missing public app URL for Stripe onboarding return URL',
        }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const refreshUrl = buildConnectRouteUrl(baseUrl, 'refresh')
    const returnUrl = buildConnectRouteUrl(baseUrl, 'return')
    console.log('create-connect-onboarding-link URL selection:', {
      source,
      baseUrl,
      fromEnv: !!source,
      refreshUrl,
      returnUrl,
    })

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Missing authorization' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey)

    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Invalid token' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, role, stripe_connect_account_id')
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
        JSON.stringify({ error: 'Only walkers can access connect onboarding' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const accountId = profile.stripe_connect_account_id as string | null
    if (!accountId) {
      return new Response(
        JSON.stringify({ error: 'No Stripe Connect account found. Create one first.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const stripe = new Stripe(stripeKey, { apiVersion: '2024-12-18.acacia' })

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type: 'account_onboarding',
    })

    return new Response(
      JSON.stringify({ url: accountLink.url }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    console.error('create-connect-onboarding-link error:', err)
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
