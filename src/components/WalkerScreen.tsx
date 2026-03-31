import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../services/supabaseClient'

interface Booking {
  id: string
  service_type: string
  status: string
  walker_lat?: number | null
  walker_lng?: number | null
  user_lat?: number | null
  user_lng?: number | null
  walker_id?: string | null
  walker_name?: string | null
  walker_rating?: number | null
  created_at?: string | null
  matched_at?: string | null
  arrived_at?: string | null
  completed_at?: string | null
  cancelled_at?: string | null
}

interface BookingWithDistance extends Booking {
  distanceKm: number | null
}

interface WalkerProfile {
  id: string
  name: string
  rating: number
  homeLat: number
  homeLng: number
}

type FilterTab = 'active' | 'completed' | 'cancelled'
type SortMode = 'latest' | 'distance' | 'status' | 'earnings'

const WALKERS: WalkerProfile[] = [
  { id: 'w-1', name: 'Daniel M.', rating: 4.9, homeLat: 32.089, homeLng: 34.786 },
  { id: 'w-2', name: 'Noa S.', rating: 4.8, homeLat: 32.081, homeLng: 34.776 },
  { id: 'w-3', name: 'Amit R.', rating: 5.0, homeLat: 32.095, homeLng: 34.792 },
  { id: 'w-4', name: 'Maya T.', rating: 4.7, homeLat: 32.078, homeLng: 34.783 },
]

const SERVICE_PRICES: Record<string, number> = {
  quick: 30,
  standard: 50,
  energy: 70,
}

function calculateDistanceInKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
) {
  const toRad = (v: number) => (v * Math.PI) / 180
  const R = 6371

  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) ** 2

  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)))
}

function statusPriority(status: string) {
  if (status === 'searching') return 0
  if (status === 'matched') return 1
  if (status === 'arrived') return 2
  if (status === 'completed') return 3
  if (status === 'cancelled') return 4
  return 5
}

export default function WalkerScreen() {
  const [bookings, setBookings] = useState<BookingWithDistance[]>([])
  const [currentWalkerId, setCurrentWalkerId] = useState<string>(WALKERS[0].id)
  const [toast, setToast] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<FilterTab>('active')
  const [searchTerm, setSearchTerm] = useState('')
  const [sortMode, setSortMode] = useState<SortMode>('latest')
  const moveIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const currentWalker =
    WALKERS.find((w) => w.id === currentWalkerId) ?? WALKERS[0]

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 2500)
    return () => clearTimeout(timer)
  }, [toast])

  const fetchBookings = async () => {
    const { data, error } = await supabase
      .from('bookings')
      .select('*')
      .in('status', ['searching', 'matched', 'arrived', 'completed', 'cancelled'])

    if (error) {
      console.error(error)
      return
    }

    const enriched: BookingWithDistance[] = (data || []).map((booking: Booking) => {
      let distanceKm: number | null = null

      if (booking.user_lat != null && booking.user_lng != null) {
        distanceKm = calculateDistanceInKm(
          currentWalker.homeLat,
          currentWalker.homeLng,
          booking.user_lat,
          booking.user_lng
        )
      }

      return {
        ...booking,
        distanceKm,
      }
    })

    enriched.sort((a, b) => {
      const aPriority = statusPriority(a.status)
      const bPriority = statusPriority(b.status)

      if (aPriority !== bPriority) return aPriority - bPriority

      const aDistance = a.distanceKm ?? Number.MAX_SAFE_INTEGER
      const bDistance = b.distanceKm ?? Number.MAX_SAFE_INTEGER

      return aDistance - bDistance
    })

    setBookings(enriched)
  }

  useEffect(() => {
    fetchBookings()

    const channel = supabase
      .channel(`walker-bookings-${currentWalkerId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'bookings' },
        () => {
          fetchBookings()
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
      if (moveIntervalRef.current) {
        clearInterval(moveIntervalRef.current)
        moveIntervalRef.current = null
      }
    }
  }, [currentWalkerId])

  const acceptBooking = async (booking: BookingWithDistance) => {
    const targetLat = booking.user_lat ?? currentWalker.homeLat
    const targetLng = booking.user_lng ?? currentWalker.homeLng

    const { data, error } = await supabase
      .from('bookings')
      .update({
        status: 'matched',
        walker_id: currentWalker.id,
        walker_name: currentWalker.name,
        walker_rating: currentWalker.rating,
        walker_lat: currentWalker.homeLat,
        walker_lng: currentWalker.homeLng,
        matched_at: new Date().toISOString(),
      })
      .eq('id', booking.id)
      .eq('status', 'searching')
      .select()

    if (error) {
      console.error(error)
      setToast('Failed to accept request')
      return false
    }

    if (!data || data.length === 0) {
      setToast('Request was already taken by another walker')
      await fetchBookings()
      return false
    }

    await supabase
      .from('bookings')
      .update({
        walker_lat: currentWalker.homeLat + (targetLat - currentWalker.homeLat) * 0.15,
        walker_lng: currentWalker.homeLng + (targetLng - currentWalker.homeLng) * 0.15,
      })
      .eq('id', booking.id)
      .eq('walker_id', currentWalker.id)

    setToast(`Accepted by ${currentWalker.name}`)
    await fetchBookings()
    return true
  }

  const startAutoMove = (booking: BookingWithDistance) => {
    if (moveIntervalRef.current) {
      clearInterval(moveIntervalRef.current)
    }

    moveIntervalRef.current = setInterval(async () => {
      const { data } = await supabase
        .from('bookings')
        .select('*')
        .eq('id', booking.id)
        .single()

      if (!data) return

      if (data.walker_id && data.walker_id !== currentWalker.id) {
        if (moveIntervalRef.current) {
          clearInterval(moveIntervalRef.current)
          moveIntervalRef.current = null
        }
        return
      }

      const targetLat = data.user_lat ?? currentWalker.homeLat
      const targetLng = data.user_lng ?? currentWalker.homeLng

      const latDiff = targetLat - data.walker_lat
      const lngDiff = targetLng - data.walker_lng

      if (Math.abs(latDiff) < 0.00035 && Math.abs(lngDiff) < 0.00035) {
        if (moveIntervalRef.current) {
          clearInterval(moveIntervalRef.current)
          moveIntervalRef.current = null
        }

        await supabase
          .from('bookings')
          .update({
            status: 'arrived',
            walker_lat: targetLat,
            walker_lng: targetLng,
            arrived_at: new Date().toISOString(),
          })
          .eq('id', booking.id)
          .eq('walker_id', currentWalker.id)

        setToast(`${currentWalker.name} arrived`)
        await fetchBookings()
        return
      }

      await supabase
        .from('bookings')
        .update({
          walker_lat: data.walker_lat + latDiff * 0.28,
          walker_lng: data.walker_lng + lngDiff * 0.28,
        })
        .eq('id', booking.id)
        .eq('walker_id', currentWalker.id)
    }, 1000)
  }

  const stopAutoMove = () => {
    if (moveIntervalRef.current) {
      clearInterval(moveIntervalRef.current)
      moveIntervalRef.current = null
      setToast('Auto move stopped')
    }
  }

  const markCompleted = async (bookingId: string) => {
    const { error } = await supabase
      .from('bookings')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
      })
      .eq('id', bookingId)
      .eq('walker_id', currentWalker.id)

    if (error) {
      console.error(error)
      setToast('Failed to complete job')
      return
    }

    setToast('Job completed')
    await fetchBookings()
  }

  const acceptBestMatch = async () => {
    const bestMatch = bookings.find((b) => b.status === 'searching')
    if (!bestMatch) {
      setToast('No searching requests available')
      return
    }

    const accepted = await acceptBooking(bestMatch)
    if (accepted) {
      startAutoMove(bestMatch)
    }
  }

  const searchingBookings = bookings.filter((b) => b.status === 'searching')
  const walkerJobs = bookings.filter((b) => b.walker_id === currentWalker.id)
  const activeJobs = walkerJobs.filter(
    (b) => b.status === 'matched' || b.status === 'arrived'
  )
  const completedJobs = walkerJobs.filter((b) => b.status === 'completed')
  const totalEarnings = completedJobs.reduce((sum, booking) => {
    return sum + (SERVICE_PRICES[booking.service_type] ?? 0)
  }, 0)

  const filteredBookings = useMemo(() => {
    const byTab = bookings.filter((booking) => {
      if (activeTab === 'active') {
        return ['searching', 'matched', 'arrived'].includes(booking.status)
      }
      if (activeTab === 'completed') {
        return booking.status === 'completed'
      }
      return booking.status === 'cancelled'
    })

    const term = searchTerm.trim().toLowerCase()

    const bySearch = term
      ? byTab.filter((booking) => {
          const fields = [
            booking.service_type,
            booking.status,
            booking.walker_name ?? '',
            booking.id,
          ]
          return fields.some((field) => field.toLowerCase().includes(term))
        })
      : byTab

    const result = [...bySearch]

    result.sort((a, b) => {
      if (sortMode === 'distance') {
        const aDistance = a.distanceKm ?? Number.MAX_SAFE_INTEGER
        const bDistance = b.distanceKm ?? Number.MAX_SAFE_INTEGER
        return aDistance - bDistance
      }

      if (sortMode === 'status') {
        return statusPriority(a.status) - statusPriority(b.status)
      }

      if (sortMode === 'earnings') {
        const aEarn = SERVICE_PRICES[a.service_type] ?? 0
        const bEarn = SERVICE_PRICES[b.service_type] ?? 0
        return bEarn - aEarn
      }

      const aTime = a.created_at ? new Date(a.created_at).getTime() : 0
      const bTime = b.created_at ? new Date(b.created_at).getTime() : 0
      return bTime - aTime
    })

    return result
  }, [bookings, activeTab, searchTerm, sortMode])

  return (
    <div className="min-h-screen bg-[#F7F7F8] p-5">
      {toast && (
        <div className="fixed left-1/2 top-6 z-[1000] -translate-x-1/2 rounded-full bg-[#001A33] px-4 py-2 text-sm font-semibold text-white shadow-lg">
          {toast}
        </div>
      )}

      <div className="mb-5 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#001A33]">Walker Dashboard</h1>
          <p className="mt-1 text-sm text-gray-500">
            Requests are ranked by real distance from the selected walker
          </p>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <select
            value={currentWalkerId}
            onChange={(e) => setCurrentWalkerId(e.target.value)}
            className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-[#001A33]"
          >
            {WALKERS.map((walker) => (
              <option key={walker.id} value={walker.id}>
                {walker.name} • ⭐ {walker.rating}
              </option>
            ))}
          </select>

          <button
            onClick={acceptBestMatch}
            disabled={searchingBookings.length === 0}
            className={`rounded-xl px-4 py-2 text-sm font-semibold ${
              searchingBookings.length === 0
                ? 'cursor-not-allowed bg-gray-200 text-gray-500'
                : 'bg-[#001A33] text-white'
            }`}
          >
            Accept best match
          </button>
        </div>
      </div>

      <div className="mb-5 grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl bg-white p-5 shadow-[0_8px_24px_rgba(0,0,0,0.06)]">
          <p className="text-sm text-gray-500">Current walker</p>
          <p className="mt-2 text-xl font-bold text-[#001A33]">{currentWalker.name}</p>
          <p className="mt-1 text-sm text-gray-500">⭐ {currentWalker.rating}</p>
        </div>

        <div className="rounded-2xl bg-white p-5 shadow-[0_8px_24px_rgba(0,0,0,0.06)]">
          <p className="text-sm text-gray-500">Completed jobs</p>
          <p className="mt-2 text-3xl font-bold text-[#001A33]">
            {completedJobs.length}
          </p>
        </div>

        <div className="rounded-2xl bg-white p-5 shadow-[0_8px_24px_rgba(0,0,0,0.06)]">
          <p className="text-sm text-gray-500">Total earnings</p>
          <p className="mt-2 text-3xl font-bold text-[#001A33]">₪{totalEarnings}</p>
          <p className="mt-1 text-sm text-gray-500">
            Active jobs: {activeJobs.length}
          </p>
        </div>
      </div>

      <div className="mb-4 flex gap-2 rounded-2xl bg-white p-2 shadow-[0_8px_24px_rgba(0,0,0,0.06)]">
        {(['active', 'completed', 'cancelled'] as FilterTab[]).map((tab) => {
          const isActive = activeTab === tab
          const label =
            tab === 'active'
              ? 'Active'
              : tab === 'completed'
              ? 'Completed'
              : 'Cancelled'

          return (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`flex-1 rounded-xl px-4 py-2 text-sm font-semibold transition ${
                isActive
                  ? 'bg-[#001A33] text-white'
                  : 'bg-transparent text-gray-500'
              }`}
            >
              {label}
            </button>
          )
        })}
      </div>

      <div className="mb-5 grid gap-3 md:grid-cols-[1fr_220px]">
        <input
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="Search by service, status, walker or id"
          className="rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm text-[#001A33] shadow-[0_8px_24px_rgba(0,0,0,0.04)] outline-none"
        />

        <select
          value={sortMode}
          onChange={(e) => setSortMode(e.target.value as SortMode)}
          className="rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm font-semibold text-[#001A33] shadow-[0_8px_24px_rgba(0,0,0,0.04)]"
        >
          <option value="latest">Latest first</option>
          <option value="distance">Sort by distance</option>
          <option value="status">Sort by status</option>
          <option value="earnings">Sort by earnings</option>
        </select>
      </div>

      {filteredBookings.length === 0 && (
        <div className="rounded-2xl bg-white p-5 shadow">
          <p className="text-gray-500">
            No {activeTab} bookings for this view
          </p>
        </div>
      )}

      {filteredBookings.map((booking, index) => {
        const isNearestSearching =
          booking.status === 'searching' &&
          searchingBookings[0]?.id === booking.id

        const isAssignedToCurrentWalker =
          booking.walker_id != null && booking.walker_id === currentWalker.id

        return (
          <div
            key={booking.id}
            className="mb-4 rounded-2xl bg-white p-5 shadow-[0_8px_24px_rgba(0,0,0,0.06)]"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-lg font-bold text-[#001A33]">
                  {booking.service_type}
                </p>

                <p className="mt-1 text-sm text-gray-500">
                  Status: {booking.status}
                </p>

                {booking.distanceKm != null && activeTab === 'active' && (
                  <p className="mt-1 text-sm text-gray-500">
                    Distance from {currentWalker.name}: {booking.distanceKm.toFixed(2)} km
                  </p>
                )}

                {booking.walker_name && (
                  <p className="mt-1 text-sm text-gray-500">
                    Assigned walker: {booking.walker_name}
                  </p>
                )}

                {booking.status === 'completed' && booking.walker_id === currentWalker.id && (
                  <p className="mt-1 text-sm font-semibold text-green-700">
                    Earned: ₪{SERVICE_PRICES[booking.service_type] ?? 0}
                  </p>
                )}
              </div>

              <div className="flex flex-col items-end gap-2">
                {isNearestSearching && activeTab === 'active' && (
                  <span className="rounded-full bg-[#FFCD00] px-3 py-1 text-xs font-semibold text-[#001A33]">
                    Nearest request
                  </span>
                )}

                {booking.status === 'arrived' && (
                  <span className="rounded-full bg-green-100 px-3 py-1 text-xs font-semibold text-green-700">
                    Arrived
                  </span>
                )}

                {booking.status === 'completed' && booking.walker_id === currentWalker.id && (
                  <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700">
                    Completed
                  </span>
                )}

                {booking.status === 'cancelled' && (
                  <span className="rounded-full bg-red-100 px-3 py-1 text-xs font-semibold text-red-700">
                    Cancelled
                  </span>
                )}

                {isAssignedToCurrentWalker && booking.status === 'matched' && (
                  <span className="rounded-full bg-blue-100 px-3 py-1 text-xs font-semibold text-blue-700">
                    Your active job
                  </span>
                )}
              </div>
            </div>

            {booking.user_lat != null && booking.user_lng != null && (
              <p className="mt-3 text-xs text-gray-400">
                User: {booking.user_lat.toFixed(4)}, {booking.user_lng.toFixed(4)}
              </p>
            )}

            {booking.walker_lat != null && booking.walker_lng != null && (
              <p className="mt-1 text-xs text-gray-400">
                Walker: {booking.walker_lat.toFixed(4)}, {booking.walker_lng.toFixed(4)}
              </p>
            )}

            <div className="mt-4 flex flex-wrap gap-2">
              {booking.status === 'searching' && activeTab === 'active' && (
                <button
                  onClick={async () => {
                    const accepted = await acceptBooking(booking)
                    if (accepted) {
                      startAutoMove(booking)
                    }
                  }}
                  className="rounded-xl bg-green-500 px-4 py-2 text-sm font-semibold text-white"
                >
                  Accept
                </button>
              )}

              {booking.status === 'matched' && isAssignedToCurrentWalker && (
                <>
                  <button
                    onClick={() => startAutoMove(booking)}
                    className="rounded-xl bg-[#FFCD00] px-4 py-2 text-sm font-semibold text-[#001A33]"
                  >
                    Start auto move
                  </button>

                  <button
                    onClick={stopAutoMove}
                    className="rounded-xl bg-gray-200 px-4 py-2 text-sm font-semibold text-gray-700"
                  >
                    Stop
                  </button>
                </>
              )}

              {booking.status === 'arrived' && isAssignedToCurrentWalker && (
                <button
                  onClick={() => markCompleted(booking.id)}
                  className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white"
                >
                  Complete job
                </button>
              )}
            </div>

            {index === 0 && booking.status === 'searching' && activeTab === 'active' && (
              <div className="mt-4 rounded-xl bg-blue-50 px-4 py-3 text-sm text-blue-700">
                Recommended match for {currentWalker.name} based on closest real distance.
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
