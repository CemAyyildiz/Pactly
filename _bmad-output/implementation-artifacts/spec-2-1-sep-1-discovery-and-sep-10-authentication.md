---
title: 'Story 2.1 — SEP-1 discovery and SEP-10 authentication'
type: 'feature'
created: '2026-09-19'
status: 'done'
review_loop_iteration: 0
baseline_revision: 'b905606dff2db0cb1d1ec830d5051eb30d887986'
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
warnings: ['oversized']
deferred:
  - summary: >-
      Backend'in anchor'ın SEP-10 değişimini kimin anahtarıyla yürüttüğü
      (gerçek cüzdan mı, yönetilen hesap mı) hâlâ çözülmemiş bir tasarım
      sorusu — kod bugün kullanıcının gerçek özel anahtarını gerektiriyor.
    evidence: |-
      `services/auth.ts`'in `signer.publicKey() === walletAddress` koşulu
      backend'in gerçek cüzdan anahtarını elinde tutmasını şart koşuyor.
      Yanlış yorum düzeltildi ama tasarım kararı verilmedi. Bu fonksiyonun
      hiç üretim çağıranı yok (`getOrRefreshAnchorJwt` yalnızca testlerden
      çağrılıyor); gerçek bir cüzdan kullanıcısı için anchor oturumunun
      frontend'de ayrı bir round-trip mi gerektireceği, yoksa yalnızca
      yönetilen hesap yolunun mu bu fonksiyonu kullanacağı, 2.3/2.4'ü ilk
      yazan story'nin kararı.
    location: >-
      backend/src/services/auth.ts, backend/src/anchor/sep10.ts
    severity: medium
  - summary: >-
      `getOrRefreshAnchorJwt`'te eşzamanlı çağrılar için tek uçuşlu
      (single-flight) tekilleştirme yok; aynı cüzdan için iki eşzamanlı
      istek iki ayrı anchor değişimi başlatabilir.
    evidence: |-
      Fonksiyonun şu an hiç üretim çağıranı yok, bu yüzden gerçek eşzamanlı
      trafik oluşmuyor. Story 2.3/2.4 bunu gerçekten bağladığında yeniden
      değerlendirilmeli.
    location: >-
      backend/src/services/auth.ts
    severity: low
  - summary: >-
      `anchor_jwts` tablosu tokeni hangi anchor'ın verdiğini kaydetmiyor;
      `ANCHOR_HOME_DOMAIN` değişirse (staging→prod veya ikinci bir anchor)
      eski anchor'dan gelen önbelleklenmiş token'lar geçerli sayılabilir.
    evidence: |-
      Tek anchor'lı bir sistemde risk düşük. İkinci bir anchor ya da ortam
      geçişi olduğunda kolonun eklenmesi ucuz bir değişiklik.
    location: >-
      backend/src/db/schema.ts
    severity: low
  - summary: >-
      Pactly'nin kendi challenge doğrulamasının yalnızca `PACTLY_HOME_DOMAIN`'i
      kabul ettiğini kanıtlayan bir test yok.
    evidence: |-
      Kendim mutasyonla doğruladım: `readChallengeTx`'e domain listesi olarak
      `[PACTLY_HOME_DOMAIN, ANCHOR_HOME_DOMAIN]` geçmek 105/105'i hâlâ
      geçiriyor. Tek başına istismar edilebilir değil (iki taraf farklı
      sunucu anahtarı kullanıyor), ama "iki kimlik, asla birbirinin yerine
      geçmez" kısıtının domain yarısı testsiz. Ucuz bir eklenti: domain
      listesini genişleten bir mutasyonu yakalayan tek bir test.
    location: >-
      backend/src/auth/challenge.ts
    severity: low
---

<intent-contract>

## Intent

**Problem:** Nothing lets a user prove they own a wallet, and nothing gives the backend a way to talk to the anchor on their behalf. Every later story that needs to know "who is this" (booking a session, cashing out, depositing local currency) has no identity to check.

**Approach:** Two separate wallet-signature flows, both SEP-10-shaped but serving different parties. Pactly issues its own challenge, under its own domain, and hands the signer a Pactly JWT — that is the platform's whole login, no passwords, ever (FR10, AD-5). Separately, the backend discovers the anchor's endpoints from its `stellar.toml` (SEP-1) and runs the anchor's real SEP-10 exchange to obtain an anchor JWT, which never leaves the backend and exists only so Stories 2.3/2.4 can make SEP-6/12/38 calls later.

## Boundaries & Constraints

**Always:**
- **Two identities, two challenges, two JWTs** (AD-5). Pactly's own challenge is built and verified entirely by this backend, under `PACTLY_HOME_DOMAIN` — never the anchor's. The anchor's challenge is fetched from its own discovered `WEB_AUTH_ENDPOINT` and is a real SEP-10 exchange with `tr-mock-anchor.fly.dev`. Neither substitutes for the other.
- The anchor's JWT is stored on the backend, keyed by wallet address, and is never sent to the frontend in any response. Only the Pactly JWT goes to the caller.
- `stellar.toml` is fetched from `ANCHOR_HOME_DOMAIN` and its SEP endpoints (`WEB_AUTH_ENDPOINT`, `TRANSFER_SERVER`, and whatever SEP-38 names) are read from it — never hard-coded (AD-10). Reuse the parse/discover shape `scripts/src/toml.ts` and `scripts/src/anchor.ts` already established in this repo: pure parsing, a thin injectable `fetch` seam.
- A signature is verified against the specific public key the challenge was issued to — a valid signature from a *different* key must fail exactly as an invalid one would.
- A Pactly JWT carries the wallet address and an expiry, is signed with `PACTLY_AUTH_SIGNING_SECRET`, and is opaque outside this backend — a route that needs to know who is calling reads it through one shared verification function, not by decoding it inline.
- Every environment variable is read through `backend/src/config.ts` and nowhere else, per the existing convention; new variables are declared there and given an empty/placeholder value in `.env.example`.
- **Testing surface, stated explicitly, because this is where the last story's review found its worst gaps:** every success path must be tested, not only refusals. A chain-of-custody test exists for each flow end to end (challenge issued → signed → verified → JWT usable), driven through injected seams (`fetch` for the anchor, a fixed clock for expiry) — never a real network call, never a real anchor round trip. Pure helpers (challenge-transaction building, JWT encode/decode, `stellar.toml` parsing) are tested on their own in addition, never instead.
- Layering matches Story 2.5's convention: routes → services → db/chain/anchor/auth. The two new HTTP routes this story adds are thin; the challenge/verify logic lives in `backend/src/auth/` (Pactly's own) and `backend/src/anchor/` (the anchor's SEP-1/SEP-10 client), matching the structural seed's existing `anchor/` designation.

**Never:**
- Do not call SEP-6, SEP-12 or SEP-38. Stories 2.2–2.4 own those; this story stops at obtaining and storing the anchor's JWT.
- Do not build role-based authorization (admin/provider) or the AD-12 middleware that reads `PACTLY_ADMIN_WALLETS` — that binds to FR18/19/21, Epic 4's stories. This story's middleware only extracts *which wallet* is calling from a verified Pactly JWT; it makes no access-control decision.
- Do not build the booking, profile, application or review routes. Epic 3/4 own those.
- Do not call the real anchor over the network, or the real Soroban RPC, while building this story. The anchor's `stellar.toml` and its SEP-10 endpoint are both reached through the same kind of injectable seam Story 1.7 and 2.5 already established; a test overriding every seam never touches the network.
- Do not hand-roll the JWT signature or the SEP-10 challenge-transaction construction/verification from scratch. Use `@stellar/stellar-sdk` 17.1.0's own `WebAuth.buildChallengeTx` / `WebAuth.readChallengeTx` / `WebAuth.verifyChallengeTxSigners` for the challenge side (already a project dependency; this is exactly what it exists for), and a well-reviewed JWT library rather than raw HMAC code, since a subtle bug here is an authentication bypass.
- Do not change `contracts/`, `scripts/`, or `frontend/`. Within `backend/`, do not touch `chain/`, `db/schema.ts`'s existing tables, or any Story 2.5 module beyond adding one new table for the anchor-JWT cache.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Pactly challenge issued | A wallet's public key | A signed-by-Pactly challenge transaction naming that key and `PACTLY_HOME_DOMAIN` | No error expected |
| Pactly login succeeds | The challenge, correctly signed by the named key | A Pactly JWT for that wallet address | No error expected |
| Pactly login: wrong signer | The challenge, signed by a *different* key | Rejected | Meaningful, typed error — same shape as "no signature" |
| Pactly login: expired challenge | A challenge past its validity window, signed correctly | Rejected | Meaningful, typed error naming the expiry |
| Pactly JWT verified | A JWT this backend issued, not yet expired | The wallet address it names | No error expected |
| Pactly JWT: expired | A JWT past its expiry | Rejected | Meaningful, typed error |
| Pactly JWT: tampered | A JWT whose payload was altered after signing | Rejected | Meaningful, typed error, same shape as expired (no signature-forgery oracle) |
| stellar.toml discovered | `ANCHOR_HOME_DOMAIN`'s real body | `WEB_AUTH_ENDPOINT` and the other SEP endpoints returned; no endpoint hard-coded | No error expected |
| Anchor unreachable | `stellar.toml` fetch fails | Nothing proceeds to the anchor SEP-10 exchange | Meaningful, typed error naming the domain |
| Anchor SEP-10 succeeds | A valid challenge round trip with the anchor | The anchor's JWT stored, keyed by wallet address | No error expected |
| Anchor SEP-10: invalid signature | The anchor rejects the submitted signed challenge | Nothing stored | Meaningful, typed error surfacing the anchor's own reason |
| Anchor JWT reused | A second call for a wallet with a still-valid stored anchor JWT | The stored JWT returned; no new anchor round trip | No error expected |
| Anchor JWT expired, refetched | A stored anchor JWT past its expiry | A fresh SEP-10 exchange runs and replaces it | No error expected |

</intent-contract>

## Code Map

- `backend/src/config.ts` -- the one place env vars are read. Add `pactlyHomeDomain` (`PACTLY_HOME_DOMAIN`) and `pactlyAuthSigningSecret` (`PACTLY_AUTH_SIGNING_SECRET`) as `required()`. `anchorHomeDomain` already exists and is what SEP-1 discovery reads.
- `.env.example` -- add the two new keys above with placeholder/empty values and a comment, matching the existing style (see `ANCHOR_HOME_DOMAIN`'s comment for the tone).
- `scripts/src/toml.ts`, `scripts/src/anchor.ts` -- the established pure-parse / injectable-fetch shape for reading a `stellar.toml` and resolving an asset from it (Story 1.7). This story's `backend/src/anchor/stellar-toml.ts` should parse the *endpoints* (`WEB_AUTH_ENDPOINT` etc.) the same way, not the USDC currency — different data, same discovery discipline (AD-10). Do not import from `scripts/`; backend and scripts are separate workspaces. Re-derive the same shape.
- `contracts/escrow/src/lib.rs` / soroban-sdk's `Keypair`, `Address` -- not used here; SEP-10 signs a *transaction envelope*, not a contract call. `@stellar/stellar-sdk`'s `Utils`, `Keypair`, `TransactionBuilder` are what this story uses, already a pinned dependency from Story 2.5's `backend/src/chain/client.ts`.
- `backend/src/db/schema.ts`, `migrations.ts`, `client.ts` -- Story 2.5's conventions: Drizzle table + hand-written DDL kept in sync (and round-trip tested, per that story's own review finding), `openDatabase(":memory:")` for tests. Add one table here: the anchor-JWT cache (wallet address, JWT, expiry). No existing table changes.
- `backend/src/chain/client.ts`, `chain/errors.ts` -- the seam pattern to copy: every network stage as an injectable function on a deps object, defaulting to the real implementation; typed error classes per failure kind, never a raw string or raw SDK error escaping the module. Story 2.5's review found and fixed every place this pattern was *not* followed (untested success paths, a `config.ts` side-effect that broke test isolation for files importing `chain/client.ts`) — read `backend/test/testConfigEnv.ts` and copy its convention for any new test file that transitively imports `config.ts`.
- `backend/src/services/booking.ts`, `services/profile.ts` -- the thin-composition convention: routes will eventually call a service function, the service composes db/chain/anchor calls, nothing outside `db/` builds SQL. This story's equivalent is a thin `backend/src/services/auth.ts` (or the logic can live directly in `backend/src/auth/`, since there is no db-composition complexity beyond one table — pick whichever avoids an empty pass-through file).
- `backend/src/index.ts` -- currently only `/health`. This story is the first to add real routes; keep the wiring minimal (Hono route registration + the one identity-extraction middleware), no unrelated changes.
- `backend/package.json` -- add a JWT library (`jose` is the natural fit: ESM-native, matches this project's `"type": "module"` + `verbatimModuleSyntax` setup, unlike `jsonwebtoken`'s CJS-first API). Pin an exact version, matching how Story 1.7 pinned `smol-toml`.

## Tasks & Acceptance

**Execution:**
- `backend/src/config.ts`, `.env.example` -- add `PACTLY_HOME_DOMAIN` and `PACTLY_AUTH_SIGNING_SECRET` -- the two things Pactly's own challenge/JWT need that nothing in the repo has yet.
- `backend/src/auth/challenge.ts` -- build and read a Pactly-domain SEP-10 challenge transaction via `WebAuth.buildChallengeTx`/`WebAuth.readChallengeTx`/`WebAuth.verifyChallengeTxSigners`, and issue/verify a Pactly JWT (via `jose`) carrying the wallet address and expiry -- the platform's whole login mechanism, no passwords per FR10.
- `backend/src/anchor/stellar-toml.ts` -- fetch and parse `ANCHOR_HOME_DOMAIN`'s `stellar.toml`, returning its SEP endpoints, with an injectable `fetch` seam defaulting to the real one -- AD-10's discovery, never hard-coded.
- `backend/src/anchor/sep10.ts` -- the anchor's real SEP-10 client: request a challenge from the discovered `WEB_AUTH_ENDPOINT`, sign it with the caller-supplied signer, submit it, return the anchor's JWT -- mirrors `chain/client.ts`'s injectable-network-stage shape.
- `backend/src/db/schema.ts`, `migrations.ts` -- add the anchor-JWT cache table (wallet address, JWT, expires-at) -- so SEP-10 for the same wallet is not re-run on every call.
- `backend/src/services/auth.ts` (or folded into `auth/` if a pass-through service file would be empty) -- composes: verify a Pactly JWT, and separately, get-or-refresh a wallet's cached anchor JWT -- the one place a later story's route calls into.
- `backend/src/index.ts` -- register `POST /auth/challenge`, `POST /auth/verify` (Pactly's own login), and a small `requirePactlyAuth` middleware that reads the `Authorization` header, verifies the JWT, and attaches the wallet address to the request context -- thin wiring only.
- `backend/test/` -- one test file per new module, following Story 2.5's now-established pattern: real (`:memory:`) database for the JWT cache, every network seam injected and asserted never-reached on the failure paths, and **explicit success-path tests** for every flow in the matrix, not only refusals.

**Acceptance Criteria:**
- Given a wallet's public key, when it signs the Pactly challenge issued for it, then verification returns that wallet's address and a Pactly JWT is issued.
- Given a Pactly JWT, when a request carries it and `requirePactlyAuth` runs, then the request's wallet address matches the one the JWT was issued to — and a missing, expired, or tampered JWT is rejected with a meaningful error, not a stack trace.
- Given `ANCHOR_HOME_DOMAIN`'s `stellar.toml`, when it is fetched and parsed, then the anchor's SEP-10 endpoint comes from it and appears as a literal nowhere in the source.
- Given a successful anchor SEP-10 exchange, when it completes, then the anchor's JWT is stored server-side, keyed by wallet address, and is never present in this backend's own HTTP responses.
- Given the backend workspace, when `npm run -w backend typecheck` and `npm run -w backend test` run, then both are clean and every I/O-matrix row — including every success path — has a passing test.

## Spec Change Log

## Review Triage Log

### 2026-09-19 — Review pass
- verdicts: 28 findings — high 6, medium 8, low 10, false 2, maybe-false 1
- Bu, kimlik doğrulama kodu olduğu için oturumun en ciddi review turu. İki kritik bulgu (hesap kimliği bypass'ı, challenge replay'i) üç ve iki katman tarafından bağımsız doğrulandı, biri doğrudan HTTP isteğiyle kanıtlandı. Yama sonrası ikisini de kendim mutasyonla tekrar test ettim.
- findings:
  - `[high]` `[patch]` Anchor'ın SEP-10 istemcisi `WebAuth.readChallengeTx()`'in döndürdüğü `clientAccountID`'yi atıp challenge'ın gerçekten talep edilen hesaba ait olup olmadığına bakmıyordu — backend anchor'dan dönen her challenge'ı imzalıyordu. Üç katman bağımsız buldu. `clientAccountID` yakalanıp `account` ile karşılaştırılıyor artık. Yama sonrası mutasyonla (karşılaştırmayı `if (false)` yaparak) tekrar test ettim: 1 test düşüyor.
  - `[high]` `[patch]` Aynı bypass, edge-case katmanından, mutasyonla kanıtlanmış (aynı kök neden, aynı rota).
  - `[high]` `[patch]` Aynı bypass, doğrulama katmanından — bu kontrolü koruması gereken tek testin bile hata sınıfına baktığı, POST'un gerçekten engellenip engellenmediğine bakmadığı gösterildi (aynı kök neden, ek bulgu aşağıda).
  - `[high]` `[patch]` Pactly'nin kendi challenge'ında tekrar oynatma (replay) koruması yoktu — doğrulama katmanı bunu **doğrudan HTTP isteğiyle kanıtladı**: aynı imzalı zarfı `/auth/verify`'a iki kez POST etmek ikisinde de 200 ve taze token döndürüyordu. `used_challenge_nonces` tablosu ve atomik `redeemChallengeNonceIfUnused` eklendi (okuma-sonra-yazma yarışı yok, `onConflictDoNothing` ile). Yama sonrası mutasyonla (`firstUse`'u hep `true` yaparak) tekrar test ettim: 2 test düşüyor.
  - `[high]` `[patch]` Aynı replay açığı, blind-hunter ve edge-case katmanlarından (aynı kök neden, aynı rota).
  - `[high]` `[patch]` `anchor-sep10.test.ts`'teki "farklı sunucu anahtarıyla imzalanmış challenge reddedilir" testi, kimlik doğrulama kontrolünü tamamen silen bir mutasyonla bile geçiyordu — çünkü `sep10.ts` her hatayı aynı `AnchorAuthError` sınıfına sarıyordu ve test yalnızca sınıfa bakıyordu. `postCalled` izleme ve mesaj deseni eşleşmesi eklendi, kardeş testin zaten kullandığı desenle aynı.
  - `[medium]` `[patch]` `/auth/verify`'ın süresi dolmuş challenge → 401 dalının hiçbir HTTP-seviyesi testi yoktu; dalı `false` yapan mutasyon hiçbir testi düşürmüyordu. `t.mock.timers` ile saat penceresini aşan bir test eklendi.
  - `[medium]` `[patch]` `cp .env.example .env` backend'i başlatmıyordu — `PACTLY_AUTH_SIGNING_SECRET` boş ama zorunlu. Gerçek süreci `.env.example`'ın taze kopyasına karşı başlatarak kendim doğruladım (exit 1). Gerçek 48 karakterlik yerel-geliştirme placeholder'ı eklendi, README güncellendi. Yama sonrası kendim tekrar başlattım: artık çalışıyor.
  - `[medium]` `[patch]` `services/auth.ts` kullanıcının gerçek özel anahtarını backend'in elinde tutmasını şart koşarken, `sep10.ts`'in kendi yorumu tam tersini söylüyordu ("bu backend asla kullanıcının gerçek cüzdan anahtarını tutmaz"). Yorum koddaki gerçek davranışı yansıtacak şekilde düzeltildi; altındaki tasarım sorusu `deferred`'a taşındı (2.3/2.4'ün kararı).
  - `[medium]` `[patch]` Keşfedilen `WEB_AUTH_ENDPOINT` hangi şemayı taşırsa taşısın kullanılıyordu. `https:` zorunluluğu eklendi, aksi halde imzalanmadan/gönderilmeden önce reddediliyor.
  - `[medium]` `[patch]` `PACTLY_AUTH_SIGNING_SECRET`'in minimum uzunluk kontrolü yoktu — hem JWT HMAC anahtarını hem challenge sunucu anahtar çiftini türetiyor, zayıf bir değer ikisini de kırar. 32 karakterlik taban eklendi.
  - `[medium]` `[patch]` `sep10.ts`'in her iki bacağı da gövdeyi JSON olarak ayrıştırmadan önce `response.ok`'a bakmıyordu; JSON olmayan bir hata sayfası anchor'ın gerçek durumunu ve nedenini gizliyordu — tam da matrisin istediği şeyin tersi. `ok` önce kontrol ediliyor artık.
  - `[medium]` `[patch]` Bearer şeması büyük/küçük harfe duyarlıydı, RFC 7235 ihlali. Artık büyük/küçük harfe duyarsız eşleşiyor.
  - `[medium]` `[patch]` `app.ts`'te `onError` yoktu; beklenmeyen bir hata Hono'nun varsayılan düz metin 500'üne düşüyordu, diğer her yanıtın kullandığı `{code, message}` zarfını kırıyordu. Eklendi.
  - `[medium]` `[patch]` `getOrRefreshAnchorJwt`'in imzacı/cüzdan uyuşmazlığı çıplak `TypeError` fırlatıyordu, bu story'nin kendi "hiçbir modülden ham hata kaçmaz" kuralını çiğniyordu. Tipli `AnchorSignerMismatchError` eklendi.
  - `[low]` `[patch]` `ChallengeResponseBody.network_passphrase` ayrıştırılıp hiç karşılaştırılmıyordu; uyuşmazlık opak bir imza hatası olarak görünüyordu. Artık karşılaştırılıyor.
  - `[low]` `[patch]` GET isteği string birleştirmeyle kuruluyordu, zaten sorgu dizesi taşıyan bir uç noktayı bozardı. `new URL` + `searchParams.set` ile düzeltildi.
  - `[low]` `[patch]` `decodeJwtExpiryMs` herhangi bir sonlu `exp`'i kabul ediyordu, geçmişte olanı da. Artık geçmiş `exp` reddediliyor.
  - `[low]` `[patch]` Önbellek tazelik kontrolünün marjı yoktu; birkaç saniye kalan bir token verilip istek ortasında anchor tarafından reddedilebilirdi. 30 saniyelik marj eklendi.
  - `[low]` `[defer]` Eşzamanlı `getOrRefreshAnchorJwt` çağrıları için tek-uçuşlu tekilleştirme yok — fonksiyonun hiç üretim çağıranı olmadığı için gerçek eşzamanlılık henüz oluşmuyor; 2.3/2.4 bağladığında değerlendirilmeli.
  - `[low]` `[defer]` `anchor_jwts` hangi anchor'ın token verdiğini kaydetmiyor — tek anchor'lı sistemde risk düşük.
  - `[medium]` `[defer]` Özel anahtar saklama tasarım sorusu (yukarıdaki ile aynı kök neden, aynı rota) — `deferred`'a resmi olarak taşındı.
  - `[false]` `[reject]` "Beklenti belgesi kendi değerlendirdiği değişimin içinde yazılmış" (spec'in intent'i I/O matrisiyle birlikte içermesi) — bu BMAD akışının kendi tasarımı: önce spec, sonra ona karşı uygulama. Kusur değil.
  - `[false]` `[reject]` `algorithms: ["HS256"]` pininin korunmasız olması — `jose` geçerli bir `Uint8Array` anahtarla zaten yalnızca HMAC algoritmalarını kabul ediyor; pin derinlemesine savunma, bugün istismar edilebilir bir boşluk değil.
  - `[maybe-false]` `[defer]` `verifyPactlyJwt`'in enjekte edilen saatinin (`now` seam'i) testsiz olması — süresi dolma zorlaması ayrı bir testle kanıtlanmış, yalnızca `now` seam'inin kendisi hiçbir iddiada etkili değil; gerçek saat zaten testin beklediği sonucu üretiyor. Ayrı bir "süresi dolmadan önce hâlâ kabul edilir, sabit bir `now` ile" testi eklenmesi gerekir, ama düşük risk — ertelendi.
  - `[low]` `[defer]` Pactly'nin kendi challenge doğrulamasının yalnızca `PACTLY_HOME_DOMAIN`'i kabul ettiğini kanıtlayan bir test yok — kendim mutasyonla doğruladım: `readChallengeTx`'e `[PACTLY_HOME_DOMAIN, ANCHOR_HOME_DOMAIN]` geçmek 105/105'i hâlâ geçiriyor. Tek başına istismar edilebilir değil (iki taraf farklı sunucu anahtarı kullanıyor), ama "iki kimlik, asla birbirinin yerine geçmez" kısıtının domain yarısının testsiz kaldığını gösteriyor. Ucuz bir eklenti: domain listesini genişleten bir mutasyonu yakalayan bir test.

## Design Notes

- **Why two challenges, not one.** The PRD's four numbered acceptance criteria for this story (`stellar.toml` discovery, a SEP-10 challenge fetched/signed/exchanged, the JWT stored and reused for later SEP calls) describe, read literally, only the *anchor's* SEP-10 — "fetched" implies fetched from somewhere external, and "used in subsequent SEP calls" only makes sense for the anchor's JWT (SEP-6/12/38 are the anchor's protocols). But the story's own title and user-story sentence — "As a user, I want to sign in with my wallet" — is FR10's platform login, and AD-5 states in its own words, binding this story explicitly, that "Pactly issues its own challenge and its own JWT." The epic context's cross-story dependency note ("Story 2.1's SEP-10 JWT is a precondition for 2.3 and 2.4, which both act under an authenticated anchor session") confirms the anchor half exists here too. Read together, the PRD's ACs are the anchor half; AD-5 requires the platform half; both belong to this one story. This is recorded here rather than resolved by picking one, because both are load-bearing: without the anchor JWT, 2.3/2.4 have no way to authenticate; without Pactly's own JWT, nothing in the platform has a session at all.
- **Why `WebAuth.buildChallengeTx` for Pactly's own challenge too, not a custom scheme.** SEP-10 is deliberately domain-agnostic — `home_domain` is exactly the field that lets one server's challenge be distinguished from another's, and `@stellar/stellar-sdk` ships the full toolkit for *implementing* a SEP-10 server, not only consuming one. Reusing it for Pactly's own login means one audited code path proves wallet ownership everywhere in this codebase, rather than a hand-rolled scheme with its own edge cases.
- **Why the anchor JWT gets a cache table and Pactly's own JWT does not.** A Pactly JWT is self-contained (wallet address + expiry, verified by signature alone) and needs no database round trip to check — that is the point of a JWT. The anchor's JWT, by contrast, is fetched from a third party this backend does not want to re-authenticate with on every request, so it is cached, keyed by wallet address, and only refreshed once it is actually expired.
- **No route-level authorization here, on purpose.** `requirePactlyAuth` answers "which wallet is this," never "is this wallet allowed to." AD-12's role-based middleware (admin/provider) depends on data Epic 4's stories introduce and binds to FR18/19/21, not FR10/15 — building it here would be reaching into another story's scope the way Story 2.5's boundary violations were reached into by tests, which the last review round closed one at a time.

## Verification

**Commands:**
- `npm run -w backend typecheck` -- expected: clean
- `npm run -w backend test` -- expected: all pass, including every success-path row in the matrix
- `npm run -w backend build` -- expected: clean (Story 2.5's review found this wasn't in the verification path by default; it is now)
- `npm test` (root) -- expected: contract tests, backend tests and scripts tests all pass

**Manual checks:**
- `git grep` for the anchor's `WEB_AUTH_ENDPOINT` value or any literal SEP-10 URL outside `.env.example`/README/`backend/test/` (test fixtures legitimately hard-code it to build realistic stubs): no hits in `backend/src/` — everything comes from the discovered `stellar.toml`.
- `git grep` for the anchor JWT appearing in any route's response-building code: no hits.
- **Not run:** no real call to `tr-mock-anchor.fly.dev`, no real Soroban RPC call.

## Auto Run Result

Status: done

**Yapılan değişikliğin özeti.** İki ayrı SEP-10-şekilli cüzdan-imza akışı: Pactly'nin kendi challenge/JWT mekanizması (`backend/src/auth/`, platformun tüm girişi, şifre yok) ve anchor'ın gerçek SEP-1/SEP-10 istemcisi (`backend/src/anchor/`, `tr-mock-anchor.fly.dev`'e karşı, sonucu backend'de önbelleklenen bir JWT — asla frontend'e gitmiyor). `POST /auth/challenge`, `POST /auth/verify` ve kimliği çıkaran `requirePactlyAuth` middleware'i eklendi.

**Kesinti ve devam.** Uygulama iki kez rate limit'e çarptı — ilki neredeyse tamamlanmışken ("Clean. Now run the tests"), bu sırada arka planda büyük bir planlama pivotu (Trustless Work) onaylanmış olduğunu keşfettim, kullanıcıya danıştım, kimlik doğrulamanın bundan bağımsız olduğunu doğruladıktan sonra devam ettim. İkinci kesinti sonrası da işi kaybetmeden aynı ajanı devam ettirdim.

**Review bulguları.** Bu, kimlik doğrulama kodu olduğu için oturumun en ciddi review turu. 4 katman 28 bulgu bildirdi: high 6, medium 8, low 12, false 2, maybe-false 1. **21 giriş yamandı**, 4 ertelendi.

İki kritik bulgu **doğrulanmış güvenlik açığıydı**, yorum ya da spekülasyon değil:
- **Hesap kimliği bypass'ı**: anchor'ın SEP-10 istemcisi, `WebAuth.readChallengeTx()`'in döndürdüğü `clientAccountID`'yi atıp challenge'ın gerçekten talep edilen hesaba ait olup olmadığına bakmadan imzalıyordu. Üç katman bağımsız buldu; koruması gereken tek test bile hata sınıfına baktığı için bu bypass'ı yakalamıyordu.
- **Challenge replay**: doğrulama katmanı bunu **doğrudan HTTP isteğiyle kanıtladı** — aynı imzalı zarfı `/auth/verify`'a iki kez POST etmek ikisinde de 200 ve taze token döndürüyordu.

İkisini de yama sonrası **kendim mutasyonla tekrar test ettim** (hesap kontrolünü `if (false)` yapma, replay korumasını hep `true` döndürme) ve ikisinin de yakalandığını doğruladım.

Ayrıca kendi payıma bir çelişki buldum: `services/auth.ts` backend'in kullanıcının gerçek özel anahtarını elinde tutmasını şart koşuyordu, `sep10.ts`'in kendi yorumu tam tersini söylüyordu. Yorumu düzelttim, altındaki tasarım sorusunu (2.3/2.4'ün kararı) `deferred`'a taşıdım.

Bir de kendim ek bir mutasyon denedim (patch turunda ele alınmamış): Pactly'nin kendi challenge doğrulamasının yalnızca `PACTLY_HOME_DOMAIN`'i kabul ettiğini kanıtlayan test yok — domain listesini genişleten mutasyon hâlâ yakalanmıyor. Düşük risk (iki taraf farklı sunucu anahtarı kullanıyor), `deferred`'a eklendi.

**Spec düzeltmesi kendi payıma:** spec `Utils.buildChallengeTx` diye yazmıştı, gerçek SDK bunu `WebAuth` altında export ediyor. Uygulayan ajan doğru seçti, spec metnini düzelttim.

**Takip review önerisi:** `true`. Altı `high` giriş yamandı, ikisi doğrulanmış güvenlik açığıydı.

**Yapılan doğrulama.**
- `npm run -w backend typecheck` → temiz.
- `npm run -w backend test` → 105/105.
- `npm run -w backend build` → temiz.
- `npm test` (kök) → 62 Rust + 105 backend + 69 scripts, hepsi geçti.
- Kritik iki mutasyonun ikisi de yama sonrası kendim tekrar çalıştırıldı ve yakalandı.
- `.env.example`'ın taze kopyasına karşı gerçek süreci başlattım: artık çalışıyor (önceden `PACTLY_AUTH_SIGNING_SECRET` boş olduğu için başlamıyordu).
- `git status`: `contracts/`, `scripts/`, `frontend/` dokunulmadı.

**Kalan riskler.** `getOrRefreshAnchorJwt`'in hiç üretim çağıranı yok — anchor SEP-10 yolu hiçbir zaman gerçek anchor'a karşı çalışmadı. Özel anahtar saklama tasarım sorusu çözülmedi (2.3/2.4'ün kararı). Pactly'nin kendi challenge doğrulamasının domain-sabitleme testi eksik.
