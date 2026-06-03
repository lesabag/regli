import { useCallback, useEffect, useMemo, useState } from 'react'

export type ProviderDashboardCardKey = 'pricing' | 'insights' | 'wallet'

type HiddenCardsState = Record<ProviderDashboardCardKey, boolean>

const DEFAULT_HIDDEN_CARDS: HiddenCardsState = {
  pricing: false,
  insights: false,
  wallet: false,
}

function getStorageKey(providerId: string): string {
  return `regli.providerDashboard.hiddenCards.${providerId}`
}

function parseHiddenCards(raw: string | null): HiddenCardsState {
  if (!raw) return DEFAULT_HIDDEN_CARDS

  try {
    const parsed = JSON.parse(raw) as Partial<Record<ProviderDashboardCardKey, unknown>>
    return {
      pricing: parsed.pricing === true,
      insights: parsed.insights === true,
      wallet: parsed.wallet === true,
    }
  } catch {
    return DEFAULT_HIDDEN_CARDS
  }
}

export function useProviderDashboardCards(providerId: string | null | undefined) {
  const [hiddenCards, setHiddenCards] = useState<HiddenCardsState>(DEFAULT_HIDDEN_CARDS)

  useEffect(() => {
    if (!providerId || typeof window === 'undefined') {
      setHiddenCards(DEFAULT_HIDDEN_CARDS)
      return
    }

    setHiddenCards(parseHiddenCards(window.localStorage.getItem(getStorageKey(providerId))))
  }, [providerId])

  const persist = useCallback((nextState: HiddenCardsState) => {
    if (!providerId || typeof window === 'undefined') return
    try {
      window.localStorage.setItem(getStorageKey(providerId), JSON.stringify(nextState))
    } catch {
      // noop
    }
  }, [providerId])

  const setCardVisible = useCallback((card: ProviderDashboardCardKey, visible: boolean) => {
    setHiddenCards((current) => {
      const nextState = {
        ...current,
        [card]: !visible,
      }
      persist(nextState)
      return nextState
    })
  }, [persist])

  const hideCard = useCallback((card: ProviderDashboardCardKey) => {
    setCardVisible(card, false)
  }, [setCardVisible])

  const visibleCards = useMemo(
    () => ({
      pricing: !hiddenCards.pricing,
      insights: !hiddenCards.insights,
      wallet: !hiddenCards.wallet,
    }),
    [hiddenCards],
  )

  return {
    hiddenCards,
    visibleCards,
    hideCard,
    setCardVisible,
  }
}
