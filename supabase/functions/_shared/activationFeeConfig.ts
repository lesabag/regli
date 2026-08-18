// SINGLE SOURCE OF TRUTH — one-time Provider Account Activation Fee amount.
//
// Financial amounts are SERVER-AUTHORITATIVE. Both the quote shown to the provider
// (payme-provider-activation-quote) and the amount authorized with PayMe (the J5 in
// payme-authorize-provider-activation) derive from THIS module. The client never
// independently decides the amount — it only formats/displays the quote returned by
// the server (see src/config/activationFee.ts, which now holds ONLY a formatter).
//
// The price literal (299 ILS + VAT) and the VAT calculation live here and NOWHERE
// else. Ops may override the net amount / VAT rate via server env without a client
// change; the defaults below are the authoritative business price.
//
// This module is intentionally pure (no Deno globals, no I/O) so it is unit-tested
// under `node --test` alongside the orchestration state machine.

export const ACTIVATION_FEE_CURRENCY = 'ILS'

// Net, pre-VAT, in agorot (1 ILS = 100 agorot). 299.00 ILS.
export const DEFAULT_ACTIVATION_FEE_NET_AGOROT = 29900
// Israeli VAT rate applied on top of the net fee.
export const DEFAULT_ACTIVATION_FEE_VAT_RATE = 0.18

export interface ActivationFeeQuote {
  currency: string
  netAgorot: number
  vatAgorot: number
  grossAgorot: number
}

/** Compute a full quote (net / VAT / gross) from a net amount + VAT rate. */
export function computeActivationFeeQuote(netAgorot: number, vatRate: number): ActivationFeeQuote {
  const vatAgorot = Math.round(netAgorot * vatRate)
  return {
    currency: ACTIVATION_FEE_CURRENCY,
    netAgorot,
    vatAgorot,
    grossAgorot: netAgorot + vatAgorot,
  }
}

/**
 * Resolve the authoritative activation-fee quote from server configuration.
 * `getEnv` is the env accessor (Deno.env.get in the edge functions; a stub in
 * tests). Falls back to the authoritative default price when unset. Returns null
 * only when an explicit override is present but invalid — callers must fail closed
 * rather than charge a bogus amount.
 */
export function resolveActivationFeeQuote(
  getEnv?: (key: string) => string | undefined,
): ActivationFeeQuote | null {
  const rawNet = getEnv?.('PAYME_PROVIDER_ACTIVATION_FEE_NET_AGOROT')
  const rawRate = getEnv?.('PAYME_PROVIDER_ACTIVATION_FEE_VAT_RATE')

  const netAgorot =
    rawNet != null && rawNet.trim() !== ''
      ? Number.parseInt(rawNet, 10)
      : DEFAULT_ACTIVATION_FEE_NET_AGOROT
  const vatRate =
    rawRate != null && rawRate.trim() !== ''
      ? Number.parseFloat(rawRate)
      : DEFAULT_ACTIVATION_FEE_VAT_RATE

  if (!Number.isInteger(netAgorot) || netAgorot <= 0) return null
  if (!Number.isFinite(vatRate) || vatRate < 0 || vatRate >= 1) return null

  return computeActivationFeeQuote(netAgorot, vatRate)
}
