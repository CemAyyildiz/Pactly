---
title: 'Story 2.6 — Trustless Work escrow adapter and reconciliation'
type: 'feature'
created: '2026-09-19'
status: 'in-progress'
review_loop_iteration: 1
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
- **Reconciliation is idempotent, restart-safe, and bound to Pactly's own escrows** (AC4, AD-9; amended 2026-09-19, see Spec Change Log): the reconciler never discovers escrows by `engagementId` (anyone can deploy an escrow naming any `engagementId`). It polls only the `contractId`s Pactly itself persisted on `bookings.escrow_contract_id` at deploy time, for bookings whose `escrow_state` is not terminal, through `listEscrows({ contractIds })` (chunked, every keyset page followed). It derives each escrow's lifecycle from the read-model row's own fields (`status`, `balance`, `snapshot.dispute`, `snapshot.released`) -- never from `EscrowEvent.kind`, whose vocabulary the SDK does not define. Each derived transition is applied at most once, deduped by `(contractId, lifecycleAction)`; a per-escrow `lastLedgerSeq` watermark is stored so a restart skips rows it has already processed. Transitions are monotonic: `released`/`refunded` are terminal and never regress.
- **Raw errors never escape the adapter** (AC5). Trustless Work's REST error codes (`auth-credential-missing`, `escrow-platform-fee-too-high`, etc.) and any GraphQL error are translated into typed application errors at the adapter boundary, mirroring `chain/errors.ts`'s and `anchor/errors.ts`'s established shape — no raw SDK error, no raw HTTP body, ever reaches a service or a route. This covers the reconciler's own read calls (`listEscrows`) as much as the six mutate calls.
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
| Escrow deployed | A booking hold with no `escrow_state`; client as funder/approver, provider as service-provider/release-signer/receiver | Unsigned deploy XDR returned; `engagementId` is the booking id; single milestone, `approvalsTarget: 1`; predicted `contractId` persisted on the booking | Refused (typed) when `escrow_state` is already set |
| Escrow funded | A booking with a persisted `contractId`, client signs | Unsigned fund XDR for the booking's own client wallet and deposit amount, against the persisted `contractId` | Refused (typed) when no `contractId` is persisted or `escrow_state` is already set |
| Session approved | Client signs approval | Unsigned approve XDR; milestone marked approved once submitted | No error expected |
| Provider self-claims | Provider signs release (release signer = receiver) | Unsigned release XDR for the provider's own signature | No error expected |
| Dispute opened | Provider or client-as-approver raises it (cancellation, no-show, disagreement) | Unsigned start-dispute XDR | No error expected |
| Dispute resolved | Pactly, as Dispute Resolver, decides `refund-client` or `pay-provider` per who cancelled | Unsigned resolve-dispute XDR with one full-amount distribution to the chosen party; the decision and its `txHash` are recorded | Refused (typed) unless the booking is `locked` with a persisted `contractId`; empty, non-positive or duplicate-address distributions refused |
| Non-positive amount | Adapter asked to deploy with `amount <= 0` | Refused before any SDK call | Typed `EscrowConfigError`, no request sent |
| Amount exceeds safe range | An integer string the adapter cannot safely narrow to `number` | Refused before any SDK call | Typed `EscrowConfigError` naming the value |
| Pactly config missing | `TRUSTLESS_WORK_API_URL`, `_API_KEY` or `_PLATFORM_ADDRESS` empty | Refused before any SDK call | Typed `EscrowConfigError` naming the variable |
| Trustless Work call rejected | The API returns a typed error (e.g. `ESCROW_PLATFORM_FEE_TOO_HIGH`) | Translated to a typed `EscrowApiError` naming the condition | No raw HTTP body ever surfaces |
| Trustless Work unreachable | Network/timeout failure, on a mutate call or on the reconciler's `listEscrows` | Translated to a typed `EscrowRequestError` | No raw fetch/axios error escapes |
| Funded on chain | Row for a persisted `contractId`: `status: "active"`, `balance` (human decimal) >= the deposit | `escrow_state` = `locked` | No error expected |
| Partially funded | `balance` > 0 but below the deposit | No state change | No error expected |
| Dispute open on chain | `snapshot.dispute.isDisputed`, not resolved | `escrow_state` = `locked` (never a resolution) | No error expected |
| Approved on chain | `snapshot.milestones[0].approvals.approvalCount` >= its `target` (or milestone `status` approved), not released | `escrow_state` stays `locked`; `approved` lifecycle row recorded (UX "Ready to release") | No error expected |
| Lifecycle read for the UI | A booking with recorded lifecycle rows | `getEscrowLifecycle(db, bookingId)` returns `contractId`, the latest recorded action (`funded`/`approved`/`disputed`/`released`/`resolved`) and, when resolved, the recorded outcome | Unknown booking: `undefined` |
| Released on chain | `status: "released"` or `snapshot.released`, no resolved dispute | `escrow_state` = `released` | No error expected |
| Dispute resolved on chain | `snapshot.dispute.resolved`, `balance` = 0, a recorded Pactly decision for this booking | `refunded` for `refund-client`, `released` for `pay-provider` | No recorded decision: anomaly recorded, no state change |
| Same row replayed | The same `(contractId, lifecycleAction)` derived again | Nothing changes; no duplicate row | No error expected |
| Reconciler restarted | A stored per-escrow watermark exists | Rows at or below the watermark are skipped | No error expected |
| Stale or out-of-order row | A `locked`-deriving row after the booking is `released`/`refunded` | No regression; terminal states stay | No error expected |
| Escrow not matching its booking | Row's `engagementId`, approver, receiver, amount or trustline differ from the booking | Anomaly recorded; no state change; reconciler continues | Logged, batch continues |
| Row for an unrequested contract | A row whose `contractId` Pactly did not ask for | Ignored as an anomaly; no row invented | Logged, batch continues |

</intent-contract>

## Code Map

- `backend/src/chain/client.ts`, `chain/errors.ts` -- the pattern to mirror exactly, not reuse: injectable `ChainCallDeps`-shaped seams defaulting to the real implementation, typed error classes per failure kind, a private `invoke`-style core every exported function funnels through. Read-only; do not modify.
- `backend/src/anchor/sep10.ts`, `anchor/errors.ts` -- the second working instance of the same pattern, plus the account-identity and replay lessons from Story 2.1's review (verify identity fields the SDK returns rather than discarding them; never trust a response shape you haven't checked against the real types). Read-only.
- `backend/src/chain/event-worker.ts`, `db/cursor.ts`, `db/processedEvents.ts` -- the reconciler shape to retarget, not rebuild: `processEvent`/`runEventWorkerOnce`, the atomic dedupe-insert-plus-state-write transaction (added in Story 2.1's era of fixes — actually landed in Story 2.5's own patch round), the cursor table. The dedupe key changes from `(booking_id, event_type)` to `(transaction_hash, lifecycle_action)`; the event source changes from `FetchEvents`/Soroban `getEvents` to a new `FetchEscrowEvidence` seam over Trustless Work's `listEscrowEvents`/GraphQL. Read fully before writing the new version.
- `backend/src/services/booking.ts` -- `lockDeposit`'s one call to `chain.createBooking` (line ~107) moves to the new `EscrowAdapter`. Amended 2026-09-19: `lockDeposit(db, bookingId, adapter)` builds the deploy XDR only and persists the predicted `contractId` (client address comes from `booking.clientWalletAddress`, never a parameter); a new `fundDeposit(db, bookingId, adapter)` builds the fund XDR against the persisted `contractId`; a new `resolveBookingDispute(db, bookingId, outcome, adapter)` builds Pactly's resolution and records the decision. `createBookingHold`, `getBooking`, `setBalanceState` are untouched.
- `backend/src/db/schema.ts`, `migrations.ts` -- `bookings.escrowState`/`balanceState` need no schema change (the three-value `EscrowState` enum already covers Trustless Work's funded/approved/released/disputed lifecycle by mapping down to locked/released/refunded, the same way Story 1.5's `forfeited`/`cancelled` distinction was preserved in `processed_events.event_type` rather than in the state column). Add the reconciler's own cursor/dedupe tables (or extend the existing `event_worker_state`/`processed_events` shape — decide based on whether one cursor table can serve both the old Soroban worker and this one, or whether they need to stay separate since `chain/`'s worker is dead code no process calls).
- **SDK reference, read the real published types, not this spec's paraphrase:** `@trustless-work/escrow-js@1.0.0-beta.1` — `src/types/types.payload.ts` (`DeploySingleReleaseEscrowPayload`: `{signer, engagementId, title, description, amount, platformFee, roles, milestones: [{description, approvalsTarget}], trustline}`), `src/types/types.entity.ts` (`Roles`: `{approvers: string[], serviceProviders: string[], platform: string, releaseSigners: string[], disputeResolvers: string[], receiver: string, admin: string, observers?: string[]}`), `src/client.ts` (`TrustlessWorkClient({baseURL, apiKey})`, `.rest.*`/`.graphql.*`). Deploy takes `AttributionHeaders` (`platformId`/`subjectId` → `X-TW-Platform`/`X-TW-Subject`) — resolve what Pactly's own `platformId` is (likely a value the operator's TW account provides, not invented here) before this story can be considered complete; if unknown, treat it as a `config.ts` variable with an empty placeholder, same convention as every other not-yet-populated secret in `.env.example`.
- `spec-1-8-trustless-work-appointment-compatibility.md` -- the authoritative source for the role map, the AC7 classification, the audit findings and the drift measurement. Cite it, don't re-derive it.

## Tasks & Acceptance

**Execution:**
- `backend/src/escrow/interface.ts` -- the vendor-neutral `EscrowAdapter` type: `deploy`, `fund`, `approve`, `release`, `startDispute`, `resolveDispute`, each taking Pactly-native types (booking id, amount as a string, addresses) and returning an unsigned XDR string plus whatever identifiers the caller needs to track it -- so `services/` never imports a Trustless Work type directly.
- `backend/src/escrow/trustless-work/client.ts`, `errors.ts` -- the adapter implementation: one `TrustlessWorkClient` construction behind an injectable seam, the six calls above, amount/id boundary conversion with the non-positive/out-of-range refusals, and error translation for every documented TW error code this story's matrix names.
- `backend/src/escrow/trustless-work/reconciler.ts` -- retargets Story 2.5's event-worker shape onto Trustless Work's escrow read model (amended 2026-09-19): polls `listEscrows({ contractIds })` for Pactly's own non-terminal bookings, derives the lifecycle per the Design Notes table, dedupes by `(contractId, lifecycleAction)` in the same atomic dedupe-then-state-write transaction, keeps a per-escrow `lastLedgerSeq` watermark, never regresses a terminal state, and translates read errors to typed errors.
- `backend/src/db/schema.ts`, `migrations.ts` -- whatever cursor/dedupe storage the reconciler needs, decided against the existing tables per the Code Map note above.
- `backend/src/services/booking.ts` -- `lockDeposit` (deploy + persist `contractId`), `fundDeposit`, `resolveBookingDispute` per the Code Map; `bookings.escrow_contract_id` column and an `escrow_dispute_resolutions` table added in `db/schema.ts`/`migrations.ts`.
- `backend/src/config.ts`, `.env.example` -- `TRUSTLESS_WORK_API_URL` (testnet default `https://dev.api.trustlesswork.com`), `TRUSTLESS_WORK_API_KEY`, `TRUSTLESS_WORK_PLATFORM_ID`, and whichever of Pactly's own role addresses (platform, dispute resolver) the adapter signs with -- all `declared()` empty until Story 1.8's blocked ACs are unblocked, matching `ESCROW_CONTRACT_ID`'s existing precedent.
- `backend/test/` -- one test file per new module, covering every matrix row's success path explicitly, plus the batch-level cursor/restart/replay tests the reconciler's own history (Story 2.5's review) says not to skip.

**Acceptance Criteria:**
- Given a booking ready to lock, when `lockDeposit` runs, then it calls the `EscrowAdapter`, not `chain/client.ts`; the deploy names the booking's own client wallet as approver and deploy signer, the provider as service provider/release signer/receiver, and Pactly as platform/dispute resolver; and the predicted `contractId` is persisted on the booking. `fundDeposit` then targets exactly that `contractId`.
- Given a non-positive amount, when a deploy is attempted, then it is refused before any network seam is invoked.
- Given Trustless Work read-model rows for Pactly's own escrows, when the reconciler runs twice over the same rows, then the second run changes nothing observable; a restart skips rows at or below the stored watermark; and a row for an escrow that does not match its booking never changes `escrow_state`.
- Given any Trustless Work failure shape (API error, network failure), when the adapter returns, then the caller receives a typed error naming the condition, never a raw body or stack trace.
- Given the backend workspace, when `npm run -w backend typecheck`, `test` and `build` run, then all three are clean and every matrix row — including every success path — has a passing test.

## Spec Change Log

### 2026-09-19 — Intent amendment (kullanıcının devrettiği karar)
- **Tetikleyen:** İlk review geçişinin iki intent_gap grubu (G-A olay sözlüğü + uyuşmazlık çözümü, G-B kanıtın rezervasyona bağlanması) ve maybe-false/high I7 (deploy+fund aynı çağrıda). Kullanıcı: "kendi önerilenlerinle yap bana soru sorma en mantıklı yolu bul ve yap".
- **Değiştirilen:** Intent'teki reconciliation ve hata maddeleri, I/O matrisi, Code Map, görevler, AC1/AC3, Design Notes. Reconciler artık olay `kind`'ı yerine escrow read-model alanlarından türetiyor ve yalnızca Pactly'nin kaydettiği `contractId`'leri sorguluyor. `lockDeposit` yalnızca deploy + `contractId` kaydı yapıyor, `fundDeposit` ayrı. Uyuşmazlık çözümü tek, tam tutarlı dağıtım ve kaydedilen karar.
- **Kaçınılan bilinen kötü durum:** Uydurma olay adlarıyla gerçek olayların sessizce düşmesi; başkasının `engagementId` ile rezervasyonu `locked` yapması; `released`'dan geri gerileme; çözülen uyuşmazlığın sonsuza dek `locked` kalması; deploy inmeden fund kurulması.
- **Ek (aynı gün, Discover v2 / EXPERIENCE.md hizalaması):** `approved` türetmesi ve `getEscrowLifecycle` okuma helper'ı eklendi; UX'in "Ready to release" / "In resolution" / "Resolved" etiketleri ve escrow kanıtı buna dayanıyor.
- **KEEP (korunacaklar):** `escrow/interface.ts` sınırı ve `services/`'in TW tipi import etmemesi; adaptörün altı çağrısı, `EscrowCallDeps` seam'leri, rol haritası testi (admin = platform adresi, gerekçesiyle); `toHumanAmount`'un pozitif/güvenli aralık reddi; `errors.ts`'nin üç tipli hatası ve SDK'nın `toTrustlessWorkError` normalizer'ını kullanması; better-sqlite3 senkron transaction deseni (dedupe insert + state write atomik); `chain/`'e dokunulmaması; config'deki 4 değişkenin adları ve `.env.example` notları (`beta.api` uyarısı dahil); ayrı tablolar kararı; mevcut testlerin başarı yolu kapsamı.

## Review Triage Log

### 2026-09-19 — Review pass
- verdicts: 54 bulgu — high 7, medium 29, low 9, false 4, maybe-false 5
- Katmanlar: Blind Hunter (B1–B14), Verification Gap (V1–V8), Intent Alignment (I1–I9), Edge Case Hunter (E1–E23). Kademeli işlemde intent_gap bulunduğu için patch/defer girdileri uygulanmadı (moot); rotaları kayıt için yazıldı.
- Kök neden grupları:
  - **G-A (intent_gap) Kanıt sözlüğü ve uyuşmazlık çözümü:** SDK'da `EscrowEvent.kind` yalnızca `string`, `EscrowStatus` = `active|released|disputed`. Reconciler'ın tanıdığı `funded/approved/released/disputed` adları hiçbir kaynağa dayanmıyor, uyuşmazlık çözümünün `escrow_state`'e eşlenmesi (tümü müşteri / tümü sağlayıcı / bölüşüm) tanımsız.
  - **G-B (intent_gap) Kanıtın rezervasyona bağlanması:** `engagementId` herkesin seçebildiği bir alan. Kanıtın Pactly'nin kurduğu escrow'dan geldiğini doğrulamak için ya `contractId` rezervasyonda saklanmalı (spec bunu sonraki bir hikâyeye bırakıyor) ya da escrow koşulları (roller/tutar/token) rezervasyonla eşleştirilmeli. İki cevap da savunulabilir.
- findings:
  - `[medium]` `[patch]` B1 Okuma tarafında tutarlar insan-ondalık string (README:205), `decodeEscrowEvidence` yalnızca tamsayı kabul ediyor, "1.5" → "0", "10" → 10 birim — doğrulandı, moot (intent_gap).
  - `[high]` `[intent_gap]` B2 Sahte escrow aynı `engagementId` ile rezervasyonu `locked` yapabilir; contractId/tutar/token kontrolü yok — G-B.
  - `[medium]` `[patch]` B3 `released` sonrası gelen funded/approved/disputed durumu `locked`'a geri çeviriyor — doğrulandı, moot.
  - `[high]` `[intent_gap]` B4 Uyuşmazlık çözümü hiçbir lifecycle eylemine eşlenmiyor, rezervasyon sonsuza dek `locked` — G-A.
  - `[medium]` `[patch]` B5 Boş platform config'inde `listEscrows` filtresiz tüm escrow'ları listeler — doğrulandı (`|| undefined`), moot.
  - `[medium]` `[patch]` B6 Boş `platformAddress`/`apiKey` reddedilmiyor, roller "" ile kurulur — doğrulandı, moot.
  - `[medium]` `[patch]` B7 `listEscrowEvents` yalnızca ilk sayfa, `hasMore`/`nextCursor`/`order` yok — doğrulandı (KeysetPage), moot.
  - `[low]` `[patch]` B8 İlk koşuda `nextCursor: null` ise cursor "" saklanır ve sonra `cursor: ""` gönderilir — doğrulandı, moot.
  - `[medium]` `[patch]` B9 `realFetchEscrowEvidence` seam'leri enjekte edilebilir olduğu hâlde testsiz — doğrulandı, moot.
  - `[medium]` `[patch]` B10 `lockDeposit`, `clientAddress`'i `booking.clientWalletAddress` ile karşılaştırmıyor — doğrulandı, moot.
  - `[medium]` `[intent_gap]` B11 `lockDeposit` idempotent değil, her çağrı yeni escrow kurar; gerçek çözüm saklanan contractId'ye bağlı — G-B.
  - `[low]` `[reject]` B12 Sabit USDC/7 ondalık, rezervasyon token'ı ile uyuşmayabilir — PRD yalnızca USDC; guard eklemek karmaşıklık katar, günlük kullanımda karşılaşılmaz.
  - `[maybe-false]` `[defer]` B13 `toHumanAmount` float yuvarlaması (1.1×1e7) bir stroop kaybettirebilir — TW'nin sunucu tarafında nasıl ölçeklediği canlı anahtarla görülmeli; doğruysa medium. Çift güvenli-tamsayı kontrolü: kozmetik.
  - `[medium]` `[intent_gap]` B14 `resolveDispute` dağıtımları doğrulanmıyor; "0" pay ifade edilemiyor (tümü tek tarafa gidemez) — G-A.
  - `[medium]` `[patch]` V1 = B10 (test iki değeri aynı verdiği için farkı göremiyor).
  - `[medium]` `[patch]` V2 = B9.
  - `[medium]` `[patch]` V3 = B1 (fixture'lar gerçek okuma formatında değil).
  - `[medium]` `[patch]` V4 = B3 (sırasız kanıt testi yok).
  - `[medium]` `[patch]` V5 = B7.
  - `[low]` `[patch]` V6 = B8.
  - `[medium]` `[patch]` V7 = B6.
  - `[high]` `[intent_gap]` V8 = B4.
  - `[high]` `[intent_gap]` I1 Olay `kind` sözlüğü uyduruldu; tanınmayan tür sessizce atlanıyor ve cursor ilerliyor — gerçek türler bilinmiyorsa tüm gerçek olaylar düşer — G-A.
  - `[medium]` `[patch]` I2 = B1 (yazma yolu R4b, okuma yolu R4a — iç çelişki).
  - `[medium]` `[patch]` I3 Reconciler'ın `listEscrows`/`listEscrowEvents` hataları çevrilmiyor, ham SDK hatası `runReconcilerOnce`'tan kaçıyor (AC5) — doğrulandı, moot.
  - `[medium]` `[patch]` I4 = B7/B8 (cursor escrow-listesi cursor'ı, olay cursor'ı değil).
  - `[low]` `[patch]` I5 `engagementId`'siz escrow sessizce atlanıyor — tek log satırıyla düzelir, moot.
  - `[high]` `[intent_gap]` I6 = B4.
  - `[maybe-false]` `[defer]` I7 `fund` XDR'ı deploy zincire inmeden tahmini contractId'ye karşı kuruluyor; TW'nin build endpoint'i var olmayan kontratı simüle edemeyebilir — canlı anahtarla bir deploy+fund denemesi gerekli; doğruysa high.
  - `[low]` `[patch]` I8 SDK'nın tanımadığı ham HTTP gövdesi için genel `EscrowRequestError` dalı testsiz — tek test, moot.
  - `[false]` `[reject]` I9 Base URL uyuşmazlığı — varsayılan boş ve ağdan önce reddediliyor, `apiUrl: ""` testi var.
  - `[medium]` `[patch]` E1 = B3.
  - `[medium]` `[patch]` E2 = B7.
  - `[high]` `[intent_gap]` E3 = B2.
  - `[false]` `[reject]` E4 Rezervasyon arama ile işlem arasında silinirse batch durur — `backend/src` içinde bookings silen hiçbir yol yok.
  - `[medium]` `[patch]` E5 = B1.
  - `[low]` `[patch]` E6 = B8.
  - `[medium]` `[patch]` E7 = I3.
  - `[low]` `[patch]` E8 = I5.
  - `[high]` `[intent_gap]` E9 = B4 (`refunded` hiç üretilmiyor).
  - `[maybe-false]` `[defer]` E10 Eşzamanlı iki `runReconcilerOnce` cursor'ı geri alabilir — henüz döngü/çağıran yok; runner yazılınca tek-uçuş kilidi gerekip gerekmediği görülmeli; doğruysa medium.
  - `[false]` `[reject]` E11 Aynı tx'te iki kontrat aynı türü üretirse PK çakışır — bir Soroban tx'i tek invokeHostFunction op taşır, TW escrow başka escrow çağırmaz.
  - `[medium]` `[patch]` E12 = B10.
  - `[medium]` `[intent_gap]` E13 = B11.
  - `[maybe-false]` `[defer]` E14 = I7 (deploy ve fund aynı sequence number'ı paylaşabilir).
  - `[maybe-false]` `[defer]` E15 = I7 (deploy başarılı, fund hata verirse contractId kaybolur).
  - `[medium]` `[patch]` E16 = B6.
  - `[medium]` `[patch]` E17 = B6 (boş API anahtarı).
  - `[low]` `[reject]` E18 client === provider — guard dal ekler, günlük kullanımda olası değil.
  - `[medium]` `[intent_gap]` E19 = B14.
  - `[low]` `[patch]` E20 `TrustlessWorkNetworkError` status 0 iken mesaj "HTTP 0" — tek satırlık düzeltme, moot.
  - `[medium]` `[patch]` E21 = I3.
  - `[medium]` `[patch]` E22 = B3.
  - `[false]` `[reject]` E23 = E4.
- intent_gap dalı: deneme [spec-2-6-attempt-1.patch](spec-2-6-attempt-1.patch) olarak kaydedildi. **Kod geri alınamadı:** çalışma ağacını geri alma komutu izin sınıflandırıcısı tarafından reddedildi ("Irreversible Local Destruction"). Kod, patch ile aynı içerikte ve commit edilmemiş hâlde ağaçta duruyor.

## Design Notes

- **Why this is one story and not two, despite the size.** The adapter (AC1/2/5) and the reconciler (AC3/4) share one boundary: `services/booking.ts` needs both to exist before `lockDeposit` can move off `chain/`, and the reconciler's dedupe/cursor shape is a near-direct retarget of code Story 2.5 already wrote and reviewed, not new design. Splitting would leave a story that "adds an adapter nothing calls" or "reconciles events nothing produces" — worse than one bounded story that reuses proven shapes throughout.
- **Why `chain/` stays in the tree.** It is reviewed, tested, working code against a contract that is not being deployed for this MVP — not a mistake to clean up, a record of the pre-pivot design the proposal itself says to preserve ("no completed history is erased"). Deleting it would also delete Story 2.5's own review triage log's evidentiary value.
- **Why the protocol-version choice (V1 REST vs. V2 SDK) is recorded rather than resolved by testing.** No live key exists to test either. The V2 SDK is the only path with real, machine-checked types available right now; building the array-shaped roles the SDK's types demand, with exactly one address per array slot, costs nothing today and loses nothing if the operator's actual account turns out to be V1-scoped — the interface layer (`escrow/interface.ts`) is what absorbs that risk, not `services/`.
- **Why the dispute-resolver concession is written into the constraints, not left implicit.** AD-2 requires it named explicitly wherever Pactly itself signs. This is the story where that signature first appears in code, so it is the story where the doc comments must say so plainly.

- **Lifecycle derivation table (amended 2026-09-19).** Evaluated in this order for each row of a persisted `contractId`, after the row is checked against its booking (`engagementId` = booking id, `snapshot.roles.approvers` = [client], `receiver` = provider wallet, `snapshot.amount` = deposit, `snapshot.trustline.contractId` = token when present; any mismatch → anomaly): (1) `snapshot.dispute.resolved` and `balance` = 0 → `resolved` → the recorded Pactly decision (`refund-client` → `refunded`, `pay-provider` → `released`), or an anomaly when none is recorded; (2) `status: "released"` or `snapshot.released` → `released`; (3) `snapshot.dispute.isDisputed` → `disputed` → `locked`; (3b) milestone 0 approvals reached → `approved` → `locked`; (4) `status: "active"` and `balance` >= deposit → `funded` → `locked`; otherwise no transition. Read amounts are human-decimal strings (SDK README); the reconciler converts them to smallest units with exact string arithmetic (at most 7 decimals, otherwise an anomaly), never floats.
- **Why dispute resolution is always one full-amount distribution.** Pactly's cancellation rule (decided 2026-09-18): professional cancels → full refund to the client; client cancels before `cancel_deadline` → full refund; client cancels after it or does not show → full deposit to the professional. There is no split outcome, so `resolveBookingDispute` takes `outcome: "refund-client" | "pay-provider"` and builds one distribution of the whole deposit. The adapter's own `resolveDispute` still validates any list it is given (non-empty, positive amounts, unique addresses).
- **Why the resolution decision is recorded with its `txHash`.** The read model shows *that* a dispute was resolved, not *to whom* the money went. The unsigned transaction's hash is the hash the signed transaction lands with, so the recorded `(bookingId, contractId, outcome, txHash)` names exactly the allocation Pactly signed. The reconciler still only moves `escrow_state` once the chain shows the dispute resolved and the balance at zero, so chain evidence remains the trigger.
- **Why deploy and fund are separate calls.** Building a fund transaction against a contract that is not yet on chain is unverified, and both transactions would share the client's sequence number. `lockDeposit` builds and persists the deploy; `fundDeposit` is called after the deploy lands. A re-deploy is allowed while `escrow_state` is still `null` (it overwrites the persisted `contractId`); an unsubmitted earlier deploy XDR is harmless because fund only ever targets the persisted id.

- **Why lifecycle rows are finer than `escrow_state` (Discover v2 / EXPERIENCE.md alignment).** The UX spine's state labels are Funded · Appointment completed · Awaiting approval · Ready to release · Released · In resolution · Resolved, and the escrow proof shows the contract/transaction record. `escrow_state` keeps its three values (AD-1); the finer label comes from the recorded `(contractId, lifecycleAction)` rows plus the persisted `contractId`, exposed through `getEscrowLifecycle` so Epic 3 never re-derives it. "Appointment completed" (provider changes milestone status) is not built here: the adapter has no `changeMilestoneStatus` call in this story.

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

## Auto Run Result

Status: blocked
Blocking condition: intent gap

**Uygulanan değişiklik (commit edilmedi):** Vendor-neutral `EscrowAdapter` arayüzü, Trustless Work adaptörü (deploy/fund/approve/release/startDispute/resolveDispute, tutar dönüşümü, tipli hatalar), cursor'lı ve idempotent reconciler, iki yeni tablo (`escrow_reconciler_state`, `escrow_processed_events`), `lockDeposit`'in adaptöre taşınması, 4 yeni config değişkeni. Deneme: [spec-2-6-attempt-1.patch](spec-2-6-attempt-1.patch).

**Doğrulama:** `npm run -w backend typecheck` temiz, `test` 131/131, `build` temiz; kök `npm test` (cargo 62, scripts 69) temiz. Manuel grep kontrolleri geçti. Matris denetimi: 14 satırın hepsi geçen bir testle karşılanıyor.

**Review:** 54 bulgu (high 7, medium 29, low 9, false 4, maybe-false 5). İki intent_gap grubu yüzünden patch/defer uygulanmadı. Reddedilenler: B12, E18 (low, karmaşıklık katıyor), I9, E4, E11, E23 (false). Takip review önerisi: false (bu geçişte patch uygulanmadı).

**Açık sorular (kullanıcının kararı):**
1. **Kanıt sözlüğü:** Trustless Work olay türlerinin adları SDK'da tanımlı değil. Reconciler olay `kind`'ı yerine escrow'un kendi `status`'u (`active|released|disputed`) ve bakiye alanlarından mı durum türetsin, yoksa Story 1.8'in canlı AC'leri çalıştırılıp gerçek tür adları görülene kadar mı beklensin?
2. **Uyuşmazlık çözümü → `escrow_state`:** Tümü müşteriye → `refunded`, tümü sağlayıcıya → `released`. Bölüşüm (ör. geç iptal) hangi duruma eşlenir? Sıfır pay (tümü tek tarafa) `resolveDispute`'ta izinli olmalı mı?
3. **Kanıtın rezervasyona bağlanması:** `lockDeposit` sırasında tahmini `contractId` rezervasyona kaydedilip kanıt yalnızca o kontrattan kabul edilsin mi (şema değişikliği, önerilen), yoksa escrow koşulları (roller/tutar/token) rezervasyonla mı eşleştirilsin?
4. **(maybe-false, high)** `fund` XDR'ı deploy zincire inmeden kurulabilir mi? Kurulamıyorsa `lockDeposit` iki adıma bölünmeli.

**Kalan riskler:** Kod geri alınamadığı için çalışma ağacı kirli. Doğrulanmış medium patch'ler (okuma-tutarı birimi, durum gerilemesi, olay sayfalama, boş config reddi, reconciler hata çevirisi, `clientAddress` kontrolü, `realFetchEscrowEvidence` testleri) sorular cevaplanınca uygulanacak.
