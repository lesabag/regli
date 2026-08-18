// Deno-only I/O glue for the provider_activation table. Pure orchestration logic
// lives in ./paymeActivation.ts (node-tested); this module only reads/writes rows
// via the service-role client. It is NOT imported by node tests.
//
// SECURITY: only ever persists safe orchestration metadata (state, sale id,
// amount, timestamps, non-secret error codes). Never card/bank/KYC/secret data.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import {
  applyVerifiedKycApproval,
  applyVerifiedSellerVerification,
  type ProviderActivationState,
  type SellerVerificationStatus,
} from './paymeActivation.ts'

type Admin = ReturnType<typeof createClient>

export interface ActivationRow {
  provider_id: string
  activation_state: ProviderActivationState
  // Independent seller/KYC lifecycle — survives fee-authorization expiry.
  seller_verification_status: SellerVerificationStatus
  seller_verified_at: string | null
  activation_fee_payme_sale_id: string | null
  activation_fee_amount_agorot: number | null
  activation_fee_authorized_at: string | null
  activation_fee_authorization_expires_at: string | null
  activation_fee_captured_at: string | null
  activation_fee_voided_at: string | null
  activation_attempt: number
  last_activation_error_code: string | null
}

const COLUMNS =
  'provider_id, activation_state, seller_verification_status, seller_verified_at, ' +
  'activation_fee_payme_sale_id, activation_fee_amount_agorot, ' +
  'activation_fee_authorized_at, activation_fee_authorization_expires_at, ' +
  'activation_fee_captured_at, activation_fee_voided_at, activation_attempt, last_activation_error_code'

/** Read the provider's activation row, or null when none exists yet. */
export async function loadActivationRow(
  admin: Admin,
  providerId: string,
): Promise<ActivationRow | null> {
  const { data } = await admin
    .from('provider_activation')
    .select(COLUMNS)
    .eq('provider_id', providerId)
    .maybeSingle()
  return (data as ActivationRow | null) ?? null
}

/**
 * Ensure a row exists in the given baseline state (default 'not_started').
 * Idempotent: on conflict it leaves the existing row untouched.
 */
export async function ensureActivationRow(
  admin: Admin,
  providerId: string,
  baseline: ProviderActivationState = 'not_started',
): Promise<void> {
  await admin
    .from('provider_activation')
    .upsert(
      { provider_id: providerId, activation_state: baseline, updated_at: new Date().toISOString() },
      { onConflict: 'provider_id', ignoreDuplicates: true },
    )
}

/**
 * Atomic concurrency claim: flip activation_state to `next` ONLY when the current
 * state is one of `allowedFrom`. Returns true iff this caller won the claim. This
 * is the single-writer lock that makes authorize/capture/void race-safe.
 */
export async function claimActivationState(
  admin: Admin,
  providerId: string,
  allowedFrom: ProviderActivationState[],
  next: ProviderActivationState,
  patch: Record<string, unknown> = {},
): Promise<boolean> {
  const { data } = await admin
    .from('provider_activation')
    .update({ activation_state: next, updated_at: new Date().toISOString(), ...patch })
    .eq('provider_id', providerId)
    .in('activation_state', allowedFrom)
    .select('provider_id')
  return Array.isArray(data) && data.length > 0
}

/**
 * Mark that the PayMe Seller has been created and Hosted Onboarding / KYC has
 * begun: seller_verification_status not_started -> pending. Idempotent and safe —
 * it never downgrades an already pending/approved/rejected status.
 *
 * TODO(payme-phase2c): the production caller (seller-creation completion) is wired
 * in Phase 2C alongside the verified authorization trigger.
 */
export async function markSellerVerificationPending(
  admin: Admin,
  providerId: string,
): Promise<void> {
  await admin
    .from('provider_activation')
    .update({ seller_verification_status: 'pending', updated_at: new Date().toISOString() })
    .eq('provider_id', providerId)
    .eq('seller_verification_status', 'not_started')
}

/**
 * PHASE 2C BOUNDARY — mark a provider's KYC as approved from a VERIFIED PayMe
 * seller-readiness signal. This is the ONLY sanctioned path to KYC approval.
 *
 * KYC approval is recorded on the INDEPENDENT seller_verification_status column so
 * it survives fee-authorization expiry: if the J5 has already expired, the approval
 * is still persisted and honored on the next re-authorization
 * (resolveStateAfterVerifiedAuthorization -> kyc_approved). Only when the
 * authorization is still LIVE (activation_state === 'kyc_pending') do we also
 * advance activation_state to kyc_approved so capture can proceed immediately.
 *
 * TODO(payme-phase2c): NO production caller wires this yet. It must NEVER be
 * invoked from the untrusted payme-partner-callback or any unmapped/undocumented
 * payload — only from a reconciler that has authenticated PayMe's official seller
 * status contract in the Personal Sandbox.
 *
 * Returns true iff a verified approval was recorded (pending -> approved).
 */
export async function markProviderKycApprovedFromVerifiedPaymeStatus(
  admin: Admin,
  providerId: string,
): Promise<boolean> {
  const row = await loadActivationRow(admin, providerId)
  if (!row) return false

  const nextStatus = applyVerifiedSellerVerification(row.seller_verification_status)
  if (!nextStatus) return false // only 'pending' may be approved

  // 1) Persist the durable KYC fact INDEPENDENTLY of the authorization lifecycle.
  //    This is what must NOT be lost when the authorization has expired.
  await patchActivation(admin, providerId, {
    seller_verification_status: nextStatus,
    seller_verified_at: new Date().toISOString(),
  })

  // 2) Advance the orchestration state only if the authorization is still live and
  //    awaiting KYC. If it expired, leave activation_state as-is; re-authorization
  //    will resolve straight to kyc_approved using the status recorded above.
  const advanced = applyVerifiedKycApproval(row.activation_state)
  if (advanced) {
    await claimActivationState(admin, providerId, ['kyc_pending'], advanced, {})
  }

  return true
}

/** Unconditional safe patch (used after a claim is already held). */
export async function patchActivation(
  admin: Admin,
  providerId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await admin
    .from('provider_activation')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('provider_id', providerId)
}
