---
title: 'Story 1.3 — Locking the deposit (create_booking)'
type: 'feature'
created: '2026-09-18'
status: 'in-progress'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '07ee8a697706684193a5d687344c53b122a048aa'
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
- [x] `contracts/escrow/src/error.rs` -- append `InvalidDeadline = 7` with a doc line -- a deadline outside the allowed window is its own outcome, not an amount or state problem.
- [x] `contracts/escrow/src/lib.rs` -- add `create_booking(env, booking_id, professional, client, token, amount, cancel_deadline) -> Result<(), Error>`: `client.require_auth()`, validate amount and deadline, reject a duplicate id, transfer through `TokenClient` into the contract address, store the `Locked` record, then emit the event -- the single money-locking path.
- [x] `contracts/escrow/src/events.rs` -- emit the `locked` event with topics `(symbol_short!("locked"), booking_id)` and the amount as data -- one place owns event shapes, so Stories 1.4 and 1.5 stay consistent and Epic 2's worker has a stable contract.
- [x] `contracts/escrow/src/test.rs` -- add a test per matrix row, using `register_stellar_asset_contract_v2` plus `mint` for a funded client, and assert the event payload and both balances on the happy path -- the matrix is this story's contract.

**Acceptance Criteria:**
- Given a locked deposit, when the contract's token balance is read, then it holds exactly the deposited amount and the client's balance dropped by it.
- Given any rejected call, when it returns, then no tokens moved, no record was written and no event was emitted.
- Given the crate, when `npm run contracts:test` runs, then every test passes, and the release build for `wasm32v1-none` produces a `.wasm` with no warnings.

## Implementation Notes

- `create_booking` validates in the order the Design Notes fix — amount, deadline, duplicate id, transfer, store, emit — with `client.require_auth()` first, before any storage read, so an unsigned call is rejected without touching the ledger.
- The deadline's upper bound is derived from the storage TTL policy rather than hard-coded: `MAX_DEADLINE_AHEAD_SECONDS = storage::BUMP_LEDGERS * LEDGER_CLOSE_SECONDS` (2_073_600 ledgers x 5s = 10_368_000s = 120 days), both private consts in `lib.rs`. Widening `BUMP_LEDGERS` widens the accepted window automatically, so the two can never drift apart. `storage.rs` was left untouched, as the Code Map asks.
- `now.saturating_add(MAX_DEADLINE_AHEAD_SECONDS)` guards the bound so a near-`u64::MAX` ledger timestamp cannot wrap it.
- **Deviation from the Execution task, wire shape unchanged:** `env.events().publish(topics, data)` is deprecated in soroban-sdk 27 ("use the #[contractevent] macro"), and using it makes both the test and release builds emit a warning, which AC3 forbids. `events.rs` therefore declares `#[contractevent(topics = ["locked"], data_format = "single-value")] pub struct Locked { #[topic] booking_id, amount }` and `create_booking` calls `.publish(&env)` on it. The bytes on the wire are exactly the topics and data the spec froze; `deposit_is_locked_and_the_balances_move` asserts the emitted event equals `(contract_id, (symbol_short!("locked"), booking_id), amount)` and was mutation-checked by renaming the topic to `"lockedx"`, which fails the test. Stories 1.4 and 1.5 add their events as sibling structs in the same module.
- The transfer runs before the storage write, so a token failure (an underfunded client) aborts the whole invocation and leaves no record; the event is last, after both, so it only exists if the money really moved.
- Tests share a `Fixture` that registers the escrow, registers a Stellar asset contract, mints the client a balance and holds the default arguments; a test mutates only the field it is about. The `CreateResult` type alias spells out `try_create_booking`'s nested result, which distinguishes a contract error (`Err(Ok(..))`) from a host error (`Err(Err(..))`).
- Every rejection path runs through one `assert_no_effect` helper: no event, contract balance 0, client's balance unchanged, no stored booking. The event check has to come first — `env.events().all()` reports only the last contract invocation, and reading a balance is one — which is why the happy-path test also asserts its event before it reads balances.
- Extra coverage beyond the matrix, all cheap and all on boundaries this story owns: the deadline exactly equal to `now` (rejected — a booking must have a window to cancel in), the deadline exactly at the edge of the TTL window (accepted, so the bound is exact rather than approximately right), the booking entry's TTL after a successful lock, and `mock_auths`-based proof that the professional's signature for the same call does not authorize it while the client's does.
- Test snapshots under `contracts/escrow/test_snapshots/` are regenerated by `cargo test` and committed, as in Stories 1.1 and 1.2. The `Fixture` uses a fixed booking id (`BytesN::from_array(&env, &[0x1d; 16])`) rather than `BytesN::random`, so this story's snapshots are reproducible and a test run leaves them unchanged. The two Story 1.2 tests that call `BytesN::random` still rewrite their snapshot on every run; that is pre-existing and was left alone as out of this story's scope.

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
