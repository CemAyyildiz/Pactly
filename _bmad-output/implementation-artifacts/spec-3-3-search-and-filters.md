---
title: 'Story 3.3 — Search and filters'
type: 'feature'
created: '2026-09-19'
status: 'in-progress'
review_loop_iteration: 0
baseline_revision: '6ddd4197bc88c907d343ef6a19c59eb94134ba8e'
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-3-2-discovery-page-and-categories.md'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-Pactly-2026-09-15/DESIGN.md'
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** Discover (Story 3.2) can only be browsed by category. The hero scenario starts with "she types 'hair transplant'", and the card list cannot be narrowed by format, price, deposit rate or availability.

**Approach:** Extend `GET /providers` with a text query and filters, and add a suggestions route. On Discover, add the search box with debounced autocomplete and the filter rail from the Discover v2 composition. The search box and filters sit on top of 3.2's card list and URL state, without replacing either.

## Boundaries & Constraints

**Always:**
- Search covers the provider's display name, title, bio and category name, case-insensitively (AC1). Only approved providers are ever matched.
- Autocomplete fires 250 ms after the last keystroke (AC2). Suggestions group into categories, services (distinct titles) and providers, and each suggestion shows its result count. Enter is never required: picking a suggestion or pausing typing updates the results.
- Filters (AC3):
  - session format (multi-select over the formats present);
  - price range (min and max, entered in USDC and sent as smallest-unit integer strings);
  - deposit rate (max %);
  - availability: "Today / next 24h", "This week", "Any", computed from the provider's future slots.
- Every filter and the query live in the URL (`q`, `format`, `minPrice`, `maxPrice`, `maxDepositBps`, `when`, alongside 3.2's `category`). The back button restores them, and results update without a reload (AC4). Unknown or invalid params are ignored, never an error.
- An empty result never shows a blank area (AC5). It echoes the query and offers at least three concrete suggestions: loosen a filter (named), try another time window, and browse the whole category (or all providers).
- Filtering and matching happen in the backend. Sort order stays 3.2's (soonest open slot). Money comparisons use BigInt on integer strings.
- Layout per EXPERIENCE.md: from 1024px up, the filter rail sits under the category list. Below that, a "Filters" button with an active-filter count opens a bottom sheet. Touch targets are at least 44px, the focus ring is visible, and the suggestion list is keyboard navigable (arrow keys, Escape) with `aria-activedescendant`.

**Never:**
- No neighbourhood or location filter. The mockup shows one, but the PRD's filter list does not include it.
- No full-text index or new search dependency; a LIKE-based query is enough at demo scale.
- No booking changes, and nothing in `backend/src/chain/` or `backend/src/escrow/`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Text search | `GET /providers?q=hair` | Approved providers whose name, title, bio or category name contains "hair" (case-insensitive) | No error expected |
| Combined | `q` + `category` + filters | The intersection of all of them | No error expected |
| Price range | `minPrice`/`maxPrice` integer strings | `minPrice ≤ price ≤ maxPrice` compared as BigInt | Non-integer: the param is ignored |
| Deposit cap | `maxDepositBps=3000` | `depositRateBps ≤ 3000` | Out of 1–10000: ignored |
| Availability | `when=24h` / `week` | At least one open future slot within 24 h / 7 days | Unknown value: ignored |
| Format | `format=in_person&format=online` | Profiles whose `sessionFormat` is one of them | Unknown value: matches nothing for that value |
| Suggestions | `GET /providers/suggest?q=ha` | Up to 8 suggestions `{kind: category\|service\|provider, label, value, count}`; count = approved providers that suggestion would return | `q` shorter than 2 characters: an empty list |
| LIKE safety | `q` containing `%` or `_` | Treated literally | No error expected |
| No results | A query that matches nothing | The echoed query plus three suggestions (loosen filter, other time, whole category) | Never blank |

</intent-contract>

## Code Map

- `backend/src/services/profile.ts` -- `listDiscoverProviders(db, categorySlug?, now?)` and `buildProviderCardView` from 3.2. Extend it to take a filter object, keeping the sort. `listCategoriesWithProviderCounts` stays as it is.
- `backend/src/db/providerProfiles.ts`, `availabilitySlots.ts` -- approved-profile queries and `listEarliestFutureSlotsByProvider`. Push text, format, price and deposit filters into SQL; the availability window can use the same earliest-slot data.
- `backend/src/app.ts` -- `GET /providers` (3.2). Add query parsing and `GET /providers/suggest`. The suggest route must be registered before `/providers/:id` so it is not captured as an id.
- `frontend/src/pages/discover/DiscoverPage.tsx` -- 3.2's URL state (`category`, preserving other params), categories-first loading and the card grid. Add the search box, rail filters, mobile sheet and empty state here or in new components.
- `frontend/src/api/hooks.ts` -- `useDiscoverProviders(slug, {enabled})`. Extend it with a filters argument, and add a `useProviderSuggestions(q)`.
- `_bmad-output/planning-artifacts/ux-designs/ux-Pactly-2026-09-15/mockups/discover-v2-marketplace.html` -- composition for the search box, the suggestions dropdown with counts, and the filter sections (When / Session type / Service price / Deposit). Ignore its Neighbourhood and Where sections. DESIGN.md wins on conflict.

## Tasks & Acceptance

**Execution:**
- `backend/src/services/profile.ts`, `backend/src/db/*` -- the filter object, SQL filtering, and the suggestion builder with counts.
- `backend/src/app.ts` -- query parsing (ignore invalid values), and `GET /providers/suggest`.
- `backend/test/` -- a test for every matrix row.
- `frontend/src/components/SearchBox.tsx`, `FilterRail.tsx`, `FilterSheet.tsx`, `EmptyResults.tsx` -- per DESIGN.md and EXPERIENCE.md.
- `frontend/src/pages/discover/DiscoverPage.tsx`, `frontend/src/api/hooks.ts` -- wire the search box, filters and URL state.

**Acceptance Criteria:**
- Given the seeded database, when a visitor types "hair" on Discover, then after 250 ms suggestions with counts appear, and the list narrows to the hair-transplant clinic without pressing Enter.
- Given active filters, when the visitor presses back, then the previous filters and results return.
- Given the backend workspace, when `typecheck`, `test` and `build` run, then all are clean. Given the frontend, when `typecheck` and `build` run, then both are clean.

## Spec Change Log

## Review Triage Log

## Verification

**Commands:**
- `npm run -w backend typecheck && npm run -w backend test && npm run -w backend build` -- expected: clean, all pass
- `npm run -w frontend typecheck && npm run -w frontend build` -- expected: clean
