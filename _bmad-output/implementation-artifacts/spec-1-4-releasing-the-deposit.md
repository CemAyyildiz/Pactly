---
title: 'Story 1.4 — Releasing the deposit (release)'
type: 'feature'
created: '2026-09-18'
status: 'ready-for-dev'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Deposits go into the contract and never come out. A professional who has done the work has no path to the money, so the escrow is a one-way trap rather than a settlement.

**Approach:** Add `release(booking_id)`: the client authorizes it, the contract pays the locked amount out to the professional, the record moves to `Released`, and a `released` event tells the rest of the system the money moved.

## Boundaries & Constraints

**Always:**
- `release` requires the **client's** `require_auth` — the address stored on the booking, not the caller (AD-2). The backend's key must never be able to release.
- Only a booking in `Locked` state can be released; `Released` and `Refunded` are terminal.
- The full stored `amount` is transferred from the contract's own address to the booking's `professional`, through the booking's own `token`.
- The record is updated through the existing `storage` helper, keeping the same key, and the write bumps the entry's TTL.
- The `released` event is emitted only after the transfer succeeds, with the same wire shape as `locked`: topics `("released", booking_id)`, data `amount`.
- Reuse the existing types, errors, storage and event modules; new error variants are appended with new numbers, never renumbered.

**Never:**
- No `resolve_cancel`, no deadline comparison, no refund path — Story 1.5 owns those.
- Do not change `initialize`, `get_admin`, `create_booking`, the `Booking` fields, or any existing error number or event shape.
- No partial releases, no fees, no platform cut: the amount paid out equals the amount stored.
- Nothing outside `contracts/escrow/` changes. Do not deploy or call the network.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Deposit released | Booking `Locked`, client authorizes | Contract pays `amount` to the professional; record becomes `Released`; `released` event carries the id and amount; TTL bumped | No error expected |
| Unknown booking id | No record under that id | Nothing transferred, nothing written, no event | `Error::BookingNotFound` |
| Already released | Booking in `Released` state | Nothing transferred, nothing written, no event; the record stays `Released` | `Error::InvalidState` |
| Already refunded | Booking in `Refunded` state | Nothing transferred, nothing written, no event | `Error::InvalidState` |
| Client did not authorize | Booking `Locked`, no signature from the stored client | Call fails; nothing transferred, record still `Locked` | `require_auth` fails with a host auth error |
| Someone else authorizes | Booking `Locked`, the professional (or any other address) signs instead of the client | Call fails; nothing transferred, record still `Locked` | `require_auth` fails with a host auth error |
| Released twice in a row | Successful release, then the same call again | The second call changes nothing and emits no event; the professional is paid exactly once | `Error::InvalidState` |

</intent-contract>

## Code Map

- `contracts/escrow/src/lib.rs` -- `#[contractimpl]` block holding `initialize`, `get_admin`, `create_booking`. `release` joins it. `create_booking` shows the house pattern: auth, then validation, then effects (transfer → store → emit). Reuse `TokenClient` and `env.current_contract_address()`, already imported.
- `contracts/escrow/src/storage.rs` -- `get_booking` (returns `Error::BookingNotFound`), `set_booking` (write + TTL bump), `has_booking`. Reads do not bump; only writes do. Use these; do not touch `env.storage()` directly.
- `contracts/escrow/src/types.rs` -- `Booking` (professional, client, token, amount, cancel_deadline, state) and `BookingState`. Update `state` only; every other field stays as stored.
- `contracts/escrow/src/error.rs` -- codes 1–8; `BookingNotFound = 4` and `InvalidState = 6` already exist and cover this story. No new variant is expected.
- `contracts/escrow/src/events.rs` -- `#[contractevent(topics = ["locked"], data_format = "single-value")] pub struct Locked { #[topic] booking_id, amount }`. Add `Released` as its sibling here; `env.events().publish(..)` is deprecated and `Cargo.toml` denies warnings, so the macro is the only way that builds.
- `contracts/escrow/src/test.rs` -- 31 tests with a `Fixture` (initializes the contract, registers a Stellar asset via `register_stellar_asset_contract_v2`, mints to the client, fixed booking id `[0x1d; 16]`, `NOW`), `assert_no_effect`, and discriminant/constant stability tests. Extend the same fixture; a rejected call's balances and storage are the real evidence, since host rollback makes an empty event list weak on its own.
- `contracts/escrow/Cargo.toml` -- `[lints.rust] warnings = "deny"`. A deprecated call fails the build rather than warning. Do not edit.

## Tasks & Acceptance

**Execution:**
- `contracts/escrow/src/events.rs` -- add the `Released` event beside `Locked`, same topic/data shape -- Epic 2's worker reads both, so they must be siblings rather than one-off publishes.
- `contracts/escrow/src/lib.rs` -- add `release(env, booking_id) -> Result<(), Error>`: load the booking, `require_auth` the stored client, reject a non-`Locked` state, pay the professional from the contract address through the booking's token, store the `Released` record, emit the event -- the only path money leaves the escrow to the professional.
- `contracts/escrow/src/test.rs` -- add a test per matrix row, asserting both balances and the stored state on the happy path and using `assert_no_effect`-style checks on every rejection, plus a `mock_auths` case proving the professional's signature does not authorize the call -- the matrix is this story's contract.

**Acceptance Criteria:**
- Given a released booking, when balances are read, then the professional holds exactly the deposited amount and the contract holds nothing for it.
- Given any rejected call, when it returns, then no tokens moved, the stored state is unchanged and no event was emitted.
- Given the crate, when `npm run contracts:test` and the `wasm32v1-none` release build run, then every test passes and the build produces a `.wasm` with no warnings.

## Spec Change Log

## Review Triage Log

## Design Notes

- **Auth comes from the record, not the caller.** `release` must read the booking before it can know which address to demand a signature from, so the lookup precedes `require_auth`. That makes an unknown id observable to an unsigned caller — acceptable, since booking ids are generated off chain and carry no secret, and the alternative would be demanding a signature from an address nobody has yet identified.
- **State is checked after auth.** A signed client is the only party who may learn whether their own booking is still releasable; the ordering mirrors `initialize`, where the auth check runs before the state check.
- **`released` reuses `locked`'s wire shape.** One shape for every money event keeps Epic 2's worker symmetrical: topics `(name, booking_id)`, data `amount`.

## Verification

**Commands:**
- `npm run contracts:test` -- expected: every test passes, including all matrix rows
- `npm run contracts:build` -- expected: a `wasm32v1-none` release artifact, no warnings (the deny-warnings lint turns any deprecated call into a build failure)
