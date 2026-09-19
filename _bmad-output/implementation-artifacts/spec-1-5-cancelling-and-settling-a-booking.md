---
title: 'Story 1.5 — Cancelling and settling a booking'
type: 'feature'
created: '2026-09-18'
status: 'done'
review_loop_iteration: 0
baseline_revision: '3ab70001db3a33046f1cab99ad0552776d91438d'
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
warnings: ['oversized']
deferred:
  - summary: >-
      Profesyonel seansa gelmezse müşterinin parasına ulaşacak hiçbir yolu yok:
      deadline geçtikten sonra müşterinin imzaladığı her çağrı profesyonele ödüyor.
    evidence: |-
      `cancel_by_client` deadline sonrası `forfeited` üretiyor, `release` zaten
      profesyonele ödüyor, `claim_no_show` ise profesyonelin kendi elinde. Kontrat
      "kim gelmedi" sorusunu ayırt edemiyor; bunun için karşılıklı onay ya da bir
      itiraz mekanizması gerekir. Spec'in Never listesi admin override ve itiraz
      yolunu açıkça kapsam dışı bıraktığı için bu story'de çözülemez — ama model
      simetrik değil ve ürün kararı olarak açık duruyor.
    location: >-
      contracts/escrow/src/lib.rs:271-336
    severity: medium
  - summary: >-
      Trustline önkoşulu artık müşteriyi de kapsıyor; dört settlement yolunun
      ikisi müşteriye ödüyor.
    evidence: |-
      `cancel_by_professional` — profesyonelin bookingi kapatmasının tek yolu —
      müşteri token'ı alamıyorsa trap eder ve çağrılamaz hale gelir.
      `deferred-work.md`'deki madde bu story'ye taşındı ve iki tarafı kapsayacak
      şekilde genişletildi; kapı booking oluşturulurken.
    location: >-
      contracts/escrow/src/lib.rs:363-386
    severity: medium
  - summary: >-
      `claim_no_show` deadline+1'de olgunlaşıyor; bu genellikle seanstan önce.
    evidence: |-
      `cancel_deadline` ücretsiz iptal penceresinin sonu (UX: "full refund up to
      24h before"), seans saati değil. Profesyonel seanstan ~24 saat önce
      depozitoyu talep edip bookingi kapatabilir. Para zaten pencere kapandığında
      hak edilmiş sayıldığı ve `forfeited` sayacı şişirmediği için zarar sınırlı;
      yine de `Booking`'e `session_start` eklemek bunu tamamen kapatırdı — 1.2/1.3
      değişikliği gerektirir.
    location: >-
      contracts/escrow/src/lib.rs:314-336
    severity: low
  - summary: >-
      `SETTLEMENT_MARGIN_SECONDS` penceresi (deadline sonrası 30 gün) içinde kimse
      settle etmezse kayıt arşivleniyor ve depozitoya ulaşılamıyor.
    evidence: |-
      Testler son meşru saniyeyi (`NOW + 86_400 + SETTLEMENT_MARGIN_SECONDS`)
      sınıyor ama ötesini ne sınıyor ne belgeliyor. Kurtarma için `RestoreFootprint`
      gerekir; repoda bunu yapan hiçbir şey yok. 1.3'ten devreden tasarım; okuma
      yolunda TTL bump etmek `storage.rs`'in "okumalar bump etmez" kuralını deler.
    location: >-
      contracts/escrow/src/lib.rs:27-33
    severity: low
  - summary: >-
      Deadline sonrası `release` ile `claim_no_show` aynı booking üzerinde ikisi de
      meşru; hangisi önce gelirse `released` mi `forfeited` mi olacağını o belirliyor.
    evidence: |-
      Doğrulanmış-seans sayacı (FR20) buna bağlı. Ters teşvik yok — profesyonel
      `forfeited` ile aynı parayı sayaç artışı olmadan alır, müşteri ise olmamış bir
      seansı onaylayarak yalnızca profesyonele yarar sağlar — ama sonuç yine de
      çağrı sırasına bağlı.
    location: >-
      contracts/escrow/src/lib.rs:182-336
    severity: low
  - summary: >-
      Üretilen `test_snapshots/*.json` dosyaları bu story'de ~30 dosya ve ~600 kB
      ekledi; sürüm kontrolünde tutulup tutulmayacakları hâlâ karara bağlanmadı.
    evidence: |-
      soroban-sdk bunları yalnızca yazar, hiçbir şey okuyup karşılaştırmaz, yani
      doğrulama değiller. Story 1.4'te de ertelenmişti. En azından `.gitattributes`
      `linguist-generated=true` ile diff'lerden çıkarılabilir.
    location: >-
      contracts/escrow/test_snapshots/
    severity: low
---

<intent-contract>

## Intent

**Problem:** A booking that does not happen has no resolution. `release` is the only way money leaves the escrow and it needs the client's signature, so a client who never shows up simply never signs and the professional's deposit is stranded. A client who cancels in good time has no way back to their own money, and a professional who has to cancel has no way to give it back.

**Approach:** Add the three cancellation paths, each signed by the party it serves. `cancel_by_professional` always returns the deposit to the client. `cancel_by_client` returns it if the free-cancellation window is still open and forfeits it to the professional if it has closed. `cancel_by_professional`'s counterpart for a silent client is `claim_no_show`, which the professional may call only once that window has closed. Each path emits its own event, so the reason a deposit moved is on the wire and not inferred.

## Boundaries & Constraints

**Always:**
- Every path is authorized by the party it serves (AD-2): `cancel_by_client` demands the **client's** `require_auth`, `cancel_by_professional` and `claim_no_show` demand the **professional's** — always the address stored on the booking, never the caller. No path is permissionless, and the backend's key can call none of them.
- `cancel_by_professional` refunds the full amount to the client **whatever the ledger timestamp**, sets `Refunded`, emits `cancelled`. A professional is never paid for a session they cancelled.
- `cancel_by_client` compares `env.ledger().timestamp()` with the stored `cancel_deadline`: `now <= cancel_deadline` refunds the client, sets `Refunded`, emits `refunded`; `now > cancel_deadline` pays the professional, sets `Released`, emits `forfeited`. The boundary second belongs to the client.
- `claim_no_show` is rejected while `now <= cancel_deadline`; after it, it pays the professional, sets `Released`, emits `forfeited`.
- `released` is emitted by `release` alone. No path added here may emit it, or a no-show would count as a held session (FR20, Story 4.3).
- Only a booking in `Locked` state settles; `Released` and `Refunded` are terminal, and every path rejects them with `Error::InvalidState`.
- Transfers move the full stored `amount` from `env.current_contract_address()` through the booking's own `token`. The record is updated through the existing `storage` helper, same key, and the write bumps the TTL.
- An event is emitted only after its transfer succeeds. All events keep the established wire shape: topics `(name, booking_id)`, data `amount`.
- New error variants are appended with new numbers; existing numbers are never renumbered.

**Never:**
- Do not change `initialize`, `get_admin`, `create_booking`, `release`, the `Booking` fields, `BookingState`'s variants, or any existing error number or event shape.
- Do not add on-chain state for the settlement reason. The event carries the reason, the state carries the destination.
- No partial refunds, no fees, no platform cut, no penalty on the professional: whoever the path picks receives the whole stored amount.
- Do not treat a passed `cancel_deadline` as proof the session is over — it is the end of the free-cancellation window, nothing more.
- Do not add an admin override, a grace period, or a per-booking policy field. Nothing outside `contracts/escrow/` changes. Do not deploy or call the network.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Professional cancels early | `Locked`, `now` < deadline, professional signs | Client's balance whole again; `Refunded`; `cancelled` event; TTL bumped | No error expected |
| Professional cancels late | `Locked`, `now` > deadline, professional signs | Refund to the client exactly as above — the clock never applies to this path | No error expected |
| Client cancels in time | `Locked`, `now` < deadline, client signs | Client's balance whole again; `Refunded`; `refunded` event; TTL bumped | No error expected |
| Client cancels on the boundary | `Locked`, `now` == deadline, client signs | Refund, as above — the boundary second belongs to the client | No error expected |
| Client cancels late | `Locked`, `now` > deadline, client signs | Professional paid in full; `Released`; `forfeited` event; TTL bumped | No error expected |
| No-show claimed | `Locked`, `now` > deadline, professional signs | Professional paid in full; `Released`; `forfeited` event; TTL bumped | No error expected |
| No-show claimed too early | `Locked`, `now` <= deadline, professional signs | Nothing transferred, nothing written, no event | `Error::TooEarly` |
| Wrong party signs | `Locked`, the other party (or a stranger) signs instead | Call fails; nothing transferred, record still `Locked` | `require_auth` fails with a host auth error |
| Nobody signs | `Locked`, no signature supplied | Call fails on every one of the three paths | `require_auth` fails with a host auth error |
| Unknown booking id | No record under that id | Nothing transferred, nothing written, no event | `Error::BookingNotFound` |
| Already released | Booking in `Released` state | Nothing transferred, nothing written, no event | `Error::InvalidState` |
| Already refunded | Booking in `Refunded` state | Nothing transferred, nothing written, no event | `Error::InvalidState` |
| Settled twice | A successful settlement, then any settlement path again | The second call changes nothing and emits no event; the deposit moves exactly once | `Error::InvalidState` |

</intent-contract>

## Code Map

- `contracts/escrow/src/lib.rs` -- `#[contractimpl]` block with `initialize`, `get_admin`, `create_booking`, `release`. `release` (line ~178) is the model for all three new functions: load → auth → state guard → transfer → store → emit. `TokenClient`, `Address`, `Env` already imported; `env.ledger().timestamp()` is already used by `create_booking`. **Stale comments to fix while here:** the crate doc (line ~9), `SETTLEMENT_MARGIN_SECONDS` (line ~27), `create_booking`'s doc (line ~76) and its past-deadline comment (line ~112), and `release`'s house-pattern comment (line ~193) all still name `resolve_cancel`, which no longer exists. `SETTLEMENT_MARGIN_SECONDS` itself stays exactly as it is — it already reserves the window `claim_no_show` acts in.
- `contracts/escrow/src/events.rs` -- currently `Locked` and `Released`, both `#[contractevent(topics = [".."], data_format = "single-value")]` with `#[topic] booking_id` and `amount`. Add `Refunded`, `Cancelled` and `Forfeited` as siblings, same shape. All four new names fit `symbol_short!`'s 9-character limit (`cancelled` and `forfeited` are exactly 9), so the tests can build their expected topics the same way. `env.events().publish(..)` is deprecated and `Cargo.toml` denies warnings, so the macro is the only form that builds.
- `contracts/escrow/src/error.rs` -- codes 1–8, explicit and stable. `BookingNotFound = 4` and `InvalidState = 6` are reused. Append `TooEarly = 9` for a no-show claimed before the window closed; do not renumber anything.
- `contracts/escrow/src/types.rs` -- `Booking` and `BookingState { Locked, Released, Refunded }`. Read-only: every variant this story needs already exists. Update `state` only; every other field stays as stored.
- `contracts/escrow/src/storage.rs` -- `get_booking` (returns `Error::BookingNotFound`), `set_booking` (write + TTL bump), `has_booking`. Reads never bump; only writes do. Use these; do not touch `env.storage()` directly.
- `contracts/escrow/src/test.rs` -- 43 tests. Reuse the existing scaffolding: `Fixture` (fixed booking id `[0x1d; 16]`, `NOW`, `cancel_deadline = NOW + 86_400`, `FUNDING`), `CallResult`, `locked_fixture()`, `Snapshot`/`snapshot()`, `expected_event(Symbol)`, and `assert_release_changed_nothing` — **rename that helper to `assert_nothing_changed` and neutralize its two messages**, since four paths now share it. `f.env.ledger().set_timestamp(..)` moves the clock; `MockAuth`/`mock_auths` pins which address signs — `only_the_clients_own_authorization_releases_the_deposit` shows both idioms.
- `_bmad-output/implementation-artifacts/spec-1-5-attempted-implementation.patch` -- the reverted attempt at the superseded model. Reference only, and never apply it wholesale: `expected_refunded_event`, `assert_only_the_state_moved` and the rejection/double-settlement/TTL/isolation test shapes carry over; the permissionless test and all clock-only branching do not.
- `contracts/escrow/Cargo.toml` -- `[lints.rust] warnings = "deny"`. Read-only.

## Tasks & Acceptance

**Execution:**
- `contracts/escrow/src/error.rs` -- append `TooEarly = 9` -- a no-show claimed before the window closes is a timing refusal, not an illegal state, and Story 3.6 shows the user which one it hit.
- `contracts/escrow/src/events.rs` -- add `Refunded`, `Cancelled` and `Forfeited` beside `Locked` and `Released` -- the reason a deposit moved must be on the wire, because Story 4.3's counter and the provider's cancellation count are both derived from the event name alone.
- `contracts/escrow/src/lib.rs` -- add `cancel_by_professional`, `cancel_by_client` and `claim_no_show`, each `(env, booking_id) -> Result<(), Error>`, and refresh the five stale `resolve_cancel` comments -- these three are every way a booking ends without the client confirming it.
- `contracts/escrow/src/test.rs` -- rename `assert_release_changed_nothing` to `assert_nothing_changed`, then add a test per matrix row, including one per path proving the *other* party's signature does not authorize it -- the matrix is this story's contract, and the auth split is the half a clock-only model got wrong.

**Acceptance Criteria:**
- Given a booking a professional cancels, when balances are read, then the client holds exactly what they started with — and this holds with the ledger clock set both before and after `cancel_deadline`.
- Given a booking settled by any path, when the escrow's balance is read, then it holds nothing for that booking and the full amount sits with exactly one party.
- Given any settlement path, when the party who does not own it signs instead, then the call fails with a host auth error and nothing moved.
- Given any rejected call, when it returns, then no tokens moved, the stored state is unchanged and no event was emitted.
- Given the whole test suite, when the events are inspected, then `released` is emitted only by `release`.
- Given the crate, when `npm run contracts:test` and the `wasm32v1-none` release build run, then every test passes and the build produces a `.wasm` with no warnings.

## Spec Change Log

## Review Triage Log

### 2026-09-18 — Review pass
- verdicts: 28 findings — high 0, medium 5, low 21, false 2, maybe-false 0
- findings:
  - `[low]` `[patch]` `epic-1-context.md` "dört para olayı" diyordu; beş var (`locked` dahil) — satır düzeltildi, hangi dördünün settle ettiği ayrıca yazıldı.
  - `[low]` `[patch]` Aynı dosyanın `Errors:` satırı üç varyantı (7, 8, 9) atlıyordu — dokuzunun tamamı numaralarıyla yazıldı.
  - `[low]` `[patch]` `sprint-status.yaml` hâlâ `backlog` diyordu; 1.4'te kapatılan aynı tutarsızlık tekrarladı — `review` yapıldı.
  - `[low]` `[reject]` `release`'in `settle`'a taşınmaması ev deseninin iki uygulaması olması demek — ama spec'in Never listesi `release`'e dokunmayı açıkça yasaklıyor ve davranışı kendi testleriyle sabitlenmiş; yanıltıcı olan yorumdu, o da yamandı.
  - `[low]` `[patch]` `release`'in yorumu `[settle]` köşeli-parantez bağlantısı kullanıyordu: düz `//` yorumunda çözülmez, üstelik `release` `settle`'ı çağırmıyor — okuyucu olmayan bir çağrı arar. Düz backtick'le yeniden yazıldı.
  - `[medium]` `[patch]` Üç yeni yolun auth-önce-durum sırasını hiçbir test tutmuyordu — doğrulama katmanı kanıtladı: durum kontrolünü `require_auth`'un üstüne taşıyan mutasyon yalnızca `release`'in kendi testini düşürdü, `claim_no_show`'un auth'unu hem durum hem saat kontrolünün altına almak ise hiçbir testi düşürmedi. İki test eklendi, ikisi de aynı mutasyonlara karşı doğrulandı.
  - `[low]` `[patch]` `no_settlement_path_moves_money_without_a_signature` adı dört yolu vaat ederken üçünü dönüyordu — `EVERY_SETTLEMENT_PATH`'e genişletildi.
  - `[low]` `[patch]` `every_settlement_path_bumps_the_bookings_ttl` aynı uyumsuzluk — o da genişletildi; ikisi de `release`'i kapsadığı için 1.4'ün iki tek-yol testi gereksizleşti ve silindi (kapsam `EVERY_SETTLEMENT_PATH`'te doğrulandı).
  - `[medium]` `[defer]` Trustline riski artık müşteriyi de kapsıyor; devralınan erteleme maddesi boş listeye düşmüştü ve ölü bir spec'e dosyalanmıştı — `deferred-work.md`'de genişletilip yeniden dosyalandı, buraya da alındı.
  - `[medium]` `[defer]` Profesyonel gelmezse müşterinin çaresi yok — spec'in Never listesi itiraz yolunu ve admin override'ı kapsam dışı bıraktığı için bu story'de çözülemez; ürün kararı olarak `deferred`'a yazıldı.
  - `[low]` `[defer]` Marj penceresi dışında kayıt arşivleniyor — 1.3'ten devreden tasarım, bu değişikliğin ürünü değil.
  - `[low]` `[patch]` İki 1.5 spec'i yan yana, hiçbiri diğerine işaret etmiyordu — eskisinin başına SUPERSEDED uyarısı ve yenisine bağlantı kondu.
  - `[low]` `[defer]` ~30 yeni snapshot, ~600 kB — sürüm kontrolündeki yerleri hâlâ karara bağlanmadı; 1.4'ten devreden.
  - `[low]` `[patch]` `a_no_show_claimed_before_the_deadline_is_rejected_as_too_early` bir saniye sonrasındaki başarıyı yalnızca dönüş değeriyle doğruluyordu — olay, bakiye ve durum iddiaları eklendi.
  - `[low]` `[defer]` `claim_no_show` deadline+1'de olgunlaşıyor, yani genellikle seanstan önce — `session_start` alanı kapatırdı ama 1.2/1.3 değişikliği gerektirir; zarar sınırlı (para zaten hak edilmiş, `forfeited` sayacı şişirmiyor).
  - `[medium]` `[defer]` Profesyonelin gelmemesi (yukarıdaki satırla aynı kök neden, aynı rota).
  - `[low]` `[defer]` Arşivlenme (aynı kök neden, aynı rota).
  - `[low]` `[defer]` Deadline sonrası `release` ile `claim_no_show` yarışı sayacın hangisini göstereceğini belirliyor — ters teşvik yok, ama sonuç çağrı sırasına bağlı.
  - `[false]` `[reject]` "Her yol kendi olayını yayınlıyor" iddiasının abartılı olduğu çürüdü: geç `cancel_by_client` ile `claim_no_show`'un `forfeited`'ı paylaşması Design Notes'ta açık karar — tek sonuç için tek olay, böylece Epic 2 aynı olgunun iki adını uzlaştırmıyor.
  - `[medium]` `[patch]` Auth sırası açığı, doğrulama katmanından (yukarıdakiyle aynı kök neden, aynı rota; mutasyonla kanıtlandı).
  - `[low]` `[patch]` `released_is_emitted_by_release_alone` içindeki `assert_ne!` satırları bağımsız olarak düşemiyordu — kaldırıldı, iddiayı taşıyanın her sonucun kendi olayına karşı `assert_eq!` olduğu yorumda kayda geçti.
  - `[low]` `[reject]` `release`'in satır içi transferi koruması (yukarıdaki reddin aynısı, aynı gerekçe).
  - `[false]` `[reject]` "`_bmad-output/` değişimi 'contracts/escrow dışında hiçbir şey değişmez' sınırını deliyor" çürüdü: sınır ürün kodunu yönetiyor, iş akışının kendi defterini değil; 1.1–1.4 de kendi spec'lerini oraya yazdı.
  - `[low]` `[patch]` İki canlı 1.5 spec'i (aynı kök neden, aynı rota).
  - `[low]` `[reject]` Reddedilen çağrılarda "olay yok" iddiasının host geri alması yüzünden boşta olması — kodun kendi yorumu bunu söylüyor ve gerçek kanıt olarak snapshot karşılaştırmasını gösteriyor; 1.4'te de aynı sonuca varıldı.
  - `[low]` `[reject]` `InvokeError::Abort`'un her trap'te aynı olması — her yanlış-imza testi aynı çağrıyı doğru imzayla tekrarlayıp tam başarıyı doğruladığı için imza tek değişen girdi olarak yalıtılıyor.
  - `[low]` `[reject]` Settle edilmiş bir bookingde erken no-show talebinin `TooEarly` yerine `InvalidState` dönmesi — intent sırayı belirlemiyor, kod kararı yorumluyor ve test sabitliyor; adlandırılabilir bir zarar yok.
  - `[low]` `[patch]` `release`'in yorumunun `settle`'a atıf yapması (aynı kök neden, aynı rota).

## Design Notes

- **Why three functions and not one.** Soroban exposes no caller identity at the top level, so a single entry point cannot tell who invoked it — it can only demand a signature from an address it already knows. Splitting by signer is therefore the only way the contract can distinguish "the professional cancelled" from "the client cancelled", which is the distinction FR7 now turns on.
- **The clock is a condition inside a signed path, never the decider.** `cancel_by_professional` ignores it entirely. `cancel_by_client` and `claim_no_show` consult it only to decide where the money goes and whether the claim is ripe. This is what keeps a passed deadline from being read as proof that a session happened — it is only the end of the free-cancellation window (UX: "full refund up to 24h before").
- **`claim_no_show` and a late `cancel_by_client` produce the same outcome on purpose.** Both pay the professional and emit `forfeited`; they differ only in who initiates. Either the client admits the late cancellation or the professional claims the silence, and the deposit is forfeit the same way. One event for one outcome keeps Epic 2's worker from having to reconcile two names for the same fact.
- **Auth before the state check, on every path.** `release` already orders it this way: the record is loaded first (there is no address to demand a signature from until it is read), then the signature, then legality. An unknown id stays answerable without a signature — booking ids are off-chain ULIDs and carry no secret — but whether a booking is still settleable is told only to a party to it.
- **No new state for a forfeit.** A forfeited deposit ends in `Released` because that is where the money went, and `Released`/`Refunded` already partition the destinations. Adding a fourth variant would change Story 1.2's committed data model to record something the event already says.

## Verification

**Commands:**
- `npm run contracts:test` -- expected: every test passes, including all matrix rows
- `npm run contracts:build` -- expected: a `wasm32v1-none` release artifact, no warnings (the deny-warnings lint turns any deprecated call into a build failure)

## Auto Run Result

Status: done

**Yapılan değişikliğin özeti.** Escrow kontratına bir bookingin müşterinin onayı olmadan bitebileceği üç yol eklendi, her biri hizmet ettiği tarafın imzasıyla: `cancel_by_professional` (profesyonelin imzası, saat ne olursa olsun müşteriye tam iade, `cancelled`), `cancel_by_client` (müşterinin imzası; pencere açıksa iade ve `refunded`, kapandıysa profesyonele ve `forfeited`) ve `claim_no_show` (profesyonelin imzası, yalnızca pencere kapandıktan sonra, `forfeited`). Hiçbiri izinsiz değil ve hiçbiri `released` yayınlamıyor — o yalnızca `release`'in, böylece no-show doğrulanmış seans sayılmıyor.

**Değişen dosyalar.**
- `contracts/escrow/src/lib.rs` — üç giriş noktası, özel `settle`/`Payee` yardımcısı, beş bayat `resolve_cancel` yorumunun tazelenmesi.
- `contracts/escrow/src/events.rs` — `Refunded`, `Cancelled`, `Forfeited` olayları; `Released`'ın yalnızca `release`'e ait olduğunun belgelenmesi.
- `contracts/escrow/src/error.rs` — `TooEarly = 9` eklendi, hiçbir numara değişmedi.
- `contracts/escrow/src/test.rs` — 21 yeni test, `assert_release_changed_nothing` → `assert_nothing_changed` yeniden adlandırması, iki yol tablosu.
- `contracts/escrow/test_snapshots/` — test başına üretilen ledger snapshot'ları.
- `_bmad-output/implementation-artifacts/` — epic bağlamı, sprint durumu, erteleme defteri, eski spec'e SUPERSEDED uyarısı.

**Review bulguları.** 4 katman 28 bulgu bildirdi: high 0, medium 5, low 21, false 2. **8 giriş yamandı** (1 medium, 7 low). Öne çıkanı doğrulama katmanından geldi ve mutasyonla kanıtlandı: üç yeni yolun auth-önce-durum sırasını hiçbir test tutmuyordu — durum kontrolünü `require_auth`'un üstüne taşımak yalnızca `release`'in kendi testini düşürüyordu, `claim_no_show`'da ise hiçbir testi düşürmüyordu. Yani üç yol da imzasız bir çağırana bookingin settle edilmiş olup olmadığını sızdıracak şekilde sessizce gerileyebilirdi. İki test eklendi ve aynı mutasyonlara karşı doğrulandı. **6 madde ertelendi**, ikisi medium: profesyonelin gelmemesi durumunda müşterinin çaresizliği, ve trustline önkoşulunun artık müşteriyi de kapsaması.

**Reddedilen bulgular ve gerekçeleri.**
- `release`'in `settle`'a taşınmaması (iki kez bildirildi) — spec'in Never listesi `release`'e dokunmayı yasaklıyor ve davranışı kendi testleriyle sabitlenmiş; yanıltıcı olan yorumdu, o yamandı.
- "Her yol kendi olayını yayınlıyor" iddiasının abartılı olması — geç iptal ile no-show talebinin `forfeited`'ı paylaşması Design Notes'ta açık karar: tek sonuç için tek olay.
- `_bmad-output/` değişiminin sınırı delmesi — sınır ürün kodunu yönetiyor, iş akışının kendi defterini değil.
- Reddedilen çağrılarda "olay yok" iddiasının boşta olması — kod bunu zaten yorumluyor, gerçek kanıt snapshot karşılaştırması.
- `InvokeError::Abort`'un kaba olması — her yanlış-imza testi aynı çağrıyı doğru imzayla tekrarlayarak imzayı tek değişen girdi olarak yalıtıyor.
- Settle edilmiş bookingde erken talebin `InvalidState` dönmesi — intent sırayı belirlemiyor, kod kararı yorumluyor ve test sabitliyor.

**Takip review önerisi:** `false`. Yamanan girişlerin hiçbiri `high` değildi ve yalnızca bir `medium` yamandı (patched: medium 1, low 7).

**Yapılan doğrulama.**
- `npm run contracts:test` → 62 passed, 0 failed.
- `npm run contracts:build` → `wasm32v1-none` release derlemesi, sıfır uyarı satırı (`warnings = "deny"` altında).
- Matris denetimi: 13 satırın hepsi çalışan ve geçen bir testle karşılanıyor.
- Yama turunda silinen iki Story 1.4 testinin kapsamı `EVERY_SETTLEMENT_PATH` döngülerinde doğrulandı (`release` tabloda var).
- Uygulama ajanı mutasyon testi sırasında `lib.rs`'i bir ara yanlış yedekten geri yüklediğini bildirdi; dosya elle denetlendi — yedi genel fonksiyon, `settle`/`Payee`, altı `require_auth`, sıfır `resolve_cancel`.

**Kalan riskler.** En büyüğü ertelenenlerin ilki: profesyonel seansa gelmezse müşterinin parasına ulaşacak bir yolu yok, çünkü kontrat "kim gelmedi" sorusunu ayırt edemiyor. Model bu yönüyle simetrik değil ve bunu kapatmak karşılıklı onay ya da itiraz mekanizması gerektirir — ikisi de bu story'nin kapsamı dışında. İkincisi, `claim_no_show` genellikle seanstan önce olgunlaşıyor; `Booking`'e `session_start` eklemek kapatırdı ama 1.2/1.3'e dönmeyi gerektirir.
