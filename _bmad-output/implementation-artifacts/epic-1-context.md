# Epic 1 Context: Foundation and Escrow Contract

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Stand up the project skeleton and get the escrow logic working on chain. By the end of this epic, a deposit can be locked, released, refunded and transferred, and every one of those paths is proven by unit tests. This is the foundation the whole product rests on: the contract — not the backend, not the platform — is the authority on money state, so everything built later mirrors what happens here.

## Stories

- Story 1.1: Monorepo skeleton and development environment
- Story 1.2: Escrow contract data model and initialize
- Story 1.3: Locking the deposit (create_booking)
- Story 1.4: Releasing the deposit (release)
- Story 1.5: Resolving a cancellation (resolve_cancel)
- Story 1.6: Contract unit tests
- Story 1.7: Testnet setup scripts

## Requirements & Constraints

- The locked deposit must reach neither the platform nor the counterparty while it is in escrow. The contract holds it.
- A booking's outcome is decided by comparing the ledger timestamp with a cancellation deadline: refund to the client before it, transfer to the professional after it.
- Every state transition emits an event. Those events are the only way the rest of the system learns about money state, so they must carry the booking id and the amount.
- Amounts are `i128` and integer-overflow checks stay explicit. No floating point, anywhere.
- Amounts live in the asset's smallest unit (7 decimals for USDC). Nothing in this layer formats or converts currency, and no currency is hard-coded — the asset arrives as a token address.
- Unit tests are mandatory for: lock + release, on-time cancellation (refund), no-show (transfer), and the error paths (duplicate booking, invalid amount, illegal state transition). `cargo test` must pass.
- The whole flow targets Stellar testnet. Setup must be reproducible with one command so demo day loses no time to environment work.
- All identifiers, comments, documentation and commit messages are English.

## Technical Decisions

- **Monorepo layout:** `contracts/escrow/` (Rust), `backend/` (Node.js + TypeScript), `frontend/` (React + TypeScript + Vite), `scripts/` (testnet funding, trustlines, deployment, seed data).
- **Pinned versions:** soroban-sdk 27.0.6, Node.js 22 LTS, TypeScript 5.x, Hono 4.13.8, Drizzle ORM 0.45.2, better-sqlite3 13.0.3, @stellar/stellar-sdk 17.1.0, React 19.x, Vite 8.3.0, Stellar Wallets Kit 2.6.0, TanStack Query 5.103.0, motion 13.3.0. Avoid deprecated Soroban APIs such as `register_contract`.
- **Authority split:** `release(booking_id)` requires the client's `require_auth`; the backend's signing key may never call a deposit function. `resolve_cancel(booking_id)` is permissionless — its outcome is decided solely by the deadline comparison, so a no-show never leaves the professional stranded.
- **Booking identity:** `booking_id` is generated off-chain (ULID) and written on chain as `BytesN<16>`. The contract never generates ids.
- **Booking record:** professional, client, token, amount, cancel_deadline, state. States are Locked / Released / Refunded, stored in persistent storage.
- **Errors:** declared as contracterror variants — `AlreadyInitialized`, `BookingExists`, `BookingNotFound`, `InvalidAmount`, `InvalidState`.
- **Naming:** contract functions and events are `snake_case`; TypeScript is `camelCase` with `PascalCase` types; file names are `kebab-case`.
- **Time:** the contract compares ledger timestamps in UTC epoch seconds. Everything downstream stores the same unit.
- **Secrets:** keys and contract ids live in `.env`, never in the repository. Script output must be shaped so it can be written straight into `.env`.

## Cross-Story Dependencies

- Story 1.2 defines the data model every later contract story builds on; 1.3–1.5 extend it and must not redefine it.
- Story 1.6 tests the behaviour of 1.3–1.5 and should follow them.
- Story 1.7 needs a deployable contract, so it lands after 1.3–1.5 compile.
- Epic 2 (backend, SEP flows) consumes the events defined here; changing an event's name or payload after this epic breaks the event worker.
- The backend generates `booking_id` and holds a slot before calling the contract, so the contract must accept an externally supplied id.
