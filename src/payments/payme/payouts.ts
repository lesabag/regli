import { PayMeError, assertPayMeConfigured } from './client'

export interface PayMePayoutStatus {
  enabled: boolean
  status: 'not_started' | 'pending' | 'active' | 'disabled'
  raw?: unknown
}

export async function getPayMePayoutStatus(
  _sellerId?: string | null,
): Promise<PayMePayoutStatus> {
  assertPayMeConfigured()

  // TODO(payme): implement payout readiness lookup.
  // TODO(payme): implement settlement lifecycle mapping.
  throw new PayMeError('PayMe payouts are not implemented yet.', {
    code: 'not_implemented',
  })
}
