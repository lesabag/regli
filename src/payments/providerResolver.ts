import type { PaymentProviderId, PaymentProviderResolverInput } from './types'

export const DEFAULT_PAYMENT_COUNTRY = 'IL'

const MARKET_PROVIDER_MAP: Record<string, PaymentProviderId> = {
  IL: 'payme',
  ISR: 'payme',
  ISRAEL: 'payme',
}

function normalizeMarketValue(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toUpperCase()
  return normalized.length > 0 ? normalized : null
}

export function resolvePaymentProvider(
  input: PaymentProviderResolverInput = {},
): PaymentProviderId {
  if (input.provider) return input.provider

  const normalizedMarket =
    normalizeMarketValue(input.countryCode) ??
    normalizeMarketValue(input.market) ??
    DEFAULT_PAYMENT_COUNTRY

  return MARKET_PROVIDER_MAP[normalizedMarket] ?? 'stripe'
}
