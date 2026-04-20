import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'

export type WalkerDispatchOffer = {
  attemptId: string
  requestId: string
  walkerId: string
  rank: number
  score: number
  offeredAt: string
  expiresAt: string
  attemptNo: number
  requestStatus: string
  dispatchState: string
}

type UseWalkerDispatchParams = {
  supabase: SupabaseClient
  profileId: string | null | undefined
}

type AcceptOfferResult =
  | { ok: true }
  | { ok: false; error: string }

export function useWalkerDispatch({
  supabase,
  profileId,
}: UseWalkerDispatchParams) {
  const [offers, setOffers] = useState<WalkerDispatchOffer[]>([])
  const [loading, setLoading] = useState(false)
  const [acceptingAttemptId, setAcceptingAttemptId] = useState<string | null>(null)
  const channelRef = useRef<RealtimeChannel | null>(null)

  const activeOffers = useMemo(() => {
    const now = Date.now()
    return offers
      .filter((offer) => new Date(offer.expiresAt).getTime() > now)
      .sort(
        (a, b) =>
          new Date(a.expiresAt).getTime() - new Date(b.expiresAt).getTime(),
      )
  }, [offers])

  const refresh = useCallback(async () => {
    if (!profileId) {
      setOffers([])
      return
    }

    setLoading(true)

    const { data, error } = await supabase
      .from('active_dispatch_offers')
      .select(`
        id,
        request_id,
        walker_id,
        rank,
        score,
        offered_at,
        expires_at,
        attempt_no,
        request_status,
        dispatch_state
      `)
      .eq('walker_id', profileId)
      .order('expires_at', { ascending: true })

    setLoading(false)

    if (error) {
      console.error('useWalkerDispatch.refresh error', error)
      return
    }

    const mapped: WalkerDispatchOffer[] = (data ?? []).map((row) => ({
      attemptId: String(row.id),
      requestId: String(row.request_id),
      walkerId: String(row.walker_id),
      rank: Number(row.rank ?? 0),
      score: Number(row.score ?? 0),
      offeredAt: String(row.offered_at),
      expiresAt: String(row.expires_at),
      attemptNo: Number(row.attempt_no ?? 0),
      requestStatus: String(row.request_status ?? ''),
      dispatchState: String(row.dispatch_state ?? ''),
    }))

    setOffers(mapped)
  }, [profileId, supabase])

  const acceptOffer = useCallback(
    async (offer: WalkerDispatchOffer): Promise<AcceptOfferResult> => {
      try {
        setAcceptingAttemptId(offer.attemptId)

        const { data, error } = await supabase.functions.invoke('accept-dispatch', {
          body: {
            requestId: offer.requestId,
            attemptId: offer.attemptId,
          },
        })

        if (error) {
          return {
            ok: false,
            error: error.message || 'Failed to accept offer',
          }
        }

        if (!data?.ok) {
          return {
            ok: false,
            error:
              data?.result?.code ||
              data?.error ||
              'Offer could not be accepted',
          }
        }

        await refresh()

        return { ok: true }
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'Unknown accept error',
        }
      } finally {
        setAcceptingAttemptId(null)
      }
    },
    [refresh, supabase],
  )

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!profileId) {
      channelRef.current?.unsubscribe()
      channelRef.current = null
      return
    }

    channelRef.current?.unsubscribe()

    const channel = supabase
      .channel(`walker-dispatch-${profileId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'dispatch_candidates',
          filter: `walker_id=eq.${profileId}`,
        },
        () => {
          void refresh()
        },
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'dispatch_attempts',
        },
        () => {
          void refresh()
        },
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'walk_requests',
        },
        () => {
          void refresh()
        },
      )
      .subscribe()

    channelRef.current = channel

    return () => {
      channel.unsubscribe()
      if (channelRef.current === channel) {
        channelRef.current = null
      }
    }
  }, [profileId, refresh, supabase])

  return {
    offers: activeOffers,
    loading,
    acceptingAttemptId,
    refresh,
    acceptOffer,
  }
}
