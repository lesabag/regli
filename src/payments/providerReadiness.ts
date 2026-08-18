// Pure, dependency-free helpers for PROVIDER ACTIVATION READINESS.
//
// COST INVARIANT — READINESS BOUNDARY (Stage A):
// A provider marking "I'm ready to receive orders" expresses INTENT only. It MUST
// NOT create a PayMe Seller and therefore has ZERO PayMe setup cost. Persisting
// readiness writes only the two Regli-only profile columns below — no Edge Function
// call, no signup URL, no Hosted Onboarding, no external PayMe navigation.
//
//   REGISTERED -> READY_FOR_ACTIVATION -> still NO PayMe Seller -> still zero cost.
//
// Actual PayMe Seller creation happens LATER, behind a separate, explicit
// payment-activation boundary (Stage B — see providerActivation.ts). Readiness is
// intentionally distinct from payment-setup state (see providerPaymentSetupState.ts)
// and NEVER makes a provider dispatch-eligible on its own.
//
// Keep this module dependency-free (no Supabase client, no PayMe imports) so it is
// deterministic and unit-testable, and so it can never reach a seller-creating path.

// Regli-only readiness columns on public.profiles (migration
// 2026081301_payme_ready_for_activation.sql). These carry no payment meaning.
export const READY_FOR_ACTIVATION_COLUMN = 'payme_ready_for_activation'
export const READY_FOR_ACTIVATION_AT_COLUMN = 'payme_ready_for_activation_at'

export interface ProviderReadinessRow {
  payme_ready_for_activation?: boolean | null
  payme_ready_for_activation_at?: string | null
}

export interface ProviderReadinessState {
  readyForActivation: boolean
  readyForActivationAt: string | null
}

// The exact update payload written when a provider marks/withdraws readiness. It is
// a plain profile flag update. It contains ONLY the two readiness columns — never
// any payme_seller_* / onboarding / signup-url field — so persisting readiness can
// never create or reference a PayMe Seller.
export interface ReadinessUpdate {
  payme_ready_for_activation: boolean
  payme_ready_for_activation_at: string | null
}

/**
 * Read the persisted readiness state from a profile row. Absent/false both mean
 * "not ready". Pure — reading readiness never triggers any side effect.
 */
export function readProviderReadiness(
  row: ProviderReadinessRow | null | undefined,
): ProviderReadinessState {
  const ready = row?.payme_ready_for_activation === true
  const at = typeof row?.payme_ready_for_activation_at === 'string' ? row.payme_ready_for_activation_at : null
  return {
    readyForActivation: ready,
    // A withdrawn/never-ready provider has no meaningful timestamp.
    readyForActivationAt: ready ? at : null,
  }
}

/**
 * Build the profile update for marking (ready=true) or withdrawing (ready=false)
 * activation readiness. Persists intent ONLY — no PayMe field is ever written here.
 * `nowIso` is passed in (not read from a clock) to keep this pure/testable.
 */
export function buildReadinessUpdate(ready: boolean, nowIso: string): ReadinessUpdate {
  return {
    payme_ready_for_activation: ready,
    payme_ready_for_activation_at: ready ? nowIso : null,
  }
}
