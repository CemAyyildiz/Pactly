---
title: 'Story 2.4 — SEP-6 deposit (client paying the deposit in local currency)'
type: 'feature'
created: '2026-09-20'
status: 'in-progress'
review_loop_iteration: 0
baseline_revision: 'd8f9e0a980e9307b4b5468e27b321c0b6fccaeca'
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-2-1-sep-1-discovery-and-sep-10-authentication.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-3-4-client-booking-flow.md'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-Pactly-2026-09-15/EXPERIENCE.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** The booking screen offers "Local currency" and then says it is not available. The hackathon's anchor (`tr-mock-anchor.fly.dev`) exists precisely so a Turkish client can pay in TRY, and the PRD makes the SEP-6 flows mandatory (FR4, Story 2.4). Today the only way to lock a deposit is to already hold USDC.

**Approach:** Let a client with a wallet pay the deposit in local currency: Pactly authenticates the wallet with the anchor (SEP-10), passes the simulated KYC (SEP-12), opens a SEP-6 deposit for the deposit amount, shows the bank details and reference the anchor returns, and tracks the transaction until the anchor's USDC lands in the client's wallet. From there the existing Lock with Pactly flow runs unchanged. The hold is extended while the deposit is pending so the slot does not slip away mid-transfer.

## Boundaries & Constraints

**Always:**
- Everything about the anchor is read from `stellar.toml` (AD-10): `TRANSFER_SERVER`, `WEB_AUTH_ENDPOINT`, `KYC_SERVER`, the USDC asset. Nothing anchor-specific is a constant.
- Anchor SEP-10 (`backend/src/anchor/sep10.ts`, Story 2.1) is the identity for SEP-12 and SEP-6. The anchor's JWT is stored per wallet with its expiry (Story 2.1's `anchor_jwts`) and is never mixed with Pactly's own JWT (AD-5). The client signs the anchor challenge in their own wallet; Pactly never holds a key.
- SEP-12 is called before the first deposit for a wallet. The mock auto-approves without personal data, so no form is shown; if a real anchor ever required fields, the flow surfaces them, it does not invent values.
- The deposit is for exactly the booking's `depositAmount`, converted to the anchor's own units with the same exact arithmetic 3.7 uses, and the request carries the booking id as the anchor's `memo`/reference where the anchor accepts one, so the incoming payment can be matched.
- Anchor limits are enforced before any anchor call (NFR3, 3.4 AC6): using the anchor's advertised min/max and the SEP-38 indicative rate (Story 2.2), a deposit outside the limits is refused with a plain sentence that names the limit and offers the wallet path.
- A missing USDC trustline is handled without the term ever reaching the client (AD-11, 2.4 AC4): before opening the deposit, Pactly checks the wallet's trustline and, if absent, builds the change-trust transaction for the client to sign under the copy "Getting your wallet ready". The anchor's `pending_trust` state is handled the same way if it appears.
- The deposit's lifecycle is stored on the booking (`anchor_deposit_id`, status, `more_info_url`, bank details snapshot, updated-at) and polled through SEP-6 `transaction` until `completed`, `error` or expiry. While a deposit is `pending_user_transfer_start` or `pending_anchor`, the booking's hold is extended (to now + 10 minutes on every poll that still shows progress) so the slot is not resold mid-transfer.
- On `completed`, the client's wallet holds the USDC and the screen moves straight to Lock with Pactly (3.4's flow, unchanged). Nothing is marked locked until the reconciler sees the escrow funded (AD-1).
- Sandbox simulation is exposed only as a developer/demo affordance: a "Simulate the bank transfer" action that calls the anchor's `POST /sep6/tx/{id}/simulate-bank-transfer`, shown only when the resolved anchor's home domain is the sandbox one, and labelled as a sandbox action.
- The client is never shown SEP vocabulary (NFR9): "Pay in TRY by bank transfer", "Bank details", "Reference", "Waiting for your transfer", "Money received".
- Errors are typed (`AnchorAuthError`, `AnchorKycError`, `AnchorDepositError`, `AnchorUnavailableError`) and mapped to the `{ code, message }` envelope; no raw anchor body ever reaches the client.

**Never:**
- No managed (custodial) account for a client without a wallet (2.4 AC5–7, AD-6, AD-14). That is a separate story with its own key-custody design; this story requires a connected wallet and says so on the screen.
- No SEP-6 withdraw (Story 2.3). No change to escrow, the reconciler, or `chain/`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Anchor auth | `POST /bookings/:id/anchor/challenge` then `/anchor/verify` by the booking's client | Anchor JWT stored for the wallet with expiry | Signer mismatch or expired challenge: `401 ANCHOR_AUTH_FAILED` |
| Reuse | A stored anchor JWT that has not expired | No new challenge | No error expected |
| Limits | Deposit below the anchor's min or above its max in local currency | Refused before any anchor call | `409 AMOUNT_OUT_OF_RANGE` with `details.min/max/currency` |
| Trustline missing | Wallet has no USDC trustline | `{ needsTrustline: true, unsignedXdr }` for the client to sign; deposit opens after it lands | No error expected |
| Open deposit | `POST /bookings/:id/deposit/local` by the owner, hold active, escrow_state null | SEP-12 then SEP-6 deposit; response carries bank details, reference, `moreInfoUrl`, `expiresAt`; booking stores the deposit id | Hold expired: `409 HOLD_EXPIRED`; already open: returns the existing one |
| Poll | `GET /bookings/:id/deposit/local` | Current anchor status, mapped to plain words | Anchor unreachable: last known status plus `stale: true` |
| Progress extends hold | Status still pending on a poll | `holdExpiresAt` moved to now + 10 min | No error expected |
| Completed | Anchor reports `completed` | Status `received`; the UI continues to Lock with Pactly | No error expected |
| Failed | Anchor reports `error` | Status `failed` with the anchor's reason in plain words; the client may retry or pay with the wallet | No raw body |
| Simulate (sandbox) | `POST /bookings/:id/deposit/local/simulate` when the anchor is the sandbox | Calls the anchor's simulate endpoint | On a non-sandbox anchor: `404` |
| Not owner | Another wallet | Nothing revealed | `404 BOOKING_NOT_FOUND` |

</intent-contract>

## Code Map

- `backend/src/anchor/sep10.ts`, `db/anchorJwts.ts`, `services/auth.ts` -- Story 2.1's anchor authentication and JWT storage. Reuse `runAnchorSep10` and the stored-JWT path; add the two routes that let the client sign the anchor challenge in their wallet.
- `backend/src/anchor/stellar-toml.ts`, `usdc.ts` -- endpoint discovery and the USDC asset.
- `backend/src/anchor/sep38.ts` (Story 2.2, landing in parallel) -- the indicative rate for the limit check. If it is not in the tree yet, call the anchor's `sep38/price` directly behind the same seam shape and reconcile later.
- `backend/src/services/booking.ts` -- hold semantics (`holdExpiresAt`, `requireHoldNotExpired`), owner checks, and the 3.4 lock flow this story hands over to.
- `backend/src/db/schema.ts`, `migrations.ts` -- new nullable booking columns via the guarded ALTER pattern.
- `backend/src/payments/stellar.ts` (3.7) -- how a classic transaction is built for the client's signature; the change-trust transaction follows it.
- `frontend/src/pages/booking/BookingPage.tsx` -- the payment-method choice ("Local currency" currently disabled) and the lock flow to continue into.
- The anchor's own reference: `https://tr-mock-anchor.fly.dev/llms-full.txt` (flow, statuses, simulate endpoint) and `/sep`. Read both before writing the client.

## Tasks & Acceptance

**Execution:**
- `backend/src/anchor/sep12.ts`, `sep6-deposit.ts` -- KYC and deposit clients behind injectable fetch seams, with typed errors and status mapping.
- `backend/src/db/*` -- the deposit columns and their writers.
- `backend/src/services/booking.ts` -- anchor auth for a booking's client, limit check, trustline check and change-trust build, open/poll/simulate, hold extension.
- routes -- the matrix's routes.
- `backend/test/` -- a test per matrix row with recorded anchor payloads (no live call in tests).
- `frontend/src/pages/booking/BookingPage.tsx` and components -- "Pay in TRY by bank transfer" as a live choice: bank details and reference, a waiting state with the anchor's expiry, the sandbox simulate button, "Money received", then straight into Lock with Pactly.
- `README.md` -- the local-currency demo path, including the sandbox simulate step.

**Acceptance Criteria:**
- Given a held booking and a connected wallet without USDC, when the client chooses to pay in local currency, then they see bank details and a reference, and after the (simulated) transfer completes their wallet holds the USDC and the screen offers Lock with Pactly.
- Given a deposit outside the anchor's limits, when the client chooses local currency, then they are told the limit before any anchor call and offered the wallet path.
- Given the backend workspace, when `typecheck`, `test` and `build` run, then all are clean and every matrix row has a passing test.

## Spec Change Log

## Review Triage Log

## Design Notes

- **Why the wallet path only.** A client without a wallet needs a managed account whose key Pactly holds (AD-6) and whose refunds must be swept back out (AD-14). That is custody, with its own threat model and tests; folding it in here would either rush it or block this story. It is recorded as the next story (2.7), and the screen tells a walletless client plainly what they need.
- **Why the hold is extended rather than lengthened up front.** A bank transfer, even simulated, can take longer than a 10-minute hold; extending on observed progress keeps the slot for a client who is actually paying and still frees it for one who walked away.

## Verification

**Commands:**
- `npm run -w backend typecheck && npm run -w backend test && npm run -w backend build` -- expected: clean, all pass
- `npm run -w frontend typecheck && npm run -w frontend build` -- expected: clean

**Manual checks:**
- Against the live sandbox with a funded testnet wallet: open a local-currency deposit, press the sandbox simulate button, watch the status reach "Money received", then lock the deposit.
