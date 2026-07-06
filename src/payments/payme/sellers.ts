import type { CreateSellerOnboardingLinkRequest } from '../types'
import { PayMeError, assertPayMeConfigured, getPayMeConfig } from './client'
import type {
  PayMeSellerDraftInput,
  PayMeSellerDraftResponse,
  PayMeSellerOnboardingLinkResponse,
  PayMeSellerStatusPayload,
  PayMeSellerStatusResponse,
} from './types'

function isTruthyString(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

export function mapPayMeSellerStatusToRegliStatus(
  payload: PayMeSellerStatusPayload | null | undefined,
): PayMeSellerStatusResponse {
  const verificationStatus = typeof payload?.verificationStatus === 'string'
    ? payload.verificationStatus.trim().toLowerCase()
    : null
  const lifecycleStatus = typeof payload?.status === 'string' ? payload.status.trim().toLowerCase() : null

  const onboardingComplete =
    verificationStatus === 'verified' ||
    lifecycleStatus === 'active' ||
    lifecycleStatus === 'verified'

  return {
    connected: isTruthyString(payload?.sellerId ?? null),
    sellerAccountId: payload?.sellerId ?? null,
    onboardingComplete,
    payoutsEnabled: payload?.payoutsEnabled === true,
    chargesEnabled: payload?.chargesEnabled === true,
    provider: 'payme',
    sandboxReady: true,
    raw: payload ?? null,
  }
}

export async function createSellerDraft(
  _input: PayMeSellerDraftInput,
): Promise<PayMeSellerDraftResponse> {
  assertPayMeConfigured()

  // TODO(payme): confirm sandbox seller draft endpoint name and request schema.
  // TODO(payme): move seller creation to a server-side Edge Function if secret auth is required.
  throw new PayMeError(
    'PayMe seller draft creation is not implemented until sandbox endpoint details are confirmed.',
    { code: 'not_implemented' },
  )
}

export async function getSellerStatus(
  sellerId?: string | null,
): Promise<PayMeSellerStatusResponse> {
  assertPayMeConfigured()

  if (!sellerId) {
    return {
      connected: false,
      sellerAccountId: null,
      onboardingComplete: false,
      payoutsEnabled: false,
      chargesEnabled: false,
      provider: 'payme',
      sandboxReady: true,
      raw: null,
    }
  }

  // TODO(payme): confirm sandbox seller status endpoint and auth model.
  throw new PayMeError(
    'PayMe seller status lookup is not implemented until sandbox endpoint details are confirmed.',
    { code: 'not_implemented' },
  )
}

export async function createSellerOnboardingLink(
  _request: CreateSellerOnboardingLinkRequest = {},
): Promise<PayMeSellerOnboardingLinkResponse> {
  const config = getPayMeConfig()
  assertPayMeConfigured(config)

  // TODO(payme): confirm whether PayMe exposes a redirect onboarding link for sellers.
  // TODO(payme): route through a Supabase Edge Function if seller onboarding needs server-side signing.
  throw new PayMeError(
    `PayMe seller onboarding link is not implemented for ${config.environment} yet.`,
    { code: 'not_implemented' },
  )
}
