// CLIENT-SIDE DISPLAY HELPERS for the one-time Provider Account Activation Fee.
//
// The fee AMOUNT is SERVER-AUTHORITATIVE. The client never decides or computes the
// amount to charge: it fetches an authoritative quote from the server
// (payme-provider-activation-quote -> getProviderActivationFeeQuote) and only
// FORMATS it for display. The single source of truth for the price (net + VAT ->
// gross) is supabase/functions/_shared/activationFeeConfig.ts, which is also what
// the J5 authorization charges — so the displayed amount and the charged amount can
// never drift.
//
// Deliberately NO price literal and NO VAT math live in this file.

/** Format an agorot amount as an ILS major-unit string, e.g. 35282 -> "352.82". */
export function formatAgorotAmount(agorot: number): string {
  return (agorot / 100).toFixed(2)
}
