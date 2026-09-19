---
title: 'Story 2.5 — Backend service layer and data model'
type: 'feature'
created: '2026-09-18'
status: 'done'
review_loop_iteration: 0
baseline_revision: '91b84443f05245808946453c6877cfae10aef146'
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
warnings: ['multiple-goals', 'oversized']
deferred:
  - summary: >-
      Bir booking'e ait "unknown booking id" anomalisi kaydedildikten sonra o
      booking daha sonra oluşturulursa, aynı olayın tekrar teslimi hâlâ
      "duplicate" okunuyor ve escrow_state hiç yazılmıyor — kalıcı olarak.
    evidence: |-
      `processEvent` dedupe anahtarını `(booking_id, event_type)` üzerinden
      tutuyor ve anomali kaydı da aynı anahtarı yakıyor. AD-13 gereği booking
      satırı zincir çağrısından önce yazıldığı için tasarlanan akışta bu
      durum oluşmamalı — ama oluşursa kurtarma yolu yok. Otomatik iyileşme mi
      (booking sonradan bulunursa yeniden dene) yoksa kasıtlı olarak insan
      müdahalesi gerektiren bir veri bütünlüğü sorunu mu olması gerektiği
      ürün kararı; spec'in matris satırı yalnızca "kaydedilsin, worker devam
      etsin" diyor, kendi kendine düzelmesini istemiyor.
    location: >-
      backend/src/chain/event-worker.ts:processEvent
    severity: medium
  - summary: >-
      `pollTransaction`'ın toplam bekleme süresi (~13.5s, 10 deneme × 1.5s)
      işlemin kendi geçerlilik penceresinden (`setTimeout(30)`) kısa; hiç
      gerçek ağa karşı doğrulanmadı.
    evidence: |-
      Bu değerler ayarlanabilir sabitler ve gerçek testnet zamanlamasına
      karşı hiç sınanmadı — kontrat henüz deploy edilmediği için sınanamazdı
      da. İlk gerçek testnet koşusu (Epic 1 retro aksiyon #1) bunu ortaya
      çıkaracak.
    location: >-
      backend/src/chain/client.ts:pollTransaction
    severity: low
  - summary: >-
      `provider_applications` ve `reviews` tabloları yalnızca DDL/şema
      uyumu için test edildi; erişimci modülleri (db/providerApplications.ts,
      db/reviews.ts) ve servis fonksiyonları henüz yok.
    evidence: |-
      Story 2.5'in AC1a'sı yalnızca "stored" diyor, erişimci istemiyor.
      Bu iki tablo Story 4.1 (başvurular) ve 4.4'ün (değerlendirmeler) kendi
      işi; o story'ler gelene kadar erteleniyor.
    location: >-
      backend/src/db/schema.ts, backend/src/db/migrations.ts
    severity: low
  - summary: >-
      Kategori tohum verisi yok; gerçek bir veritabanına karşı
      listCategories/listMarketplaceProfiles boş döner.
    evidence: |-
      `scripts/README.md` tohum verisini zaten kendi kapsamına ("Seed —
      create sample categories and providers for the demo") yazmış; bu
      story'nin işi şema ve erişimcilerdi, tohumlama değil.
    location: >-
      scripts/
    severity: low
  - summary: >-
      `migrations.ts` gerçek bir göç sistemi değil — yalnızca CREATE TABLE
      IF NOT EXISTS; sürüm takibi yok, ALTER yolu yok.
    evidence: |-
      Projenin şu anki aşamasında (testnet, canlı veri yok) tam bir göç
      aracı (örn. drizzle-kit) erken kalır; epic bağlamının pinlediği
      sürümler arasında da yok. Şema gerçek veriyle evrilmeye başladığında
      yeniden değerlendirilmeli.
    location: >-
      backend/src/db/migrations.ts
    severity: low
---

<intent-contract>

## Intent

**Problem:** The backend is a health endpoint and a config loader. Nothing stores a booking, nothing can call the escrow contract, and nothing learns that money moved. Every other story in this epic — and the whole of Epic 3 — needs somewhere to put data and one way to reach the chain, so they are all blocked on a layer that does not exist.

**Approach:** Stand up the three things the rest of the system is written against: a database schema for what the chain does not hold, a single chain client that every contract call goes through, and a cursored event worker that mirrors the chain's money events into that database. Routes and authentication arrive with their own stories; this one builds the layer beneath them.

## Boundaries & Constraints

**Always:**
- A booking carries **two independent state fields** (AD-3): `escrow_state` (`locked`/`released`/`refunded`), written **only** by the event worker after a contract event is processed, and `balance_state` (`unpaid`/`paid_platform`/`paid_cash`), written only by the backend. No column, API field or function merges them.
- The chain is the authority on money state (AD-1). No code path outside the event worker may write `escrow_state`. On a conflict between database and chain, the chain wins.
- **All contract access goes through one client** under `backend/src/chain/` (AD-8). Contract errors are translated to application errors there, and no other module opens an RPC connection. The client covers `create_booking`, `release`, `cancel_by_professional`, `cancel_by_client` and `claim_no_show`.
- The event worker is **cursored and idempotent** (AD-9): it keeps the last processed ledger cursor in the database, dedupes by `(booking_id, event_type)`, and resumes from the cursor on restart. Processing the same event twice changes nothing observable.
- It understands exactly the five money events Epic 1 emits — `locked`, `released`, `refunded`, `cancelled`, `forfeited` — and maps each to its `escrow_state`. `released` and `forfeited` both mean the professional was paid; only `released` may ever feed a verified-session counter, and only `cancelled` a provider-cancellation counter (AD-4).
- Layering is one-way: routes → services → db/chain/anchor. A service never imports a route; nothing outside `db/` builds SQL; nothing outside `chain/` speaks to the RPC.
- Amounts are integers in the asset's smallest unit, stored and carried as strings at any boundary (AD-7). No floats anywhere.
- Every environment variable is read through the existing `backend/src/config.ts` and nowhere else.
- **Testing surface, stated explicitly:** the matrix rows below are stated about the chain client and the event worker as units. Tests must reach *those* surfaces — the client's translation of a contract error, and the worker's handling of a batch of events against a real (temporary, file-based) database. Pure helpers may be tested on their own in addition, never instead. Network and RPC access sit behind an injected seam that defaults to the real implementation.

**Never:**
- Do not build HTTP routes, authorization middleware or any SEP/anchor client. Story 2.1 owns authentication, 2.2–2.4 own the anchor, Epic 3 owns the booking routes. This story stops at the service layer's public functions.
- Do not call the network, the Soroban RPC, or a live contract while building this story. `ESCROW_CONTRACT_ID` is empty and the contract is not deployed; the client is written and unit-tested against injected seams, and its first real call belongs to a later story.
- Do not write `escrow_state` from a service, a seed script or a test helper that pretends to be one — only the event worker writes it.
- Do not invent a money state the contract cannot produce, and do not collapse `forfeited` into `released` in storage even though both pay the professional; the distinction is what Epic 4's counter depends on.
- Do not change `contracts/`, `frontend/`, or `scripts/`. Within `backend/`, `config.ts` gains new variables only if genuinely required, and `.env.example` gains any such key with an empty value.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Booking mirrored | `locked` event for a known booking id | `escrow_state` becomes `locked`; `balance_state` untouched; cursor advances | No error expected |
| Same event twice | A batch replaying an already-processed `(booking_id, event_type)` | Nothing changes; no duplicate row; cursor still advances | No error expected |
| Restart | Worker restarted with a stored cursor | Processing resumes from the cursor, not from the first ledger | No error expected |
| Payout events distinguished | `released` then, on another booking, `forfeited` | Both set `escrow_state` to `released`; the event type is recorded distinctly so a counter can tell them apart | No error expected |
| Provider cancellation | `cancelled` event | `escrow_state` becomes `refunded`; recorded as `cancelled`, not as a client refund | No error expected |
| Unknown booking id | An event whose booking id has no row | The event is recorded and surfaced as an anomaly; no row is invented | Logged, worker continues |
| Two states independent | A booking marked `paid_cash`, then a `released` event | `balance_state` stays `paid_cash`, `escrow_state` becomes `released` | No error expected |
| Contract error translated | A contract call returning `InvalidState` | The client raises an application error naming the condition, not a raw host code | Typed application error |
| Contract call with no contract id | `ESCROW_CONTRACT_ID` empty | The client refuses before reaching the network, naming the setup step | Typed configuration error |
| Amount round-trip | An `i128` amount at the top of the range | Stored and read back as the identical string; no precision lost | No error expected |

</intent-contract>

## Code Map

- `backend/src/config.ts` -- the one place environment variables are read; `required()`, `declared()`, `list()`, `databasePath()` already exist, and `escrowContractId` is already `declared()` (empty until deployed). Import `config` from here; never touch `process.env` elsewhere. `PACTLY_ENV_FILE` is the test isolation hook.
- `backend/src/index.ts` -- Hono app with `/health` only. The event worker's lifecycle hooks in here eventually; keep the change minimal and do not add routes.
- `backend/test/config.test.ts` -- the existing test convention: Node's built-in runner, real process, `PACTLY_ENV_FILE` for isolation. Copy this shape; do not add a test framework.
- `backend/package.json` -- `hono` 4.13.8, `@hono/node-server` 2.1.1; `tsx`, `typescript` 5.9.3, `@types/node` as dev. `drizzle-orm` 0.45.2, `better-sqlite3` 13.0.3 and `@stellar/stellar-sdk` 17.1.0 are pinned by the epic context and are **not yet installed**.
- `backend/tsconfig.json` -- **read this before writing tests**: `"include": ["src"]`, so `backend/test/` is currently outside the typecheck. Epic 1's retrospective raised this (F-12); bring `test` into the include as part of this story.
- `contracts/escrow/src/events.rs` -- the authoritative wire shape: every event is topics `(name, booking_id)`, data `amount`. Five names, no others.
- `contracts/escrow/src/error.rs` -- the error catalogue the chain client translates: codes 1–9, `AlreadyInitialized` … `TooEarly`. Note the retrospective's F-10: `InvalidParties`' doc is broader than its check — translate what the contract *does*, not what the doc says.
- `contracts/escrow/src/types.rs` -- `Booking` fields and `BookingState`. The mirror's columns follow these; read the retrospective's F-8 first, because this file's field docs still describe the superseded model.
- `scripts/src/env-lines.ts`, `scripts/src/decisions.ts` -- the shape Epic 1 settled on for testable-without-network code: pure decisions separated from thin effectful wrappers with an injected default. Follow it; do not copy the code.
- `_bmad-output/implementation-artifacts/epic-2-context.md` -- AD-1/3/4/7/8/9 in force, the structural seed for `backend/src/`, and the note that this story's conventions are what 2.1–2.4 are written against.

## Tasks & Acceptance

**Execution:**
- `backend/package.json` -- add `drizzle-orm` 0.45.2, `better-sqlite3` 13.0.3, `@stellar/stellar-sdk` 17.1.0 at the pinned versions -- the epic fixed these, and a version drift here reaches every later story.
- `backend/src/db/` -- the Drizzle schema and its migration: provider profiles, categories, provider applications and their state, bookings (carrying both `escrow_state` and `balance_state`, matched to the on-chain `booking_id`), reviews, the verified-session counter, and the event worker's cursor and processed-event ledger -- this is the mirror for everything the chain does not hold.
- `backend/src/chain/client.ts` -- the single contract client: one function per contract entry point, contract errors translated into typed application errors, RPC access behind an injected seam -- AD-8 exists so error translation and retry live in one place instead of five.
- `backend/src/chain/event-worker.ts` -- read events from a cursor, dedupe by `(booking_id, event_type)`, map each of the five names to an `escrow_state`, advance the cursor -- the only writer of `escrow_state` in the system.
- `backend/src/services/` -- the booking and profile service functions the later stories call, written so routes can stay thin; no SQL outside `db/`, no RPC outside `chain/`.
- `backend/tsconfig.json`, `backend/package.json` -- bring `test/` into the typecheck and make `npm run -w backend typecheck` cover it -- Epic 1 shipped a workspace whose tests no checker ever read.
- `backend/test/` -- tests reaching the two surfaces the matrix names: the chain client's error translation and its refusal without a contract id, and the event worker driven over a real temporary database through its injected seam, covering replay, restart, the unknown id, and the two-states-independent row.

**Acceptance Criteria:**
- Given a booking row and a batch of contract events, when the worker runs, then `escrow_state` reflects the last event and `balance_state` is untouched.
- Given the same batch replayed, when the worker runs again, then nothing observable changes and no duplicate processed-event row exists.
- Given a worker restarted with a stored cursor, when it runs, then it begins after the cursor rather than at the beginning.
- Given a contract call that the contract rejects, when the client returns, then the caller receives a typed application error naming the condition, never a raw host code.
- Given an empty `ESCROW_CONTRACT_ID`, when any contract call is attempted, then it fails before any network access with an error naming the setup step.
- Given the backend workspace, when `npm run -w backend typecheck` and `npm run -w backend test` run, then both are clean and the typecheck includes `test/`.

## Spec Change Log

## Review Triage Log

### 2026-09-19 — Review pass
- verdicts: 32 findings — high 5, medium 4, low 20, false 3, maybe-false 0
- Dört katman ağır örtüşmeyle 56'nın üzerinde ham bulgu bildirdi; aşağıda kök nedene göre gruplanmış. Beş `high` bulgunun hepsi ayrı ayrı mutasyonla kanıtlandı ve yama sonrası kendim tekrar çalıştırıp yakalandığını doğruladım.
- findings:
  - `[high]` `[patch]` Olay işçisi dedupe kaydını yazıp *sonra* `escrow_state`'i güncelliyordu — iki ayrı adım. Süreç arada ölürse dedupe kaydı commit'li kalıyor, aynı olay bir daha "duplicate" okunuyor ve `escrow_state` asla yazılmıyor. `processEvent`, `db.transaction()` içine alındı (better-sqlite3'ün senkron sözleşmesine uygun senkron varyantlarla); arada atılan bir hata testle kanıtlandı. Yama sonrası kendim mutasyonla (iki adımı ayırıp) tekrar test ettim: 1 test düşüyor.
  - `[high]` `[patch]` Aynı atomik olmayan yazma, kenar-durum katmanından (aynı kök neden, aynı rota; mutasyonla kanıtlanmış).
  - `[high]` `[patch]` Aynı atomik olmayan yazma, doğrulama katmanından (aynı kök neden, aynı rota; mutasyonla kanıtlanmış).
  - `[high]` `[patch]` `decodeEvent` — ham RPC olayını çözen tek kod — hiç test edilmiyordu; olay işçisi testlerinin hepsi elle kurulmuş `ChainEvent` nesneleri kullanıyordu. `raw.topic[0]`/`raw.topic[1]` yer değiştirse hiçbir test düşmüyordu. Gerçek `ScVal`'lerle (`nativeToScVal`) yeni test dosyası eklendi. Yama sonrası aynı mutasyonu tekrarladım: 3 test düşüyor.
  - `[high]` `[patch]` Aynı testsizlik, doğrulama katmanından, mutasyonla kanıtlanmış (aynı kök neden, aynı rota).
  - `[high]` `[patch]` `chain/client.ts`'in başarı yolu (simülasyon → imzala → gönder → bekle → hash dön) ve gönderim-sonrası iki hata dalı hiç test edilmiyordu; testlerin dördü de yalnızca simülasyon-öncesi reddedilen iki yolu kapsıyordu. Hash'i sabit bir string'le değiştirmek 29/29'u geçiriyordu. Üç yeni test eklendi: başarı yolu, `PENDING` olmayan gönderim durumu, `FAILED` sonuç durumu.
  - `[high]` `[patch]` Aynı testsizlik, blind-hunter katmanından (aynı kök neden, aynı rota).
  - `[high]` `[patch]` `lockDeposit`'in profesyonel/müşteri argümanlarının doğru eşlendiğini hiçbir test doğrulamıyordu; ikisini yer değiştirmek 29/29'u geçiriyordu — depozito yanlış tarafa kilitlenebilirdi. Yeni test, kurulan işlemin argümanlarını yakalayıp doğruluyor. Yama sonrası aynı mutasyonu tekrarladım: 1 test düşüyor.
  - `[high]` `[patch]` `listApprovedProviderProfiles`'in onay filtresi hiç test edilmiyordu; filtreyi kaldırmak 29/29'u geçiriyordu — onaylanmamış sağlayıcılar pazara sızabilirdi (PRD Story 4.1 AC4). Yeni test eklendi. Yama sonrası aynı mutasyonu tekrarladım: 1 test düşüyor.
  - `[medium]` `[patch]` `chain-client.test.ts`, `client.ts` üzerinden `config.ts`'i dolaylı içe aktarıyordu; `config.ts`'in modül yüklemede `.env` okuyup eksik değişkende `process.exit(1)` çağırması, her ağ seam'i override edilmiş olsa bile test dosyasını gerçek `.env`'e bağımlı kılıyordu. `config.test.ts`'in zaten kurduğu `PACTLY_ENV_FILE` kuralı uygulandı. Yama sonrası gerçek `.env`'i geçici olarak kaldırıp doğruladım: testler hâlâ geçiyor.
  - `[medium]` `[patch]` Aynı test izolasyonu açığı, kenar-durum katmanından (aynı kök neden, aynı rota).
  - `[medium]` `[patch]` `db.test.ts`'teki bir test, `updateEscrowState`'i — tek yazıcı olması gereken fonksiyonu — sırf ilgisiz bir iddiaya (bakiye durumunun etkilenmediği) zemin hazırlamak için doğrudan çağırıyordu. Spec'in kendi "test yardımcısı worker'a benzeşmesin" yasağının ihlaliydi; `sed`'le okuyup kendim doğruladım. Kurulum artık gerçek tek yazıcı olan `processEvent` üzerinden geçiyor; fonksiyonun kendi birim testi dokunulmadan kaldı.
  - `[medium]` `[patch]` Aynı ihlal, kenar-durum ve blind-hunter katmanlarından (aynı kök neden, aynı rota).
  - `[medium]` `[patch]` `provider_applications` ve `reviews` tabloları `schema.ts`'te tanımlı, hiçbir test onlara yazıp okumuyordu; DDL bir metin dizesi olduğu için şemayla sessizce ayrışabilirdi. DDL'de bir sütun adını değiştirmek typecheck'i ve testleri temiz geçiriyordu. Drizzle tablo nesneleri üzerinden gidiş-dönüş testi eklendi.
  - `[low]` `[patch]` `escrowState`/`balanceState`/`providerApplications.state` düz `text(...)` olarak tanımlıydı; `ESCROW_STATES`/`BALANCE_STATES` sabitleri vardı ama uygulanmamıştı. Drizzle'ın `{enum: [...]}` biçimi eklendi, davranış değişmedi.
  - `[low]` `[patch]` `cancelDeadline` doğrulanmıyordu; `parseAmount`/`bookingIdToBytes` gibi kardeşlerinin aksine `NaN` çıplak `BigInt()`'e ulaşıp tipsiz `RangeError` fırlatıyordu. Aynı desende `parseCancelDeadline` eklendi.
  - `[low]` `[patch]` `updateEscrowState`/`updateBalanceState`/`setBalanceState` etkilenen satır sayısını kontrol etmiyordu; bilinmeyen id ile çağrı sessizce "başarılı" dönüyordu. Üçü de artık `result.changes === 0` durumunda adlandırılmış hata fırlatıyor.
  - `[low]` `[patch]` `realFetchEvents()`, `client.ts`'in aksine boş `ESCROW_CONTRACT_ID`'yi reddetmiyordu. Aynı `ChainConfigError` koruması eklendi.
  - `[medium]` `[defer]` Bilinmeyen booking id için anomali kaydedildikten sonra o booking sonradan oluşturulursa, aynı olayın tekrar teslimi hâlâ kalıcı olarak `escrow_state`'i atlıyor — dört katman da bunu ayrı ayrı işaret etti. AD-13 gereği tasarlanan akışta bu durum oluşmamalı; oluşursa otomatik iyileşme mi yoksa kasıtlı insan-müdahalesi gerektiren bir bütünlük sorunu mu olması gerektiği ürün kararı. `deferred`'a yazıldı.
  - `[low]` `[defer]` `pollTransaction`'ın zamanlaması gerçek ağa karşı hiç sınanmadı — kontrat henüz deploy edilmedi. İlk testnet koşusuna kadar.
  - `[low]` `[defer]` AD-13'ün `pending_lock`/hold-süresi ve randevu saati şemada yok — Story 3.4/3.5'in kapsamı, bu story'nin AC'leri istemiyor.
  - `[low]` `[defer]` `provider_applications`/`reviews`'in tam erişimci modülleri ve servisleri yok — Story 4.1/4.4'ün işi; AC1a yalnızca "stored" istiyor.
  - `[low]` `[defer]` Kategori tohum verisi yok — `scripts/README.md` bunu zaten kendi kapsamına yazmış.
  - `[low]` `[defer]` `migrations.ts` gerçek bir göç sistemi değil, yalnızca `CREATE TABLE IF NOT EXISTS` — projenin şu aşamasında (canlı veri yok) erken; iki katman bağımsız işaret etti.
  - `[low]` `[defer]` Olaylar ledger sırası dışında gelirse `escrow_state` geriye gidebilir — Soroban'ın `getEvents`'i ledger sıralı döndürüyor olmalı ama gerçek RPC'ye karşı doğrulanamadı; testnet koşusuna kadar işaretli.
  - `[low]` `[defer]` Boş string cursor koşulsuz saklanıyor — spekülatif, gerçek RPC davranışı bilinmeden doğrulanamaz.
  - `[low]` `[defer]` `decodeEvent`'in yeni testi yanlış konu adını kapsıyor ama iki-elemanlı olmayan bir topic dizisini (`raw.topic.length < 2`) kapsamıyor — kontratın kendi `events.rs`'i her zaman iki topic yayınlıyor, savunma amaçlı kalan bir boşluk.
  - `[low]` `[defer]` Geri alınan (reverted) bir kontrat çağrısının olayları mirror'lanabilir mi (`inSuccessfulContractCall`) — Soroban RPC semantiği gerçek ağ olmadan doğrulanamaz.
  - `[low]` `[defer]` Aynı süreç içinde event worker ve API eşzamanlı SQLite dosyasına yazarsa WAL/`busy_timeout` yapılandırılmamış — çalışan süreç henüz kurulmadığı için erken (bkz. reddedilen "composition root" maddesi).
  - `[low]` `[defer]` Simülasyonun `restorePreamble` (arşivlenmiş ledger girdisi) dönmesi işlenmiyor — gerçek ağ olmadan doğrulanamaz.
  - `[low]` `[defer]` `client.ts`, `ESCROW_CONTRACT_ID`'yi geçerli bir StrKey olarak doğrulamıyor — deploy script'i (1.7) zaten doğruluyor, savunma derinliği isteğe bağlı.
  - `[low]` `[defer]` `parseAmount`'ın üst i128 sınırını kontrol etmemesi — regex zaten negatif/tam sayı olmayanı reddediyor, yalnızca üst sınır eksik.
  - `[low]` `[defer]` `is_approved`/`category_id` üzerinde indeks yok — performans endişesi, erken.
  - `[low]` `[defer]` `createBookingHold`/`createProviderProfile`'ın girdi doğrulaması (var olmayan sağlayıcı, yinelenen cüzdan) yok — henüz hiçbir rota bunları kullanıcı girdisiyle çağırmıyor; o rota geldiğinde ele alınmalı.
  - `[low]` `[reject]` `getProcessedEvent`'in tipi `EscrowState | string`'e genişletilmiş ve kullanılmayan `scValToNative` yeniden ihracı — kozmetik, davranış etkisi yok.
  - `[false]` `[reject]` `escrowStateForEvent`'e çalışma zamanı varsayılan dalı gerekmesi çürüdü: fonksiyon kapalı bir union üzerinde `strict: true` altında typecheck ediliyor, TypeScript'in kapsayıcılık denetimi zaten koruyor; gerçek risk çözme aşamasında (zaten yamalanan `decodeEvent` testsizliği).
  - `[false]` `[reject]` Sayaçların (`verified_session_count`, `provider_cancellation_count`) hiç artırılmaması çürüdü: epic-2-context.md açıkça "Epic 4's verified-session counter... read from later" diyor — bu story'nin işi yalnızca ayırt edici bilgiyi (`processed_events.event_type`) korumak, ki koruyor.
  - `[false]` `[reject]` Çalışan sürece hiçbir şeyin bağlanmaması çürüdü: spec'in kendi Approach'u "Routes and authentication arrive with their own stories; this one builds the layer beneath them" diyor — kasıtlı kapsam, gözden kaçırma değil.

## Design Notes

- **Why 2.5 is being built before 2.1–2.4.** The epic context states that 2.1–2.4 are implemented against this story's conventions, and Story 2.4's automatic refund-withdraw fires off the event worker built here. Building the consumers first would mean inventing storage each one throws away. Epic 1's retrospective found the mirror-image mistake in Story 1.6, where a story arrived after the work it was meant to do had already been absorbed.
- **The two states are the reason this layer exists.** A booking's money state comes from the chain and nothing else; its balance state comes from the platform and nothing else. Epic 1 proved the chain half is trustworthy; the risk here is a well-meaning service that writes `escrow_state` directly because it "knows" what happened. One writer, enforced by the layering.
- **`forfeited` and `released` share a state but not a meaning.** Both end with the professional paid, so both store `escrow_state = released`. The event type is kept because Epic 4's verified-session counter must increase on one and not the other — that distinction is exactly what the Epic 1 course correction was for, and collapsing it here would undo it.
- **Nothing here can be proven against a live contract yet.** `ESCROW_CONTRACT_ID` is empty and the contract is not deployed. That is why the chain client's seam is a constraint rather than a preference: it is the only way this story is verifiable at all, and it is the same shape Story 1.7 settled on.

## Verification

**Commands:**
- `npm run -w backend typecheck` -- expected: clean, and covering `test/`
- `npm run -w backend test` -- expected: all pass, including the worker's replay/restart/unknown-id rows
- `npm test` (root) -- expected: contract tests, backend tests and scripts tests all pass

**Manual checks:**
- `git grep` for `process.env` outside `backend/src/config.ts`: no hits.
- `git grep` for writes to `escrow_state` outside `backend/src/chain/`: no hits.
- **Not run:** no Soroban RPC call, no live contract, no anchor request.

## Auto Run Result

Status: done

**Yapılan değişikliğin özeti.** Backend'e üç temel katman eklendi: Drizzle şeması (7 tablo, chain'in tutmadığı her şeyin aynası), tek zincir istemcisi (`create_booking`, `release`, `cancel_by_professional`, `cancel_by_client`, `claim_no_show` — her ağ aşaması enjekte edilebilir, override edilmezse gerçek RPC'ye dokunuyor), ve imleçli/tekrarsız olay işçisi (`escrow_state`'in tek yazıcısı). Servis katmanı (`booking.ts`, `profile.ts`) rota story'lerinin çağıracağı ince fonksiyonları sağlıyor.

**Değişen dosyalar.**
- `backend/src/db/` — şema, migrasyon, bookings/categories/providerProfiles/cursor/processedEvents erişimcileri.
- `backend/src/chain/` — istemci, hata çevirisi, olay şekli çözümü, olay işçisi.
- `backend/src/services/` — booking ve profile servis fonksiyonları.
- `backend/tsconfig.json`/`tsconfig.build.json` — typecheck artık `test/`'i kapsıyor, emit ayrı yapılandırmaya taşındı.
- `backend/test/` — 47 test: olay işçisi (7 I/O matris satırı), zincir istemcisi hata çevirisi ve başarı yolu, olay çözümü, servisler, DDL/şema uyumu.

**Kesinti ve devam.** İlk uygulama turu rate limit'e çarptı, kaynak kodun tamamı bitmiş ama testler yazılmadan. Kaynağı kendim doğruladım (tek yazıcı kuralı tutuyor, hiçbir yerde gerçek ağ çağrısı yok, enjekte edilebilir seam'ler doğru), sonra yalnızca test yazma görevini yeni bir ajana verdim — bitmiş işi tekrarlamadan.

**Review bulguları.** 4 katman 56+ ham bulgu bildirdi; kök nedene göre 32 ayrı girişe indirildi: high 5, medium 4, low 20, false 3. **11 giriş yamandı**. Beş `high` bulgunun hepsi mutasyonla kanıtlandı — patch turundan sonra kendim tekrar çalıştırıp beşinin de yakalandığını doğruladım:
- Olay işçisinin dedupe kaydı ile `escrow_state` yazımı atomik değildi; arada kesinti olursa kayıt kalıcı olarak kayboluyordu. Artık tek transaction.
- `decodeEvent` (RPC olay çözümü) hiç test edilmiyordu; topic sırasını değiştirmek suite'i yeşil bırakıyordu.
- Zincir istemcisinin başarı yolu (imzala→gönder→bekle→hash dön) hiç çalışmamıştı.
- `lockDeposit`'in profesyonel/müşteri argümanları yer değiştirse hiçbir test düşmüyordu — depozito yanlış tarafa kilitlenebilirdi.
- `listApprovedProviderProfiles`'in onay filtresi kaldırılsa hiçbir test düşmüyordu — onaylanmamış sağlayıcılar pazara sızabilirdi.

**5 madde ertelendi**, en önemlisi: bilinmeyen booking id için anomali kaydedildikten sonra booking sonradan oluşturulursa, aynı olayın tekrar teslimi kalıcı olarak `escrow_state`'i atlıyor — dört katman da bağımsız işaret etti, ürün kararı gerektiriyor.

**Reddedilen bulgular ve gerekçeleri.**
- `escrowStateForEvent`'e çalışma zamanı varsayılan dalı — TypeScript'in kapalı union üzerindeki kapsayıcılık denetimi zaten koruyor.
- Sayaçların artırılmaması — epic bağlamı bunu açıkça Epic 4'e atamış, bu story'nin işi yalnızca ayırt edici bilgiyi korumak.
- Çalışan sürece bağlanmama — spec'in kendi Approach'u rotaların ayrı story'lerle geleceğini açıkça söylüyor.

**Takip review önerisi:** `true`. Beş `high` giriş yamandı (eşiğin çok üzerinde). Adlandırılmış doğrulanmamış risk: `ESCROW_CONTRACT_ID` hâlâ boş, hiçbir zincir çağrısı gerçek ağa karşı hiç çalışmadı — ilk testnet koşusu istemcinin başarı yolunu, olay işçisinin gerçek RPC şeklini ve `pollTransaction`'ın zamanlamasını ilk kez sınayacak.

**Yapılan doğrulama.**
- `npm run -w backend typecheck` → temiz, `test/` dahil.
- `npm run -w backend test` → 47/47.
- `npm run -w backend build` → temiz.
- `npm test` (kök) → 62 Rust + 47 backend + 69 scripts, hepsi geçti.
- Beş `high` mutasyonun beşi de yama sonrası kendim tekrar çalıştırıldı ve yakalandı.
- `git status`: `contracts/`, `scripts/`, `frontend/`, `.env` dokunulmadı.

**Kalan riskler.** Hiçbir zincir çağrısı gerçek ağa karşı hiç çalışmadı — kontrat deploy edilmedi, `ESCROW_CONTRACT_ID` boş. İkincisi: bilinmeyen booking id anomalisi kalıcı olarak kurtarılamaz kalabilir; bu ürün kararı bekliyor.
