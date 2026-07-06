import { PayMeError, assertPayMeConfigured } from './client'
import type { CreatePaymentIntentRequest, CreatePaymentIntentResponse } from '../types'

export async function createPayMePayment(
  _request: CreatePaymentIntentRequest,
): Promise<CreatePaymentIntentResponse> {
  assertPayMeConfigured()

  // TODO(payme): implement sandbox charge creation.
  // TODO(payme): implement platform fee handling.
  // TODO(payme): implement marketplace split allocation to providers.
  throw new PayMeError('PayMe payment creation is not implemented yet.', {
    code: 'not_implemented',
  })
}
