# Epic 2 Context: Anchor Integration and Payment Rail

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Build the local-currency leg and the escrow integration boundary. By the end of this epic a user can authenticate with a wallet signature, see a live USDC↔local-currency quote, fund a Trustless Work escrow, and cash out a released deposit in local currency. The backend mirrors Trustless Work/chain evidence and holds everything the escrow does not, so Epic 3 has a single Pactly API.

## Stories

- Story 2.1: SEP-1 discovery and SEP-10 authentication
- Story 2.2: SEP-38 quote
- Story 2.3: SEP-6 withdraw (professional cashing out)
- Story 2.4: SEP-6 deposit (client paying in local currency)
- Story 2.5: Backend service layer and data model
- Story 2.6: Trustless Work escrow adapter and reconciliation

## Requirements & Constraints

- Authentication is a wallet signature only — no passwords, no sign-up forms. Discovery, search, profile viewing and price comparison need no sign-in; a wallet is requested only at the payment step.
- A client can pay the deposit two ways: stablecoin from their own wallet, or local currency through an SEP-6 deposit. A professional withdraws a released deposit as local currency through SEP-6; they never have to handle crypto.
- Anchor integration follows SEP standards so moving to mainnet changes only the home domain and the network passphrase. All SEP endpoints are discovered from `stellar.toml`, never hard-coded, and the local-currency asset is a property of the resolved anchor, not a constant in code.
- The demo anchor (`tr-mock-anchor.fly.dev`) exposes SEP-1, SEP-10, SEP-6, SEP-12, SEP-38 — explicitly no SEP-24 — on USDC/testnet, with limits of 50–3000 TRY per transaction and a 0.5% spread; identity is SEP-10 only.
- Deposit amounts must stay inside the anchor's limits; a request outside them fails with a meaningful, user-presentable error, not a raw anchor error.
- Implementation vocabulary never reaches the user (no "Soroban", "trustline", "SEP-6", "ledger", "hash"; "Stellar", "wallet", "transaction", "contract" are fine). API errors follow a fixed envelope: `code`, a user-facing `message`, raw detail only in `details`/logs.
- Amounts are integers in the asset's smallest unit end to end (no floats); the API carries them as strings.
- Both parties need a live USDC trustline before a booking exists — the client before locking a deposit, the professional before their application is approved — because every settlement path can pay either party and a missing trustline would strand the deposit permanently. Epic 2's deposit/withdraw flows must respect this, not paper over it.
- Trustless Work appointment compatibility is not yet proven end to end. Story 1.8 gates the runtime role map and supported claims; Story 2.6 implements the approved adapter after that decision.

## Technical Decisions

- **Two identities.** Pactly issues its own challenge and JWT; that token alone authorizes Pactly API calls. The anchor's SEP-10 JWT is a separate credential, used only for SEP-6/12/38 calls, stored on the backend, and never handed to the frontend.
- **Managed accounts for local-currency payers.** When a client has no wallet, the backend opens a managed Stellar account on their behalf; the SEP-6 deposit lands there and the escrow lock is signed from it. That key is used for exactly two jobs — locking the deposit and paying a refund back out in local currency — never anything else. When a deposit locked from a managed account is later refunded, the backend automatically starts a SEP-6 withdraw for that user on the `refunded` event so money is never stranded there.
- **One escrow boundary.** Services depend on a vendor-neutral escrow interface. Trustless Work REST, indexer, unsigned-XDR and direct chain reads live only under `backend/src/escrow/trustless-work/`.
- **Cursored, idempotent reconciliation.** The reconciler persists its Trustless Work indexer/ledger cursor and dedupes by transaction hash plus lifecycle action.
- **Runtime surface this epic consumes:** initialize, fund, change appointment status, approve, release, dispute, resolve and read/reconcile operations from the version pinned by Story 1.8.
- **Money state is chain-derived only.** A booking's `escrow_state` is written only after Trustless Work/chain evidence is reconciled; on conflict the chain wins. This remains separate from backend-owned `balance_state`.
- **Structural seed:** `backend/src/config.ts` (env vars validated once, process refuses to start if one is missing), `backend/src/routes/` (+ authorization middleware), `backend/src/services/` (booking/profile/application/review logic — routes never write to the DB directly), `backend/src/chain/` (contract client + event worker), `backend/src/anchor/` (SEP-1/10/6/12/38 client), `backend/src/db/` (Drizzle schema and migrations).
- **Stack pins relevant here:** Hono 4.13.8, Drizzle ORM 0.45.2, better-sqlite3 13.0.3, @stellar/stellar-sdk 17.1.0, Node.js 22 LTS, TypeScript 5.x.

## UX & Interaction Patterns

- The wallet-signature moment reads as approval, not a technical step: a disabled button says "Approve it in your wallet," with "Open wallet again" appearing after 60 seconds. A rejected signature is neutral information ("You didn't sign. The slot is still yours for 10 minutes."), not an error.
- A missing trustline is handled silently under "Getting your wallet ready"; an extra approval, if needed, is one plain sentence — the word "trustline" is never shown.
- An amount outside the anchor's limits is caught and explained **before** the payment step, with the other payment method offered as an alternative.
- A dropped connection during payment reads "Connection dropped. Your deposit is untouched," with a retry action.
- The SEP-38 quote is shown on the payment screen with the anchor's spread already reflected in the displayed amount, not as a separate fee line.

## Cross-Story Dependencies

- Story 2.5's data model and service-layer conventions remain the base. Story 2.6 replaces the custom chain implementation behind the escrow interface after Story 1.8's go/no-go result.
- Story 2.1's SEP-10 JWT is a precondition for 2.3 and 2.4, which both act under an authenticated anchor session (KYC, deposit, withdraw).
- Story 2.2's quote feeds the amount shown in Story 2.4's payment flow and, later, Epic 3's booking/payment screen.
- Story 2.4's managed-account creation is what makes AD-14's automatic-refund-withdraw reachable; that rule fires off the event worker (Story 2.5) recognizing a `refunded` event, so the worker must exist first.
- The reconciler built here is what Epic 4 uses for verified sessions. Provider cancellation remains backend-derived unless Story 1.8 finds a distinct verifiable Trustless Work transition.
- The trustline precondition lands in two epics: the client's trustline at booking creation (this epic's deposit flow touches it directly), the professional's at provider approval (Epic 4) — Story 2.3's withdraw flow assumes the professional side is already satisfied.
