---
title: 'Story 1.2 — Escrow contract data model and initialize'
type: 'feature'
created: '2026-09-18'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'be8f0f62eb3523824e71aa95d95f149137f88ade'
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
- [x] `contracts/escrow/src/types.rs` -- define `BookingState` (Locked / Released / Refunded) and `Booking` as `#[contracttype]` types, with the field order and units from the epic context -- one shape every later story imports.
- [x] `contracts/escrow/src/error.rs` -- declare `#[contracterror] #[repr(u32)] pub enum Error` with the five variants plus `NotInitialized`, each with a stable explicit discriminant -- error codes must not shift when 1.3–1.5 add paths.
- [x] `contracts/escrow/src/storage.rs` -- define the `DataKey` enum (`Admin`, `Booking(BytesN<16>)`) and the read/write helpers for the admin and for a booking record, including the persistent-storage TTL bump -- the single place storage is touched.
- [x] `contracts/escrow/src/lib.rs` -- wire the new modules and add `#[contractimpl]` with `initialize(env, admin: Address) -> Result<(), Error>` (requires the admin's auth, stores it, returns `AlreadyInitialized` on a second call) and `get_admin(env) -> Result<Address, Error>` -- the entry points 1.3+ build on.
- [x] `contracts/escrow/src/test.rs` -- extend with unit tests covering every row of the I/O matrix, using `env.mock_all_auths()` for the authorized cases and an unauthorized case that asserts the failure -- the matrix is the contract of this story.

**Acceptance Criteria:**
- Given the crate, when `npm run contracts:test` runs, then every test passes and no test is skipped.
- Given the crate, when it is built for `wasm32v1-none` in release, then a `.wasm` artifact is produced with no warnings.
- Given Stories 1.3–1.5, when they add `create_booking`, `release` and `resolve_cancel`, then they can write and read a booking through the storage helper without redefining any type, key or error.

## Implementation Notes

- Modules are `pub mod` and the crate root re-exports `Error`, `Booking`, `BookingId`, `BookingState`. The reason is dead-code suppression: the helpers 1.3–1.5 will call have no in-crate caller yet, and `pub` keeps the build warning-free. Only `initialize` and `get_admin` are exported from the wasm, so this is not a supported external API.
- `BookingId` is a type alias for `BytesN<16>` in `types.rs`. `DataKey::Booking` uses it, so the id width is written down once.
- The booking id is the storage key and is deliberately not repeated inside the `Booking` record.
- TTL policy lives entirely in `storage.rs`: one private `bump` helper extends a persistent entry to 120 days (`120 * 17_280` = 2_073_600 ledgers, under the 3_110_400 network maximum) whenever it drops below 119 days. Only `set_admin` and `set_booking` bump — the getters do not write, so a view read stays read-only. A booking's entry must outlive its `cancel_deadline`, so `create_booking` in Story 1.3 must reject a deadline beyond this window; the module doc says so.
- Explicit error discriminants 1–6, with `NotInitialized` inserted at 2 (so the five epic-context errors sit at 1 and 3–6). Any number is as good as another once fixed; `test::error_discriminants_are_stable` locks them in.
- `initialize` calls `require_auth` before the already-initialized check: fail closed, and reject an unsigned call before touching storage. It hides nothing — `get_admin` is public and unauthenticated, so initialization state is public either way.
- The unauthorized-initialize row is covered twice: a `#[should_panic(expected = "Unauthorized")]` test on the direct client call, plus a test that asserts `try_initialize` returns exactly `Err(Err(InvokeError::Abort))` — a host auth error, not a contract error — and then checks through `storage::has_admin` that nothing was written. `second_initialize_checks_authorization_before_the_admin_check` pins that `require_auth` runs before the `has_admin` check, and `initialize_requires_the_admins_own_authorization` uses `env.mock_auths(&[MockAuth { .. }])` to show a stranger's signature for the same call is rejected while the admin's own is accepted.
- The TTL policy and both discriminant sets are asserted, not assumed: `writes_extend_the_persistent_ttl_to_the_bump_window` reads `get_ttl` back for the admin key and a booking key, and `booking_state_discriminants_are_stable` pins Locked/Released/Refunded to 0/1/2 alongside the error codes. The TTL test and the auth-order test were mutation-checked — shrinking the bump to `extend_ttl(key, 0, 1)`, and moving `require_auth` below the `has_admin` check — and each fails under its mutation.
- Test snapshot JSON under `contracts/escrow/test_snapshots/` is regenerated by `cargo test`. It is committed, as Story 1.1 committed its own snapshot; "leave alone" in the Code Map means do not hand-edit it.

## Spec Change Log

## Review Triage Log

Review loop 1 (blind-hunter BH, edge-case-hunter EC, verification-gap VG).

| # | Location | Finding | Verdict | Evidence | Route |
|---|---|---|---|---|---|
| 1 | `storage.rs:16` | BH1 / EC3: flat 30-day TTL ignores `cancel_deadline`; a longer-dated booking is archived while its deposit is locked | medium | Real: `cancel_deadline` is caller-supplied with no bound, and nothing here or in 1.3 keeps the entry alive past it. Test env max is 6,312,000 ledgers, network max 3,110,400, so a wider window is available. | patch |
| 2 | `storage.rs:47,75` | BH2 / EC7: `get_admin` / `get_booking` bump TTL, so read paths write to the ledger | medium | Confirmed in the code; a plain view read becomes a state-changing invocation for the backend's chain client (AD-8). Fix is deleting two calls. | patch |
| 3 | `storage.rs:87` | VG1: the TTL policy has no assertion | medium | Pre-verified by VG: replacing `extend_ttl(key, THRESHOLD, BUMP)` with `extend_ttl(key, 0, 1)` kept all 10 tests green; snapshots are output, not assertions. | patch |
| 4 | `lib.rs:31-35` | VG2: the `require_auth`-before-state-check ordering is unverified | medium | Pre-verified by VG: moving `require_auth` below the `has_admin` check kept all 10 tests green; no test calls `initialize` unauthorized on an initialized contract. | patch |
| 5 | `types.rs:17-21` | VG3 / BH7 / EC8: `BookingState` discriminants are unpinned while `Error`'s are pinned | medium | Pre-verified by VG: renumbering to 7/8/9 kept all 10 tests green; the state is stored on ledger as a bare `u32`. | patch |
| 6 | `test.rs:60,75` | BH4 / BH5 / EC9 / EC10: bare `#[should_panic]` and `is_err()` accept any failure, not the auth failure | low | Real: both would pass on an unrelated panic or a returned contract error. Fix pins the error shape in place. | patch |
| 7 | `test.rs` | BH6: every authorized test uses `mock_all_auths`, so no test pins *which* address must sign | low | Real: `initialize` calling `require_auth` on a different address would stay green. `mock_auths` fixes it in the same file. | patch |
| 8 | spec Implementation Notes | BH10 / BH11 / EC12: three rationales are factually wrong (the "leak" claim, the `pub mod` reason, "contiguous" error codes) | low | Verified: `get_admin` is public and unauthenticated so initialization state is already public; 1.3–1.5 live in the same crate; the five epic errors sit at 1 and 3–6. The code is fine; only the notes mislead. | patch |
| 9 | `storage.rs:66` | BH8 / EC4 / EC5 / EC11: `set_booking` overwrites silently, `BookingExists` / `InvalidAmount` / `InvalidState` are unenforced, replace semantics untested | medium | Real, but `create_booking` is Story 1.3's task and the frozen boundary excludes it from this story. Recorded for 1.3. | defer |
| 10 | `storage.rs:33,59` | EC1 / EC2: `has_admin` / `has_booking` do not bump TTL | false | With #2 applied the policy is "writes bump, reads do not"; existence probes are reads. | reject |
| 11 | `storage.rs:38` | EC6: `set_admin` is reachable from 1.3–1.5 and could overwrite the admin | low | Only `initialize` is exported from the wasm; an in-crate misuse is a review matter for 1.3. Narrowing visibility would make the still-uncalled booking helpers dead code. | reject |
| 12 | `storage.rs` | EC3 (restore): no restore path or monitoring for an archived entry | low | Restoring an archived entry is an off-chain footprint concern, not a contract function; #1 widens the window. | reject |
| 13 | spec / `sprint-status.yaml` | BH12 / VG other: spec says `in-review`, sprint says `in-progress` | false | The sprint file moves to `review` at the presentation step; 1.1 shows the same sequence. | reject |
| 14 | — | BH13: AC2 (wasm build, no warnings) has no evidence in the diff | false | The build is a verification command, run and green in this session; its artifact is gitignored by design. | reject |
| 15 | `test_snapshots/` | BH9 / EC15 / VG other: 8 generated snapshots are untracked and not ignored | false | Story 1.1 committed its snapshot file, so these are committed the same way; the Code Map's "leave alone" means do not hand-edit them. | reject |
| 16 | repo | VG other: no CI, so every check is local | low | Pre-existing; not caused by this change. | reject |

## Design Notes

- **`NotInitialized` joins the five epic-context errors, and `get_admin` returns `Result`.** Reading the admin before `initialize` is a real outcome; giving it its own code beats folding it into `InvalidState` or making every caller handle an `Option`.
- **Bookings go in persistent, not instance, storage, and the helper owns the TTL bump.** Instance storage shares one TTL and size limit across all bookings; the archival policy is then decided once instead of at three call sites in 1.3–1.5.

## Verification

**Commands:**
- `npm run contracts:test` -- expected: all tests pass, including the unauthorized-initialize case
- `cargo build --manifest-path contracts/escrow/Cargo.toml --target wasm32v1-none --release` -- expected: a `.wasm` artifact, no warnings
- `cargo clippy --manifest-path contracts/escrow/Cargo.toml --all-targets` -- expected: no warnings (skip if clippy is unavailable and say so)
