# Epic 3 Context: Marketplace and Booking Flow

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Deliver the end-to-end demoable experience: a client finds a provider on the marketplace and completes the whole scenario — discover, pick a slot, lock a deposit through Trustless Work, track its state, reach completion/release or resolution, and settle the balance — without ever being asked for a wallet before the payment step.

## Stories

- Story 3.1: Provider profile and availability
- Story 3.2: Discovery page and categories
- Story 3.3: Search and filters
- Story 3.4: Client booking flow (Lock with Pactly)
- Story 3.5: Two-sided status panel
- Story 3.6: Appointment completion, release and resolution
- Story 3.7: Paying the balance before the session
- Story 3.8: Demo preparation and documentation

## Requirements & Constraints

- No sign-in for discovery, search, filters, profile viewing or price comparison; the wallet is requested only at payment (Stellar Wallets Kit).
- Only approved providers appear in discovery/search. Category selection is written to the URL; back button works correctly.
- A provider card/profile always shows deposit amount and free-cancellation window together, plus price and the three earliest open slots.
- Search covers name/service/category; autocomplete after a 250ms debounce with a result count per suggestion. Filters (format, price range, deposit rate, availability) apply without a page reload. An empty result set echoes the query with at least three alternatives — never a blank screen.
- Taken slots are never selectable and never take keyboard focus.
- Before payment: deposit, total price and cancellation policy are shown together; a deposit outside anchor limits (below 50 TRY / above 3,000 TRY) is flagged before the payment step.
- Payment method is stablecoin (own wallet) or local currency (SEP-6 deposit via a managed account, no wallet needed).
- The primary booking action is always labeled "Lock with Pactly" — the only black button in the product, the only action that commits money. Confirmation depends on reconciled Trustless Work funding evidence, never on request submission alone.
- A slot hold precedes any chain call: backend issues the `booking_id`, blocks the slot 10 minutes, writes `pending_lock`; chain calls only ever use this id. An expired unsigned hold returns the slot to sale (remaining time shown). A slot taken meanwhile shows a clear message plus that day's other slots.
- Two independent states are always shown separately, never merged: `escrow_state` (locked/released/refunded/transferred, chain-derived) and `balance_state` (unpaid/paid via Pactly/paid in person, backend-derived). State is never colour-only. Bookings link to an explorer for on-chain verification; a free-cancellation countdown is shown (alert colour under 6h).
- Appointment lifecycle advances only through explicit, role-correct Trustless Work actions (provider completes, approver approves, release signer releases); either side may open the supported dispute flow before release; the dispute resolver executes the allocation. Nothing here is automatic, and nothing is shown as settled without chain evidence. Before opening a dispute, Pactly states the policy-implied outcome in words, clearly separated from what the chain actually enforces.
- The balance (price minus deposit) is paid before the session, in person or through Pactly; both panels show its state.
- No implementation vocabulary reaches users (no Soroban/trustline/SEP-6/milestone/hash/smart contract); Stellar, Trustless Work, USDC, wallet, transaction and contract are fine. Booking surfaces state "Escrow powered by Trustless Work on Stellar" with a verifiable link.
- Amounts are integer strings in smallest units end to end (no floating point), shown with `tabular-nums` and a currency code, never a hard-coded symbol.
- Demo: five minutes end to end, ≥6 approved sample providers across ≥2 categories, at least one full lock→release→cash-out flow proven on testnet. Hero scenario: a client abroad locking a meaningful deposit for an in-person hair-transplant consultation in Istanbul; therapy/salon listings show breadth.
- Client flow is mobile-first (375px+); provider panel is desktop-first (table, collapsing to cards on mobile). Breakpoints: 375·768·1024·1440.

## Technical Decisions

- The chain (Trustless Work) is sole authority on escrow money state; the database only mirrors reconciled evidence — no API request alone settles `escrow_state`, and chain wins on conflict. Non-money marketplace data (categories, profiles, applications, availability, reviews) lives only in the database.
- The backend's escrow boundary is `backend/src/escrow/` (Story 2.6, done); it supersedes the old `backend/src/chain/`, which is no longer the runtime path. The low-level adapter (`backend/src/escrow/trustless-work/`) exposes `deploy`/`fund`/`approve`/`release`/`startDispute`/`resolveDispute`, returning unsigned XDR only (never signs or holds keys). Epic 3 should build against the booking-facing service layer in `backend/src/services/booking.ts`: `lockDeposit` (deploys the escrow, persists the returned `contractId`), `fundDeposit`, `resolveBookingDispute`, and `getEscrowLifecycle` — not against the adapter or `chain/` directly.
- Every booking stores its explicit Trustless Work role assignments (funder, service provider, receiver, approver, release signer, platform, dispute resolver); unsigned XDR goes only to the signer holding the requested role.
- A booking carries two independent state fields — `escrow_state` (chain) and `balance_state` (backend) — never merged in any screen or response.
- Auth is a wallet signature (SEP-10) issuing Pactly's own JWT, distinct from the anchor JWT; role model is `client`/`provider`/`admin`, enforced as route middleware.
- API errors use `{ code, message, details? }`; raw chain/anchor text never reaches `message`.
- Automatic appointment-policy enforcement (deadline refunds, no-show forfeiture) is not an established Trustless Work capability — dispute/resolution UI must state policy guidance in words and route real outcomes through the explicit signed dispute path, never claim automatic on-chain enforcement.
- Frontend: `frontend/src/pages/` (discover, provider, booking, my-bookings, panel, admin), `frontend/src/components/`, `frontend/src/wallet/` (Stellar Wallets Kit); data via TanStack Query; motion via Framer Motion. No frontend test infrastructure planned; manual verification is accepted for this epic.

## UX & Interaction Patterns

- "Two Sides" system: mustard marks anything the client can act on; deep teal marks the provider's identity/commitment (never interactive); black is reserved for the escrow lane, deposit pill and "Lock with Pactly" button — no other button is ever black. Deposit pill (black, mustard dot) always states amount + free-cancellation window together. Slot chip: open = mustard; taken = dashed/faded, never struck through, never focusable.
- Booking layout ≥1024px: three lanes (client · escrow · provider); below, stacks with escrow pinned to the bottom bar, always visible. Discovery ≥1024px: filter rail + two-column grid; below, filters move to a bottom sheet, single-column results. Six skeleton cards on first load.
- "Lock with Pactly" reads "Approve it in your wallet" while waiting (an "Open wallet again" option appears after 60s); a rejected signature is shown as neutral info, not a warning. The confirmation "seal" stamps only once funding evidence is reconciled, never on submission (skips straight to final state under `prefers-reduced-motion`). The escrow proof line is always secondary evidence, never a competing CTA.
- Lifecycle state labels: Funded · Appointment completed · Awaiting approval · Ready to release · Released · In resolution · Resolved — text always accompanies colour.
- Copy is second-person, plain, no "successfully" filler; policy outcomes are stated in the interface's own words before any resolution flow opens; a missing trustline hides behind "Getting your wallet ready"; connection failures say the deposit is untouched.
- Balance row pattern: "Balance 1,400.00 TRY · due before the session", three states (unpaid / paid via Pactly / paid in person); provider can mark cash received.
- Accessibility floor: full keyboard nav with visible focus ring, 44×44px touch targets, state never colour-only, `aria-live="polite"` for countdowns/state changes, `aria-disabled` on taken slots.
- Composition references: `mockups/discover-v2-marketplace.html` and `mockups/booking-and-payment.html` — DESIGN.md/EXPERIENCE.md win wherever they disagree with these mockups.

## Cross-Story Dependencies

- All stories depend on Story 2.6's Trustless Work adapter/reconciler under `backend/src/escrow/`; no story should build a competing chain client.
- Story 3.1 must exist before 3.2 can list real providers and before 3.4 has slots to book.
- Story 3.3 extends Story 3.2's list/card components rather than replacing them.
- Story 3.4's slot hold (`pending_lock`, 10-minute expiry, backend-issued `booking_id`) is the entry point Stories 3.5, 3.6 and 3.7 all read from.
- Story 3.6's dispute/resolution copy depends on Story 1.8's go/no-go findings on which cancellation/no-show claims are honestly presentable.
- Story 3.8 depends on Stories 3.1, 3.2, 3.4, 3.5, 3.6 working, plus approved seed providers (Epic 4's admin approval, or pre-approved seed data per the priority note).
- Story 3.7 reuses Epic 2's SEP-6 deposit path as a second, independent payment against the same booking (AD-3), not a variant of the escrow lock.
- Epic 4 (verified sessions, reviews, admin approval) consumes this epic's reconciled state but is not a build prerequisite for it.
