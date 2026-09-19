# Epic 1 Context: Foundation and Escrow Contract

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Stand up the project skeleton and get the escrow logic working on chain. By the end of this epic a deposit can be locked, released, refunded and forfeited, and every one of those paths is proven by unit tests. This is the foundation the whole product rests on: the contract — not the backend, not the platform — is the sole authority on money state, so everything built later mirrors what happens here.

## Stories

- Story 1.1: Monorepo skeleton and development environment
- Story 1.2: Escrow contract data model and initialize
- Story 1.3: Locking the deposit (create_booking)
- Story 1.4: Releasing the deposit (release)
- Story 1.5: Cancelling and settling a booking
- Story 1.6: Contract unit tests
- Story 1.7: Testnet setup scripts

## Requirements & Constraints

- The locked deposit must reach neither the platform nor the counterparty while it is in escrow. The contract holds it.
- When a session does not happen, the outcome depends on **who cancelled**, not on the clock alone. A professional's cancellation refunds the client in full at any time. A client's cancellation refunds them before the cancellation deadline and forfeits the deposit to the professional after it. A no-show forfeits to the professional.
- The clock is a condition inside a signed path, never the decider on its own: it gates when a late client cancellation forfeits and when a no-show may be claimed.
- Every state transition emits an event. Those events are the only way the rest of the system learns about money state, so they must carry the booking id and the amount.
- Event names are load-bearing downstream: the verified-session counter increments on `released` alone, and a provider's cancellation count on `cancelled` alone. A forfeited no-show must therefore never emit `released`.
- Amounts are `i128` and integer-overflow checks stay explicit. No floating point, anywhere.
- Amounts live in the asset's smallest unit (7 decimals for USDC). Nothing in this layer formats or converts currency, and no currency is hard-coded — the asset arrives as a token address.
- Unit tests are mandatory and must cover: lock + release; on-time client cancellation (refund); professional cancellation before and after the deadline (refund both times); late client cancellation and no-show claim (both pay the professional); and the error paths — duplicate booking, invalid amount, illegal state transition, wrong signer on every settlement path, and no signer at all. `cargo test` must pass.
- The whole flow targets Stellar testnet. Setup must be reproducible with one command so demo day loses no time to environment work.
- All identifiers, comments, documentation and commit messages are English.

## Technical Decisions

- **Monorepo layout:** `contracts/escrow/` (Rust), `backend/` (Node.js + TypeScript), `frontend/` (React + TypeScript + Vite), `scripts/` (testnet funding, trustlines, deployment, seed data).
- **Pinned versions:** soroban-sdk 27.0.6, Node.js 22 LTS, TypeScript 5.x, Hono 4.13.8, Drizzle ORM 0.45.2, better-sqlite3 13.0.3, @stellar/stellar-sdk 17.1.0, React 19.x, Vite 8.3.0, Stellar Wallets Kit 2.6.0, TanStack Query 5.103.0, motion 13.3.0. Avoid deprecated Soroban APIs such as `register_contract`.
- **Authority split:** every deposit function is authorized by the party it serves. `release` and `cancel_by_client` require the client's `require_auth`; `cancel_by_professional` and `claim_no_show` require the professional's. No deposit function is permissionless, and the backend's signing key may call none of them.
- **Settlement matrix** (all four events keep the same wire shape — topics `(name, booking_id)`, data `amount`):

  | Function | Signer | Timing | Money to | State | Event |
  |---|---|---|---|---|---|
  | `release` | client | any | professional | `Released` | `released` |
  | `cancel_by_professional` | professional | any | client | `Refunded` | `cancelled` |
  | `cancel_by_client` | client | `now <= cancel_deadline` | client | `Refunded` | `refunded` |
  | `cancel_by_client` | client | `now > cancel_deadline` | professional | `Released` | `forfeited` |
  | `claim_no_show` | professional | `now > cancel_deadline` only | professional | `Released` | `forfeited` |

- **Booking identity:** `booking_id` is generated off-chain (ULID) and written on chain as `BytesN<16>`. The contract never generates ids.
- **Booking record:** professional, client, token, amount, cancel_deadline, state. States are Locked / Released / Refunded, stored in persistent storage; `Released` and `Refunded` are terminal. The *event* carries the reason, the *state* carries the destination — so the settlement model needs no new on-chain state.
- **`cancel_deadline` is the end of the free-cancellation window**, not the session time. Time past it does not mean the session is over, so no path may treat the deadline as proof that a session happened.
- **Errors:** declared as contracterror variants with explicit, stable discriminants — `AlreadyInitialized = 1`, `NotInitialized = 2`, `BookingExists = 3`, `BookingNotFound = 4`, `InvalidAmount = 5`, `InvalidState = 6`, `InvalidDeadline = 7`, `InvalidParties = 8`, `TooEarly = 9`. New variants are appended with new numbers; an existing number is never renumbered.
- **Naming:** contract functions and events are `snake_case`; TypeScript is `camelCase` with `PascalCase` types; file names are `kebab-case`.
- **Time:** the contract compares ledger timestamps in UTC epoch seconds. Everything downstream stores the same unit.
- **Secrets:** keys and contract ids live in `.env`, never in the repository. Script output must be shaped so it can be written straight into `.env`.

## Cross-Story Dependencies

- Story 1.2 defines the data model every later contract story builds on; 1.3–1.5 extend it and must not redefine it. The settlement rework does not change the `Booking` struct or the state enum.
- Story 1.6 tests the behaviour of 1.3–1.5 and should follow them.
- Story 1.7 needs a deployable contract, so it lands after 1.3–1.5 compile.
- Epic 2 (backend, event worker) consumes all five money events defined here — `locked`, `released`, `refunded`, `cancelled`, `forfeited`, of which the last four settle a booking; changing an event's name or payload after this epic breaks the worker, the verified-session counter (Epic 4) and the provider cancellation counter.
- The backend generates `booking_id` and holds a slot before calling the contract, so the contract must accept an externally supplied id.
- A reverted earlier attempt at Story 1.5 built against the superseded clock-only model is preserved at `_bmad-output/implementation-artifacts/spec-1-5-attempted-implementation.patch`. Useful only as reference for the parts that survive — transfer/write/emit order, storage and event reuse, the terminal-state guard and test scaffolding. `resolve_cancel` no longer exists.
