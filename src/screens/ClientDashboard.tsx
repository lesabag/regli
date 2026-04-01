import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { loadStripe } from '@stripe/stripe-js'
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js'
import { supabase } from '../services/supabaseClient'
import NotificationsBell, { createNotification } from '../components/NotificationsBell'
import MapView from '../components/MapView'
import { useJobTracking } from '../hooks/useJobTracking'
import {
  createPaymentIntent,
  SERVICE_LABELS,
  SERVICE_PRICES_ILS,
  type ServiceType,
} from '../lib/payments'

const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY)

type AppRole = 'client' | 'walker' | 'admin'

interface ClientDashboardProps {
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
  selected_walker_id: string | null
  status: 'awaiting_payment' | 'open' | 'accepted' | 'completed' | 'cancelled'
  dog_name: string | null
  location: string | null
  notes: string | null
  created_at: string | null
  price: number | null
  amount: number | null
  currency: string | null
  platform_fee: number | null
  walker_amount: number | null
  payment_status: 'unpaid' | 'authorized' | 'paid' | 'failed' | 'refunded'
  paid_at: string | null
  stripe_payment_intent_id: string | null
  stripe_client_secret: string | null
}

interface WalkerProfileRow {
  id: string
  email: string | null
  full_name: string | null
  role: AppRole
  stripe_connect_account_id: string | null
  charges_enabled: boolean
  payouts_enabled: boolean
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

export default function ClientDashboard({
  profile,
  onSignOut,
}: ClientDashboardProps) {
  // Form state
  const [dogName, setDogName] = useState('')
  const [location, setLocation] = useState('')
  const [notes, setNotes] = useState('')
  const [serviceType, setServiceType] = useState<ServiceType>('standard')
  const [selectedWalkerId, setSelectedWalkerId] = useState<string>('')

  // Loading/feedback
  const [loading, setLoading] = useState(false)
  const [jobsLoading, setJobsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  // Data
  const [requests, setRequests] = useState<WalkRequestRow[]>([])
  const [walkers, setWalkers] = useState<WalkerProfileRow[]>([])

  // Payment modal
  const [payingJobId, setPayingJobId] = useState<string | null>(null)
  const [clientSecret, setClientSecret] = useState<string | null>(null)
  const [paymentLoading] = useState(false)

  // Ratings
  const [myRatings, setMyRatings] = useState<RatingRow[]>([])
  const [walkerRatingsOfMe, setWalkerRatingsOfMe] = useState<RatingRow[]>([])
  const [ratingJobId, setRatingJobId] = useState<string | null>(null)
  const [ratingValue, setRatingValue] = useState(0)
  const [ratingHover, setRatingHover] = useState(0)
  const [ratingReview, setRatingReview] = useState('')
  const [ratingSubmitting, setRatingSubmitting] = useState(false)

  const clientName = profile.full_name || profile.email || 'Client'

  const walkerNameById = useMemo(() => {
    const map = new Map<string, string>()
    walkers.forEach((w) => {
      map.set(w.id, w.full_name || w.email || 'Unknown walker')
    })
    return map
  }, [walkers])

  const availableWalkers = useMemo(
    () =>
      walkers.filter(
        (w) =>
          w.role === 'walker' &&
          !!w.stripe_connect_account_id &&
          w.charges_enabled &&
          w.payouts_enabled
      ),
    [walkers]
  )

  const ratedJobIds = useMemo(() => {
    const set = new Set<string>()
    myRatings.forEach((r) => set.add(r.job_id))
    return set
  }, [myRatings])

  const myRatingByJobId = useMemo(() => {
    const map = new Map<string, RatingRow>()
    myRatings.forEach((r) => map.set(r.job_id, r))
    return map
  }, [myRatings])

  const walkerRatingByJobId = useMemo(() => {
    const map = new Map<string, RatingRow>()
    walkerRatingsOfMe.forEach((r) => map.set(r.job_id, r))
    return map
  }, [walkerRatingsOfMe])

  // ─── Live tracking ────────────────────────────────────────

  const trackedJob = useMemo(
    () => requests.find((r) => r.status === 'accepted' && r.walker_id),
    [requests]
  )

  const { walkerLocation, walkerBearing, userLocation, hasUserLocation, etaMinutes, isArrived, gpsQuality, proximityLevel, routePolyline } = useJobTracking(
    trackedJob?.id ?? null
  )

  // ─── Completion success state ────────────────────────────────
  // Detect when the tracked job transitions to completed and show a success card

  const [completionSuccess, setCompletionSuccess] = useState<{
    jobId: string
    walkerId: string
    dogName: string
    walkerName: string
  } | null>(null)

  // Inline rating state for the completion card (separate from the modal)
  const [completionRating, setCompletionRating] = useState(0)
  const [completionRatingHover, setCompletionRatingHover] = useState(0)
  const [completionReview, setCompletionReview] = useState('')
  const [completionRatingSubmitting, setCompletionRatingSubmitting] = useState(false)
  const [completionRatingDone, setCompletionRatingDone] = useState(false)

  const lastTrackedJobIdRef = useRef<string | null>(null)

  useEffect(() => {
    const currentId = trackedJob?.id ?? null

    // If we were tracking a job and it disappeared (completed/cancelled),
    // check if it was just completed
    if (lastTrackedJobIdRef.current && !currentId) {
      const finishedJob = requests.find(
        (r) => r.id === lastTrackedJobIdRef.current && r.status === 'completed'
      )
      if (finishedJob && finishedJob.walker_id) {
        const wName = walkerNameById.get(finishedJob.walker_id) || 'Your walker'
        // Only show rating prompt if not already rated
        const alreadyRated = ratedJobIds.has(finishedJob.id)
        setCompletionRating(0)
        setCompletionRatingHover(0)
        setCompletionReview('')
        setCompletionRatingSubmitting(false)
        setCompletionRatingDone(alreadyRated)
        setCompletionSuccess({
          jobId: finishedJob.id,
          walkerId: finishedJob.walker_id,
          dogName: finishedJob.dog_name || 'your dog',
          walkerName: wName,
        })
      }
    }

    lastTrackedJobIdRef.current = currentId
  }, [trackedJob?.id, requests, walkerNameById, ratedJobIds])

  // ─── "Walker arrived" notification (once per job per session) ─

  const arrivedNotifiedJobRef = useRef<string | null>(null)

  useEffect(() => {
    if (!isArrived || !trackedJob?.id || !trackedJob.walker_id) return
    if (arrivedNotifiedJobRef.current === trackedJob.id) return

    arrivedNotifiedJobRef.current = trackedJob.id

    const walkerLabel = walkerNameById.get(trackedJob.walker_id) || 'Your walker'

    // Check DB to prevent duplicate across page refreshes
    supabase
      .from('notifications')
      .select('id')
      .eq('user_id', profile.id)
      .eq('type', 'walker_arrived')
      .eq('related_job_id', trackedJob.id)
      .limit(1)
      .then(({ data }) => {
        if (data && data.length > 0) return // already notified in a prior session

        createNotification({
          userId: profile.id,
          type: 'walker_arrived',
          title: 'Walker Arrived',
          message: `${walkerLabel} arrived at your location.`,
          relatedJobId: trackedJob.id,
        })
      })
  }, [isArrived, trackedJob?.id, trackedJob?.walker_id, profile.id, walkerNameById])

  // ─── Data loading ──────────────────────────────────────────

  const loadWalkers = async () => {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, email, full_name, role, stripe_connect_account_id, charges_enabled, payouts_enabled')
      .eq('role', 'walker')

    if (error) {
      console.error('Failed to load walkers', error.message)
      return
    }
    setWalkers((data as WalkerProfileRow[]) || [])
  }

  const loadMyRequests = async () => {
    setJobsLoading(true)

    const { data, error } = await supabase
      .from('walk_requests')
      .select(
        'id, client_id, walker_id, selected_walker_id, status, dog_name, location, notes, created_at, price, amount, currency, platform_fee, walker_amount, payment_status, paid_at, stripe_payment_intent_id, stripe_client_secret'
      )
      .eq('client_id', profile.id)
      .order('created_at', { ascending: false })

    if (error) {
      setError(error.message)
      setRequests([])
      setJobsLoading(false)
      return
    }

    setRequests((data as WalkRequestRow[]) || [])
    setJobsLoading(false)
  }

  const loadRatings = useCallback(async () => {
    const { data: given, error: givenErr } = await supabase
      .from('ratings')
      .select('*')
      .eq('from_user_id', profile.id)

    if (givenErr) {
      console.error('Failed to load given ratings', givenErr.message)
    } else {
      setMyRatings((given as RatingRow[]) || [])
    }

    const { data: received, error: receivedErr } = await supabase
      .from('ratings')
      .select('*')
      .eq('to_user_id', profile.id)

    if (receivedErr) {
      console.error('Failed to load received ratings', receivedErr.message)
    } else {
      setWalkerRatingsOfMe((received as RatingRow[]) || [])
    }
  }, [profile.id])

  useEffect(() => {
    loadWalkers()
    loadMyRequests()
    loadRatings()

    const requestsChannel = supabase
      .channel(`client-walk-requests-${profile.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'walk_requests',
          filter: `client_id=eq.${profile.id}`,
        },
        async () => {
          await loadMyRequests()
        }
      )
      .subscribe()

    const profilesChannel = supabase
      .channel(`client-profiles-${profile.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'profiles',
        },
        () => {
          loadWalkers()
        }
      )
      .subscribe()

    const ratingsChannel = supabase
      .channel(`client-ratings-${profile.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'ratings',
        },
        () => {
          loadRatings()
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(requestsChannel)
      supabase.removeChannel(profilesChannel)
      supabase.removeChannel(ratingsChannel)
    }
  }, [profile.id, loadRatings])

  // ─── Actions ───────────────────────────────────────────────

  const handleBookAndPay = async () => {
    setError(null)
    setSuccessMessage(null)

    if (!dogName.trim()) {
      setError('Please enter a dog name.')
      return
    }
    if (!location.trim()) {
      setError('Please enter a location.')
      return
    }
    if (!selectedWalkerId) {
      setError('Please select a walker.')
      return
    }

    setLoading(true)

    const { data, error: payErr } = await createPaymentIntent({
      dogName: dogName.trim(),
      location: location.trim(),
      notes: notes.trim() || undefined,
      serviceType,
      walkerId: selectedWalkerId,
    })

    if (payErr) {
      setError(payErr)
      setLoading(false)
      return
    }

    if (!data) {
      setError('Empty response from server')
      setLoading(false)
      return
    }

    // Open payment modal with the client secret
    setPayingJobId(data.jobId)
    setClientSecret(data.clientSecret)
    setLoading(false)

    // Reset form
    setDogName('')
    setLocation('')
    setNotes('')

    await loadMyRequests()
  }

  const handlePayClick = async (jobId: string) => {
    // For existing awaiting_payment jobs that already have a client secret
    const job = requests.find((r) => r.id === jobId)
    if (!job?.stripe_client_secret) {
      setError('No payment information found for this job')
      return
    }

    setPayingJobId(jobId)
    setClientSecret(job.stripe_client_secret)
  }

  const handlePaymentSuccess = async (_paymentIntentId: string) => {
    if (!payingJobId) return

    // Update the job status in DB
    const { error: updateErr } = await supabase
      .from('walk_requests')
      .update({
        payment_status: 'authorized',
        payment_authorized_at: new Date().toISOString(),
        status: 'open',
      })
      .eq('id', payingJobId)

    if (updateErr) {
      setError('Payment succeeded but failed to update job status: ' + updateErr.message)
    }

    const paidJob = requests.find((r) => r.id === payingJobId)
    const dogLabel = paidJob?.dog_name || 'your dog'
    const priceIls = paidJob?.price != null ? `${paidJob.price} ILS` : ''

    await createNotification({
      userId: profile.id,
      type: 'payment_success',
      title: 'Payment Authorized',
      message: `Your payment${priceIls ? ` of ${priceIls}` : ''} for ${dogLabel}'s walk has been authorized. Your job is now visible to walkers!`,
      relatedJobId: payingJobId,
    })

    // Notify the selected walker that a new job is available for them
    if (paidJob?.selected_walker_id) {
      await createNotification({
        userId: paidJob.selected_walker_id,
        type: 'job_created',
        title: 'New Walk Request',
        message: `A new walk request for ${dogLabel}${priceIls ? ` (${priceIls})` : ''} is waiting for you!`,
        relatedJobId: payingJobId,
      }).catch((err) => console.error('job_created notification failed:', err))
    }

    setPayingJobId(null)
    setClientSecret(null)
    setSuccessMessage('Payment authorized! Your job is now visible to walkers.')
    await loadMyRequests()
  }

  const handlePaymentCancel = () => {
    setPayingJobId(null)
    setClientSecret(null)
  }

  // ─── Inline completion rating ─────────────────────────────

  const handleCompletionRatingSubmit = async () => {
    if (!completionSuccess || completionRating < 1) return

    setCompletionRatingSubmitting(true)

    const { error } = await supabase.from('ratings').insert({
      job_id: completionSuccess.jobId,
      from_user_id: profile.id,
      to_user_id: completionSuccess.walkerId,
      rating: completionRating,
      review: completionReview.trim() || null,
    })

    if (error) {
      // If duplicate, just treat as done
      if (error.code === '23505') {
        setCompletionRatingDone(true)
        setCompletionRatingSubmitting(false)
        return
      }
      setError(error.message)
      setCompletionRatingSubmitting(false)
      return
    }

    await createNotification({
      userId: completionSuccess.walkerId,
      type: 'new_rating',
      title: 'New Rating Received',
      message: `You received a ${completionRating}-star rating for walking ${completionSuccess.dogName}.`,
      relatedJobId: completionSuccess.jobId,
    }).catch(() => {})

    setCompletionRatingDone(true)
    setCompletionRatingSubmitting(false)
    await loadRatings()
  }

  // ─── Ratings ───────────────────────────────────────────────

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

    const job = requests.find((r) => r.id === ratingJobId)
    if (!job || !job.walker_id) return

    setRatingSubmitting(true)

    const { error } = await supabase.from('ratings').insert({
      job_id: ratingJobId,
      from_user_id: profile.id,
      to_user_id: job.walker_id,
      rating: ratingValue,
      review: ratingReview.trim() || null,
    })

    if (error) {
      setError(error.message)
      setRatingSubmitting(false)
      return
    }

    await createNotification({
      userId: job.walker_id,
      type: 'new_rating',
      title: 'New Rating Received',
      message: `You received a ${ratingValue}-star rating for walking ${job.dog_name || 'a dog'}.`,
      relatedJobId: ratingJobId,
    })

    setRatingSubmitting(false)
    closeRatingModal()
    setSuccessMessage('Rating submitted!')
    await loadRatings()
  }

  // ─── Render ────────────────────────────────────────────────

  return (
    <div
      style={{
        minHeight: '100svh',
        background: '#F8FAFC',
        padding: '28px 20px',
        paddingTop: 'calc(28px + env(safe-area-inset-top))',
        paddingBottom: 'calc(28px + env(safe-area-inset-bottom))',
        fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
        color: '#0F172A',
      }}
    >
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        <div
          style={{
            background: '#0F172A',
            color: '#FFFFFF',
            borderRadius: 20,
            padding: '22px 28px',
            display: 'flex',
            justifyContent: 'space-between',
            gap: 16,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <div>
            <div style={{ fontSize: 12, opacity: 0.6, letterSpacing: 1, textTransform: 'uppercase' as const }}>
              Regli
            </div>
            <h1 style={{ margin: '6px 0 0', fontSize: 28, fontWeight: 800 }}>
              Welcome, {clientName}
            </h1>
            <p style={{ margin: '6px 0 0', fontSize: 14, opacity: 0.8 }}>
              Book a walk, track your walker in real time.
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <NotificationsBell variant="light" />
            <button
              type="button"
              onClick={onSignOut}
              style={logoutButtonStyle}
            >
              Sign out
            </button>
          </div>
        </div>

        {error && <MessageBox text={error} kind="error" />}
        {successMessage && <MessageBox text={successMessage} kind="success" />}

        {/* Payment Modal */}
        {payingJobId && clientSecret && (
          <div style={paymentOverlayStyle} onClick={handlePaymentCancel}>
            <div style={paymentSheetStyle} onClick={(e) => e.stopPropagation()}>
              <div style={{ padding: '24px 28px', paddingBottom: 'calc(24px + env(safe-area-inset-bottom))' }}>
                <h2 style={{ margin: '0 0 18px', fontSize: 20, fontWeight: 700 }}>Complete Payment</h2>
                <Elements stripe={stripePromise} options={{ clientSecret }}>
                  <CheckoutForm
                    onSuccess={handlePaymentSuccess}
                    onCancel={handlePaymentCancel}
                  />
                </Elements>
              </div>
            </div>
          </div>
        )}

        {/* Rating Modal */}
        {ratingJobId && (
          <div style={overlayStyle}>
            <div style={modalStyle}>
              <h2 style={{ margin: '0 0 18px', fontSize: 20, fontWeight: 700 }}>Rate your walker</h2>
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
                  ...inputStyle,
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
                    ...primaryButtonStyle,
                    flex: 1,
                    opacity: ratingValue < 1 || ratingSubmitting ? 0.6 : 1,
                    cursor: ratingValue < 1 || ratingSubmitting ? 'not-allowed' : 'pointer',
                  }}
                >
                  {ratingSubmitting ? 'Submitting...' : 'Submit Rating'}
                </button>
                <button
                  type="button"
                  onClick={closeRatingModal}
                  disabled={ratingSubmitting}
                  style={cancelButtonStyle}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Completion Success Card with Inline Rating */}
        {completionSuccess && (
          <div
            style={{
              marginTop: 20,
              background: '#FFFFFF',
              borderRadius: 20,
              padding: 28,
              border: '1px solid #BBF7D0',
              textAlign: 'center' as const,
              animation: 'completionSlideUp 0.4s ease-out',
            }}
          >
            <div
              style={{
                width: 56,
                height: 56,
                borderRadius: 999,
                background: '#DCFCE7',
                display: 'grid',
                placeItems: 'center',
                margin: '0 auto 16px',
                animation: 'checkmarkPop 0.5s ease-out 0.15s both',
              }}
            >
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#16A34A" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <h2 style={{ margin: '0 0 6px', fontSize: 20, fontWeight: 800, color: '#0F172A' }}>
              Walk completed successfully
            </h2>
            <p style={{ margin: '0 0 20px', fontSize: 14, color: '#64748B' }}>
              {completionSuccess.walkerName} finished walking {completionSuccess.dogName}.
            </p>

            {/* Inline rating */}
            {!completionRatingDone ? (
              <div
                style={{
                  background: '#F8FAFC',
                  borderRadius: 16,
                  padding: '20px 24px',
                  marginBottom: 16,
                  textAlign: 'center' as const,
                  animation: 'earningsCount 0.3s ease-out 0.35s both',
                }}
              >
                <div style={{ fontSize: 14, fontWeight: 700, color: '#0F172A', marginBottom: 12 }}>
                  How was your walk?
                </div>
                <div style={{ display: 'flex', justifyContent: 'center', gap: 4, marginBottom: 14 }}>
                  {[1, 2, 3, 4, 5].map((star) => (
                    <button
                      key={star}
                      type="button"
                      onMouseEnter={() => setCompletionRatingHover(star)}
                      onMouseLeave={() => setCompletionRatingHover(0)}
                      onClick={() => setCompletionRating(star)}
                      style={{
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        fontSize: 36,
                        color: star <= (completionRatingHover || completionRating) ? '#F59E0B' : '#D1D5DB',
                        padding: '0 2px',
                        transition: 'color 0.15s, transform 0.15s',
                        transform: star <= (completionRatingHover || completionRating) ? 'scale(1.1)' : 'scale(1)',
                      }}
                    >
                      ★
                    </button>
                  ))}
                </div>
                {completionRating > 0 && (
                  <div style={{ animation: 'completionFadeIn 0.2s ease-out' }}>
                    <textarea
                      value={completionReview}
                      onChange={(e) => setCompletionReview(e.target.value)}
                      placeholder="Add a note (optional)"
                      rows={2}
                      style={{
                        ...inputStyle,
                        resize: 'vertical',
                        minHeight: 56,
                        marginBottom: 12,
                        textAlign: 'left' as const,
                      }}
                    />
                    <button
                      type="button"
                      onClick={handleCompletionRatingSubmit}
                      disabled={completionRatingSubmitting}
                      style={{
                        ...primaryButtonStyle,
                        width: '100%',
                        opacity: completionRatingSubmitting ? 0.7 : 1,
                        cursor: completionRatingSubmitting ? 'not-allowed' : 'pointer',
                      }}
                    >
                      {completionRatingSubmitting ? 'Submitting...' : 'Submit Rating'}
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div
                style={{
                  background: '#F0FDF4',
                  borderRadius: 16,
                  padding: '14px 24px',
                  marginBottom: 16,
                  fontSize: 14,
                  fontWeight: 600,
                  color: '#166534',
                  animation: 'completionFadeIn 0.3s ease-out',
                }}
              >
                Thank you for your feedback!
              </div>
            )}

            <button
              type="button"
              onClick={() => setCompletionSuccess(null)}
              style={{
                border: completionRatingDone || completionRating === 0 ? 'none' : '1px solid #E2E8F0',
                borderRadius: 12,
                padding: '10px 28px',
                background: completionRatingDone || completionRating === 0 ? '#0F172A' : '#FFFFFF',
                color: completionRatingDone || completionRating === 0 ? '#FFFFFF' : '#64748B',
                fontWeight: 700,
                fontSize: 14,
                cursor: 'pointer',
              }}
            >
              {completionRatingDone ? 'Done' : completionRating === 0 ? 'Skip' : 'Skip Rating'}
            </button>
          </div>
        )}

        {/* Live Tracking */}
        {trackedJob && (
          <div
            style={{
              ...trackingCardStyle,
              ...(proximityLevel === 'arrived'
                ? { borderColor: '#BBF7D0', background: '#FAFFFE' }
                : {}),
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800 }}>
                    {proximityLevel === 'arrived' ? 'Walker Arrived' : 'Live Tracking'}
                  </h2>
                  {proximityLevel !== 'arrived' && (
                    <span style={trackingPulseDotStyle} />
                  )}
                  {proximityLevel === 'arrived' && (
                    <span style={{ fontSize: 18 }}>🐾</span>
                  )}
                </div>
                <div style={{ fontSize: 14, color: '#64748B', marginTop: 6 }}>
                  <span style={{ fontWeight: 600, color: '#0F172A' }}>
                    {trackedJob.dog_name || 'Walk'}
                  </span>
                  {' '}&mdash;{' '}
                  {walkerNameById.get(trackedJob.walker_id!) || 'Walker'}{' '}
                  {proximityLevel === 'arrived'
                    ? 'has arrived!'
                    : proximityLevel === 'arriving'
                    ? 'is arriving now!'
                    : proximityLevel === 'very_near'
                    ? 'is almost there!'
                    : proximityLevel === 'near'
                    ? 'is nearby'
                    : 'is on the way'}
                </div>
              </div>
              {proximityLevel === 'arrived' ? (
                <div style={{ ...etaBadgeStyle, background: '#DCFCE7', color: '#166534' }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#16A34A" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 2 }}>
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span style={{ fontSize: 12, fontWeight: 800 }}>Arrived</span>
                </div>
              ) : proximityLevel === 'arriving' ? (
                <div style={{ ...etaBadgeStyle, background: '#FEF3C7', color: '#92400E' }}>
                  <span style={{ fontSize: 13, fontWeight: 800 }}>Arriving now</span>
                </div>
              ) : proximityLevel === 'very_near' ? (
                <div style={{ ...etaBadgeStyle, background: '#EFF6FF', color: '#1D4ED8' }}>
                  <span style={{ fontSize: 13, fontWeight: 800 }}>Almost there</span>
                </div>
              ) : proximityLevel === 'near' && etaMinutes != null && gpsQuality === 'live' ? (
                <div style={etaBadgeStyle}>
                  <span style={{ fontSize: 20, fontWeight: 800, lineHeight: 1 }}>
                    {etaMinutes}
                  </span>
                  <span style={{ fontSize: 10, fontWeight: 600, opacity: 0.7 }}>
                    min &middot; nearby
                  </span>
                </div>
              ) : etaMinutes != null && gpsQuality === 'live' ? (
                <div style={etaBadgeStyle}>
                  <span style={{ fontSize: 24, fontWeight: 800, lineHeight: 1 }}>
                    {etaMinutes}
                  </span>
                  <span style={{ fontSize: 11, fontWeight: 600, opacity: 0.7 }}>
                    min ETA
                  </span>
                </div>
              ) : (
                <div style={{
                  ...etaBadgeStyle,
                  background: gpsQuality === 'offline' ? '#FEE2E2'
                    : gpsQuality === 'delayed' ? '#FEF3C7'
                    : '#F1F5F9',
                  color: gpsQuality === 'offline' ? '#991B1B'
                    : gpsQuality === 'delayed' ? '#92400E'
                    : '#64748B',
                }}>
                  <span style={{ fontSize: 12, fontWeight: 700 }}>
                    {gpsQuality === 'none' && !hasUserLocation && 'Requesting location...'}
                    {gpsQuality === 'none' && hasUserLocation && 'Waiting for walker location'}
                    {gpsQuality === 'live' && 'Calculating ETA...'}
                    {gpsQuality === 'last_known' && 'Using last known location'}
                    {gpsQuality === 'delayed' && 'GPS signal delayed'}
                    {gpsQuality === 'offline' && 'Walker temporarily offline'}
                  </span>
                </div>
              )}
            </div>
            <div
              style={{
                borderRadius: 16,
                overflow: 'hidden',
                height: 320,
                transition: 'opacity 0.5s ease',
                ...(proximityLevel === 'arrived' ? { opacity: 0.85 } : {}),
              }}
            >
              <MapView
                userLocation={userLocation}
                walkerLocation={walkerLocation ?? undefined}
                walkerBearing={walkerBearing}
                isArrived={isArrived}
                gpsQuality={gpsQuality}
                proximityLevel={proximityLevel}
                routePolyline={proximityLevel === 'arrived' ? [] : routePolyline}
              />
            </div>
          </div>
        )}

        <div
          style={{
            marginTop: 20,
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 20,
            alignItems: 'start',
          }}
        >
          {/* Book a Walk form */}
          <div style={cardStyle}>
            <h2 style={sectionTitleStyle}>Book a Walk</h2>

            <div style={{ display: 'grid', gap: 14 }}>
              <div>
                <label style={labelStyle}>Dog name</label>
                <input
                  value={dogName}
                  onChange={(e) => setDogName(e.target.value)}
                  placeholder="e.g. Rocky"
                  style={inputStyle}
                />
              </div>

              <div>
                <label style={labelStyle}>Location</label>
                <input
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="e.g. Tel Aviv, Dizengoff 20"
                  style={inputStyle}
                />
              </div>

              <div>
                <label style={labelStyle}>Notes (optional)</label>
                <input
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="e.g. Needs water, friendly dog"
                  style={inputStyle}
                />
              </div>

              <div>
                <label style={labelStyle}>Service type</label>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                  {(['quick', 'standard', 'energy'] as ServiceType[]).map((st) => (
                    <button
                      key={st}
                      type="button"
                      onClick={() => setServiceType(st)}
                      style={{
                        border: serviceType === st ? '2px solid #0F172A' : '1px solid #E2E8F0',
                        borderRadius: 12,
                        padding: '10px 8px',
                        background: serviceType === st ? '#EFF6FF' : '#FFFFFF',
                        cursor: 'pointer',
                        textAlign: 'center' as const,
                        transition: 'border-color 0.15s',
                      }}
                    >
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>
                        {SERVICE_LABELS[st]}
                      </div>
                      <div style={{ fontSize: 18, fontWeight: 800, color: '#15803D', marginTop: 2 }}>
                        {SERVICE_PRICES_ILS[st]} ILS
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label style={labelStyle}>Select walker</label>
                {availableWalkers.length === 0 ? (
                  <div style={{ fontSize: 13, color: '#94A3B8', padding: '10px 0' }}>
                    No walkers available for payment right now.
                  </div>
                ) : (
                  <select
                    value={selectedWalkerId}
                    onChange={(e) => setSelectedWalkerId(e.target.value)}
                    style={{
                      ...inputStyle,
                      appearance: 'auto' as React.CSSProperties['appearance'],
                    }}
                  >
                    <option value="">Choose a walker...</option>
                    {availableWalkers.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.full_name || w.email || w.id}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {/* Price summary */}
              {selectedWalkerId && (
                <div style={priceSummaryStyle}>
                  <div style={priceSummaryRow}>
                    <span>Walk price</span>
                    <span style={{ fontWeight: 600 }}>{SERVICE_PRICES_ILS[serviceType]} ILS</span>
                  </div>
                  <div style={priceSummaryRow}>
                    <span style={{ color: '#64748B' }}>Platform fee (20%)</span>
                    <span style={{ color: '#64748B' }}>{(SERVICE_PRICES_ILS[serviceType] * 0.2).toFixed(2)} ILS</span>
                  </div>
                  <div style={{ ...priceSummaryRow, borderTop: '1px solid #E2E8F0', paddingTop: 8, marginTop: 4 }}>
                    <span style={{ fontWeight: 600 }}>Walker receives</span>
                    <span style={{ fontWeight: 700, color: '#15803D' }}>
                      {(SERVICE_PRICES_ILS[serviceType] * 0.8).toFixed(2)} ILS
                    </span>
                  </div>
                </div>
              )}

              <button
                type="button"
                onClick={handleBookAndPay}
                disabled={loading || !selectedWalkerId || availableWalkers.length === 0}
                style={{
                  ...primaryButtonStyle,
                  opacity: loading || !selectedWalkerId ? 0.7 : 1,
                  cursor: loading || !selectedWalkerId ? 'not-allowed' : 'pointer',
                }}
              >
                {loading ? 'Creating order...' : `Book & Pay ${SERVICE_PRICES_ILS[serviceType]} ILS`}
              </button>
            </div>
          </div>

          {/* My Requests */}
          <div style={cardStyle}>
            <h2 style={sectionTitleStyle}>
              My Requests
              {requests.length > 0 && (
                <span style={countBadgeStyle}>{requests.length}</span>
              )}
            </h2>

            {jobsLoading ? (
              <div style={emptyStateStyle}>Loading requests...</div>
            ) : requests.length === 0 ? (
              <div style={emptyStateStyle}>
                <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>
                  No requests yet
                </div>
                <div style={{ fontSize: 13 }}>
                  Book your first walk and it will appear here
                </div>
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 14 }}>
                {requests.map((request) => {
                  const myRating = myRatingByJobId.get(request.id)
                  const walkerRating = walkerRatingByJobId.get(request.id)
                  const isCompleted = request.status === 'completed'
                  const isPaid = request.payment_status === 'paid' || request.payment_status === 'authorized'
                  const displayWalkerId = request.walker_id || request.selected_walker_id

                  return (
                    <div key={request.id} style={listCardStyle}>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          gap: 12,
                          alignItems: 'flex-start',
                          flexWrap: 'wrap',
                        }}
                      >
                        <div>
                          <div style={{ fontSize: 16, fontWeight: 700 }}>
                            {request.dog_name || 'Walk'}
                          </div>
                          <div style={{ fontSize: 13, color: '#64748B', marginTop: 3 }}>
                            {request.location || 'No location'}
                          </div>
                        </div>

                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <StatusBadge status={request.status} />
                          <PaymentStatusBadge status={request.payment_status} />
                        </div>
                      </div>

                      <div style={{ marginTop: 10, fontSize: 13, color: '#64748B', display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
                        <span>
                          {displayWalkerId
                            ? walkerNameById.get(displayWalkerId) || 'Walker'
                            : 'Unassigned'}
                        </span>
                        {request.price != null && (
                          <>
                            <span style={{ opacity: 0.4 }}>&middot;</span>
                            <span style={{ fontWeight: 600 }}>{request.price} ILS</span>
                          </>
                        )}
                        <span style={{ opacity: 0.4 }}>&middot;</span>
                        <span>{formatRelativeDate(request.created_at)}</span>
                      </div>

                      {/* Pay button for jobs that have a client secret but are still unpaid */}
                      {request.payment_status === 'unpaid' &&
                        request.stripe_client_secret && (
                          <button
                            type="button"
                            onClick={() => handlePayClick(request.id)}
                            disabled={paymentLoading && payingJobId === request.id}
                            style={{
                              ...payButtonStyle,
                              opacity:
                                paymentLoading && payingJobId === request.id
                                  ? 0.7
                                  : 1,
                              cursor:
                                paymentLoading && payingJobId === request.id
                                  ? 'not-allowed'
                                  : 'pointer',
                            }}
                          >
                            {paymentLoading && payingJobId === request.id
                              ? 'Loading...'
                              : `Pay ${request.price != null ? request.price + ' ILS' : ''}`}
                          </button>
                        )}

                      {isCompleted &&
                        isPaid &&
                        request.walker_id &&
                        !ratedJobIds.has(request.id) && (
                          <button
                            type="button"
                            onClick={() => openRatingModal(request.id)}
                            style={rateButtonStyle}
                          >
                            Rate your walker
                          </button>
                        )}

                      {/* Reviews section for completed jobs */}
                      {isCompleted && (myRating || walkerRating) && (
                        <div style={reviewsSectionStyle}>
                          {myRating && (
                            <ReviewBlock
                              label="Your review"
                              rating={myRating.rating}
                              review={myRating.review}
                            />
                          )}
                          {walkerRating && (
                            <ReviewBlock
                              label="Walker review"
                              rating={walkerRating.rating}
                              review={walkerRating.review}
                            />
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Sub-components ─────────────────────────────────────────

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

function CheckoutForm({
  onSuccess,
  onCancel,
}: {
  onSuccess: (paymentIntentId: string) => void
  onCancel: () => void
}) {
  const stripe = useStripe()
  const elements = useElements()
  const [processing, setProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!stripe || !elements) return

    setProcessing(true)
    setError(null)

    const { error: submitError, paymentIntent } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: window.location.href,
      },
      redirect: 'if_required',
    })

    if (submitError) {
      setError(submitError.message || 'Payment failed')
      setProcessing(false)
      return
    }

    if (paymentIntent && (paymentIntent.status === 'requires_capture' || paymentIntent.status === 'succeeded')) {
      onSuccess(paymentIntent.id)
    } else {
      setError('Payment was not completed')
    }

    setProcessing(false)
  }

  return (
    <form onSubmit={handleSubmit}>
      <PaymentElement />
      {error && (
        <div
          style={{
            marginTop: 12,
            padding: 10,
            borderRadius: 10,
            background: '#FEF2F2',
            color: '#B91C1C',
            fontSize: 14,
          }}
        >
          {error}
        </div>
      )}
      <div style={{
        display: 'flex',
        gap: 12,
        marginTop: 18,
        position: 'sticky',
        bottom: 0,
        background: '#FFFFFF',
        paddingTop: 16,
        paddingBottom: 8,
        borderTop: '1px solid #F1F5F9',
        zIndex: 1,
      }}>
        <button
          type="submit"
          disabled={!stripe || processing}
          style={{
            ...primaryButtonStyle,
            flex: 1,
            cursor: processing ? 'not-allowed' : 'pointer',
            opacity: processing ? 0.7 : 1,
          }}
        >
          {processing ? 'Processing...' : 'Pay Now'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={processing}
          style={{
            ...cancelButtonStyle,
            cursor: processing ? 'not-allowed' : 'pointer',
          }}
        >
          Cancel
        </button>
      </div>
    </form>
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

function StatusBadge({
  status,
}: {
  status: 'awaiting_payment' | 'open' | 'accepted' | 'completed' | 'cancelled'
}) {
  const map: Record<string, { bg: string; color: string; text: string }> = {
    awaiting_payment: { bg: '#FFF7ED', color: '#C2410C', text: 'Awaiting Payment' },
    open: { bg: '#EFF6FF', color: '#1D4ED8', text: 'Finding Walker' },
    accepted: { bg: '#FFF7ED', color: '#C2410C', text: 'In Progress' },
    completed: { bg: '#F0FDF4', color: '#15803D', text: 'Completed' },
    cancelled: { bg: '#FEF2F2', color: '#991B1B', text: 'Cancelled' },
  }

  const styles = map[status] || map.open

  return (
    <span style={badgeBaseStyle(styles.bg, styles.color)}>
      {styles.text}
    </span>
  )
}

function PaymentStatusBadge({ status }: { status: string }) {
  const map: Record<string, { bg: string; color: string; text: string }> = {
    unpaid: { bg: '#F1F5F9', color: '#64748B', text: 'Unpaid' },
    authorized: { bg: '#EFF6FF', color: '#1D4ED8', text: 'Authorized' },
    paid: { bg: '#F0FDF4', color: '#15803D', text: 'Paid' },
    failed: { bg: '#FEF2F2', color: '#991B1B', text: 'Failed' },
    refunded: { bg: '#FEF3C7', color: '#92400E', text: 'Refunded' },
  }

  const styles = map[status] || map.unpaid

  return (
    <span style={badgeBaseStyle(styles.bg, styles.color)}>
      {styles.text}
    </span>
  )
}

function badgeBaseStyle(bg: string, color: string): React.CSSProperties {
  return {
    display: 'inline-block',
    borderRadius: 999,
    padding: '4px 10px',
    fontSize: 11,
    fontWeight: 700,
    background: bg,
    color,
    letterSpacing: 0.3,
  }
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

// ─── Styles ─────────────────────────────────────────────────

const cardStyle: React.CSSProperties = {
  background: '#FFFFFF',
  borderRadius: 20,
  padding: 24,
  boxShadow: '0 1px 3px rgba(15, 23, 42, 0.04)',
  border: '1px solid #E2E8F0',
}

const listCardStyle: React.CSSProperties = {
  borderRadius: 14,
  padding: 16,
  background: '#FAFBFC',
  border: '1px solid #E2E8F0',
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

const labelStyle: React.CSSProperties = {
  display: 'block',
  marginBottom: 6,
  fontWeight: 600,
  fontSize: 13,
  color: '#475569',
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  border: '1px solid #E2E8F0',
  borderRadius: 12,
  padding: '10px 14px',
  fontSize: 14,
  outline: 'none',
  boxSizing: 'border-box',
}

const primaryButtonStyle: React.CSSProperties = {
  border: 'none',
  borderRadius: 12,
  padding: '12px 16px',
  background: '#0F172A',
  color: '#FFFFFF',
  fontWeight: 700,
  fontSize: 14,
}

const payButtonStyle: React.CSSProperties = {
  marginTop: 12,
  border: 'none',
  borderRadius: 12,
  padding: '10px 16px',
  background: '#15803D',
  color: '#FFFFFF',
  fontWeight: 700,
  fontSize: 14,
  width: '100%',
  cursor: 'pointer',
}

const rateButtonStyle: React.CSSProperties = {
  marginTop: 12,
  border: 'none',
  borderRadius: 12,
  padding: '10px 16px',
  background: '#F59E0B',
  color: '#FFFFFF',
  fontWeight: 700,
  fontSize: 14,
  width: '100%',
  cursor: 'pointer',
}

const cancelButtonStyle: React.CSSProperties = {
  border: '1px solid #E2E8F0',
  borderRadius: 12,
  padding: '12px 16px',
  background: '#FFFFFF',
  color: '#64748B',
  fontWeight: 600,
  fontSize: 14,
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

const emptyStateStyle: React.CSSProperties = {
  background: '#FAFBFC',
  borderRadius: 14,
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

const paymentOverlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(15, 23, 42, 0.5)',
  zIndex: 1000,
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'flex-end',
}

const paymentSheetStyle: React.CSSProperties = {
  background: '#FFFFFF',
  borderRadius: '20px 20px 0 0',
  width: '100%',
  maxWidth: 480,
  maxHeight: '85vh',
  margin: '0 auto',
  boxShadow: '0 -8px 40px rgba(15, 23, 42, 0.2)',
  overflowY: 'auto',
  WebkitOverflowScrolling: 'touch',
}

const priceSummaryStyle: React.CSSProperties = {
  background: '#F8FAFC',
  borderRadius: 12,
  padding: '14px 16px',
  border: '1px solid #E2E8F0',
  display: 'grid',
  gap: 6,
}

const priceSummaryRow: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  fontSize: 14,
}

const reviewsSectionStyle: React.CSSProperties = {
  marginTop: 12,
  display: 'grid',
  gap: 8,
}

const reviewBlockStyle: React.CSSProperties = {
  background: '#FAFBFC',
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

const trackingCardStyle: React.CSSProperties = {
  marginTop: 20,
  background: '#FFFFFF',
  borderRadius: 20,
  padding: 24,
  boxShadow: '0 1px 3px rgba(15, 23, 42, 0.04)',
  border: '1px solid #E2E8F0',
}

const etaBadgeStyle: React.CSSProperties = {
  background: '#0F172A',
  color: '#FFFFFF',
  borderRadius: 14,
  padding: '10px 18px',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  minWidth: 60,
  flexShrink: 0,
}

const trackingPulseDotStyle: React.CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: 999,
  background: '#16A34A',
  boxShadow: '0 0 0 3px rgba(22, 163, 74, 0.25)',
  flexShrink: 0,
}
