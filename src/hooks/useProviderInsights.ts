import { useEffect, useMemo, useState } from 'react'
import { BUSINESS_TIMEZONE } from '../utils/providerAvailability'
import { supabase } from '../services/supabaseClient'

export type ProviderInsightsSnapshot = {
  periodStart: string | null
  periodEnd: string | null
  acceptanceRate: number | null
  completionRate: number | null
  averageRating: number | null
  requestsReceived: number
  requestsAccepted: number
  requestsDeclined: number
  requestsExpired: number
  requestsReceivedWhileOffline: number
  requestsOutsideAvailability: number
  estimatedMissedEarnings: number
  mostActiveWeekday: number | null
  mostActiveHour: number | null
}

type ProviderInsightsRow = {
  period_start?: string | null
  period_end?: string | null
  acceptance_rate?: number | string | null
  completion_rate?: number | string | null
  average_rating?: number | string | null
  requests_received?: number | string | null
  requests_accepted?: number | string | null
  requests_declined?: number | string | null
  requests_expired?: number | string | null
  requests_received_while_offline?: number | string | null
  requests_outside_availability?: number | string | null
  estimated_missed_earnings?: number | string | null
  most_active_weekday?: number | string | null
  most_active_hour?: number | string | null
}

const EMPTY_INSIGHTS: ProviderInsightsSnapshot = {
  periodStart: null,
  periodEnd: null,
  acceptanceRate: null,
  completionRate: null,
  averageRating: null,
  requestsReceived: 0,
  requestsAccepted: 0,
  requestsDeclined: 0,
  requestsExpired: 0,
  requestsReceivedWhileOffline: 0,
  requestsOutsideAvailability: 0,
  estimatedMissedEarnings: 0,
  mostActiveWeekday: null,
  mostActiveHour: null,
}

function toNumber(value: number | string | null | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function toInt(value: number | string | null | undefined): number {
  const parsed = toNumber(value)
  return parsed == null ? 0 : Math.max(0, Math.round(parsed))
}

function normalizeSnapshot(row: ProviderInsightsRow | null | undefined): ProviderInsightsSnapshot {
  if (!row) return EMPTY_INSIGHTS
  const requestsReceived = toInt(row.requests_received)
  const requestsAccepted = toInt(row.requests_accepted)
  const requestsDeclined = toInt(row.requests_declined)
  const requestsExpired = toInt(row.requests_expired)
  const requestsReceivedWhileOffline = toInt(row.requests_received_while_offline)
  const requestsOutsideAvailability = toInt(row.requests_outside_availability)
  const missedOpportunityCount =
    requestsDeclined +
    requestsExpired +
    requestsReceivedWhileOffline +
    requestsOutsideAvailability

  return {
    periodStart: row.period_start ?? null,
    periodEnd: row.period_end ?? null,
    acceptanceRate: toNumber(row.acceptance_rate),
    completionRate: toNumber(row.completion_rate),
    averageRating: toNumber(row.average_rating),
    requestsReceived,
    requestsAccepted,
    requestsDeclined,
    requestsExpired,
    requestsReceivedWhileOffline,
    requestsOutsideAvailability,
    estimatedMissedEarnings: missedOpportunityCount > 0 ? Math.max(0, toNumber(row.estimated_missed_earnings) ?? 0) : 0,
    mostActiveWeekday: toNumber(row.most_active_weekday),
    mostActiveHour: toNumber(row.most_active_hour),
  }
}

export function useProviderInsights(providerId: string, refreshKey: number) {
  const [snapshot, setSnapshot] = useState<ProviderInsightsSnapshot>(EMPTY_INSIGHTS)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      if (!providerId) {
        if (!cancelled) {
          setSnapshot(EMPTY_INSIGHTS)
          setLoading(false)
          setError(null)
        }
        return
      }

      setLoading(true)
      setError(null)

      const { data, error: rpcError } = await supabase.rpc('get_provider_insights', {
        p_timezone: BUSINESS_TIMEZONE,
      })

      if (cancelled) return

      if (rpcError) {
        setLoading(false)
        setError(rpcError.message)
        return
      }

      const row = Array.isArray(data)
        ? (data[0] as ProviderInsightsRow | undefined)
        : (data as ProviderInsightsRow | null)
      const normalizedSnapshot = normalizeSnapshot(row)
      const hasDirectProviderActivity =
        normalizedSnapshot.requestsReceived > 0 ||
        normalizedSnapshot.requestsAccepted > 0 ||
        normalizedSnapshot.requestsDeclined > 0 ||
        normalizedSnapshot.requestsExpired > 0
      const hasCompletionSignals =
        normalizedSnapshot.acceptanceRate != null ||
        normalizedSnapshot.completionRate != null ||
        normalizedSnapshot.averageRating != null

      if (!hasDirectProviderActivity && !hasCompletionSignals) {
        if (
          normalizedSnapshot.requestsReceivedWhileOffline > 0 ||
          normalizedSnapshot.requestsOutsideAvailability > 0 ||
          normalizedSnapshot.estimatedMissedEarnings > 0
        ) {
          console.log('[provider-insights] no provider-scoped missed data, using zero', {
            providerId,
          })
        }
        setSnapshot({
          ...normalizedSnapshot,
          requestsReceivedWhileOffline: 0,
          requestsOutsideAvailability: 0,
          estimatedMissedEarnings: 0,
        })
        setLoading(false)
        return
      }

      setSnapshot(normalizedSnapshot)
      setLoading(false)
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [providerId, refreshKey])

  return useMemo(
    () => ({
      snapshot,
      loading,
      error,
    }),
    [error, loading, snapshot],
  )
}
