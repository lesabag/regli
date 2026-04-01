import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase, invokeEdgeFunction } from '../services/supabaseClient'
import NotificationsBell, { createNotification } from '../components/NotificationsBell'
import { useWalkerTracking } from '../hooks/useWalkerTracking'

type AppRole = 'client' | 'walker' | 'admin'

interface WalkerDashboardProps {
  profile: {
    id: string
    email: string | null
    full_name: string | null
    role: AppRole
  }
  onSignOut: () => Promise<void>
}

interface WalkRequestRow {
  id: string
  client_id: string
  walker_id: string | null
  status: 'open' | 'accepted' | 'completed' | 'cancelled'
  dog_name: string | null
  location: string | null
  address: string | null
  notes: string | null
  created_at: string | null
  price: number | null
  platform_fee: number | null
  walker_earnings: number | null
  payment_status: 'unpaid' | 'authorized' | 'paid' | 'failed' | 'refunded'
  paid_at: string | null
  stripe_payment_intent_id: string | null
  client?: { id: string; full_name: string | null; email: string | null } | null
}

interface RatingRow {
  id: string
  job_id: string
  from_user_id: string
  to_user_id: string
  rating: number
  review: string | null
  created_at: string
}

interface PayoutRequestRow {
  id: string
  walker_id: string
  amount: number
  status: 'pending' | 'approved' | 'paid' | 'rejected'
  note: string | null
  created_at: string
  processed_at: string | null
}

interface WalkerPayoutRow {
  id: string
  walker_id: string
  job_id: string
  gross_amount: number
  platform_fee: number
  net_amount: number
  currency: string
  status: 'pending' | 'processing' | 'transferred' | 'in_transit' | 'paid_out' | 'failed' | 'reversed' | 'refunded'
  stripe_transfer_id: string | null
  stripe_payout_id: string | null
  failure_reason: string | null
  available_at: string | null
  created_at: string
  updated_at: string
}

interface ConnectStatus {
  connected: boolean
  stripe_connect_account_id: string | null
  stripe_connect_onboarding_complete: boolean
  payouts_enabled: boolean
  charges_enabled: boolean
}

/**
 * Prepare auth for edge function calls.
 * Calls setAuth so the FunctionsClient picks up the current token.
 * Returns false if there is no active session.
 */
async function prepareEdgeFunctionAuth(): Promise<boolean> {
  const { data: { session } } = await supabase.auth.getSession()
  console.log('[prepareEdgeFunctionAuth] session exists:', !!session)
  console.log('[prepareEdgeFunctionAuth] access_token exists:', !!session?.access_token)
  if (!session?.access_token) return false
  supabase.functions.setAuth(session.access_token)
  return true
}

export default function WalkerDashboard({
  profile,
  onSignOut,
}: WalkerDashboardProps) {
  const [openJobs, setOpenJobs] = useState<WalkRequestRow[]>([])
  const [myJobs, setMyJobs] = useState<WalkRequestRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  const [ratingsReceived, setRatingsReceived] = useState<RatingRow[]>([])
  const [ratingsGiven, setRatingsGiven] = useState<RatingRow[]>([])
  const [ratingJobId, setRatingJobId] = useState<string | null>(null)
  const [ratingValue, setRatingValue] = useState(0)
  const [ratingHover, setRatingHover] = useState(0)
  const [ratingReview, setRatingReview] = useState('')
  const [ratingSubmitting, setRatingSubmitting] = useState(false)

  const [payoutRequests, setPayoutRequests] = useState<PayoutRequestRow[]>([])
  const [payoutAmount, setPayoutAmount] = useState('')
  const [payoutNote, setPayoutNote] = useState('')
  const [payoutSubmitting, setPayoutSubmitting] = useState(false)

  const [walkerPayouts, setWalkerPayouts] = useState<WalkerPayoutRow[]>([])

  const [balanceAdjustments, setBalanceAdjustments] = useState<{
    id: string
    job_id: string | null
    type: string
    amount: number
    description: string | null
    created_at: string
  }[]>([])

  const [connectStatus, setConnectStatus] = useState<ConnectStatus | null>(null)
  const [connectLoading, setConnectLoading] = useState(true)
  const [connectError, setConnectError] = useState<string | null>(null)

  const walkerName = profile.full_name || profile.email || 'Walker'
  const firstName = (profile.full_name || '').split(' ')[0] || walkerName

  const avgRating = useMemo(() => {
    if (ratingsReceived.length === 0) return null
    const sum = ratingsReceived.reduce((acc, r) => acc + r.rating, 0)
    return Math.round((sum / ratingsReceived.length) * 10) / 10
  }, [ratingsReceived])

  const ratedJobIds = useMemo(() => {
    const set = new Set<string>()
    ratingsGiven.forEach((r) => set.add(r.job_id))
    return set
  }, [ratingsGiven])

  const myRatingByJobId = useMemo(() => {
    const map = new Map<string, RatingRow>()
    ratingsGiven.forEach((r) => map.set(r.job_id, r))
    return map
  }, [ratingsGiven])

  const clientRatingByJobId = useMemo(() => {
    const map = new Map<string, RatingRow>()
    ratingsReceived.forEach((r) => map.set(r.job_id, r))
    return map
  }, [ratingsReceived])

  const payoutByJobId = useMemo(() => {
    const map = new Map<string, WalkerPayoutRow>()
    walkerPayouts.forEach((p) => map.set(p.job_id, p))
    return map
  }, [walkerPayouts])

  const transferBreakdown = useMemo(() => {
    let total = 0
    let inTransit = 0
    let paidOut = 0
    let failed = 0

    walkerPayouts.forEach((p) => {
      total += p.net_amount
      if (p.status === 'transferred' || p.status === 'in_transit') inTransit += p.net_amount
      else if (p.status === 'paid_out') paidOut += p.net_amount
      else if (p.status === 'failed' || p.status === 'reversed' || p.status === 'refunded') failed += p.net_amount
    })

    return { transferred: total, inTransit, paidOut, failed }
  }, [walkerPayouts])

  const [walletData, setWalletData] = useState<{
    available_balance: number
    pending_balance: number
    total_earned: number
  } | null>(null)

  // Derive pending from jobs as fallback (accepted jobs with authorized payment)
  const pendingFromJobs = useMemo(() => {
    return myJobs
      .filter((j) => j.status === 'accepted' && j.payment_status === 'authorized')
      .reduce((sum, j) => sum + (j.walker_earnings ?? (j.price != null ? j.price * 0.8 : 0)), 0)
  }, [myJobs])

  const totalAdjustments = useMemo(() => {
    return balanceAdjustments.reduce((sum, adj) => sum + adj.amount, 0)
  }, [balanceAdjustments])

  const wallet = useMemo(() => {
    const dbAvailable = walletData?.available_balance ?? 0
    const dbPending = walletData?.pending_balance ?? 0
    const dbTotal = walletData?.total_earned ?? 0

    // Pending combines DB pending + in-flight authorized jobs not yet captured
    const pending = dbPending + pendingFromJobs

    // Deduct refund debits from available balance
    const adjustedAvailable = Math.max(0, dbAvailable + totalAdjustments)

    const completedPaidCount = myJobs.filter(
      (j) => j.status === 'completed' && j.payment_status === 'paid'
    ).length
    const pendingCount = myJobs.filter(
      (j) => j.status === 'accepted' && j.payment_status === 'authorized'
    ).length

    return {
      availableBalance: Math.round(adjustedAvailable * 100) / 100,
      pendingEarnings: Math.round(pending * 100) / 100,
      totalEarnings: Math.round((dbTotal + pending + totalAdjustments) * 100) / 100,
      completedWalks: completedPaidCount,
      pendingCount,
      hasDeductions: totalAdjustments < 0,
      deductionTotal: Math.round(Math.abs(totalAdjustments) * 100) / 100,
    }
  }, [walletData, pendingFromJobs, myJobs, totalAdjustments])

  const fetchWallet = useCallback(async () => {
    const { data, error } = await supabase
      .from('walker_wallets')
      .select('available_balance, pending_balance, total_earned')
      .eq('walker_id', profile.id)
      .maybeSingle()

    if (error) {
      console.error('Failed to load wallet', error.message)
      return
    }

    // If no wallet row yet, use zeros
    setWalletData(data ?? { available_balance: 0, pending_balance: 0, total_earned: 0 })
  }, [profile.id])

  const activeJobs = useMemo(
    () => myJobs.filter((j) => j.status === 'accepted'),
    [myJobs]
  )

  // Broadcast walker GPS to all active jobs
  const activeJobIds = useMemo(() => activeJobs.map((j) => j.id), [activeJobs])
  useWalkerTracking(activeJobIds)

  const completedJobs = useMemo(
    () => myJobs.filter((j) => j.status === 'completed' || j.status === 'cancelled'),
    [myJobs]
  )

  // ─── Data fetching ──────────────────────────────────────────

  const fetchAll = async () => {
    setLoading(true)
    setError(null)

    const selectFields =
      'id, client_id, walker_id, status, dog_name, location, address, notes, created_at, price, platform_fee, walker_earnings, payment_status, paid_at, stripe_payment_intent_id, client:profiles!walk_requests_client_id_fkey(id, full_name, email)'

    const { data: open, error: openErr } = await supabase
      .from('walk_requests')
      .select(selectFields)
      .eq('status', 'open')
      .in('payment_status', ['authorized', 'paid'])
      .order('created_at', { ascending: false })

    if (openErr) {
      setError(openErr.message)
      setLoading(false)
      return
    }

    const { data: mine, error: mineErr } = await supabase
      .from('walk_requests')
      .select(selectFields)
      .eq('walker_id', profile.id)
      .order('created_at', { ascending: false })

    if (mineErr) {
      setError(mineErr.message)
      setLoading(false)
      return
    }

    const normalizeRows = (rows: unknown[]) =>
      (rows as Record<string, unknown>[]).map((row) => ({
        ...row,
        client: Array.isArray(row.client) ? row.client[0] || null : row.client,
      }))

    setOpenJobs(normalizeRows(open || []) as WalkRequestRow[])
    setMyJobs(normalizeRows(mine || []) as WalkRequestRow[])
    setLoading(false)
  }

  const fetchRatings = useCallback(async () => {
    const { data: received } = await supabase
      .from('ratings')
      .select('*')
      .eq('to_user_id', profile.id)

    setRatingsReceived((received as RatingRow[]) || [])

    const { data: given } = await supabase
      .from('ratings')
      .select('*')
      .eq('from_user_id', profile.id)

    setRatingsGiven((given as RatingRow[]) || [])
  }, [profile.id])

  const fetchPayoutRequests = useCallback(async () => {
    const { data, error } = await supabase
      .from('payout_requests')
      .select('*')
      .eq('walker_id', profile.id)
      .order('created_at', { ascending: false })

    if (error) {
      console.error('Failed to load payout requests', error.message)
      return
    }
    setPayoutRequests((data as PayoutRequestRow[]) || [])
  }, [profile.id])

  const fetchWalkerPayouts = useCallback(async () => {
    const { data, error } = await supabase
      .from('walker_payouts')
      .select('*')
      .eq('walker_id', profile.id)
      .order('created_at', { ascending: false })

    if (error) {
      console.error('Failed to load walker payouts', error.message)
      return
    }
    setWalkerPayouts((data as WalkerPayoutRow[]) || [])
  }, [profile.id])

  const fetchBalanceAdjustments = useCallback(async () => {
    const { data, error } = await supabase
      .from('walker_balance_adjustments')
      .select('id, job_id, type, amount, description, created_at')
      .eq('walker_id', profile.id)
      .order('created_at', { ascending: false })

    if (error) {
      console.error('Failed to load balance adjustments', error.message)
      return
    }
    setBalanceAdjustments(data || [])
  }, [profile.id])

  const fetchConnectStatus = useCallback(async () => {
    setConnectLoading(true)
    setConnectError(null)

    try {
      const hasAuth = await prepareEdgeFunctionAuth()
      if (!hasAuth) {
        setConnectError('Session expired. Please log in again.')
        setConnectLoading(false)
        return
      }

      const { data, error } = await supabase.functions.invoke('get-connect-status')

      if (error) {
        console.error('[ConnectStatus] Edge function error:', error)
        setConnectError(error.message || String(error))
        setConnectLoading(false)
        return
      }

      if (!data) {
        setConnectError('Empty response from server.')
        setConnectLoading(false)
        return
      }

      setConnectStatus(data as ConnectStatus)
      setConnectError(null)
    } catch (err) {
      console.error('[ConnectStatus] Unexpected error:', err)
      setConnectError('Failed to load payout account status.')
    } finally {
      setConnectLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchAll()
    fetchRatings()
    fetchPayoutRequests()
    fetchConnectStatus()
    fetchWallet()
    fetchWalkerPayouts()
    fetchBalanceAdjustments()

    const channel = supabase
      .channel(`walker-requests-${profile.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'walk_requests',
        },
        () => {
          fetchAll()
          fetchWallet()
        }
      )
      .subscribe()

    const ratingsChannel = supabase
      .channel(`walker-ratings-${profile.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'ratings',
        },
        () => {
          fetchRatings()
        }
      )
      .subscribe()

    const payoutsChannel = supabase
      .channel(`walker-payouts-${profile.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'payout_requests',
        },
        () => {
          fetchPayoutRequests()
        }
      )
      .subscribe()

    const walletChannel = supabase
      .channel(`walker-wallet-${profile.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'walker_wallets',
          filter: `walker_id=eq.${profile.id}`,
        },
        () => {
          fetchWallet()
        }
      )
      .subscribe()

    const walkerPayoutsChannel = supabase
      .channel(`walker-payouts-transfer-${profile.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'walker_payouts',
          filter: `walker_id=eq.${profile.id}`,
        },
        () => {
          fetchWalkerPayouts()
        }
      )
      .subscribe()

    const adjustmentsChannel = supabase
      .channel(`walker-adjustments-${profile.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'walker_balance_adjustments',
          filter: `walker_id=eq.${profile.id}`,
        },
        () => {
          fetchBalanceAdjustments()
          fetchWallet()
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
      supabase.removeChannel(ratingsChannel)
      supabase.removeChannel(payoutsChannel)
      supabase.removeChannel(walletChannel)
      supabase.removeChannel(walkerPayoutsChannel)
      supabase.removeChannel(adjustmentsChannel)
    }
  }, [profile.id, fetchRatings, fetchPayoutRequests, fetchConnectStatus, fetchWallet, fetchWalkerPayouts, fetchBalanceAdjustments])

  // Check for connect return/refresh URL params
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.has('connect_return') || params.has('connect_refresh')) {
      const url = new URL(window.location.href)
      url.searchParams.delete('connect_return')
      url.searchParams.delete('connect_refresh')
      window.history.replaceState({}, '', url.toString())
      fetchConnectStatus()
    }
  }, [fetchConnectStatus])

  // ─── Actions ────────────────────────────────────────────────

  const handleAccept = async (id: string) => {
    setError(null)
    setSuccessMessage(null)

    const job = openJobs.find((j) => j.id === id)

    const { error } = await supabase
      .from('walk_requests')
      .update({
        status: 'accepted',
        walker_id: profile.id,
        walker_lat: null,
        walker_lng: null,
        last_location_update: null,
      })
      .eq('id', id)

    if (error) {
      setError(error.message)
      return
    }

    setSuccessMessage('Job accepted!')
    fetchAll()

    const dogLabel = job?.dog_name || 'a dog'

    if (job?.client_id) {
      await createNotification({
        userId: job.client_id,
        type: 'job_accepted',
        title: 'Walker Accepted',
        message: `${walkerName} accepted your walk request for ${dogLabel}.`,
        relatedJobId: id,
      })
    }

    await createNotification({
      userId: profile.id,
      type: 'job_accepted_self',
      title: 'Job Accepted',
      message: `You accepted a walk for ${dogLabel}. Head to the location and start the walk!`,
      relatedJobId: id,
    })
  }

  const [completingJobId, setCompletingJobId] = useState<string | null>(null)

  // Completion success state — shows earnings overlay after completing a walk
  const [completionSuccess, setCompletionSuccess] = useState<{
    dogName: string
    earnings: number | null
    clientName: string
  } | null>(null)

  const handleComplete = async (id: string) => {
    setError(null)
    setSuccessMessage(null)
    setCompletingJobId(id)

    const job = myJobs.find((j) => j.id === id)

    try {
      // If the job has an authorized payment, capture it via edge function
      if (job?.payment_status === 'authorized' && job?.stripe_payment_intent_id) {
        const { data, error: captureErr } = await invokeEdgeFunction<{
          success?: boolean
          error?: string
          details?: string
        }>('capture-payment', { body: { jobId: id } })

        if (captureErr) {
          console.error('[handleComplete] capture-payment error:', captureErr)
          setError(captureErr)
          return
        }

        if (!data?.success) {
          const msg = data?.details || data?.error || 'Failed to capture payment'
          console.error('[handleComplete] capture-payment not successful:', msg)
          setError(msg)
          return
        }
      } else {
        // Fallback for jobs without authorized payment (e.g. unpaid/legacy)
        const { error } = await supabase
          .from('walk_requests')
          .update({ status: 'completed' })
          .eq('id', id)

        if (error) {
          console.error('[handleComplete] DB update error:', error.message)
          setError(error.message)
          return
        }
      }

      // Show completion success overlay
      const earnings = job?.walker_earnings ?? (job?.price != null ? Math.round((job.price) * 0.8 * 100) / 100 : null)
      setCompletionSuccess({
        dogName: job?.dog_name || 'the dog',
        earnings,
        clientName: job?.client?.full_name || job?.client?.email || 'Client',
      })

      await fetchAll()
      await fetchWallet()

      const dogLabel = job?.dog_name || 'your dog'

      if (job?.client_id) {
        await createNotification({
          userId: job.client_id,
          type: 'job_completed',
          title: 'Walk Completed',
          message: `${walkerName} completed the walk for ${dogLabel}.`,
          relatedJobId: id,
        }).catch((err) => {
          console.error('[handleComplete] notification failed:', err)
        })
      }

      // Notify walker about payment received
      const notifyEarnings = job?.walker_earnings ?? (job?.price != null ? Math.round((job?.price ?? 0) * 0.8) : null)
      if (notifyEarnings && notifyEarnings > 0) {
        await createNotification({
          userId: profile.id,
          type: 'payment_received',
          title: 'Payment Received',
          message: `${notifyEarnings} ILS has been added to your wallet for walking ${dogLabel}.`,
          relatedJobId: id,
        }).catch((err) => {
          console.error('[handleComplete] payment_received notification failed:', err)
        })
      }
    } catch (err) {
      console.error('[handleComplete] unexpected error:', err)
      setError(err instanceof Error ? err.message : 'Something went wrong while completing the job')
    } finally {
      setCompletingJobId(null)
    }
  }

  const handleRelease = async (id: string) => {
    setError(null)
    setSuccessMessage(null)

    const { error } = await supabase
      .from('walk_requests')
      .update({ status: 'open', walker_id: null })
      .eq('id', id)

    if (error) {
      setError(error.message)
      return
    }

    setSuccessMessage('Job released.')
    fetchAll()
  }

  const openRatingModal = (jobId: string) => {
    setRatingJobId(jobId)
    setRatingValue(0)
    setRatingHover(0)
    setRatingReview('')
  }

  const closeRatingModal = () => {
    setRatingJobId(null)
    setRatingValue(0)
    setRatingHover(0)
    setRatingReview('')
  }

  const handleSubmitRating = async () => {
    if (!ratingJobId || ratingValue < 1) return

    const job = myJobs.find((j) => j.id === ratingJobId)
    if (!job) return

    setRatingSubmitting(true)

    const { error } = await supabase.from('ratings').insert({
      job_id: ratingJobId,
      from_user_id: profile.id,
      to_user_id: job.client_id,
      rating: ratingValue,
      review: ratingReview.trim() || null,
    })

    if (error) {
      setError(error.message)
      setRatingSubmitting(false)
      return
    }

    await createNotification({
      userId: job.client_id,
      type: 'new_rating',
      title: 'New Rating Received',
      message: `Your walker rated you ${ratingValue} stars for the walk with ${job.dog_name || 'your dog'}.`,
      relatedJobId: ratingJobId,
    })

    setRatingSubmitting(false)
    closeRatingModal()
    setSuccessMessage('Rating submitted!')
    await fetchRatings()
  }

  const handleRequestPayout = async () => {
    setError(null)
    setSuccessMessage(null)

    const parsed = parseFloat(payoutAmount.trim())
    if (isNaN(parsed) || parsed <= 0) {
      setError('Please enter a valid payout amount.')
      return
    }

    if (parsed > wallet.availableBalance) {
      setError(`Amount exceeds your available balance of ${wallet.availableBalance.toFixed(2)} ILS.`)
      return
    }

    setPayoutSubmitting(true)

    const { error } = await supabase.from('payout_requests').insert({
      walker_id: profile.id,
      amount: parsed,
      note: payoutNote.trim() || null,
    })

    if (error) {
      setError(error.message)
      setPayoutSubmitting(false)
      return
    }

    setPayoutAmount('')
    setPayoutNote('')
    setPayoutSubmitting(false)
    setSuccessMessage(`Payout request of ${parsed.toFixed(2)} ILS submitted!`)
    await fetchPayoutRequests()
  }

  const handleConnectAccount = async () => {
    setError(null)
    setConnectError(null)
    setConnectLoading(true)

    try {
      const hasAuth = await prepareEdgeFunctionAuth()
      if (!hasAuth) {
        setConnectError('Session expired. Please log in again.')
        setConnectLoading(false)
        return
      }

      // Step 1: Create or reuse the connect account
      const { data: accountData, error: accountError } = await supabase.functions.invoke('create-connect-account')

      if (accountError) {
        setConnectError(accountError.message || String(accountError))
        setConnectLoading(false)
        return
      }

      const acct = accountData as { accountId?: string; error?: string } | null
      if (!acct?.accountId) {
        setConnectError(acct?.error || 'Failed to create connect account')
        setConnectLoading(false)
        return
      }

      // Step 2: Get the onboarding link
      const { data: linkData, error: linkError } = await supabase.functions.invoke('create-connect-onboarding-link')

      if (linkError) {
        setConnectError(linkError.message || String(linkError))
        setConnectLoading(false)
        return
      }

      const link = linkData as { url?: string; error?: string } | null
      if (!link?.url) {
        setConnectError(link?.error || 'Failed to get onboarding link')
        setConnectLoading(false)
        return
      }

      window.location.href = link.url
    } catch (err) {
      console.error('[ConnectAccount] Unexpected error:', err)
      setConnectError('Failed to start onboarding')
      setConnectLoading(false)
    }
  }

  const handleContinueOnboarding = async () => {
    setError(null)
    setConnectError(null)
    setConnectLoading(true)

    try {
      const hasAuth = await prepareEdgeFunctionAuth()
      if (!hasAuth) {
        setConnectError('Session expired. Please log in again.')
        setConnectLoading(false)
        return
      }

      const { data, error } = await supabase.functions.invoke('create-connect-onboarding-link')

      if (error) {
        setConnectError(error.message || String(error))
        setConnectLoading(false)
        return
      }

      const link = data as { url?: string; error?: string } | null
      if (!link?.url) {
        setConnectError(link?.error || 'Failed to get onboarding link')
        setConnectLoading(false)
        return
      }

      window.location.href = link.url
    } catch (err) {
      console.error('[ContinueOnboarding] Unexpected error:', err)
      setConnectError('Failed to continue onboarding')
      setConnectLoading(false)
    }
  }

  // ─── Render ─────────────────────────────────────────────────

  return (
    <div style={pageStyle}>
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        {/* Header */}
        <div style={headerStyle}>
          <div>
            <div style={{ fontSize: 12, opacity: 0.6, letterSpacing: 1, textTransform: 'uppercase' as const }}>
              Regli
            </div>
            <h1 style={{ margin: '8px 0 0', fontSize: 28, fontWeight: 800 }}>
              Hey, {firstName}
            </h1>
            {avgRating !== null && (
              <div style={{ marginTop: 6 }}>
                <div style={{ fontSize: 14, opacity: 0.9 }}>
                  <span style={{ color: '#F59E0B' }}>★</span> {avgRating} avg rating ({ratingsReceived.length} review{ratingsReceived.length !== 1 ? 's' : ''})
                </div>
                {(() => {
                  const latestWithReview = ratingsReceived.find((r) => r.review)
                  if (!latestWithReview) return null
                  const snippet = latestWithReview.review!.length > 60
                    ? latestWithReview.review!.slice(0, 60) + '...'
                    : latestWithReview.review!
                  return (
                    <div style={{ marginTop: 4, fontSize: 12, opacity: 0.6, fontStyle: 'italic' }}>
                      &ldquo;{snippet}&rdquo;
                    </div>
                  )
                })()}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <NotificationsBell variant="light" />
            <button type="button" onClick={onSignOut} style={logoutButtonStyle}>
              Sign out
            </button>
          </div>
        </div>

        {error && <MessageBox text={error} kind="error" />}
        {successMessage && <MessageBox text={successMessage} kind="success" />}

        {/* Rating Modal */}
        {ratingJobId && (
          <div style={overlayStyle}>
            <div style={modalStyle}>
              <h2 style={{ margin: '0 0 18px', fontSize: 20, fontWeight: 700 }}>Rate client</h2>
              <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
                {[1, 2, 3, 4, 5].map((star) => (
                  <button
                    key={star}
                    type="button"
                    onMouseEnter={() => setRatingHover(star)}
                    onMouseLeave={() => setRatingHover(0)}
                    onClick={() => setRatingValue(star)}
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      fontSize: 32,
                      color: star <= (ratingHover || ratingValue) ? '#F59E0B' : '#D1D5DB',
                      padding: 2,
                      transition: 'color 0.15s',
                    }}
                  >
                    ★
                  </button>
                ))}
              </div>
              <textarea
                value={ratingReview}
                onChange={(e) => setRatingReview(e.target.value)}
                placeholder="Write an optional review..."
                rows={3}
                style={{
                  width: '100%',
                  border: '1px solid #E2E8F0',
                  borderRadius: 12,
                  padding: '12px 14px',
                  fontSize: 14,
                  outline: 'none',
                  boxSizing: 'border-box' as const,
                  resize: 'vertical',
                  minHeight: 80,
                }}
              />
              <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
                <button
                  type="button"
                  onClick={handleSubmitRating}
                  disabled={ratingValue < 1 || ratingSubmitting}
                  style={{
                    flex: 1,
                    border: 'none',
                    borderRadius: 12,
                    padding: '12px 16px',
                    background: '#0F172A',
                    color: '#FFFFFF',
                    fontWeight: 700,
                    fontSize: 14,
                    cursor: ratingValue < 1 || ratingSubmitting ? 'not-allowed' : 'pointer',
                    opacity: ratingValue < 1 || ratingSubmitting ? 0.6 : 1,
                  }}
                >
                  {ratingSubmitting ? 'Submitting...' : 'Submit Rating'}
                </button>
                <button
                  type="button"
                  onClick={closeRatingModal}
                  disabled={ratingSubmitting}
                  style={{
                    border: '1px solid #E2E8F0',
                    borderRadius: 12,
                    padding: '12px 16px',
                    background: '#FFFFFF',
                    color: '#64748B',
                    fontWeight: 600,
                    fontSize: 14,
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Completion Success Overlay */}
        {completionSuccess && (
          <div style={overlayStyle}>
            <div
              style={{
                ...modalStyle,
                textAlign: 'center' as const,
                animation: 'completionSlideUp 0.4s ease-out',
              }}
            >
              <div
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: 999,
                  background: '#DCFCE7',
                  display: 'grid',
                  placeItems: 'center',
                  margin: '0 auto 20px',
                  animation: 'checkmarkPop 0.5s ease-out 0.15s both',
                }}
              >
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#16A34A" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <h2 style={{ margin: '0 0 6px', fontSize: 22, fontWeight: 800, color: '#0F172A' }}>
                Walk completed
              </h2>
              <p style={{ margin: '0 0 20px', fontSize: 14, color: '#64748B' }}>
                Great job walking {completionSuccess.dogName} for {completionSuccess.clientName}!
              </p>
              {completionSuccess.earnings != null && completionSuccess.earnings > 0 && (
                <div
                  style={{
                    background: '#F0FDF4',
                    borderRadius: 16,
                    padding: '18px 24px',
                    marginBottom: 20,
                    animation: 'earningsCount 0.4s ease-out 0.3s both',
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#15803D', opacity: 0.7, textTransform: 'uppercase' as const, letterSpacing: 0.8 }}>
                    You earned
                  </div>
                  <div style={{ fontSize: 32, fontWeight: 800, color: '#15803D', marginTop: 4 }}>
                    +{completionSuccess.earnings.toLocaleString('he-IL', {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })} ILS
                  </div>
                  <div style={{ fontSize: 12, color: '#16A34A', marginTop: 6, opacity: 0.7 }}>
                    Payment is on the way to your wallet
                  </div>
                </div>
              )}
              <button
                type="button"
                onClick={() => setCompletionSuccess(null)}
                style={{
                  border: 'none',
                  borderRadius: 12,
                  padding: '12px 32px',
                  background: '#0F172A',
                  color: '#FFFFFF',
                  fontWeight: 700,
                  fontSize: 14,
                  cursor: 'pointer',
                  width: '100%',
                }}
              >
                Done
              </button>
            </div>
          </div>
        )}

        {/* Stripe Connect Onboarding */}
        <ConnectOnboardingCard
          status={connectStatus}
          loading={connectLoading}
          error={connectError}
          onConnect={handleConnectAccount}
          onContinue={handleContinueOnboarding}
          onRefresh={fetchConnectStatus}
        />

        {/* Wallet */}
        <div style={walletGridStyle}>
          <div style={walletCardPrimaryStyle}>
            <div style={walletLabelStyle}>Available Balance</div>
            <div style={walletValuePrimaryStyle}>
              {wallet.availableBalance.toLocaleString('he-IL', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}{' '}
              <span style={{ fontSize: 18, fontWeight: 600, opacity: 0.8 }}>ILS</span>
            </div>
            <div style={{ fontSize: 12, opacity: 0.6, marginTop: 10, lineHeight: 1.5 }}>
              {wallet.availableBalance > 0
                ? `Ready to withdraw \u00b7 ${wallet.completedWalks} paid walk${wallet.completedWalks !== 1 ? 's' : ''}`
                : wallet.completedWalks > 0
                  ? `${wallet.completedWalks} paid walk${wallet.completedWalks !== 1 ? 's' : ''} \u00b7 All funds withdrawn`
                  : 'Complete walks to start earning'}
            </div>
            {wallet.hasDeductions && (
              <div style={{ fontSize: 12, color: '#FCA5A5', marginTop: 8, lineHeight: 1.4 }}>
                Includes {wallet.deductionTotal.toFixed(2)} ILS in refund deductions
              </div>
            )}
          </div>

          <div style={walletCardStyle}>
            <div style={walletLabelStyle}>Pending Earnings</div>
            <div style={{ ...walletValueStyle, color: wallet.pendingEarnings > 0 ? '#C2410C' : '#0F172A' }}>
              {wallet.pendingEarnings.toLocaleString('he-IL', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}{' '}
              <span style={{ fontSize: 14, fontWeight: 600, color: '#64748B' }}>ILS</span>
            </div>
            <div style={{ fontSize: 12, color: '#94A3B8', marginTop: 8, lineHeight: 1.5 }}>
              {wallet.pendingCount > 0
                ? `${wallet.pendingCount} walk${wallet.pendingCount !== 1 ? 's' : ''} in progress \u00b7 Becomes available after completion`
                : 'No walks in progress'}
            </div>
          </div>

          <div style={walletCardStyle}>
            <div style={walletLabelStyle}>Total Earned</div>
            <div style={walletValueStyle}>
              {wallet.totalEarnings.toLocaleString('he-IL', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}{' '}
              <span style={{ fontSize: 14, fontWeight: 600, color: '#64748B' }}>ILS</span>
            </div>
            <div style={{ fontSize: 12, color: '#94A3B8', marginTop: 8 }}>
              {wallet.totalEarnings === 0
                ? 'Accept and complete walks to earn'
                : 'All-time earnings on Regli'}
            </div>
          </div>
        </div>

        {/* Transfer Breakdown */}
        {walkerPayouts.length > 0 && (
          <section style={{ marginTop: 24 }}>
            <h2 style={sectionTitleStyle}>Stripe Transfers</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
              <div style={walletCardStyle}>
                <div style={walletLabelStyle}>Total Transferred</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: '#0F172A' }}>
                  {transferBreakdown.transferred.toFixed(2)} <span style={{ fontSize: 13, fontWeight: 600, color: '#64748B' }}>ILS</span>
                </div>
              </div>
              <div style={walletCardStyle}>
                <div style={walletLabelStyle}>In Transit</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: '#C2410C' }}>
                  {transferBreakdown.inTransit.toFixed(2)} <span style={{ fontSize: 13, fontWeight: 600, color: '#64748B' }}>ILS</span>
                </div>
              </div>
              <div style={walletCardStyle}>
                <div style={walletLabelStyle}>Paid Out</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: '#15803D' }}>
                  {transferBreakdown.paidOut.toFixed(2)} <span style={{ fontSize: 13, fontWeight: 600, color: '#64748B' }}>ILS</span>
                </div>
              </div>
              <div style={walletCardStyle}>
                <div style={walletLabelStyle}>Failed</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: transferBreakdown.failed > 0 ? '#DC2626' : '#94A3B8' }}>
                  {transferBreakdown.failed.toFixed(2)} <span style={{ fontSize: 13, fontWeight: 600, color: '#64748B' }}>ILS</span>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* Balance Adjustments (refund debits) */}
        {balanceAdjustments.length > 0 && (
          <section style={{ marginTop: 24 }}>
            <h2 style={sectionTitleStyle}>Balance Adjustments</h2>
            <div style={{ display: 'grid', gap: 8 }}>
              {balanceAdjustments.map((adj) => (
                <div key={adj.id} style={{
                  background: '#FFFFFF',
                  borderRadius: 14,
                  padding: '14px 18px',
                  border: '1px solid #FEE2E2',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 16,
                }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: '#991B1B' }}>
                      {adj.amount.toFixed(2)} ILS
                    </div>
                    <div style={{ fontSize: 12, color: '#64748B', marginTop: 2 }}>
                      {adj.description || adj.type}
                    </div>
                  </div>
                  <div style={{ fontSize: 12, color: '#94A3B8', textAlign: 'right' as const, flexShrink: 0 }}>
                    {formatRelativeDate(adj.created_at)}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Withdraw Funds */}
        <section style={{ marginTop: 24 }}>
          <h2 style={sectionTitleStyle}>Withdraw Funds</h2>
          <div style={payoutFormCardStyle}>
            {connectStatus && !connectStatus.payouts_enabled && (
              <div style={payoutNoticeStyle}>
                Automatic payouts are not available yet. Connect your payout account above to enable them later. You can still submit manual withdrawal requests below.
              </div>
            )}

            {wallet.availableBalance <= 0 ? (
              <div style={payoutEmptyStyle}>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#475569', marginBottom: 6 }}>
                  Nothing to withdraw yet
                </div>
                <div style={{ fontSize: 13, color: '#94A3B8', lineHeight: 1.5 }}>
                  {wallet.pendingCount > 0
                    ? `You have ${wallet.pendingCount} walk${wallet.pendingCount !== 1 ? 's' : ''} in progress. Earnings will become available once ${wallet.pendingCount === 1 ? 'the walk is' : 'walks are'} completed and payment is captured.`
                    : 'Complete paid walks and your earnings will appear here.'}
                </div>
              </div>
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 12, alignItems: 'end' }}>
                  <div>
                    <label style={payoutLabelStyle}>Amount (ILS)</label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={payoutAmount}
                      onChange={(e) => setPayoutAmount(e.target.value)}
                      placeholder={`Up to ${wallet.availableBalance.toFixed(2)} ILS`}
                      style={payoutInputStyle}
                    />
                  </div>
                  <div>
                    <label style={payoutLabelStyle}>Note (optional)</label>
                    <input
                      value={payoutNote}
                      onChange={(e) => setPayoutNote(e.target.value)}
                      placeholder="e.g. Bit, bank transfer"
                      style={payoutInputStyle}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={handleRequestPayout}
                    disabled={payoutSubmitting}
                    style={{
                      ...payoutButtonStyle,
                      opacity: payoutSubmitting ? 0.5 : 1,
                      cursor: payoutSubmitting ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {payoutSubmitting ? 'Submitting...' : 'Withdraw'}
                  </button>
                </div>
                <div style={{ marginTop: 10, fontSize: 12, color: '#94A3B8' }}>
                  Your request will be reviewed and processed manually.
                </div>
              </>
            )}
          </div>

          {/* Payout History */}
          {payoutRequests.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <h3 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 700, color: '#475569' }}>
                Withdrawal History
              </h3>
              <div style={{ display: 'grid', gap: 8 }}>
                {payoutRequests.map((pr) => (
                  <div key={pr.id} style={payoutRowStyle}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ fontSize: 15, fontWeight: 700 }}>
                          {pr.amount.toLocaleString('he-IL', {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}{' '}
                          ILS
                        </span>
                        <PayoutStatusBadge status={pr.status} />
                      </div>
                      <div style={{ fontSize: 12, color: '#64748B', marginTop: 4 }}>
                        Requested {formatRelativeDate(pr.created_at)}
                        {pr.note && (
                          <>
                            <span style={{ margin: '0 6px', opacity: 0.4 }}>&middot;</span>
                            {pr.note}
                          </>
                        )}
                      </div>
                    </div>
                    {pr.processed_at && (
                      <div style={{ fontSize: 12, color: '#94A3B8', textAlign: 'right' as const, flexShrink: 0 }}>
                        Processed<br />{formatDate(pr.processed_at)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* Active Jobs */}
        {activeJobs.length > 0 && (
          <section style={{ marginTop: 24, paddingBottom: activeJobs.length === 1 ? 88 : 0 }}>
            <h2 style={sectionTitleStyle}>Active Jobs</h2>
            <div style={{ display: 'grid', gap: 14 }}>
              {activeJobs.map((job) => (
                <div key={job.id} style={jobCardStyle}>
                  <div style={jobCardHeaderStyle}>
                    <div>
                      <div style={jobTitleStyle}>
                        {job.dog_name || 'Walk'}
                      </div>
                      <div style={jobMetaStyle}>
                        {job.client?.full_name || job.client?.email || 'Client'}
                      </div>
                    </div>
                    <StatusBadge status={job.status} />
                  </div>

                  <div style={jobDetailsStyle}>
                    <div>{job.location || job.address || '-'}</div>
                    <div>Started {formatDate(job.created_at)}</div>
                  </div>

                  {/* Inline actions for multi-job case */}
                  {activeJobs.length > 1 && (
                    <div style={jobActionsStyle}>
                      <button
                        type="button"
                        onClick={() => handleComplete(job.id)}
                        disabled={completingJobId === job.id}
                        style={{
                          ...completeButtonStyle,
                          opacity: completingJobId === job.id ? 0.6 : 1,
                          cursor: completingJobId === job.id ? 'not-allowed' : 'pointer',
                        }}
                      >
                        {completingJobId === job.id ? 'Completing...' : 'Complete Walk'}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRelease(job.id)}
                        style={releaseButtonStyle}
                      >
                        Release
                      </button>
                    </div>
                  )}

                  {/* Single job: show release inline, complete is in fixed CTA */}
                  {activeJobs.length === 1 && (
                    <div style={{ marginTop: 16 }}>
                      <button
                        type="button"
                        onClick={() => handleRelease(job.id)}
                        style={{ ...releaseButtonStyle, width: '100%' }}
                      >
                        Release Job
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Fixed bottom CTA for single active job */}
        {activeJobs.length === 1 && (
          <div style={fixedBottomCtaContainerStyle}>
            <div style={fixedBottomCtaInnerStyle}>
              <div style={{ fontSize: 13, color: '#64748B', marginBottom: 6, fontWeight: 600 }}>
                {activeJobs[0].dog_name || 'Walk'} &middot; {activeJobs[0].client?.full_name || activeJobs[0].client?.email || 'Client'}
              </div>
              <button
                type="button"
                onClick={() => handleComplete(activeJobs[0].id)}
                disabled={completingJobId === activeJobs[0].id}
                style={{
                  ...fixedCompleteButtonStyle,
                  opacity: completingJobId === activeJobs[0].id ? 0.7 : 1,
                  cursor: completingJobId === activeJobs[0].id ? 'not-allowed' : 'pointer',
                }}
              >
                {completingJobId === activeJobs[0].id ? (
                  <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
                    <span style={spinnerStyle} />
                    Completing...
                  </span>
                ) : (
                  'Complete Walk'
                )}
              </button>
            </div>
          </div>
        )}

        {/* Two Column: Open Jobs + History */}
        <div style={{ ...twoColumnStyle, marginTop: 24 }}>
          {/* Open Jobs */}
          <section>
            <h2 style={sectionTitleStyle}>
              Available Jobs
              {openJobs.length > 0 && (
                <span style={countBadgeStyle}>{openJobs.length}</span>
              )}
            </h2>

            {loading ? (
              <div style={emptyStateStyle}>Loading...</div>
            ) : openJobs.length === 0 ? (
              <div style={emptyStateStyle}>
                <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>
                  No jobs available
                </div>
                <div style={{ fontSize: 13 }}>
                  New jobs will appear here in real-time
                </div>
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 12 }}>
                {openJobs.map((job) => (
                  <div key={job.id} style={openJobCardStyle}>
                    <div style={jobTitleStyle}>
                      {job.dog_name || 'Walk'}
                    </div>
                    <div style={jobMetaStyle}>
                      {job.location || job.address || '-'}
                    </div>
                    {job.notes && (
                      <div style={{ fontSize: 12, color: '#94A3B8', marginTop: 4 }}>
                        {job.notes}
                      </div>
                    )}
                    <div style={{ fontSize: 13, color: '#64748B', marginTop: 8 }}>
                      {job.client?.full_name || job.client?.email || 'Client'}
                      <span style={{ margin: '0 6px', opacity: 0.4 }}>&middot;</span>
                      {formatRelativeDate(job.created_at)}
                    </div>
                    <EstimatedEarnings job={job} />
                    <button
                      type="button"
                      onClick={() => handleAccept(job.id)}
                      style={acceptButtonStyle}
                    >
                      Accept Job
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Earnings History */}
          <section>
            <h2 style={sectionTitleStyle}>
              Earnings History
              {completedJobs.length > 0 && (
                <span style={countBadgeStyle}>{completedJobs.length}</span>
              )}
            </h2>

            {loading ? (
              <div style={emptyStateStyle}>Loading...</div>
            ) : completedJobs.length === 0 ? (
              <div style={emptyStateStyle}>
                <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>
                  No earnings yet
                </div>
                <div style={{ fontSize: 13 }}>
                  Accept and complete walks to start earning
                </div>
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 10 }}>
                {completedJobs.map((job) => {
                  const myRating = myRatingByJobId.get(job.id)
                  const clientRating = clientRatingByJobId.get(job.id)
                  const isCompleted = job.status === 'completed'

                  return (
                    <div key={job.id} style={historyCardStyle}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <span style={{ fontSize: 15, fontWeight: 700 }}>
                              {job.dog_name || 'Walk'}
                            </span>
                            <StatusBadge status={job.status} />
                            {job.payment_status === 'paid' && (
                              <PaymentBadge />
                            )}
                          </div>
                          <div style={{ fontSize: 13, color: '#64748B', marginTop: 4 }}>
                            {job.client?.full_name || job.client?.email || 'Client'}
                            {job.paid_at && (
                              <>
                                <span style={{ margin: '0 6px', opacity: 0.4 }}>&middot;</span>
                                Paid {formatRelativeDate(job.paid_at)}
                              </>
                            )}
                          </div>

                          {isCompleted && !ratedJobIds.has(job.id) && (
                            <button
                              type="button"
                              onClick={() => openRatingModal(job.id)}
                              style={rateClientButtonStyle}
                            >
                              Rate client
                            </button>
                          )}
                        </div>

                        <div style={{ textAlign: 'right' as const, flexShrink: 0 }}>
                          {job.payment_status === 'paid' && job.walker_earnings != null ? (
                            <>
                              <div style={earningsAmountStyle}>
                                +{job.walker_earnings.toLocaleString('he-IL', {
                                  minimumFractionDigits: 2,
                                  maximumFractionDigits: 2,
                                })}{' '}
                                ILS
                              </div>
                              <TransferStatusLabel payout={payoutByJobId.get(job.id)} />
                            </>
                          ) : job.status === 'cancelled' ? (
                            <div style={{ fontSize: 13, color: '#991B1B', fontWeight: 600 }}>
                              Cancelled
                            </div>
                          ) : (
                            <div style={{ fontSize: 13, color: '#94A3B8' }}>
                              Awaiting payment
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Reviews section */}
                      {isCompleted && (myRating || clientRating) && (
                        <div style={reviewsSectionStyle}>
                          {myRating && (
                            <ReviewBlock
                              label="Your review"
                              rating={myRating.rating}
                              review={myRating.review}
                            />
                          )}
                          {clientRating && (
                            <ReviewBlock
                              label="Client review"
                              rating={clientRating.rating}
                              review={clientRating.review}
                            />
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────

function ConnectOnboardingCard({
  status,
  loading,
  error,
  onConnect,
  onContinue,
  onRefresh,
}: {
  status: ConnectStatus | null
  loading: boolean
  error: string | null
  onConnect: () => void
  onContinue: () => void
  onRefresh: () => void
}) {
  // Error state
  if (error) {
    return (
      <div style={{ ...connectCardStyle, borderColor: '#FCA5A5' }}>
        <div style={{ ...connectIconStyle, background: '#FEE2E2' }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#DC2626" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="15" y1="9" x2="9" y2="15" />
            <line x1="9" y1="9" x2="15" y2="15" />
          </svg>
        </div>
        <div style={{ flex: 1 }}>
          <div style={connectTitleStyle}>Payout account error</div>
          <div style={{ ...connectDescStyle, color: '#DC2626' }}>{error}</div>
        </div>
        <button type="button" onClick={onRefresh} style={connectRefreshStyle}>
          Retry
        </button>
      </div>
    )
  }

  // Still loading initial status
  if (loading && status === null) {
    return (
      <div style={connectCardStyle}>
        <div style={{ fontSize: 14, color: '#64748B' }}>Loading payout account status...</div>
      </div>
    )
  }

  if (status === null) {
    return null
  }

  // Not connected at all
  if (!status.connected) {
    return (
      <div style={connectCardStyle}>
        <div style={connectIconStyle}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#6366F1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="1" y="4" width="22" height="16" rx="2" ry="2" />
            <line x1="1" y1="10" x2="23" y2="10" />
          </svg>
        </div>
        <div style={{ flex: 1 }}>
          <div style={connectTitleStyle}>Connect your payout account</div>
          <div style={connectDescStyle}>
            Link your bank account via Stripe to receive automatic payouts for completed walks.
          </div>
        </div>
        <button
          type="button"
          onClick={onConnect}
          disabled={loading}
          style={{
            ...connectButtonStyle,
            opacity: loading ? 0.6 : 1,
            cursor: loading ? 'not-allowed' : 'pointer',
          }}
        >
          {loading ? 'Connecting...' : 'Connect payout account'}
        </button>
      </div>
    )
  }

  // Connected but onboarding incomplete
  if (!status.stripe_connect_onboarding_complete) {
    return (
      <div style={{ ...connectCardStyle, borderColor: '#FDE68A' }}>
        <div style={{ ...connectIconStyle, background: '#FEF3C7' }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#D97706" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>
        <div style={{ flex: 1 }}>
          <div style={connectTitleStyle}>Onboarding incomplete</div>
          <div style={connectDescStyle}>
            Your payout account is linked but you need to finish the verification process.
          </div>
          <div style={connectStatusRowStyle}>
            <ConnectStatusDot enabled={false} label="Onboarding incomplete" />
            <ConnectStatusDot enabled={status.payouts_enabled} label={status.payouts_enabled ? 'Payouts enabled' : 'Payouts not enabled'} />
            <ConnectStatusDot enabled={status.charges_enabled} label={status.charges_enabled ? 'Charges enabled' : 'Charges not enabled'} />
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 8 }}>
          <button
            type="button"
            onClick={onContinue}
            disabled={loading}
            style={{
              ...connectButtonStyle,
              background: '#D97706',
              opacity: loading ? 0.6 : 1,
              cursor: loading ? 'not-allowed' : 'pointer',
            }}
          >
            {loading ? 'Loading...' : 'Continue onboarding'}
          </button>
          <button type="button" onClick={onRefresh} style={connectRefreshStyle}>
            Refresh status
          </button>
        </div>
      </div>
    )
  }

  // Fully connected
  return (
    <div style={{ ...connectCardStyle, borderColor: '#BBF7D0' }}>
      <div style={{ ...connectIconStyle, background: '#DCFCE7' }}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#16A34A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
          <polyline points="22 4 12 14.01 9 11.01" />
        </svg>
      </div>
      <div style={{ flex: 1 }}>
        <div style={connectTitleStyle}>Payout account connected</div>
        <div style={connectStatusRowStyle}>
          <ConnectStatusDot enabled={true} label="Onboarding complete" />
          <ConnectStatusDot enabled={status.payouts_enabled} label={status.payouts_enabled ? 'Payouts enabled' : 'Payouts pending verification'} />
          <ConnectStatusDot enabled={status.charges_enabled} label={status.charges_enabled ? 'Charges enabled' : 'Charges pending'} />
        </div>
        {!status.payouts_enabled && (
          <div style={{ marginTop: 8, fontSize: 13, color: '#92400E' }}>
            Stripe is still verifying your account. Automatic payouts will be available once verification is complete.
          </div>
        )}
      </div>
      <button type="button" onClick={onRefresh} style={connectRefreshStyle}>
        Refresh status
      </button>
    </div>
  )
}

function ConnectStatusDot({ enabled, label }: { enabled: boolean; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
      <div
        style={{
          width: 8,
          height: 8,
          borderRadius: 999,
          background: enabled ? '#16A34A' : '#D1D5DB',
          flexShrink: 0,
        }}
      />
      <span style={{ color: enabled ? '#166534' : '#64748B' }}>{label}</span>
    </div>
  )
}

const REVIEW_PREVIEW_LIMIT = 120

function ReviewBlock({
  label,
  rating,
  review,
}: {
  label: string
  rating: number
  review: string | null
}) {
  const [expanded, setExpanded] = useState(false)
  const isLong = review != null && review.length > REVIEW_PREVIEW_LIMIT

  return (
    <div style={reviewBlockStyle}>
      <div style={reviewHeaderStyle}>
        <span style={reviewLabelStyle}>{label}</span>
        <span style={reviewStarsStyle}>
          <span style={{ color: '#F59E0B' }}>{'★'.repeat(rating)}</span>
          <span style={{ color: '#E2E8F0' }}>{'★'.repeat(5 - rating)}</span>
        </span>
      </div>
      {review && (
        <div style={reviewTextStyle}>
          {isLong && !expanded ? review.slice(0, REVIEW_PREVIEW_LIMIT) + '...' : review}
          {isLong && (
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              style={expandButtonStyle}
            >
              {expanded ? 'Show less' : 'Read more'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function TransferStatusLabel({ payout }: { payout?: WalkerPayoutRow }) {
  if (!payout) {
    return <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 2 }}>Net earnings</div>
  }

  const statusMap: Record<string, { color: string; text: string }> = {
    pending: { color: '#92400E', text: 'Transfer pending' },
    processing: { color: '#92400E', text: 'Processing payout' },
    transferred: { color: '#1D4ED8', text: 'Transferred to Stripe' },
    in_transit: { color: '#6D28D9', text: 'In transit to bank' },
    paid_out: { color: '#15803D', text: 'Paid to bank' },
    failed: { color: '#DC2626', text: 'Transfer failed' },
    reversed: { color: '#DC2626', text: 'Transfer reversed' },
    refunded: { color: '#991B1B', text: 'Payment refunded' },
  }

  const s = statusMap[payout.status] || statusMap.pending

  return (
    <div style={{ fontSize: 11, color: s.color, marginTop: 2, fontWeight: 600 }}>
      {s.text}
      {payout.failure_reason && (
        <div style={{ fontWeight: 400, fontSize: 10, marginTop: 2 }}>
          {payout.failure_reason}
        </div>
      )}
    </div>
  )
}

function EstimatedEarnings({ job }: { job: WalkRequestRow }) {
  const earnings = job.walker_earnings ?? (job.price != null ? Math.round(job.price * 0.8 * 100) / 100 : null)

  if (earnings == null) return null

  return (
    <div style={estimatedEarningsStyle}>
      <span style={{ fontWeight: 800 }}>
        You will earn: {earnings.toLocaleString('he-IL', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })} ILS
      </span>
      <span style={{ fontSize: 11, color: '#94A3B8', marginLeft: 8 }}>
        After fees
      </span>
    </div>
  )
}

function MessageBox({
  text,
  kind,
}: {
  text: string
  kind: 'error' | 'success'
}) {
  const isError = kind === 'error'

  return (
    <div
      style={{
        marginTop: 16,
        borderRadius: 14,
        padding: '12px 16px',
        fontSize: 14,
        background: isError ? '#FEF2F2' : '#ECFDF3',
        color: isError ? '#B91C1C' : '#166534',
        border: `1px solid ${isError ? '#FECACA' : '#BBF7D0'}`,
      }}
    >
      {text}
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { bg: string; color: string; text: string }> = {
    open: { bg: '#EFF6FF', color: '#1D4ED8', text: 'Open' },
    accepted: { bg: '#FFF7ED', color: '#C2410C', text: 'In Progress' },
    completed: { bg: '#F0FDF4', color: '#15803D', text: 'Completed' },
    cancelled: { bg: '#FEF2F2', color: '#B91C1C', text: 'Cancelled' },
  }

  const s = map[status] || map.open

  return (
    <span
      style={{
        display: 'inline-block',
        borderRadius: 999,
        padding: '3px 10px',
        fontSize: 11,
        fontWeight: 700,
        background: s.bg,
        color: s.color,
        letterSpacing: 0.3,
      }}
    >
      {s.text}
    </span>
  )
}

function PaymentBadge() {
  return (
    <span
      style={{
        display: 'inline-block',
        borderRadius: 999,
        padding: '3px 10px',
        fontSize: 11,
        fontWeight: 700,
        background: '#F0FDF4',
        color: '#15803D',
        letterSpacing: 0.3,
      }}
    >
      Paid
    </span>
  )
}

function PayoutStatusBadge({ status }: { status: 'pending' | 'approved' | 'paid' | 'rejected' }) {
  const map: Record<string, { bg: string; color: string; text: string }> = {
    pending: { bg: '#FEF3C7', color: '#92400E', text: 'Pending' },
    approved: { bg: '#DBEAFE', color: '#1D4ED8', text: 'Approved' },
    paid: { bg: '#F0FDF4', color: '#15803D', text: 'Paid' },
    rejected: { bg: '#FEF2F2', color: '#B91C1C', text: 'Rejected' },
  }

  const s = map[status] || map.pending

  return (
    <span
      style={{
        display: 'inline-block',
        borderRadius: 999,
        padding: '3px 10px',
        fontSize: 11,
        fontWeight: 700,
        background: s.bg,
        color: s.color,
        letterSpacing: 0.3,
      }}
    >
      {s.text}
    </span>
  )
}

function formatDate(value: string | null) {
  if (!value) return '-'
  return new Date(value).toLocaleString()
}

function formatRelativeDate(value: string | null) {
  if (!value) return ''
  const now = Date.now()
  const then = new Date(value).getTime()
  const diffMs = now - then
  const diffMin = Math.floor(diffMs / 60000)
  const diffHrs = Math.floor(diffMin / 60)
  const diffDays = Math.floor(diffHrs / 24)

  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  if (diffHrs < 24) return `${diffHrs}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  return new Date(value).toLocaleDateString()
}

/* ─── Styles ──────────────────────────────────────────────── */

const pageStyle: React.CSSProperties = {
  minHeight: '100svh',
  background: '#F8FAFC',
  padding: '28px 20px',
  paddingTop: 'calc(28px + env(safe-area-inset-top))',
  paddingBottom: 'calc(28px + env(safe-area-inset-bottom))',
  fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
  color: '#0F172A',
}

const headerStyle: React.CSSProperties = {
  background: '#0F172A',
  color: '#FFFFFF',
  borderRadius: 20,
  padding: '22px 28px',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 16,
}

const logoutButtonStyle: React.CSSProperties = {
  border: '1px solid rgba(255,255,255,0.15)',
  borderRadius: 12,
  padding: '8px 16px',
  background: 'transparent',
  color: '#FFFFFF',
  fontWeight: 600,
  fontSize: 13,
  cursor: 'pointer',
}

const walletGridStyle: React.CSSProperties = {
  marginTop: 20,
  display: 'grid',
  gridTemplateColumns: '1.2fr 1fr 0.8fr',
  gap: 14,
}

const walletCardPrimaryStyle: React.CSSProperties = {
  background: 'linear-gradient(135deg, #0F172A 0%, #1E293B 100%)',
  color: '#FFFFFF',
  borderRadius: 20,
  padding: '24px 28px',
}

const walletCardStyle: React.CSSProperties = {
  background: '#FFFFFF',
  borderRadius: 20,
  padding: '24px 28px',
  border: '1px solid #E2E8F0',
}

const walletLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  textTransform: 'uppercase' as const,
  letterSpacing: 0.8,
  opacity: 0.6,
  marginBottom: 8,
}

const walletValuePrimaryStyle: React.CSSProperties = {
  fontSize: 36,
  fontWeight: 800,
  lineHeight: 1.1,
}

const walletValueStyle: React.CSSProperties = {
  fontSize: 28,
  fontWeight: 800,
  color: '#0F172A',
  lineHeight: 1.1,
}

const sectionTitleStyle: React.CSSProperties = {
  margin: '0 0 16px',
  fontSize: 18,
  fontWeight: 700,
  display: 'flex',
  alignItems: 'center',
  gap: 10,
}

const countBadgeStyle: React.CSSProperties = {
  background: '#EFF6FF',
  color: '#1D4ED8',
  borderRadius: 999,
  padding: '2px 10px',
  fontSize: 13,
  fontWeight: 700,
}

const twoColumnStyle: React.CSSProperties = {
  marginTop: 24,
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 24,
  alignItems: 'start',
}

const jobCardStyle: React.CSSProperties = {
  background: '#FFFFFF',
  borderRadius: 16,
  padding: 20,
  border: '1px solid #E2E8F0',
  boxShadow: '0 1px 3px rgba(15, 23, 42, 0.04)',
}

const jobCardHeaderStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  gap: 12,
}

const jobTitleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 700,
  color: '#0F172A',
}

const jobMetaStyle: React.CSSProperties = {
  fontSize: 13,
  color: '#64748B',
  marginTop: 3,
}

const jobDetailsStyle: React.CSSProperties = {
  marginTop: 12,
  fontSize: 13,
  color: '#64748B',
  display: 'grid',
  gap: 3,
}

const jobActionsStyle: React.CSSProperties = {
  display: 'flex',
  gap: 10,
  marginTop: 16,
}

const openJobCardStyle: React.CSSProperties = {
  background: '#FFFFFF',
  borderRadius: 16,
  padding: 18,
  border: '1px solid #E2E8F0',
}

const historyCardStyle: React.CSSProperties = {
  background: '#FFFFFF',
  borderRadius: 14,
  padding: '16px 20px',
  border: '1px solid #E2E8F0',
}

const earningsAmountStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 800,
  color: '#15803D',
}

const estimatedEarningsStyle: React.CSSProperties = {
  marginTop: 12,
  padding: '10px 14px',
  borderRadius: 10,
  background: '#F0FDF4',
  color: '#15803D',
  fontSize: 14,
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
}

const acceptButtonStyle: React.CSSProperties = {
  marginTop: 14,
  width: '100%',
  border: 'none',
  borderRadius: 12,
  padding: '10px 16px',
  background: '#0F172A',
  color: '#FFFFFF',
  fontWeight: 700,
  fontSize: 14,
  cursor: 'pointer',
}

const completeButtonStyle: React.CSSProperties = {
  flex: 1,
  border: 'none',
  borderRadius: 12,
  padding: '10px 16px',
  background: '#15803D',
  color: '#FFFFFF',
  fontWeight: 700,
  fontSize: 14,
  cursor: 'pointer',
}

const releaseButtonStyle: React.CSSProperties = {
  flex: 1,
  border: '1px solid #E2E8F0',
  borderRadius: 12,
  padding: '10px 16px',
  background: '#FFFFFF',
  color: '#64748B',
  fontWeight: 600,
  fontSize: 14,
  cursor: 'pointer',
}

const rateClientButtonStyle: React.CSSProperties = {
  marginTop: 8,
  border: 'none',
  borderRadius: 10,
  padding: '6px 14px',
  background: '#F59E0B',
  color: '#FFFFFF',
  fontWeight: 700,
  fontSize: 13,
  cursor: 'pointer',
}

const emptyStateStyle: React.CSSProperties = {
  background: '#FFFFFF',
  borderRadius: 16,
  padding: 28,
  textAlign: 'center' as const,
  color: '#94A3B8',
  border: '1px dashed #E2E8F0',
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(15, 23, 42, 0.5)',
  display: 'grid',
  placeItems: 'center',
  zIndex: 1000,
}

const modalStyle: React.CSSProperties = {
  background: '#FFFFFF',
  borderRadius: 20,
  padding: 28,
  width: '100%',
  maxWidth: 480,
  boxShadow: '0 18px 40px rgba(15, 23, 42, 0.2)',
}

const reviewsSectionStyle: React.CSSProperties = {
  marginTop: 12,
  display: 'grid',
  gap: 8,
}

const reviewBlockStyle: React.CSSProperties = {
  background: '#F8FAFC',
  borderRadius: 10,
  padding: '10px 14px',
  border: '1px solid #E2E8F0',
}

const reviewHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
}

const reviewLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: '#64748B',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
}

const reviewStarsStyle: React.CSSProperties = {
  fontSize: 14,
  letterSpacing: 1,
}

const reviewTextStyle: React.CSSProperties = {
  marginTop: 6,
  fontSize: 13,
  lineHeight: 1.5,
  color: '#334155',
}

const expandButtonStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: '#3B82F6',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  padding: 0,
  marginLeft: 4,
}

const payoutFormCardStyle: React.CSSProperties = {
  background: '#FFFFFF',
  borderRadius: 16,
  padding: 20,
  border: '1px solid #E2E8F0',
}

const payoutEmptyStyle: React.CSSProperties = {
  background: '#F8FAFC',
  borderRadius: 12,
  padding: '24px 20px',
  textAlign: 'center' as const,
}

const payoutLabelStyle: React.CSSProperties = {
  display: 'block',
  marginBottom: 6,
  fontSize: 13,
  fontWeight: 600,
  color: '#475569',
}

const payoutInputStyle: React.CSSProperties = {
  width: '100%',
  border: '1px solid #E2E8F0',
  borderRadius: 10,
  padding: '10px 12px',
  fontSize: 14,
  outline: 'none',
  boxSizing: 'border-box' as const,
}

const payoutButtonStyle: React.CSSProperties = {
  border: 'none',
  borderRadius: 12,
  padding: '10px 20px',
  background: '#0F172A',
  color: '#FFFFFF',
  fontWeight: 700,
  fontSize: 14,
  whiteSpace: 'nowrap' as const,
  height: 42,
}

const payoutRowStyle: React.CSSProperties = {
  background: '#FFFFFF',
  borderRadius: 12,
  padding: '14px 18px',
  border: '1px solid #E2E8F0',
  display: 'flex',
  alignItems: 'center',
  gap: 16,
}

const payoutNoticeStyle: React.CSSProperties = {
  marginBottom: 14,
  padding: '10px 14px',
  borderRadius: 10,
  background: '#FEF3C7',
  color: '#92400E',
  fontSize: 13,
  lineHeight: 1.5,
}

const connectCardStyle: React.CSSProperties = {
  marginTop: 20,
  display: 'flex',
  alignItems: 'center',
  gap: 18,
  background: '#FFFFFF',
  borderRadius: 20,
  padding: '22px 28px',
  border: '1px solid #E2E8F0',
  flexWrap: 'wrap',
}

const connectIconStyle: React.CSSProperties = {
  width: 48,
  height: 48,
  borderRadius: 14,
  background: '#EEF2FF',
  display: 'grid',
  placeItems: 'center',
  flexShrink: 0,
}

const connectTitleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 700,
  color: '#0F172A',
  marginBottom: 4,
}

const connectDescStyle: React.CSSProperties = {
  fontSize: 14,
  color: '#64748B',
  lineHeight: 1.5,
}

const connectStatusRowStyle: React.CSSProperties = {
  marginTop: 8,
  display: 'flex',
  flexWrap: 'wrap' as const,
  gap: 14,
}

const connectButtonStyle: React.CSSProperties = {
  border: 'none',
  borderRadius: 12,
  padding: '12px 22px',
  background: '#6366F1',
  color: '#FFFFFF',
  fontWeight: 700,
  fontSize: 14,
  whiteSpace: 'nowrap' as const,
}

const connectRefreshStyle: React.CSSProperties = {
  border: '1px solid #E2E8F0',
  borderRadius: 10,
  padding: '8px 14px',
  background: '#FFFFFF',
  color: '#64748B',
  fontWeight: 600,
  fontSize: 13,
  cursor: 'pointer',
  whiteSpace: 'nowrap' as const,
}

const fixedBottomCtaContainerStyle: React.CSSProperties = {
  position: 'fixed',
  bottom: 0,
  left: 0,
  right: 0,
  zIndex: 900,
  background: 'linear-gradient(transparent, rgba(248,250,252,0.95) 20%)',
  padding: '24px 20px calc(20px + env(safe-area-inset-bottom))',
  pointerEvents: 'none',
}

const fixedBottomCtaInnerStyle: React.CSSProperties = {
  maxWidth: 1100,
  margin: '0 auto',
  pointerEvents: 'auto',
  textAlign: 'center' as const,
}

const fixedCompleteButtonStyle: React.CSSProperties = {
  width: '100%',
  border: 'none',
  borderRadius: 16,
  padding: '16px 24px',
  background: '#15803D',
  color: '#FFFFFF',
  fontWeight: 800,
  fontSize: 16,
  cursor: 'pointer',
  boxShadow: '0 4px 20px rgba(21, 128, 61, 0.3)',
  transition: 'opacity 0.15s, transform 0.15s',
}

const spinnerStyle: React.CSSProperties = {
  display: 'inline-block',
  width: 16,
  height: 16,
  border: '2px solid rgba(255,255,255,0.3)',
  borderTopColor: '#FFFFFF',
  borderRadius: 999,
  animation: 'completionSpin 0.6s linear infinite',
}
