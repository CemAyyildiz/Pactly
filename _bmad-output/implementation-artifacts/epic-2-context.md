# Epic 2 Context: Anchor Integration and Payment Rail

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Build the local-currency leg and the Trustless Work escrow integration boundary now that Trustless Work is the pivoted runtime (replacing the custom Soroban contract). By the end of this epic a user authenticates with a wallet signature, sees a live USDC↔local-currency quote, funds a Trustless Work escrow through one adapter, and cashes out a released deposit in local currency. The epic's central unfinished work is Story 2.6: replace Story 2.5's now-superseded custom chain client with a Trustless Work adapter and reconciler, built against Story 1.8's settled findings, so Epic 3 keeps a single Pactly API regardless of escrow vendor.

## Stories

- Story 2.1: SEP-1 discovery and SEP-10 authentication
- Story 2.2: SEP-38 quote
- Story 2.3: SEP-6 withdraw (professional cashing out)
- Story 2.4: SEP-6 deposit (client paying in local currency)
- Story 2.5: Backend service layer and data model
- Story 2.6: Trustless Work escrow adapter and reconciliation

## Course Correction — 2026-09-19

- Story 2.1 already shipped and is unaffected by the pivot (SEP-10 auth has nothing to do with the escrow runtime).
- Story 2.5 already shipped against the old custom-contract model; its data model and service-layer conventions (one escrow interface, idempotent evidence consumption) remain the base, but its `backend/src/chain/` module is superseded — it is not the escrow adapter. Story 2.6 replaces it.
- Story 2.6 has **not** been implemented; it is the next story to spec and build.
- Story 1.8's live-execution ACs stay blocked on an operator-supplied Trustless Work API key. Its documentation-sourced findings are settled and are what Story 2.6 builds against; no real Trustless Work network call is possible or expected while building 2.6.

## Requirements & Constraints

- All Trustless Work REST/indexer/XDR operations pass through one adapter; unsigned XDR is returned only to the wallet or managed signer assigned to the requested role; no other module calls Trustless Work directly.
- Booking money state is reconciled from Trustless Work contract/indexer evidence only, never settled from an API request alone; on conflict, chain wins. Retries, duplicate callbacks and repeated indexer rows must be idempotent (dedupe by transaction hash + lifecycle action; cursor persisted and resumed).
- Raw Trustless Work API/contract errors never reach product copy — translate to Pactly's fixed envelope (`code`, user-facing `message`, raw detail only in `details`/logs).
- Trustless Work's real role model has nine roles; Story 1.8's proposed mapping onto Pactly's seven: Funder = client wallet, Service Provider = provider wallet, Approver = client wallet, Release Signer = provider wallet (self-claim), Receiver = provider wallet, Platform = Pactly, Dispute Resolver = Pactly (a trust assumption, must be named explicitly, never described as trustless). Issuer and Observer are not assigned.
- No automatic deadline-based settlement exists at the protocol level (Story 1.8 AC7: unsupported) — release and dispute resolution always require an explicit signed transaction from the assigned role. Every cancellation/no-show that the client doesn't resolve by approving in time becomes a dispute Pactly itself resolves as Dispute Resolver; this must never be described as automatic.
- "Audited infrastructure" claims must be version-qualified: the public audit covers one commit; whichever commit Pactly deploys against is well past it (114 commits as of the spike, including a state-machine-affecting change), and two High-severity findings ([A04] unvalidated `update_escrow`, [A06] missing `i128` sign checks) were only partially fixed. The adapter must refuse to construct a non-positive-amount `initialize_escrow` payload to keep [A06]'s residual risk moot for Pactly's own traffic.
- Exact Trustless Work request/response shapes, indexer query format, real signature/transaction counts and API rate limits are still unknown — Story 1.8 could not determine them without a live key. Treat these as build-time unknowns to research further, not as settled fact.
- Anchor integration (2.2–2.4) follows SEP standards discovered from `stellar.toml`, never hard-coded; amounts stay within the anchor's 50–3000 TRY limits at a 0.5% spread; a client pays via stablecoin wallet or SEP-6 local currency; a professional withdraws via SEP-6 without handling crypto.
- Amounts are integers in the asset's smallest unit end to end, encoded as strings; no floating point. Implementation vocabulary (Soroban, trustline, SEP-6, ledger, XDR, milestone, hash) never reaches the user.

## Technical Decisions

- **No vendor-neutral interface exists yet — this is a correction to an earlier draft of this document.** `backend/src/chain/` (Story 2.5) is hardwired directly to the custom contract's five functions (`createBooking`/`release`/`cancelByProfessional`/`cancelByClient`/`claimNoShow`); there is no `backend/src/escrow/` directory and no interface file of any kind. Confirmed by listing `backend/src/` directly. Story 2.6 must both define the vendor-neutral boundary (AD-8 names `backend/src/escrow/trustless-work/` as the adapter's home) and populate it — there is nothing to "replace the implementation behind."
- **What happens to `backend/src/chain/`.** Its callers (`services/booking.ts`'s `lockDeposit`) will need to move to the new adapter; the module itself, its tests, and Story 2.5's own review history stay as a record of the pre-pivot design. Story 2.6's own spec decides how much of `chain/` to touch — likely: stop calling it from `services/`, leave the module and its tests in place rather than deleting working, reviewed code for a still-unproven replacement.
- **Trustless Work adapter home.** `backend/src/escrow/trustless-work/`, likely built on `@trustless-work/escrow-js` (npm, `1.0.0-beta.1` as of Story 1.8 — very early, no adoption signal).
- **Injectable seam, real implementation default.** Every Trustless Work network call in Story 2.6 must sit behind an injectable seam defaulting to the real implementation, matching the pattern already established in `backend/src/chain/client.ts` and `backend/src/anchor/sep10.ts` — since no live API key exists, no real network call is possible or expected while building it.
- **Two identities, unaffected by the pivot.** Pactly's own JWT (Story 2.1, shipped) authorizes Pactly API calls; the anchor's separate SEP-10 JWT is used only for SEP-6/12/38 calls and never reaches the frontend.
- **Managed accounts** sign only the Trustless Work roles explicitly assigned to them (Funder/Approver per the role map); a refund routed to a managed account still triggers an automatic SEP-6 withdraw so funds are never stranded.
- **Config additions for 2.6:** Trustless Work API base URL (testnet `https://dev.api.trustlesswork.com`), API key, network, USDC contract id, platform address, and whichever role addresses Pactly itself holds — validated once at startup like every other env var.
- **Stack pins relevant here:** Hono 4.13.8, Drizzle ORM 0.45.2, better-sqlite3 13.0.3, @stellar/stellar-sdk 17.1.0, Node.js 22 LTS, TypeScript 5.x.

## UX & Interaction Patterns

- "Lock with Pactly" is the sole money-commit CTA; it initializes/funds the Trustless Work escrow and requests the role-correct wallet signature ("Approve it in your wallet", "Open wallet again" after 60s; a rejected signature reads as neutral information, not an error).
- "Escrow powered by Trustless Work on Stellar" is secondary proof copy paired with a real transaction/contract link — never the CTA.
- Cancellation/dispute copy always states the booking-policy outcome in words before naming the Trustless Work role that must sign the actual resolution; it never implies the outcome happened automatically before chain evidence exists (the "Needs resolution" state).
- A missing trustline is handled silently under "Getting your wallet ready"; an amount outside anchor limits is caught before the payment step, with the other payment method offered as an alternative.
- The SEP-38 quote appears on the payment screen with the anchor's spread already reflected in the displayed amount, not as a separate fee line.

## Cross-Story Dependencies

- Story 2.5's data model and service-layer conventions are the base; Story 2.6 replaces the superseded `backend/src/chain/` implementation behind that same interface, gated on Story 1.8's go/no-go (provisional go, happy path only).
- Story 2.1's SEP-10 JWT (shipped) is a precondition for 2.3 and 2.4's authenticated anchor-session calls.
- Story 2.2's quote feeds the amount shown in Story 2.4's payment flow and, later, Epic 3's booking/payment screen.
- Story 2.4's managed-account creation is what makes the automatic-refund-withdraw reachable; that rule fires off Story 2.6's reconciler recognizing chain-backed resolution evidence, so the reconciler must exist first.
- Story 2.6's reconciler is what Epic 4 uses for verified sessions (increment only on chain-backed approved + released evidence) and what Epic 3's Story 3.6 (complete/approve/release/dispute UI) and Story 3.4 (booking hold → Lock with Pactly) need for role-correct unsigned XDR.
- Story 1.8's remaining live-execution ACs (1, 3, 4, 5, live half of 6) stay blocked on the operator's API key; Story 2.6 proceeds on 1.8's documentation-sourced, settled findings alone and must treat unresolved shapes (exact request/response payloads, indexer query format) as build-time unknowns to research further.
