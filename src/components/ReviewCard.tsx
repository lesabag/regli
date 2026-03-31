import { useState } from 'react'

interface ReviewCardProps {
  walkerName: string
  onSubmit: (rating: number, review: string) => void
  isSubmitting?: boolean
}

export default function ReviewCard({
  walkerName,
  onSubmit,
  isSubmitting = false,
}: ReviewCardProps) {
  const [rating, setRating] = useState(5)
  const [review, setReview] = useState('')

  return (
    <div className="px-5 pb-6">
      <div className="rounded-[28px] bg-white p-5 shadow-[0_12px_32px_rgba(0,0,0,0.08)]">
        <h3 className="text-2xl font-bold text-[#001A33]">
          Rate your walker
        </h3>

        <p className="mt-2 text-gray-500">
          How was your experience with {walkerName}?
        </p>

        <div className="mt-5 flex gap-2">
          {[1, 2, 3, 4, 5].map((star) => (
            <button
              key={star}
              onClick={() => setRating(star)}
              className={`h-12 w-12 rounded-full text-xl font-bold transition ${
                star <= rating
                  ? 'bg-[#FFCD00] text-[#001A33]'
                  : 'bg-gray-100 text-gray-400'
              }`}
            >
              ★
            </button>
          ))}
        </div>

        <textarea
          value={review}
          onChange={(e) => setReview(e.target.value)}
          placeholder="Write a short review (optional)"
          className="mt-5 min-h-[110px] w-full rounded-2xl border border-gray-200 px-4 py-3 text-sm text-[#001A33] outline-none"
        />

        <button
          onClick={() => onSubmit(rating, review)}
          disabled={isSubmitting}
          className={`mt-5 w-full rounded-2xl px-4 py-3 text-sm font-semibold ${
            isSubmitting
              ? 'cursor-not-allowed bg-gray-200 text-gray-500'
              : 'bg-[#001A33] text-white'
          }`}
        >
          {isSubmitting ? 'Submitting...' : 'Submit review'}
        </button>
      </div>
    </div>
  )
}
