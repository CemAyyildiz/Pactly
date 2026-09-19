---
title: 'Story 1.3 — Locking the deposit (create_booking)'
type: 'feature'
created: '2026-09-18'
status: 'ready-for-dev'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The contract can describe a booking but cannot hold money. Nothing moves a deposit out of the client's hands into neutral custody, so the product's core promise — the deposit reaches neither the platform nor the professional — has no code behind it.

**Approach:** Add `create_booking`, the one function that locks a deposit: it takes the client's authorization, pulls the amount through the token contract into the contract's own address, writes the booking in `Locked` state, and emits a `locked` event.

## Boundaries & Constraints

**Always:**
- `create_booking(booking_id, professional, client, token, amount, cancel_deadline)` requires the client's `require_auth`; the backend's key must never be able to call it.
- The deposit is transferred from the client to `env.current_contract_address()` through the token contract; the contract never mints, holds a balance elsewhere, or touches a hard-coded asset.
- The record is written through the existing `storage` helper in `Locked` state, and the write bumps the entry's TTL.
- A `locked` event is emitted after the transfer succeeds, carrying the booking id and the amount.
- Amounts stay `i128` in the token's smallest unit; `cancel_deadline` stays UTC epoch seconds compared against `env.ledger().timestamp()`.
- Reuse the types, errors and storage helpers from Story 1.2 as they are; new error variants are appended with new numbers, never renumbered.

**Never:**
- No `release` or `resolve_cancel`, no state transition out of `Locked` — Stories 1.4 and 1.5 own those.
- Do not change `initialize`, `get_admin`, the `Booking` fields or the existing error numbers.
- Nothing outside `contracts/escrow/` changes.
- Do not deploy or call the network.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Deposit locked | Fresh id, positive amount, deadline inside the window, client authorized and funded | Tokens move client → contract; booking stored `Locked`; `locked` event carries the id and amount | N/A |
| Duplicate id | A booking already stored under that id | No transfer, no event, the stored record is untouched | `Error::BookingExists` |
| Zero or negative amount | `amount <= 0` | No transfer, nothing stored | `Error::InvalidAmount` |
| Deadline already passed | `cancel_deadline <= ledger timestamp` | No transfer, nothing stored | `Error::InvalidDeadline` |
| Deadline beyond the TTL window | `cancel_deadline` further out than the storage bump window | No transfer, nothing stored | `Error::InvalidDeadline` |
| Client did not authorize | No signature from `client` | Call fails; nothing stored, nothing transferred | `require_auth` fails with a host auth error |
| Client cannot cover the amount | Client's token balance below `amount` | Call fails; nothing stored, no event | The token contract's own error propagates |

</frozen-after-approval>

## Code Map

- `contracts/escrow/src/lib.rs` -- `#[contractimpl]` block with `initialize` and `get_admin`. `create_booking` is added to this same block; do not restructure what is there.
- `contracts/escrow/src/storage.rs` -- `has_booking`, `set_booking`, `get_booking`, `DataKey`, and `pub const BUMP_LEDGERS` (120 days in ledgers, ~5s per ledger). Writes bump the TTL, reads do not. The module doc already states that `create_booking` must reject a deadline beyond this window; honour it.
- `contracts/escrow/src/types.rs` -- `Booking`, `BookingState`, `BookingId = BytesN<16>`. Use as-is.
- `contracts/escrow/src/error.rs` -- `Error` codes 1–6 with a stability test in `test.rs`; `BookingExists = 3` and `InvalidAmount = 5` already exist. Append `InvalidDeadline = 7`.
- `contracts/escrow/src/test.rs` -- 14 tests, `setup()` helper, `env.mock_all_auths()` / `env.mock_auths(..)` patterns, plus discriminant-stability tests. Extend the same file and keep the per-matrix-row test naming.
- soroban-sdk 27.0.6 API confirmed locally: `soroban_sdk::token::TokenClient` (`transfer(from, to, amount)`), `env.register_stellar_asset_contract_v2(admin)` with `StellarAssetClient::mint` for tests, `env.events().publish(topics, data)`, `env.ledger().timestamp()`, `env.current_contract_address()`.

## Tasks & Acceptance

**Execution:**
- [ ] `contracts/escrow/src/error.rs` -- append `InvalidDeadline = 7` with a doc line -- a deadline outside the allowed window is its own outcome, not an amount or state problem.
- [ ] `contracts/escrow/src/lib.rs` -- add `create_booking(env, booking_id, professional, client, token, amount, cancel_deadline) -> Result<(), Error>`: `client.require_auth()`, validate amount and deadline, reject a duplicate id, transfer through `TokenClient` into the contract address, store the `Locked` record, then emit the event -- the single money-locking path.
- [ ] `contracts/escrow/src/events.rs` -- emit the `locked` event with topics `(symbol_short!("locked"), booking_id)` and the amount as data -- one place owns event shapes, so Stories 1.4 and 1.5 stay consistent and Epic 2's worker has a stable contract.
- [ ] `contracts/escrow/src/test.rs` -- add a test per matrix row, using `register_stellar_asset_contract_v2` plus `mint` for a funded client, and assert the event payload and both balances on the happy path -- the matrix is this story's contract.

**Acceptance Criteria:**
- Given a locked deposit, when the contract's token balance is read, then it holds exactly the deposited amount and the client's balance dropped by it.
- Given any rejected call, when it returns, then no tokens moved, no record was written and no event was emitted.
- Given the crate, when `npm run contracts:test` runs, then every test passes, and the release build for `wasm32v1-none` produces a `.wasm` with no warnings.

## Implementation Notes

## Spec Change Log

## Review Triage Log

## Design Notes

- **Validation order is: amount, deadline, duplicate id, then transfer.** Cheap checks first, and the transfer is last so a rejected call can never have moved tokens.
- **The event is emitted after the transfer, not before.** The event is the only way Epic 2 learns money moved (AD-1), so it must not exist unless the transfer succeeded.
- **`locked` carries the id and the amount only.** The backend already holds professional, client and token from its own hold record (AD-13); a wider payload would duplicate mirror data on chain.
- **A deadline in the past is rejected rather than accepted as an instant no-show.** Accepting one would let a booking be created that `resolve_cancel` could immediately settle to the professional, which no product flow asks for.

## Verification

**Commands:**
- `npm run contracts:test` -- expected: all tests pass, including every matrix row
- `cargo build --manifest-path contracts/escrow/Cargo.toml --target wasm32v1-none --release` -- expected: a `.wasm` artifact, no warnings
