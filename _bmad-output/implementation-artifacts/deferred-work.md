- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-monorepo-skeleton.md`
  summary: Add an automated check that `GET /health` returns 200 with `{"status":"ok"}`.
  evidence: Verification-gap review found no test touching `/health`; renaming the route would pass `npm run build` and `npm test`. Cheap once the backend test script from Story 1.1 exists (export `app` and use `app.request("/health")`).
- source_spec: `_bmad-output/implementation-artifacts/spec-1-2-escrow-data-model-and-initialize.md`
  summary: Story 1.3 must guard booking writes: reject a duplicate id with `BookingExists`, `amount <= 0` with `InvalidAmount`, and a non-`Locked` initial state with `InvalidState`, and cover replace-vs-create semantics with tests.
  evidence: Review found `storage::set_booking` overwrites silently and three declared error variants have no producer; `create_booking` is Story 1.3's task, so the guard belongs there rather than in 1.2's storage helper.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-2-escrow-data-model-and-initialize.md`
  summary: Story 1.3 must reject a `cancel_deadline` that falls outside the contract's persistent-entry TTL window.
  evidence: The TTL bump is a fixed window decided in 1.2's storage helper; only `create_booking` sees the deadline and can refuse one the entry would not outlive.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-3-locking-the-deposit.md`
  summary: Make the two Story 1.2 tests that use `BytesN::random` use a fixed booking id, so `cargo test` stops rewriting their committed snapshots.
  evidence: `booking_round_trips_through_the_storage_helper` and `writes_extend_the_persistent_ttl_to_the_bump_window` rewrite their snapshot on every run, so `git status` is never clean after a test run. One-line change each, but it belongs to 1.2's files.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-5-resolving-a-cancellation.md`
  summary: Hard precondition for Epic 2/4 — a professional must have a live USDC trustline before they can be approved or take bookings.
  evidence: The escrow's payout traps if the recipient cannot receive the token (no trustline, authorization off, clawback), and after the deadline both `release` and the no-show path target the professional, so the deposit would be permanently stuck. Soroban cannot check a trustline cheaply, and an admin recovery path would break AD-2. The professional already needs the trustline for SEP-6 withdraw (Story 2.3), so making it a gate on provider approval (Epic 4) removes the failure mode entirely. Decided 2026-09-18.
