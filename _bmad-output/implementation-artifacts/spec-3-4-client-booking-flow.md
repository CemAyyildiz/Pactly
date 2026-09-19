---
title: 'Story 3.4 — Client booking flow (Lock with Pactly)'
type: 'feature'
created: '2026-09-19'
status: 'ready-for-dev'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-2-6-trustless-work-escrow-adapter-and-reconciliation.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-3-1-provider-profile-and-availability.md'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-Pactly-2026-09-15/DESIGN.md'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-Pactly-2026-09-15/EXPERIENCE.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** A client can see a provider's slots but cannot book one. Story 2.6 builds unsigned deploy and fund XDR, but nothing holds a slot, submits a signed transaction, runs the reconciler, or shows the client that the deposit is locked. "Lock with Pactly", the product's core moment, does not exist.

**Approach:** Add the AD-13 slot hold, three owner-only escrow steps (deploy, fund, submit signed XDR), a background runner for the reconciler and for hold expiry, and a booking read route. On the frontend, build the Booking & payment screen from the booking-and-payment composition. It requests the wallet only at the payment step, runs both signatures behind the single **Lock with Pactly** button, and stamps the seal only once reconciled funding evidence shows the booking `locked`.

## Boundaries & Constraints

**Always:**
- The hold is AD-13: the backend mints `booking_id`, blocks the slot for 10 minutes and writes the booking with `escrow_state` null (`pending_lock`). Every chain call uses only that id. A slot has at most one active booking: a non-expired hold, or a booking whose `escrow_state` is non-null. This is enforced in SQL, not by a read-then-write.
- The hold's money comes from the provider profile at hold time:
  - deposit = 3.1's `computeDepositAmount`;
  - balance = price − deposit;
  - `cancelDeadline` = slot start − `cancellationWindowHours`;
  - `tokenAddress` = the USDC Stellar Asset Contract id.
  The frontend never supplies any amount.
- The USDC asset comes from the anchor's `stellar.toml` (AD-10), resolved once and cached. The contract id is the Stellar SDK's `Asset.contractId(networkPassphrase)`. No token address constant exists in code.
- Only the booking's own client wallet (JWT) may run lock, fund or submit on it. Anyone else gets `404 BOOKING_NOT_FOUND`, so bookings are not enumerable.
- The escrow steps go through `services/booking.ts` (`lockDeposit`, `fundDeposit`) and the adapter only. Submit is a new adapter method, `submit(signedXdr)` → `{txHash}`, over the SDK's `rest.sendTransaction`, with 2.6's typed-error translation.
- `escrow_state` stays reconciler-only (AD-1). The UI shows "locked" only when `GET /bookings/:id` returns `escrowState: "locked"`, never on a submit response.
- Lock and fund are refused after the hold expires (`409 HOLD_EXPIRED`). Submit is allowed after expiry, because a transaction the client already signed must still land and be reconciled.
- An expired hold releases the slot, but its booking row is kept: it may carry a `contractId` the reconciler must keep polling, so dropping it could orphan funds. A slot freed from an expired hold whose escrow later reconciles as funded is logged as an anomaly (double-sale risk), never silently overwritten.
- The runner starts in `index.ts` only (never in `createApp` and never in tests). Each tick is independent: the reconciler every 15 s, but only when the Trustless Work config is complete, and hold expiry every 30 s. A failed tick logs and never crashes the process.
- UI follows DESIGN.md and EXPERIENCE.md:
  - three lanes from 1024px up; below that, a stack with the escrow lane pinned to the bottom bar;
  - "Lock with Pactly" is the only black button;
  - summary before funding: provider, appointment, amount, policy deadline, and who may approve, release or resolve;
  - deposit + window always together;
  - "Approve it in your wallet" while signing, with "Open wallet again" after 60 s;
  - a rejected signature is neutral info ("You didn't sign. The slot is still yours for N minutes.");
  - a live hold countdown;
  - seal plus "You're set." plus escrow proof ("Escrow powered by Trustless Work on Stellar" + shortened contract id linking to a testnet explorer);
  - `prefers-reduced-motion` skips the animation.
- Signature budget honesty: the UI never promises one signature. Each wallet prompt names the human action: "Create your escrow", then "Lock your deposit".

**Never:**
- No local-currency (SEP-6) payment. Story 2.4 is not built. The method selector shows "Local currency" as unavailable with one plain sentence, and stablecoin is the only live path. This is recorded as a gap against PRD 3.4 AC4. For the same reason, the anchor limit warning (AC6, TRY limits) does not apply to the stablecoin path.
- No release, approval, dispute or cancellation (Story 3.6). No "My bookings" list (Story 3.5).
- No private key on the server. Signing happens only in the client's wallet.
- No changes to `backend/src/chain/`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Hold | `POST /bookings/hold` `{providerId, slotStartsAt}` with a JWT; the slot is open and in the future | `201` `{bookingId, holdExpiresAt, deposit, balance, price, cancelDeadline, provider summary}` | No error expected |
| Slot taken | The slot has an active hold or a locked booking | Nothing written | `409 SLOT_TAKEN`, `details.sameDaySlots` = that provider's other open slots on the same local day |
| Concurrent holds | Two holds race for one slot | Exactly one succeeds | The other gets `409 SLOT_TAKEN` |
| Bad slot | Unknown provider, unapproved provider, slot not published, or slot in the past | Nothing written | `404 PROVIDER_NOT_FOUND` / `409 SLOT_UNAVAILABLE` |
| Lock | `POST /bookings/:id/lock` by the owner within the hold | `{unsignedXdr, contractId}`; `contractId` persisted (2.6 `lockDeposit`) | Expired: `409 HOLD_EXPIRED`; already locked: `409 BOOKING_STATE` |
| Fund | `POST /bookings/:id/fund` by the owner after a deploy was submitted | `{unsignedXdr}` for the deposit | No contractId: `409 BOOKING_STATE`; expired: `409 HOLD_EXPIRED` |
| Submit | `POST /bookings/:id/submit` `{signedXdr}` by the owner | `{txHash}` from Trustless Work | TW refusal: `502 ESCROW_REJECTED` with a safe message; unreachable: `503 ESCROW_UNAVAILABLE`; never a raw body |
| Not owner | Another wallet calls lock, fund, submit or GET | Nothing revealed | `404 BOOKING_NOT_FOUND` |
| Read | `GET /bookings/:id` by the owner | `{id, escrowState, lifecycle (getEscrowLifecycle), holdExpiresAt, contractId, amounts, provider summary, slotStartsAt, cancelDeadline}` | No error expected |
| Hold expires | 10 minutes pass with `escrow_state` null | The slot becomes holdable again; the row is kept | No error expected |
| Funded after expiry | Reconciler sets `locked` on an expired hold whose slot was re-held | Both rows kept; anomaly logged | No silent overwrite |
| Wallet rejects | The user declines a signature | Neutral message, hold countdown continues; Lock can be retried | No error state |
| Retry after a rejected deploy | `POST /bookings/:id/lock` again, within the hold, with a `contractId` already persisted | Returns the same stored unsigned deploy XDR and the same `contractId` (no new escrow) | No error expected |
| Stored deploy XDR no longer valid | Submit of the stored deploy XDR fails (for example, expired or bad sequence) and `listEscrows` confirms the persisted contract is not on chain | `lock` may clear the persisted `contractId` (conditional on it being unchanged and `escrow_state` null) and build a fresh deploy | If the contract is on chain: no rebuild; continue to fund |
| Runner resilience | A reconciler tick throws | Logged; the next tick runs | Process keeps running |

</intent-contract>

## Code Map

- `backend/src/services/booking.ts` -- `createBookingHold` (inserts with a given `depositAmount`/`cancelDeadline`; extend it with `slotId`/`holdExpiresAt` and derive the amounts inside), `lockDeposit` (refuses once a `contractId` is persisted), `fundDeposit`, `BookingEscrowStateError`. `getEscrowLifecycle` is in `escrow/trustless-work/reconciler.ts`.
- `backend/src/escrow/interface.ts`, `trustless-work/client.ts` -- add `submit` to `EscrowAdapter` and to `EscrowCallDeps` (`sendTransaction` seam), funnelled through `callTrustlessWork`.
- `backend/src/escrow/trustless-work/reconciler.ts` -- `runReconcilerOnce({db, listEscrows, platformAddress})` and `realListEscrows()`. The runner calls these.
- `backend/src/db/schema.ts`, `migrations.ts`, `bookings.ts` -- `bookings` needs `slot_id` (FK to 3.1's `availability_slots`) and `hold_expires_at` (epoch seconds), added via the guarded ALTER pattern. Enforce one active booking per slot with a partial unique index or an atomic conditional insert. 3.1's "replace all future slots" on availability save must now keep slots that carry an active or locked booking. Update that function and add a test.
- `backend/src/anchor/stellar-toml.ts` -- `fetchAnchorToml`/`parseSepEndpoints` exist. Add a USDC asset resolver, mirroring `scripts/src/toml.ts`'s `resolveUsdcAsset`, plus the SAC contract id derivation.
- `backend/src/app.ts` + 3.1's routes module, `backend/src/index.ts` -- the new routes, and the runner start next to `serve(...)`.
- `frontend/src/` (3.1 and 3.2 foundation) -- router, api hooks, `wallet/` (Stellar Wallets Kit connect + sign), `DepositPill`, `SlotChip`, `lib/money.ts`. The profile page's selected slot gets a "Continue" action into the booking route.
- `_bmad-output/planning-artifacts/ux-designs/ux-Pactly-2026-09-15/mockups/booking-and-payment.html` -- composition reference for the three lanes, escrow lane, method choice, summary and seal. DESIGN.md and EXPERIENCE.md win on conflict.

## Tasks & Acceptance

**Execution:**
- `backend/src/db/*` -- the booking slot and hold columns, the one-active-booking-per-slot guarantee, and the availability-save preservation rule.
- `backend/src/anchor/usdc.ts` -- resolve and cache the USDC asset and its contract id.
- `backend/src/escrow/interface.ts`, `trustless-work/client.ts` -- `submit`.
- `backend/src/services/booking.ts` -- `holdSlot` (atomic, returns the same-day alternatives on conflict), deploy-XDR storage and the chain-checked rebuild for lock retries, the owner check, hold-expiry checks in lock and fund, `submitSignedTransaction`, `expireHolds`, `getBookingForClient`.
- `backend/src/runner.ts` + `index.ts` -- the reconciler and hold-expiry intervals with per-tick error isolation. The hold-expiry tick logs the double-sale anomaly.
- routes -- the five booking routes in the matrix.
- `backend/test/` -- a test for every matrix row, including a real concurrent-hold race against one in-memory DB and the runner's tick isolation (with the runner's interval injected).
- `frontend/src/pages/booking/BookingPage.tsx` -- route `/book/:providerId?slot=`. The steps are:
  1. review summary;
  2. connect wallet and hold;
  3. Lock with Pactly: lock → sign → submit → poll until the deploy is visible → fund → sign → submit;
  4. poll `GET /bookings/:id` until `locked`;
  5. seal.
  Handle slot-taken (show the other slots that day), hold countdown and expiry, wallet rejection, and backend errors in the voice guide.
- `frontend/src/components/EscrowLane.tsx`, `LockButton.tsx`, `Seal.tsx`, `EscrowProof.tsx` -- per DESIGN.md.
- `README.md` -- "Try a booking": a testnet wallet (Freighter) with XLM and the anchor's USDC (`npm run setup:testnet`), and the Trustless Work env vars.

**Acceptance Criteria:**
- Given a seeded provider and a testnet wallet holding USDC, when the client picks a slot, connects the wallet, taps Lock with Pactly and approves both prompts, then the screen waits in "Locking with Pactly" and shows the seal with the escrow proof link only after `GET /bookings/:id` returns `locked`. The slot then shows as taken on the profile.
- Given the backend workspace, when `typecheck`, `test` and `build` run, then all are clean and every matrix row has a passing test. Given the frontend, when `typecheck` and `build` run, then both are clean.

## Spec Change Log

## Review Triage Log

## Design Notes

- **Why the fund step waits for the deploy to be visible.** Story 2.6 split deploy and fund because building a fund transaction against a contract not yet on chain is unverified. The client flow submits the deploy, then polls `GET /bookings/:id` until the reconciler has seen the contract (or a short retry of `fund` succeeds), before it asks for the second signature.
- **Why expired holds keep their row.** The row is the only link from a possibly funded contract back to Pactly. Freeing the slot while keeping the row trades a rare double-sale (logged loudly) for never losing track of money.
- **Why retry reuses the stored deploy XDR.** Story 2.6 made `lockDeposit` write-once, so a landed deploy can never be orphaned. A declined signature must still be retryable within the hold, so the unsigned deploy XDR is stored with the booking and returned again. A rebuild happens only after chain evidence (via `listEscrows`) shows the old contract does not exist. This is the abandoned-deploy recovery that 2.6 left to Epic 3.
- **Local currency deferred.** PRD 3.4 AC4 and AC6 depend on Story 2.4 (SEP-6 deposit), which is in backlog behind the hackathon's frontend-first order. The UI states it plainly rather than hiding the option.

## Verification

**Commands:**
- `npm run -w backend typecheck && npm run -w backend test && npm run -w backend build` -- expected: clean, all pass
- `npm run -w frontend typecheck && npm run -w frontend build` -- expected: clean

**Manual checks:**
- Two browser sessions hold the same slot → the second sees "slot taken" with the day's other slots.
- A full lock on testnet with a funded Freighter wallet → seal appears only after reconciliation; the explorer link opens the contract. (Needs the user's wallet; performed by the user.)
