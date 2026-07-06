import type { CreateRefundRequest, CreateRefundResponse } from '../types'
import { PayMeError, assertPayMeConfigured } from './client'

export async function createPayMeRefund(
  _request: CreateRefundRequest,
): Promise<CreateRefundResponse> {
  assertPayMeConfigured()

  // TODO(payme): implement refund creation once sandbox refund endpoints are confirmed.
  throw new PayMeError('PayMe refunds are not implemented yet.', {
    code: 'not_implemented',
  })
}
