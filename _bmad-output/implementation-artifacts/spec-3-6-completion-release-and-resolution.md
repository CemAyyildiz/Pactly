---
title: 'Story 3.6 — Appointment completion, release and resolution'
type: 'feature'
created: '2026-09-20'
status: 'ready-for-dev'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-2-6-trustless-work-escrow-adapter-and-reconciliation.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-3-4-client-booking-flow.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-3-5-two-sided-status-panel.md'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-Pactly-2026-09-15/EXPERIENCE.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** A locked deposit can never leave escrow through the product. Nothing lets the provider mark the appointment complete, lets the client approve it, or lets the provider release it. A cancellation or no-show has no path at all. The demo's "lock → release" flow stops at "Funded".

**Approach:** Add role-correct, owner-only action routes that build unsigned XDR over the 2.6 adapter:
- complete (provider);
- approve (client);
- release (provider);
- open a dispute (either side), stating the policy outcome first;
- resolve (Pactly's dispute-resolver wallet, admin only).

Each route reuses 3.4's submit-binding rule. Surface the actions on 3.5's My bookings and panel cards, plus a plain admin "Resolutions" list. Every state shown stays chain-derived through the reconciler.

## Boundaries & Constraints

**Always:**
- Role map (Story 1.8), enforced per action. It is checked against the JWT wallet and the booking, never against request fields.

  | Action | Signer |
  |---|---|
  | complete | provider wallet (service provider) |
  | approve | client wallet (approver) |
  | release | provider wallet (release signer), only when the latest lifecycle is `approved` and not disputed |
  | dispute | client or provider, only while `locked` and not yet released or resolved |
  | resolve | only a wallet in `config.adminWallets` that also equals `config.trustlessWorkPlatformAddress` (the dispute resolver) |

- Every action returns unsigned XDR plus its Trustless Work `txHash`. The hash is stored on the booking and joins 3.4's submit allow-list, so submit relays only hashes Pactly built for that booking and that role. A non-owner, or a wallet without the role, gets `404 BOOKING_NOT_FOUND`. A wrong lifecycle state gets `409 BOOKING_STATE`.
- "Complete" adds `changeMilestoneStatus` to the adapter (new `EscrowAdapter.complete`) with the provider as `serviceProvider`, milestone 0, and status `"completed"`. The reconciler records a new `completed` lifecycle action when milestone 0's status reads completed. It ranks between `funded` and `approved`, and `escrow_state` stays `locked`.
- Cancellation and no-show policy (decided 2026-09-18, "who cancels decides"):
  - the professional cancels: full refund to the client;
  - the client cancels before `cancelDeadline`: full refund;
  - the client cancels after `cancelDeadline`, or does not show (claimed by the provider): full deposit to the provider.

  Before a dispute opens, the UI states this outcome in words and says plainly that Pactly will resolve it and that nothing moves automatically. The dispute records `reason` (`client-cancel`, `provider-cancel`, `no-show`, `disagreement`) and the policy's `suggestedOutcome`.
- Resolve uses 2.6's `resolveBookingDispute(outcome)`: one full-amount distribution, with the decision recorded. The admin list shows each open dispute: who opened it, the reason, the suggested outcome, and the amount. The admin may pick either outcome. The suggestion is guidance, never automatic.
- `escrow_state` changes only through the reconciler. The UI labels follow 3.5's mapping, plus "Appointment completed" for `completed`.

**Never:**
- No automatic release, refund or forfeiture on any clock. No partial splits.
- No server-held private key. Pactly's resolver signs in its own wallet like any other signer.
- No balance-payment work (Story 3.7) and no `chain/` changes.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Complete | Provider, booking `locked` (funded) | Unsigned change-milestone XDR; hash stored | Client calls it: `404`; not locked: `409 BOOKING_STATE` |
| Approve | Client, lifecycle `completed` or `funded` | Unsigned approve XDR | Provider calls it: `404` |
| Release | Provider, lifecycle `approved`, not disputed | Unsigned release XDR | Not approved or disputed: `409 BOOKING_STATE` |
| Dispute | Client or provider, `locked`, with a `reason` | Unsigned start-dispute XDR; reason and `suggestedOutcome` stored | Released or resolved: `409`; unknown reason: `400` |
| Suggested outcome | `client-cancel` before or after the deadline, `provider-cancel`, `no-show` | refund-client / pay-provider / refund-client / pay-provider | No error expected |
| Resolve | Admin resolver wallet, latest lifecycle `disputed` | Unsigned resolve XDR; decision recorded (2.6) | Non-admin: `404`; admin whose wallet is not the platform address: `403 NOT_DISPUTE_RESOLVER` |
| Admin list | `GET /admin/disputes` by an admin | Open disputes with the fields above | Non-admin: `404` |
| Submit binding | Signed XDR for an action hash on this booking | Relayed (3.4 rule) | Any other hash: `409 XDR_MISMATCH` |
| Completed on chain | Milestone 0 status completed, balance at deposit | `completed` lifecycle row; `escrow_state` stays `locked` | No error expected |

</intent-contract>

## Code Map

- `backend/src/escrow/interface.ts`, `trustless-work/client.ts` -- add `complete` over the SDK's `rest.changeMilestoneStatus(payload, "single-release")` (`{contractId, serviceProvider, updates: [{index: 0, newStatus: "completed"}]}`), following the other five calls' seam and error pattern.
- `backend/src/escrow/trustless-work/reconciler.ts` -- `RECOGNIZED_LIFECYCLE_ACTIONS` order and the derivation table. Add `completed` after `funded`, derived from `snapshot.milestones[0].status`.
- `backend/src/services/booking.ts` -- `resolveBookingDispute`, 3.4's stored-hash submit binding, `getBookingForClient`. Add the provider-side ownership check (the booking's `providerProfileId` belongs to the JWT wallet) and the per-action state guards.
- `backend/src/app.ts` -- 3.4 and 3.5 booking routes. Add `POST /bookings/:id/{complete,approve,release,dispute}`, `POST /admin/bookings/:id/resolve` and `GET /admin/disputes`. Admin is `config.adminWallets.includes(wallet)`.
- `frontend/src/components/BookingCard.tsx`, `pages/my-bookings`, `pages/panel/BookingsPage.tsx` (3.5) -- add action buttons per role and lifecycle, and reuse 3.4's sign-and-submit helper (`wallet.signXdr` + submit + poll). The policy statement dialog comes before a dispute.
- `frontend/src/pages/admin/ResolutionsPage.tsx` -- new, route `/admin/resolutions`, a plain list with resolve actions.

## Tasks & Acceptance

**Execution:**
- adapter, reconciler, service, routes and tests for every matrix row (backend);
- frontend actions, the policy dialog, the admin page;
- `backend/src/seed/demo.ts` -- `SEED_ADMIN_WALLET` adds that wallet to the demo's expectations and documents that it must equal `TRUSTLESS_WORK_PLATFORM_ADDRESS`;
- `README.md` -- the "complete → approve → release" and "cancel → resolve" demo steps.

**Acceptance Criteria:**
- Given a locked booking, when the provider completes, the client approves and the provider releases (each signing in their wallet), then both panels move through "Appointment completed", "Ready to release" and "Released" as the reconciler observes each step.
- Given a client cancelling after the deadline, when they confirm the policy dialog and sign, then the booking reads "In resolution". Once the admin resolves with the suggested outcome, both sides read "Resolved · Paid to the provider".
- Given the backend workspace, when `typecheck`, `test` and `build` run, then all are clean. Given the frontend, when `typecheck` and `build` run, then both are clean.

## Spec Change Log

## Review Triage Log

## Verification

**Commands:**
- `npm run -w backend typecheck && npm run -w backend test && npm run -w backend build` -- expected: clean, all pass
- `npm run -w frontend typecheck && npm run -w frontend build` -- expected: clean
