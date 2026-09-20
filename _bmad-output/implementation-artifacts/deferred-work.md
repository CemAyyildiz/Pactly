- source_spec: Demo Day conversation with Mihai (XOXNO), 20 Sep 2026
  summary: Optional yield on a locked deposit — client opt-in, off by default; shop still receives the exact deposit; client keeps any yield. Needs a yield-aware wrapper or Trustless Work strategy hook (current single-release escrow cannot supply internally). Park after Story 2.3 cash-out. Not in this hackathon window.
  evidence: Trustless Work Core v2 single-release has no supply/invest path; XOXNO Controller.supply is callable from another Soroban contract that holds the tokens. See README "After the hackathon" and PRD same heading.
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
- source_spec: `_bmad-output/implementation-artifacts/spec-1-5-cancelling-and-settling-a-booking.md`
  summary: Hard precondition for Epic 2/4 — both parties must have a live USDC trustline before a booking is created: the professional before approval, the client before they can lock a deposit.
  evidence: The escrow's payout traps if the recipient cannot receive the token (no trustline, authorization off, clawback), and after the deadline both `release` and the no-show path target the professional, so the deposit would be permanently stuck. Soroban cannot check a trustline cheaply, and an admin recovery path would break AD-2. The professional already needs the trustline for SEP-6 withdraw (Story 2.3), so making it a gate on provider approval (Epic 4) removes the failure mode entirely. Decided 2026-09-18.
  Widened 2026-09-18 after Story 1.5: two of the four settlement paths now pay the *client*, so the
  same trap applies to the client's trustline — and `cancel_by_professional`, the professional's only
  way to call a booking off, becomes uncallable if the client cannot receive. The client already needs
  the trustline to lock the deposit in the first place, so the gate belongs at booking creation.
