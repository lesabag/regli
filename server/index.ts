import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

const app = express()
app.use(cors())
app.use(express.json())

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// ─── Helper: extract authenticated user from Bearer token ───

async function getAuthUser(authHeader: string | undefined) {
  if (!authHeader?.startsWith('Bearer ')) return null
  const token = authHeader.slice(7)
  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) return null
  return user
}

// ─── Payment endpoints ──────────────────────────────────────

app.post('/api/create-payment-intent', async (req, res) => {
  try {
    const user = await getAuthUser(req.headers.authorization)
    if (!user) {
      res.status(401).json({ error: 'Missing or invalid authorization token' })
      return
    }

    const { jobId } = req.body
    if (!jobId) {
      res.status(400).json({ error: 'Missing jobId' })
      return
    }

    const { data: job, error: jobError } = await supabase
      .from('walk_requests')
      .select('id, client_id, price, payment_status, status')
      .eq('id', jobId)
      .single()

    if (jobError || !job) {
      res.status(404).json({ error: 'Job not found' })
      return
    }

    if (job.client_id !== user.id) {
      res.status(403).json({ error: 'Not your job' })
      return
    }

    if (job.payment_status === 'paid') {
      res.status(400).json({ error: 'Job already paid' })
      return
    }

    if (!job.price || job.price <= 0) {
      res.status(400).json({ error: 'Job has no valid price' })
      return
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(job.price * 100),
      currency: 'ils',
      metadata: { jobId: job.id, clientId: user.id },
    })

    res.json({ clientSecret: paymentIntent.client_secret })
  } catch (err) {
    console.error('Payment intent error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

app.post('/api/confirm-payment', async (req, res) => {
  try {
    const user = await getAuthUser(req.headers.authorization)
    if (!user) {
      res.status(401).json({ error: 'Missing or invalid authorization token' })
      return
    }

    const { jobId, paymentIntentId } = req.body
    if (!jobId || !paymentIntentId) {
      res.status(400).json({ error: 'Missing jobId or paymentIntentId' })
      return
    }

    const { data: job, error: jobError } = await supabase
      .from('walk_requests')
      .select('id, client_id, price, payment_status, platform_fee_percent, status')
      .eq('id', jobId)
      .single()

    if (jobError || !job) {
      res.status(404).json({ error: 'Job not found' })
      return
    }

    if (job.client_id !== user.id) {
      res.status(403).json({ error: 'Not your job' })
      return
    }

    if (job.payment_status === 'paid') {
      res.status(400).json({ error: 'Job already paid' })
      return
    }

    const price = job.price || 0
    const feePercent = job.platform_fee_percent || 20
    const platformFee = Math.round(price * (feePercent / 100) * 100) / 100
    const walkerEarnings = Math.round((price - platformFee) * 100) / 100

    const updatePayload: Record<string, unknown> = {
      payment_status: 'paid',
      paid_at: new Date().toISOString(),
      stripe_payment_intent_id: paymentIntentId,
      platform_fee: platformFee,
      walker_earnings: walkerEarnings,
    }

    if (job.status === 'awaiting_payment') {
      updatePayload.status = 'open'
    }

    const { error: updateError } = await supabase
      .from('walk_requests')
      .update(updatePayload)
      .eq('id', jobId)

    if (updateError) {
      console.error('DB update error:', updateError)
      res.status(500).json({ error: 'Failed to update payment status' })
      return
    }

    res.json({
      success: true,
      platform_fee: platformFee,
      walker_earnings: walkerEarnings,
    })
  } catch (err) {
    console.error('Confirm payment error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ─── Start server ───────────────────────────────────────────

const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
