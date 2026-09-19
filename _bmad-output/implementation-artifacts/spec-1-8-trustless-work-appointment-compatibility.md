---
title: 'Story 1.8 — Trustless Work appointment compatibility'
type: 'spike'
created: '2026-09-19'
status: 'blocked'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/planning-artifacts/sprint-change-proposal-2026-09-19.md'
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** The sprint change proposal replaces Pactly's custom Soroban contract with Trustless Work, but adopting a generic milestone-escrow platform for an appointment product is not a package swap — its documented lifecycle does not obviously prove automatic appointment deadlines, cancellation refunds or no-show forfeiture the way the custom contract did. Building Epic 2/3 against unverified assumptions risks a demo that claims behavior the platform doesn't have.

**Approach:** A time-boxed compatibility spike, not a feature. Document Trustless Work's real role model, lifecycle and constraints from its own sources (docs, audit report, live repository state); where a claim can be settled by reading and cross-checking without touching the network, settle it now; where it genuinely requires a live testnet exercise (funding, signing, releasing, disputing), name exactly what's needed and stop rather than assume. End with one explicit decision: which user-facing claims about automatic settlement Pactly may honestly make.

## Boundaries & Constraints

**Always:**
- Every factual claim about Trustless Work is sourced — a documentation URL, an audit report page, a specific commit — never inferred from how escrow systems "usually" work.
- Distinguish official Trustless Work sources (docs.trustlesswork.com, their own GitHub org, their own audit report) from third-party material (other projects' repos, unrelated GitHub issues) that happens to surface in a search. A third party's feature request is not Trustless Work's documented behavior.
- Classify AC7 (deadline-based automatic settlement) as one of exactly three values — supported, externally orchestrated, or unsupported — argued from the platform's own lifecycle documentation, not assumed.
- The role map (AC2) is a real trust-model decision, not a technical detail: name explicitly wherever Pactly itself ends up holding a role (platform, release signer, dispute resolver), per AD-2's rule that a Pactly-controlled signer must be documented as a trust assumption, never described as trustless.

**Never:**
- Do not execute a real testnet transaction (fund, approve, release, dispute) without the operator's own Trustless Work API key and explicit go-ahead — this spike started without one, by the user's own choice, so ACs 1/3/4/5 and the live parts of AC6 stay blocked on that credential rather than being skipped silently.
- Do not write application code against Trustless Work yet (no `backend/src/escrow/trustless-work/` adapter) — that is Story 2.6's job, gated on this story's go/no-go.
- Do not claim "audited infrastructure" without version-qualifying it — the audit's scope is a specific commit, and the live repository has moved since.

## I/O & Edge-Case Matrix

_Not applicable — this story produces findings and a decision, not a tested code path._

</intent-contract>

## Code Map

_Not applicable yet. Story 2.6 will need:_
- `@trustless-work/escrow-js` (npm, `1.0.0-beta.1` as of this writing) — the official JS/TS client; likely the right foundation for AD-8's single adapter, given it already handles unsigned-XDR construction, rather than hand-rolling REST calls.
- `backend/src/config.ts` — will need `TRUSTLESS_WORK_API_URL`, `TRUSTLESS_WORK_API_KEY`, `TRUSTLESS_WORK_NETWORK`, the asset (USDC) contract id, the platform address, and whichever role addresses Pactly itself holds (see the role map below).

## Findings by Acceptance Criterion

### AC1 — Initialize and fund a testnet single-release escrow with USDC

**Blocked — needs the operator's API key.** What's confirmed without one:
- Testnet base URL: `https://dev.api.trustlesswork.com`. Mainnet: `https://api.trustlesswork.com`.
- An API key is required for programmatic access, obtained by connecting a Stellar wallet at `dapp.trustlesswork.com`, signing to prove ownership, then generating a key from the BackOffice Settings page. No account/key is needed to browse the dApp itself.
- Testnet USDC: fund via the Circle faucet (`faucet.circle.com`, select Stellar), after establishing a trustline. Circle's testnet issuer: `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`.
- The single-release contract's current testnet-deployed address/commit was not checked — this is itself part of what AC1's live exercise must confirm, since (see AC6) the public repository has moved substantially past the audited commit and the docs don't publish a testnet contract id.

### AC2 — Pactly's seven role assignments, documented

Trustless Work actually defines **nine** roles (source: [Understanding Roles in Trustless Work](https://www.trustlesswork.com/escrow-times/tutorial-roles)); the PRD's FR24 names seven of them. Proposed mapping, argued below — **this is a product/trust decision for the user to confirm, not a technical default**:

| Trustless Work role | Pactly assignment | Why |
|---|---|---|
| Funder | The client's own wallet | They sign "Lock with Pactly"; matches FR3 exactly. |
| Service Provider | The provider's wallet | Marks the appointment complete; may raise a dispute. |
| Approver | The client's own wallet | Confirms the session happened — mirrors the custom contract's `release()`, which also needed the client's signature. Keeps the happy path genuinely client-controlled. |
| Release Signer | The provider's own wallet (self-claim mode) | The docs describe a "claim model" where "the receiver is also the release signer, meaning they can claim their own funds." Once the client approves, the provider claims their own payout — no extra Pactly signature needed for the happy path. |
| Receiver | The provider's wallet | Gets the payout. |
| Platform Address | Pactly | Collects the platform fee automatically; updates escrow metadata pre-funding. |
| Dispute Resolver | Pactly | **Trust assumption, named explicitly per AD-2.** No neutral third party exists in this MVP. A cancellation, a no-show, or a disagreement all land here, and Pactly decides the allocation. |
| *(Issuer, Observer — not in FR24)* | Not assigned / read-only | Issuer is "factual, not functional"; Observer is read-only. Neither needs a Pactly-side decision. |

Consequence worth stating plainly: **Pactly is the Dispute Resolver**, and because AC7 finds no automatic deadline enforcement, *every* cancellation, late cancellation and no-show that isn't self-resolved by the client approving in time runs through Pactly's own dispute decision. This is the single largest departure from the custom contract's model, where the deadline comparison — not a Pactly-held key — decided the outcome.

### AC3 / AC4 — Complete → approve → release, and dispute → resolve, end to end

**Blocked — needs the operator's API key and a funded testnet escrow (AC1).** What's confirmed from the lifecycle documentation without executing anything:
- Release always requires the Release Signer's explicit signed transaction ([Release Phase](https://docs.trustlesswork.com/trustless-work/introduction/technology-overview/escrow-lifecycle/release-phase)) — no code path releases funds without one.
- A dispute may be opened by either the Service Provider or the Approver; only the Dispute Resolver's signed transaction can resolve it, and the resolution can route funds to an arbitrary list of addresses/amounts (not limited to a binary split) ([Dispute Resolution](https://docs.trustlesswork.com/trustless-work/introduction/technology-overview/escrow-lifecycle/dispute-resolution)).
- Both mechanisms are entirely manual/discretionary at the protocol level — see AC7 below.

### AC5 — Signature and transaction counts, wallet vs. managed-account paths

**Blocked — needs a live exercise.** Reasoning from the role map above, before execution: a wallet-paying client's happy path needs at minimum two client signatures (fund, approve) and one provider signature (claim/release) — three total, across at least two parties, before any Pactly signature is needed. A no-show/dispute path adds at least one Pactly (Dispute Resolver) signature. The managed-account path (AD-6) needs the same shape, but Pactly signs on the managed account's behalf for whichever of Funder/Approver that account holds. Exact transaction counts (does each role-action require its own submitted transaction, or can any be batched?) were not determined from documentation and need the live exercise.

### AC6 — Fees, indexer visibility, API limits, authentication, contract revision, audit coverage

- **Fees:** a protocol fee starting at 0.3%, deducted when funds release, is charged by Trustless Work on top of whatever platform fee Pactly itself configures. Both are separate line items.
- **API authentication:** API key, obtained as described under AC1. The docs' error catalogue names `auth-credential-missing`, `auth-invalid-credential`, `auth-insufficient-role`, and `api-key-limit-reached` — the last implies a rate/quota ceiling whose actual number was not found in the public docs and needs confirming with a real key.
- **Contract revision and audit coverage — the load-bearing finding of this story:**
  - Runtime Verification Inc. audited Trustless Work's contracts between **August 5 and September 12, 2025**, report delivered **November 7, 2025**. Scope: the single-release escrow contract at commit `5d4669d69ecdf1a8c788b5e644078f797f818850` (branch `develop`), a separate multi-release contract at commit `68d9a9920a50a60223ec85c20400ee8af72d6e4e`, and the TypeScript orchestration backend at commit `8087379c690324185aeaf24e14a4d1f39aef840b`. ([Audit report PDF](https://www.trustlesswork.com/20251107%20Trustless%20Work%20Audit%20Report.pdf))
  - Nine main findings (A01–A09), seven of them **High** or **Medium** severity. Seven were fully addressed and re-verified by the auditor before the report was finalized. **Two High-severity findings were only partially addressed as of the report:**
    - **[A04]** `update_escrow` runs none of the validation `initialize_escrow` enforces — an escrow can be updated after creation to exceed 10 milestones or have a zero amount, states the initialization path exists specifically to prevent. The client's fix used a separate validation function rather than reusing the original one, which the auditor flagged as still divergence-prone.
    - **[A06]** Several `i128` fields (`platform_fee`, `amount`, dispute-resolution amounts, milestone indices) lack sign checks. The most concrete residual risk for Pactly: an escrow can still be *initialized* with a negative `amount`, which the report states would permanently lock funds once deposited, because `release_funds`/`resolve_dispute` would revert on the negative transfer.
  - **Repository drift since the audit, checked directly against GitHub:** the audited commit (July 7, 2025) sits on `single-release-develop`, which is now **114 commits ahead**, most recently on **September 15, 2026** (`fix: freeze milestone status changes once escrow is released or resolved` — a state-machine change, not a refactor). The more conservative `single-release-main` branch is less drifted but still moved as recently as May 20, 2026 (a `soroban-sdk` version bump to 26.0.0). **Neither branch's current HEAD has been re-audited.** Whichever commit Pactly actually deploys against must be pinned and checked individually — assuming either "the audited commit" or "whatever's on `main` today" is safe would be exactly the unqualified claim the proposal's own risk #4 warns against.
  - The JS/TS SDK (`@trustless-work/escrow-js`) is at `1.0.0-beta.1`, last published 8 days before this research (Sep 11, 2026), with no adoption signal (0 GitHub stars). Consistent with the "V2 beta" framing found across the docs — this is genuinely early tooling, not a mature integration path.
- **Indexer visibility:** not checked — needs a live escrow to query.

### AC7 — Deadline-based automatic refund/no-show: classify as supported, externally orchestrated, or unsupported

**Unsupported at the protocol level.** Read directly from Trustless Work's own lifecycle documentation, which states plainly that a release always requires the Release Signer's explicit signature and a dispute always requires the Dispute Resolver's explicit signature — no time-based trigger releases or reallocates funds on its own. (An earlier search surfaced a `claim_after_deadline` proposal, but it belongs to an unrelated third-party project's own contract fork, not Trustless Work — excluded as a source per this story's own sourcing rule.)

Consequence: everything the custom contract's `cancel_by_client`/`cancel_by_professional`/`claim_no_show` did automatically by comparing the ledger clock to `cancel_deadline` has no equivalent here. Under this story's proposed role map, all of it becomes a **dispute Pactly itself resolves**, using the same policy language the product already shows the user ("cancel before Sep 17, 2:00 PM and the deposit returns in full") — but enforced by Pactly's own signature, not the contract. This is exactly the gap the proposal's Option 3 anticipated ("describe cancellation and no-show as dispute/resolution paths until automatic appointment rules are proven") — it is now confirmed, not merely anticipated.

### AC8 — Go/no-go decision

**Provisional go, on the happy path only — pending the blocked live-execution ACs above.**

What can be said today: Trustless Work's role model maps cleanly onto Pactly's seven actors, the happy path (fund → approve → claim) is well-documented and needs no Pactly signature, and the audit found no unresolved critical/High finding that blocks a **funded, positive-amount, single-release escrow** — [A04]/[A06]'s residual risk is specifically about a negative or malformed initialization, which Pactly's own backend can refuse to construct in the first place (matching AD-7's "no floats, integer-safe amount handling" — extend it to "never build an `initialize_escrow` payload with a non-positive amount," and this becomes moot for Pactly's own traffic).

What is not yet decided, because it needs the operator's credential: whether the currently-deployed testnet contract behaves as documented (AC1/3/4/5), the real signature/transaction count and UX cost of the happy path (AC5), and indexer/rate-limit behavior (part of AC6).

**User-facing claims this story clears Pactly to make once 2.6 ships the happy path:**
- "Escrow powered by Trustless Work on Stellar," with a real transaction/contract link (FR25) — true and verifiable.
- The deposit is held by neither Pactly nor the provider until release (FR3) — true; Funder has no signing authority per the role model.

**User-facing claims this story explicitly forbids**, per the proposal's own constraint and AC7's finding:
- Any wording implying the contract *automatically* enforces the cancellation deadline, refunds early cancellations, or forfeits a no-show deposit. All of that is Pactly's own dispute decision under the proposed role map, not the protocol's.
- "Audited infrastructure" without naming the commit/date, given the confirmed drift above.

## Verification

**Commands:** none — this story produced no code.

**Manual checks performed:**
- Every URL cited above was fetched directly (not taken from a search snippet alone) before being used as evidence.
- The audit PDF was downloaded and its text extracted locally (`pypdf`) rather than summarized from a search result, so severity/status lines are quoted from the source, not inferred.
- Repository drift was measured with `gh api .../compare/<audited-sha>...<branch>`, not estimated from commit dates alone.

**Not run:** no Trustless Work API call of any kind (no key available); no testnet transaction of any kind.

## Auto Run Result

Status: blocked
Blocking condition: needs a Trustless Work API key and the operator's go-ahead to execute real testnet transactions (fund, approve, release, dispute) for ACs 1, 3, 4, 5 and the live half of AC6.

Everything answerable from Trustless Work's own documentation, audit report and public repository — without touching the network — is answered above, each with its source. The single most consequential finding: **AC7 is unsupported**, confirmed from the platform's own lifecycle docs, not assumed — so the proposal's cautious Option 3 framing was correct, and no automatic settlement claim may ship. The second: **two High-severity audit findings are only partially fixed**, and the branch Pactly would actually deploy from is 114 commits past what was audited, most recently by a state-machine change eleven days ago — so "audited infrastructure" needs a version-qualified sentence, and whichever commit gets deployed needs its own check against these two findings specifically, not an assumption that the audit covers it.

Provisional go/no-go: **go, scoped to the happy path**, with the dispute-resolver trust concession named plainly rather than hidden. Story 2.6 can begin adapter work against this role map and this AC7 classification. The remaining blocked ACs are the operator's to unblock with a credential, not a further research task.
