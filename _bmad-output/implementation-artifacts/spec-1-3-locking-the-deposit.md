---
title: 'Story 1.3 — Locking the deposit (create_booking)'
type: 'feature'
created: '2026-09-18'
status: 'done'
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

- `create_booking` runs `client.require_auth()` first, then every check, then all three effects: initialized guard, amount, deadline, parties, duplicate id, and only after the last of them the transfer, the store and the event. Auth before the storage reads matters on its own — without it an unsigned call that got back `BookingExists` would be a free oracle for whether a booking id is in use. `create_booking_checks_authorization_before_validation_and_storage` pins it with an unsigned call carrying both an existing id and `amount = 0`.
- `create_booking` refuses to lock a deposit in a contract with no admin (`Error::NotInitialized`), checked immediately after `require_auth` so the auth-first ordering still holds.
- `Error::InvalidParties = 8` (appended; 1–7 untouched) rejects a booking whose professional is its own client, or whose professional is the escrow contract. The first round-trips the deposit to the payer while still counting as a session that provider delivered; the second names the custodian as a counterparty, which no settlement path could pay out.
- The deadline's upper bound is derived from the storage TTL policy rather than hard-coded, and stops short of it: `MAX_DEADLINE_AHEAD_SECONDS = storage::BUMP_LEDGERS * LEDGER_CLOSE_SECONDS - SETTLEMENT_MARGIN_SECONDS` = 120 days − 30 days = **90 days**. The margin exists because the deadline is when a booking becomes *settleable*, not when it is settled — Story 1.5's `resolve_cancel` acts only once the deadline has passed, so a record expiring at its deadline would archive exactly as its settlement window opened.
- `LEDGER_CLOSE_SECONDS` lives in `storage.rs` as the single source of the seconds-per-ledger assumption: `DAY_IN_LEDGERS` is derived from it (`86_400 / LEDGER_CLOSE_SECONDS`) and `lib.rs` imports it. Previously the same 5 was written twice and either copy could be changed with the suite still green. `the_deadline_window_constants_are_stable` now pins the result as wall-clock literals (5 s/ledger, 120-day TTL, 30-day margin, 90-day window), so touching any of the three constants has to be a deliberate change to the window.
- `now.saturating_add(MAX_DEADLINE_AHEAD_SECONDS)` guards the bound so a near-`u64::MAX` ledger timestamp cannot wrap it, exercised by `a_ledger_timestamp_near_the_end_of_time_does_not_wrap_the_deadline_bound`.
- **Deviation from the Execution task, wire shape unchanged:** `env.events().publish(topics, data)` is deprecated in soroban-sdk 27 ("use the #[contractevent] macro"), and using it makes both the test and release builds emit a warning, which AC3 forbids. `events.rs` therefore declares `#[contractevent(topics = ["locked"], data_format = "single-value")] pub struct Locked { #[topic] booking_id, amount }` and `create_booking` calls `.publish(&env)` on it. The bytes on the wire are exactly the topics and data the spec froze; `deposit_is_locked_and_the_balances_move` asserts the emitted event equals `(contract_id, (symbol_short!("locked"), booking_id), amount)` and was mutation-checked by renaming the topic to `"lockedx"`, which fails the test. Stories 1.4 and 1.5 add their events as sibling structs in the same module.
- The transfer runs before the storage write, so a token failure (an underfunded client) aborts the whole invocation and leaves no record; the event is last, after both, so it only exists if the money really moved. The underfunded row asserts the token's specific error — `InvokeError::Contract(10)`, the Stellar Asset Contract's `BalanceError` — rather than any host error, which would also have accepted an auth failure or a panic in this contract.
- Tests share a `Fixture` that registers the escrow, registers a Stellar asset contract, mints the client a balance and holds the default arguments; a test mutates only the field it is about. The `CreateResult` type alias spells out `try_create_booking`'s nested result, which distinguishes a contract error (`Err(Ok(..))`) from a host error (`Err(Err(..))`).
- Every rejection path runs through one `assert_no_effect` helper: no event, contract balance 0, client's balance unchanged, no stored booking. The event check has to come first — `env.events().all()` describes only the most recent contract invocation, and reading a balance is one — which is why the happy-path test also asserts its event before it reads balances. That check is weak evidence by itself, since the host discards a failed invocation's events regardless; the balance and storage assertions are what actually show nothing happened, and the helper's doc comment says so.
- Extra coverage beyond the matrix, all cheap and all on boundaries this story owns: the deadline exactly equal to `now` (rejected — a booking must have a window to cancel in), the deadline exactly at the edge of the accepted window (accepted, and asserted to leave exactly the settlement margin of readable life after it), the booking entry's TTL after a successful lock, two bookings under distinct ids coexisting with the contract custodying the sum, and `mock_auths`-based proof that the professional's signature for the same call does not authorize it while the client's does.
- `[lints.rust] warnings = "deny"` in `Cargo.toml` is what actually enforces AC3. Nothing else did, which mattered because the `#[contractevent]` deviation below exists solely to keep the build warning-free. Verified by reintroducing a deprecated `events().publish` call: the release wasm build now fails rather than warns. Dependencies and the release profile were not touched.
- Mutation-checked, each failing at least one test: `LEDGER_CLOSE_SECONDS` 5 → 50, `saturating_add` → `wrapping_add`, dropping the settlement margin, dropping the `has_admin` guard, dropping the `InvalidParties` guard, and moving `require_auth` below the duplicate-id check. Every one of those passed the suite before this round.
- Test snapshots under `contracts/escrow/test_snapshots/` are regenerated by `cargo test` and committed, as in Stories 1.1 and 1.2. The `Fixture` uses a fixed booking id (`BytesN::from_array(&env, &[0x1d; 16])`) rather than `BytesN::random`, so this story's snapshots are reproducible and a test run leaves them unchanged. The two Story 1.2 tests that call `BytesN::random` still rewrite their snapshot on every run; that is pre-existing and was left alone as out of this story's scope.

## Spec Change Log

- **Loop 1 (2026-09-18)** — Trigger: the Execution task specified `env.events().publish((symbol_short!("locked"), booking_id), amount)`, which soroban-sdk 27 deprecates; using it emits a build warning and breaks AC3's "no warnings". Amended: the event is declared with `#[contractevent]` in `events.rs` while the frozen wire shape — topics `("locked", booking_id)`, data `amount` — is unchanged and asserted by a test. Known-bad state avoided: either a warning-producing build or a silently changed event contract for Epic 2. KEEP: the module-owned event shape, and the happy-path test that pins the exact topic tuple and data.

## Review Triage Log

Review loop 1 (blind-hunter BH, edge-case-hunter EC, verification-gap VG).

| # | Location | Finding | Verdict | Evidence | Route |
|---|---|---|---|---|---|
| 1 | `lib.rs:32` | BH1 / EC4: the accepted deadline reaches exactly the TTL window, leaving no room for the settlement that happens *after* the deadline | medium | Real: `resolve_cancel` settles a no-show after `cancel_deadline`, but the entry's TTL ends at the same point, so a boundary booking can archive as its settlement window opens. | patch |
| 2 | `lib.rs:25` / `storage.rs:19` | BH2 / BH3 / VG1: the 5-second ledger assumption exists twice, and no test pins the wall-clock window | medium | Pre-verified by VG: changing `LEDGER_CLOSE_SECONDS` from 5 to 50 kept all 24 tests green, because both deadline tests compute their bound from the same constant. | patch |
| 3 | `lib.rs:87` | VG2: nothing pins `require_auth` running before any validation or storage read | medium | Pre-verified by VG: moving it below the duplicate-id check kept all 24 tests green and turns `create_booking` into an unauthenticated oracle for whether a booking id exists. | patch |
| 4 | `lib.rs:78` | BH5 / EC1: no check that `professional` differs from `client` (or from the contract address) | medium | Real: a self-booking settles to the payer and, once Story 4.3 lands, a `released` event would inflate that provider's verified-session counter — fake credibility with real money round-tripped. | patch |
| 5 | `lib.rs:98` | BH8 / VG3: the `saturating_add` overflow guard is never exercised | low | Pre-verified by VG: replacing it with `wrapping_add` kept all 24 tests green. Unreachable timestamp, but the notes claim the guard. | patch |
| 6 | `test.rs` underfunded case | BH7 / EC7: the assertion accepts any host error, not the token's insufficient-balance error | low | Real: `matches!(result, Err(Err(_)))` also passes on an unrelated abort. | patch |
| 7 | `test.rs` | BH9 / BH10: no test that two bookings coexist; the duplicate-id test never checks the client's balance | low | Real: the normal multi-booking case has no coverage, and the half of AC2 that protects the payer is unasserted on the duplicate path. | patch |
| 8 | `lib.rs:78` doc, `test.rs` helper comment | BH4 / VG other: two comments state orderings the code does not have | low | Verified: the transfer is not last (store and emit follow), and the rollback that makes `assert_no_effect` hold is host-level, not an `events().all()` artifact. | patch |
| 9 | `Cargo.toml` | BH12 / VG other: AC3's "no warnings" is enforced by nothing | medium | Real: the `#[contractevent]` deviation exists to keep the build warning-free, yet a reintroduced deprecated call would only show up to a human reading build output. A `[lints.rust]` entry fixes it inside the story's boundary. | patch |
| 10 | `lib.rs:87` | BH6 / EC6: `create_booking` works on a contract where `initialize` never ran | medium | Real: deposits can be locked in a contract with no admin — e.g. against a wrong contract id — and `NotInitialized` exists for exactly this. Guarding costs one storage read. | patch |
| 11 | spec Execution task | BH11: the task still describes `env.events().publish(..)` while the code uses `#[contractevent]`, and the change log was empty | low | Verified; recorded as a Spec Change Log entry rather than by rewriting the ticked task. | patch |
| 12 | `lib.rs:110` | EC2: `token` is not checked against an allowed asset | false | The epic context fixes the opposite: no currency is hard-coded, the asset arrives as a token address. | reject |
| 13 | `lib.rs:110` | EC3: a fee-on-transfer or rebasing token would credit less than `amount` | low | Only a caller supplying such a token is harmed, and the demo rail is USDC; a balance-delta check adds a second read and a branch to every lock. | reject |
| 14 | `lib.rs:97` | EC5: no minimum cancellation window (`now + 1` is accepted) | low | How long a client may cancel is a product rule the backend sets per booking; the contract only enforces that the window exists. | reject |
| 15 | spec / `sprint-status.yaml` | BH11 (second half): the two files disagree on status | false | The sprint file moves to `review` at the presentation step, as in 1.1 and 1.2. | reject |
| 16 | `test.rs` fixture | BH extra: the funding amount is passed twice; `set_auths(&[])` vs `mock_auths(&[])` | low | Cosmetic; no failure mode named. | reject |
| 17 | 1.2 tests | VG other: two Story 1.2 tests use `BytesN::random`, so snapshots churn on every run | low | Pre-existing, from Story 1.2, and outside this story's boundary. | defer |

## Design Notes

- **Validation order is: amount, deadline, duplicate id, then transfer.** Cheap checks first, and the transfer is last so a rejected call can never have moved tokens.
- **The event is emitted after the transfer, not before.** The event is the only way Epic 2 learns money moved (AD-1), so it must not exist unless the transfer succeeded.
- **`locked` carries the id and the amount only.** The backend already holds professional, client and token from its own hold record (AD-13); a wider payload would duplicate mirror data on chain.
- **A deadline in the past is rejected rather than accepted as an instant no-show.** Accepting one would let a booking be created that `resolve_cancel` could immediately settle to the professional, which no product flow asks for.

## Verification

**Commands:**
- `npm run contracts:test` -- expected: all tests pass, including every matrix row
- `cargo build --manifest-path contracts/escrow/Cargo.toml --target wasm32v1-none --release` -- expected: a `.wasm` artifact, no warnings
