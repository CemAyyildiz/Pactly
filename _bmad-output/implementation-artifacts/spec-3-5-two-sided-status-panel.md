---
title: 'Story 3.5 — Two-sided status panel'
type: 'feature'
created: '2026-09-19'
status: 'in-progress'
review_loop_iteration: 0
baseline_revision: 'be4f6067129a58d731b3814522b55e37f8f54ac8'
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-3-4-client-booking-flow.md'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-Pactly-2026-09-15/DESIGN.md'
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** After Story 3.4, a client can lock a deposit, but neither side can later see their bookings or the deposit's state. The demo's "follow what is happening" moment is missing.

**Approach:** Add two wallet-authenticated list routes: the client's own bookings across providers, and the provider's incoming bookings. Build "My bookings" (mobile-first cards) and the provider panel's "Bookings" view (desktop table, cards on mobile). Each shows the escrow state and the balance state separately, the lifecycle label, a free-cancellation countdown and an explorer link.

## Boundaries & Constraints

**Always:**
- The two state fields are always shown separately and never merged (AD-3): the deposit state comes from `escrow_state` plus `getEscrowLifecycle`, and the balance state from `balance_state`. State is never shown by colour alone (AC3).
- Lifecycle label mapping, from the latest recorded action:
  - hold active with no action: "Waiting for your lock";
  - `funded`: "Funded";
  - `approved`: "Ready to release";
  - `disputed`: "In resolution";
  - `released`: "Released";
  - `resolved`: "Resolved" plus the outcome in words ("Refunded to you" / "Paid to the provider").
  An expired, never-funded hold is listed under "Expired holds" (collapsed), never as a booking.
- The countdown runs to `cancelDeadline` ("Free cancellation · 2d 19h"). It turns `alert` under 6 hours, and after the deadline reads "Window closed" with the policy consequence, without claiming any automatic money movement. It uses `aria-live="polite"` with no more than one announcement per minute.
- The explorer link (AC4) goes to the testnet contract page for `contractId`, labelled "View on Stellar Expert", and appears only when a `contractId` exists.
- The client list is ordered by appointment date (the upcoming ones first, then the past ones), across all providers (AC2). The provider list is ordered by appointment date.
- Only the caller's own rows are returned: a client sees bookings where they are the client wallet, a provider sees bookings for their own profile. Other wallets' data never appears.

**Never:**
- No actions (cancel, approve, release, dispute, mark cash). Those are Stories 3.6 and 3.7. Buttons for them are not rendered yet.
- No changes to escrow, reconciler or booking-state writers.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Client list | `GET /me/bookings` with a JWT | Own bookings: id, provider summary, slotStartsAt, amounts, escrowState, lifecycle action/outcome, balanceState, cancelDeadline, contractId, holdExpiresAt, `isExpiredHold` | No token: `401` |
| Provider list | `GET /me/provider/bookings` with a JWT | Bookings for the caller's profile, same shape plus the client wallet shortened | Not a provider: `404 NOT_A_PROVIDER` |
| Isolation | Another client's bookings exist | Never included | No error expected |
| Empty | A wallet with no bookings | "No bookings yet." plus a primary action into Discover | No error expected |
| Resolved | Latest action `resolved` with outcome `refund-client` | Label "Resolved · Refunded to you" (client) / "Resolved · Refunded to the client" (provider) | No error expected |
| Window closed | Now > `cancelDeadline` | Alert border, "Window closed" plus the policy consequence; no claim that money moved | No error expected |

</intent-contract>

## Code Map

- `backend/src/services/booking.ts` (as 3.4 leaves it) -- `getBookingForClient`, the owner check, and hold-expiry semantics. Build the list functions next to them and reuse the single-booking view shape.
- `backend/src/escrow/trustless-work/reconciler.ts` -- `getEscrowLifecycle(db, bookingId)`. For lists, avoid N+1 by reading `escrow_processed_events` and `escrow_dispute_resolutions` for all listed booking ids in one query each, applying the same lifecycle-rank rule.
- `frontend/src/` (3.1 to 3.4) -- wallet sign-in, api hooks, `lib/money.ts`, `lib/time.ts`, `DepositPill`, `EscrowProof`. The panel shell from 3.1 (`/panel/availability`) gets a `/panel/bookings` sibling and nav.

## Tasks & Acceptance

**Execution:**
- `backend/src/services/booking.ts`, `backend/src/db/bookings.ts` -- the two list queries and the batched lifecycle read.
- routes -- `GET /me/bookings` and `GET /me/provider/bookings`.
- `backend/test/` -- a test for every backend matrix row.
- `frontend/src/pages/my-bookings/MyBookingsPage.tsx` -- route `/me/bookings` (top-bar "My bookings"): sign in if needed; card list; empty state.
- `frontend/src/pages/panel/BookingsPage.tsx` -- route `/panel/bookings`: a table at ≥1024px, cards below.
- `frontend/src/components/StateLabel.tsx`, `Countdown.tsx`, `BookingCard.tsx` -- per DESIGN.md (text plus colour, tabular-nums).

**Acceptance Criteria:**
- Given a locked booking from 3.4, when the client opens My bookings and the provider opens Panel → Bookings, then both see it with "Funded", balance "Unpaid · due before the session", a countdown and a working explorer link.
- Given the backend and frontend workspaces, when typecheck, test (backend) and build run, then all are clean.

## Spec Change Log

## Review Triage Log

## Verification

**Commands:**
- `npm run -w backend typecheck && npm run -w backend test && npm run -w backend build` -- expected: clean, all pass
- `npm run -w frontend typecheck && npm run -w frontend build` -- expected: clean
