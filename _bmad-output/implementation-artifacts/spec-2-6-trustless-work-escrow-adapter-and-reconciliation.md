---
title: 'Story 2.6 — Trustless Work escrow adapter and reconciliation'
type: 'feature'
created: '2026-09-19'
status: 'in-progress'
review_loop_iteration: 0
baseline_revision: '0b91e9866b8f07966d391a62f4ca875228be1c90'
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-8-trustless-work-appointment-compatibility.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Story 2.5's `backend/src/chain/` is hardwired to the custom contract's five functions and is now superseded — nothing in the backend can move money through Trustless Work, the pivoted runtime. No vendor-neutral boundary exists either; `services/booking.ts` imports `chain/client.ts` directly, so today's code names a contract that will not be deployed.

**Approach:** Define the vendor-neutral escrow boundary AD-8 requires, and populate it with a Trustless Work adapter built on Story 1.8's settled findings — the role map, the "no automatic deadline" classification, the audit's two open findings. Reuse Story 2.5's event-worker shape (cursor, dedupe-by-key, two independent state columns) for the reconciler, retargeted from Soroban's `getEvents` to Trustless Work's indexer. `services/booking.ts` moves onto the new boundary; `chain/` stays in the tree as a record of the pre-pivot design, called by nothing.

## Boundaries & Constraints

**Always:**
- **One adapter, one interface.** All Trustless Work REST/XDR/indexer calls go through `backend/src/escrow/trustless-work/`, behind a vendor-neutral `EscrowAdapter` interface at `backend/src/escrow/interface.ts` that `services/booking.ts` depends on — never the vendor's own types. This interface does not exist yet; this story creates it.
- **Unsigned XDR only to the assigned signer** (AC2). Every mutate call (`deployEscrow`, `fundEscrow`, `approveMilestones`, `releaseFunds`, `startDispute`, `resolveDispute`) returns an unsigned XDR string; the adapter never holds or requests a private key itself, matching `chain/client.ts`'s and `anchor/sep10.ts`'s existing pattern of taking a `Keypair` (or, for a managed account, whichever key the caller already resolved) as an explicit parameter.
- **Role map from Story 1.8, applied exactly:** Funder = client wallet, Approver = client wallet, Service Provider = provider wallet, Release Signer = provider wallet (self-claim), Receiver = provider wallet, Platform = Pactly, Dispute Resolver = Pactly. `engagementId` in every deploy payload is Pactly's own `booking_id` (AD-13) — the join key between the Trustless Work escrow and Pactly's own booking row, exactly as `bookingId` already is for the custom contract.
- **No automatic settlement, ever implied.** Every code path and doc comment that touches a cancellation, late-cancellation or no-show state must read as what Story 1.8 confirmed: an explicit signed dispute resolution Pactly itself performs as Dispute Resolver, never a deadline the protocol enforces on its own.
- **Booking money state is chain-derived only** (AD-1, unchanged from Story 2.5): `escrow_state` is written only by the reconciler, after Trustless Work evidence is processed; on conflict, chain wins. `balance_state` stays a separate column, untouched by this story.
- **Reconciliation is cursored and idempotent** (AC4, AD-9): the reconciler stores its own cursor, dedupes by `(transactionHash, lifecycleAction)`, and resumes from the stored cursor on restart — the same three guarantees Story 2.5's event-worker already proved for the old model, now sourced from Trustless Work's `listEscrowEvents`/GraphQL instead of Soroban's `getEvents`.
- **Raw errors never escape the adapter** (AC5). Trustless Work's REST error codes (`auth-credential-missing`, `escrow-platform-fee-too-high`, etc.) and any GraphQL error are translated into typed application errors at the adapter boundary, mirroring `chain/errors.ts`'s and `anchor/errors.ts`'s established shape — no raw SDK error, no raw HTTP body, ever reaches a service or a route.
- **Amount and id boundary conversions are explicit and tested.** The SDK's own payload types use `amount: number` (confirmed by reading `@trustless-work/escrow-js`'s `types.payload.ts` directly) where Pactly's own convention (AD-7) is an integer string. The adapter is the one place this conversion happens, with an explicit range check before crossing into `number` — never a silent `Number(bigString)`.
- **The protocol-version decision is recorded, not silently made.** `@trustless-work/escrow-js` (`1.0.0-beta.1`) targets Trustless Work's **Core v2** API — its own `Roles` type uses arrays (`approvers: string[]`, `releaseSigners: string[]`, `disputeResolvers: string[]`), a threshold model, not V1's single-address-per-role semantics the audit report and Story 1.8's role map assumed. This story builds against **V2 via the SDK**, because it is the only path with real, checkable TypeScript types available without a live key — every array this story constructs holds exactly one address per role, matching the 1-to-1 map, so the code is forward-compatible with a true multi-signer configuration later without being one today. If Story 1.8's still-blocked live ACs (once the operator's API key arrives) find the operator's actual account is V1-scoped, that is a follow-up finding for this story's own triage, not something to guess around now.
- **Testing surface, stated explicitly, because every prior story's worst gaps were here:** every adapter function's success path is tested (an unsigned XDR is returned, correctly shaped, for a payload built with the right roles/amount/engagementId), not only its refusals. The reconciler's cursor-advance-on-duplicate-batch and restart-resumes-from-cursor behavior get their own tests at the batch level, not only the single-event level (Story 2.5's own review found exactly this gap). Every Trustless Work network call sits behind an injectable seam defaulting to `TrustlessWorkClient`; no test and no code path built in this story reaches `dev.api.trustlesswork.com`.

**Never:**
- Do not call the real Trustless Work API, or the real Soroban RPC, while building this story — no API key exists in this session. Every seam is written and unit-tested against injected responses.
- Do not delete, rewrite, or stop testing `backend/src/chain/`. It is superseded, not wrong — its own review history stands. Only its one caller (`services/booking.ts`'s `lockDeposit`) moves off it.
- Do not implement `updateEscrow`. The audit's [A04] finding — `update_escrow` skips the validation `initialize_escrow` runs — is only partially fixed upstream; this story has no task that needs updating an escrow after deployment, so the finding is moot by not calling the function at all, not by re-validating it ourselves.
- Do not construct a non-positive-amount `initialize`/`deploy` payload under any circumstance — the adapter refuses before ever calling the SDK, closing [A06]'s residual risk for Pactly's own traffic without needing the upstream fix.
- Do not build the SEP-38/SEP-6 flows (2.2–2.4), the booking-hold/routes (Epic 3), or role-based admin authorization (AD-12, Epic 4). This story stops at the adapter and the reconciler.
- Do not claim "audited infrastructure" anywhere in a doc comment or log message without naming the audited commit and the confirmed 114-commit drift — if the sentence doesn't fit, cut it rather than leave it unqualified.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Escrow deployed | A booking hold, client as funder/approver, provider as service-provider/release-signer/receiver | Unsigned deploy XDR returned; `engagementId` is the booking id; single milestone, `approvalsTarget: 1` | No error expected |
| Escrow funded | A deployed escrow, client signs | Unsigned fund XDR returned for the client's signature | No error expected |
| Session approved | Client signs approval | Unsigned approve XDR; milestone marked approved once submitted | No error expected |
| Provider self-claims | Provider signs release (release signer = receiver) | Unsigned release XDR for the provider's own signature | No error expected |
| Dispute opened | Provider or client-as-approver raises it (cancellation, no-show, disagreement) | Unsigned start-dispute XDR | No error expected |
| Dispute resolved | Pactly, as Dispute Resolver, signs an allocation | Unsigned resolve-dispute XDR naming addresses and amounts | No error expected |
| Non-positive amount | Adapter asked to deploy with `amount <= 0` | Refused before any SDK call | Typed `EscrowConfigError`, no request sent |
| Amount exceeds safe range | An integer string the adapter cannot safely narrow to `number` | Refused before any SDK call | Typed `EscrowConfigError` naming the value |
| Trustless Work call rejected | The API returns a typed error (e.g. `escrow-platform-fee-too-high`) | Translated to a typed `EscrowApiError` naming the condition | No raw HTTP body ever surfaces |
| Trustless Work unreachable | Network/timeout failure | Translated to a typed `EscrowRequestError` | No raw fetch/axios error escapes |
| Event batch mirrored | A funded/approved/released/disputed evidence batch for a known booking | `escrow_state` updated to match; cursor advances | No error expected |
| Same batch replayed | The same `(transactionHash, lifecycleAction)` pairs redelivered | Nothing changes; no duplicate row; cursor still advances | No error expected |
| Reconciler restarted | A stored cursor exists | Resumes from the cursor, not from the beginning | No error expected |
| Evidence for unknown booking | A transaction/event whose `engagementId` has no matching row | Recorded as an anomaly; no row invented; reconciler continues | Logged, batch continues |

</intent-contract>

## Code Map

- `backend/src/chain/client.ts`, `chain/errors.ts` -- the pattern to mirror exactly, not reuse: injectable `ChainCallDeps`-shaped seams defaulting to the real implementation, typed error classes per failure kind, a private `invoke`-style core every exported function funnels through. Read-only; do not modify.
- `backend/src/anchor/sep10.ts`, `anchor/errors.ts` -- the second working instance of the same pattern, plus the account-identity and replay lessons from Story 2.1's review (verify identity fields the SDK returns rather than discarding them; never trust a response shape you haven't checked against the real types). Read-only.
- `backend/src/chain/event-worker.ts`, `db/cursor.ts`, `db/processedEvents.ts` -- the reconciler shape to retarget, not rebuild: `processEvent`/`runEventWorkerOnce`, the atomic dedupe-insert-plus-state-write transaction (added in Story 2.1's era of fixes — actually landed in Story 2.5's own patch round), the cursor table. The dedupe key changes from `(booking_id, event_type)` to `(transaction_hash, lifecycle_action)`; the event source changes from `FetchEvents`/Soroban `getEvents` to a new `FetchEscrowEvidence` seam over Trustless Work's `listEscrowEvents`/GraphQL. Read fully before writing the new version.
- `backend/src/services/booking.ts` -- `lockDeposit`'s one call to `chain.createBooking` (line ~107) is this story's one required call-site change: it moves to the new `EscrowAdapter`'s deploy+fund calls. `createBookingHold`, `getBooking`, `setBalanceState` are untouched.
- `backend/src/db/schema.ts`, `migrations.ts` -- `bookings.escrowState`/`balanceState` need no schema change (the three-value `EscrowState` enum already covers Trustless Work's funded/approved/released/disputed lifecycle by mapping down to locked/released/refunded, the same way Story 1.5's `forfeited`/`cancelled` distinction was preserved in `processed_events.event_type` rather than in the state column). Add the reconciler's own cursor/dedupe tables (or extend the existing `event_worker_state`/`processed_events` shape — decide based on whether one cursor table can serve both the old Soroban worker and this one, or whether they need to stay separate since `chain/`'s worker is dead code no process calls).
- **SDK reference, read the real published types, not this spec's paraphrase:** `@trustless-work/escrow-js@1.0.0-beta.1` — `src/types/types.payload.ts` (`DeploySingleReleaseEscrowPayload`: `{signer, engagementId, title, description, amount, platformFee, roles, milestones: [{description, approvalsTarget}], trustline}`), `src/types/types.entity.ts` (`Roles`: `{approvers: string[], serviceProviders: string[], platform: string, releaseSigners: string[], disputeResolvers: string[], receiver: string, admin: string, observers?: string[]}`), `src/client.ts` (`TrustlessWorkClient({baseURL, apiKey})`, `.rest.*`/`.graphql.*`). Deploy takes `AttributionHeaders` (`platformId`/`subjectId` → `X-TW-Platform`/`X-TW-Subject`) — resolve what Pactly's own `platformId` is (likely a value the operator's TW account provides, not invented here) before this story can be considered complete; if unknown, treat it as a `config.ts` variable with an empty placeholder, same convention as every other not-yet-populated secret in `.env.example`.
- `spec-1-8-trustless-work-appointment-compatibility.md` -- the authoritative source for the role map, the AC7 classification, the audit findings and the drift measurement. Cite it, don't re-derive it.

## Tasks & Acceptance

**Execution:**
- `backend/src/escrow/interface.ts` -- the vendor-neutral `EscrowAdapter` type: `deploy`, `fund`, `approve`, `release`, `startDispute`, `resolveDispute`, each taking Pactly-native types (booking id, amount as a string, addresses) and returning an unsigned XDR string plus whatever identifiers the caller needs to track it -- so `services/` never imports a Trustless Work type directly.
- `backend/src/escrow/trustless-work/client.ts`, `errors.ts` -- the adapter implementation: one `TrustlessWorkClient` construction behind an injectable seam, the six calls above, amount/id boundary conversion with the non-positive/out-of-range refusals, and error translation for every documented TW error code this story's matrix names.
- `backend/src/escrow/trustless-work/reconciler.ts` -- retargets Story 2.5's event-worker shape onto Trustless Work evidence: `(transactionHash, lifecycleAction)` dedupe, the same atomic dedupe-then-state-write transaction, the same cursor persistence.
- `backend/src/db/schema.ts`, `migrations.ts` -- whatever cursor/dedupe storage the reconciler needs, decided against the existing tables per the Code Map note above.
- `backend/src/services/booking.ts` -- `lockDeposit` calls the new adapter's `deploy`+`fund` instead of `chain.createBooking`.
- `backend/src/config.ts`, `.env.example` -- `TRUSTLESS_WORK_API_URL` (testnet default `https://dev.api.trustlesswork.com`), `TRUSTLESS_WORK_API_KEY`, `TRUSTLESS_WORK_PLATFORM_ID`, and whichever of Pactly's own role addresses (platform, dispute resolver) the adapter signs with -- all `declared()` empty until Story 1.8's blocked ACs are unblocked, matching `ESCROW_CONTRACT_ID`'s existing precedent.
- `backend/test/` -- one test file per new module, covering every matrix row's success path explicitly, plus the batch-level cursor/restart/replay tests the reconciler's own history (Story 2.5's review) says not to skip.

**Acceptance Criteria:**
- Given a booking ready to lock, when `lockDeposit` runs, then it calls the `EscrowAdapter`, not `chain/client.ts`, and the returned unsigned XDR names the client as both funder and approver, the provider as service provider/release signer/receiver, and Pactly as platform/dispute resolver.
- Given a non-positive amount, when a deploy is attempted, then it is refused before any network seam is invoked.
- Given a batch of Trustless Work evidence, when the reconciler runs it twice, then the second run changes nothing observable and the cursor still advances.
- Given any Trustless Work failure shape (API error, network failure), when the adapter returns, then the caller receives a typed error naming the condition, never a raw body or stack trace.
- Given the backend workspace, when `npm run -w backend typecheck`, `test` and `build` run, then all three are clean and every matrix row — including every success path — has a passing test.

## Spec Change Log

## Review Triage Log

## Design Notes

- **Why this is one story and not two, despite the size.** The adapter (AC1/2/5) and the reconciler (AC3/4) share one boundary: `services/booking.ts` needs both to exist before `lockDeposit` can move off `chain/`, and the reconciler's dedupe/cursor shape is a near-direct retarget of code Story 2.5 already wrote and reviewed, not new design. Splitting would leave a story that "adds an adapter nothing calls" or "reconciles events nothing produces" — worse than one bounded story that reuses proven shapes throughout.
- **Why `chain/` stays in the tree.** It is reviewed, tested, working code against a contract that is not being deployed for this MVP — not a mistake to clean up, a record of the pre-pivot design the proposal itself says to preserve ("no completed history is erased"). Deleting it would also delete Story 2.5's own review triage log's evidentiary value.
- **Why the protocol-version choice (V1 REST vs. V2 SDK) is recorded rather than resolved by testing.** No live key exists to test either. The V2 SDK is the only path with real, machine-checked types available right now; building the array-shaped roles the SDK's types demand, with exactly one address per array slot, costs nothing today and loses nothing if the operator's actual account turns out to be V1-scoped — the interface layer (`escrow/interface.ts`) is what absorbs that risk, not `services/`.
- **Why the dispute-resolver concession is written into the constraints, not left implicit.** AD-2 requires it named explicitly wherever Pactly itself signs. This is the story where that signature first appears in code, so it is the story where the doc comments must say so plainly.

## Verification

**Commands:**
- `npm run -w backend typecheck` -- expected: clean
- `npm run -w backend test` -- expected: all pass, including every matrix success path and the reconciler's batch-level tests
- `npm run -w backend build` -- expected: clean
- `npm test` (root) -- expected: contract tests, backend tests and scripts tests all pass

**Manual checks:**
- `git grep` for a call to `chain.createBooking` outside `chain/`'s own tests: no hits after `services/booking.ts`'s change.
- `git grep` for `amount:` followed by a bare `Number(` conversion without a preceding range check, in `escrow/trustless-work/`: no hits.
- **Not run:** no real call to `dev.api.trustlesswork.com`, no real Soroban RPC call.
