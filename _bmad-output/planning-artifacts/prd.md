---
title: Pactly — Product Requirements Document
status: final
created: 2026-09-15
updated: 2026-09-17
---

# Pactly — Product Requirements Document

**Product:** A trust-backed booking marketplace for appointment-based services — the deposit is held in escrow
**Event:** Rise In × Stellar Pro Hackathon 2026 — Genesis Track
**Demo scenario:** An online therapy session
**Status:** v1.2

---

## 1. Goals and Background

### Goals

- List every appointment-based service on one platform and let clients find providers there
- Protect appointment-based professionals from revenue lost to no-shows, using a deposit held in escrow
- Remove the risk a client takes when paying up front — "will my money just disappear?"
- Make small cross-border deposits collectable without declined cards, delayed transfers or heavy fees
- Let the professional collect in their local currency without knowing anything about crypto
- Ship a proof of concept that runs end to end on Stellar testnet

### Background

In every appointment-based profession, the product is time. A therapist's 14:00 session, a coach's court hour, a consultant's reserved hour — when the client does not show up, that time cannot be resold. The industry tries to cover the loss with cancellation policies ("cancel less than 24 hours ahead and you will be charged"), but a policy is not a collection mechanism.

When the professional asks for prepayment, the risk moves to the client. Paying a stranger up front takes trust, especially a stranger in another country. As remote work spreads, the two sides are increasingly in different places, and collecting a small deposit becomes disproportionately hard.

Pactly locks the deposit in neutral escrow: it releases to the professional when the appointment happens and resolves according to the cancellation policy when it does not. The payer can use crypto or local currency; the professional is always paid in local currency.

The product does this as a marketplace rather than for one professional at a time. Clients search, compare and book on the platform; a client tracks bookings across different providers in a single panel. Only approved providers are listed, and the quality signals cannot be fabricated: an approved-provider badge, and a count of sessions that actually happened — that is, sessions whose deposit was released.

### Change Log

| Date | Version | Description |
|---|---|---|
| 2026-09-15 | v1.0 | First draft |
| 2026-09-16 | v1.1 | Marketplace decision: discovery, search and filters; curated provider onboarding with admin approval; reviews tied to verified sessions; wallet requested only at payment; the balance paid before the session. Source: UX round (`ux-designs/ux-Pactly-2026-09-15/`) |
| 2026-09-17 | v1.2 | Product goes global: all content, interface copy and documentation in English. The TRY rail stays for the demo; the architecture stays open to additional anchors and currencies. Acceptance criteria traced from the architecture spine (AD-2, AD-6, AD-13, AD-14) |

---

## 2. Requirements

### Functional Requirements

- **FR1:** A professional can define an availability calendar, a session price, a deposit rate and a cancellation policy (deadline).
- **FR2:** A client can pick an available slot and create a booking request; the deposit amount and the cancellation policy are visible before payment.
- **FR3:** The system locks the deposit in a Soroban contract; the locked amount reaches neither the platform nor the other party.
- **FR4:** A client can pay the deposit two ways: (a) with stablecoin from their wallet, (b) with local currency through SEP-6 deposit.
- **FR5:** Once the deposit is locked the slot closes — no other client can take it.
- **FR6:** When the session happens and is confirmed, the locked amount is released to the professional.
- **FR7:** When an appointment does not happen, the outcome depends on who cancelled it. If the professional cancels, the full deposit is refunded to the client, whatever the time. If the client cancels before the cancellation deadline, the full deposit is refunded. If the client cancels after the deadline, or never shows up, the deposit is transferred to the professional.
- **FR8:** A professional can withdraw the released amount in local currency through SEP-6 withdraw.
- **FR9:** Both parties can see the booking and deposit state (locked / released / refunded) from a single panel.
- **FR10:** Authentication happens through a wallet signature (SEP-10); there are no passwords and no sign-up forms.
- **FR11:** The contract emits an event on every state transition (locked, released, refunded).

**Marketplace (v1.1)**

- **FR12:** A client can browse approved providers on a category-based discovery page; each card shows the price, the deposit amount, the free-cancellation window and the earliest available slots.
- **FR13:** A client can search by provider, service or category; search offers autocomplete and, when a query returns nothing, suggests alternatives.
- **FR14:** Results can be filtered by session format, price range, deposit rate and availability.
- **FR15:** Discovery, search, profile viewing and price comparison require no sign-in; the wallet is requested only when the deposit is paid.
- **FR16:** Every provider has a shareable profile address; a client arriving from discovery and a client arriving from a shared link reach the same page.
- **FR17:** A client can see every booking they hold across different providers, with deposit states, in a single panel.
- **FR18:** A professional can apply to the platform; their profile is not listed on the marketplace until an administrator approves the application.
- **FR19:** An administrator can list pending applications and approve or reject them; the decision is communicated to the applicant.
- **FR20:** A provider profile shows a "verified sessions" count; the count increases only for bookings whose deposit was released.
- **FR21:** A review can only be written by the client of a booking whose deposit was released.
- **FR22:** The part of the session price beyond the deposit — the balance — is paid before the session; the client can pay it off-platform (in person) or through Pactly. The booking carries the balance payment state.
- **FR23:** A professional's own cancellations are counted and shown on their profile beside the verified-session count. The platform applies no monetary penalty for them.

### Non-Functional Requirements

- **NFR1:** The whole flow runs on Stellar testnet (mainnet is a bonus).
- **NFR2:** Anchor integration follows the SEP standards; moving to mainnet changes only the home domain and the network passphrase.
- **NFR3:** Deposit amounts stay inside anchor limits (min 50 TRY, max 3000 TRY per transaction).
- **NFR4:** The product is only the booking and payment layer; session content, notes, video calls and health data are out of scope.
- **NFR5:** The contract has explicit integer-overflow checks; amounts are held as `i128`.
- **NFR6:** The demo can be shown end to end in five minutes or less.
- **NFR7:** The product is vertical-agnostic; interface copy is never written for a single profession. Therapy is only the demo scenario.
- **NFR8:** The interface follows `ux-designs/ux-Pactly-2026-09-15/DESIGN.md` and `EXPERIENCE.md`. Where they disagree with a mockup, the documents win.
- **NFR9:** Users are never shown implementation vocabulary (escrow internals, Soroban, trustline, SEP-6, hash). As proof of trust the interface may name Stellar, the wallet, the transaction and the contract.
- **NFR10:** The interface is responsive: the client flow is mobile-first (from 375px up), the provider panel is desktop-first. Breakpoints 375 · 768 · 1024 · 1440.
- **NFR11:** All product content, interface copy, documentation, code identifiers and commit messages are in English. The product is built for a global audience from the start.
- **NFR12:** Currency is not hard-coded. The demo runs on the TRY rail the hackathon anchor provides, but no module assumes TRY; the local-currency leg is a property of the configured anchor.

---

## 3. Technical Assumptions

### Repository Layout
Monorepo:
```
contracts/escrow/   → Soroban (Rust) escrow contract
backend/            → Node.js + TypeScript, SEP integrations
frontend/           → React + TypeScript + Vite
scripts/            → testnet account funding, trustline setup
```

### Service Architecture
The escrow logic lives on chain (Soroban contract). The backend runs the SEP-10 auth, SEP-6 deposit/withdraw and SEP-38 quote flows and wraps the contract calls. The frontend is only presentation and wallet signing.

### Anchor Configuration (provided by the hackathon)

| Field | Value |
|---|---|
| Home domain | `tr-mock-anchor.fly.dev` |
| Asset | USDC |
| Network | Stellar testnet (Test SDF Network ; September 2015) |
| SEP surface | SEP-1, SEP-10, SEP-6, SEP-12, SEP-38 — **no SEP-24** |
| Limits / fee | min 50 TRY · max 3000 TRY per transaction · 0.5% spread |
| Identity | SEP-10 wallet signature (no API key, no registration) |
| Discovery | Endpoints are read from `stellar.toml` |

### Asset Decision: USDC vs USDT0

The MVP is built on the **USDC + SEP-6** rail that works on testnet. USDT0 is live on mainnet (LayerZero OFT) but is not on the hackathon's list of eligible integration partners and has no testnet registration — so it is positioned as a **vision/roadmap layer**, not a required integration.

### Test Requirements
Unit tests are mandatory for the contract: lock+release, on-time cancellation (refund), no-show (transfer to the professional). Integration tests for the backend's SEP flows.

### Additional Technical Notes
- Use a current Soroban SDK release; avoid deprecated APIs such as `register_contract`.
- The wallet's XLM balance and USDC trustline must be set up in the first step of the flow; otherwise the anchor waits in `pending_trust`.
- Submission requirement: the skill files used must be listed with their paths in the README.

### Data Model Additions (v1.1)

The marketplace decision brings four new concepts to the backend:

| Concept | Contents |
|---|---|
| Category | Name, slug, parent category. Initial set: therapy and wellbeing, education and lessons, consulting, fitness and beauty |
| Provider application | Application details, state (pending / approved / rejected), decision date and decision maker |
| Provider profile | Category, bio, languages, session format, price, deposit rate, cancellation window, verified-session counter |
| Review | Rating and comment bound to a booking; can only exist for a booking in the `Released` state |

The verified-session counter increases by listening to the contract's `released` event; it cannot be written by hand.

### UX Sources

Interface decisions were made during the UX round and live in:

- `ux-designs/ux-Pactly-2026-09-15/DESIGN.md` — visual system, colour rule, typography, components
- `ux-designs/ux-Pactly-2026-09-15/EXPERIENCE.md` — information architecture, states, copy rules, flows
- `ux-designs/ux-Pactly-2026-09-15/mockups/` — discovery and booking screen references

---

## 4. Epic List

- **Epic 1 — Foundation and Escrow Contract:** Monorepo skeleton, the Soroban escrow contract and its tests, testnet setup scripts.
- **Epic 2 — Anchor Integration and Payment Rail:** SEP-10 auth, SEP-6 deposit/withdraw, SEP-38 quotes; the backend service layer.
- **Epic 3 — Marketplace and Booking Flow:** Provider profile, discovery page, search and filters, client booking, payment and the two-sided panel.
- **Epic 4 — Provider Onboarding and Trust:** Provider application, admin approval, verified-session counter and reviews.

---

## Epic 1 — Foundation and Escrow Contract

**Goal:** Stand up the skeleton of the project and get the escrow logic working on chain. By the end of this epic, locking and resolving a deposit is verified by tests.

### Story 1.1 — Monorepo skeleton and development environment

As a developer, I want to install and run the project with a single command, so the team can start building quickly.

**Acceptance Criteria**
1. The `contracts/`, `backend/`, `frontend/` and `scripts/` directories exist.
2. A root README documents installation, build and run steps.
3. Rust toolchain and Node version requirements are documented.
4. `.gitignore` is configured appropriately for all three sub-projects.

### Story 1.2 — Escrow contract data model and initialize

As a developer, I need a contract skeleton that holds booking data on chain, so the escrow logic can be built on top of it.

**Acceptance Criteria**
1. The `Booking` struct carries: professional, client, token, amount, cancel_deadline, state.
2. The `BookingState` enum carries Locked / Released / Refunded.
3. `initialize(admin)` can be called only once; a second call returns `AlreadyInitialized`.
4. Error types are defined as contracterror.

### Story 1.3 — Locking the deposit (create_booking)

As a client, I want my deposit locked somewhere neutral when I book, so my money is safe without going straight to the professional.

**Acceptance Criteria**
1. `create_booking(booking_id, professional, client, token, amount, cancel_deadline)` requires the client's authorization (`require_auth`).
2. The amount is pulled from the client through the token contract and transferred to the contract address.
3. `amount <= 0` returns `InvalidAmount`.
4. A second call with the same `booking_id` returns `BookingExists`.
5. The record is written to persistent storage in the `Locked` state.
6. A `locked` event is emitted with the booking_id and the amount.

### Story 1.4 — Releasing the deposit (release)

As a professional, I want the deposit to reach me once the session has happened, so I am paid for my work.

**Acceptance Criteria**
1. `release(booking_id)` works only on records in the `Locked` state; otherwise it returns `InvalidState`.
1a. `release` requires the client's authorization (`require_auth`); a call from any other account is rejected (AD-2).
1b. The cancellation paths are specified in Story 1.5; each is authorized by the party it serves, and none of them is `release` (AD-2).
2. The locked amount is transferred from the contract address to the professional's address.
3. The record moves to the `Released` state.
4. A `released` event is emitted.
5. An unknown booking_id returns `BookingNotFound`.

### Story 1.5 — Cancelling and settling a booking

As a client I want my money back when I cancel in time or when the professional cancels on me; as a professional I want the deposit when the client does not show up.

**Acceptance Criteria**
1. `cancel_by_professional(booking_id)` requires the professional's `require_auth`; it refunds the full amount to the client whatever the ledger timestamp, sets `Refunded` and emits `cancelled`.
2. `cancel_by_client(booking_id)` requires the client's `require_auth`. If `now <= cancel_deadline` it refunds the client, sets `Refunded` and emits `refunded`. If `now > cancel_deadline` it transfers to the professional, sets `Released` and emits `forfeited`.
3. `claim_no_show(booking_id)` requires the professional's `require_auth` and is rejected while `now <= cancel_deadline`; after it, it transfers to the professional, sets `Released` and emits `forfeited`.
4. All three work only in the `Locked` state; `Released` and `Refunded` stay terminal.
5. No path is callable without one of the two parties' authorization, and the backend's signing key calls none of them.
6. `released` is emitted by `release` alone, so a no-show can never be counted as a held session.

### Story 1.6 — Contract unit tests

As a developer, I want the escrow logic proven by tests, so demo day holds no surprises.

**Acceptance Criteria**
1. The lock + release scenario is tested; the professional's balance increases.
2. The on-time cancellation scenario is tested; the client's balance returns in full.
3. The no-show scenario is tested (deadline passed); the amount goes to the professional.
4. Error paths are tested: duplicate booking, invalid amount, illegal state transition.
5. All tests pass with `cargo test`.
6. The professional-cancels scenario is tested: the client's balance returns in full, before and after the deadline alike.
7. The late client cancellation and the no-show claim are tested; both pay the professional and emit `forfeited`.
8. Every settlement path is tested for rejection when the wrong party signs, and when nobody signs.

### Story 1.7 — Testnet setup scripts

As a developer, I want to prepare testnet accounts and trustlines with one command, so setup does not eat into demo time.

**Acceptance Criteria**
1. The script funds test accounts through friendbot.
2. The USDC trustline is established automatically.
3. The contract is deployed to testnet and the contract ID is printed.
4. The script output is in a form that can be written to a `.env` file.

---

## Epic 2 — Anchor Integration and Payment Rail

**Goal:** Build the local-currency leg. By the end of this epic the professional can withdraw the deposit as local currency through a real SEP-6 flow.

### Story 2.1 — SEP-1 discovery and SEP-10 authentication

As a user, I want to sign in with my wallet, so I can use the platform without a password or a sign-up form.

**Acceptance Criteria**
1. `stellar.toml` is read from the home domain and the endpoints are discovered from it (never hard-coded).
2. A SEP-10 challenge is fetched, signed with the wallet and exchanged for a JWT.
3. The JWT is stored on the backend and used in subsequent SEP calls.
4. An invalid signature produces a meaningful error message.

### Story 2.2 — SEP-38 quote

As a user, I want to see the current local-currency equivalent before I pay, so I know what I am spending.

**Acceptance Criteria**
1. The USDC ↔ TRY price can be fetched through SEP-38.
2. The quote is shown to the user on the payment screen.
3. The displayed amount accounts for the 0.5% spread.

### Story 2.3 — SEP-6 withdraw (professional cashing out)

As a professional, I want to withdraw the released deposit as local currency, so I never have to handle crypto.

**Acceptance Criteria**
1. The SEP-12 KYC flow is triggered (simulated and auto-approved on the mock anchor).
2. SEP-6 withdraw is started; the destination address and memo come from the anchor.
3. USDC plus the memo is sent to the anchor.
4. Transaction status (`pending_user_transfer_start` → `completed`) is tracked and shown to the user.
5. Amounts outside the limits (>3000 TRY) produce a meaningful error.

### Story 2.4 — SEP-6 deposit (client paying in local currency)

As a client, I want to pay the deposit in local currency without touching crypto.

**Acceptance Criteria**
1. SEP-6 deposit is started; bank details and a reference come from the anchor.
2. When the mock payment completes, USDC reaches the wallet.
3. The incoming USDC locks the deposit in the contract.
4. A missing trustline is established automatically; the user is never shown the term (AD-11).
5. If the client has no wallet, the backend opens a managed Stellar account on their behalf; the deposit lands there and the escrow is locked from it (AD-6).
6. When a deposit locked from a managed account is refunded, the backend starts a SEP-6 withdraw for that user on the `refunded` event; money is never left stranded in the managed account (AD-14).
7. The managed account's key is used for exactly two jobs: locking the deposit and paying a refund out in local currency.

### Story 2.5 — Backend service layer and data model

As a developer, I need a backend that holds booking and user data, so the frontend talks to a single API.

**Acceptance Criteria**
1. The provider profile (availability, price, deposit rate, cancellation policy) is stored.
1a. Marketplace concepts are stored: category, provider application and its state, verified-session counter, review (see §3 Data Model Additions).
2. Booking records are matched with the on-chain booking_id.
3. Contract calls (create/release/resolve) can be made from the service layer.
4. Contract events are consumed and the booking state is updated.

---

## Epic 3 — Marketplace and Booking Flow

**Goal:** A user experience that can be demonstrated end to end. By the end of this epic a client can find a provider on the marketplace and complete the therapy scenario from start to finish.

### Story 3.1 — Provider profile and availability

As a professional, I want to define my working hours and deposit rules, so clients can book me.

**Acceptance Criteria**
1. Session price, deposit rate (%) and cancellation deadline (hours) can be entered.
2. Available hours can be marked on a calendar.
3. Once saved, the profile is visible on the client side.

### Story 3.2 — Discovery page and categories

As a client, I want to browse providers by category, so I can find someone who fits what I need.

**Acceptance Criteria**
1. Only approved providers are listed.
2. Category tabs work; the selection is written to the URL and the back button behaves correctly.
3. A provider card shows: name, title, session format and length, approved badge, verified-session count, session price, deposit amount, free-cancellation window and the three earliest available slots.
4. Clicking a slot on a card opens the provider profile with that slot pre-selected.
5. Card skeletons are shown on first load.
6. The page can be viewed without signing in.

### Story 3.3 — Search and filters

As a client, I want to type what I am looking for and narrow the results.

**Acceptance Criteria**
1. Search covers provider name, service and category.
2. Autocomplete shows suggestions after a 250 ms debounce, each with its result count.
3. Filters can be applied: session format, price range, deposit rate, availability.
4. A filter change updates results without a page reload.
5. An empty result set never shows a blank screen; the query is echoed back with at least three alternative suggestions.

### Story 3.4 — Client booking flow

As a client, I want to pick a slot and confirm my booking by paying the deposit.

**Acceptance Criteria**
1. Available slots are listed; taken slots cannot be selected and do not take focus.
2. After selection, the deposit amount, the total price and the cancellation policy are clearly shown; the deposit amount and the free-cancellation window always appear together.
3. The wallet is requested only at the payment step (Stellar Wallets Kit); no sign-in is asked for earlier.
4. The payment method can be chosen: stablecoin or local currency (SEP-6 deposit).
5. After payment the booking is confirmed and the slot closes.
6. If the deposit falls outside the anchor limits (below 50 TRY, above 3,000 TRY) the user is warned **before** the payment step.
7. If the chosen slot is taken by someone else meanwhile, a clear message and the other slots of the same day are shown.
8. At the payment step the backend opens a hold: it generates the `booking_id`, blocks the slot for 10 minutes and writes the booking in the `pending_lock` state (AD-13).
9. The chain is only ever called with the `booking_id` the backend issued.
10. If the hold expires unsigned, the record is dropped and the slot returns to sale; the remaining time is shown to the user.

### Story 3.5 — Two-sided status panel

As a user, I want to see the state of my booking and my deposit, so I can follow what is happening.

**Acceptance Criteria**
1. The professional can list incoming bookings and their deposit states.
2. The client can see every booking they hold across providers in one list, ordered by date.
3. States are shown clearly: locked / released / refunded / transferred. State is never conveyed by colour alone.
4. The on-chain transaction can be verified through an explorer link.
5. The time left in the free-cancellation window is shown as a countdown.

### Story 3.6 — Session confirmation and cancellation

As a user, I want to confirm a session that happened, or cancel when I need to.

**Acceptance Criteria**
1. After the session the client can confirm it happened; this calls `release`.
2. The client can cancel; this calls `cancel_by_client`.
3. Before cancelling, the outcome implied by the deadline is shown to the user.
4. The result is reflected in the panel.
5. The professional can cancel a booking from the provider panel; the client is refunded in full and told the professional cancelled.
6. Before either party confirms a cancellation, the outcome implied by their role and the deadline is stated in words.

### Story 3.7 — Paying the balance before the session

As a client I want to pay the rest of the session price before the session; as a professional I want to see that it was paid.

**Acceptance Criteria**
1. The booking record carries the balance amount and its payment state (unpaid / paid through Pactly / paid in person).
2. The client can pay the balance through Pactly.
3. The professional can mark a balance received in person.
4. Both panels show the balance state.
5. The interface states clearly that the balance is paid before the session.

### Story 3.8 — Demo preparation and documentation

As a team, we want a demo we can show end to end in five minutes.

**Acceptance Criteria**
1. The README covers the product, installation, running and an architecture summary.
2. A mermaid architecture diagram is included.
3. The skill files used are listed with their paths.
4. The demo scenario is written step by step (therapy session).
5. At least one full flow (lock → release → cash out) works on testnet.
6. At least six approved sample providers across at least two categories are seeded for the marketplace demo.

---

## Epic 4 — Provider Onboarding and Trust

**Goal:** Build the marketplace's quality layer. By the end of this epic only approved providers are listed and the trust signals rest on data that cannot be fabricated.

**Priority note:** Stories 4.1–4.3 are in the MVP. Story 4.4 is done if time remains; the demo is complete without it.

### Story 4.1 — Provider application flow

As a professional, I want to apply to the platform, so I can sell my service here.

**Acceptance Criteria**
1. The application form collects: name, title, category, service description, session format and length, session price, deposit rate, cancellation window.
2. A saved application starts in the `pending` state.
3. The applicant is taken to a page showing the application state.
4. An unapproved profile appears in neither marketplace listings nor search.
5. While approval is pending the provider panel opens read-only with a banner stating the state.

### Story 4.2 — Admin approval queue

As an administrator, I want to review pending applications and decide on them.

**Acceptance Criteria**
1. Pending applications can be listed.
2. An application can be approved, or rejected with a reason.
3. An approved profile becomes visible on the marketplace immediately and the "approved provider" badge activates.
4. The decision is communicated to the applicant.
5. Only an authorised account can reach the screen.

### Story 4.3 — Verified-session counter

As a client, I want to see how many sessions a provider has actually held, so I do not have to trust invented references.

**Acceptance Criteria**
1. The counter increases only on the contract's `released` event.
2. The counter cannot be written by hand.
3. The number is shown as "verified sessions" on the provider card and profile.
4. Cancelled or refunded bookings do not increase the counter; a no-show emits `forfeited`, not `released`, so it never reaches it either.
5. The professional's own cancellation count is shown beside the verified-session count; it increases only on the contract's `cancelled` event.

### Story 4.4 — Reviews

As a client, I want to review the provider I met with.

**Acceptance Criteria**
1. A review can only be written by the client of a booking whose deposit was released.
2. At most one review per booking.
3. The rating and comment are shown on the provider profile.
4. The booking a review belongs to is verifiable.
