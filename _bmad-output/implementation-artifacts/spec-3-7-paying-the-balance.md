---
title: 'Story 3.7 — Paying the balance before the session'
type: 'feature'
created: '2026-09-20'
status: 'done'
review_loop_iteration: 0
baseline_revision: '567484280a797b6b6c46cd3c8f682fdf959def80'
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-3-4-client-booking-flow.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-3-5-two-sided-status-panel.md'
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** A booking carries `balanceAmount` (price − deposit) and `balanceState`, but the client has no way to pay it and the provider has no way to record cash. PRD 3.7 needs both, shown on both panels.

**Approach:** Two paths for the balance:
- **Through Pactly.** The backend builds a plain Stellar USDC payment from the client's wallet to the provider's wallet. The client signs it. The backend submits it through Soroban RPC and marks the booking `paid_platform` only after the confirmed ledger result.
- **In person.** The provider marks the balance as paid in cash.

This payment is independent of the escrow (AD-3). It never touches `escrow_state` or Trustless Work.

## Boundaries & Constraints

**Always:**
- `balance_state` is written only by this story's two paths:
  - `paid_platform`, only after `getTransaction` reports SUCCESS for the exact transaction Pactly built;
  - `paid_cash`, only by the booking's provider.
  It never moves back, and it never touches `escrow_state` (AD-3).
- The payment transaction is built server-side from the booking row:
  - source: `clientWalletAddress`;
  - destination: the provider wallet;
  - asset: the anchor-resolved USDC (3.4's resolver);
  - amount: `balanceAmount`, converted from smallest units with exact string arithmetic.

  Its hash is stored. `POST .../balance/submit` relays only a signed envelope whose hash matches that stored hash (the same rule as 3.4's submit binding).
- Paying is allowed only by the booking's client, only while `balanceState` is `unpaid`, only on a booking whose `escrow_state` is `locked`, and only before the appointment starts ("paid before the session", PRD AC5). A zero balance means nothing to pay, and the UI hides the action.
- Marking cash is allowed only by the booking's provider, while `unpaid` and `locked`.
- The UI says plainly "Balance X USDC · due before the session", with the three states "Unpaid", "Paid through Pactly" and "Paid in person", in text on both panels (3.5's cards). A Stellar Expert transaction link appears after a platform payment.
- Submission goes through Soroban RPC (`config.sorobanRpcUrl`) behind an injectable seam: `sendTransaction`, then poll `getTransaction` until SUCCESS or FAILED, with a timeout. Failures map to typed errors: `502 PAYMENT_FAILED` with a safe message, `503 PAYMENT_UNAVAILABLE`.

**Never:**
- No local-currency (SEP-6) balance path. Story 2.4 is not built, and the UI says so in one sentence.
- No change to escrow, the reconciler or `chain/`. No server-held keys.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Build payment | Client, `locked`, `unpaid`, balance > 0, before the slot starts | `{unsignedXdr}`; hash stored | Wrong wallet: `404`; paid, not locked, or started: `409 BOOKING_STATE` |
| Zero balance | `balanceAmount` "0" | Nothing to pay | `409 NOTHING_TO_PAY` |
| Submit | Signed XDR whose hash matches | Confirmed on chain → `paid_platform`, tx hash stored | Hash mismatch: `409 XDR_MISMATCH`; FAILED: `502 PAYMENT_FAILED`; unreachable or timeout: `503` |
| Mark cash | Provider, `locked`, `unpaid` | `paid_cash` | Client calls it: `404`; already paid: `409` |
| Lists | `GET /me/bookings`, `/me/provider/bookings` | Carry `balanceState` and the payment tx hash | No error expected |
| Amount conversion | `balanceAmount` "14000000000" | Payment amount "1400.0000000" (exact) | Non-integer string: refused |

</intent-contract>

## Code Map

- `backend/src/services/booking.ts` -- `setBalanceState`, `getBookingForClient` and the provider ownership check from 3.6 (or add one). 3.4's `submitSignedTransaction` is the hash-binding pattern to mirror.
- `backend/src/anchor/usdc.ts` (3.4) -- the resolved USDC `Asset` (code + issuer) for `Operation.payment`.
- `backend/src/db/schema.ts`, `migrations.ts` -- add nullable `balance_payment_tx_hash` and `balance_payment_built_hash` via the guarded ALTER pattern.
- `backend/src/app.ts` -- `POST /bookings/:id/balance/pay`, `POST /bookings/:id/balance/submit`, `POST /bookings/:id/balance/mark-cash`.
- `frontend/src/components/BookingCard.tsx` (3.5) -- the balance row and actions. Reuse `wallet.signXdr`.

## Tasks & Acceptance

**Execution:**
- `backend/src/payments/stellar.ts` -- build the payment XDR (a `TransactionBuilder` with a base fee and a 5-minute timeout, loading the client account sequence through the RPC seam), and submit and poll through the injectable seam.
- service, routes, migrations, and backend tests for every matrix row (RPC stubbed);
- frontend balance row, "Pay balance" (sign → submit → shows "Paid through Pactly" with the tx link), and a provider "Mark paid in person" button with a confirm step.

**Acceptance Criteria:**
- Given a locked booking with a balance, when the client pays through Pactly and signs, then both panels read "Paid through Pactly" only after the ledger confirms. When the provider marks cash on another booking, both read "Paid in person".
- Given the backend workspace, when `typecheck`, `test` and `build` run, then all are clean. Given the frontend, when `typecheck` and `build` run, then both are clean.

## Spec Change Log

### 2026-09-20 — Review kararları (kullanıcının devrettiği yetki)
- **Tetikleyen:** Gönderim aşamasının yalnızca hash'e bakması (dört katman), `markBalancePaidPlatform`'ın dönüş değerinin yok sayılması, `markBalancePaidCash`'in koşulsuz yazması.
- **Değişen:** Gönderim, ağa çıkmadan önce rezervasyonu yeniden okuyup durumu (unpaid, locked, seans başlamamış, kurulu hash var) doğruluyor. Onaylanan ödemeden sonra kurulu hash siliniyor. Korumalı yazma `false` dönerse bu gerçek bir hata: loglanıyor ve çağırana 409 BALANCE_ALREADY_SETTLED olarak bildiriliyor. "Elden ödendi" de korumalı yazma; sıfır bakiyeyi reddediyor, `released` durumunda da izin veriyor ve kurulu hash'i siliyor.
- **Kaçınılan kötü durum:** Aynı bakiyenin zincirde iki kez ödenmesi. Zincire giden ama hiçbir yere kaydedilmeyen bir ödemenin başarı gibi görünmesi. Onaylanmış bir Pactly ödemesinin elden ödeme kaydıyla ezilmesi.
- **KEEP:** Ayrı `payments/` modülü ve AD-3 ayrımı, tam string aritmetiği, hash bağı, yalnızca onaydan sonra `paid_platform`, sağlayıcıya özel nakit yolu.

## Review Triage Log

### 2026-09-20 — Review pass (4 katman, Opus)
- verdicts: 38 bulgu — high 6, medium 17, low 11, false 1, maybe-false 3
- Kök neden grupları:
  - **G1 gönderimde durum kontrolü yok (high, patch):** BH3, ECH1, ECH3, VG-O2, Intent-(ii) — yeniden okuma ve dört kontrol, onay sonrası hash'in silinmesi.
  - **G2 korumalı yazmanın sonucu yok sayılıyor (high, patch):** BH1, ECH2, VG-O1, Intent-(iii) — 409 BALANCE_ALREADY_SETTLED.
  - **G3 nakit yolu koşulsuz yazıyor (high, patch):** BH2, ECH1 — korumalı yazma, sıfır bakiye reddi, `released` izni.
  - **G4 RPC durum eşlemeleri (medium, patch):** BH4/ECH5 `TRY_AGAIN_LATER`, BH5/ECH6 kurulum aşamasının 500'e düşmesi, ECH7 int64 sınırı, ECH4/VG2 anket tavanı ve testlenebilirlik.
  - **G5 slotId olmayan rezervasyon (medium, patch):** ECH8.
  - **G6 nakit, escrow serbest bırakıldıktan sonra kaydedilemiyor (medium, patch):** ECH9.
  - **G7 frontend (medium/low, patch):** BH6/ECH10/ECH-claim1 kanıt linkinin kaybolması, ECH11 PAYMENT_UNAVAILABLE sonrası çift ödeme riski, BH12 "cüzdanda onayla" metninin anket sırasında kalması, BH13 tekrarlanan metin ve etiket tutarlılığı.
  - **G8 testler (patch):** VG1 korumalı yazmanın `false` dalı, VG2 gerçek anket döngüsü, VG3 iki kez kurma (yeniden deneme yolu), BH9 migration testi, BH10 route 400/404 dalları, Intent-(vi) sağlayıcı listesinde tx hash.
  - **Reddedilen:** BH8 `chain/client.ts`'in `pollTransaction`'ını yeniden kullanmak (low: hikâyenin sınırı `chain/`'e dokunmamak); BH7 sıfır bakiyede `NOTHING_TO_PAY` yerine `BOOKING_STATE` dönmesi (false: matris satırları bağımsız, ikisi de savunulabilir); Intent-(iv) tamsayı olmayan tutarın HTTP karşılığı (maybe-false: kalıcı veriden gelir, erişilemez); Intent-(i) ve VG-O5 frontend testsizliği (epic manuel doğrulamayı kabul ediyor).

## Verification

**Commands:**
- `npm run -w backend typecheck && npm run -w backend test && npm run -w backend build` -- expected: clean, all pass
- `npm run -w frontend typecheck && npm run -w frontend build` -- expected: clean

## Auto Run Result

Status: done

**Özet:** Müşteri, seans öncesinde kalan bakiyeyi USDC ile ödeyebiliyor: Pactly ödemeyi kuruyor, müşteri cüzdanında imzalıyor, Pactly Soroban RPC ile gönderip onaylanana kadar bekliyor ve ancak ondan sonra `paid_platform` yazıyor. Sağlayıcı elden ödemeyi işaretleyebiliyor. İki yol da korumalı yazma kullanıyor ve kurulu hash'i temizliyor, böylece aynı bakiye iki kez ödenemiyor. Ödeme escrow'dan bağımsız (AD-3).

**Commit'ler:** `9f4878b` spec, `dff079f` start, `7376902` feat, `897105b` fix (worktree'de yazıldı, 3.6 ve 3.8'in üstüne rebase edildi; çakışmalar birleştirmede çözüldü).

**Review:** 38 bulgu (high 6, medium 17, low 11, false 1, maybe-false 3). G1–G8 patch edildi. Reddedilenler: `chain/`'in poll fonksiyonunu yeniden kullanmak, sıfır bakiyede kod önceliği, tamsayı olmayan tutarın HTTP karşılığı, frontend testsizliği. Takip review önerisi: `true`; gönderimdeki durum kontrolü ve çift ödeme korumaları bir sonraki turdan geçmedi. Kullanıcının kuralı gereği takip turu çalıştırılmadı.

**Doğrulama:** backend typecheck ve build temiz, test 448/448; frontend typecheck ve build temiz.

**Kalan riskler:** Gerçek bir Stellar ödemesi hiç denenmedi (testnet cüzdanı ve RPC gerektirir). Frontend testi yok. Yerel para ile ödeme hâlâ Story 2.4'e bağlı.
