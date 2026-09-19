---
title: 'Story 3.8 — Demo preparation and documentation'
type: 'chore'
created: '2026-09-20'
status: 'done'
review_loop_iteration: 0
baseline_revision: 'dff079fe9211f0bad19ac69f17b482a82b019d02'
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-Pactly-2026-09-15/EXPERIENCE.md'
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** Epic 3's screens exist, but nothing tells a newcomer what Pactly is, how to run it, or how to show it in five minutes. The README still describes the pre-pivot design, and no single page states which parts are real and which are not yet built.

**Approach:** Rewrite the README around the product as it now stands, with an architecture diagram, an honest capability table, a step-by-step demo script and a one-command demo setup. Add a `demo:reset` script so a rehearsal can start from a clean, seeded state.

## Boundaries & Constraints

**Always:**
- The README covers, in this order: what Pactly is (one paragraph), the demo scenario, prerequisites, install and run, the demo script, an architecture summary with a mermaid diagram, what is and is not built, and the BMAD skill files used with their paths (PRD 3.8 AC1–AC4).
- Every claim is checked against the code at the time of writing. Nothing is described as working unless it is. Specifically, and in the README's own words:
  - the escrow runs on Trustless Work, not the custom Soroban contract (`contracts/escrow/` is kept as a record of the pre-pivot design and is not deployed);
  - paying or cashing out in local currency (SEP-6, Stories 2.2–2.4) is not built, and the demo pays in USDC;
  - Story 1.8's live Trustless Work checks have not been run against a real operator key, so the first live lock is unproven;
  - the provider application and admin approval queue (Epic 4) are not built, so demo providers are seeded pre-approved.
- The demo script is written as numbered steps a presenter can follow in five minutes, naming the URL and the wallet for each step: discover → provider → hold → Lock with Pactly → My bookings → complete → approve → release → resolution, with the wallets each step signs with.
- Wallet and network prerequisites are explicit: Freighter on testnet, XLM for fees, the anchor's USDC trustline and balance, `npm run setup:testnet`, and the four Trustless Work variables (noting that `TRUSTLESS_WORK_API_URL` must be whichever host the operator's key belongs to).
- `npm run demo:reset` reseeds a clean demo database (delete the sqlite file, run migrations, run `seed:demo`), and prints the seeded provider links and the wallets it expects.
- The mermaid diagram shows the real runtime: browser (React) → backend (Hono, SQLite) → Trustless Work API and Soroban RPC → Stellar testnet, plus the anchor for SEP-1/10 and the reconciler loop.

**Never:**
- No new product feature, route or UI. This story only documents and scripts what exists.
- No claim of a completed testnet lock, release or cash-out until one has actually run. PRD 3.8 AC5 stays open, and the README says so plainly.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Reset | `npm run demo:reset` on a dirty database | A fresh database, migrations, seed data, and printed provider links | A missing database file is not an error |
| Reset twice | Run it again | Same result, no duplicates | No error expected |
| Seeded links | After a reset | Every printed provider URL resolves to a real profile with open slots | No error expected |
| Missing config | Trustless Work variables empty | The script still seeds and says which steps will not work | Never a stack trace |

</intent-contract>

## Code Map

- `README.md` -- currently pre-pivot (custom Soroban escrow). Rewrite.
- `backend/src/seed/demo.ts` (3.1, extended in 3.6) -- the seed and its `SEED_PROVIDER_WALLET` / `SEED_ADMIN_WALLET` inputs; reuse rather than duplicating.
- `backend/package.json`, root `package.json` -- where `seed:demo`, `dev` and `setup:testnet` live; add `demo:reset`.
- `.env.example` -- the variable list the prerequisites section must match exactly.
- `_bmad-output/implementation-artifacts/spec-*.md` and `sprint-status.yaml` -- the source of truth for what is built; the capability table must match them.
- `.claude/skills/` and `_bmad/` -- the skill files and paths AC3 asks for.

## Tasks & Acceptance

**Execution:**
- `README.md` -- the rewrite described above.
- `backend/src/seed/reset.ts` + `demo:reset` script (root and backend) -- reset, migrate, seed, print.
- `backend/test/` -- a test that the reset path recreates a usable database and is idempotent.

**Acceptance Criteria:**
- Given a fresh clone and a filled `.env`, when a reader follows the README's install and run steps, then the app runs and the demo script's first four steps work without any further explanation.
- Given the README's capability table, when it is compared with `sprint-status.yaml`, then every "built" row has a `done` story and nothing unbuilt is described as working.
- Given the backend workspace, when `typecheck`, `test` and `build` run, then all are clean.

## Verification

**Commands:**
- `npm run -w backend typecheck && npm run -w backend test && npm run -w backend build` -- expected: clean, all pass
- `npm run demo:reset` twice -- expected: the same seeded state, no duplicates

**Manual checks:**
- Follow the README from the top on the current checkout; every command named exists and runs.

## Review Triage Log

### 2026-09-20 — Review pass (2 katman, Sonnet)
- verdicts: 9 bulgu — high 0, medium 5, low 4, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` E5 README'de 3.6 "in review" diyor, oysa spec ve sprint-status `done`.
  - `[medium]` `[patch]` (kapsam eki) 3.7 "yok" diyordu; artık tamam, tabloya ve demo senaryosuna eklendi.
  - `[medium]` `[patch]` E6/VG-O1 "dört değişken her escrow işlemini engeller" iddiası yanlış — hangi değişkenin neyi engellediği tabloya yazıldı.
  - `[medium]` `[patch]` E7 Rust "yalnızca kontrata dokunursan" deniyordu; `setup:testnet` boş `ESCROW_CONTRACT_ID` ile cargo çalıştırıyor — düzeltildi, atlama yolu eklendi.
  - `[medium]` `[patch]` E8 Örnek `demo:reset` çıktısı gerçek çıktıyla uyuşmuyordu — gerçek koşudan alındı.
  - `[low]` `[patch]` E2 Dizin ya da izin hatasında `rmSync` ham stack trace basıyordu — düz mesaj.
  - `[low]` `[patch]` E3 CLI giriş kontrolü elle kurulan `file://` karşılaştırmasıydı; boşluklu yolda hiç çalışmıyordu — `fileURLToPath`.
  - `[low]` `[patch]` E1 Çalışan bir backend varken reset sonrası veri görünmüyor — hem çıktıya hem README'ye yeniden başlatma uyarısı.
  - `[low]` `[patch]` E4 Testler ortamdaki `SEED_*` değişkenlerine bağımlıydı — testte temizleniyor.

## Auto Run Result

Status: done

**Özet:** README ürünün bugünkü hâline göre yeniden yazıldı: ne olduğu, demo senaryosu, ön koşullar, kurulum, yedi adımlık demo betiği, mermaid mimari diyagramı, dürüst "yapıldı / yapılmadı" tablosu ve kullanılan BMAD skill yolları. `npm run demo:reset` veritabanını sıfırlayıp yeniden seed ediyor ve sağlayıcı linklerini yazıyor.

**Commit'ler:** `7215ff2` spec, `8d71e99` feat, `4c38fdb` fix, chore(3.8).

**Review:** 9 bulgu (medium 5, low 4), hepsi patch edildi. Takip review önerisi: false.

**Doğrulama:** backend typecheck ve build temiz, test 448/448; `demo:reset` iki kez çalıştırıldı, aynı sonuç.

**Kalan riskler:** PRD 3.8 AC5 (canlı testnet'te uçtan uca kilitle → serbest bırak → nakde çevir) hâlâ açık; README bunu açıkça yazıyor. Nakde çevirme SEP-6'ya (Story 2.3) bağlı.
