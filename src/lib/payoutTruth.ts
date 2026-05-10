export type PayoutState = 'pending' | 'available' | 'paid' | 'failed'

export interface JobFinancials {
  customerPaidAmount: number
  platformFeeAmount: number
  providerEarningsAmount: number
  payoutState: PayoutState
  isFinalized: boolean
  source: 'stored' | 'estimated'
}

const PLATFORM_FEE_RATE = 0.20

interface FinancialsInput {
  price: number | null
  platform_fee: number | null
  walker_earnings: number | null
  payment_status: string | null
  status: string | null
}

export function resolveJobFinancials(job: FinancialsInput): JobFinancials {
  const customerPaid = job.price ?? 0

  let providerEarnings: number
  let source: 'stored' | 'estimated'
  if (job.walker_earnings != null) {
    providerEarnings = job.walker_earnings
    source = 'stored'
  } else if (customerPaid > 0) {
    providerEarnings = Math.round(customerPaid * (1 - PLATFORM_FEE_RATE) * 100) / 100
    source = 'estimated'
    console.log('[PayoutTruth] using estimated earnings — no stored walker_earnings', {
      price: customerPaid,
      estimatedEarnings: providerEarnings,
    })
  } else {
    providerEarnings = 0
    source = 'estimated'
  }

  const platformFee = job.platform_fee ?? Math.round(customerPaid * PLATFORM_FEE_RATE * 100) / 100

  const payoutState = mapPayoutState(job.payment_status)
  const isFinalized = job.payment_status === 'paid'

  return {
    customerPaidAmount: customerPaid,
    platformFeeAmount: platformFee,
    providerEarningsAmount: providerEarnings,
    payoutState,
    isFinalized,
    source,
  }
}

function mapPayoutState(paymentStatus: string | null): PayoutState {
  if (paymentStatus === 'paid') return 'available'
  if (paymentStatus === 'failed' || paymentStatus === 'refunded') return 'failed'
  if (paymentStatus === 'authorized') return 'pending'
  return 'pending'
}

export function getProviderEarnings(job: {
  price: number | null
  walker_earnings: number | null
}): number {
  if (job.walker_earnings != null) return job.walker_earnings
  if (job.price != null) return Math.round(job.price * (1 - PLATFORM_FEE_RATE) * 100) / 100
  return 0
}

export function getPlatformFee(job: {
  price: number | null
  platform_fee: number | null
}): number {
  if (job.platform_fee != null) return job.platform_fee
  if (job.price != null) return Math.round(job.price * PLATFORM_FEE_RATE * 100) / 100
  return 0
}

export function logPayoutSummary(
  label: string,
  jobs: Array<{ price: number | null; walker_earnings: number | null; payment_status: string | null }>,
): void {
  let storedCount = 0
  let estimatedCount = 0
  let totalEarnings = 0

  for (const job of jobs) {
    const earnings = getProviderEarnings(job)
    totalEarnings += earnings
    if (job.walker_earnings != null) {
      storedCount++
    } else if (job.price != null) {
      estimatedCount++
    }
  }

  console.log(`[ProviderEarnings] ${label}`, {
    jobCount: jobs.length,
    storedCount,
    estimatedCount,
    totalEarnings: Math.round(totalEarnings * 100) / 100,
  })
}
