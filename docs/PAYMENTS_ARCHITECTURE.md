# Payments Architecture

## Market rule

- Israel (`IL`) is planned to use `PayMe`
- International markets use `Stripe`
- Current live client and provider flows remain explicitly pinned to `Stripe` until rollout is approved

## Provider selection rule

`src/payments/PaymentService.ts` is the single app entry point for payment operations.

`PaymentService` delegates to a provider through `providerResolver`:

- `IL` / `ISR` / `ISRAEL` => `payme`
- fallback => `stripe`

Phase 1 and Phase 2 keep production behavior stable by explicitly constructing:

```ts
new PaymentService({ provider: 'stripe' })
```

at current live integration points.

## Why direct provider calls are forbidden

Direct `Stripe` or future `PayMe` calls from screens, hooks, or feature helpers create long-term coupling and make market routing unsafe.

All provider-specific behavior must stay behind:

- `PaymentProvider`
- `PaymentService`
- provider modules under `src/payments/`
- backend Edge Functions for secret/server-only operations

This keeps:

- market routing centralized
- UI behavior stable during provider rollout
- secret handling out of frontend code
- webhook and audit processing provider-agnostic

## Frontend module layout

### Shared abstraction

- `src/payments/PaymentProvider.ts`
- `src/payments/PaymentService.ts`
- `src/payments/StripeProvider.ts`
- `src/payments/PayMeProvider.ts`
- `src/payments/providerResolver.ts`
- `src/payments/types.ts`

### PayMe foundation

- `src/payments/payme/client.ts`
- `src/payments/payme/types.ts`
- `src/payments/payme/sellers.ts`
- `src/payments/payme/payments.ts`
- `src/payments/payme/refunds.ts`
- `src/payments/payme/payouts.ts`
- `src/payments/payme/webhooks.ts`
- `src/payments/payme/index.ts`

## Environment configuration

Frontend-safe PayMe environment variables:

- `VITE_PAYME_BASE_URL`
- `VITE_PAYME_PARTNER_ID`
- `VITE_PAYME_CLIENT_KEY`
- `VITE_PAYME_ENV=sandbox|production`

Important:

- do not place PayMe secret/server-only credentials in frontend code
- if PayMe requires secret signing or server-authenticated seller/payment actions, route them through Supabase Edge Functions

## Seller onboarding flow

### Stripe today

1. Provider opens onboarding
2. Frontend calls `PaymentService({ provider: 'stripe' })`
3. `StripeProvider` invokes:
   - `create-connect-account`
   - `create-connect-onboarding-link`
   - `get-connect-status`
4. Provider completes Stripe onboarding
5. App checks seller readiness before allowing online mode

### PayMe planned

1. Provider onboarding starts through `PayMeProvider`
2. Seller draft / seller status / onboarding link are routed through `src/payments/payme/sellers.ts`
3. If secret auth is required, move the call to an Edge Function
4. Seller readiness maps back to generic `SellerStatus`

Phase 2 status:

- config-aware module foundation exists
- seller methods are intentionally not fully implemented until sandbox endpoint details are confirmed

## Payment flow

### Shared rule

All payment creation must go through `PaymentService`.

### Stripe today

1. Client checkout calls shared payment helper
2. Helper uses `PaymentService({ provider: 'stripe' })`
3. `StripeProvider` invokes `create-payment-intent`
4. Existing Stripe-native and saved-card flows continue unchanged

### PayMe planned

1. Market routing resolves PayMe for Israel
2. `PayMeProvider` delegates to `src/payments/payme/payments.ts`
3. Payment capture, fees, splits, and refunds will be added after sandbox validation

## Webhook flow

### Stripe today

- `supabase/functions/stripe-webhook`
- handles Stripe event verification and business routing

### PayMe foundation

- `supabase/functions/payme-webhook`
- accepts `POST`
- parses JSON safely
- logs the incoming event
- writes a generic audit record to `public.payment_events`
- returns `200 OK`

Pending TODOs:

- PayMe signature verification
- event-type routing
- seller/payment/refund/payout reconciliation logic

## Audit table

`public.payment_events` is the generic provider-agnostic webhook audit table.

It stores:

- provider
- event type
- external event id
- related booking/provider ids
- raw payload
- processing state
- processing timestamp
- last error

Permissions:

- RLS enabled
- no anon/authenticated access
- service role only

## Platform fee flow

### Stripe today

- platform fee and provider earnings are computed in the existing Stripe payment flow
- payout and transfer truth remain unchanged

### PayMe planned

Platform fee work still needs explicit sandbox confirmation for:

- fee collection model
- marketplace split behavior
- seller settlement timing
- payout lifecycle events

## PayMe sandbox POC checklist

- confirm base sandbox URL
- confirm seller draft endpoint and schema
- confirm seller status endpoint and lifecycle states
- confirm onboarding redirect/link flow, if any
- confirm payment creation endpoint
- confirm refund endpoint
- confirm payout and settlement status model
- confirm webhook signing scheme
- confirm external event id and event type fields
- confirm whether any operation requires server-only credentials
- move secret-requiring flows to Edge Functions before live rollout
