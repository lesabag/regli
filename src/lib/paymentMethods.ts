import { PaymentService } from '../payments/PaymentService'
import type { SavedCard } from '../payments/types'

const stripePaymentService = new PaymentService({ provider: 'stripe' })

export type { SavedCard } from '../payments/types'

export type PaymentMethodType = 'saved_card' | 'apple_pay'

export interface SavedCardPaymentMethod {
  type: 'saved_card'
  card: SavedCard | null
}

export interface ApplePayPaymentMethod {
  type: 'apple_pay'
  card: null
}

export type ActivePaymentMethod = SavedCardPaymentMethod | ApplePayPaymentMethod

export function toSavedCardPaymentMethod(card: SavedCard | null): SavedCardPaymentMethod | null {
  if (!card) return null
  return {
    type: 'saved_card',
    card,
  }
}

export function toApplePayPaymentMethod(): ApplePayPaymentMethod {
  return {
    type: 'apple_pay',
    card: null,
  }
}

export function getPaymentMethodLabel(method: ActivePaymentMethod): string {
  if (method.type === 'apple_pay') return 'Apple Pay'
  if (method.card) {
    return `${capitalize(method.card.brand)} ${method.card.last4}`
  }
  return 'Card'
}

export function getPaymentMethodIcon(type: PaymentMethodType): string {
  if (type === 'apple_pay') return 'apple'
  return 'card'
}

// TODO: Apple Pay support
// Keep booking payment methods behind a small discriminated union so a future
// native Apple Pay option can be added without rewriting saved-card selection.
// TODO: Native iOS Apple Pay eligibility check
// Eligibility should be decided before rendering any future Apple Pay row.

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export async function fetchSavedCards(): Promise<{ customerId: string | null; cards: SavedCard[] }> {
  try {
    return await stripePaymentService.listSavedPaymentMethods()
  } catch (error) {
    console.error(
      '[paymentMethods] fetchSavedCards error:',
      error instanceof Error ? error.message : String(error),
    )
    return { customerId: null, cards: [] }
  }
}

export async function requestSetupIntent(): Promise<{ clientSecret: string | null; error: string | null }> {
  try {
    const data = await stripePaymentService.createSetup()
    return { clientSecret: data.clientSecret, error: null }
  } catch (error) {
    return {
      clientSecret: null,
      error: error instanceof Error ? error.message : 'Failed to create setup',
    }
  }
}

export async function detachPaymentMethod(paymentMethodId: string): Promise<{ error: string | null }> {
  return stripePaymentService.detachSavedPaymentMethod(paymentMethodId)
}
