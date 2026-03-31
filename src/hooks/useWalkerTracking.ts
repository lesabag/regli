import { useEffect, useRef } from 'react'
import { supabase } from '../services/supabaseClient'

const MIN_UPDATE_INTERVAL_MS = 5000

/**
 * Broadcasts the walker's GPS position to all their active (accepted) jobs.
 * Starts geolocation watch when there are active jobs, stops when there are none.
 */
export function useWalkerTracking(activeJobIds: string[]) {
  const jobIdsRef = useRef(activeJobIds)
  jobIdsRef.current = activeJobIds

  const lastUpdateRef = useRef(0)
  const hasActiveJobs = activeJobIds.length > 0

  useEffect(() => {
    if (!hasActiveJobs || !navigator.geolocation) return

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const now = Date.now()
        if (now - lastUpdateRef.current < MIN_UPDATE_INTERVAL_MS) return
        lastUpdateRef.current = now

        const ids = jobIdsRef.current
        if (ids.length === 0) return

        supabase
          .from('walk_requests')
          .update({
            walker_lat: position.coords.latitude,
            walker_lng: position.coords.longitude,
            last_location_update: new Date().toISOString(),
          })
          .in('id', ids)
          .then(({ error }) => {
            if (error) {
              console.error('[useWalkerTracking] location write failed:', error.message)
            }
          })
      },
      (err) => {
        console.warn('[useWalkerTracking] geolocation error:', err.message)
      },
      {
        enableHighAccuracy: true,
        maximumAge: 3000,
        timeout: 10000,
      }
    )

    return () => {
      navigator.geolocation.clearWatch(watchId)
    }
  }, [hasActiveJobs])
}
