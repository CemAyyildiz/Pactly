---
title: 'Story 1.2 — Escrow contract data model and initialize'
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

**Problem:** The escrow crate compiles but holds nothing: there is no booking record, no state enum, no error type and no way to set the contract's admin. Stories 1.3–1.5 each need those exact shapes, and if any of them invents its own, the three money paths stop agreeing.

**Approach:** Define the on-chain data model once — `Booking`, `BookingState`, the `Error` variants and the storage keys — plus `initialize(admin)`, which stores the admin and refuses a second call. No money moves in this story.

## Boundaries & Constraints

**Always:**
- The data model matches the epic context exactly: `Booking` carries professional, client, token, amount, cancel_deadline, state; `BookingState` is Locked / Released / Refunded; errors are `AlreadyInitialized`, `BookingExists`, `BookingNotFound`, `InvalidAmount`, `InvalidState`.
- `amount` is `i128` in the asset's smallest unit; `cancel_deadline` is UTC epoch seconds (`u64`); `booking_id` is `BytesN<16>` supplied by the caller — the contract never generates one.
- Contract functions and fields are `snake_case`; everything is English; functions return `Result<_, Error>` instead of panicking on a foreseeable error.
- Booking records and the admin live in persistent storage, reached through one storage helper rather than ad-hoc `env.storage()` calls.
- Everything builds for `wasm32v1-none` with no deprecated Soroban APIs (`register_contract`), and `cargo test` stays green.

**Never:**
- No `create_booking`, `release` or `resolve_cancel`, no token transfer, no event emission — Stories 1.3–1.5 own those.
- Do not change the crate's dependency versions, the release profile or `rust-toolchain.toml`.
- Nothing outside `contracts/escrow/` changes: no backend, frontend, script or `.env` work.
- Do not deploy or call the network.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| First initialize | Fresh contract, `initialize(admin)` with the admin's authorization | Admin stored; call returns `Ok(())` | N/A |
| Second initialize | Contract already initialized, `initialize(other)` | Nothing is stored; the stored admin is unchanged | Returns `Error::AlreadyInitialized` |
| Initialize without authorization | Fresh contract, `initialize(admin)` invoked without the admin's signature | Call fails; nothing is stored | `require_auth` panics with an auth error |
| Admin read after initialize | Contract initialized with `admin` | `get_admin()` returns that address | N/A |
| Admin read before initialize | Fresh contract, `get_admin()` | No address returned | Returns `Error::NotInitialized` |
| Booking round-trip through the storage helper | A `Booking` written under a `BytesN<16>` id, then read back | The same field values come back, including `BookingState::Locked` | N/A |
| Booking read for an unknown id | Storage helper asked for an id that was never written | No record returned | Returns `Error::BookingNotFound` |

</frozen-after-approval>

## Code Map

- `contracts/escrow/src/lib.rs` -- today: `#![no_std]`, an empty `#[contract] pub struct EscrowContract`, `mod test`. Keep the struct name; `initialize` and the `#[contractimpl]` block land here and 1.3–1.5 extend the same block.
- `contracts/escrow/src/test.rs` -- one smoke test using `env.register(EscrowContract, ())`. Extend it; never `register_contract`.
- `contracts/escrow/Cargo.toml` -- soroban-sdk `=27.0.6`, `testutils` dev-feature and release profile already set. Do not edit.
- soroban-sdk 27.0.6 API confirmed locally: `env.storage().persistent()`/`.instance()` with `get`/`set`/`has`/`extend_ttl`, `#[contracttype]`, `#[contracterror]`, `#[contractimpl]`, `Address::require_auth()`, `env.mock_all_auths()`.
- `contracts/escrow/target/`, `contracts/escrow/test_snapshots/` -- generated; leave alone.

## Tasks & Acceptance

**Execution:**
- [ ] `contracts/escrow/src/types.rs` -- define `BookingState` (Locked / Released / Refunded) and `Booking` as `#[contracttype]` types, with the field order and units from the epic context -- one shape every later story imports.
- [ ] `contracts/escrow/src/error.rs` -- declare `#[contracterror] #[repr(u32)] pub enum Error` with the five variants plus `NotInitialized`, each with a stable explicit discriminant -- error codes must not shift when 1.3–1.5 add paths.
- [ ] `contracts/escrow/src/storage.rs` -- define the `DataKey` enum (`Admin`, `Booking(BytesN<16>)`) and the read/write helpers for the admin and for a booking record, including the persistent-storage TTL bump -- the single place storage is touched.
- [ ] `contracts/escrow/src/lib.rs` -- wire the new modules and add `#[contractimpl]` with `initialize(env, admin: Address) -> Result<(), Error>` (requires the admin's auth, stores it, returns `AlreadyInitialized` on a second call) and `get_admin(env) -> Result<Address, Error>` -- the entry points 1.3+ build on.
- [ ] `contracts/escrow/src/test.rs` -- extend with unit tests covering every row of the I/O matrix, using `env.mock_all_auths()` for the authorized cases and an unauthorized case that asserts the failure -- the matrix is the contract of this story.

**Acceptance Criteria:**
- Given the crate, when `npm run contracts:test` runs, then every test passes and no test is skipped.
- Given the crate, when it is built for `wasm32v1-none` in release, then a `.wasm` artifact is produced with no warnings.
- Given Stories 1.3–1.5, when they add `create_booking`, `release` and `resolve_cancel`, then they can write and read a booking through the storage helper without redefining any type, key or error.

## Implementation Notes

## Spec Change Log

## Review Triage Log

## Design Notes

- **`NotInitialized` joins the five epic-context errors, and `get_admin` returns `Result`.** Reading the admin before `initialize` is a real outcome; giving it its own code beats folding it into `InvalidState` or making every caller handle an `Option`.
- **Bookings go in persistent, not instance, storage, and the helper owns the TTL bump.** Instance storage shares one TTL and size limit across all bookings; the archival policy is then decided once instead of at three call sites in 1.3–1.5.

## Verification

**Commands:**
- `npm run contracts:test` -- expected: all tests pass, including the unauthorized-initialize case
- `cargo build --manifest-path contracts/escrow/Cargo.toml --target wasm32v1-none --release` -- expected: a `.wasm` artifact, no warnings
- `cargo clippy --manifest-path contracts/escrow/Cargo.toml --all-targets` -- expected: no warnings (skip if clippy is unavailable and say so)
