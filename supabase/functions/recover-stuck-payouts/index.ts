import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import Stripe from 'https://esm.sh/stripe@17.5.0?target=denonext'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const STUCK_THRESHOLD_MINUTES = 15

/**
 * Recover payouts stuck in "processing" status for more than 15 minutes.
 * - If a Stripe transfer exists, repair the DB to match Stripe state.
 * - If no transfer exists, move to "failed" with retry scheduling.
 *
 * Can be called by admin manually or via cron.
 * Body (optional): { dryRun?: boolean }
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

    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey)

    // Allow service_role key for cron calls; otherwise require admin user
    const token = authHeader.replace('Bearer ', '')
    const isCron = token === serviceRoleKey

    if (!isCron) {
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

      const { data: callerProfile } = await supabaseAdmin
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .single()

      if (!callerProfile || callerProfile.role !== 'admin') {
        return new Response(
          JSON.stringify({ error: 'Admin only' }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
    }

    let dryRun = false
    try {
      const body = await req.json()
      dryRun = body?.dryRun === true
    } catch {
      // No body or invalid JSON — proceed with dryRun=false
    }

    // Find payouts stuck in processing for > threshold
    const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MINUTES * 60 * 1000).toISOString()

    const { data: stuckPayouts, error: queryErr } = await supabaseAdmin
      .from('walker_payouts')
      .select('id, walker_id, job_id, status, stripe_transfer_id, updated_at, created_at, retry_count, net_amount, currency')
      .eq('status', 'processing')
      .lt('updated_at', cutoff)
      .order('updated_at', { ascending: true })
      .limit(20)

    if (queryErr) {
      console.error('[recover-stuck] Query failed:', queryErr)
      return new Response(
        JSON.stringify({ error: 'Failed to query stuck payouts' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!stuckPayouts || stuckPayouts.length === 0) {
      console.log('[recover-stuck] No stuck payouts found')
      return new Response(
        JSON.stringify({ recovered: 0, results: [] }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log(`[recover-stuck] Found ${stuckPayouts.length} stuck payouts`)

    const stripe = new Stripe(stripeKey, { apiVersion: '2024-12-18.acacia' })
    const results: Array<{
      payoutId: string
      jobId: string
      action: string
      stripeTransferId?: string
    }> = []

    for (const payout of stuckPayouts) {
      const logCtx = { payoutId: payout.id, jobId: payout.job_id }

      // Check if a transfer exists in Stripe for this job
      let stripeTransfer: Stripe.Transfer | null = null

      if (payout.stripe_transfer_id) {
        // DB has a transfer_id but status is still processing — repair
        try {
          stripeTransfer = await stripe.transfers.retrieve(payout.stripe_transfer_id)
        } catch (err) {
          console.error('[recover-stuck] Failed to retrieve transfer:', logCtx, err)
        }
      } else {
        // No transfer_id — search by transfer_group (job_id)
        try {
          const transfers = await stripe.transfers.list({
            transfer_group: payout.job_id,
            limit: 1,
          })
          if (transfers.data.length > 0) {
            stripeTransfer = transfers.data[0]
          }
        } catch (err) {
          console.error('[recover-stuck] Failed to search transfers:', logCtx, err)
        }
      }

      if (stripeTransfer) {
        // Transfer exists in Stripe — repair DB to match
        console.log('[recover-stuck] Repairing:', logCtx, 'transfer:', stripeTransfer.id)

        if (!dryRun) {
          await supabaseAdmin
            .from('walker_payouts')
            .update({
              stripe_transfer_id: stripeTransfer.id,
              status: 'transferred',
              failure_reason: null,
              updated_at: new Date().toISOString(),
            })
            .eq('id', payout.id)
        }

        results.push({
          payoutId: payout.id,
          jobId: payout.job_id,
          action: 'repaired',
          stripeTransferId: stripeTransfer.id,
        })
      } else {
        // No transfer found — mark as failed with retry
        const retryCount = (payout.retry_count || 0)
        const backoffMinutes = [5, 15, 60, 240, 1440]
        const nextBackoff = backoffMinutes[Math.min(retryCount, backoffMinutes.length - 1)]
        const nextRetryAt = new Date(Date.now() + nextBackoff * 60 * 1000).toISOString()

        console.log('[recover-stuck] Marking failed:', logCtx, 'retryCount:', retryCount)

        if (!dryRun) {
          await supabaseAdmin
            .from('walker_payouts')
            .update({
              status: 'failed',
              failure_reason: `Stuck in processing for >${STUCK_THRESHOLD_MINUTES}m, no Stripe transfer found`,
              next_retry_at: retryCount < 5 ? nextRetryAt : null,
              updated_at: new Date().toISOString(),
            })
            .eq('id', payout.id)
        }

        results.push({
          payoutId: payout.id,
          jobId: payout.job_id,
          action: retryCount < 5 ? 'failed_with_retry' : 'failed_final',
        })
      }
    }

    const recovered = results.filter(r => r.action === 'repaired').length
    const failedWithRetry = results.filter(r => r.action === 'failed_with_retry').length
    const failedFinal = results.filter(r => r.action === 'failed_final').length

    console.log(`[recover-stuck] Done: ${recovered} repaired, ${failedWithRetry} failed+retry, ${failedFinal} failed final${dryRun ? ' (DRY RUN)' : ''}`)

    return new Response(
      JSON.stringify({
        recovered: results.length,
        repaired: recovered,
        failedWithRetry,
        failedFinal,
        dryRun,
        results,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    console.error('[recover-stuck] Unhandled error:', err)
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
