---
title: 'Story 3.2 — Discovery page and categories'
type: 'feature'
created: '2026-09-19'
status: 'done'
review_loop_iteration: 0
baseline_revision: 'a2f5f7d7aeafb2155446c4224e21ac4382869d0d'
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-3-1-provider-profile-and-availability.md'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-Pactly-2026-09-15/DESIGN.md'
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** After Story 3.1, a provider can be reached only by a direct link. There is no marketplace to browse, so the hero scenario ("she opens Discover") cannot start. EXPERIENCE.md marks the Discover list as non-negotiable for the demo.

**Approach:** Add a public list route that returns approved providers as card data, and extend `GET /categories` with approved-provider counts. Replace 3.1's temporary home with the Discover page, following the Discover v2 composition: category tabs, provider cards with the deposit pill and three earliest slots, and skeletons on first load. Everything is built on 3.1's frontend foundation and components.

## Boundaries & Constraints

**Always:**
- No sign-in anywhere on this page (PRD 3.2 AC6).
- Only approved providers are listed and counted (AC1). This is enforced in the backend list query, never by filtering in the frontend.
- Card content per PRD 3.2 AC3 and DESIGN.md's provider card, in this order:
  - monogram tile with the teal APPROVED badge;
  - name;
  - title, session format and length;
  - badge row: verified sessions, plus the provider's cancellation count stated plainly and never styled as an alarm;
  - location;
  - session price;
  - deposit pill (amount + free-cancellation window, reusing 3.1's `DepositPill`);
  - up to three earliest open slots (reusing `SlotChip`).
- There is no photo field. The photo slot shows the provider's initials on the teal ground, and photo upload stays post-MVP.
- The whole card links to `/providers/:id`. A slot chip links to `/providers/:id?slot=<epochSeconds>` (AC4), and its click must not also trigger the card link.
- Category selection lives in the URL (`/?category=<slug>`), and the back and forward buttons restore it (AC2). An unknown slug shows the "all" list with no error.
- Sort order is soonest open slot ascending (the Discover v2 default). Providers with no open slot come last, and ties break by name.
- Money is shown with the same BigInt formatter, `tabular-nums` and the `USDC` code as in 3.1.
- Six card skeletons match the real card layout on first load (AC5). They follow `prefers-reduced-motion`.
- Layout: from 1024px up, the category list sits in the left rail and the cards in a two-column grid. Below that, category tabs scroll horizontally above a single column. Touch targets are at least 44px and the focus ring is visible.

**Never:**
- No search box behaviour, autocomplete or filter controls (Story 3.3). The rail may show only the category list.
- No booking or hold, and no wallet prompt.
- No changes to `backend/src/chain/` or `backend/src/escrow/`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| List all | `GET /providers` | Approved providers as card objects: id, displayName, title, category `{slug, name}`, location, sessionFormat, sessionLengthMinutes, price, deposit, cancellationWindowHours, verifiedSessionCount, providerCancellationCount, `earliestSlots` (≤3 future, ascending). Sorted by the soonest slot, slotless last | No error expected |
| List by category | `GET /providers?category=<slug>` | Only that category's approved providers | Unknown slug: `200` with an empty list |
| Unapproved hidden | An unapproved profile with slots | Absent from the list and from the counts | No error expected |
| Category counts | `GET /categories` | Each category with `providerCount` = approved providers in it | No error expected |
| Past slots | A provider whose slots are all in the past | `earliestSlots: []`; the provider is listed last | No error expected |
| URL state | Select a category, then press back | The URL goes from `?category=x` back to `/`, and tabs and list follow | No error expected |
| Slot click | Tap a card's slot chip | The profile opens with that slot selected (3.1's `?slot=` handling) | No error expected |
| Empty category | A category with no approved provider | A plain message plus a link to see all providers, never a blank area | No error expected |
| Backend down | The list request fails | The voice-guide message ("Connection dropped.") with a retry | No raw error text |

</intent-contract>

## Code Map

- Story 3.1's spec and output are the foundation. Reuse its public profile view builder in `backend/src/services/profile.ts`, `computeDepositAmount`, `listApprovedProviderProfiles`, and the availability slot queries in `backend/src/db/availabilitySlots.ts`. Reuse `DepositPill`, `SlotChip`, `ProviderHeader` pieces, the `frontend/src/api/` hooks, `lib/money.ts`, `lib/time.ts`, and the router in `frontend/src/App.tsx`. Read those files as 3.1 left them before writing anything.
- `backend/src/app.ts` (or 3.1's routes module) -- add `GET /providers` and extend `GET /categories`. Earliest slots for many providers come from one query (for example a window-function or per-provider LIMIT subquery, or one ordered query grouped in code), not one query per provider.
- `_bmad-output/planning-artifacts/ux-designs/ux-Pactly-2026-09-15/mockups/discover-v2-marketplace.html` -- composition reference: the left category rail with counts, cards with the photo column and badge, the deposit line, and the slot chips row. Ignore its search box, filter sections, neighbourhood and price controls (Story 3.3). DESIGN.md and EXPERIENCE.md win on conflict.
- `backend/src/seed/demo.ts` (3.1) -- already seeds ≥6 approved providers across ≥2 categories. Extend it only if a card field has no seeded value.

## Tasks & Acceptance

**Execution:**
- `backend/src/services/profile.ts`, `backend/src/db/*` -- the card list builder and the category counts, with the earliest-slots query.
- `backend/src/app.ts` / routes module -- `GET /providers[?category=]` and `providerCount` on `GET /categories`.
- `backend/test/` -- a test for every matrix row that touches the backend.
- `frontend/src/pages/discover/DiscoverPage.tsx` -- route `/`: category rail or tabs from the URL, the card grid, skeletons, the empty and error states.
- `frontend/src/components/ProviderCard.tsx`, `ProviderCardSkeleton.tsx`, `CategoryTabs.tsx` -- per DESIGN.md.
- `frontend/src/App.tsx` -- `/` renders Discover (the 3.1 temporary home is removed) and the top-bar logo links to `/`.

**Acceptance Criteria:**
- Given the seeded database and `npm run dev`, when a visitor opens `/` without a wallet, then approved providers appear as cards with the deposit pill and up to three slot chips, and six skeletons show while loading.
- Given the Discover page, when the visitor picks a category and then presses back, then the URL, the selected tab and the list all return to the previous state.
- Given the backend workspace, when `typecheck`, `test` and `build` run, then all are clean. Given the frontend workspace, when `typecheck` and `build` run, then both are clean.

## Spec Change Log

## Review Triage Log

### 2026-09-19 — Review pass (2 katman, Sonnet: Verification Gap + Edge Case Hunter)
- verdicts: 7 bulgu — high 0, medium 3, low 4, false 0, maybe-false 0
- findings:
  - `[low]` `[patch]` V1 Aynı en erken slota sahip iki sağlayıcının isim sıralaması testsiz — test eklendi.
  - `[medium]` `[patch]` V2 Kategoriler yüklenmeden `?category=` doğrulanıyor, önce filtresiz liste görünüyor (= E3).
  - `[low]` `[reject]` E1 `limit` 0 verilirse ilk slot yine tutuluyor — tek çağıran 3 geçiyor, günlük kullanımda oluşmaz.
  - `[medium]` `[patch]` E2 `/categories` hata verirse kenar çubuğu sessizce "All providers (0)" gösteriyor — tekrar dene butonlu hata bandı.
  - `[medium]` `[patch]` E3 = V2 — kategoriler yüklenene kadar sorgu bekletiliyor, iskelet gösteriliyor.
  - `[low]` `[patch]` E4 "All" seçimi diğer URL parametrelerini siliyor — yalnızca `category` siliniyor.
  - `[low]` `[patch]` E5 Nokta ile biten her kelime atlanıyor, monogram yanlış ya da boş — yalnızca baştaki ünvan atlanıyor, boş kalırsa ismin ilk harfi.

## Design Notes

- **Why the backend sorts.** "Soonest open slot" needs every provider's earliest slot. The backend already has it, and sorting there keeps the order identical for Story 3.3's filtered lists.
- **Why a monogram and not a stock photo.** DESIGN.md's card has a photo column, but no profile has a photo and badges "cannot be invented". Initials on teal keep the layout honest without faking an image.

## Verification

**Commands:**
- `npm run -w backend typecheck && npm run -w backend test && npm run -w backend build` -- expected: clean, all pass
- `npm run -w frontend typecheck && npm run -w frontend build` -- expected: clean

**Manual checks:**
- Seed, run `npm run dev`, open `/`. Cards show, the category rail has counts, and a category click updates the URL while back restores it. Clicking a slot chip opens the profile with that slot selected. At 375px width the layout is a single column. Tabbing reaches the tabs, cards and slot chips with a visible focus ring.

## Auto Run Result

Status: done

**Özet:** `GET /providers[?category=]` onaylı sağlayıcıları kart verisiyle döndürüyor: en erken 3 slot tek sorguda geliyor, sıralama en yakın slota göre, slotu olmayanlar sonda. `GET /categories` onaylı sağlayıcı sayılarını da veriyor. `/` artık Discover sayfası: URL'de tutulan kategori sekmeleri ya da kenar çubuğu, DESIGN.md'deki sağlayıcı kartları (monogram, rozetler, depozito pill'i, slotlar), 6 iskelet kart, boş kategori ve bağlantı hatası durumları.

**Commit'ler:** `862828b` spec, `c182ad6` feat (worktree'de yazıldı, `main` üzerine rebase edildi), fix(3.2), chore(3.2).

**Review:** 7 bulgu (medium 3, low 4). Patch: V1, V2, E2, E3, E4, E5. Reddedilen: E1 (low). Takip review önerisi: false.

**Doğrulama:** backend typecheck ve build temiz, test 239/239; frontend typecheck ve build temiz. Route'lar çalışan bir backend üzerinde denendi. Tarayıcıda etkileşimli QA yapılmadı.

**Kalan riskler:** Frontend'de test runner yok. 375px genişlikte yerleşim ve klavye odağı yalnızca kod incelemesiyle doğrulandı.
