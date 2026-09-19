---
title: 'Story 1.7 — Testnet setup scripts'
type: 'feature'
created: '2026-09-18'
status: 'done'
review_loop_iteration: 0
baseline_revision: '3e6911cb671652a7934aaf7dec303957d9f6bfef'
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
warnings: []
deferred:
  - summary: >-
      Ağ yollarının hiçbiri çalıştırılmadı: fonlama, trustline ve deploy yalnızca
      okunarak ve sahte seam'lerle doğrulandı.
    evidence: |-
      Spec bunları çalıştırmayı yasakladı ve Stellar CLI bu makinede kurulu değil.
      Yüksek önemli düzeltmelerin üçü (sırrın `STELLAR_SECRET_KEY` ile geçirilmesi,
      kontrat id doğrulaması, CLI kontrolünün deploy dalına taşınması) tam da bu
      yolda yaşıyor. İlk gerçek koşu operatörün işi ve bu story'nin en büyük
      doğrulanmamış riski.
    location: >-
      scripts/src/cli.ts, scripts/src/horizon.ts
    severity: medium
  - summary: >-
      Hiçbir test çıkış kodunu gözlemlemiyor; matrisin "sıfırdan farklı çıkış"
      vaadi yalnızca atılan hatanın tipiyle doğrulanıyor.
    evidence: |-
      `main().catch` `process.exitCode = 1` atıyor ve yalnızca `error.message`
      basıyor — okunarak doğru, testle değil. Uçtan uca test başarı yolunu
      sürüyor, hata yolunun çıkış kodunu değil.
    location: >-
      scripts/src/setup-testnet.ts
    severity: low
  - summary: >-
      Horizon dayanıklılığı kapsam dışı bırakıldı: ücret artışı (surge) ve 429/5xx
      yanıtları yorumlanmıyor.
    evidence: |-
      `addTrustline` sabit `BASE_FEE` kullanıyor, ağ yoğunsa `tx_insufficient_fee`
      alır; `loadAccountIfExists` yalnızca `NotFoundError`'ı yorumluyor, 429/5xx
      opak axios mesajı olarak geçiyor. Demo ölçeğinde gerçekçi değil, ama
      testnet'te ilk gerçek koşudan sonra yeniden değerlendirilmeli.
    location: >-
      scripts/src/horizon.ts
    severity: low
  - summary: >-
      İki Story 1.2 testi `BytesN::random` yüzünden snapshot'larını her koşuda
      yeniden yazıyor; bu story boyunca üç kez elle temizlendi.
    evidence: |-
      1.3'ten beri `deferred-work.md`'de kayıtlı, 1.4 ve 1.5'te de ertelendi.
      Artık `contracts/` dışındaki story'leri bile kirletiyor: bu story'de
      `npm test` her çalıştığında iki dosya değişti. Test başına tek satır.
    location: >-
      contracts/escrow/src/test.rs:302,350
    severity: low
---

<intent-contract>

## Intent

**Problem:** The escrow contract is finished but nothing can reach it. A demo needs funded testnet accounts, a USDC trustline on each, and a deployed contract whose id the backend can read — and doing that by hand on demo day is exactly the time nobody has.

**Approach:** One command, `npm run setup:testnet`, that funds the accounts through friendbot, adds the anchor's USDC trustline to each, deploys the escrow contract, and prints the result as lines that paste straight into `.env`. Re-running it is safe: anything already done is recognised and skipped rather than retried into an error.

## Boundaries & Constraints

**Always:**
- The USDC asset — issuer and code alike — is discovered from the anchor's `stellar.toml` at `ANCHOR_HOME_DOMAIN` (AD-10). Only the home domain and the network passphrase are configured, and both already exist in `.env.example`.
- Every step is idempotent. An account friendbot has already funded, a trustline that already exists and a contract already deployed are each recognised and skipped, so a second run reports the same result instead of failing.
- The script's own output is the `.env` shape: `KEY=value` lines, ready to paste or redirect. `ESCROW_CONTRACT_ID` and `PACTLY_ADMIN_WALLETS` are among them, both already declared in `.env.example`.
- Secret keys are printed to stdout for the operator to place in `.env` and nowhere else. `.env` is gitignored; `.env.example` gains any new key with an empty value, never a real one.
- Deployment shells out to the Stellar CLI, as `scripts/README.md` already commits to. When the CLI is absent the script says so plainly and names the install page, exits non-zero, and leaves nothing half-applied.
- Every failure mode — the anchor unreachable, its `stellar.toml` missing a USDC entry, friendbot refusing, the CLI absent — exits non-zero with a message that names what to do next. No stack traces as the primary output.
- The logic that does not touch the network — parsing `stellar.toml`, deciding what is already done, shaping the `.env` lines — is pure and unit-tested. Network calls stay thin wrappers around it.
- `scripts/` joins the existing workspaces beside `backend` and `frontend`, with its own `package.json` and `tsconfig.json`. TypeScript, `@stellar/stellar-sdk` 17.1.0, run through `tsx`.

**Never:**
- Do not hard-code the USDC issuer, the asset code, or any SEP endpoint. Do not read them from anywhere but the resolved `stellar.toml`.
- Do not commit a secret key, and do not write one into `.env.example` or any tracked file.
- **Do not run any of these scripts against the network as part of building this story** — no friendbot call, no trustline, no deploy. They are written and verified statically here; running them is the operator's separate, deliberate act.
- Do not install the Stellar CLI or change the toolchain on this machine. Detect it and report it missing.
- Do not change `contracts/`, `backend/` or `frontend/`. The root `package.json` gains the `setup:testnet` script and the workspace entry, nothing else.
- No mainnet. No key generation that silently overwrites keys an operator already placed in `.env`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| First run | No accounts, no trustlines, no deployed contract, CLI present | Accounts funded, USDC trustline on each, contract deployed; `.env` lines printed including `ESCROW_CONTRACT_ID` | No error expected |
| Re-run, all done | Accounts funded, trustlines present, contract id already in `.env` | Each step reports "already done" and is skipped; the same `.env` lines are printed | No error expected |
| Re-run, partly done | Accounts funded but no trustlines | Funding skipped, trustlines added, run continues | No error expected |
| Stellar CLI missing | `stellar` not on PATH | Message naming the install page; nothing deployed | Non-zero exit |
| Anchor unreachable | `stellar.toml` cannot be fetched | Message naming the home domain it tried; no trustline attempted | Non-zero exit |
| Anchor has no USDC | `stellar.toml` fetched, no matching currency | Message naming the currencies it did find | Non-zero exit |
| Friendbot refuses | Friendbot returns an error that is not "already funded" | Message carrying friendbot's own reason | Non-zero exit |
| `stellar.toml` parsed | A toml body with a USDC currency entry | Issuer and asset code returned; unrelated currencies ignored | Malformed body reports which field was missing |
| `.env` lines shaped | A set of resolved values | One `KEY=value` line per key, values quoted only where they need it | No error expected |

</intent-contract>

## Code Map

- `scripts/README.md` -- already states this story's scope and commits to four concerns (funding, trustlines, deploy, seed) and to the Stellar CLI. Read it first; it is the contract for what lands here. Update it from future tense to what exists once the scripts are written.
- `.env.example` -- the key list the backend reads. `ESCROW_CONTRACT_ID` (empty, waiting for this story) and `PACTLY_ADMIN_WALLETS` (empty, comma-separated `G...` ids, AD-12) already exist, and its header already names `npm run setup:testnet`. Any new key is added here with an empty value. Read-only otherwise.
- `.env` -- gitignored, present locally. The script never writes it; it prints lines the operator places.
- `package.json` (root) -- `workspaces: ["backend", "frontend"]` gains `"scripts"`; `scripts` object gains `setup:testnet`. Node `>=22.12.0`, currently on 22.17. `concurrently` is the only root devDependency. Nothing else here changes.
- `backend/package.json` -- the convention to copy for the new workspace: `tsx` 4.23.13, `typescript` 5.9.3, `@types/node` 22.20.3 as devDependencies. `@stellar/stellar-sdk` is pinned to 17.1.0 by the epic context and is not yet a dependency anywhere.
- `_bmad-output/implementation-artifacts/epic-1-context.md` -- AD-10 (endpoints discovered, never hard-coded) and AD-12 (`PACTLY_ADMIN_WALLETS`) are the two decisions this story is bound by; the pinned versions are listed there.
- `contracts/escrow/` -- read-only here. The deploy step consumes the `wasm32v1-none` release artifact that `npm run contracts:build` produces; it must build the contract rather than assume the artifact is present.
- **Toolchain note:** the Stellar CLI is *not installed on this machine*. That is expected and must not be changed — it is why the CLI-missing row exists in the matrix, and why the deploy path cannot be exercised while building this story.

## Tasks & Acceptance

**Execution:**
- `scripts/package.json`, `scripts/tsconfig.json` -- add the workspace beside `backend` and `frontend`, with `@stellar/stellar-sdk` 17.1.0 and the same `tsx`/`typescript`/`@types/node` versions the backend uses -- one convention for every workspace, and the pinned SDK version is an epic-level decision.
- `scripts/src/` -- the setup command and its steps: resolve the anchor's USDC asset from `stellar.toml`, fund through friendbot, add the trustline, build and deploy the contract through the Stellar CLI, then print the `.env` lines -- each step reporting what it did or why it was skipped, because an operator re-running this needs to see which parts were already in place.
- `scripts/src/` (pure helpers, separated from the network calls) -- `stellar.toml` parsing, the already-done decisions and the `.env` line shaping, each unit-tested with Node's built-in test runner -- these carry the story's logic and are the only parts verifiable without touching the network; no new test framework.
- `package.json` (root) -- add `scripts` to `workspaces` and `setup:testnet` to `scripts` -- `.env.example` already tells the operator this command exists.
- `scripts/README.md` -- rewrite from "what lands here" to what exists, including the Stellar CLI prerequisite and what to do with the printed output -- it is the first thing someone setting up reads.

**Acceptance Criteria:**
- Given the anchor's `stellar.toml` body, when it is parsed, then the USDC issuer and asset code come from it and no issuer appears as a literal anywhere in the source.
- Given a set of resolved values, when the output is shaped, then every line is a valid `.env` assignment and the set includes `ESCROW_CONTRACT_ID` and `PACTLY_ADMIN_WALLETS`.
- Given the `scripts` workspace, when `tsc --noEmit` runs, then it typechecks clean.
- Given the pure helpers, when their tests run, then every matrix row that does not require the network passes.
- Given a reader of `scripts/README.md`, when they follow it, then they learn the Stellar CLI is required, what one command to run, and where its output goes.

## Spec Change Log

## Review Triage Log

### 2026-09-18 — Review pass
- verdicts: 55 findings — high 12, medium 17, low 23, false 3, maybe-false 0
- Katmanlar arası yoğun tekrar var; aşağıda her bulgunun kendi satırı, gruplananlar aynı rotayı paylaşıyor. Doğrulama katmanı beş açığı mutasyonla kanıtladı; beşini de yama sonrası kendim tekrar çalıştırdım.
- findings:
  - `[high]` `[patch]` Deploy sırrı argv'de (`--source-account <S...>`), `ps`'te görünüyor; üstelik `execFileSync`'in hata mesajı tüm komut satırını gömüyor ve o mesaj README'nin önerdiği `setup.log`'a düşüyor. Sır artık `STELLAR_SECRET_KEY` ortam değişkeniyle geçiyor ve hata mesajı komut satırını yansıtmıyor; bir test sırrın mesajda geçmediğini doğruluyor.
  - `[high]` `[patch]` Aynı sızıntı, kenar-durum katmanından (aynı kök neden, aynı rota).
  - `[high]` `[patch]` Aynı sızıntı, doğrulama katmanından (aynı kök neden, aynı rota).
  - `[high]` `[patch]` Belgelenen `npm run setup:testnet >> .env` npm'in kendi `> paket@sürüm` başlığını `.env`'e yazıyor (npm onu stdout'a basıyor), üstelik kök script devrettiği için iki kez. `--silent` hem kök devirde hem README'de; append reçetesi de yapıştır/değiştir rehberliğiyle değiştirildi.
  - `[high]` `[patch]` Aynı başlık sorunu, kenar-durum katmanından (aynı kök neden).
  - `[high]` `[patch]` Aynı başlık sorunu, üçüncü katmandan (aynı kök neden).
  - `[low]` `[patch]` `>> .env` her koşuda anahtarları çoğaltıyor — doğrulama katmanı `process.loadEnvFile`'ın son tekrarı aldığını kanıtladı, yani okuma doğru; sorun dosya düzeni. README reçetesiyle birlikte düzeltildi.
  - `[high]` `[patch]` `deployContract` son satırı alıp yalnızca `"C"` ile başlıyor mu diye bakıyordu; `Contract deployed` gibi bir satır `.env`'e kontrat id'si olarak yazılabilirdi. `parseContractId` saf fonksiyon olarak ayrıldı, tam `/^C[A-Z2-7]{55}$/` eşleşmesi isteniyor ve testleri var.
  - `[high]` `[patch]` Aynı ayrıştırma, doğrulama katmanından, mutasyonla kanıtlanmış (son satır → ilk satır 41 testi geçiyordu). Yama sonrası tekrar çalıştırdım: 2 test düşüyor. Tam-eşleşme → `startsWith("C")` mutasyonu da 1 test düşürüyor.
  - `[high]` `[patch]` Aynı ayrıştırmanın saf mantığının efektli fonksiyon içinde gömülü olması, intent-hizalama katmanından (aynı kök neden).
  - `[low]` `[patch]` Ortamdan yeniden kullanılan `ESCROW_CONTRACT_ID` doğrulanmıyordu; bayat ya da kırpılmış bir değer yeniden basılırdı. Aynı desene bağlandı.
  - `[high]` `[patch]` `detectStellarCli()` deploy kararından 50 satır önce koşulsuz çalışıyordu: CLI'ı olmayan makinede işi bitmiş bir koşu hiçbir `.env` satırı basmadan hata veriyordu — story'nin merkezî vaadinin tersi. Yalnızca gerçekten deploy eden dala taşındı.
  - `[high]` `[patch]` Aynı idempotentlik kırılması, iddia olarak (aynı kök neden).
  - `[medium]` `[patch]` `PACTLY_ADMIN_WALLETS` mevcut listeyi eziyordu; operatörün elle eklediği yöneticiler sessizce düşerdi. `unionAdminWallets` ile birleştiriliyor: tekrarsız, mevcut sıra korunarak.
  - `[medium]` `[patch]` Aynı ezme, kenar-durum katmanından (aynı kök neden).
  - `[medium]` `[patch]` Aynı ezme, doğrulama katmanından (aynı kök neden).
  - `[medium]` `[patch]` Fonlamadan sonra bir şey hata verirse üretilen sırlar hiç basılmıyordu: hesaplar zincirde fonlanmış, operatör onlara ulaşamıyor. Gövde `try/finally`'ye alındı; hangi yoldan çıkılırsa çıkılsın o ana kadar çözülmüş satırlar basılıyor.
  - `[medium]` `[patch]` Dört hata yolu sonraki adımı söylemiyordu (eksik `cargo`, TOML olmayan gövde, bozuk `PACTLY_DEMO_*_SECRET`, geçersiz issuer). Dördü de sarmalandı; `cargo` artık `stellar` gibi tespit edilip açıklanıyor.
  - `[medium]` `[patch]` Aynı dört yol, iddia olarak toplu bildirilmiş (aynı kök neden).
  - `[medium]` `[patch]` `cargo`/wasm hedefi tespit edilmiyordu (aynı kök neden, aynı rota).
  - `[low]` `[patch]` TOML olmayan gövde `smol-toml`'un kendi hatasını sızdırıyordu (aynı kök neden).
  - `[low]` `[patch]` Bozuk demo sırrı değişken adını söylemiyordu (aynı kök neden).
  - `[low]` `[patch]` Geçersiz issuer SDK'nın ham hatasını veriyordu (aynı kök neden); artık `StrKey` ile doğrulanıyor ve anchor adı anılıyor.
  - `[medium]` `[patch]` `addTrustline` `submitTransaction`'ı çıplak bekliyordu: Horizon reddi "status code 400" olarak görünüyor, `extras.result_codes` çöpe gidiyordu. Friendbot'un çevirisi paylaşıma açıldı, enjekte edilebilir seam ve testler eklendi.
  - `[medium]` `[patch]` Aynı trustline yolu, kenar-durum katmanından (aynı kök neden).
  - `[medium]` `[patch]` `loadAccountIfExists`/`addTrustline`'ın testsizliği, intent-hizalama katmanından (aynı kök neden).
  - `[medium]` `[patch]` `main()` hiçbir şey export etmediği için davranışının hiçbiri testten erişilemiyordu; üç mutasyon (admin ataması silinir, testnet koruması etkisiz, varlık kodu değişir) tüm suite'i geçiyordu. Saf parçalar dışa aktarıldı, `runSetupTestnet` seam'lerle sürülebilir hale geldi. **Not: spec'in "ağa dokunmayan mantık saf ve testli olsun" cümlesi hangi seviyeyi kastettiğini söylemiyordu; matrisin dokuz satırının yedisi komut hakkındaydı ama kısıt yaprak fonksiyonlar diye okunabiliyordu. Bu spec belirsizliğiydi, uygulama hatası değil.**
  - `[medium]` `[patch]` "Aynı `.env` satırları basılır" iddiasının hiç doğrulanmaması (aynı kök neden). Yama sonrası: admin atamasını silmek artık 1 test düşürüyor (kendim doğruladım).
  - `[medium]` `[patch]` Testnet korumasının testsizliği, mutasyonla kanıtlanmış (`if (false)` tüm suite'i geçiyordu). `assertTestnetPassphrase` ayrıldı; yama sonrası mutasyon 1 test düşürüyor.
  - `[medium]` `[patch]` `resolveAnchorUsdcAsset`'in fetch+çözümleme birleşiminin testsizliği, mutasyonla kanıtlanmış. `fetchImpl` iletiliyor; yama sonrası varlık kodu mutasyonu 1 test düşürüyor.
  - `[medium]` `[patch]` `main()`'in seam'lere ulaşmaması, intent-hizalama katmanından (aynı kök neden).
  - `[medium]` `[patch]` `shapeEnvLine`'ın kaçışları `process.loadEnvFile` tarafından yanlış okunuyordu — round-trip'te `He said "hi" \ bye` geri okunduğunda `He said \` oluyordu. Kök neden bulundu: `loadEnvFile` iki tırnak türünde de kaçış işlemiyor. Tek tırnağa geçildi ve kodlanamayan değerler reddediliyor; round-trip testi eklendi.
  - `[medium]` `[patch]` Aynı kaçış sorunu, kenar-durum katmanından (aynı kök neden).
  - `[low]` `[patch]` `fetchAnchorToml`'da zaman aşımı yoktu; yanıt vermeyen bir host komutu süresiz asardı. `AbortSignal.timeout(10s)` ve testi eklendi.
  - `[low]` `[patch]` Horizon friendbot'un gerisinde kalırsa ilk koşuda sahte "hesap yüklenemiyor" hatası. `loadAccountWithRetry` eklendi.
  - `[low]` `[patch]` `addTrustline` doğrulanmış passphrase yerine `Networks.TESTNET`'i yeniden sabitliyordu; artık doğrulanmış değer kullanılıyor.
  - `[low]` `[patch]` `tsconfig.json` `include: ["src"]` olduğu için testler typecheck edilmiyordu ve `tsx` tipleri kontrol etmeden siliyordu. `test/` dahil edildi; `decisions.test.ts`'teki denetlenmeyen `as` cast'i de kalktı.
  - `[low]` `[patch]` Aynı typecheck kapsamı, kenar-durum katmanından (aynı kök neden).
  - `[low]` `[patch]` Aynı typecheck kapsamı, doğrulama katmanından (aynı kök neden).
  - `[low]` `[patch]` Aynı typecheck kapsamı, intent-hizalama katmanından (aynı kök neden).
  - `[low]` `[patch]` `scripts/package.json`'daki `build` script'i kimsenin kullanmadığı bir `dist/` üretiyordu ve kök `npm run build` onu her seferinde çalıştırıyordu. Kaldırıldı; kök `build` `--if-present` aldı.
  - `[low]` `[patch]` `resolveUsdcAsset` kendisine verilen varlık kodunu döndürüyordu, eşleşen girdinin kendi alanını değil. Artık `match.code` dönüyor.
  - `[low]` `[patch]` Kök `README.md`'de üç yer bayattı ("Story 1.7 ile geliyor", CLI gelecek işi, `scripts/` seed data içeriyor). Üçü de güncellendi.
  - `[low]` `[patch]` `.env.example` yorumları komutun `.env`'i "yazdığını" söylüyordu; komut yalnızca basıyor. Düzeltildi.
  - `[low]` `[patch]` Spec artefaktının `in-progress` durumuyla commit'lenmesi — finalize adımında `done` yapıldı.
  - `[medium]` `[defer]` Ağ yollarının hiçbiri çalıştırılmadı; yüksek önemli düzeltmelerin üçü tam da orada yaşıyor. Bu story'nin en büyük doğrulanmamış riski, `deferred`'a yazıldı.
  - `[low]` `[defer]` Hiçbir test çıkış kodunu gözlemlemiyor — `main().catch` okunarak doğru, testle değil.
  - `[low]` `[defer]` Horizon ücret artışı (surge) yorumlanmıyor — demo ölçeğinde gerçekçi değil, ilk gerçek koşudan sonra değerlendirilmeli.
  - `[low]` `[defer]` Horizon 429/5xx yanıtları yorumlanmıyor (aynı kök neden, aynı rota).
  - `[low]` `[defer]` İki Story 1.2 testinin snapshot gürültüsü — bu story boyunca üç kez elle temizlendi, artık `contracts/` dışındaki story'leri de kirletiyor.
  - `[low]` `[reject]` Aynı sırrın iki role verilmesi profesyonel ile müşteriyi tek hesaba indirir — operatör hatası, gösterilmemiş bir duruma karşı koruma eklemek gerekirdi; olasılığı düşük.
  - `[low]` `[reject]` Admin hesabının trustline almaması — kasıtlı: admin AD-12'nin yetki rolü, depozito imzalamıyor. `TRUSTLINE_ROLES` bunu dışlıyor ve bir test bunu sabitliyor.
  - `[false]` `[reject]` `smol-toml`'un bağımlılık olarak eklenmesi sınır ihlali değil: spec eklemeyi yasaklamadı, paket zaten geçişli olarak vardı ve açıkça pinlenmesi bildirilmemiş geçişli bağımlılığa dayanmaktan iyi.
  - `[false]` `[reject]` "`package-lock.json` diff'te yok, bu haliyle kurulmaz" — bilinçli staging kararım: üretilmiş 27 KB'lık kilit dosyası reviewer'a bir şey söylemiyor, bağımlılık kararı `package.json`'da görünüyor ve o diff'te. Commit'e dahil.
  - `[false]` `[reject]` "Spec artefaktı yorumlayıcı iş yapıyor" — spec'in işi zaten bu; intent'i alıp uygulanabilir sınırlara çevirmek.

## Design Notes

- **Why the network paths cannot be verified here.** Funding, trustlines and deploy are irreversible outward actions against a live network, and the Stellar CLI is not installed on this machine. So the story is built and verified statically: the logic that decides *what* to do is pure and tested, the code that *performs* it is a thin wrapper, and running it is the operator's separate act. This is the reason the pure/effectful split is a constraint rather than a stylistic preference — it is the only thing that makes the story verifiable at all.
- **Idempotency is what makes a demo-day script trustworthy.** The failure mode this story exists to prevent is an operator running setup, hitting a half-applied state, and not knowing whether re-running is safe. Every step therefore answers "is this already done?" before acting, and says which branch it took.
- **The asset is discovered, not configured** (AD-10). Hard-coding the USDC issuer would make a second anchor a code change, and the anchor is mock infrastructure that can be redeployed with a new issuer at any time. `stellar.toml` is the only source.
- **Secrets are printed, never written.** The script prints `.env` lines and stops. Writing `.env` itself would risk overwriting keys an operator already placed there, and the repo's rule is that secrets live only in that gitignored file.

## Verification

**Commands:**
- `npm run -w scripts typecheck` (or `npx tsc --noEmit -p scripts`) -- expected: clean
- `npm run -w scripts test` -- expected: the pure helpers' tests all pass
- `npm run contracts:build` -- expected: unchanged, still a clean `wasm32v1-none` artifact

**Manual checks:**
- `git grep` for the anchor's issuer key and for `tr-mock-anchor` outside `.env.example` and the README: no issuer literal in source.
- `git status` after the run: no `.env` written, no secret in a tracked file.
- **Not run:** friendbot, trustline and deploy are never executed while building this story.

## Auto Run Result

Status: done

**Yapılan değişikliğin özeti.** Yeni `scripts` workspace'i ve tek komut: `npm run --silent setup:testnet`. Komut anchor'ın `stellar.toml`'undan USDC varlığını çözüyor (AD-10 gereği issuer ve kod sabit yazılmıyor), üç demo hesabını friendbot ile fonluyor, işlem yapan ikisine trustline ekliyor, kontratı derleyip Stellar CLI ile deploy ediyor ve sonucu `.env` satırları olarak **stdout'a basıyor** — ilerleme stderr'e gidiyor, böylece yönlendirme temiz kalıyor. Her adım önce "bu zaten yapılmış mı" diye soruyor.

**Değişen dosyalar.**
- `scripts/src/` — komut ve adımları; saf mantık (toml ayrıştırma, kararlar, `.env` satır biçimlendirme, kontrat id ayrıştırma, testnet önkoşulu, admin listesi birleştirme) ağ çağrılarından ayrı ve enjekte edilebilir seam'lerin arkasında.
- `scripts/test/` — 69 test, Node'un yerleşik koşucusuyla.
- `scripts/package.json`, `scripts/tsconfig.json` — `backend` konvansiyonu; `@stellar/stellar-sdk` 17.1.0 ve `smol-toml` 1.8.0.
- `package.json` (kök) — workspace girdisi, `setup:testnet`, ve `build`'e `--if-present`.
- `README.md`, `scripts/README.md`, `.env.example` — var olanı anlatacak şekilde güncellendi; üç yeni demo sır anahtarı boş değerle eklendi.

**Review bulguları.** 4 katman 55 bulgu bildirdi: high 12, medium 17, low 23, false 3. Katmanlar arası tekrar yoğundu; kök nedene göre gruplandığında **17 giriş yamandı** (4 high, 6 medium, 7 low), **5 madde ertelendi**, 5 bulgu çürütülerek reddedildi.

Dört yüksek önemli bulgunun hepsi "çalıştırılamayan yolda" olduğu için sessizce geçebilecek cinstendi: deploy sırrının argv'de ve hata mesajında görünmesi; belgelenen yönlendirmenin npm başlığıyla `.env`'i bozması; kontrat id'sinin yalnızca `"C"` ile başlamasına bakılması; ve CLI kontrolünün koşulsuz çalışıp idempotent yeniden koşuyu kırması.

Doğrulama katmanı beş açığı mutasyonla kanıtladı. **Beşini de yama sonrası kendim tekrar çalıştırdım**: son satır → ilk satır (2 test düşüyor), tam eşleşme → `startsWith` (1), testnet koruması etkisiz (1), varlık kodu değişir (1), admin ataması silinir (1). İlk denememde `.pop()` → `.shift()` çevirisi yapmıştım ama kod `.at(-1)` kullanıyor; sed hiçbir şeyi değiştirmemiş ve sahte bir "hayatta kaldı" sonucu vermişti — doğru mutasyonla tekrarladım.

**Reddedilen bulgular ve gerekçeleri.**
- Aynı sırrın iki role verilmesi — operatör hatası; gösterilmemiş bir duruma karşı koruma eklemek gerekirdi.
- Admin hesabının trustline almaması — kasıtlı, AD-12'nin yetki rolü depozito imzalamıyor, bir test bunu sabitliyor.
- `smol-toml` eklenmesi — spec eklemeyi yasaklamadı, paket zaten geçişliydi, açık pin daha sağlam.
- `package-lock.json`'ın review diff'inde olmaması — bilinçli staging kararım; bağımlılık kararı `package.json`'da görünüyor ve commit'e dahil.
- "Spec yorumlayıcı iş yapıyor" — spec'in işi zaten intent'i uygulanabilir sınırlara çevirmek.

**Takip review önerisi:** `true`. Dört `high` giriş yamandı. Adlandırılmış doğrulanmamış risk: yamaların üçü (sırrın ortam değişkeniyle geçirilmesi, kontrat id doğrulaması, CLI kontrolünün konumu) **hiç çalıştırılmamış ağ yolunda** yaşıyor; sahte seam'ler ve okuma dışında kanıt yok. İlk gerçek koşu bu üçünü birden sınayacak.

**Yapılan doğrulama.**
- `npm run -w scripts typecheck` → temiz, artık `test/` dahil.
- `npm test` → 62 Rust + 2 backend + 69 scripts, hepsi geçti.
- `npm run build` → backend ve frontend derleniyor, `scripts` atlanıyor.
- Beş mutasyonun beşi de yakalanıyor (yukarıda).
- `git status`: `contracts/`, `backend/`, `frontend/` ve `.env` dokunulmadı. Ağa hiçbir çağrı yapılmadı, Stellar CLI kurulmadı.

**Kalan riskler.** En büyüğü ertelenenlerin ilki: fonlama, trustline ve deploy hiç çalıştırılmadı. Bunlar geri alınamaz dış eylemler ve ilk gerçek koşu operatörün bilinçli kararı — ama o koşuya kadar bu yolların doğruluğu yalnızca okumaya dayanıyor. İkincisi: hiçbir test çıkış kodunu gözlemlemiyor, matrisin "sıfırdan farklı çıkış" vaadi atılan hatanın tipiyle doğrulanıyor.
