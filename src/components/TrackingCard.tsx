import { MessageCircle, Phone, Star, Clock } from 'lucide-react'
import type { Walker } from '../types/booking'

interface TrackingCardProps {
  walker: Walker
  etaMinutes?: number | null
  isArrived?: boolean
  onEndSession: () => void
  onComplete: () => void
}

export default function TrackingCard({
  walker,
  etaMinutes,
  isArrived = false,
  onEndSession,
  onComplete,
}: TrackingCardProps) {
  const displayEta = etaMinutes ?? walker.etaMinutes
  const arrived = isArrived

  return (
    <div className="px-5 pb-6">
      <div className="rounded-[28px] bg-white shadow-[0_12px_32px_rgba(0,0,0,0.08)] overflow-hidden">
        <div className="h-1.5 w-1/2 bg-[#FFCD00]" />

        <div className="p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className="relative">
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[#001A33] text-2xl font-bold text-white">
                  {walker.name.charAt(0)}
                </div>
                <div className="absolute bottom-0 right-0 h-5 w-5 rounded-full border-4 border-white bg-green-500" />
              </div>

              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-2xl font-bold text-[#001A33]">
                    {walker.name}
                  </h3>

                  <div className="flex items-center gap-1 rounded-full bg-yellow-50 px-2 py-1">
                    <Star size={14} className="fill-[#FFCD00] text-[#FFCD00]" />
                    <span className="text-sm font-semibold text-[#001A33]">
                      {walker.rating}
                    </span>
                  </div>
                </div>

                <p className="mt-1 text-lg text-gray-400">
                  {arrived ? 'Your walker has arrived' : 'Your walker is on the way'}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <button className="flex h-14 w-14 items-center justify-center rounded-full bg-gray-50 text-gray-400 shadow-sm transition hover:bg-gray-100">
                <MessageCircle size={24} />
              </button>

              <button className="flex h-14 w-14 items-center justify-center rounded-full bg-gray-50 text-gray-400 shadow-sm transition hover:bg-gray-100">
                <Phone size={24} />
              </button>
            </div>
          </div>

          <div className="mt-5 rounded-2xl border border-gray-100 bg-gray-50 px-5 py-4 shadow-sm">
            <div className="flex items-center gap-3">
              <Clock size={24} className="text-gray-400" />
              {arrived ? (
                <span className="text-xl font-bold text-green-600">
                  Walker arrived 🐶
                </span>
              ) : (
                <>
                  <span className="text-lg text-gray-500">Arriving in</span>
                  <span className="text-2xl font-bold text-[#001A33]">
                    {displayEta} min
                  </span>
                </>
              )}
            </div>
          </div>

          <div className="mt-5 flex gap-3">
            <button
              onClick={onEndSession}
              className="flex-1 rounded-2xl border border-gray-200 bg-white px-4 py-3 font-semibold text-gray-600 transition hover:bg-gray-50"
            >
              Cancel
            </button>

            <button
              onClick={onComplete}
              className="flex-1 rounded-2xl bg-[#001A33] px-4 py-3 font-semibold text-white shadow-md transition hover:opacity-95"
            >
              Complete walk
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
