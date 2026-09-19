# Sprint Change Proposal — Cancellation outcome depends on who cancels

**Date:** 2026-09-18
**Trigger story:** Story 1.5 — Resolving a cancellation (`resolve_cancel`)
**Status:** awaiting approval
**Change scope:** Moderate — backlog reorganization across Epics 1–4, no MVP reduction

---

## 1. Issue Summary

**Problem.** FR7 decides the outcome of a booking that does not happen by comparing the ledger clock with `cancel_deadline` alone. That silently assumes every session that does not happen is the client's doing. It is not: if the *professional* cancels after the deadline, the deposit still goes to the professional. The client loses their money because the provider cancelled on them.

**Category:** Misunderstanding of original requirements. The gap is in the captured requirements, not in the implementation — there is no professional-cancels path anywhere in the PRD, the functional requirements, the architecture or any story.

**How it was discovered.** Story 1.5 was specified, implemented and passed its whole verification gate (54 tests, clean `wasm32v1-none` build, every I/O-matrix row covered, all ten of the verification layer's mutations caught). The four-layer review then surfaced three consequences of the clock-only model, and the underlying gap was identified when the model was examined against how cancellations actually work. The implementation was reverted and preserved at `_bmad-output/implementation-artifacts/spec-1-5-attempted-implementation.patch`; the spec is `blocked` with condition `intent gap`.

**Evidence.**

- `prd.md:58` — FR7: *"If the appointment does not happen, the contract decides by the cancellation deadline: refund to the client before it, transfer to the professional after it (late cancellation or no-show)."* The parenthetical names only client-side causes.
- `ARCHITECTURE-SPINE.md:51-55` — AD-2 makes `resolve_cancel` permissionless and clock-only.
- `prd.md:377` — Story 3.6 AC2 gives cancellation to the client only.
- A search across all planning artifacts for a provider-side cancellation returns nothing.
- Three further consequences of the same model, each confirmed against the source documents:
  - **Anyone can close a live booking.** `resolve_cancel` takes no authorization, so before the deadline any address can force a refund and terminally close a booking both parties intend to keep. AD-2's stated purpose ("the provider being stuck when a client no-shows") justifies only the post-deadline branch.
  - **`cancel_deadline` is not session time.** The UX defines it as the end of the free-cancellation window — `EXPERIENCE.md:145` *"full refund up to 24h before"*, `:62`, `:109`; `types.rs` *"before it the client may cancel for a refund"*. In the interval between the deadline and the session, `now > cancel_deadline` already holds, so a permissionless call pays out and marks the booking terminal up to a day before the session. `release` (Story 3.6 AC1) then returns `InvalidState` — the confirm path dies for every booking past its deadline.
  - **A no-show is indistinguishable from a held session.** Both emit `released` with identical topics and data. FR20 and Story 4.3 increase the verified-session counter on exactly that event, so a no-show would inflate the trust signal that story exists to protect.

---

## 2. Impact Analysis

### Epic Impact

| Epic | Impact |
|---|---|
| **Epic 1 — Foundation and Escrow Contract** | Story 1.5 redefined. Story 1.6's test scenarios extended. Stories 1.1–1.4 unaffected: `create_booking`, `release`, the `Booking` record, the error numbers and the `locked`/`released` event shapes all stand. No rollback. |
| **Epic 2 — Anchor Integration and Payment Rail** | The event worker consumes four money events instead of two. Story 2.5's data model carries who cancelled. |
| **Epic 3 — Marketplace and Booking Flow** | Story 3.6 gains a provider-side cancel action. Story 3.5's panel shows the new outcome. |
| **Epic 4 — Provider Onboarding and Trust** | Story 4.3 gains the provider's cancellation count. FR20's "only for bookings whose deposit was released" becomes literally true once the no-show emits its own event. |

No epic becomes obsolete, no new epic is needed, and the epic order does not change.

### Artifact Conflicts

- **PRD:** FR7 (rewrite), new FR23 (cancellation counter), Story 1.5 (rewrite), Story 1.6 (ACs), Story 3.6 (ACs), Story 4.3 (AC).
- **Architecture:** AD-2 (rewrite, title included — `resolve_cancel` no longer exists and nothing is permissionless), AD-4 (one sentence), the contract's file comment at `ARCHITECTURE-SPINE.md:188`.
- **UX:** `EXPERIENCE.md` — the cancellation copy at `:62-63` and `:124` assumes the client is always the canceller; a provider-cancelled state and its copy are missing. `DESIGN.md` — the verified-session badge gains a sibling counter.
- **Technical:** contract only. No data-model change on chain: `BookingState` stays `Locked` / `Released` / `Refunded`, because the *event* carries the reason and the state carries the destination. No change to the `Booking` struct, so Stories 1.2 and 1.3 stay as committed.

---

## 3. Recommended Approach

**Direct Adjustment** — modify stories within the existing plan.

| Option | Verdict |
|---|---|
| Direct Adjustment | **Selected.** Effort: Medium. Risk: Low. |
| Rollback | Not required. Story 1.5's code is already reverted and preserved as a patch; 1.1–1.4 rest on no part of the flawed model. |
| MVP Review | Not needed. The MVP is unchanged and gets stronger — the escrow stops paying professionals for sessions they cancelled. |

**Rationale.** The flaw was caught before anything was built on it. The contract's data model, three of its four functions and every committed story survive untouched. The cost is one story's re-specification plus acceptance-criteria edits in four other stories and two architecture decisions. Deferring it would be far more expensive: Epic 2's event worker and Epic 3's panel would both be built against a settlement model that has to change anyway, and the product would ship an escrow that pays a provider for cancelling.

---

## 4. Detailed Change Proposals

### 4.1 The new settlement model

The outcome is decided by **who signs**, not by the clock alone. `resolve_cancel` is replaced by three signed entry points:

| Function | Signer | Timing | Money goes to | State | Event |
|---|---|---|---|---|---|
| `release` *(Story 1.4, unchanged)* | client | any | professional | `Released` | `released` |
| `cancel_by_professional` | professional | any | client | `Refunded` | `cancelled` |
| `cancel_by_client` | client | `now <= cancel_deadline` | client | `Refunded` | `refunded` |
| `cancel_by_client` | client | `now > cancel_deadline` | professional | `Released` | `forfeited` |
| `claim_no_show` | professional | `now > cancel_deadline` only | professional | `Released` | `forfeited` |

All four events keep the established wire shape: topics `(name, booking_id)`, data `amount`. The backend derives everything it needs from the event name — verified sessions from `released` alone, provider cancellations from `cancelled` alone — with no payload-shape change and no new on-chain state.

**AD-2's purpose survives.** A no-show never strands the professional, because the professional claims it with their own signature instead of relying on anyone being able to call it. And no third party can touch a booking at all.

### 4.2 PRD

**FR7** (`prd.md:58`)

OLD:
> **FR7:** If the appointment does not happen, the contract decides by the cancellation deadline: refund to the client before it, transfer to the professional after it (late cancellation or no-show).

NEW:
> **FR7:** When an appointment does not happen, the outcome depends on who cancelled it. If the professional cancels, the full deposit is refunded to the client, whatever the time. If the client cancels before the cancellation deadline, the full deposit is refunded. If the client cancels after the deadline, or never shows up, the deposit is transferred to the professional.

*Rationale: the clock alone cannot tell whose fault a missed session is, and the old wording paid the professional for cancelling.*

**FR23** (new, after FR22)

> **FR23:** A professional's own cancellations are counted and shown on their profile beside the verified-session count. The platform applies no monetary penalty for them.

*Rationale: the escrow holds only the client's money, so a monetary penalty would need a collateral mechanism the MVP does not have. Reputation carries the deterrent instead.*

**Story 1.5** (`prd.md:214-222`) — retitled **"Cancelling and settling a booking"**

OLD acceptance criteria:
> 1. `resolve_cancel(booking_id)` compares the ledger timestamp with `cancel_deadline`.
> 2. If `now <= cancel_deadline` the amount is refunded to the client and the state becomes `Refunded`.
> 3. If `now > cancel_deadline` the amount is transferred to the professional and the state becomes `Released`.
> 4. It works only in the `Locked` state.
> 5. The matching event (`refunded` or `released`) is emitted.

NEW:
> **As a client** I want my money back when I cancel in time or when the professional cancels on me; **as a professional** I want the deposit when the client does not show up.
>
> 1. `cancel_by_professional(booking_id)` requires the professional's `require_auth`; it refunds the full amount to the client whatever the ledger timestamp, sets `Refunded` and emits `cancelled`.
> 2. `cancel_by_client(booking_id)` requires the client's `require_auth`. If `now <= cancel_deadline` it refunds the client, sets `Refunded` and emits `refunded`. If `now > cancel_deadline` it transfers to the professional, sets `Released` and emits `forfeited`.
> 3. `claim_no_show(booking_id)` requires the professional's `require_auth` and is rejected while `now <= cancel_deadline`; after it, it transfers to the professional, sets `Released` and emits `forfeited`.
> 4. All three work only in the `Locked` state; `Released` and `Refunded` stay terminal.
> 5. No path is callable without one of the two parties' authorization, and the backend's signing key calls none of them.
> 6. `released` is emitted by `release` alone, so a no-show can never be counted as a held session.

**Story 1.6** (`prd.md:231`) — add to the acceptance criteria:
> 6. The professional-cancels scenario is tested: the client's balance returns in full, before and after the deadline alike.
> 7. The late client cancellation and the no-show claim are tested; both pay the professional and emit `forfeited`.
> 8. Every settlement path is tested for rejection when the wrong party signs, and when nobody signs.

**Story 3.6** (`prd.md:376-379`) — add:
> 5. The professional can cancel a booking from the provider panel; the client is refunded in full and told the professional cancelled.
> 6. Before either party confirms a cancellation, the outcome implied by their role and the deadline is stated in words.

**Story 4.3** (`prd.md:438-442`) — add:
> 5. The professional's own cancellation count is shown beside the verified-session count; it increases only on the contract's `cancelled` event.

### 4.3 Architecture

**AD-2** (`ARCHITECTURE-SPINE.md:51-55`) — retitled **"AD-2 — On-chain authority: every money path is signed by the party it serves"**

OLD rule:
> `release(booking_id)` requires the client's `require_auth`. `resolve_cancel(booking_id)` requires no authorization; its outcome is decided solely by comparing `ledger.timestamp` with `cancel_deadline`. The backend's signing key may not call any deposit function.

NEW rule:
> Every deposit function is authorized by the party it serves. `release` and `cancel_by_client` require the client's `require_auth`; `cancel_by_professional` and `claim_no_show` require the professional's. No deposit function is permissionless, and the backend's signing key may call none of them. The clock is a condition inside the signed paths, never the sole decider: it gates when a late cancellation forfeits and when a no-show may be claimed.

Also update **Prevents:** to *"The backend moving money on a user's behalf; a third party closing a booking neither party asked to close; a professional being paid for a session they cancelled themselves; the provider being stuck when a client no-shows."*

**AD-4** (`ARCHITECTURE-SPINE.md:67`) — extend the `verified_sessions` sentence:
> …only ever incremented by a `released` event (AD-1) and never written by hand. A no-show emits `forfeited`, not `released`, so it never reaches the counter. The provider's own cancellation count is incremented by `cancelled` events on the same terms.

**`ARCHITECTURE-SPINE.md:188`** — the contract's file comment: `create/release/resolve_cancel` becomes `create/release/cancel/claim_no_show`.

### 4.4 UX

**`EXPERIENCE.md:62-63`** — the cancellation copy table covers only the client's own cancellation. Add the provider-cancelled line, in the same voice:
> | "Dr. Aydın cancelled this session. All 600.00 TRY is on its way back to you." | "Booking cancelled by provider. Refund issued." |

**`EXPERIENCE.md:124`** ("Cancelling") — extend so the rule covers both parties: the provider's confirmation states that the client will be refunded in full and that the cancellation will show on their profile.

**`DESIGN.md:232`** — the verified-session badge gains a sibling: the provider's cancellation count, shown with the same restraint and never as the louder number.

---

## 5. Implementation Handoff

**Scope: Moderate.** Backlog reorganization across four epics; no fundamental replan, no MVP change.

| Recipient | Responsibility |
|---|---|
| PRD / planning | Apply §4.2 to `prd.md`: FR7, new FR23, Story 1.5 rewrite, ACs on 1.6, 3.6, 4.3. |
| Architecture | Apply §4.3 to `ARCHITECTURE-SPINE.md`: AD-2 rewrite, AD-4 sentence, the file-comment line. |
| UX | Apply §4.4 to `EXPERIENCE.md` and `DESIGN.md`. |
| Developer (build) | Re-plan and re-implement Story 1.5 from the new intent. The reverted attempt at `spec-1-5-attempted-implementation.patch` is a reference for the parts that survive — the transfer/write/emit order, the storage and event reuse, the terminal-state guard and most of the test scaffolding. |
| Epic 2 (later) | Story 2.5's booking record carries the cancellation reason; the event worker handles four money events. |

**Success criteria.**

1. No deposit function is callable by anyone but the client or the professional, and a test proves it for each path.
2. A professional's cancellation refunds the client in full, before and after the deadline alike.
3. `released` originates only from `release`, so the verified-session counter cannot be inflated by a no-show.
4. `cargo test` passes and the `wasm32v1-none` build is warning-free.
5. FR7, AD-2 and the affected story acceptance criteria no longer contradict the contract.

**Out of scope, recorded elsewhere.** A live USDC trustline is a hard precondition of provider approval (Epic 2/4) — logged in `deferred-work.md`, no contract change.
