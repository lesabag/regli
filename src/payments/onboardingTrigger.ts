import { runNonBlocking } from './nonBlocking'
import { PaymentService } from './PaymentService'

/**
 * Trigger PayMe seller onboarding after a provider (walker) finishes registration.
 *
 * Phase 1 behaviour:
 *  - Only runs for providers (role === 'walker').
 *  - Fire-and-forget and NON-BLOCKING: any failure is swallowed so provider
 *    registration / authentication is never affected (see {@link runNonBlocking}).
 *  - Whether PayMe is actually contacted is decided server-side by the
 *    PAYME_SELLER_ONBOARDING_ENABLED flag inside the create-payme-seller edge
 *    function; when disabled this resolves as a safe no-op.
 *  - Does NOT open or navigate to the PayMe signup URL — that is Phase 2. The URL
 *    is persisted server-side and available for later use.
 */
export function triggerPaymeSellerOnboarding(
  role: string | null | undefined,
): Promise<{ ok: boolean }> {
  if (role !== 'walker') {
    return Promise.resolve({ ok: true })
  }

  return runNonBlocking(async () => {
    const paymentService = new PaymentService({ provider: 'payme' })
    await paymentService.createSellerAccount()
  })
}
