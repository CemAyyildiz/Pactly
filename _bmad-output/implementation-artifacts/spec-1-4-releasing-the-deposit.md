---
title: 'Story 1.4 — Releasing the deposit (release)'
type: 'feature'
created: '2026-09-18'
status: 'done'
review_loop_iteration: 0
baseline_revision: 'e8dff466db66e4181bdbf03c81ee84842466c41c'
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
warnings: ['oversized']
deferred:
  - summary: >-
      Story 1.5 kararı: permissionless `resolve_cancel` ile `release` aynı
      `Locked` kaydı üzerinde yarışır; tek hakem terminal-durum kontrolüdür.
    evidence: |-
      `release` hiçbir deadline karşılaştırması yapmaz (lib.rs:184 yalnızca
      `state != Locked` bakar). epic-1-context.md `resolve_cancel` için
      "sonucu yalnızca deadline karşılaştırması belirler" diyor. İki yolun
      etkileşimi 1.5 planlanırken yazılı bir karar olmalı.
    location: >-
      contracts/escrow/src/lib.rs:177-206
    severity: low
  - summary: >-
      İki Story 1.2 testi hâlâ `BytesN::random` kullandığı için her `cargo test`
      commit'li snapshot'larını yeniden yazıyor; bu, ikinci story'nin diff'ini
      de kirletti.
    evidence: |-
      `booking_round_trips_through_the_storage_helper` (test.rs:302) ve
      `writes_extend_the_persistent_ttl_to_the_bump_window` (test.rs:350).
      deferred-work.md'de Story 1.3'ten beri kayıtlı; test başına tek satır,
      ama 1.2'nin dosyalarına ait. Kapanmadıkça her story'nin diff'ine
      alakasız iki `M` girer.
    location: >-
      contracts/escrow/src/test.rs:302,350
    severity: low
  - summary: >-
      Profesyonelin token'ı alamadığı durumda (trustline yok, yetki kapalı,
      clawback) `release` trap eder ve depozito `Locked` kalır; tipli hata yok.
    evidence: |-
      `TokenClient::transfer` (lib.rs:191) `try_` değil, yani host trap'i tüm
      çağrıyı geri alır. Hiçbir test başarısız ödemeyi kapsamıyor.
      Netleştirecek şey: Pactly'nin kullanacağı SAC'ın AUTH_REQUIRED/clawback
      bayrakları açık mı, ve 1.5'in `resolve_cancel`'ı bu durumda müşteriye
      geri ödeme yolu bırakıyor mu. Test kurulabilir:
      `StellarAssetClient::set_authorized` / `clawback`.
    location: >-
      contracts/escrow/src/lib.rs:191-195
    severity: medium (unverified)
  - summary: >-
      `booking.token` kurala uymayan bir kontratsa transfer sessizce hiçbir şey
      taşımadan dönebilir; kayıt yine `Released` olur ve olay yayınlanır.
    evidence: |-
      Token adresi `create_booking` çağrısında serbestçe veriliyor; `release`
      bakiyeyi transfer öncesi/sonrası karşılaştırmıyor. Kök neden `release`
      değil, `create_booking`'in keyfi token kabul etmesi — 1.3'ten devreden.
    location: >-
      contracts/escrow/src/lib.rs:191-195
    severity: low
  - summary: >-
      `test_snapshots/*.json` dosyaları doğrulama değil: soroban-sdk onları
      yazar, hiçbir şey okuyup karşılaştırmaz. Sürüm kontrolünde tutulup
      tutulmayacakları bilinçli bir karar olmalı.
    evidence: |-
      soroban-sdk 27.0.6 `impl Drop for Env` → `to_test_snapshot_file()` yalnızca
      yazar. Bu story'de 12 yeni JSON diff'in ~%90'ını oluşturdu ve hiçbiri
      başarısız olamaz.
    location: >-
      contracts/escrow/test_snapshots/
    severity: low
  - summary: >-
      Tüm testler kontratı native kaydediyor; kabul kriterlerinin adlandırdığı
      `wasm32v1-none` artefaktı hiçbir test tarafından çalıştırılmıyor.
    evidence: |-
      `env.register(EscrowContract, ())` (test.rs:21-26). Olay XDR şekli, hata
      diskriminantları ve host auth zorlaması wasm yüzeyinde yaşıyor; build
      ayrı bir komut ve davranışı sınamıyor. Epic 1 genelinde geçerli.
    location: >-
      contracts/escrow/src/test.rs:21-26
    severity: low
---

<intent-contract>

## Intent

**Problem:** Deposits go into the contract and never come out. A professional who has done the work has no path to the money, so the escrow is a one-way trap rather than a settlement.

**Approach:** Add `release(booking_id)`: the client authorizes it, the contract pays the locked amount out to the professional, the record moves to `Released`, and a `released` event tells the rest of the system the money moved.

## Boundaries & Constraints

**Always:**
- `release` requires the **client's** `require_auth` — the address stored on the booking, not the caller (AD-2). The backend's key must never be able to release.
- Only a booking in `Locked` state can be released; `Released` and `Refunded` are terminal.
- The full stored `amount` is transferred from the contract's own address to the booking's `professional`, through the booking's own `token`.
- The record is updated through the existing `storage` helper, keeping the same key, and the write bumps the entry's TTL.
- The `released` event is emitted only after the transfer succeeds, with the same wire shape as `locked`: topics `("released", booking_id)`, data `amount`.
- Reuse the existing types, errors, storage and event modules; new error variants are appended with new numbers, never renumbered.

**Never:**
- No `resolve_cancel`, no deadline comparison, no refund path — Story 1.5 owns those.
- Do not change `initialize`, `get_admin`, `create_booking`, the `Booking` fields, or any existing error number or event shape.
- No partial releases, no fees, no platform cut: the amount paid out equals the amount stored.
- Nothing outside `contracts/escrow/` changes. Do not deploy or call the network.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Deposit released | Booking `Locked`, client authorizes | Contract pays `amount` to the professional; record becomes `Released`; `released` event carries the id and amount; TTL bumped | No error expected |
| Unknown booking id | No record under that id | Nothing transferred, nothing written, no event | `Error::BookingNotFound` |
| Already released | Booking in `Released` state | Nothing transferred, nothing written, no event; the record stays `Released` | `Error::InvalidState` |
| Already refunded | Booking in `Refunded` state | Nothing transferred, nothing written, no event | `Error::InvalidState` |
| Client did not authorize | Booking `Locked`, no signature from the stored client | Call fails; nothing transferred, record still `Locked` | `require_auth` fails with a host auth error |
| Someone else authorizes | Booking `Locked`, the professional (or any other address) signs instead of the client | Call fails; nothing transferred, record still `Locked` | `require_auth` fails with a host auth error |
| Released twice in a row | Successful release, then the same call again | The second call changes nothing and emits no event; the professional is paid exactly once | `Error::InvalidState` |

</intent-contract>

## Code Map

- `contracts/escrow/src/lib.rs` -- `#[contractimpl]` block holding `initialize`, `get_admin`, `create_booking`. `release` joins it. `create_booking` shows the house pattern: auth, then validation, then effects (transfer → store → emit). Reuse `TokenClient` and `env.current_contract_address()`, already imported.
- `contracts/escrow/src/storage.rs` -- `get_booking` (returns `Error::BookingNotFound`), `set_booking` (write + TTL bump), `has_booking`. Reads do not bump; only writes do. Use these; do not touch `env.storage()` directly.
- `contracts/escrow/src/types.rs` -- `Booking` (professional, client, token, amount, cancel_deadline, state) and `BookingState`. Update `state` only; every other field stays as stored.
- `contracts/escrow/src/error.rs` -- codes 1–8; `BookingNotFound = 4` and `InvalidState = 6` already exist and cover this story. No new variant is expected.
- `contracts/escrow/src/events.rs` -- `#[contractevent(topics = ["locked"], data_format = "single-value")] pub struct Locked { #[topic] booking_id, amount }`. Add `Released` as its sibling here; `env.events().publish(..)` is deprecated and `Cargo.toml` denies warnings, so the macro is the only way that builds.
- `contracts/escrow/src/test.rs` -- 31 tests with a `Fixture` (initializes the contract, registers a Stellar asset via `register_stellar_asset_contract_v2`, mints to the client, fixed booking id `[0x1d; 16]`, `NOW`), `assert_no_effect`, and discriminant/constant stability tests. Extend the same fixture; a rejected call's balances and storage are the real evidence, since host rollback makes an empty event list weak on its own.
- `contracts/escrow/Cargo.toml` -- `[lints.rust] warnings = "deny"`. A deprecated call fails the build rather than warning. Do not edit.

## Tasks & Acceptance

**Execution:**
- `contracts/escrow/src/events.rs` -- add the `Released` event beside `Locked`, same topic/data shape -- Epic 2's worker reads both, so they must be siblings rather than one-off publishes.
- `contracts/escrow/src/lib.rs` -- add `release(env, booking_id) -> Result<(), Error>`: load the booking, `require_auth` the stored client, reject a non-`Locked` state, pay the professional from the contract address through the booking's token, store the `Released` record, emit the event -- the only path money leaves the escrow to the professional.
- `contracts/escrow/src/test.rs` -- add a test per matrix row, asserting both balances and the stored state on the happy path and using `assert_no_effect`-style checks on every rejection, plus a `mock_auths` case proving the professional's signature does not authorize the call -- the matrix is this story's contract.

**Acceptance Criteria:**
- Given a released booking, when balances are read, then the professional holds exactly the deposited amount and the contract holds nothing for it.
- Given any rejected call, when it returns, then no tokens moved, the stored state is unchanged and no event was emitted.
- Given the crate, when `npm run contracts:test` and the `wasm32v1-none` release build run, then every test passes and the build produces a `.wasm` with no warnings.

## Spec Change Log

## Review Triage Log

### 2026-09-18 — Review pass
- verdicts: 27 findings — high 0, medium 1, low 20, false 4, maybe-false 2
- findings:
  - `[low]` `[patch]` `sprint-status.yaml` 1.4'ü `in-progress` derken spec `in-review` diyordu; 1.1–1.3 `review` kullanıyor — dosyanın kendi başlık yorumu da `review` diyor, tek kelime düzeltildi.
  - `[low]` `[patch]` `release`'teki "önce para hareket eder, böylece başarısız transfer kaydı olduğu gibi bırakır" yorumu Soroban'da yanlış gerekçe — trap eden alt çağrı tüm yazmaları geri alır; yorum gerçek gerekçeyle (host atomikliği + ev düzeni) değiştirildi.
  - `[low]` `[patch]` `releasing_an_unknown_booking_id_is_rejected_and_changes_nothing` yalnızca `f.booking_id`'yi izleyen `snapshot()`'a bakıyordu, sorulan id'ye değil — `has_booking(&unknown_id)` kontrolü eklendi.
  - `[low]` `[patch]` `an_unknown_booking_id_is_reported_without_any_authorization` ve `release_checks_authorization_before_the_state_check` yalnızca dönüş değerini doğruluyordu — ikisine de `assert_release_changed_nothing` eklendi.
  - `[low]` `[patch]` `only_the_clients_own_authorization_releases_the_deposit`'in mutlu yolu yalnızca profesyonelin bakiyesini kontrol ediyordu — olay, escrow bakiyesi ve saklanan durum eklendi.
  - `[low]` `[patch]` `ReleaseResult`, `CreateResult` ile bayt bayt aynıydı — tek `CallResult` takma adına indirildi, 1.5'in `resolve_cancel`'ı da onu kullanacak.
  - `[low]` `[reject]` `FUNDING` sabiti tanıtıldı ama Story 1.3'ün 26 literali dönüştürülmedi — sabit kendi bölümüne doğru kapsanmış; 26 satırı bu story'nin diff'ine eklemek adlandırılabilir bir zarar olmadan gürültü üretirdi.
  - `[low]` `[patch]` `events.rs` modül dokümanı hâlâ "Stories 1.4 and 1.5 add their own events here" diyordu — 1.4 artık dosyada, metin güncellendi.
  - `[false]` `[reject]` `release`'in `NotInitialized` kapısını atlaması bir denetim açığı değil: kayıt ancak `create_booking` çalıştıysa var olabilir, o da admin gerektirir; ulaşılabilir kötü sonuç gösterilmedi ve doc yorumu zaten hangi imzayı talep ettiğini yazıyor.
  - `[low]` `[defer]` `release`/`resolve_cancel` yarışı belgelenmemiş — 1.5 henüz yok, bu story'nin kusuru değil; `deferred` listesine 1.5 kararı olarak taşındı.
  - `[low]` `[defer]` İki Story 1.2 testi `BytesN::random` yüzünden snapshot'larını her koşuda yeniden yazıyor — önceden var, `deferred-work.md`'de Story 1.3'ten beri kayıtlı; ikinci kez ertelendi, artık tekrar eden gürültü olarak not düşüldü.
  - `[maybe-false]` `[defer]` Başarısız ödeme transferi için test yok — ulaşılabilirliği Pactly'nin SAC bayraklarına bağlı; EC ile aynı kök nedende gruplandı, ne kanıtın karara bağlayacağı `deferred`'a yazıldı.
  - `[maybe-false]` `[defer]` Profesyonel token'ı alamazsa `release` trap eder ve depozito `Locked` kalır — doğruysa medium; önerilen `try_transfer` + tipli hata dalı ödemeyi yine çözmez ve spec'in yasakladığı davranış değişikliğidir, karar mimarinin.
  - `[low]` `[defer]` Kurala uymayan token sessizce transfer etmeden dönebilir — kök neden `create_booking`'in keyfi token adresi kabul etmesi, 1.3'ten devreden; `release`'e bakiye karşılaştırması eklemek bu story'nin kusurunu değil öncekini yamalardı.
  - `[medium]` `[patch]` `release`'in deadline'ı kasıtlı olarak yok sayması hiçbir testle sabitlenmemiş — katmanın mutasyonu (deadline kapısı eklenmiş `release`) 42 testin tamamını yeşil geçti; `a_deposit_is_still_releasable_after_the_cancel_deadline` eklendi, artık mutasyon yakalanıyor.
  - `[low]` `[defer]` Snapshot gürültüsü (yukarıdaki satırla aynı kök neden, aynı rota).
  - `[low]` `[defer]` `test_snapshots/*.json` doğrulama değil, yalnızca yazılıyor — sürüm kontrolünde tutulmaları proje düzeyinde bir karar, `deferred`'a alındı.
  - `[false]` `[reject]` "Kontratın hangi yüzeyi garanti ettiği kayıtlı değil" iddiası çürüdü: `release`'in doc yorumu açıkça "not of whoever submitted the transaction" diyor; üstelik Soroban üst düzeyde çağıran kimliği sunmaz, yani hesap yüzeyindeki okuma uygulanabilir değil.
  - `[low]` `[reject]` `Snapshot` TTL'i yakalamıyor, yani "hiçbir şey yazılmadı" değer yüzeyinde doğrulanıyor — okuma yolu zaten bump etmiyor ve `storage.rs` bunu yazılı kural yapıyor; `Snapshot`'a TTL eklemek gösterilmemiş bir duruma karşı karmaşıklık katardı.
  - `[low]` `[reject]` Saklanan durumun genel bir okuma yüzeyi yok — kontrata getter eklemek spec'te olmayan yeni genel yüzeydir; tasarlanan tüketici yüzeyi olay akışı.
  - `[low]` `[reject]` Reddedilen çağrılarda "olay yok" iddiası host geri alması yüzünden boşta — kodun kendi yorumu bunu zaten söylüyor ve gerçek kanıt olarak snapshot karşılaştırmasını gösteriyor.
  - `[low]` `[reject]` `InvokeError::Abort` her trap'te aynı, yani tek başına "`require_auth` reddetti"yi kanıtlamaz — ayırt eden test (`release_checks_authorization_before_the_state_check`) zaten var.
  - `[low]` `[defer]` Testler native kayıtlı kontrata karşı koşuyor, kabul kriterinin adlandırdığı wasm artefaktına karşı değil — Epic 1 geneli, bu story'nin ürünü değil.
  - `[low]` `[patch]` Spec/sprint-status uyuşmazlığı (ilk satırla aynı kök neden, aynı rota).
  - `[low]` `[defer]` Snapshot gürültüsü (aynı kök neden, aynı rota).
  - `[false]` `[reject]` "Üç test toleransları garantiye çeviriyor" çürüdü: spec'in Design Notes bölümü hem kayıt-önce-auth sırasını hem durum-sonra-auth sırasını açık karar olarak yazıyor, yani testler kararı sabitliyor, kendi başlarına icat etmiyor.
  - `[false]` `[reject]` "Profesyonelin tek taraflı yolu yok" iddiası bu diff'in sapması değil: intent'in Always listesi `release`'i müşterinin eylemi olarak tanımlıyor ve tek taraflı yolu açıkça 1.5'in `resolve_cancel`'ına veriyor.

## Design Notes

- **Auth comes from the record, not the caller.** `release` must read the booking before it can know which address to demand a signature from, so the lookup precedes `require_auth`. That makes an unknown id observable to an unsigned caller — acceptable, since booking ids are generated off chain and carry no secret, and the alternative would be demanding a signature from an address nobody has yet identified.
- **State is checked after auth.** A signed client is the only party who may learn whether their own booking is still releasable; the ordering mirrors `initialize`, where the auth check runs before the state check.
- **`released` reuses `locked`'s wire shape.** One shape for every money event keeps Epic 2's worker symmetrical: topics `(name, booking_id)`, data `amount`.

## Verification

**Commands:**
- `npm run contracts:test` -- expected: every test passes, including all matrix rows
- `npm run contracts:build` -- expected: a `wasm32v1-none` release artifact, no warnings (the deny-warnings lint turns any deprecated call into a build failure)

## Auto Run Result

Status: done

**Yapılan değişikliğin özeti.** Escrow kontratına `release(booking_id)` eklendi: kayıt okunur, üzerindeki **müşterinin** imzası istenir, durum `Locked` değilse `InvalidState` ile reddedilir, saklanan `amount` kontratın kendi adresinden bookingin kendi token'ı üzerinden profesyonele ödenir, kayıt `Released` olur (TTL bump'lanarak) ve `released` olayı yayınlanır. Para escrow'dan profesyonele yalnızca bu yoldan çıkar.

**Değişen dosyalar.**
- `contracts/escrow/src/lib.rs` — `release` entry point'i ve crate dokümanının güncellenmesi.
- `contracts/escrow/src/events.rs` — `Locked`'ın kardeşi `Released` olayı (topics `("released", booking_id)`, data `amount`).
- `contracts/escrow/src/test.rs` — 13 yeni test, `locked_fixture`, `Snapshot`, `assert_release_changed_nothing`, tek `CallResult` takma adı.
- `contracts/escrow/test_snapshots/` — soroban-sdk'nın test başına yazdığı 13 yeni ledger snapshot'ı, artı iki eski testin rastgele id'den kaynaklanan gürültüsü.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — 1.4 `review`.

**Review bulguları.** 4 katman 27 bulgu bildirdi: high 0, medium 1, low 20, false 4, maybe-false 2. **8 giriş yamandı** (1 medium, 7 low): sprint-status tutarsızlığı, `release`'teki yanlış sıralama gerekçesi, bilinmeyen id'nin yazılmadığının doğrulanması, iki testin yalnızca dönüş değerine bakması, mutlu yolun eksik iddiaları, `ReleaseResult` kopyası, bayat `events.rs` dokümanı ve deadline kuralının testle sabitlenmemiş olması. **6 madde ertelendi** (frontmatter `deferred`): 1.5'in `resolve_cancel` yarışı, snapshot gürültüsü, alıcısı token'ı alamayan ödeme, kurala uymayan token, snapshot'ların sürüm kontrolündeki yeri, native-vs-wasm test yüzeyi.

**Reddedilen bulgular ve gerekçeleri.**
- `FUNDING`'in Story 1.3'ün 26 literaline yayılmaması — sabit kendi bölümünde doğru kapsanmış; yayma adlandırılabilir zarar olmadan diff gürültüsü üretir.
- `release`'in `NotInitialized` kapısını atlaması — kayıt ancak admin gerektiren `create_booking` çalıştıysa var olur; ulaşılabilir kötü sonuç yok.
- "Hangi yetkilendirme yüzeyinin garanti edildiği yazılı değil" — doc yorumu bunu açıkça yazıyor ve Soroban üst düzeyde çağıran kimliği sunmuyor.
- `Snapshot`'ın TTL'i yakalamaması — okuma yolu bump etmiyor, `storage.rs` bunu kural olarak yazıyor; ek karmaşıklık gösterilmemiş bir duruma karşı olurdu.
- Saklanan durumun genel getter'ı olmaması — spec'te olmayan yeni genel yüzey.
- Reddedilen çağrılarda "olay yok" iddiasının boşta olması — kod bunu zaten yorumluyor, gerçek kanıt snapshot karşılaştırması.
- `InvokeError::Abort`'un kaba olması — ayırt eden test zaten var.
- "Üç test toleransı garantiye çeviriyor" — her iki sıralama da Design Notes'ta açık karar.
- "Profesyonelin tek taraflı yolu yok" — intent bu yolu açıkça 1.5'e veriyor.

**Takip review önerisi:** `false`. Yamanan girişlerin hiçbiri `high` değildi ve yalnızca bir `medium` yamandı (patched: medium 1, low 7).

**Yapılan doğrulama.**
- `npm run contracts:test` → 43 passed, 0 failed (review öncesi 42 + eklenen deadline testi).
- `npm run contracts:build` → `wasm32v1-none` release derlemesi, uyarı yok (`warnings = "deny"` altında).
- Doğrulama katmanının mutasyonu (`release`'e deadline kapısı) artık `a_deposit_is_still_releasable_after_the_cancel_deadline` tarafından yakalanıyor.

**Kalan riskler.** Ödeme transferinin başarısız olduğu yol hâlâ testsiz: profesyonel token'ı alamıyorsa `release` trap eder ve depozito `Locked` kalır — 1.5'in geri ödeme yolu bunu çözüyor mu, mimari kararı. Kontrat davranışı yalnızca native kayıtta sınanıyor; olay XDR şekli ve hata diskriminantlarının wasm yüzeyindeki karşılığı derleme dışında doğrulanmadı.
