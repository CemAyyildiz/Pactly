---
title: 'Story 1.6 — Contract unit tests'
type: 'chore'
created: '2026-09-18'
status: 'done'
review_loop_iteration: 0
baseline_revision: 'a6ffcc1'
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
warnings: []
deferred:
  - summary: >-
      Hiçbir test `wasm32v1-none` artefaktına karşı koşmuyor; hepsi kontratı
      native kaydediyor.
    evidence: |-
      `env.register(EscrowContract, ())` (test.rs:22). Olay XDR şekli, hata
      diskriminantlarının tel üzerindeki karşılığı ve host'un auth zorlaması wasm
      yüzeyinde yaşıyor; `npm run contracts:build` yalnızca derlemeyi kanıtlıyor,
      davranışı değil. Story 1.4'ten devreden; 1.6 bunu kapatmadı çünkü PRD'nin
      kabul kriterleri native `cargo test` diyor ve hepsi karşılanıyor. Kapatmak
      isteyen `env.register_contract_wasm` ile derlenmiş artefaktı yükleyip aynı
      matrisi tekrar koşturmalı — testlerin build'e bağımlı hale gelmesi pahasına.
    location: >-
      contracts/escrow/src/test.rs:22
    severity: low
---

# Story 1.6 — Contract unit tests

## Sonuç: kod yazılmadı, story zaten karşılanmıştı

Bu story hiçbir kod değişikliği üretmedi. Sekiz kabul kriterinin tamamı, Stories 1.2–1.5 sırasında yazılan 62 testle zaten karşılanıyordu. Aşağıdaki denetim her kriteri onu kanıtlayan teste bağlar; her satır `contracts/escrow/src/test.rs` içinde doğrulandı.

Bu, testlerin sonradan yazılmamasının sonucu: 1.3, 1.4 ve 1.5'in her biri kendi I/O matrisini test etmek zorundaydı, ve o matrisler 1.6'nın istediklerini kapsıyor.

## Kabul kriteri → kanıt

| AC | Kanıtlayan test |
|---|---|
| 1. lock + release; profesyonelin bakiyesi artar | `deposit_is_released_and_the_professional_is_paid` |
| 2. zamanında iptal; müşterinin bakiyesi tam döner | `a_client_cancelling_before_the_deadline_is_refunded` → `assert_the_client_was_made_whole` |
| 3. no-show (deadline geçmiş); tutar profesyonele | `a_no_show_claimed_after_the_deadline_forfeits_the_deposit` → `assert_the_professional_was_paid` |
| 4. hata yolları: yinelenen booking | `duplicate_booking_id_is_rejected_and_changes_nothing` |
| 4. hata yolları: geçersiz tutar | `non_positive_amount_is_rejected_and_stores_nothing` |
| 4. hata yolları: yasadışı durum geçişi | `every_path_rejects_an_already_released_booking`, `every_path_rejects_an_already_refunded_booking` |
| 5. `cargo test` ile hepsi geçer | 62 passed, 0 failed, 0 ignored |
| 6. profesyonel iptali; deadline'ın iki yanında da tam iade | `a_professional_cancelling_before_the_deadline_refunds_the_client`, `a_professional_cancelling_after_the_deadline_still_refunds_the_client` |
| 7. geç müşteri iptali ve no-show talebi; ikisi de profesyonele öder ve `forfeited` yayınlar | `a_client_cancelling_after_the_deadline_forfeits_the_deposit`, `a_no_show_claimed_after_the_deadline_forfeits_the_deposit` |
| 8. her settlement yolu, yanlış taraf imzalayınca ve kimse imzalamayınca reddedilir | `only_the_professionals_own_authorization_cancels_by_professional`, `only_the_clients_own_authorization_cancels_by_client`, `only_the_professionals_own_authorization_claims_a_no_show`, `no_settlement_path_moves_money_without_a_signature` |

Kriterlerin ötesinde, aynı suite şunları da tutuyor: her settlement yolunun TTL bump'ı, auth-önce-durum sırası (mutasyonla doğrulanmış), `released`'ın yalnızca `release`'ten geldiği, hata diskriminantlarının sabitliği, deadline penceresinin sınırları ve booking'ler arası yalıtım.

## Denetim notu

AC2, AC3, AC6 ve AC7'nin dayandığı iki yardımcı — `assert_the_client_was_made_whole` ve `assert_the_professional_was_paid` — yalnızca adını taşıdıkları bakiyeyi değil, **üç bakiyeyi birden** kontrol ediyor (escrow, profesyonel, müşteri). Yani "müşterinin parası tam döndü" iddiası, paranın başka bir yere sızmadığını da kapsıyor. Bu, kriterlerin harfinden daha güçlü.

## Verification

**Commands:**
- `npm run contracts:test` -- expected: 62 passed, 0 failed, 0 ignored
- `npm run contracts:build` -- expected: `wasm32v1-none` release artefaktı, uyarı yok

## Auto Run Result

Status: done

Kod değişikliği yok. Story, önceki story'lerin testleriyle karşılanmış olarak denetlendi ve kapatıldı; denetim izi yukarıdaki tabloda. Tek açık madde `deferred` listesinde: testlerin hiçbiri wasm artefaktına karşı koşmuyor. PRD'nin AC5'i native `cargo test` dediği ve o karşılandığı için bu story kapsamına alınmadı, sahibi belirtilerek ertelendi.

Review katmanları çalıştırılmadı: inceleyecek diff yok.
