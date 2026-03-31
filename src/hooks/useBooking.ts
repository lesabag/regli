import { supabase } from '../services/supabaseClient'
import { useState, useEffect, useCallback, useRef } from 'react'
import type { BookingStatus, ServiceType, Walker } from '../types/booking'

const DEFAULT_USER_LAT = 32.0853
const DEFAULT_USER_LNG = 34.7818

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

export function useBooking() {
  const [bookingStatus, setBookingStatus] = useState<BookingStatus>('IDLE')
  const [selectedService, setSelectedService] = useState<ServiceType>('standard')
  const [assignedWalker, setAssignedWalker] = useState<Walker | null>(null)
  const [matchAttempts, setMatchAttempts] = useState(0)
  const [bookingId, setBookingId] = useState<string | null>(null)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [searchStartTime, setSearchStartTime] = useState<number | null>(null)
  const [walkerLocation, setWalkerLocation] = useState<[number, number] | null>(null)
  const [etaMinutes, setEtaMinutes] = useState<number | null>(null)
  const [isArrived, setIsArrived] = useState(false)
  const [userLocation, setUserLocation] = useState<[number, number]>([
    DEFAULT_USER_LAT,
    DEFAULT_USER_LNG,
  ])
  const [notification, setNotification] = useState<string | null>(null)
  const [submittedRating, setSubmittedRating] = useState<number | null>(null)
  const [submittedReview, setSubmittedReview] = useState<string>('')
  const [isSubmittingReview, setIsSubmittingReview] = useState(false)

  const previousStatusRef = useRef<string | null>(null)

  useEffect(() => {
    if (!navigator.geolocation) return

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        setUserLocation([
          position.coords.latitude,
          position.coords.longitude,
        ])
      },
      (error) => {
        console.warn('Geolocation error:', error.message)
      },
      {
        enableHighAccuracy: true,
        maximumAge: 5000,
        timeout: 10000,
      }
    )

    return () => {
      navigator.geolocation.clearWatch(watchId)
    }
  }, [])

  useEffect(() => {
    if (!notification) return

    const timer = setTimeout(() => {
      setNotification(null)
    }, 3000)

    return () => clearTimeout(timer)
  }, [notification])

  useEffect(() => {
    if (!bookingId) return

    const channel = supabase
      .channel(`booking-${bookingId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'bookings',
          filter: `id=eq.${bookingId}`,
        },
        (payload) => {
          const updated = payload.new as {
            status?: string
            walker_lat?: number | null
            walker_lng?: number | null
            walker_id?: string | null
            walker_name?: string | null
            walker_rating?: number | null
            rating?: number | null
            review?: string | null
          }

          const previousStatus = previousStatusRef.current

          if (updated.walker_lat != null && updated.walker_lng != null) {
            setWalkerLocation([updated.walker_lat, updated.walker_lng])

            const distanceKm = calculateDistanceInKm(
              updated.walker_lat,
              updated.walker_lng,
              userLocation[0],
              userLocation[1]
            )

            const eta = Math.max(1, Math.ceil((distanceKm / 12) * 60))
            setEtaMinutes(eta)
          }

          if (updated.walker_name && updated.walker_rating != null) {
            setAssignedWalker({
              id: updated.walker_id ?? 'assigned-walker',
              name: updated.walker_name,
              rating: updated.walker_rating,
              etaMinutes: etaMinutes ?? 4,
            })
          }

          if (updated.rating != null) {
            setSubmittedRating(updated.rating)
          }

          if (updated.review != null) {
            setSubmittedReview(updated.review)
          }

          if (updated.status === 'matched') {
            setIsArrived(false)
            setSearchStartTime(null)
            setElapsedSeconds(0)
            setBookingStatus('TRACKING')

            if (previousStatus !== 'matched') {
              setNotification('Walker matched and on the way')
            }
          }

          if (updated.status === 'arrived') {
            setIsArrived(true)
            setBookingStatus('TRACKING')
            setEtaMinutes(0)
            setWalkerLocation([userLocation[0], userLocation[1]])

            if (previousStatus !== 'arrived') {
              setNotification('Walker arrived')
            }
          }

          if (updated.status === 'no_match') {
            setMatchAttempts((prev) => prev + 1)
            setAssignedWalker(null)
            setWalkerLocation(null)
            setEtaMinutes(null)
            setSearchStartTime(null)
            setElapsedSeconds(0)
            setIsArrived(false)
            setBookingStatus('NO_MATCH')

            if (previousStatus !== 'no_match') {
              setNotification('No walkers available right now')
            }
          }

          if (updated.status === 'cancelled') {
            setAssignedWalker(null)
            setWalkerLocation(null)
            setEtaMinutes(null)
            setSearchStartTime(null)
            setElapsedSeconds(0)
            setIsArrived(false)
            setBookingStatus('CANCELLED')
          }

          if (updated.status === 'completed') {
            setSearchStartTime(null)
            setElapsedSeconds(0)
            setBookingStatus('COMPLETED')

            if (previousStatus !== 'completed') {
              setNotification('Walk completed')
            }
          }

          previousStatusRef.current = updated.status ?? null
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [bookingId, userLocation, etaMinutes])

  useEffect(() => {
    if (bookingStatus !== 'MATCHING' || !searchStartTime) return

    const interval = setInterval(() => {
      const seconds = Math.floor((Date.now() - searchStartTime) / 1000)
      setElapsedSeconds(seconds)
    }, 1000)

    return () => clearInterval(interval)
  }, [bookingStatus, searchStartTime])

  const requestMatch = useCallback(async () => {
    if (bookingStatus !== 'IDLE' && bookingStatus !== 'NO_MATCH') return

    const { data, error } = await supabase
      .from('bookings')
      .insert([
        {
          status: 'searching',
          service_type: selectedService,
          user_lat: userLocation[0],
          user_lng: userLocation[1],
        },
      ])
      .select()

    if (error) {
      console.error('Error creating booking:', error)
      return
    }

    if (data && data.length > 0) {
      setBookingId(data[0].id)
      setAssignedWalker(null)
      setWalkerLocation(null)
      setEtaMinutes(null)
      setSearchStartTime(Date.now())
      setElapsedSeconds(0)
      setIsArrived(false)
      setNotification(null)
      setSubmittedRating(null)
      setSubmittedReview('')
      previousStatusRef.current = 'searching'
      setBookingStatus('MATCHING')
    }
  }, [selectedService, bookingStatus, userLocation])

  const cancelMatch = useCallback(async () => {
    if (bookingId) {
      await supabase
        .from('bookings')
        .update({ status: 'cancelled' })
        .eq('id', bookingId)
    }

    setAssignedWalker(null)
    setWalkerLocation(null)
    setEtaMinutes(null)
    setSearchStartTime(null)
    setElapsedSeconds(0)
    setIsArrived(false)
    setNotification(null)
    previousStatusRef.current = 'cancelled'
    setBookingStatus('CANCELLED')
  }, [bookingId])

  const completeWalk = useCallback(async () => {
    if (bookingId) {
      await supabase
        .from('bookings')
        .update({ status: 'completed' })
        .eq('id', bookingId)
    }

    setSearchStartTime(null)
    setElapsedSeconds(0)
    setNotification('Walk completed')
    previousStatusRef.current = 'completed'
    setBookingStatus('COMPLETED')
  }, [bookingId])

  const submitReview = useCallback(
    async (rating: number, review: string) => {
      if (!bookingId) return

      setIsSubmittingReview(true)

      const { error } = await supabase
        .from('bookings')
        .update({
          rating,
          review: review.trim(),
        })
        .eq('id', bookingId)

      setIsSubmittingReview(false)

      if (error) {
        console.error(error)
        setNotification('Failed to submit review')
        return
      }

      setSubmittedRating(rating)
      setSubmittedReview(review.trim())
      setNotification('Thanks for your review')
    },
    [bookingId]
  )

  const cancelWalk = useCallback(async () => {
    if (bookingId) {
      await supabase
        .from('bookings')
        .update({ status: 'cancelled' })
        .eq('id', bookingId)
    }

    setAssignedWalker(null)
    setWalkerLocation(null)
    setEtaMinutes(null)
    setSearchStartTime(null)
    setElapsedSeconds(0)
    setIsArrived(false)
    setNotification(null)
    previousStatusRef.current = 'cancelled'
    setBookingStatus('CANCELLED')
  }, [bookingId])

  const reset = useCallback(() => {
    setAssignedWalker(null)
    setWalkerLocation(null)
    setEtaMinutes(null)
    setBookingId(null)
    setSearchStartTime(null)
    setElapsedSeconds(0)
    setIsArrived(false)
    setNotification(null)
    setSubmittedRating(null)
    setSubmittedReview('')
    previousStatusRef.current = null
    setBookingStatus('IDLE')
  }, [])

  return {
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
    submittedReview,
    isSubmittingReview,
    requestMatch,
    cancelMatch,
    completeWalk,
    submitReview,
    cancelWalk,
    reset,
  }
}
