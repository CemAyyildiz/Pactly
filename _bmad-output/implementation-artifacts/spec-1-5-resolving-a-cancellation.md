---
title: 'Story 1.5 — Resolving a cancellation (resolve_cancel)'
type: 'feature'
created: '2026-09-18'
status: 'blocked'
review_loop_iteration: 0
baseline_revision: 'bd06fc086c110731deced0d62114dcc2a08af52b'
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** A booking that does not happen has no resolution. `release` is the only way money leaves the escrow and it needs the client's signature, so a client who never shows up simply never signs: the professional's deposit is stranded forever. A client who cancels in good time has no way back to their own money either.

**Approach:** Add `resolve_cancel(booking_id)`: anyone may call it, and the ledger clock decides the outcome. On or before `cancel_deadline` the deposit goes back to the client and the booking becomes `Refunded`; after it the deposit goes to the professional and the booking becomes `Released`. The matching event announces which way it went.

## Boundaries & Constraints

**Always:**
- `resolve_cancel` takes **no authorization at all** — no `require_auth`, from anybody (AD-2). The deadline comparison is the only thing that decides the outcome, which is precisely what keeps a no-show from stranding the professional.
- The clock is `env.ledger().timestamp()`, compared against the booking's stored `cancel_deadline`. Both are UTC epoch seconds; no conversion, no tolerance window.
- `now <= cancel_deadline` refunds the full stored `amount` to the booking's `client`, sets `Refunded`, emits `refunded`.
- `now > cancel_deadline` transfers the full stored `amount` to the booking's `professional`, sets `Released`, emits the existing `released` event.
- Only a booking in `Locked` state resolves; `Released` and `Refunded` are terminal.
- The transfer is from `env.current_contract_address()` through the booking's own `token`. The record is updated through the existing `storage` helper, same key, and the write bumps the TTL.
- The event is emitted only after the transfer succeeds, with the established wire shape: topics `(name, booking_id)`, data `amount`.
- Reuse the existing types, errors, storage and event modules; new error variants would be appended with new numbers, never renumbered.

**Never:**
- Do not add authorization to `resolve_cancel`, and do not weaken `release`'s client `require_auth` to match it.
- Do not change `initialize`, `get_admin`, `create_booking`, `release`, the `Booking` fields, or any existing error number or event shape.
- No partial refunds, no fees, no platform cut, no penalty split between the parties: whoever the deadline picks receives the whole stored amount.
- Do not introduce a third outcome, a grace period, or a per-booking cancellation policy. `cancel_deadline` is already the policy.
- Nothing outside `contracts/escrow/` changes. Do not deploy or call the network.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| On-time cancellation | Booking `Locked`, `now` < `cancel_deadline` | Client's balance is whole again; record becomes `Refunded`; `refunded` event carries the id and amount; TTL bumped | No error expected |
| Cancelled exactly on the deadline | Booking `Locked`, `now` == `cancel_deadline` | Refund, exactly as above — the boundary second belongs to the client | No error expected |
| No-show | Booking `Locked`, `now` > `cancel_deadline` | Professional is paid the full amount; record becomes `Released`; `released` event; TTL bumped | No error expected |
| Called by a stranger | Booking `Locked`, no signature from anybody | Resolves normally by the deadline; the caller's identity changes nothing | No error expected |
| Unknown booking id | No record under that id | Nothing transferred, nothing written, no event | `Error::BookingNotFound` |
| Already released | Booking in `Released` state | Nothing transferred, nothing written, no event | `Error::InvalidState` |
| Already refunded | Booking in `Refunded` state | Nothing transferred, nothing written, no event | `Error::InvalidState` |
| Resolved twice in a row | Successful resolve, then the same call again | The second call changes nothing and emits no event; the money moves exactly once, on either side of the deadline | `Error::InvalidState` |

</intent-contract>

## Code Map

- `contracts/escrow/src/lib.rs` -- `#[contractimpl]` block with `initialize`, `get_admin`, `create_booking`, `release` (`release` at line 177 is the closest model: load → guard → transfer → store → emit). `resolve_cancel` joins it as the last function. `TokenClient`, `Address`, `Env` already imported; `env.ledger().timestamp()` is already used by `create_booking` (line ~116) for deadline validation, so the clock needs no new import. `SETTLEMENT_MARGIN_SECONDS` (line 31) exists *for this story*: `create_booking` already refuses a deadline that would leave the record archived before it can be resolved, so `resolve_cancel` may assume a live entry and needs no TTL reasoning of its own.
- `contracts/escrow/src/events.rs` -- `Locked` and `Released`, both `#[contractevent(topics = [".."], data_format = "single-value")]` with a `#[topic] booking_id` and an `amount`. Add `Refunded` as their third sibling, same shape. `env.events().publish(..)` is deprecated and `Cargo.toml` denies warnings, so the macro is the only form that builds.
- `contracts/escrow/src/types.rs` -- `Booking` (professional, client, token, amount, cancel_deadline, state) and `BookingState { Locked = 0, Released = 1, Refunded = 2 }`. Both terminal variants already exist. Update `state` only; every other field stays as stored.
- `contracts/escrow/src/error.rs` -- codes 1–8. `BookingNotFound = 4` and `InvalidState = 6` cover this story; no new variant is expected.
- `contracts/escrow/src/storage.rs` -- `get_booking` (returns `Error::BookingNotFound`), `set_booking` (write + TTL bump), `has_booking`. Reads never bump; only writes do. Use these; do not touch `env.storage()` directly.
- `contracts/escrow/src/test.rs` -- 43 tests. Reuse the Story 1.4 scaffolding rather than inventing new: `Fixture` (fixed booking id `[0x1d; 16]`, `NOW`, `cancel_deadline = NOW + 86_400`, `FUNDING`), `CallResult`, `locked_fixture()`, `Snapshot`/`snapshot()`, `assert_release_changed_nothing`, `expected_event(Symbol)` with its `expected_released_event()` wrapper. `f.env.ledger().set_timestamp(..)` moves the clock — `a_deposit_is_still_releasable_after_the_cancel_deadline` shows the idiom. A rejected call's balances and stored record are the real evidence; an empty event list is weak on its own, since the host discards a failed invocation's events anyway.
- `contracts/escrow/Cargo.toml` -- `[lints.rust] warnings = "deny"`. Read-only: a deprecated call fails the build rather than warning.

## Tasks & Acceptance

**Execution:**
- `contracts/escrow/src/events.rs` -- add the `Refunded` event beside `Locked` and `Released`, same topic/data shape -- Epic 2's worker learns a refund the same way it learns the other two, so it must be a sibling rather than a one-off publish.
- `contracts/escrow/src/lib.rs` -- add `resolve_cancel(env, booking_id) -> Result<(), Error>`: load the booking, reject a non-`Locked` state, compare `env.ledger().timestamp()` with `booking.cancel_deadline`, pay the client or the professional accordingly, store the matching terminal state, emit the matching event -- the only settlement path that does not need the client's cooperation.
- `contracts/escrow/src/test.rs` -- add a test per matrix row, plus a test that the deadline boundary second refunds rather than pays out, and one that a resolve bumps the TTL -- reuse `locked_fixture`, `Snapshot` and `assert_release_changed_nothing` instead of new scaffolding; the matrix is this story's contract.

**Acceptance Criteria:**
- Given a booking resolved before its deadline, when balances are read, then the client holds exactly what they started with and the escrow holds nothing for that booking.
- Given a booking resolved after its deadline, when balances are read, then the professional holds exactly the deposited amount and the escrow holds nothing for that booking.
- Given a resolve submitted with no signatures supplied at all, when it returns, then it succeeded — no host auth error anywhere in the path.
- Given any rejected call, when it returns, then no tokens moved, the stored state is unchanged and no event was emitted.
- Given the crate, when `npm run contracts:test` and the `wasm32v1-none` release build run, then every test passes and the build produces a `.wasm` with no warnings.

## Spec Change Log

## Review Triage Log

### 2026-09-18 — Review pass
- verdicts: 24 findings — high 8, medium 2, low 13, false 1, maybe-false 0
- Sonuç: **intent_gap**. Kod geri alındı; denenen uygulama `spec-1-5-attempted-implementation.patch` olarak saklandı (`git apply` ile geri yüklenir). Aşağıdaki `[moot]` satırları gerçek ama intent boşlukları kapanınca kod yeniden türetileceği için bu geçişte işlenmedi.
- findings:
  - `[high]` `[intent_gap]` No-show ödemesi `released` yayınlıyor; müşterinin imzaladığı `release` ile telde bayt bayt aynı. PRD 4.3 AC1 sayacın "yalnızca `released` olayında" arttığını, AC4 iptal/iade edilen bookinglerin saymadığını söylüyor; ARCHITECTURE-SPINE.md:67 ve DESIGN.md:232 ("depozitosu serbest bırakılan seanslar") aynı yere bakıyor. Kendi doğrulamam: PRD satır 438-442. No-show bir seans değil, ama sayacı artırıyor. **E3**
  - `[high]` `[intent_gap]` Deadline öncesi herhangi bir adres canlı bir bookingi iptal edip sonlandırabiliyor. PRD 3.6 AC2 iptali müşteriye veriyor; AD-2'nin izinsizlik gerekçesi ("no-show profesyoneli mahsur bırakmasın") yalnızca deadline sonrası dalı savunuyor. **E2**
  - `[medium]` `[intent_gap]` Alıcı token'ı alamıyorsa çağrı trap ediyor; deadline sonrası hem `release` hem `resolve_cancel` aynı adresi hedeflediği için artık hiçbir kaçış yolu yok. 1.4'ün bu soruyu 1.5'e devreden erteleme maddesi yanıtsız. **E4**
  - `[low]` `[moot]` `sprint-status.yaml` hâlâ `backlog`, spec `in-progress` diyor — 1.4'te kapatılan aynı tutarsızlık.
  - `[low]` `[moot]` 1.4'ün dört açık erteleme maddesi 1.5'in boş `deferred: []` listesine taşınmamış; çözülen yarış maddesinin kapanışı da kayıtlı değil.
  - `[low]` `[moot]` Kayıt arşivlenirse (kimse marj içinde çözmezse) depozitoya ulaşacak yol yok; Code Map'in "canlı kayıt varsayabilir" ifadesi yalnızca marj içinde geçerli.
  - `[low]` `[moot]` `assert_release_changed_nothing` dört `resolve_cancel` testi tarafından kullanılıyor ama adı ve iki hata mesajı hâlâ "release" diyor.
  - `[low]` `[moot]` Yeni `assert_only_the_state_moved` yardımcısı, `deposit_is_released_and_the_professional_is_paid` içindeki satır satır `Booking` karşılaştırmasını yerinden etmemiş; kopya duruyor.
  - `[low]` `[moot]` `resolving_twice_after_the_deadline_pays_the_professional_exactly_once` kodun kendi zayıf saydığı boş-olay iddiasına dayanıyor, snapshot karşılaştırmasını atlıyor.
  - `[low]` `[moot]` Deadline sonrası `resolve_cancel` ödemesinin ardından `release`'in reddedildiğini gösteren test yok — iki fonksiyonun da `Released` ürettiği tek yol bu.
  - `[low]` `[moot]` `releasing_a_refunded_booking_is_rejected_and_changes_nothing` hâlâ `Refunded` durumunu elle yazıyor; gerçek iade yolu artık var, yorum bayatladı.
  - `[low]` `[moot]` `resolve_cancel_needs_no_authorization_from_anybody` müşterinin kendi handle'ından çağırıyor (kimlik boyutunu sınamıyor); TTL testi yalnızca iade dalını kapsıyor.
  - `[high]` `[intent_gap]` Üçüncü tarafın canlı bookingi iptal etmesi — **E2** ile aynı kök neden, aynı rota.
  - `[low]` `[moot]` 120 günlük TTL penceresi dışında kayıt arşivlenir; önerilen "okuma yolunda bump" `storage.rs`'in "okumalar bump etmez" kuralıyla çelişir.
  - `[medium]` `[intent_gap]` Alıcının token'ı alamaması — **E4** ile aynı kök neden, aynı rota.
  - `[high]` `[intent_gap]` Saat çağrı anında okunduğu için çağıran, ne zaman çağıracağını seçerek sonucu seçiyor — **E1** ile aynı kök neden.
  - `[high]` `[intent_gap]` No-show/release ayırt edilemezliği, bağımsız ikinci katmandan — **E3** ile aynı kök neden. Bu katman ayrıca 10 mutasyon çalıştırdı ve hepsinin yakalandığını gösterdi: doğrulama açığı yok.
  - `[low]` `[defer]` İki Story 1.2 testinin `BytesN::random` yüzünden snapshot'ları her koşuda yeniden yazması — önceden var, bu story'nin ürünü değil.
  - `[high]` `[intent_gap]` `cancel_deadline` seans saati değil, ücretsiz iptal penceresinin sonu (EXPERIENCE.md:145 "full refund up to 24h before", :62, :109; `types.rs` "before it the client may cancel for a refund"). İkisi arasındaki aralıkta seans hâlâ yapılacakken `now > cancel_deadline` sağlanıyor ve izinsiz bir çağrı depozitonun tamamını profesyonele aktarıp bookingi kapatıyor. Zincirde seans saati hiçbir yerde yok. **E1**
  - `[high]` `[intent_gap]` Deadline öncesi izinsiz iade — **E2** ile aynı kök neden.
  - `[low]` `[moot]` "Yabancı çağırıyor" matris satırı gönderen kimliği yüzeyinde yazılmış; test yetki-girdisi yüzeyini sınıyor. Soroban üst düzeyde çağıran kimliği sunmadığı ve fonksiyon adres parametresi almadığı için mevcut testten güçlüsü yazılamaz.
  - `[low]` `[moot]` TTL testi `set_sequence_number`'ı ilerletirken zaman damgasını `NOW`'da bırakıyor; gerçek bir ledgerde ikisi birlikte ilerler, yani bu durum oluşamaz.
  - `[high]` `[intent_gap]` Olay tüketicisi asimetrisi: `Refunded` yalnızca `resolve_cancel`'dan gelebildiği için iadeler atfedilebilir, ödemeler değil — **E3** ile aynı kök neden.
  - `[false]` `[reject]` "Spec dosyası `contracts/escrow/` dışında, sınır ihlali" çürüdü: sınır ürün kodunu yönetiyor, süreç artefaktını değil; 1.1–1.4 de kendi spec'lerini aynı yere yazdı.

## Design Notes

- **The boundary second belongs to the client.** The comparison is `now <= cancel_deadline` refunds, `now > cancel_deadline` pays out — so a client who cancels in the deadline's very last second is on time. This is the PRD's wording, and it is the right way round: the deadline is published to the client as the end of their free-cancellation window, so the window must include it.
- **Permissionless is the feature, not a relaxation.** `release` demands the client's signature because it takes money *from* them; `resolve_cancel` demands nothing because a no-show client will never sign anything. A stranger calling it gains nothing: the outcome was already fixed by the clock, and the money can only reach one of the two addresses on the record. There is no `require_auth` anywhere in this function.
- **How `resolve_cancel` and `release` interact** (carried from Story 1.4's deferred list). Both act on the same `Locked` record, and the terminal-state check is the only arbiter — whichever lands first wins, the second gets `InvalidState`. After the deadline they agree: both pay the professional. Before it they disagree — `release` pays the professional, `resolve_cancel` refunds the client — and that is correct, because `release` carries the client's own signature. A client choosing to pay early overrides their own refund window; nobody else can make that choice for them.
- **The no-show path reuses `released` rather than inventing a third event.** What the backend needs to know is where the deposit went, not which function moved it. `refunded` is new because it is a new destination; a no-show payout is the same destination `released` already describes.
- **State is checked before the clock.** Reading the ledger timestamp for a booking that is already terminal would be work with no bearing on the answer, and it keeps the guard order readable: existence, then legality, then outcome.

## Verification

**Commands:**
- `npm run contracts:test` -- expected: every test passes, including all matrix rows
- `npm run contracts:build` -- expected: a `wasm32v1-none` release artifact, no warnings (the deny-warnings lint turns any deprecated call into a build failure)

## Auto Run Result

Status: blocked
Blocking condition: intent gap
Saklanan patch: `spec-1-5-attempted-implementation.patch` (bu dizinde; `git apply` ile geri yüklenir)

Uygulama tamamlanmış ve yeşildi (54 test, temiz `wasm32v1-none` derlemesi, matrisin 8 satırı da kapsanmış, doğrulama katmanının 10 mutasyonunun tamamı yakalanıyor). Kod, spec'e ve PRD'nin Story 1.5 kabul kriterlerine **sadık**. Geri alınmasının nedeni kod kalitesi değil: dört review katmanı, yakalanan intent'in kendi içinde çözmediği dört soru ortaya çıkardı ve dördü de paranın gittiği yeri değiştiriyor.

**E1 — `cancel_deadline` seans saati değil.** UX bu alanı "full refund up to 24h before" olarak tanımlıyor, yani seans saati eksi iptal penceresi. Deadline ile seans arasındaki aralıkta seans hâlâ yapılacakken `now > cancel_deadline` sağlanıyor; izinsiz bir `resolve_cancel` depozitonun tamamını profesyonele aktarıp bookingi kapatıyor. Zincirde seans saati hiç yok, dolayısıyla kontrat bu aralığı göremiyor.

**E2 — Deadline öncesi herkes iptal edebiliyor.** AD-2 izinsizliği "no-show profesyoneli mahsur bırakmasın" diye gerekçelendiriyor; bu yalnızca deadline sonrası dalı savunuyor. Deadline öncesinde aynı kural, bir botun bir profesyonelin tüm takvimini gaz ücretine kapatmasına izin veriyor. PRD 3.6 iptali müşteriye veriyor.

**E3 — No-show ödemesi, tamamlanan seanstan ayırt edilemiyor.** İkisi de `released` yayınlıyor. PRD 4.3 sayacın yalnızca `released` ile arttığını söylüyor, ama aynı story'nin amacı "sağlayıcının gerçekten yaptığı seanslar". No-show bir seans değil; mevcut haliyle güven sinyalini şişiriyor.

**E4 — Alıcı token'ı alamıyorsa depozito kalıcı olarak kilitli.** Deadline sonrası hem `release` hem `resolve_cancel` profesyoneli hedefliyor, yani 1.4'te "1.5 çözer mi?" diye ertelenen soru bu story'de olumsuz yanıtlanıyor: kaçış yolu yok.

Bu dört soru kapandığında kod yeniden türetilecek; saklanan patch yeniden başlamayı gerektirmiyor.

## Kullanıcı Kararları (2026-09-18)

Review sonrası sorulan intent sorularının yanıtları. 1.5 bu kararlarla yeniden planlanacak; aşağıdakiler yeni intent'in girdisidir.

- **E1/E2 birlikte çözülüyor — iptalin sonucunu saat değil, imzalayan belirler.** Kullanıcı, mevcut modelin temel kusurunu işaret etti: FR7 gerçekleşmeyen her seansı örtük olarak müşterinin kusuru sayıyor, yani profesyonel iptal etse bile deadline geçmişse para ona gidiyor. Doğrulandı — profesyonelin iptali PRD'de, FR'lerde ve mimaride hiç yok. Yeni model: profesyonel iptal ederse **her zaman** müşteriye tam iade; müşteri iptal ederse saat karar verir (deadline öncesi iade, sonrası profesyonele). Kabaca `cancel_by_professional`, `cancel_by_client` ve `claim_no_show` giriş noktaları. AD-2'nin izinsizlik kuralı düşüyor, ama *amacı* korunuyor: profesyonel no-show'u kendi imzasıyla talep ettiği için mahsur kalmıyor, ve yabancılar tamamen dışarıda kalıyor.
- **Profesyonel iptalinde parasal ceza yok.** Tam iade, artı profesyonelin iptal sayacı profilde görünür (Epic 2/4 işi; `refunded` olayı kimin iptal ettiğini taşıyabilir). Escrow'da profesyonelin parası olmadığı için parasal ceza yeni bir teminat mekanizması gerektirirdi.
- **E3 — no-show için üçüncü olay: `forfeited`.** `release` `released` yayınlamaya devam eder, no-show tahsilatı `forfeited` yayınlar. Story 4.3'ün "doğrulanmış seans" sayacı yalnızca `released` sayar, böylece no-show güven sinyalini şişirmez. Üç olay da aynı tel şeklini paylaşır.
- **E4 — trustline kontrat sorunu değil, onboarding sorunu.** Profesyonel onaylanmadan önce USDC trustline'ı kurulmuş olmalı; `deferred-work.md`'ye Epic 2/4 önkoşulu olarak yazıldı. Kontrat değişmiyor.

Sıradaki adım: `bmad-correct-course` — FR7, AD-2, Story 1.5 ve 3.6 üzerindeki etkiyi çıkarıp değişiklik önerisi üretmek.
