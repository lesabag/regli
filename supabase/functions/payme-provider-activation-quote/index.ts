import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import { resolveActivationFeeQuote } from '../_shared/activationFeeConfig.ts'

// Authoritative Provider Account Activation Fee quote.
//
// This is the ONE place the client learns the fee amount. The exact gross returned
// here is the SAME value payme-authorize-provider-activation charges via J5 — both
// derive from _shared/activationFeeConfig.ts. The client never computes the amount
// itself; it only formats what this endpoint returns.
//
// SECURITY: requires an authenticated provider (JWT). Returns only safe numeric
// config — no secrets, no PayMe credentials. It performs NO PayMe call and creates
// nothing, so it is NOT gated behind PAYME_SELLER_ONBOARDING_ENABLED.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function fail(code: string, message: string, status: number): Response {
  return json({ success: false, code, message }, status)
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')
    if (!supabaseUrl || !supabaseAnonKey) {
      return fail('SERVER_MISCONFIGURED', 'Server misconfigured', 500)
    }

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return fail('UNAUTHENTICATED', 'Missing authorization', 401)

    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    })
    const {
      data: { user },
      error: authError,
    } = await supabaseUser.auth.getUser()
    if (authError || !user) return fail('UNAUTHENTICATED', 'Invalid token', 401)

    const quote = resolveActivationFeeQuote((key) => Deno.env.get(key))
    if (!quote) {
      return fail('ACTIVATION_FEE_MISCONFIGURED', 'Activation fee is not configured', 500)
    }

    return json({ success: true, ...quote }, 200)
  } catch (err) {
    console.error('payme-activation-quote error:', err instanceof Error ? err.message : 'unknown')
    return fail('INTERNAL_ERROR', 'Internal server error', 500)
  }
})
