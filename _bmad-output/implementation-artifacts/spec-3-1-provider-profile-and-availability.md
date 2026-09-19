---
title: 'Story 3.1 — Provider profile and availability'
type: 'feature'
created: '2026-09-19'
status: 'done'
review_loop_iteration: 0
baseline_revision: '779060a6d1ed32ebdcc34df0233f61e9e49dedd0'
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-Pactly-2026-09-15/DESIGN.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** A professional cannot set a price, deposit rate, cancellation window or bookable hours anywhere, and a client cannot see a provider at all. The backend has `provider_profiles` rows but no availability model and no HTTP route, and the frontend is an empty Vite placeholder. Nothing in the product can be opened in a browser and tried.

**Approach:** Add an `availability_slots` table (architecture ERD: `PROVIDER_PROFILE ||--o{ AVAILABILITY_SLOT`) and the display fields a card needs. Expose public read routes and wallet-authenticated provider write routes. Lay down the frontend foundation that every later Epic 3 story builds on: DESIGN.md tokens, router, API client, Stellar Wallets Kit sign-in. On that foundation, build two screens: a public provider profile and the provider's "Availability & rules" panel. A demo seed script makes both screens testable immediately.

## Boundaries & Constraints

**Always:**
- Amounts are integer strings in USDC smallest units (7 decimals, AD-7) end to end. The API returns money as `{ amount: "…", asset: "USDC" }`. The frontend formats with BigInt and `tabular-nums`, and never uses floats. The deposit is `floor(price × depositRateBps / 10000)`, computed once in `services/profile.ts` and returned by the API. The frontend never recomputes it.
- The deposit amount and the free-cancellation window always appear together, wherever a deposit is shown (the deposit pill).
- Public routes (`GET /categories`, `GET /providers/:id`) need no auth and return approved profiles only. An unapproved or unknown id gives `404 PROVIDER_NOT_FOUND`.
- Provider write routes use `requirePactlyAuth`. The caller's wallet must own a `provider_profiles` row, otherwise `404 NOT_A_PROVIDER`. A provider may edit their own profile before approval, and it stays off public routes until approved.
- Errors use the `{ code, message, details? }` envelope (AD-11), with stable SCREAMING_SNAKE codes.
- Slots are UTC epoch seconds, each lasting `sessionLengthMinutes`. The frontend shows them in the viewer's local time with an explicit day label.
- A new column on an existing table is added through the PRAGMA-guarded `ALTER TABLE` pattern Story 2.6 introduced in `migrations.ts`, never only in `CREATE TABLE`.
- UI follows DESIGN.md: deep teal (`pro`) marks the provider's identity and is never interactive. Mustard (`you`) marks what the client can act on. Black is reserved for the escrow/deposit pill. Text always accompanies colour. Touch targets are at least 44px, the focus ring is visible, and open slot chips are keyboard reachable. Copy follows EXPERIENCE.md's voice (second person, no implementation vocabulary).

**Never:**
- No booking, hold, payment or escrow call. Slots are only published here, and Story 3.4 holds and consumes them.
- No discovery list, search or filters (Stories 3.2 and 3.3). No provider application or admin approval (Epic 4).
- No fiat conversion. The SEP-38 quote belongs to Story 2.2, so amounts show as USDC.
- Nothing in `backend/src/chain/` or `backend/src/escrow/` changes.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Public profile | `GET /providers/:id` for an approved profile | Name, title, category, location, format, length, price, deposit (computed), depositRateBps, cancellationWindowHours, verifiedSessionCount, approved flag, future slots for the next 30 days ascending | No error expected |
| Hidden profile | Unapproved or unknown id | Nothing leaks | `404 PROVIDER_NOT_FOUND` |
| Past slots | A profile with slots in the past | Only slots starting after now are returned | No error expected |
| Own profile | `GET /me/provider` with a valid JWT for a provider wallet | Own profile, including when unapproved, plus all future slots | Not a provider: `404 NOT_A_PROVIDER`; no or expired token: `401` |
| Save rules | `PUT /me/provider/rules` `{priceAmount, depositRateBps, cancellationWindowHours}` | Saved; response is the updated own profile with the recomputed deposit | No error expected |
| Invalid rules | Price not a positive integer string; bps outside 1–10000; window outside 0–720 h | Nothing saved | `400 INVALID_RULES` with `details` naming each bad field |
| Deposit rounds to zero | Price × bps floors to 0 | Nothing saved | `400 INVALID_RULES` (the deposit must be positive) |
| Save availability | `PUT /me/provider/availability` `{slots: number[]}` | Replaces all of the provider's future slots with this set (deduplicated, sorted); past slots untouched | No error expected |
| Invalid slots | A slot in the past, more than 60 days ahead, not on a 15-minute boundary, overlapping another within `sessionLengthMinutes`, or more than 500 slots | Nothing saved | `400 INVALID_SLOTS` with the offending values in `details` |
| Categories | `GET /categories` | All categories `{id, name, slug}` | No error expected |
| Existing database | A `provider_profiles` table created before this story | New columns added by migration; existing rows keep working | No error expected |
| Slot pre-selection | Profile page opened with `?slot=<epochSeconds>` matching an open slot | That slot shows as selected | Unknown slot value: ignored, nothing selected |

</intent-contract>

## Code Map

- `backend/src/app.ts` -- `createApp(db)`, `requirePactlyAuth` (sets `walletAddress`), and `app.onError`'s `{code, message}` backstop. New routes go here or in a `routes/` module that `createApp` registers. Mirror the existing handlers' typed-error-to-envelope style.
- `backend/src/db/schema.ts` -- `providerProfiles` (no name, title or location yet), `categories`. Add `displayName`, `title`, `location` (text, NOT NULL default `''`) and a new `availabilitySlots` table (`id`, `providerProfileId` FK, `startsAt` integer epoch seconds, `createdAt`; unique `(providerProfileId, startsAt)`).
- `backend/src/db/migrations.ts` -- the `STATEMENTS` DDL list plus Story 2.6's `hasColumn()` PRAGMA guard and `ALTER TABLE`. Reuse that pattern for the three profile columns, and add the `availability_slots` CREATE.
- `backend/src/db/providerProfiles.ts`, `backend/src/services/profile.ts` -- existing insert, get and list-approved functions. Extend them with the new fields and an update-rules function. Put `computeDepositAmount(priceAmount, depositRateBps)` in the service (BigInt).
- `backend/src/db/categories.ts` -- `listCategories` already exists.
- `backend/test/app.test.ts`, `backend/test/helpers.ts` -- how route tests drive `app.request(...)` with an in-memory DB and how a JWT is issued in tests. Follow the same pattern for the new routes. `backend/test/db.test.ts` has the pre-existing-schema migration test pattern from Story 2.6.
- `backend/src/auth/challenge.ts` -- `POST /auth/challenge` / `POST /auth/verify` return `{transaction}` / `{token, walletAddress}`. The frontend wallet module signs the challenge XDR with the connected wallet.
- `frontend/` -- React 19 + Vite 8 placeholder (`src/App.tsx`, `src/main.tsx`); no router, data layer or styles yet. `vite.config.ts` needs a dev proxy `/api` → `http://localhost:<backend port from config.ts>` with the `/api` prefix stripped, so the browser never hits CORS.
- `_bmad-output/planning-artifacts/ux-designs/ux-Pactly-2026-09-15/DESIGN.md` -- tokens in frontmatter (colors, typography with Darker Grotesque / Familjen Grotesk / Martian Mono, spacing, rounded) plus the Components section (deposit pill, slot chip, provider identity). `mockups/discover-v2-marketplace.html` is the composition reference for the provider header and slot chips. DESIGN.md wins on conflict.
- `scripts/` -- the workspace for dev scripts (`npm run … -w scripts`). The demo seed goes here or in `backend` as `npm run -w backend seed:demo`, reusing backend's db functions.

## Tasks & Acceptance

**Execution:**
- `backend/src/db/schema.ts`, `migrations.ts` -- the new profile columns (via guarded ALTER) and the `availability_slots` table.
- `backend/src/db/availabilitySlots.ts` -- list future slots for a profile within a window, and replace future slots atomically (one transaction: delete future rows, insert the new set).
- `backend/src/db/providerProfiles.ts`, `backend/src/services/profile.ts` -- the new fields, `updateProviderRules`, `computeDepositAmount`, validation for rules and slots (the matrix's bounds), and a public profile view builder shared by both GET routes.
- `backend/src/app.ts` (or `backend/src/routes/providers.ts`) -- the five routes in the matrix.
- `backend/src/seed/demo.ts` + `backend/package.json` script `seed:demo` -- idempotent. It upserts the four approved categories (therapy and wellbeing, education and lessons, consulting, fitness and beauty) and at least 6 approved sample providers across at least 2 categories, with names, titles, Istanbul locations, prices, rates, windows and slots over the next 7 days. The hero is a hair-transplant clinic consult with a large deposit. `SEED_PROVIDER_WALLET=G…` also creates (or updates) an approved profile owned by that wallet, so a tester can open the panel with their own wallet.
- `backend/test/` -- route and service tests for every matrix row, plus the migration test for the new columns.
- `frontend/package.json` -- add pinned exact versions of `react-router`, `@tanstack/react-query` and `@creit.tech/stellar-wallets-kit`.
- `frontend/index.html`, `frontend/src/styles/tokens.css`, `frontend/src/styles/base.css` -- DESIGN.md tokens as CSS custom properties, the three Google Fonts with fallbacks, the focus ring, and `tabular-nums` for money and time.
- `frontend/src/api/` -- typed fetch client for `/api/*` that surfaces the error envelope, plus TanStack Query hooks.
- `frontend/src/wallet/` -- Stellar Wallets Kit wrapper: connect, sign the `/auth/challenge` XDR, `POST /auth/verify`, keep the JWT in sessionStorage, sign out.
- `frontend/src/lib/money.ts`, `frontend/src/lib/time.ts` -- BigInt smallest-unit → `1,234.50 USDC` formatting, and local slot/day labels.
- `frontend/src/components/` -- `DepositPill` (amount + free-cancellation window, black), `SlotChip` (open, selected), `ProviderHeader` (teal identity block, approved badge, verified count).
- `frontend/src/pages/provider/ProviderProfilePage.tsx` -- route `/providers/:id`: header, price, format/length, deposit pill, slots grouped by day, `?slot=` pre-selection. Loading and 404 states use the voice guide.
- `frontend/src/pages/panel/AvailabilityPage.tsx` -- route `/panel/availability`:
  - sign in with a wallet; a wallet that owns no provider profile sees a plain explanation;
  - rules form with a live deposit preview that the server confirms on save;
  - a 14-day × 08:00–20:00 grid that toggles slots in session-length steps and saves;
  - "View public profile" link;
  - inline field errors from `details`.
- `frontend/src/App.tsx`, `main.tsx` -- router, QueryClientProvider, a minimal top bar (Pactly, "Escrow powered by Trustless Work · Stellar"), and a temporary home linking to the seeded providers until Story 3.2 replaces it.
- `README.md` -- a short "Try it locally" section: `npm run -w backend seed:demo`, `npm run dev`, the two URLs.

**Acceptance Criteria:**
- Given the seeded database and `npm run dev`, when a visitor opens `/providers/<id>` without a wallet, then they see the provider's name, title, price, deposit pill (amount + window) and upcoming slots grouped by day.
- Given a wallet seeded via `SEED_PROVIDER_WALLET`, when that provider signs in on `/panel/availability`, changes price, deposit rate and window, marks slots and saves, then reloading their public profile shows the new values and slots (PRD 3.1 AC1–AC3).
- Given the backend workspace, when `typecheck`, `test` and `build` run, then all are clean and every matrix row has a passing test. Given the frontend workspace, when `typecheck` and `build` run, then both are clean.

## Spec Change Log

### 2026-09-19 — Takvim adımı (kullanıcının devrettiği yetki)
- **Tetikleyen:** E6. Panel takvimi oturum uzunluğu yerine 15 dakikalık hücrelerle çalışıyor.
- **Karar:** 15 dakikalık hücre korunuyor. Backend her slotun 15 dakikalık sınırda başlamasını zorunlu tutuyor, 50 dakikalık gibi oturum uzunlukları bu sınıra bölünmüyor. Takvim çakışmaya duyarlı işaretleme yaptığı için oturum uzunluğu yine uygulanıyor.
- **Kaçınılan kötü durum:** Oturum uzunluğu adımlarının backend'in 15 dakika kuralıyla çelişip kaydedilemeyen slotlar üretmesi.

## Review Triage Log

### 2026-09-19 — Review pass (2 katman, Sonnet: Edge Case Hunter + Verification Gap)
- verdicts: 9 bulgu — high 0, medium 2, low 5, false 2, maybe-false 0
- findings:
  - `[low]` `[patch]` V1 `updateProviderProfileRules` yorumu tek yazıcı olduğunu söylüyor, seed script de yazıyor — yorum düzeltildi.
  - `[medium]` `[patch]` E1 Bir form kaydedilince yeniden çekilen veri diğer formun kaydedilmemiş değişikliklerini siliyor — yerel durum yalnızca ilk yüklemede veya profil değişince tohumlanıyor.
  - `[low]` `[reject]` E2 Sekme uzun süre açık kalırsa geçmiş hücre seçilebilir kalıyor — kayıt hatası geçersiz değerleri listeliyor; periyodik yeniden hesaplama karmaşıklık katar, nadir.
  - `[medium]` `[patch]` E3 Ağ hatası veya süresi dolan oturumda kayıt hatası hiç gösterilmiyor — genel hata bandı.
  - `[low]` `[reject]` E4 `.env`'deki BACKEND_PORT tırnaklıysa proxy 3001'e düşer — `.env.example` tırnaksız, günlük kullanımda karşılaşılmaz.
  - `[false]` `[reject]` E5 Profil satırı silinirse 500 — `backend/src` içinde profil silen yol yok.
  - `[low]` `[reject]` E6 Takvim oturum uzunluğu adımlarıyla değil 15 dakikayla çalışıyor — bilinçli sapma, Spec Change Log'da.
  - `[false]` `[reject]` E7 `index.html`'e dokunulmamış, fontlar eksik — fontlar `frontend/src/styles/base.css`'te `@import` ile yükleniyor.
  - `[low]` `[patch]` E8 `GET /me/provider` için süresi dolmuş token testi yok — test eklendi.

## Design Notes

- **Why concrete slots, not weekly rules.** The architecture ERD names `AVAILABILITY_SLOT`, and Story 3.4 must hold and consume exactly one slot. A concrete row can be held; a rule cannot. The panel grid keeps marking hours quick.
- **Why replace-all-future on save.** No booking references a slot yet (3.4 adds that), so replacing future slots is safe and keeps the API to one idempotent call. Story 3.4 must change this to preserve held and booked slots. That is recorded here so 3.4's planner sees it.
- **Why a seed script now.** The user wants to test in a browser for the hackathon. Without seeded providers and a way to own one, neither screen can be exercised. PRD 3.8 AC6 needs the same data later.
- **No frontend test runner.** Epic 3 context accepts manual verification for the frontend. Money math lives in the backend (deposit) and in one BigInt formatter, which stays small.

## Verification

**Commands:**
- `npm run -w backend typecheck && npm run -w backend test && npm run -w backend build` -- expected: clean, all pass
- `npm run -w frontend typecheck && npm run -w frontend build` -- expected: clean
- `npm test` (root) -- expected: all pass

**Manual checks:**
- `npm run -w backend seed:demo` twice → no duplicates. Then `npm run dev`, open the home page → provider links → a profile shows the deposit pill and slot chips. Tab reaches every open slot chip with a visible focus ring.
- `curl localhost:<port>/providers/<unapproved-id>` → `404 PROVIDER_NOT_FOUND`.

## Auto Run Result

Status: done

**Özet:** Sağlayıcı profiline isim, ünvan ve konum alanları eklendi (mevcut veritabanları için korumalı ALTER ile). Yeni `availability_slots` tablosu kuruldu. Herkese açık `GET /categories` ve `GET /providers/:id` route'ları, cüzdanla giriş gerektiren `GET /me/provider`, `PUT /me/provider/rules` ve `PUT /me/provider/availability` route'ları eklendi. Idempotent `seed:demo` script'i yazıldı. Frontend temeli kuruldu: DESIGN.md token'ları, router, TanStack Query, `/api` proxy'si ve Stellar Wallets Kit ile giriş. Herkese açık profil sayfası ve sağlayıcının "Availability & rules" paneli hazır.

**Commit'ler:** `779060a` spec, `a25521d` feat, fix(3.1), chore(3.1).

**Review:** 9 bulgu (medium 2, low 5, false 2). Patch: E1, E3 (medium), E8, V1 (low). Reddedilenler: E2, E4, E6 (low, gerekçeleri triage kaydında), E5, E7 (false). Takip review önerisi: false.

**Doğrulama:** backend typecheck ve build temiz, test 225/225; frontend typecheck ve build temiz. Ajan route'ları ve gerçek bir imza/giriş döngüsünü çalışan bir backend üzerinde denedi. Tarayıcıda etkileşimli QA yapılmadı.

**Kalan riskler:** Frontend'de test runner yok. Takvim, izleyicinin UTC farkının 15 dakikanın katı olduğunu varsayıyor (UTC+5:45 gibi bölgelerde hücreler kayabilir). Story 3.4, availability kaydının "gelecekteki tüm slotları değiştir" davranışını dolu veya tutulan slotları koruyacak şekilde değiştirmeli (3.4 spec'inde yazılı).
