import { invokeEdgeFunction } from '../services/supabaseClient'

export interface SavedCard {
  id: string
  brand: string
  last4: string
  expMonth?: number
  expYear?: number
}

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

interface GetOrCreateResponse {
  customerId: string
  cards: SavedCard[]
}

export async function fetchSavedCards(): Promise<{ customerId: string | null; cards: SavedCard[] }> {
  const { data, error } = await invokeEdgeFunction<GetOrCreateResponse>(
    'manage-payment-method',
    { body: { action: 'get-or-create-customer' } }
  )

  if (error || !data) {
    console.error('[paymentMethods] fetchSavedCards error:', error)
    return { customerId: null, cards: [] }
  }

  return { customerId: data.customerId, cards: data.cards }
}

interface SetupIntentResponse {
  clientSecret: string
}

export async function requestSetupIntent(): Promise<{ clientSecret: string | null; error: string | null }> {
  const { data, error } = await invokeEdgeFunction<SetupIntentResponse>(
    'manage-payment-method',
    { body: { action: 'create-setup-intent' } }
  )

  if (error || !data) {
    return { clientSecret: null, error: error ?? 'Failed to create setup' }
  }

  return { clientSecret: data.clientSecret, error: null }
}

export async function detachPaymentMethod(paymentMethodId: string): Promise<{ error: string | null }> {
  const { error } = await invokeEdgeFunction(
    'manage-payment-method',
    { body: { action: 'detach-payment-method', paymentMethodId } }
  )

  return { error }
}
