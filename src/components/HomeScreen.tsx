import { useBooking } from '../hooks/useBooking'
import Header from './Header'
import MapView from './MapView'
import ServiceCard from './ServiceCard'
import OrderButton from './OrderButton'
import MatchingOverlay from './MatchingOverlay'
import TrackingCard from './TrackingCard'
import StatusOverlay from './StatusOverlay'
import NoMatchOverlay from './NoMatchOverlay'
import ReviewCard from './ReviewCard'

const services = [
  { id: 'quick', title: 'Quick', duration: '15 min', price: 30 },
  { id: 'standard', title: 'Standard', duration: '30 min', price: 50 },
  { id: 'energy', title: 'Energy', duration: '45 min', price: 70 },
] as const

export default function HomeScreen() {
  const {
    bookingStatus,
    selectedService,
    setSelectedService,
    assignedWalker,
    walkerLocation,
    userLocation,
    matchAttempts,
    elapsedSeconds,
    etaMinutes,
    isArrived,
    notification,
    submittedRating,
    isSubmittingReview,
    requestMatch,
    cancelMatch,
    completeWalk,
    submitReview,
    cancelWalk,
    reset,
  } = useBooking()

  return (
    <div className="flex flex-col min-h-svh bg-[#F7F7F8]">
      <Header />

      {notification && (
        <div className="fixed top-20 left-1/2 z-[1000] -translate-x-1/2 rounded-full bg-[#001A33] px-4 py-2 text-sm font-semibold text-white shadow-lg">
          {notification}
        </div>
      )}

      <div className="relative px-5 pt-2">
        <div className="relative z-0 overflow-hidden rounded-2xl">
          <MapView
            userLocation={userLocation}
            walkerLocation={
              bookingStatus === 'TRACKING' ? walkerLocation ?? undefined : undefined
            }
            isArrived={isArrived}
          />
        </div>

        {bookingStatus !== 'TRACKING' && bookingStatus !== 'COMPLETED' && (
          <div className="absolute z-10 left-8 bottom-6">
            <div className="rounded-full bg-white px-4 py-2 shadow-lg flex items-center gap-2">
              <span className="h-3 w-3 rounded-full bg-green-500" />
              <span className="text-[14px] font-semibold text-[#001A33]">
                3 walkers nearby
              </span>
            </div>
          </div>
        )}
      </div>

      {bookingStatus === 'IDLE' && (
        <>
          <div className="px-5 pt-6 pb-2">
            <h2 className="text-[13px] font-semibold text-gray-400 tracking-wide uppercase mb-3">
              Choose your walk
            </h2>

            <div className="grid grid-cols-3 gap-2">
              {services.map((service) => (
                <ServiceCard
                  key={service.id}
                  title={service.title}
                  duration={service.duration}
                  price={service.price}
                  selected={selectedService === service.id}
                  onSelect={() => setSelectedService(service.id)}
                />
              ))}
            </div>
          </div>

          <div className="mt-auto">
            <OrderButton
              label="Order Regli Now"
              onClick={requestMatch}
              disabled={bookingStatus !== 'IDLE'}
            />
          </div>
        </>
      )}

      {bookingStatus === 'MATCHING' && (
        <MatchingOverlay
          matched={false}
          onCancel={cancelMatch}
          elapsedSeconds={elapsedSeconds}
        />
      )}

      {bookingStatus === 'TRACKING' && assignedWalker && (
        <div className="mt-auto pt-4">
          <TrackingCard
            walker={assignedWalker}
            etaMinutes={etaMinutes}
            isArrived={isArrived}
            onEndSession={cancelWalk}
            onComplete={completeWalk}
          />
        </div>
      )}

      {bookingStatus === 'NO_MATCH' && (
        <NoMatchOverlay
          attempts={matchAttempts}
          onRetry={requestMatch}
          onCancel={reset}
        />
      )}

      {bookingStatus === 'COMPLETED' && assignedWalker && submittedRating == null && (
        <div className="mt-auto pt-4">
          <ReviewCard
            walkerName={assignedWalker.name}
            onSubmit={submitReview}
            isSubmitting={isSubmittingReview}
          />
        </div>
      )}

      {bookingStatus === 'COMPLETED' && submittedRating != null && (
        <StatusOverlay
          variant="success"
          title="Thanks for your review!"
          subtitle="Your feedback helps keep Regli amazing"
          actionLabel="Back to home"
          onAction={reset}
        />
      )}

      {bookingStatus === 'CANCELLED' && (
        <StatusOverlay
          variant="error"
          title="Session cancelled"
          subtitle="You can book again anytime"
          actionLabel="Back to home"
          onAction={reset}
        />
      )}
    </div>
  )
}
