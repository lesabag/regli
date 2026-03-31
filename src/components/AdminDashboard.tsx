import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../services/supabaseClient'

interface Booking {
  id: string
  service_type: string
  status: string
  walker_id?: string | null
  walker_name?: string | null
  walker_rating?: number | null
  rating?: number | null
  review?: string | null
  created_at?: string | null
}

interface WalkerStats {
  walkerId: string
  walkerName: string
  jobsCompleted: number
  jobsCancelled: number
  revenue: number
  avgRating: number | null
  reviewCount: number
}

const SERVICE_PRICES: Record<string, number> = {
  quick: 30,
  standard: 50,
  energy: 70,
}

export default function AdminDashboard() {
  const [bookings, setBookings] = useState<Booking[]>([])
  const [loading, setLoading] = useState(true)

  const fetchBookings = async () => {
    setLoading(true)

    const { data, error } = await supabase
      .from('bookings')
      .select('*')
      .order('created_at', { ascending: false })

    if (error) {
      console.error(error)
      setLoading(false)
      return
    }

    setBookings(data || [])
    setLoading(false)
  }

  useEffect(() => {
    fetchBookings()

    const channel = supabase
      .channel('admin-bookings')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'bookings',
        },
        () => {
          fetchBookings()
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  const metrics = useMemo(() => {
    const totalBookings = bookings.length
    const completedBookings = bookings.filter((b) => b.status === 'completed').length
    const cancelledBookings = bookings.filter((b) => b.status === 'cancelled').length
    const activeBookings = bookings.filter((b) =>
      ['searching', 'matched', 'arrived'].includes(b.status)
    ).length

    const totalRevenue = bookings
      .filter((b) => b.status === 'completed')
      .reduce((sum, b) => sum + (SERVICE_PRICES[b.service_type] ?? 0), 0)

    return {
      totalBookings,
      completedBookings,
      cancelledBookings,
      activeBookings,
      totalRevenue,
    }
  }, [bookings])

  const bookingsByStatus = useMemo(() => {
    const counts: Record<string, number> = {
      searching: 0,
      matched: 0,
      arrived: 0,
      completed: 0,
      cancelled: 0,
    }

    for (const booking of bookings) {
      counts[booking.status] = (counts[booking.status] ?? 0) + 1
    }

    return counts
  }, [bookings])

  const walkerStats = useMemo(() => {
    const map = new Map<string, WalkerStats>()

    for (const booking of bookings) {
      if (!booking.walker_id || !booking.walker_name) continue

      if (!map.has(booking.walker_id)) {
        map.set(booking.walker_id, {
          walkerId: booking.walker_id,
          walkerName: booking.walker_name,
          jobsCompleted: 0,
          jobsCancelled: 0,
          revenue: 0,
          avgRating: null,
          reviewCount: 0,
        })
      }

      const row = map.get(booking.walker_id)!

      if (booking.status === 'completed') {
        row.jobsCompleted += 1
        row.revenue += SERVICE_PRICES[booking.service_type] ?? 0
      }

      if (booking.status === 'cancelled') {
        row.jobsCancelled += 1
      }

      if (booking.rating != null) {
        const currentTotal = (row.avgRating ?? 0) * row.reviewCount
        row.reviewCount += 1
        row.avgRating = (currentTotal + booking.rating) / row.reviewCount
      }
    }

    return Array.from(map.values()).sort((a, b) => b.revenue - a.revenue)
  }, [bookings])

  const recentBookings = useMemo(() => bookings.slice(0, 10), [bookings])

  return (
    <div className="min-h-screen bg-[#F7F7F8] p-5">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-[#001A33]">Admin Dashboard</h1>
        <p className="mt-1 text-sm text-gray-500">
          Real-time KPI overview for Regli
        </p>
      </div>

      {loading && (
        <div className="mb-4 rounded-2xl bg-white p-4 shadow">
          <p className="text-gray-500">Loading dashboard...</p>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-5">
        <div className="rounded-2xl bg-white p-5 shadow-[0_8px_24px_rgba(0,0,0,0.06)]">
          <p className="text-sm text-gray-500">Total bookings</p>
          <p className="mt-2 text-3xl font-bold text-[#001A33]">
            {metrics.totalBookings}
          </p>
        </div>

        <div className="rounded-2xl bg-white p-5 shadow-[0_8px_24px_rgba(0,0,0,0.06)]">
          <p className="text-sm text-gray-500">Completed</p>
          <p className="mt-2 text-3xl font-bold text-emerald-700">
            {metrics.completedBookings}
          </p>
        </div>

        <div className="rounded-2xl bg-white p-5 shadow-[0_8px_24px_rgba(0,0,0,0.06)]">
          <p className="text-sm text-gray-500">Cancelled</p>
          <p className="mt-2 text-3xl font-bold text-red-600">
            {metrics.cancelledBookings}
          </p>
        </div>

        <div className="rounded-2xl bg-white p-5 shadow-[0_8px_24px_rgba(0,0,0,0.06)]">
          <p className="text-sm text-gray-500">Active</p>
          <p className="mt-2 text-3xl font-bold text-blue-700">
            {metrics.activeBookings}
          </p>
        </div>

        <div className="rounded-2xl bg-white p-5 shadow-[0_8px_24px_rgba(0,0,0,0.06)]">
          <p className="text-sm text-gray-500">Revenue</p>
          <p className="mt-2 text-3xl font-bold text-[#001A33]">
            ₪{metrics.totalRevenue}
          </p>
        </div>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl bg-white p-5 shadow-[0_8px_24px_rgba(0,0,0,0.06)]">
          <h2 className="text-lg font-bold text-[#001A33]">Bookings by status</h2>

          <div className="mt-4 space-y-3">
            {Object.entries(bookingsByStatus).map(([status, count]) => (
              <div key={status} className="flex items-center justify-between">
                <span className="text-sm capitalize text-gray-600">{status}</span>
                <span className="rounded-full bg-gray-100 px-3 py-1 text-sm font-semibold text-[#001A33]">
                  {count}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-2xl bg-white p-5 shadow-[0_8px_24px_rgba(0,0,0,0.06)]">
          <h2 className="text-lg font-bold text-[#001A33]">Top walkers</h2>

          <div className="mt-4 space-y-3">
            {walkerStats.length === 0 && (
              <p className="text-sm text-gray-500">No walker stats yet</p>
            )}

            {walkerStats.slice(0, 5).map((walker) => (
              <div
                key={walker.walkerId}
                className="flex items-center justify-between rounded-xl bg-gray-50 px-4 py-3"
              >
                <div>
                  <p className="font-semibold text-[#001A33]">{walker.walkerName}</p>
                  <p className="text-xs text-gray-500">
                    Completed: {walker.jobsCompleted} · Reviews: {walker.reviewCount}
                  </p>
                </div>

                <div className="text-right">
                  <p className="font-bold text-[#001A33]">₪{walker.revenue}</p>
                  <p className="text-xs text-gray-500">
                    ⭐ {walker.avgRating != null ? walker.avgRating.toFixed(1) : '-'}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-6 rounded-2xl bg-white p-5 shadow-[0_8px_24px_rgba(0,0,0,0.06)]">
        <h2 className="text-lg font-bold text-[#001A33]">Walker performance</h2>

        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="border-b text-gray-500">
                <th className="pb-3 pr-4">Walker</th>
                <th className="pb-3 pr-4">Avg rating</th>
                <th className="pb-3 pr-4">Reviews</th>
                <th className="pb-3 pr-4">Completed</th>
                <th className="pb-3 pr-4">Cancelled</th>
                <th className="pb-3 pr-4">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {walkerStats.map((walker) => (
                <tr key={walker.walkerId} className="border-b last:border-b-0">
                  <td className="py-3 pr-4 font-semibold text-[#001A33]">
                    {walker.walkerName}
                  </td>
                  <td className="py-3 pr-4 text-gray-600">
                    {walker.avgRating != null ? walker.avgRating.toFixed(1) : '-'}
                  </td>
                  <td className="py-3 pr-4 text-gray-600">
                    {walker.reviewCount}
                  </td>
                  <td className="py-3 pr-4 text-gray-600">
                    {walker.jobsCompleted}
                  </td>
                  <td className="py-3 pr-4 text-gray-600">
                    {walker.jobsCancelled}
                  </td>
                  <td className="py-3 pr-4 font-semibold text-[#001A33]">
                    ₪{walker.revenue}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {walkerStats.length === 0 && (
            <p className="pt-4 text-sm text-gray-500">No data yet</p>
          )}
        </div>
      </div>

      <div className="mt-6 rounded-2xl bg-white p-5 shadow-[0_8px_24px_rgba(0,0,0,0.06)]">
        <h2 className="text-lg font-bold text-[#001A33]">Recent bookings</h2>

        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="border-b text-gray-500">
                <th className="pb-3 pr-4">Service</th>
                <th className="pb-3 pr-4">Status</th>
                <th className="pb-3 pr-4">Walker</th>
                <th className="pb-3 pr-4">Price</th>
                <th className="pb-3 pr-4">Rating</th>
                <th className="pb-3 pr-4">Review</th>
                <th className="pb-3 pr-4">Created</th>
              </tr>
            </thead>
            <tbody>
              {recentBookings.map((booking) => (
                <tr key={booking.id} className="border-b last:border-b-0">
                  <td className="py-3 pr-4 font-semibold text-[#001A33]">
                    {booking.service_type}
                  </td>
                  <td className="py-3 pr-4 capitalize text-gray-600">
                    {booking.status}
                  </td>
                  <td className="py-3 pr-4 text-gray-600">
                    {booking.walker_name ?? '-'}
                  </td>
                  <td className="py-3 pr-4 text-gray-600">
                    ₪{SERVICE_PRICES[booking.service_type] ?? 0}
                  </td>
                  <td className="py-3 pr-4 text-gray-600">
                    {booking.rating ?? '-'}
                  </td>
                  <td className="py-3 pr-4 text-gray-600">
                    {booking.review || '-'}
                  </td>
                  <td className="py-3 pr-4 text-gray-600">
                    {booking.created_at
                      ? new Date(booking.created_at).toLocaleString()
                      : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {recentBookings.length === 0 && (
            <p className="pt-4 text-sm text-gray-500">No bookings yet</p>
          )}
        </div>
      </div>
    </div>
  )
}
