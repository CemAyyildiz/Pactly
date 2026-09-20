---
title: 'Story 2.2 — SEP-38 quote (local-currency equivalent)'
type: 'feature'
created: '2026-09-20'
status: 'in-progress'
review_loop_iteration: 0
baseline_revision: 'd8f9e0a980e9307b4b5468e27b321c0b6fccaeca'
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-3-4-client-booking-flow.md'
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** Every amount in the product is USDC. The hackathon's own anchor exposes SEP-38, the PRD requires the local-currency equivalent before paying (Story 2.2, FR4, NFR12), and a Turkish client cannot judge "450.00 USDC" without seeing what it costs in TRY.

**Approach:** Read the anchor's SEP-38 price for the asset pair it advertises, expose it through one backend route, and show the equivalent beside the deposit and total wherever the client is about to commit money. The equivalent is always marked as indicative and stamped with the time it was quoted.

## Boundaries & Constraints

**Always:**
- The anchor and its endpoints come from `stellar.toml` (AD-10), never from a constant: `ANCHOR_QUOTE_SERVER` for SEP-38, the USDC asset from the same file (3.4's resolver).
- The fiat currency is whatever the anchor advertises (`sep38/info`), not a hard-coded TRY (NFR12). The response carries the currency code, and the UI prints that code.
- The price comes from SEP-38 `price` (an indicative quote), and it already carries the anchor's 0.5% spread, so Pactly never adds or recomputes a spread of its own. The response carries `quotedAt`.
- Amounts stay integer strings in the asset's smallest unit end to end (AD-7). The fiat equivalent is a separate, display-only field with its own decimals — it is never persisted on a booking and never used to compute a deposit.
- Prices are cached briefly (about 60 seconds, keyed by the pair and the rounded amount) so a list of cards does not hammer the anchor, and every response says how old the quote is.
- A quote failure never blocks the flow: the USDC amount still shows, and the equivalent line is replaced by one plain sentence. No stack trace, no raw anchor body.
- The client is never shown SEP vocabulary (NFR9). The line reads like "≈ 14,350.00 TRY · indicative, quoted just now".

**Never:**
- No SEP-6 deposit or withdraw here (Stories 2.4 and 2.3) and no firm `quote_id` reservation — that belongs to the story that actually moves money.
- No change to escrow, booking state or amounts.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Quote | `GET /quote?amount=4500000000` | `{ amount, asset: "USDC", fiat: { amount: "14350.00", currency: "TRY" }, quotedAt, spreadApplied: true }` | No error expected |
| Bad amount | Not a positive integer string | Refused before any anchor call | `400 INVALID_AMOUNT` |
| Cached | The same pair and amount within the cache window | Served from cache, `quotedAt` unchanged | No error expected |
| Anchor down | SEP-38 unreachable or a non-200 | The route answers without a fiat block | `503 QUOTE_UNAVAILABLE`, safe message |
| Unsupported pair | The anchor does not offer the asset or currency | Same, with a distinct code | `409 QUOTE_UNSUPPORTED` |
| Booking screen | Deposit, balance and total on the payment step | Each shows its own indicative equivalent with the currency code and the quote's age | Quote failure: one plain sentence instead |

</intent-contract>

## Code Map

- `backend/src/anchor/stellar-toml.ts` -- `discoverAnchorSepEndpoints` already parses the toml; `ANCHOR_QUOTE_SERVER` is in it. Reuse rather than re-fetching by hand.
- `backend/src/anchor/usdc.ts` (3.4) -- the resolved USDC asset, cached. The quote's `sell_asset` is that asset in SEP-38's `stellar:CODE:ISSUER` form.
- `backend/src/anchor/errors.ts` -- typed anchor errors to extend, following `AnchorDiscoveryError`'s shape.
- `backend/src/app.ts` -- route registration and the `{ code, message, details? }` envelope.
- `frontend/src/pages/booking/BookingPage.tsx`, `frontend/src/components/DepositPill.tsx` -- where money is shown at the moment of commitment.
- `frontend/src/lib/money.ts` -- the BigInt formatter the fiat line sits beside.
- The anchor documents itself at `https://tr-mock-anchor.fly.dev/llms-full.txt` and `/sep`; read the SEP-38 section there before writing the client.

## Tasks & Acceptance

**Execution:**
- `backend/src/anchor/sep38.ts` -- `fetchIndicativePrice({ amount })` behind an injectable fetch seam, with the cache, the currency from `sep38/info`, and typed errors.
- `backend/src/app.ts` -- `GET /quote`.
- `backend/test/` -- a test per matrix row, with the anchor's own recorded payload shapes; no live call in tests.
- `frontend/src/api/`, `BookingPage.tsx`, `DepositPill.tsx` -- the indicative line beside the deposit, balance and total.

**Acceptance Criteria:**
- Given the booking screen for a 450.00 USDC deposit, when the anchor is reachable, then the client sees the deposit in USDC and its indicative local-currency equivalent with the currency code and the quote's age.
- Given the anchor is unreachable, when the same screen loads, then the USDC amounts still show and one plain sentence replaces the equivalent.
- Given the backend workspace, when `typecheck`, `test` and `build` run, then all are clean and every matrix row has a passing test.

## Spec Change Log

## Review Triage Log

## Verification

**Commands:**
- `npm run -w backend typecheck && npm run -w backend test && npm run -w backend build` -- expected: clean, all pass
- `npm run -w frontend typecheck && npm run -w frontend build` -- expected: clean

**Manual checks:**
- `curl "localhost:<port>/quote?amount=4500000000"` against the live anchor returns a TRY equivalent close to the anchor's own `/health` rate.
