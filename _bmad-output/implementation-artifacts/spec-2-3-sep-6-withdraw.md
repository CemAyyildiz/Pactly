---
title: 'Story 2.3 — SEP-6 withdraw (professional cashing out in local currency)'
type: 'feature'
created: '2026-09-20'
status: 'ready-for-dev'
review_loop_iteration: 0
baseline_revision: 'f2bb11f9c044c6af8afa1a3e82c94382207cf697'
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-2-4-sep-6-deposit.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-3-7-paying-the-balance.md'
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** A provider whose deposit was released holds USDC in their wallet and has no way, inside Pactly, to turn it into local currency. The PRD requires SEP-6 withdraw on the hackathon's anchor (FR8, Story 2.3), and the demo's closing beat is "the clinic cashes out in TRY".

**Approach:** From the provider panel, the provider chooses an amount to cash out. Pactly authenticates their wallet with the anchor (SEP-10), passes the simulated KYC (SEP-12), opens a SEP-6 withdraw, and receives the anchor's treasury account and memo. Pactly builds the USDC payment to that account with that memo; the provider signs it in their wallet; Pactly submits it and tracks the anchor's transaction until `completed`. Nothing custodial: the provider's key never leaves their wallet.

## Boundaries & Constraints

**Always:**
- Everything about the anchor comes from `stellar.toml` (AD-10). Anchor SEP-10 and SEP-12 reuse Story 2.4's clients (`backend/src/anchor/sep10.ts`, `sep12.ts`); the anchor JWT is stored per wallet and never mixed with Pactly's own (AD-5).
- The withdraw is started with the anchor's `type=bank_account` and the provider's chosen USDC amount. The anchor's response gives `account_id` (its treasury) and `memo` with `memo_type: id`; both are stored on a `cash_outs` row with the anchor's transaction id and status.
- Limits are enforced before any anchor call (NFR3, 2.3 AC5), against the anchor's advertised min/max in local currency using the SEP-38 indicative rate (Story 2.2, `backend/src/anchor/sep38.ts`): an amount outside the limits gets a plain sentence naming the limit.
- The USDC payment is built server-side from the provider's wallet to the anchor's treasury, with the anchor's memo, using the same builder and hash-binding rule as Story 3.7's balance payment: the built hash is stored, the provider signs in their wallet, and submit relays only a signed envelope whose hash matches. It is confirmed through Soroban RPC before the cash-out is marked `sent`.
- After the payment lands, the anchor's transaction is polled until `completed` (2.3 AC4); the panel shows the anchor's states in plain words: "Waiting for your transfer" → "Sent" → "Paid out". A cash-out that the anchor reports as `error` shows the reason in plain words and keeps the transaction id for support.
- The amount a provider may cash out is capped by what their wallet actually holds in the anchor's USDC (read from Horizon or RPC), never by Pactly's own bookkeeping alone; the panel shows that balance.
- The provider is never shown SEP vocabulary (NFR9): "Cash out to your bank", "Amount", "Sent", "Paid out".
- Errors are typed and mapped to the `{ code, message }` envelope; no raw anchor body reaches the panel.

**Never:**
- No custody, no server-side signing, no sweeping of anyone's funds (AD-14's managed-account refunds belong to the managed-account story).
- No change to escrow, the reconciler, booking state or `chain/`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Balance | `GET /me/provider/cash-out/balance` | The wallet's USDC balance in the anchor's asset, and the anchor's limits in local currency | Wallet has no trustline: balance `"0"` with `hasTrustline: false` |
| Limits | Amount below min or above max in local currency | Refused before any anchor call | `409 AMOUNT_OUT_OF_RANGE` with `details.min/max/currency` |
| Insufficient | Amount above the wallet's USDC balance | Refused | `409 INSUFFICIENT_BALANCE` |
| Start | `POST /me/provider/cash-out` `{amount}` by a provider with a valid anchor JWT | SEP-12 then SEP-6 withdraw; a `cash_outs` row with the anchor id, treasury account, memo, status; response carries `{cashOutId, unsignedXdr}` | Anchor JWT missing/expired: `401 ANCHOR_AUTH_REQUIRED` (the panel runs the challenge flow) |
| Submit | `POST /me/provider/cash-out/:id/submit` `{signedXdr}` whose hash matches | Confirmed on chain → status `sent`, tx hash stored | Mismatch: `409 XDR_MISMATCH`; FAILED: `502 PAYMENT_FAILED`; unreachable: `503` |
| Poll | `GET /me/provider/cash-out/:id` | Anchor status mapped to plain words; `paid_out` on `completed` | Anchor unreachable: last known status plus `stale: true` |
| List | `GET /me/provider/cash-outs` | The provider's cash-outs, newest first | No error expected |
| Not a provider | A wallet without a profile | Nothing revealed | `404 NOT_A_PROVIDER` |
| Not owner | Another provider's cash-out id | Nothing revealed | `404 CASH_OUT_NOT_FOUND` |

</intent-contract>

## Code Map

- `backend/src/anchor/sep10.ts`, `sep12.ts`, `sep6-deposit.ts` (Story 2.4, landing in parallel) -- the anchor auth, KYC and the transaction-polling shape to mirror. If 2.4 is not in your tree yet, write `sep6-withdraw.ts` against the anchor's documented shapes and keep the polling helper local; the merge will reconcile.
- `backend/src/anchor/sep38.ts` (Story 2.2) -- `fetchIndicativePrice` for the limit check.
- `backend/src/payments/stellar.ts` (Story 3.7) -- `buildBalancePaymentTransaction` / `submitBalancePaymentTransaction`: the payment builder, the hash-binding rule and the RPC poll. Generalise a memo-carrying payment from them rather than copying.
- `backend/src/services/booking.ts` -- `getBookingForProvider`'s provider-ownership check is the pattern for provider-only routes; the cash-out is not booking-scoped, so it lives in a new `services/cashOut.ts`.
- `backend/src/db/schema.ts`, `migrations.ts` -- a new `cash_outs` table.
- `frontend/src/pages/panel/` (Story 3.5/3.6) -- the panel shell; add `/panel/cash-out`.
- The anchor's reference: `https://tr-mock-anchor.fly.dev/llms-full.txt` (withdraw flow and statuses) and `/sep`.

## Tasks & Acceptance

**Execution:**
- `backend/src/anchor/sep6-withdraw.ts` -- start and poll behind an injectable fetch seam, typed errors, status mapping.
- `backend/src/db/*` -- `cash_outs` and its writers.
- `backend/src/services/cashOut.ts` -- balance, limits, start, submit (hash-bound, RPC-confirmed), poll, list.
- routes -- the matrix's routes, provider-only.
- `backend/test/` -- a test per matrix row with recorded anchor payloads; no live call in tests.
- `frontend/src/pages/panel/CashOutPage.tsx` -- balance, amount, "Cash out to your bank", sign, then the status in plain words with the anchor's transaction id; panel nav entry.
- `README.md` -- the cash-out step of the demo.

**Acceptance Criteria:**
- Given a provider whose wallet holds the anchor's USDC, when they cash out an amount inside the limits and sign, then the panel shows "Sent" once the payment is confirmed and "Paid out" once the anchor completes.
- Given the backend workspace, when `typecheck`, `test` and `build` run, then all are clean and every matrix row has a passing test.

## Spec Change Log

## Review Triage Log

## Verification

**Commands:**
- `npm run -w backend typecheck && npm run -w backend test && npm run -w backend build` -- expected: clean, all pass
- `npm run -w frontend typecheck && npm run -w frontend build` -- expected: clean

**Manual checks:**
- Against the live sandbox with a provider wallet holding the anchor's USDC: cash out a small amount, sign, watch "Sent" then "Paid out".
